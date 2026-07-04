import type { ChargerType, StatusSource } from "./types.js";

export interface ChargeSignal {
  powerKw: number | null;
  chargeType: "ac" | "dc" | null;
}

/** Charger telemetry from a snapshot's raw payload. Both sources report
 *  chargePower_kW + chargeType, just at different depths. */
export function chargeSignal(source: StatusSource, raw: string | null): ChargeSignal {
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, any>) : null;
    const cs =
      source === "api"
        ? parsed?.charging?.chargingStatus?.value
        : parsed?.charging?.data?.chargingStatus;
    const powerKw = typeof cs?.chargePower_kW === "number" ? cs.chargePower_kW : null;
    const chargeType = cs?.chargeType === "dc" ? "dc" : cs?.chargeType === "ac" ? "ac" : null;
    return { powerKw, chargeType };
  } catch {
    return { powerKw: null, chargeType: null };
  }
}

/** Sessions default to home charging; only an explicit DC signal — or power
 *  beyond the 22 kW AC ceiling — labels them dc. Public AC still reads as
 *  home (indistinguishable from a wallbox) and can be re-labeled by hand. */
export function chargerTypeFromSignal(s: ChargeSignal): ChargerType {
  if (s.chargeType === "dc" || (s.powerKw ?? 0) > 22) return "dc";
  return "home";
}
