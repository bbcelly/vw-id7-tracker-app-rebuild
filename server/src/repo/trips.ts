import type Database from "better-sqlite3";
import type { Trip, TripInsert } from "../domain/types.js";

const COLS: Record<keyof TripInsert, string> = {
  startTs: "start_ts",
  endTs: "end_ts",
  startOdometer: "start_odometer",
  endOdometer: "end_odometer",
  startSoc: "start_soc",
  endSoc: "end_soc",
  distanceKm: "distance_km",
  energyKwh: "energy_kwh",
  consumption: "consumption",
  durationMin: "duration_min",
  notes: "notes",
  source: "source",
};

function rowToTrip(r: any): Trip {
  return {
    id: r.id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    startOdometer: r.start_odometer,
    endOdometer: r.end_odometer,
    startSoc: r.start_soc,
    endSoc: r.end_soc,
    distanceKm: r.distance_km,
    energyKwh: r.energy_kwh,
    consumption: r.consumption,
    durationMin: r.duration_min,
    notes: r.notes,
    source: r.source,
  };
}

export function createTrip(db: Database.Database, t: TripInsert): Trip {
  const res = db
    .prepare(
      `INSERT INTO trips (${Object.values(COLS).join(", ")})
       VALUES (${Object.keys(COLS).map(() => "?").join(", ")})`
    )
    .run(...(Object.keys(COLS) as (keyof TripInsert)[]).map((k) => t[k]));
  return { ...t, id: Number(res.lastInsertRowid) };
}

export function getTrip(db: Database.Database, id: number): Trip | null {
  const r = db.prepare("SELECT * FROM trips WHERE id = ?").get(id);
  return r ? rowToTrip(r) : null;
}

export function updateTrip(
  db: Database.Database,
  id: number,
  patch: Partial<TripInsert>
): Trip | null {
  const keys = (Object.keys(patch) as (keyof TripInsert)[]).filter((k) => k in COLS);
  if (keys.length > 0) {
    db.prepare(
      `UPDATE trips SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")} WHERE id = ?`
    ).run(...keys.map((k) => patch[k] as any), id);
  }
  return getTrip(db, id);
}

export function deleteTrip(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM trips WHERE id = ?").run(id).changes > 0;
}

export function listTrips(
  db: Database.Database,
  opts: { limit: number; offset: number }
): { items: Trip[]; total: number } {
  const items = db
    .prepare("SELECT * FROM trips ORDER BY start_ts DESC, id DESC LIMIT ? OFFSET ?")
    .all(opts.limit, opts.offset)
    .map(rowToTrip);
  const total = (db.prepare("SELECT COUNT(*) n FROM trips").get() as any).n;
  return { items, total };
}

/** Every trip, oldest first — for full CSV export. */
export function allTrips(db: Database.Database): Trip[] {
  return db.prepare("SELECT * FROM trips ORDER BY start_ts, id").all().map(rowToTrip);
}

/**
 * Insert or (when the id already exists) update a trip by explicit id — the
 * primitive behind CSV import's upsert-by-id. A row with no id (id <= 0) is
 * inserted with an auto-assigned id.
 */
export function upsertTrip(db: Database.Database, t: Trip): "inserted" | "updated" {
  if (t.id && getTrip(db, t.id)) {
    const { id: _id, ...rest } = t;
    updateTrip(db, t.id, rest);
    return "updated";
  }
  if (t.id) {
    db.prepare(
      `INSERT INTO trips (id, ${Object.values(COLS).join(", ")})
       VALUES (?, ${Object.keys(COLS).map(() => "?").join(", ")})`
    ).run(t.id, ...(Object.keys(COLS) as (keyof TripInsert)[]).map((k) => t[k]));
    return "inserted";
  }
  createTrip(db, t);
  return "inserted";
}

/** The currently open detected trip (no end time) for a source, if any. */
export function openTrip(db: Database.Database, source: string = "api"): Trip | null {
  const r = db
    .prepare("SELECT * FROM trips WHERE end_ts IS NULL AND source = ? ORDER BY start_ts DESC LIMIT 1")
    .get(source);
  return r ? rowToTrip(r) : null;
}

/** Most recent trip of a source (open or closed) — for continue-vs-new decisions. */
export function latestTrip(db: Database.Database, source: string): Trip | null {
  const r = db
    .prepare("SELECT * FROM trips WHERE source = ? ORDER BY start_ts DESC, id DESC LIMIT 1")
    .get(source);
  return r ? rowToTrip(r) : null;
}
