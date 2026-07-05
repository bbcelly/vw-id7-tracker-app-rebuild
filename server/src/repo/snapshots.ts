import type Database from "better-sqlite3";
import type { Snapshot, SnapshotInsert, StatusSource } from "../domain/types.js";

const bool = (v: unknown): boolean | null => (v === null ? null : v === 1);
const toInt = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

function rowToSnapshot(r: any): Snapshot {
  return {
    id: r.id,
    ts: r.ts,
    soc: r.soc,
    rangeKm: r.range_km,
    odometerKm: r.odometer_km,
    isParked: bool(r.is_parked),
    isCharging: bool(r.is_charging),
    isPlugged: bool(r.is_plugged),
    chargingState: r.charging_state,
    externalPower: r.external_power,
    targetSoc: r.target_soc,
    lat: r.lat,
    lon: r.lon,
    raw: r.raw,
    source: r.source,
  };
}

export function insertSnapshot(db: Database.Database, s: SnapshotInsert): Snapshot {
  const res = db
    .prepare(
      `INSERT INTO vehicle_status
       (ts, soc, range_km, odometer_km, is_parked, is_charging, is_plugged,
        charging_state, external_power, target_soc, lat, lon, raw, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.ts, s.soc, s.rangeKm, s.odometerKm,
      toInt(s.isParked), toInt(s.isCharging), toInt(s.isPlugged),
      s.chargingState, s.externalPower, s.targetSoc, s.lat, s.lon, s.raw, s.source
    );
  return { ...s, id: Number(res.lastInsertRowid) };
}

/** Every snapshot, oldest first — for full CSV export. */
export function allSnapshots(db: Database.Database): Snapshot[] {
  return db
    .prepare("SELECT * FROM vehicle_status ORDER BY ts, id")
    .all()
    .map(rowToSnapshot);
}

/**
 * Insert or (when the id already exists) update a snapshot by explicit id — the
 * primitive behind CSV import's upsert-by-id. A row with no id is inserted with
 * an auto-assigned id.
 */
export function upsertSnapshot(
  db: Database.Database,
  s: Snapshot
): "inserted" | "updated" {
  const vals = [
    s.ts, s.soc, s.rangeKm, s.odometerKm,
    toInt(s.isParked), toInt(s.isCharging), toInt(s.isPlugged),
    s.chargingState, s.externalPower, s.targetSoc, s.lat, s.lon, s.raw, s.source,
  ];
  const exists = s.id
    ? db.prepare("SELECT 1 FROM vehicle_status WHERE id = ?").get(s.id)
    : undefined;
  if (s.id && exists) {
    db.prepare(
      `UPDATE vehicle_status SET
         ts = ?, soc = ?, range_km = ?, odometer_km = ?,
         is_parked = ?, is_charging = ?, is_plugged = ?,
         charging_state = ?, external_power = ?, target_soc = ?,
         lat = ?, lon = ?, raw = ?, source = ?
       WHERE id = ?`
    ).run(...vals, s.id);
    return "updated";
  }
  if (s.id) {
    db.prepare(
      `INSERT INTO vehicle_status
       (id, ts, soc, range_km, odometer_km, is_parked, is_charging, is_plugged,
        charging_state, external_power, target_soc, lat, lon, raw, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(s.id, ...vals);
    return "inserted";
  }
  insertSnapshot(db, s);
  return "inserted";
}

export function latestSnapshot(db: Database.Database): Snapshot | null {
  const r = db
    .prepare("SELECT * FROM vehicle_status ORDER BY ts DESC, id DESC LIMIT 1")
    .get();
  return r ? rowToSnapshot(r) : null;
}

export function latestSnapshotBySource(
  db: Database.Database,
  source: StatusSource
): Snapshot | null {
  const r = db
    .prepare("SELECT * FROM vehicle_status WHERE source = ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(source);
  return r ? rowToSnapshot(r) : null;
}

export function listSnapshots(
  db: Database.Database,
  opts: { limit: number; offset: number }
): { items: Snapshot[]; total: number } {
  const items = db
    .prepare("SELECT * FROM vehicle_status ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?")
    .all(opts.limit, opts.offset)
    .map(rowToSnapshot);
  const total = (db.prepare("SELECT COUNT(*) n FROM vehicle_status").get() as any).n;
  return { items, total };
}
