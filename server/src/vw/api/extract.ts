import type { SnapshotInsert } from "../../domain/types.js";
import type { VwIdData } from "./types.js";

/** Pure mapping from a selectivestatus+parking payload to a status snapshot. */
export function extractSnapshot(data: VwIdData, ts: string): SnapshotInsert {
  const chargingState = data.charging?.chargingStatus?.value?.chargingState ?? null;
  const externalPower = data.charging?.plugStatus?.value?.externalPower ?? null;

  return {
    ts,
    soc: data.charging?.batteryStatus?.value?.currentSOC_pct ?? null,
    rangeKm: data.charging?.batteryStatus?.value?.cruisingRangeElectric_km ?? null,
    odometerKm: data.measurements?.odometerStatus?.value?.odometer ?? null,
    isParked: data.parking?.data?.carIsParked ?? null,
    isCharging: chargingState !== null ? chargingState === "charging" : null,
    isPlugged:
      externalPower != null
        ? externalPower === "ready" || externalPower === "active"
        : null,
    chargingState,
    externalPower,
    targetSoc: data.charging?.chargingSettings?.value?.targetSOC_pct ?? null,
    lat: data.parking?.data?.lat ?? null,
    lon: data.parking?.data?.lon ?? null,
    raw: JSON.stringify(data),
    source: "api",
  };
}

/** Live-view extras not persisted as columns (read from idData / raw payload). */
export function extractLiveExtras(data: VwIdData): {
  climatisationState: string | null;
  doorLockStatus: string | null;
  targetTemperatureC: number | null;
} {
  return {
    climatisationState:
      data.climatisation?.climatisationStatus?.value?.climatisationState ?? null,
    doorLockStatus: data.access?.accessStatus?.value?.doorLockStatus ?? null,
    targetTemperatureC:
      data.climatisation?.climatisationSettings?.value?.targetTemperature_C ?? null,
  };
}
