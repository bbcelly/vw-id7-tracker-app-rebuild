import type Database from "better-sqlite3";
import type { TripPosition } from "../domain/types.js";

export function addPosition(
  db: Database.Database,
  tripId: number,
  ts: string,
  lat: number,
  lon: number
): TripPosition {
  const res = db
    .prepare("INSERT INTO trip_positions (trip_id, ts, lat, lon) VALUES (?, ?, ?, ?)")
    .run(tripId, ts, lat, lon);
  return { id: Number(res.lastInsertRowid), tripId, ts, lat, lon };
}

export function listPositions(db: Database.Database, tripId: number): TripPosition[] {
  return (
    db
      .prepare("SELECT * FROM trip_positions WHERE trip_id = ? ORDER BY ts ASC")
      .all(tripId) as any[]
  ).map((r) => ({ id: r.id, tripId: r.trip_id, ts: r.ts, lat: r.lat, lon: r.lon }));
}
