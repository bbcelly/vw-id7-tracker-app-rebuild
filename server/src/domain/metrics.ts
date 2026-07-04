import type { ChargingInsert, TripInsert } from "./types.js";

export function round(v: number | null, decimals: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** decimals;
  return Math.round((v + Number.EPSILON) * f) / f;
}

function minutesBetween(startTs: string, endTs: string | null): number | null {
  if (!endTs) return null;
  const ms = Date.parse(endTs) - Date.parse(startTs);
  return Number.isFinite(ms) ? round(ms / 60000, 1) : null;
}

/**
 * Fill derived trip fields per the domain rules: manually supplied values
 * always win; computed values only fill gaps. Rounding: distance 1dp,
 * energy/consumption 2dp.
 */
export function finalizeTrip<T extends TripInsert>(trip: T, batteryKwh: number): T {
  const distance =
    trip.distanceKm ??
    (trip.startOdometer !== null && trip.endOdometer !== null
      ? round(trip.endOdometer - trip.startOdometer, 1)
      : null);

  const energy =
    trip.energyKwh ??
    (trip.startSoc !== null && trip.endSoc !== null
      ? round(((trip.startSoc - trip.endSoc) / 100) * batteryKwh, 2)
      : null);

  const consumption =
    trip.consumption ??
    (energy !== null && distance !== null && distance > 0
      ? round((energy / distance) * 100, 2)
      : null);

  return {
    ...trip,
    distanceKm: distance,
    energyKwh: energy,
    consumption,
    durationMin: trip.durationMin ?? minutesBetween(trip.startTs, trip.endTs),
  };
}

// Which derived field must be recomputed when which input fields change.
// A PATCH only invalidates a derived value when it touches one of that
// value's inputs — otherwise a manually-entered value from an earlier
// request must survive ("manual values always win").
const TRIP_DERIVED_DEPS: Record<string, (keyof TripInsert)[]> = {
  distanceKm: ["startOdometer", "endOdometer"],
  energyKwh: ["startSoc", "endSoc"],
  consumption: ["startOdometer", "endOdometer", "startSoc", "endSoc", "distanceKm", "energyKwh"],
  durationMin: ["startTs", "endTs"],
};

const CHARGE_DERIVED_DEPS: Record<string, (keyof ChargingInsert)[]> = {
  energyKwh: ["startSoc", "endSoc"],
  cost: ["startSoc", "endSoc", "energyKwh", "pricePerKwh"],
};

function applyPatch<T extends Record<string, unknown>>(
  existing: T,
  patch: Partial<T>,
  deps: Record<string, (keyof T)[]>
): T {
  const merged: T = { ...existing, ...patch };
  for (const [field, inputs] of Object.entries(deps)) {
    if (field in patch) continue; // explicitly set in this write — manual wins
    if (inputs.some((k) => (k as string) in patch)) {
      (merged as Record<string, unknown>)[field] = null; // input changed — recompute
    }
  }
  return merged;
}

/** Merge a PATCH into an existing trip, recomputing only affected derived fields. */
export function mergeTripPatch<T extends TripInsert>(
  existing: T,
  patch: Partial<TripInsert>,
  batteryKwh: number
): T {
  return finalizeTrip(applyPatch(existing, patch as Partial<T>, TRIP_DERIVED_DEPS as never), batteryKwh);
}

/** Merge a PATCH into an existing charging session, recomputing only affected derived fields. */
export function mergeChargePatch<T extends ChargingInsert>(
  existing: T,
  patch: Partial<ChargingInsert>,
  batteryKwh: number
): T {
  return finalizeCharge(applyPatch(existing, patch as Partial<T>, CHARGE_DERIVED_DEPS as never), batteryKwh);
}

/** Same gap-filling contract for charging sessions. */
export function finalizeCharge<T extends ChargingInsert>(
  sess: T,
  batteryKwh: number
): T {
  const energy =
    sess.energyKwh ??
    (sess.startSoc !== null && sess.endSoc !== null
      ? round(((sess.endSoc - sess.startSoc) / 100) * batteryKwh, 2)
      : null);

  const cost =
    sess.cost ??
    (energy !== null && sess.pricePerKwh !== null
      ? round(energy * sess.pricePerKwh, 2)
      : null);

  return { ...sess, energyKwh: energy, cost };
}
