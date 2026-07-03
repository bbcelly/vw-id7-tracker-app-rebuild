import type Database from "better-sqlite3";
import type { ChargingSession, ChargingInsert } from "../domain/types.js";

const COLS: Record<keyof ChargingInsert, string> = {
  startTs: "start_ts",
  endTs: "end_ts",
  startSoc: "start_soc",
  endSoc: "end_soc",
  energyKwh: "energy_kwh",
  cost: "cost",
  pricePerKwh: "price_per_kwh",
  maxPowerKw: "max_power_kw",
  chargerType: "charger_type",
  location: "location",
  lat: "lat",
  lon: "lon",
  notes: "notes",
  source: "source",
};

function rowToSession(r: any): ChargingSession {
  return {
    id: r.id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    startSoc: r.start_soc,
    endSoc: r.end_soc,
    energyKwh: r.energy_kwh,
    cost: r.cost,
    pricePerKwh: r.price_per_kwh,
    maxPowerKw: r.max_power_kw,
    chargerType: r.charger_type,
    location: r.location,
    lat: r.lat,
    lon: r.lon,
    notes: r.notes,
    source: r.source,
  };
}

export function createSession(db: Database.Database, s: ChargingInsert): ChargingSession {
  const res = db
    .prepare(
      `INSERT INTO charging_sessions (${Object.values(COLS).join(", ")})
       VALUES (${Object.keys(COLS).map(() => "?").join(", ")})`
    )
    .run(...(Object.keys(COLS) as (keyof ChargingInsert)[]).map((k) => s[k]));
  return { ...s, id: Number(res.lastInsertRowid) };
}

export function getSession(db: Database.Database, id: number): ChargingSession | null {
  const r = db.prepare("SELECT * FROM charging_sessions WHERE id = ?").get(id);
  return r ? rowToSession(r) : null;
}

export function updateSession(
  db: Database.Database,
  id: number,
  patch: Partial<ChargingInsert>
): ChargingSession | null {
  const keys = (Object.keys(patch) as (keyof ChargingInsert)[]).filter((k) => k in COLS);
  if (keys.length > 0) {
    db.prepare(
      `UPDATE charging_sessions SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")} WHERE id = ?`
    ).run(...keys.map((k) => patch[k] as any), id);
  }
  return getSession(db, id);
}

export function deleteSession(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM charging_sessions WHERE id = ?").run(id).changes > 0;
}

export function listSessions(
  db: Database.Database,
  opts: { limit: number; offset: number }
): { items: ChargingSession[]; total: number } {
  const items = db
    .prepare("SELECT * FROM charging_sessions ORDER BY start_ts DESC, id DESC LIMIT ? OFFSET ?")
    .all(opts.limit, opts.offset)
    .map(rowToSession);
  const total = (db.prepare("SELECT COUNT(*) n FROM charging_sessions").get() as any).n;
  return { items, total };
}

/** The currently open auto-detected charging session, if any. */
export function openSession(db: Database.Database): ChargingSession | null {
  const r = db
    .prepare("SELECT * FROM charging_sessions WHERE end_ts IS NULL AND source = 'auto' ORDER BY start_ts DESC LIMIT 1")
    .get();
  return r ? rowToSession(r) : null;
}

export function summary(db: Database.Database): {
  count: number;
  totalEnergyKwh: number;
  totalCost: number;
} {
  const r = db
    .prepare(
      "SELECT COUNT(*) count, COALESCE(SUM(energy_kwh),0) energy, COALESCE(SUM(cost),0) cost FROM charging_sessions"
    )
    .get() as any;
  return { count: r.count, totalEnergyKwh: r.energy, totalCost: r.cost };
}
