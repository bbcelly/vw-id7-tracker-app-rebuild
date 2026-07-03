import { test, expect } from "vitest";
import {
  deriveTripAction,
  deriveChargingAction,
  type StatusRow,
  type TripRow,
  type SessionRow,
  type DeriveOpts,
  type TripAction,
  type ChargingAction,
} from "../../src/poller/derive.js";

const MIN = 60_000;
const OPTS: DeriveOpts = {
  pollIntervalMs: 5 * MIN,
  continueGapMs: 13 * MIN, // ~2.5 polls
  batteryCapacityKwh: 86,
  minTripKm: 1,
  minChargePct: 2,
};
const t = (min: number) => new Date(2026, 5, 9, 8, min, 0);
const row = (min: number, soc: number | null, odo: number | null): StatusRow => ({
  timestamp: t(min),
  socPercent: soc,
  odometerKm: odo,
});
// Row carrying the explicit charging-state flag (from charging/status).
const rowC = (
  min: number,
  soc: number | null,
  odo: number | null,
  isCharging: boolean | null
): StatusRow => ({ timestamp: t(min), socPercent: soc, odometerKm: odo, isCharging });

test("odometer flat → no trip", () => {
  expect(deriveTripAction(row(0, 73, 100), row(5, 71, 100), null, OPTS).kind).toBe("none");
});

test("odometer up → new trip, distance + energy + consumption computed", () => {
  const a = deriveTripAction(row(0, 80, 100), row(5, 78, 110), null, OPTS) as TripAction & { kind: "insert" };
  expect(a.kind).toBe("insert");
  expect(a.values.startOdoKm).toBe(100);
  expect(a.values.endOdoKm).toBe(110);
  expect(a.values.distanceKm).toBe(10);
  // (80-78)/100 * 86 = 1.72 kWh over 10km → 17.2 kWh/100km
  expect(a.values.energyUsedKwh).toBe(1.72);
  expect(a.values.consumptionKwhPer100km).toBe(17.2);
});

test("continuing odometer extends the open trip instead of opening a new one", () => {
  const latest: TripRow = {
    id: 7, startTime: t(0), endTime: t(5), startOdoKm: 100, endOdoKm: 110, startSocPct: 80, endSocPct: 78,
  };
  const a = deriveTripAction(row(5, 78, 110), row(10, 75, 122), latest, OPTS) as TripAction & { kind: "extend" };
  expect(a.kind).toBe("extend");
  expect(a.id).toBe(7);
  expect(a.values.endOdoKm).toBe(122);
  expect(a.values.distanceKm).toBe(22); // from trip start 100
  expect(a.values.durationMinutes).toBe(10);
});

test("odometer jump after a long park → new trip with estimated start time", () => {
  const latest: TripRow = {
    id: 7, startTime: t(0), endTime: t(5), startOdoKm: 100, endOdoKm: 110, startSocPct: 80, endSocPct: 78,
  };
  // 4h later, drove 8km
  const a = deriveTripAction(
    { timestamp: t(5), socPercent: 78, odometerKm: 110 },
    { timestamp: new Date(2026, 5, 9, 12, 0, 0), socPercent: 76, odometerKm: 118 },
    latest, OPTS
  ) as TripAction & { kind: "insert" };
  expect(a.kind).toBe("insert");
  expect(a.values.startOdoKm).toBe(110);
  expect(a.values.endOdoKm).toBe(118);
  // start estimated one poll before arrival, not 4h of parking
  expect(a.values.durationMinutes).toBe(5);
});

test("SOC up while parked → new charging session", () => {
  const a = deriveChargingAction(row(0, 50, 100), row(5, 55, 100), null, OPTS) as ChargingAction & { kind: "insert" };
  expect(a.kind).toBe("insert");
  expect(a.values.startSocPct).toBe(50);
  expect(a.values.endSocPct).toBe(55);
  expect(a.values.energyChargedKwh).toBe(4.3); // 5% of 86
});

test("SOC up while driving (odo moving) → ignored as regen, not a charge", () => {
  expect(deriveChargingAction(row(0, 50, 100), row(5, 53, 108), null, OPTS).kind).toBe("none");
});

test("SOC rise below threshold with no open session → none", () => {
  expect(deriveChargingAction(row(0, 50, 100), row(5, 51, 100), null, OPTS).kind).toBe("none");
});

test("continuing charge extends the session (even by a sub-threshold tick)", () => {
  const latest: SessionRow = { id: 3, endTime: t(5), startSocPct: 50, endSocPct: 55 };
  const a = deriveChargingAction(row(5, 55, 100), row(10, 56, 100), latest, OPTS) as ChargingAction & { kind: "extend" };
  expect(a.kind).toBe("extend");
  expect(a.id).toBe(3);
  expect(a.values.endSocPct).toBe(56);
  expect(a.values.energyChargedKwh).toBe(5.16); // (56-50)% of 86
});

// --- charging detection from the explicit chargingState signal (web charging/status) ---
test("chargingState false→true opens a session even below the SOC-delta threshold", () => {
  // +1% would be ignored by SOC-delta detection, but the state says it's charging.
  const a = deriveChargingAction(rowC(0, 60, 100, false), rowC(5, 61, 100, true), null, OPTS) as ChargingAction & { kind: "insert" };
  expect(a.kind).toBe("insert");
  expect(a.values.startSocPct).toBe(60);
  expect(a.values.endSocPct).toBe(61);
  expect(a.values.energyChargedKwh).toBe(0.86); // 1% of 86
});

test("chargingState true→true extends the session even when SOC is flat (charge holding)", () => {
  const latest: SessionRow = { id: 4, endTime: t(10), startSocPct: 70, endSocPct: 80 };
  const a = deriveChargingAction(rowC(10, 80, 100, true), rowC(15, 80, 100, true), latest, OPTS) as ChargingAction & { kind: "extend" };
  expect(a.kind).toBe("extend");
  expect(a.id).toBe(4);
  expect(a.values.endSocPct).toBe(80);
  expect(a.values.energyChargedKwh).toBe(8.6); // (80-70)% of 86
});

test("a big parked SOC rise between two non-charging rows → charge completed between polls, recorded", () => {
  // Car was unreachable/asleep while it charged 60→85; both bracketing rows say
  // isCharging=false. The state signal alone would drop the charge entirely.
  const a = deriveChargingAction(rowC(0, 60, 100, false), rowC(240, 85, 100, false), null, OPTS) as ChargingAction & { kind: "insert" };
  expect(a.kind).toBe("insert");
  expect(a.values.startSocPct).toBe(60);
  expect(a.values.endSocPct).toBe(85);
});

test("a sub-threshold SOC drift while chargingState is false → still not a charge", () => {
  expect(deriveChargingAction(rowC(0, 60, 100, false), rowC(5, 61, 100, false), null, OPTS).kind).toBe("none");
});

test("a slow AC charge (<threshold per poll) is one session via chargingState, not zero", () => {
  const sessions: SessionRow[] = [];
  let seq = 0;
  const rows: StatusRow[] = [
    rowC(0, 60, 100, false), // plugged, not yet charging
    rowC(5, 61, 100, true),  // +1%
    rowC(10, 62, 100, true), // +1%
    rowC(15, 63, 100, true), // +1%
    rowC(20, 64, 100, false), // charge stops, final reading
  ];
  for (let i = 1; i < rows.length; i++) {
    const ca = deriveChargingAction(rows[i - 1], rows[i], sessions[sessions.length - 1] ?? null, OPTS);
    if (ca.kind === "insert") sessions.push({ id: ++seq, endTime: ca.values.endTime, startSocPct: ca.values.startSocPct, endSocPct: ca.values.endSocPct });
    else if (ca.kind === "extend") {
      const s = sessions.find((x) => x.id === ca.id)!;
      s.endTime = ca.values.endTime;
      s.endSocPct = ca.values.endSocPct;
    }
  }
  expect(sessions.length).toBe(1);
  expect(sessions[0].startSocPct).toBe(60);
  expect(sessions[0].endSocPct).toBe(64); // final reading captured at stop
});

test("a drive after an intermediate charge starts a new trip instead of extending", () => {
  // Trip ended at odo 138 / soc 70; the car then charged to 75 (odo flat);
  // then drove off. Extending trip A would swallow the charge and corrupt
  // energy/consumption (start SOC 80 vs end 73 ignores the +5% charged).
  const latest: TripRow = {
    id: 7, startTime: t(0), endTime: t(20), startOdoKm: 100, endOdoKm: 138, startSocPct: 80, endSocPct: 70,
  };
  const a = deriveTripAction(rowC(25, 75, 138, true), rowC(30, 73, 150, false), latest, OPTS);
  expect(a.kind).toBe("insert");
});

// --- end-to-end sequence: a drive then a charge must yield exactly 1 trip + 1 session ---
test("a full drive (4 polls) then a charge (3 polls) → 1 trip, 1 session", () => {
  const trips: Array<{ id: number; startTime: Date; endTime: Date | null; startOdoKm: number | null; endOdoKm: number | null; startSocPct: number | null; endSocPct: number | null }> = [];
  const sessions: Array<{ id: number; endTime: Date | null; startSocPct: number | null; endSocPct: number | null }> = [];
  let tripSeq = 0, sessSeq = 0;

  const seq: StatusRow[] = [
    row(0, 80, 100),   // parked baseline
    row(5, 78, 108),   // driving
    row(10, 75, 120),  // driving
    row(15, 72, 130),  // driving
    row(20, 70, 138),  // driving (arrives)
    row(40, 73, 138),  // plugged in, charging (odo flat) — 20min gap, within continueGap
    row(45, 78, 138),  // charging
    row(50, 82, 138),  // charging
  ];

  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1], curr = seq[i];
    const ta = deriveTripAction(prev, curr, trips[trips.length - 1] ?? null, OPTS);
    if (ta.kind === "insert") trips.push({ id: ++tripSeq, ...ta.values });
    else if (ta.kind === "extend") {
      const tr = trips.find((x) => x.id === ta.id)!;
      tr.endTime = ta.values.endTime; tr.endOdoKm = ta.values.endOdoKm;
    }
    const ca = deriveChargingAction(prev, curr, sessions[sessions.length - 1] ?? null, OPTS);
    if (ca.kind === "insert") sessions.push({ id: ++sessSeq, endTime: ca.values.endTime, startSocPct: ca.values.startSocPct, endSocPct: ca.values.endSocPct });
    else if (ca.kind === "extend") {
      const s = sessions.find((x) => x.id === ca.id)!;
      s.endTime = ca.values.endTime; s.endSocPct = ca.values.endSocPct;
    }
  }

  expect(trips.length).toBe(1);
  expect(trips[0].startOdoKm).toBe(100);
  expect(trips[0].endOdoKm).toBe(138);
  expect(sessions.length).toBe(1);
  expect(sessions[0].startSocPct).toBe(70);
  expect(sessions[0].endSocPct).toBe(82);
});
