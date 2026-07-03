export interface WebStatus {
  rangeKm: number | null;
  odometerKm: number | null;
  socPercent: number | null;
  isCharging: boolean | null;
  isPlugged: boolean | null;
  chargingState: string | null;
  externalPower: string | null;
  capturedAt: Date | null;
  raw: unknown;
}

function parseTs(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface RangeBody {
  data?: Array<{ id?: string; carCapturedTimestamp?: string; properties?: Array<{ name?: string; value?: string }> }>;
}
interface MaintBody {
  data?: { mileage_km?: number | null; carCapturedTimestamp?: string };
}
interface ChargingBody {
  data?: {
    batteryStatus?: { carCapturedTimestamp?: string; currentSOC_pct?: number | null; cruisingRangeElectric_km?: number | null };
    chargingStatus?: { carCapturedTimestamp?: string; chargingState?: string | null };
    plugStatus?: { externalPower?: string | null };
  };
}

export function extractWebStatus(
  rangeBody: unknown,
  maintenanceBody: unknown,
  chargingBody: unknown = null
): WebStatus {
  let rangeKm: number | null = null;
  let rangeAt: Date | null = null;
  const rb = (rangeBody ?? {}) as RangeBody;
  const entry = rb.data?.find((d) => d.id === "range") ?? rb.data?.[0];
  if (entry) {
    rangeAt = parseTs(entry.carCapturedTimestamp);
    const prop = entry.properties?.find((p) => p.name === "electricRange_km");
    if (prop?.value != null && prop.value !== "") {
      const n = Number(prop.value);
      rangeKm = Number.isFinite(n) ? n : null;
    }
  }

  let odometerKm: number | null = null;
  let maintAt: Date | null = null;
  const mb = (maintenanceBody ?? {}) as MaintBody;
  if (mb.data) {
    maintAt = parseTs(mb.data.carCapturedTimestamp);
    if (typeof mb.data.mileage_km === "number") odometerKm = mb.data.mileage_km;
  }

  // charging/status: SOC, charging state and plug status (mirrors mapper.ts conventions).
  let socPercent: number | null = null;
  let chargingState: string | null = null;
  let externalPower: string | null = null;
  let isCharging: boolean | null = null;
  let isPlugged: boolean | null = null;
  let chargingAt: Date | null = null;
  const cb = (chargingBody ?? {}) as ChargingBody;
  if (cb.data) {
    const bat = cb.data.batteryStatus;
    chargingAt = parseTs(bat?.carCapturedTimestamp ?? cb.data.chargingStatus?.carCapturedTimestamp);
    if (typeof bat?.currentSOC_pct === "number") socPercent = bat.currentSOC_pct;
    // charging/status carries a fresh range too — prefer it, fall back to measurements.
    if (rangeKm == null && typeof bat?.cruisingRangeElectric_km === "number") {
      rangeKm = bat.cruisingRangeElectric_km;
    }
    chargingState = cb.data.chargingStatus?.chargingState ?? null;
    isCharging = chargingState != null ? chargingState === "charging" : null;
    externalPower = cb.data.plugStatus?.externalPower ?? null;
    isPlugged = externalPower != null ? externalPower === "ready" || externalPower === "active" : null;
  }

  return {
    rangeKm,
    odometerKm,
    socPercent,
    isCharging,
    isPlugged,
    chargingState,
    externalPower,
    capturedAt: chargingAt ?? rangeAt ?? maintAt,
    raw: { range: rangeBody ?? null, maintenance: maintenanceBody ?? null, charging: chargingBody ?? null },
  };
}
