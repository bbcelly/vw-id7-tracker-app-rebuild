import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import { VehicleSource } from "../../src/vw/source.js";
import { Poller } from "../../src/poller/poller.js";
import { Detector, type DetectorConfig } from "../../src/poller/detection.js";
import * as snapshotsRepo from "../../src/repo/snapshots.js";
import type { VwIdData } from "../../src/vw/api/types.js";
import type { WebStatus } from "../../src/vw/web/index.js";

const ID_DATA: VwIdData = {
  charging: {
    batteryStatus: { value: { currentSOC_pct: 70, cruisingRangeElectric_km: 350 } },
    chargingStatus: { value: { chargingState: "readyForCharging" } },
    plugStatus: { value: { externalPower: "unavailable" } },
  },
  measurements: { odometerStatus: { value: { odometer: 1000 } } },
  parking: { data: { carIsParked: true, lat: 50, lon: 14 } },
};

const WEB: WebStatus = {
  rangeKm: 350,
  odometerKm: 1000,
  socPercent: 70,
  isCharging: false,
  isPlugged: false,
  chargingState: "readyForCharging",
  externalPower: "unavailable",
  capturedAt: new Date("2026-07-01T10:00:00.000Z"),
  raw: {},
};

function makeDeps(overrides: Partial<Record<"api" | "web", "ok" | "fail">> = {}) {
  let vin: string | null = "VIN123";
  const calls = { api: 0, web: 0 };
  const deps = {
    api: {
      listVehicles: async () => ["VIN123"],
      fetchIdData: async () => {
        calls.api++;
        if (overrides.api === "fail") throw new Error("VW GET x failed: 500");
        return ID_DATA;
      },
    },
    fetchWeb: async () => {
      calls.web++;
      return overrides.web === "fail" ? null : WEB;
    },
    getCredentials: () => ({ username: "u", password: "p" }),
    getVin: () => vin,
    setVin: (v: string) => {
      vin = v;
    },
    log: () => {},
  };
  return { deps, calls };
}

describe("VehicleSource", () => {
  it("primary success → api snapshot", async () => {
    const { deps } = makeDeps();
    const src = new VehicleSource(deps);
    const snap = await src.poll(new Date("2026-07-01T10:00:00Z"));
    expect(snap!.source).toBe("api");
    expect(snap!.soc).toBe(70);
    expect(src.state).toBe("api");
  });

  it("primary failure → web fallback snapshot; recovery flips back", async () => {
    const { deps } = makeDeps({ api: "fail" });
    const src = new VehicleSource(deps);
    const snap = await src.poll();
    expect(snap!.source).toBe("web");
    expect(snap!.ts).toBe("2026-07-01T10:00:00.000Z"); // carCapturedTimestamp
    expect(snap!.isParked).toBeNull();
    expect(src.state).toBe("web");

    // primary recovers — force bypasses the failure backoff (manual sync path)
    deps.api.fetchIdData = async () => ID_DATA;
    const snap2 = await src.poll(new Date("2026-07-01T10:05:00Z"), true);
    expect(snap2!.source).toBe("api");
    expect(src.state).toBe("api");
  });

  it("backs off primary retries exponentially instead of hammering the IDP", async () => {
    const { deps, calls } = makeDeps({ api: "fail" });
    const src = new VehicleSource(deps);
    for (let i = 0; i < 10; i++) await src.poll();
    // attempts at ticks 1,3,6 (skips 1 then 2 then 4) → 3 login attempts in 10 ticks
    expect(calls.api).toBe(3);

    // success resets the backoff
    deps.api.fetchIdData = async () => {
      calls.api++;
      return ID_DATA;
    };
    await src.poll(new Date(), true);
    const before = calls.api;
    await src.poll();
    expect(calls.api).toBe(before + 1); // next tick attempts primary again
  });

  it("force poll bypasses both backoffs", async () => {
    const { deps, calls } = makeDeps({ api: "fail" });
    const src = new VehicleSource(deps);
    await src.poll(); // fail #1 → skip next tick
    const apiCalls = calls.api;
    await src.poll(new Date(), true); // forced: attempts primary despite skip
    expect(calls.api).toBe(apiCalls + 1);
  });

  it("both paths down → null, disconnected", async () => {
    const { deps } = makeDeps({ api: "fail", web: "fail" });
    const src = new VehicleSource(deps);
    expect(await src.poll()).toBeNull();
    expect(src.state).toBe("disconnected");
  });

  it("no credentials → null without network calls", async () => {
    const { deps, calls } = makeDeps();
    deps.getCredentials = () => null;
    const src = new VehicleSource(deps);
    expect(await src.poll()).toBeNull();
    expect(calls.api + calls.web).toBe(0);
  });

  it("auto-detects and persists the VIN on first primary poll", async () => {
    const { deps } = makeDeps();
    let stored: string | null = null;
    deps.getVin = () => stored;
    deps.setVin = (v: string) => {
      stored = v;
    };
    const src = new VehicleSource(deps);
    await src.poll();
    expect(stored).toBe("VIN123");
  });
});

describe("Poller", () => {
  let db: Database.Database;
  let detector: Detector;
  const detectorCfg: DetectorConfig = {
    batteryKwh: () => 77,
    positionTrackingEnabled: () => false,
    socDeltaEnabled: () => false,
    socDeltaThresholdPct: () => 2,
    pollIntervalMs: () => 300_000,
    debounceMs: () => 180_000,
    now: () => new Date(),
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    detector = new Detector(db, detectorCfg, () => {});
  });

  it("stores a snapshot per poll and feeds detection with (prev, next)", async () => {
    const { deps } = makeDeps();
    const src = new VehicleSource(deps);
    const spy = vi.spyOn(detector, "onSnapshot");
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    const first = await poller.syncNow();
    expect(first).not.toBeNull();
    expect(spy).toHaveBeenCalledWith(null, expect.objectContaining({ id: first!.id }));
    expect(snapshotsRepo.latestSnapshot(db)!.id).toBe(first!.id);
  });

  it("dedups identical parked api polls but always writes while charging", async () => {
    const { deps } = makeDeps();
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    await poller.syncNow();
    const again = await poller.syncNow(); // identical values → dedup
    expect(again).toBeNull();
    expect(snapshotsRepo.listSnapshots(db, { limit: 10, offset: 0 }).total).toBe(1);

    ID_DATA.charging!.chargingStatus!.value!.chargingState = "charging";
    try {
      expect(await poller.syncNow()).not.toBeNull();
      expect(await poller.syncNow()).not.toBeNull(); // still writes while charging
      expect(snapshotsRepo.listSnapshots(db, { limit: 10, offset: 0 }).total).toBe(3);
    } finally {
      ID_DATA.charging!.chargingStatus!.value!.chargingState = "readyForCharging";
    }
  });

  it("dedups web rows on repeated carCapturedTimestamp", async () => {
    const { deps } = makeDeps({ api: "fail" });
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    expect(await poller.syncNow()).not.toBeNull();
    expect(await poller.syncNow()).toBeNull(); // same capturedAt
    expect(snapshotsRepo.listSnapshots(db, { limit: 10, offset: 0 }).total).toBe(1);
  });

  it("persists the charging carry-forward across the DB round-trip (one session, not two)", async () => {
    // 3-poll sequence: charging → charging job omitted (null) → charging.
    const readings: Array<boolean | null> = [false, true, null, true, false];
    let i = 0;
    const { deps } = makeDeps();
    deps.api.fetchIdData = async () => {
      const state = readings[Math.min(i++, readings.length - 1)];
      return {
        ...ID_DATA,
        charging: {
          batteryStatus: { value: { currentSOC_pct: 40 + i * 2, cruisingRangeElectric_km: 300 } },
          chargingStatus: state === null ? undefined : { value: { chargingState: state ? "charging" : "readyForCharging" } },
          plugStatus: { value: { externalPower: "active" } },
        },
      };
    };
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    for (let k = 0; k < readings.length; k++) await poller.syncNow();

    const sessions = db.prepare("SELECT COUNT(*) n FROM charging_sessions").get() as { n: number };
    expect(sessions.n).toBe(1); // gap bridged — no stop/restart fragmentation
    const open = db.prepare("SELECT COUNT(*) n FROM charging_sessions WHERE end_ts IS NULL").get() as { n: number };
    expect(open.n).toBe(0); // and the final stop closed it
    // the stored gap row carries the bridged value, not null
    const gapRow = db.prepare("SELECT is_charging FROM vehicle_status ORDER BY id LIMIT 1 OFFSET 2").get() as { is_charging: number | null };
    expect(gapRow.is_charging).toBe(1);
  });

  it("skips edge detection across a source flip and reconciles on recovery", async () => {
    // Orphaned open api trip from before an outage:
    db.prepare(
      "INSERT INTO trips (start_ts, start_odometer, start_soc, source) VALUES ('2026-06-01T08:00:00.000Z', 900, 80, 'api')"
    ).run();
    // Latest row is web-source (outage period)
    const { deps } = makeDeps({ api: "fail" });
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    expect((await poller.syncNow())!.source).toBe("web");

    // Primary recovers with the car explicitly parked:
    deps.api.fetchIdData = async () => ID_DATA; // parked, not charging, unplugged
    const recovered = await poller.syncNow();
    expect(recovered!.source).toBe("api");
    // recovery reconciled the orphan (closed against fresh api reading)…
    const open = db.prepare("SELECT COUNT(*) n FROM trips WHERE end_ts IS NULL").get() as { n: number };
    expect(open.n).toBe(0);
    // …and no phantom trip/charge was fabricated from the web→api pairing
    const trips = db.prepare("SELECT COUNT(*) n FROM trips").get() as { n: number };
    expect(trips.n).toBe(1);
  });

  it("dedups identical-value web rows even when capturedAt is missing", async () => {
    const { deps } = makeDeps({ api: "fail" });
    const noTsWeb = { ...WEB, capturedAt: null };
    deps.fetchWeb = async () => noTsWeb;
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    expect(await poller.syncNow()).not.toBeNull();
    expect(await poller.syncNow()).toBeNull(); // same values → dedup despite ts=now
    expect(snapshotsRepo.listSnapshots(db, { limit: 10, offset: 0 }).total).toBe(1);
  });

  it("writes a new row when only targetSoc or climate extras change while parked", async () => {
    const { deps } = makeDeps();
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    await poller.syncNow();
    deps.api.fetchIdData = async () => ({
      ...ID_DATA,
      charging: {
        ...ID_DATA.charging,
        chargingSettings: { value: { targetSOC_pct: 100 } }, // user raised target
      },
    });
    const updated = await poller.syncNow();
    expect(updated).not.toBeNull();
    expect(updated!.targetSoc).toBe(100);
  });

  it("a source that throws does not kill the loop", async () => {
    const { deps } = makeDeps();
    deps.api.fetchIdData = async () => {
      throw new Error("boom");
    };
    deps.fetchWeb = async () => {
      throw new Error("web boom");
    };
    const src = new VehicleSource(deps);
    const poller = new Poller(db, src, detector, { intervalMin: () => 5, now: () => new Date() }, () => {});
    await expect(poller.syncNow()).resolves.toBeNull();
  });
});
