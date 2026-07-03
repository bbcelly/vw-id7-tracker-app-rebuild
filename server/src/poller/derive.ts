// Polling-based trip + charging detection for the web fallback path.
//
// The primary API path detects trips/charges from npm-package events
// (notParked/parked/chargingStarted/…). The web fallback has no events and no
// parking/position data — only a monotonic odometer and SOC. So we reconstruct
// activity from consecutive web `vehicle_status` rows:
//   - odometer increased  ⇒ the car drove        → a trip segment
//   - SOC rose while odo flat ⇒ the car charged    → a charging segment
//
// Rows are written only on change (see writeWebStatusRow dedup), so a parked,
// idle car produces no rows. We therefore never leave sessions "open": each
// trip/session is kept closed at its last observed row and EXTENDED when the
// next row continues it (same boundary value, small time gap), otherwise a new
// one is INSERTED. This yields correct counts without dangling open rows.

export interface StatusRow {
  timestamp: Date;
  socPercent: number | null;
  odometerKm: number | null;
  // Explicit charging state from charging/status (web path). When known it is
  // the authoritative charging signal; null/absent falls back to SOC deltas.
  isCharging?: boolean | null;
}

/** Most-recent web trip, for the continue-vs-new decision. */
export interface TripRow {
  id: number;
  startTime: Date;
  endTime: Date | null;
  startOdoKm: number | null;
  endOdoKm: number | null;
  startSocPct: number | null;
  endSocPct: number | null;
}

/** Most-recent web charging session, for the continue-vs-new decision. */
export interface SessionRow {
  id: number;
  endTime: Date | null;
  startSocPct: number | null;
  endSocPct: number | null;
}

export interface DeriveOpts {
  pollIntervalMs: number;
  /** Max gap between rows that still counts as one continuous activity. */
  continueGapMs: number;
  batteryCapacityKwh: number;
  /** Min odometer increase (km) to open a new trip. */
  minTripKm: number;
  /** Min SOC rise (pct points) to open a new charging session. */
  minChargePct: number;
}

interface TripInsert {
  startTime: Date;
  endTime: Date;
  startOdoKm: number;
  endOdoKm: number;
  distanceKm: number;
  startSocPct: number | null;
  endSocPct: number | null;
  energyUsedKwh: number | null;
  consumptionKwhPer100km: number | null;
  durationMinutes: number;
}
interface TripExtend {
  endTime: Date;
  endOdoKm: number;
  distanceKm: number;
  endSocPct: number | null;
  energyUsedKwh: number | null;
  consumptionKwhPer100km: number | null;
  durationMinutes: number;
}
export type TripAction =
  | { kind: "none" }
  | { kind: "insert"; values: TripInsert }
  | { kind: "extend"; id: number; values: TripExtend };

interface ChargeInsert {
  startTime: Date;
  endTime: Date;
  startSocPct: number;
  endSocPct: number;
  energyChargedKwh: number;
}
interface ChargeExtend {
  endTime: Date;
  endSocPct: number;
  energyChargedKwh: number;
}
export type ChargingAction =
  | { kind: "none" }
  | { kind: "insert"; values: ChargeInsert }
  | { kind: "extend"; id: number; values: ChargeExtend };

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function durationMin(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

/** Decide what the new odometer reading means for trips. */
export function deriveTripAction(
  prev: StatusRow,
  curr: StatusRow,
  latestTrip: TripRow | null,
  opts: DeriveOpts
): TripAction {
  if (prev.odometerKm == null || curr.odometerKm == null) return { kind: "none" };
  const odoDelta = curr.odometerKm - prev.odometerKm;
  if (odoDelta <= 0) return { kind: "none" }; // not moving (parked / charging)

  const energy = (a: number | null, b: number | null): number | null =>
    a != null && b != null && a - b > 0 ? round2(((a - b) / 100) * opts.batteryCapacityKwh) : null;
  const consumption = (e: number | null, dist: number): number | null =>
    e != null && dist > 0 ? round2((e / dist) * 100) : null;

  // Continue the last web trip if this segment picks up exactly where it ended,
  // with no long park and no charge in between. A charge shows up as prev
  // reporting isCharging or a SOC above the trip's final SOC — merging across
  // it would corrupt the trip's energy/consumption.
  const chargedSinceTripEnd =
    prev.isCharging === true ||
    (latestTrip?.endSocPct != null &&
      prev.socPercent != null &&
      prev.socPercent > latestTrip.endSocPct);
  const continuable =
    latestTrip != null &&
    latestTrip.endTime != null &&
    latestTrip.endOdoKm === prev.odometerKm &&
    !chargedSinceTripEnd &&
    curr.timestamp.getTime() - latestTrip.endTime.getTime() <= opts.continueGapMs;

  if (continuable && latestTrip) {
    const dist = round1(curr.odometerKm - (latestTrip.startOdoKm ?? prev.odometerKm));
    const e = energy(latestTrip.startSocPct, curr.socPercent);
    return {
      kind: "extend",
      id: latestTrip.id,
      values: {
        endTime: curr.timestamp,
        endOdoKm: curr.odometerKm,
        distanceKm: dist,
        endSocPct: curr.socPercent,
        energyUsedKwh: e,
        consumptionKwhPer100km: consumption(e, dist),
        durationMinutes: durationMin(latestTrip.startTime, curr.timestamp),
      },
    };
  }

  if (odoDelta < opts.minTripKm) return { kind: "none" };

  // New trip. If continuous with prev, prev IS the departure; otherwise the car
  // was parked (no rows) and we estimate departure one poll before this reading.
  const gapMs = curr.timestamp.getTime() - prev.timestamp.getTime();
  const startTime =
    gapMs <= opts.continueGapMs
      ? prev.timestamp
      : new Date(curr.timestamp.getTime() - opts.pollIntervalMs);
  const dist = round1(odoDelta);
  const e = energy(prev.socPercent, curr.socPercent);
  return {
    kind: "insert",
    values: {
      startTime,
      endTime: curr.timestamp,
      startOdoKm: prev.odometerKm,
      endOdoKm: curr.odometerKm,
      distanceKm: dist,
      startSocPct: prev.socPercent,
      endSocPct: curr.socPercent,
      energyUsedKwh: e,
      consumptionKwhPer100km: consumption(e, dist),
      durationMinutes: durationMin(startTime, curr.timestamp),
    },
  };
}

/**
 * Decide what the new reading means for charging. Prefers the explicit
 * chargingState signal (reliable, from charging/status) when known; otherwise
 * falls back to the SOC-delta heuristic (primary/API path or older web rows).
 */
export function deriveChargingAction(
  prev: StatusRow,
  curr: StatusRow,
  latestSession: SessionRow | null,
  opts: DeriveOpts
): ChargingAction {
  if (curr.isCharging != null) {
    const action = deriveChargingFromState(prev, curr, latestSession, opts);
    if (action.kind !== "none") return action;
    // A charge that starts AND finishes between two observed rows leaves both
    // reporting not-charging; only the parked SOC rise remains as evidence.
    if (curr.isCharging !== true && prev.isCharging !== true) {
      return deriveChargingFromSocDelta(prev, curr, latestSession, opts);
    }
    return action;
  }
  return deriveChargingFromSocDelta(prev, curr, latestSession, opts);
}

/**
 * State-based detection: a session spans the rows where the car reports
 * charging. The start row (false→true) opens it at the pre-charge SOC; ongoing
 * rows extend it; the stop row (true→false) carries the final SOC and closes
 * it. Unlike SOC-delta this catches slow charges (<threshold per poll) and
 * never mistakes regen for a charge.
 */
function deriveChargingFromState(
  prev: StatusRow,
  curr: StatusRow,
  latestSession: SessionRow | null,
  opts: DeriveOpts
): ChargingAction {
  const isCharging = curr.isCharging === true;
  const wasCharging = prev.isCharging === true;
  if (!isCharging && !wasCharging) return { kind: "none" };
  if (prev.socPercent == null || curr.socPercent == null) return { kind: "none" };

  const continuable =
    latestSession != null &&
    latestSession.endTime != null &&
    latestSession.endSocPct === prev.socPercent &&
    curr.timestamp.getTime() - latestSession.endTime.getTime() <= opts.continueGapMs;

  // Continue the open session — whether this is an ongoing charging row or the
  // stop reading that carries the final SOC. Either way close it at curr.
  if (continuable && latestSession) {
    const start = latestSession.startSocPct ?? prev.socPercent;
    return {
      kind: "extend",
      id: latestSession.id,
      values: {
        endTime: curr.timestamp,
        endSocPct: curr.socPercent,
        energyChargedKwh: round2(((curr.socPercent - start) / 100) * opts.batteryCapacityKwh),
      },
    };
  }

  // Open a new session. prev is the pre-charge reading → its SOC is the start.
  const gapMs = curr.timestamp.getTime() - prev.timestamp.getTime();
  const startTime =
    gapMs <= opts.continueGapMs
      ? prev.timestamp
      : new Date(curr.timestamp.getTime() - opts.pollIntervalMs);
  return {
    kind: "insert",
    values: {
      startTime,
      endTime: curr.timestamp,
      startSocPct: prev.socPercent,
      endSocPct: curr.socPercent,
      energyChargedKwh: round2((Math.max(0, curr.socPercent - prev.socPercent) / 100) * opts.batteryCapacityKwh),
    },
  };
}

/** Heuristic fallback: detect charging from a parked SOC rise.
 *  Exported for the API path (client.ts SOC-delta detection) so both data
 *  sources share one implementation. */
export function deriveChargingFromSocDelta(
  prev: StatusRow,
  curr: StatusRow,
  latestSession: SessionRow | null,
  opts: DeriveOpts
): ChargingAction {
  if (prev.socPercent == null || curr.socPercent == null) return { kind: "none" };
  // Charging happens parked: ignore SOC rises while the odometer moves (regen).
  if (prev.odometerKm != null && curr.odometerKm != null && curr.odometerKm - prev.odometerKm > 0) {
    return { kind: "none" };
  }
  const socDelta = curr.socPercent - prev.socPercent;
  if (socDelta <= 0) return { kind: "none" };

  const continuable =
    latestSession != null &&
    latestSession.endTime != null &&
    latestSession.endSocPct === prev.socPercent &&
    curr.timestamp.getTime() - latestSession.endTime.getTime() <= opts.continueGapMs;

  if (continuable && latestSession) {
    const start = latestSession.startSocPct ?? prev.socPercent;
    return {
      kind: "extend",
      id: latestSession.id,
      values: {
        endTime: curr.timestamp,
        endSocPct: curr.socPercent,
        energyChargedKwh: round2(((curr.socPercent - start) / 100) * opts.batteryCapacityKwh),
      },
    };
  }

  if (socDelta < opts.minChargePct) return { kind: "none" };

  const gapMs = curr.timestamp.getTime() - prev.timestamp.getTime();
  const startTime =
    gapMs <= opts.continueGapMs
      ? prev.timestamp
      : new Date(curr.timestamp.getTime() - opts.pollIntervalMs);
  return {
    kind: "insert",
    values: {
      startTime,
      endTime: curr.timestamp,
      startSocPct: prev.socPercent,
      endSocPct: curr.socPercent,
      energyChargedKwh: round2((socDelta / 100) * opts.batteryCapacityKwh),
    },
  };
}
