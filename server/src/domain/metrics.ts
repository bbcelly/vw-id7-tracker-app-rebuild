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
