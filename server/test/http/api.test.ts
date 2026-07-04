import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "../../src/db/migrate.js";
import { buildServer } from "../../src/http/server.js";
import { Poller } from "../../src/poller/poller.js";
import { Detector } from "../../src/poller/detection.js";
import { VehicleSource } from "../../src/vw/source.js";
import * as tripsRepo from "../../src/repo/trips.js";
import { getSetting, setSetting } from "../../src/repo/settings.js";

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(":memory:");
  runMigrations(db);
  const source = new VehicleSource({
    api: {
      listVehicles: async () => [],
      fetchIdData: async () => ({}),
    },
    fetchWeb: async () => null,
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
  app = buildServer({ db, poller, source });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const TRIP = {
  startTs: "2026-07-01T08:00:00.000Z",
  endTs: "2026-07-01T09:00:00.000Z",
  startOdometer: 1000,
  endOdometer: 1050,
  startSoc: 80,
  endSoc: 70,
};

describe("trips API", () => {
  it("creates a trip with derived metrics filled and source forced to manual", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/trips",
      payload: { ...TRIP, id: 999, source: "api" },
    });
    expect(res.statusCode).toBe(201);
    const t = res.json();
    expect(t.id).not.toBe(999); // client id ignored
    expect(t.source).toBe("manual"); // client source stripped
    expect(t.distanceKm).toBe(50);
    expect(t.energyKwh).toBe(7.7);
    expect(t.consumption).toBe(15.4);
    expect(t.durationMin).toBe(60);
  });

  it("rejects invalid SOC and bad timestamps", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/trips", payload: { ...TRIP, startSoc: 140 } }))
        .statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/trips", payload: { ...TRIP, startTs: "yesterday" } }))
        .statusCode
    ).toBe(400);
  });

  it("PATCH: manual value wins, untouched derived fields recompute", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/trips", payload: TRIP })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/trips/${created.id}`,
      payload: { endOdometer: 1100, distanceKm: 95 },
    });
    const t = res.json();
    expect(t.distanceKm).toBe(95); // manual wins
    expect(t.consumption).toBeCloseTo((7.7 / 95) * 100, 2); // recomputed from manual distance
  });

  it("paginates with total and clamps limit", async () => {
    for (let i = 0; i < 3; i++)
      await app.inject({ method: "POST", url: "/api/trips", payload: TRIP });
    const page = (await app.inject({ url: "/api/trips?limit=2&offset=0" })).json();
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    const clamped = (await app.inject({ url: "/api/trips?limit=9999" })).json();
    expect(clamped.items.length).toBeLessThanOrEqual(200);
  });

  it("DELETE removes and 404s on repeat", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/trips", payload: TRIP })
    ).json();
    expect((await app.inject({ method: "DELETE", url: `/api/trips/${created.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/trips/${created.id}` })).statusCode).toBe(404);
  });

  it("positions endpoint 404s for unknown trip and lists for known", async () => {
    expect((await app.inject({ url: "/api/trips/999/positions" })).statusCode).toBe(404);
    const t = tripsRepo.createTrip(db, {
      ...TRIP,
      distanceKm: null, energyKwh: null, consumption: null, durationMin: null,
      notes: null, source: "api",
    });
    expect((await app.inject({ url: `/api/trips/${t.id}/positions` })).json()).toEqual([]);
  });
});

describe("charging API", () => {
  it("creates with cost auto-filled from price and returns summary in list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/charging",
      payload: {
        startTs: "2026-07-01T20:00:00.000Z",
        endTs: "2026-07-01T23:00:00.000Z",
        startSoc: 40,
        endSoc: 80,
        pricePerKwh: 0.25,
        chargerType: "home",
      },
    });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c.energyKwh).toBe(30.8);
    expect(c.cost).toBe(7.7);
    const list = (await app.inject({ url: "/api/charging" })).json();
    expect(list.summary.count).toBe(1);
    expect(list.summary.totalEnergyKwh).toBeCloseTo(30.8);
  });

  it("rejects unknown charger type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/charging",
      payload: { startTs: "2026-07-01T20:00:00.000Z", chargerType: "nuclear" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("stats API", () => {
  it("computes totals and weighted average consumption", async () => {
    await app.inject({ method: "POST", url: "/api/trips", payload: TRIP }); // 50km, 7.7kWh
    await app.inject({
      method: "POST",
      url: "/api/trips",
      payload: { ...TRIP, startTs: "2026-07-02T08:00:00.000Z", endOdometer: 1150 }, // 150km, 7.7kWh
    });
    const s = (await app.inject({ url: "/api/stats" })).json();
    expect(s.tripCount).toBe(2);
    expect(s.totalDistanceKm).toBe(200);
    expect(s.avgConsumption).toBeCloseTo(((7.7 + 7.7) / 200) * 100, 2);
    expect(s.trend).toHaveLength(2);
    expect(s.trend[0].startTs < s.trend[1].startTs).toBe(true); // oldest first
  });
});

describe("settings API", () => {
  it("masks the password, keeps it on empty writes, updates on non-empty", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vw_username: "user@example.com", vw_password: "secret1" },
    });
    const got = (await app.inject({ url: "/api/settings" })).json();
    expect(got.vw_username).toBe("user@example.com");
    expect(got.vw_password).toBeUndefined();
    expect(got.vw_password_set).toBe("true");

    await app.inject({ method: "PUT", url: "/api/settings", payload: { vw_password: "" } });
    expect(getSetting(db, "vw_password")).toBe("secret1");
    await app.inject({ method: "PUT", url: "/api/settings", payload: { vw_password: "secret2" } });
    expect(getSetting(db, "vw_password")).toBe("secret2");
  });

  it("validates poll interval bounds", async () => {
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings", payload: { poll_interval: 0 } }))
        .statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings", payload: { poll_interval: 61 } }))
        .statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings", payload: { poll_interval: 10 } }))
        .statusCode
    ).toBe(200);
    expect(getSetting(db, "poll_interval")).toBe("10");
  });
});

describe("status API", () => {
  it("returns null snapshot + disconnected state on an empty database", async () => {
    const s = (await app.inject({ url: "/api/status" })).json();
    expect(s.snapshot).toBeNull();
    expect(s.connection.state).toBe("disconnected");
  });

  it("sync without credentials reports not synced", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/sync" })).json();
    expect(s.synced).toBe(false);
  });

  it("status surfaces live extras from the raw payload", async () => {
    setSetting(db, "x", "y"); // noop to keep db referenced
    db.prepare(
      `INSERT INTO vehicle_status (ts, soc, raw, source) VALUES (?, ?, ?, 'api')`
    ).run(
      "2026-07-01T10:00:00.000Z",
      70,
      JSON.stringify({
        climatisation: { climatisationStatus: { value: { climatisationState: "heating" } } },
        access: { accessStatus: { value: { doorLockStatus: "locked" } } },
      })
    );
    const s = (await app.inject({ url: "/api/status" })).json();
    expect(s.snapshot.soc).toBe(70);
    expect(s.climatisationState).toBe("heating");
    expect(s.doorLockStatus).toBe("locked");
  });
});

describe("connect starts the poller", () => {
  it("starts the poll loop when connected even if the poll deduped", async () => {
    await app.close();
    const WEB = {
      rangeKm: 400, odometerKm: 1200, socPercent: 70, isCharging: false,
      isPlugged: false, chargingState: "readyForCharging", externalPower: "unavailable",
      capturedAt: new Date("2026-07-03T10:00:00.000Z"), raw: {},
    };
    const source = new VehicleSource({
      api: { listVehicles: async () => { throw new Error("502"); }, fetchIdData: async () => { throw new Error("502"); } },
      fetchWeb: async () => WEB,
      getCredentials: () => ({ username: "u", password: "p" }),
      getVin: () => "VIN1",
      setVin: () => {},
      log: () => {},
    });
    const detector = new Detector(db, {
      batteryKwh: () => 77, positionTrackingEnabled: () => false, socDeltaEnabled: () => false,
      socDeltaThresholdPct: () => 2, pollIntervalMs: () => 300_000, debounceMs: () => 180_000,
      now: () => new Date(),
    }, () => {});
    const poller = new Poller(db, source, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    app = buildServer({ db, poller, source });
    await app.ready();

    await poller.syncNow(); // stores the web row → the next poll dedups
    poller.stop();
    const res = (await app.inject({ method: "POST", url: "/api/connect" })).json();
    expect(res.connected).toBe(true);
    expect(res.snapshot).toBeNull(); // deduped
    expect(poller.running).toBe(true); // must start anyway
    poller.stop();
  });
});
