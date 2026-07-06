export type StatusSource = "api" | "web" | "manual";
export type EntitySource = "api" | "web" | "manual";
export type ChargerType = "home" | "ac" | "dc";

export interface Snapshot {
  id: number;
  ts: string; // UTC ISO-8601
  soc: number | null;
  rangeKm: number | null;
  odometerKm: number | null;
  isParked: boolean | null;
  isCharging: boolean | null;
  isPlugged: boolean | null;
  chargingState: string | null;
  externalPower: string | null;
  targetSoc: number | null;
  lat: number | null;
  lon: number | null;
  raw: string | null;
  source: StatusSource;
}
export type SnapshotInsert = Omit<Snapshot, "id">;

/** A single point on the battery-history chart — SoC over time. */
export interface SocPoint {
  ts: string; // UTC ISO-8601
  soc: number;
  targetSoc: number | null;
  isCharging: boolean;
}

export interface Trip {
  id: number;
  startTs: string;
  endTs: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
  startSoc: number | null;
  endSoc: number | null;
  distanceKm: number | null;
  energyKwh: number | null;
  consumption: number | null; // kWh/100km
  durationMin: number | null;
  notes: string | null;
  source: EntitySource;
}
export type TripInsert = Omit<Trip, "id">;

export interface ChargingSession {
  id: number;
  startTs: string;
  endTs: string | null;
  startSoc: number | null;
  endSoc: number | null;
  energyKwh: number | null;
  cost: number | null;
  pricePerKwh: number | null;
  maxPowerKw: number | null;
  chargerType: ChargerType | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  notes: string | null;
  source: EntitySource;
}
export type ChargingInsert = Omit<ChargingSession, "id">;

export interface TripPosition {
  id: number;
  tripId: number;
  ts: string;
  lat: number;
  lon: number;
}

export const DEFAULT_BATTERY_KWH = 77;
export const DEFAULT_POLL_INTERVAL_MIN = 5;
