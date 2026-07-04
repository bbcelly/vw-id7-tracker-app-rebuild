import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import { Detector, type DetectorConfig } from "../../src/poller/detection.js";
import * as tripsRepo from "../../src/repo/trips.js";
import * as chargingRepo from "../../src/repo/charging.js";
import * as positionsRepo from "../../src/repo/positions.js";
import type { Snapshot } from "../../src/domain/types.js";

const T0 = Date.parse("2026-07-01T08:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000);

let db: Database.Database;
let detector: Detector;
let socDelta = false;
let positionTracking = true;

const cfg: DetectorConfig = {
  batteryKwh: () => 77,
  positionTrackingEnabled: () => positionTracking,
  socDeltaEnabled: () => socDelta,
  socDeltaThresholdPct: () => 2,
  pollIntervalMs: () => 5 * 60_000,
  debounceMs: () => 3 * 60_000,
  now: () => new Date(),
};

let idCounter = 0;
const snap = (min: number, over: Partial<Snapshot>): Snapshot => ({
  id: ++idCounter,
  ts: at(min).toISOString(),
  soc: 70,
  rangeKm: 350,
  odometerKm: 1000,
  isParked: true,
  isCharging: false,
  isPlugged: false,
  chargingState: "readyForCharging",
  externalPower: "unavailable",
  targetSoc: 80,
  lat: 50.0,
  lon: 14.4,
  raw: null,
  source: "api",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(0));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  socDelta = false;
  positionTracking = true;
  detector = new Detector(db, cfg, () => {});
});

afterEach(() => {
  detector.stop();
  vi.useRealTimers();
});

describe("API charging detection", () => {
  it("opens a session on charging start and closes it with energy on stop", () => {
    const a = snap(0, { isCharging: false, soc: 40 });
    const b = snap(5, { isCharging: true, soc: 41 });
    detector.onSnapshot(a, b);
    const open = chargingRepo.openSession(db, "api");
    expect(open).not.toBeNull();
    expect(open!.startSoc).toBe(41);
    expect(open!.lat).toBe(50.0);

    vi.setSystemTime(at(65));
    const c = snap(65, { isCharging: false, soc: 80 });
    detector.onSnapshot(b, c);
    expect(chargingRepo.openSession(db, "api")).toBeNull();
    const closed = chargingRepo.latestSession(db, "api")!;
    expect(closed.endSoc).toBe(80);
    expect(closed.energyKwh).toBeCloseTo(((80 - 41) / 100) * 77, 2);
  });

  it("never stacks a second open session even when prev reads as not-charging", () => {
    const a = snap(0, { isCharging: false, soc: 40 });
    const b = snap(5, { isCharging: true, soc: 42 });
    detector.onSnapshot(a, b);
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(1);
    // A stored charging-job gap (isCharging=null) followed by charging again
    // must NOT open a second session while one is open.
    const gap = snap(10, { isCharging: null, chargingState: null, soc: 45 });
    const c = snap(15, { isCharging: true, soc: 47 });
    detector.onSnapshot(gap, c);
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(1);
    expect(chargingRepo.openSession(db, "api")).not.toBeNull();
  });
});

describe("charger-type labeling", () => {
  const apiRaw = (chargeType: string, powerKw: number) =>
    JSON.stringify({ charging: { chargingStatus: { value: { chargingState: "charging", chargePower_kW: powerKw, chargeType } } } });
  const webRaw = (chargeType: string, powerKw: number) =>
    JSON.stringify({ charging: { data: { chargingStatus: { chargePower_kW: powerKw, chargeType } } } });

  it("labels a new session home by default (no telemetry)", () => {
    detector.onSnapshot(snap(0, {}), snap(5, { isCharging: true, soc: 50 }));
    const s = chargingRepo.openSession(db, "api")!;
    expect(s.chargerType).toBe("home");
    expect(s.maxPowerKw).toBeNull();
  });

  it("labels an AC charge home and records its power", () => {
    detector.onSnapshot(snap(0, {}), snap(5, { isCharging: true, soc: 50, raw: apiRaw("ac", 11) }));
    const s = chargingRepo.openSession(db, "api")!;
    expect(s.chargerType).toBe("home");
    expect(s.maxPowerKw).toBe(11);
  });

  it("labels a DC charge from telemetry", () => {
    detector.onSnapshot(snap(0, {}), snap(5, { isCharging: true, soc: 50, raw: apiRaw("dc", 120) }));
    const s = chargingRepo.openSession(db, "api")!;
    expect(s.chargerType).toBe("dc");
    expect(s.maxPowerKw).toBe(120);
  });

  it("upgrades an open session to DC and tracks max power mid-charge", () => {
    detector.onSnapshot(snap(0, {}), snap(5, { isCharging: true, soc: 50, raw: apiRaw("ac", 11) }));
    detector.onSnapshot(
      snap(5, { isCharging: true, soc: 50 }),
      snap(10, { isCharging: true, soc: 55, raw: apiRaw("dc", 120) })
    );
    const s = chargingRepo.openSession(db, "api")!;
    expect(s.chargerType).toBe("dc");
    expect(s.maxPowerKw).toBe(120);
    // a later weaker tick must not lower the recorded max
    detector.onSnapshot(
      snap(10, { isCharging: true, soc: 55 }),
      snap(15, { isCharging: true, soc: 58, raw: apiRaw("dc", 60) })
    );
    expect(chargingRepo.openSession(db, "api")!.maxPowerKw).toBe(120);
  });

  it("labels web-derived sessions from web telemetry (home for AC)", () => {
    const web = (min: number, over: Partial<Snapshot>): Snapshot =>
      snap(min, { source: "web", isParked: null, isCharging: null, lat: null, lon: null, ...over });
    detector.onSnapshot(
      web(0, { odometerKm: 1000, soc: 50 }),
      web(5, { odometerKm: 1000, soc: 57, raw: webRaw("ac", 4.8) })
    );
    const s = chargingRepo.latestSession(db, "web")!;
    expect(s.chargerType).toBe("home");
    expect(s.maxPowerKw).toBe(4.8);
  });

  it("labels SOC-delta sessions home by default", () => {
    socDelta = true;
    detector.onSnapshot(snap(0, { soc: 50 }), snap(5, { soc: 55 }));
    expect(chargingRepo.latestSession(db, "api")!.chargerType).toBe("home");
  });
});

describe("API trip detection", () => {
  it("confirms a trip only after the debounce and closes it with metrics", () => {
    const parked = snap(0, { isParked: true, soc: 80, odometerKm: 1000 });
    const moving = snap(5, { isParked: false, soc: 79, odometerKm: 1000 });
    detector.onSnapshot(parked, moving);
    expect(tripsRepo.openTrip(db, "api")).toBeNull(); // not yet — debouncing

    vi.advanceTimersByTime(3 * 60_000 + 1);
    const open = tripsRepo.openTrip(db, "api");
    expect(open).not.toBeNull();
    expect(open!.startOdometer).toBe(1000);
    // start position recorded from last parked coordinates
    expect(positionsRepo.listPositions(db, open!.id)).toHaveLength(1);

    vi.setSystemTime(at(45));
    const parkedAgain = snap(45, { isParked: true, soc: 68, odometerKm: 1052.5, lat: 50.2, lon: 14.6 });
    detector.onSnapshot(moving, parkedAgain);
    const closed = tripsRepo.getTrip(db, open!.id)!;
    expect(closed.endTs).not.toBeNull();
    expect(closed.distanceKm).toBe(52.5);
    // trip start SOC is the first moving reading (79), not the last parked one
    expect(closed.energyKwh).toBeCloseTo(((79 - 68) / 100) * 77, 2);
    expect(closed.consumption).not.toBeNull();
    expect(positionsRepo.listPositions(db, open!.id)).toHaveLength(2);
  });

  it("a parked-again signal within the debounce cancels the pending trip", () => {
    const parked = snap(0, { isParked: true });
    const moving = snap(5, { isParked: false });
    detector.onSnapshot(parked, moving);
    vi.advanceTimersByTime(60_000); // 1 min < 3 min debounce
    detector.onSnapshot(moving, snap(6, { isParked: true }));
    vi.advanceTimersByTime(10 * 60_000);
    expect(tripsRepo.listTrips(db, { limit: 10, offset: 0 }).total).toBe(0);
  });

  it("discards a closed trip under 2 km", () => {
    const parked = snap(0, { isParked: true, odometerKm: 1000, soc: 70 });
    const moving = snap(5, { isParked: false, odometerKm: 1000, soc: 70 });
    detector.onSnapshot(parked, moving);
    vi.advanceTimersByTime(3 * 60_000 + 1);
    expect(tripsRepo.openTrip(db, "api")).not.toBeNull();
    detector.onSnapshot(moving, snap(15, { isParked: true, odometerKm: 1001, soc: 69 }));
    expect(tripsRepo.listTrips(db, { limit: 10, offset: 0 }).total).toBe(0);
  });

  it("discards a 'trip' whose SOC rose (it was actually charging)", () => {
    const parked = snap(0, { isParked: true, odometerKm: 1000, soc: 50 });
    const moving = snap(5, { isParked: false, odometerKm: 1000, soc: 50 });
    detector.onSnapshot(parked, moving);
    vi.advanceTimersByTime(3 * 60_000 + 1);
    detector.onSnapshot(moving, snap(60, { isParked: true, odometerKm: 1010, soc: 65 }));
    expect(tripsRepo.listTrips(db, { limit: 10, offset: 0 }).total).toBe(0);
  });
});

describe("SOC-delta heuristic (API path)", () => {
  it("detects a parked SOC rise ≥ threshold as a charge when enabled", () => {
    socDelta = true;
    detector.onSnapshot(snap(0, { soc: 50 }), snap(5, { soc: 55 }));
    const s = chargingRepo.latestSession(db, "api")!;
    expect(s.startSoc).toBe(50);
    expect(s.endSoc).toBe(55);
    expect(s.endTs).not.toBeNull();
  });

  it("stays silent when disabled or below threshold", () => {
    socDelta = false;
    detector.onSnapshot(snap(0, { soc: 50 }), snap(5, { soc: 55 }));
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(0);
    socDelta = true;
    detector.onSnapshot(snap(10, { soc: 55 }), snap(15, { soc: 56 }));
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(0);
  });

  it("defers to an open event-detected session", () => {
    socDelta = true;
    detector.onSnapshot(snap(0, { isCharging: false, soc: 40 }), snap(5, { isCharging: true, soc: 41 }));
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(1);
    // SOC rising while the open session exists must not add another
    detector.onSnapshot(snap(5, { isCharging: true, soc: 41 }), snap(10, { isCharging: true, soc: 47 }));
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(1);
  });
});

describe("web-path reconstruction", () => {
  const web = (min: number, over: Partial<Snapshot>): Snapshot =>
    snap(min, { source: "web", isParked: null, isCharging: null, lat: null, lon: null, ...over });

  it("odometer increase ⇒ closed web trip", () => {
    detector.onSnapshot(web(0, { odometerKm: 1000, soc: 80 }), web(5, { odometerKm: 1012, soc: 78 }));
    const t = tripsRepo.latestTrip(db, "web")!;
    expect(t.startOdometer).toBe(1000);
    expect(t.endOdometer).toBe(1012);
    expect(t.distanceKm).toBe(12);
    expect(t.endTs).not.toBeNull();
  });

  it("SOC rise while odometer flat ⇒ web charging session", () => {
    detector.onSnapshot(web(0, { odometerKm: 1000, soc: 50 }), web(5, { odometerKm: 1000, soc: 57 }));
    const s = chargingRepo.latestSession(db, "web")!;
    expect(s.startSoc).toBe(50);
    expect(s.endSoc).toBe(57);
  });

  it("never derives across mixed sources", () => {
    const apiPrev = snap(0, { source: "api", odometerKm: 900 });
    detector.onSnapshot(apiPrev, web(5, { odometerKm: 1000, soc: 70 }));
    expect(tripsRepo.listTrips(db, { limit: 10, offset: 0 }).total).toBe(0);
    expect(chargingRepo.listSessions(db, { limit: 10, offset: 0 }).total).toBe(0);
  });
});

describe("boot reconciliation + crash guard", () => {
  it("closes an orphaned open session and trip against current status", () => {
    chargingRepo.createSession(db, {
      startTs: at(-120).toISOString(), endTs: null, startSoc: 40, endSoc: null,
      energyKwh: null, cost: null, pricePerKwh: null, maxPowerKw: null,
      chargerType: null, location: null, lat: null, lon: null, notes: null, source: "api",
    });
    tripsRepo.createTrip(db, {
      startTs: at(-90).toISOString(), endTs: null, startOdometer: 900, endOdometer: null,
      startSoc: 80, endSoc: null, distanceKm: null, energyKwh: null, consumption: null,
      durationMin: null, notes: null, source: "api",
    });
    detector.reconcile(snap(0, { isCharging: false, isPlugged: false, isParked: true, soc: 75, odometerKm: 950 }));
    expect(chargingRepo.openSession(db, "api")).toBeNull();
    expect(tripsRepo.openTrip(db, "api")).toBeNull();
    const t = tripsRepo.latestTrip(db, "api")!;
    expect(t.distanceKm).toBe(50);
  });

  it("reconcile is conservative: null flags, plugged cable, or web rows close nothing", () => {
    chargingRepo.createSession(db, {
      startTs: at(-120).toISOString(), endTs: null, startSoc: 40, endSoc: null,
      energyKwh: null, cost: null, pricePerKwh: null, maxPowerKw: null,
      chargerType: null, location: null, lat: null, lon: null, notes: null, source: "api",
    });
    tripsRepo.createTrip(db, {
      startTs: at(-90).toISOString(), endTs: null, startOdometer: 900, endOdometer: null,
      startSoc: 80, endSoc: null, distanceKm: null, energyKwh: null, consumption: null,
      durationMin: null, notes: null, source: "api",
    });
    // web row: isParked/isCharging null → must not close anything
    detector.reconcile(snap(0, { source: "web", isParked: null, isCharging: null }));
    // charge done but still plugged → session stays open
    detector.reconcile(snap(0, { isCharging: false, isPlugged: true, isParked: null }));
    expect(chargingRepo.openSession(db, "api")).not.toBeNull();
    // mid-drive with unknown parked state → trip stays open
    detector.reconcile(snap(0, { isCharging: null, isPlugged: false, isParked: null }));
    expect(tripsRepo.openTrip(db, "api")).not.toBeNull();
  });

  it("a failing handler never throws out of onSnapshot", () => {
    db.exec("DROP TABLE charging_sessions");
    expect(() =>
      detector.onSnapshot(snap(0, { isCharging: false }), snap(5, { isCharging: true }))
    ).not.toThrow();
  });

  it("a failing debounced trip commit never crashes (timer runs outside onSnapshot)", () => {
    detector.onSnapshot(snap(0, { isParked: true }), snap(5, { isParked: false }));
    db.exec("DROP TABLE trips");
    expect(() => vi.advanceTimersByTime(3 * 60_000 + 1)).not.toThrow();
  });
});
