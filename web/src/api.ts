export interface Snapshot {
  id: number;
  ts: string;
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
  source: "api" | "web" | "manual";
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
  consumption: number | null;
  durationMin: number | null;
  notes: string | null;
  source: string;
}

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
  chargerType: "home" | "ac" | "dc" | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
  notes: string | null;
  source: string;
}

export interface StatusResponse {
  snapshot: Snapshot | null;
  climatisationState: string | null;
  doorLockStatus: string | null;
  targetTemperatureC: number | null;
  connection: {
    state: "api" | "web" | "disconnected";
    lastError: string | null;
    pollerRunning: boolean;
    lastPollAt: string | null;
  };
}

export interface Stats {
  totalDistanceKm: number;
  totalEnergyUsedKwh: number;
  avgConsumption: number | null;
  totalChargedKwh: number;
  totalChargeCost: number;
  tripCount: number;
  chargeCount: number;
  trend: Array<{ id: number; startTs: string; consumption: number; distanceKm: number | null }>;
}

export interface Page<T> {
  items: T[];
  total: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  status: () => request<StatusResponse>("/api/status"),
  sync: () => request<{ synced: boolean; state: string; lastError: string | null }>("/api/sync", { method: "POST" }),
  connect: () =>
    request<{ connected: boolean; state: string; lastError: string | null }>("/api/connect", { method: "POST" }),
  stats: () => request<Stats>("/api/stats"),

  trips: (limit = 50, offset = 0) => request<Page<Trip>>(`/api/trips?limit=${limit}&offset=${offset}`),
  createTrip: (t: Partial<Trip>) => request<Trip>("/api/trips", { method: "POST", body: JSON.stringify(t) }),
  updateTrip: (id: number, t: Partial<Trip>) =>
    request<Trip>(`/api/trips/${id}`, { method: "PATCH", body: JSON.stringify(t) }),
  deleteTrip: (id: number) => request<{ deleted: boolean }>(`/api/trips/${id}`, { method: "DELETE" }),
  tripPositions: (id: number) =>
    request<Array<{ ts: string; lat: number; lon: number }>>(`/api/trips/${id}/positions`),

  charging: (limit = 50, offset = 0) =>
    request<Page<ChargingSession> & { summary: { count: number; totalEnergyKwh: number; totalCost: number } }>(
      `/api/charging?limit=${limit}&offset=${offset}`
    ),
  createCharge: (c: Partial<ChargingSession>) =>
    request<ChargingSession>("/api/charging", { method: "POST", body: JSON.stringify(c) }),
  updateCharge: (id: number, c: Partial<ChargingSession>) =>
    request<ChargingSession>(`/api/charging/${id}`, { method: "PATCH", body: JSON.stringify(c) }),
  deleteCharge: (id: number) => request<{ deleted: boolean }>(`/api/charging/${id}`, { method: "DELETE" }),

  settings: () => request<Record<string, string | null>>("/api/settings"),
  saveSettings: (s: Record<string, unknown>) =>
    request<{ saved: boolean }>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};
