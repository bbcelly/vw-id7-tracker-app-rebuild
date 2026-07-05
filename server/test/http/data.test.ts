import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "../../src/db/migrate.js";
import { buildServer } from "../../src/http/server.js";
import { Poller } from "../../src/poller/poller.js";
import { Detector } from "../../src/poller/detection.js";
import { VehicleSource } from "../../src/vw/source.js";
import * as tripsRepo from "../../src/repo/trips.js";
import * as chargingRepo from "../../src/repo/charging.js";
import { parseCsv } from "../../src/domain/csv.js";

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(":memory:");
  runMigrations(db);
  const source = new VehicleSource({
    api: { listVehicles: async () => [], fetchIdData: async () => ({}) },
    fetchWeb: async () => null,
    fetchWebVins: async () => null,
    getCredentials: () => null,
    getVin: () => null,
    setVin: () => {},
    log: () => {},
  });
  const detector = new Detector(
    db,
    {
      batteryKwh: () => 77,
      positionTrackingEnabled: () => false,
      socDeltaEnabled: () => false,
      socDeltaThresholdPct: () => 2,
      pollIntervalMs: () => 300_000,
      debounceMs: () => 180_000,
      now: () => new Date(),
    },
    () => {}
  );
  const poller = new Poller(db, source, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
  app = buildServer({ db, poller, source, fetchWebSpec: async () => null });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function importCsv(entity: string, csv: string) {
  return app.inject({
    method: "POST",
    url: `/api/${entity}/import`,
    headers: { "content-type": "text/csv" },
    payload: csv,
  });
}

describe("trips CSV export", () => {
  it("streams a CSV attachment with the header row and data", async () => {
    tripsRepo.createTrip(db, {
      startTs: "2026-07-01T08:00:00.000Z",
      endTs: "2026-07-01T09:00:00.000Z",
      startOdometer: 1000, endOdometer: 1050,
      startSoc: 80, endSoc: 70,
      distanceKm: 50, energyKwh: 7.7, consumption: 15.4, durationMin: 60,
      notes: "with, comma", source: "manual",
    });
    const res = await app.inject({ method: "GET", url: "/api/trips/export.csv" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain('filename="trips.csv"');

    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual([
      "id", "startTs", "endTs", "startOdometer", "endOdometer", "startSoc",
      "endSoc", "distanceKm", "energyKwh", "consumption", "durationMin", "notes", "source",
    ]);
    expect(rows[1][0]).toBe("1");
    expect(rows[1][1]).toBe("2026-07-01T08:00:00.000Z");
    expect(rows[1][11]).toBe("with, comma"); // comma survived round-trip
  });
});

describe("trips CSV import", () => {
  const header =
    "id,startTs,endTs,startOdometer,endOdometer,startSoc,endSoc,distanceKm,energyKwh,consumption,durationMin,notes,source";

  it("inserts new rows and fills derived metrics", async () => {
    const csv = `${header}\r\n,2026-07-01T08:00:00.000Z,2026-07-01T09:00:00.000Z,1000,1050,80,70,,,,,,`;
    const res = await importCsv("trips", csv);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inserted: 1, updated: 0, failed: 0 });

    const trips = tripsRepo.allTrips(db);
    expect(trips).toHaveLength(1);
    expect(trips[0].distanceKm).toBe(50);
    expect(trips[0].energyKwh).toBe(7.7);
    expect(trips[0].consumption).toBe(15.4);
    expect(trips[0].durationMin).toBe(60);
    expect(trips[0].source).toBe("manual");
  });

  it("upserts by id (updates instead of duplicating) and preserves source", async () => {
    const existing = tripsRepo.createTrip(db, {
      startTs: "2026-07-01T08:00:00.000Z", endTs: null,
      startOdometer: null, endOdometer: null, startSoc: null, endSoc: null,
      distanceKm: null, energyKwh: null, consumption: null, durationMin: null,
      notes: "original", source: "api",
    });
    const csv = `${header}\r\n${existing.id},2026-07-01T08:00:00.000Z,,,,,,,,,,updated note,api`;
    const res = await importCsv("trips", csv);
    expect(res.json()).toMatchObject({ inserted: 0, updated: 1, failed: 0 });

    const trips = tripsRepo.allTrips(db);
    expect(trips).toHaveLength(1); // no duplicate
    expect(trips[0].id).toBe(existing.id);
    expect(trips[0].notes).toBe("updated note");
    expect(trips[0].source).toBe("api"); // source preserved from CSV
  });

  it("inserts a row that carries a brand-new explicit id", async () => {
    const csv = `${header}\r\n42,2026-07-01T08:00:00.000Z,,,,,,,,,,,manual`;
    const res = await importCsv("trips", csv);
    expect(res.json()).toMatchObject({ inserted: 1, updated: 0, failed: 0 });
    expect(tripsRepo.getTrip(db, 42)?.id).toBe(42);
  });

  it("skips invalid rows and reports per-row errors", async () => {
    const csv =
      `${header}\r\n` +
      `,2026-07-01T08:00:00.000Z,,,,999,,,,,,,\r\n` + // startSoc 999 out of range
      `,not-a-date,,,,,,,,,,,`;                        // bad timestamp
    const res = await importCsv("trips", csv);
    const body = res.json();
    expect(body.inserted).toBe(0);
    expect(body.failed).toBe(2);
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0].row).toBe(2);
    expect(body.errors[1].row).toBe(3);
    expect(tripsRepo.allTrips(db)).toHaveLength(0);
  });

  it("rejects a non-CSV content type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/trips/import",
      payload: { not: "csv" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("charging CSV round-trip", () => {
  it("exports then re-imports as an update", async () => {
    chargingRepo.createSession(db, {
      startTs: "2026-07-02T20:00:00.000Z", endTs: "2026-07-02T22:00:00.000Z",
      startSoc: 40, endSoc: 80, energyKwh: 30.8, cost: 9.24, pricePerKwh: 0.3,
      maxPowerKw: 11, chargerType: "home", location: "Home", lat: 50.1, lon: 14.4,
      notes: null, source: "manual",
    });
    const exported = await app.inject({ method: "GET", url: "/api/charging/export.csv" });
    const res = await importCsv("charging", exported.body);
    expect(res.json()).toMatchObject({ inserted: 0, updated: 1, failed: 0 });
    expect(chargingRepo.allSessions(db)).toHaveLength(1);
  });
});

describe("snapshots CSV round-trip", () => {
  it("exports raw JSON blobs and re-imports them intact", async () => {
    const { insertSnapshot } = await import("../../src/repo/snapshots.js");
    const raw = JSON.stringify({ soc: 55, note: 'has "quotes", commas' });
    insertSnapshot(db, {
      ts: "2026-07-03T10:00:00.000Z", soc: 55, rangeKm: 300, odometerKm: 12000,
      isParked: true, isCharging: false, isPlugged: null,
      chargingState: "readyForCharging", externalPower: "unavailable", targetSoc: 80,
      lat: null, lon: null, raw, source: "api",
    });
    const exported = await app.inject({ method: "GET", url: "/api/snapshots/export.csv" });
    const res = await importCsv("snapshots", exported.body);
    expect(res.json()).toMatchObject({ inserted: 0, updated: 1, failed: 0 });

    const { allSnapshots } = await import("../../src/repo/snapshots.js");
    const snaps = allSnapshots(db);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].isParked).toBe(true);
    expect(snaps[0].isCharging).toBe(false);
    expect(snaps[0].raw).toBe(raw);
  });
});
