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

    // primary recovers
    deps.api.fetchIdData = async () => ID_DATA;
    const snap2 = await src.poll(new Date("2026-07-01T10:05:00Z"));
    expect(snap2!.source).toBe("api");
    expect(src.state).toBe("api");
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
