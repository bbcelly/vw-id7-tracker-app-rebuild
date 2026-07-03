import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import * as snapshots from "../../src/repo/snapshots.js";
import * as trips from "../../src/repo/trips.js";
import * as charging from "../../src/repo/charging.js";
import * as settings from "../../src/repo/settings.js";
import * as positions from "../../src/repo/positions.js";
import type { SnapshotInsert, TripInsert, ChargingInsert } from "../../src/domain/types.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const snap = (over: Partial<SnapshotInsert> = {}): SnapshotInsert => ({
  ts: "2026-07-01T10:00:00.000Z",
  soc: 75,
  rangeKm: 400,
  odometerKm: 1200,
  isParked: true,
  isCharging: false,
  isPlugged: false,
  chargingState: "readyForCharging",
  externalPower: "unavailable",
  targetSoc: 80,
  lat: 50.08,
  lon: 14.43,
  raw: '{"x":1}',
  source: "api",
  ...over,
});

describe("snapshots repo", () => {
  it("inserts and reads back with type round-trip (booleans, nulls)", () => {
    const inserted = snapshots.insertSnapshot(db, snap({ soc: null, isParked: false }));
    expect(inserted.id).toBeGreaterThan(0);
    const latest = snapshots.latestSnapshot(db);
    expect(latest).not.toBeNull();
    expect(latest!.soc).toBeNull();
    expect(latest!.isParked).toBe(false);
    expect(latest!.isCharging).toBe(false);
    expect(latest!.rangeKm).toBe(400);
    expect(latest!.source).toBe("api");
  });

  it("latestSnapshot returns newest by ts; latestSnapshotBySource filters", () => {
    snapshots.insertSnapshot(db, snap({ ts: "2026-07-01T10:00:00.000Z" }));
    snapshots.insertSnapshot(db, snap({ ts: "2026-07-01T11:00:00.000Z", source: "web", soc: null }));
    expect(snapshots.latestSnapshot(db)!.source).toBe("web");
    expect(snapshots.latestSnapshotBySource(db, "api")!.soc).toBe(75);
  });
});

const trip = (over: Partial<TripInsert> = {}): TripInsert => ({
  startTs: "2026-07-01T08:00:00.000Z",
  endTs: "2026-07-01T09:00:00.000Z",
  startOdometer: 100,
  endOdometer: 150,
  startSoc: 80,
  endSoc: 70,
  distanceKm: 50,
  energyKwh: 7.7,
  consumption: 15.4,
  durationMin: 60,
  notes: null,
  source: "api",
  ...over,
});

describe("trips repo", () => {
  it("CRUD round-trip", () => {
    const t = trips.createTrip(db, trip());
    expect(t.id).toBeGreaterThan(0);
    const updated = trips.updateTrip(db, t.id, { notes: "to work", distanceKm: 51 });
    expect(updated!.notes).toBe("to work");
    expect(updated!.distanceKm).toBe(51);
    expect(updated!.startSoc).toBe(80); // untouched fields preserved
    expect(trips.deleteTrip(db, t.id)).toBe(true);
    expect(trips.getTrip(db, t.id)).toBeNull();
    expect(trips.deleteTrip(db, t.id)).toBe(false);
  });

  it("lists newest-first with pagination and total", () => {
    for (let i = 0; i < 5; i++)
      trips.createTrip(db, trip({ startTs: `2026-07-0${i + 1}T08:00:00.000Z` }));
    const page = trips.listTrips(db, { limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].startTs).toBe("2026-07-05T08:00:00.000Z");
    const page2 = trips.listTrips(db, { limit: 2, offset: 4 });
    expect(page2.items).toHaveLength(1);
  });

  it("openTrip finds the auto trip without endTs", () => {
    expect(trips.openTrip(db)).toBeNull();
    trips.createTrip(db, trip({ endTs: null, source: "api" }));
    expect(trips.openTrip(db)).not.toBeNull();
  });
});

describe("charging repo", () => {
  const sess = (over: Partial<ChargingInsert> = {}): ChargingInsert => ({
    startTs: "2026-07-01T20:00:00.000Z",
    endTs: null,
    startSoc: 40,
    endSoc: null,
    energyKwh: null,
    cost: null,
    pricePerKwh: null,
    maxPowerKw: null,
    chargerType: "home",
    location: "Home",
    lat: null,
    lon: null,
    notes: null,
    source: "api",
    ...over,
  });

  it("CRUD + openSession + summary", () => {
    const c = charging.createSession(db, sess());
    expect(charging.openSession(db)!.id).toBe(c.id);
    charging.updateSession(db, c.id, { endTs: "2026-07-01T23:00:00.000Z", endSoc: 80, energyKwh: 30.8, cost: 7.7 });
    expect(charging.openSession(db)).toBeNull();
    charging.createSession(db, sess({ startTs: "2026-07-02T20:00:00.000Z", endTs: "2026-07-02T21:00:00.000Z", energyKwh: 10, cost: 2.5 }));
    const s = charging.summary(db);
    expect(s.count).toBe(2);
    expect(s.totalEnergyKwh).toBeCloseTo(40.8);
    expect(s.totalCost).toBeCloseTo(10.2);
  });
});

describe("settings repo", () => {
  it("set/get/getAll round-trip, upsert semantics", () => {
    expect(settings.getSetting(db, "poll_interval")).toBeNull();
    settings.setSetting(db, "poll_interval", "5");
    settings.setSetting(db, "poll_interval", "10");
    expect(settings.getSetting(db, "poll_interval")).toBe("10");
    settings.setSetting(db, "currency", "EUR");
    expect(settings.getAllSettings(db)).toEqual({ poll_interval: "10", currency: "EUR" });
  });
});

describe("positions repo", () => {
  it("stores and lists positions per trip; cascade on trip delete", () => {
    const t = trips.createTrip(db, trip());
    positions.addPosition(db, t.id, "2026-07-01T08:00:00.000Z", 50.0, 14.4);
    positions.addPosition(db, t.id, "2026-07-01T09:00:00.000Z", 50.1, 14.5);
    expect(positions.listPositions(db, t.id)).toHaveLength(2);
    trips.deleteTrip(db, t.id);
    expect(positions.listPositions(db, t.id)).toHaveLength(0);
  });
});
