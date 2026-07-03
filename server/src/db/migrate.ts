import type Database from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

// Migrations are embedded TS (not .sql assets) so the compiled dist/ is
// self-contained in the container image.
const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: `
      CREATE TABLE vehicle_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        soc REAL,
        range_km REAL,
        odometer_km REAL,
        is_parked INTEGER,
        is_charging INTEGER,
        is_plugged INTEGER,
        charging_state TEXT,
        external_power TEXT,
        target_soc REAL,
        lat REAL,
        lon REAL,
        raw TEXT,
        source TEXT NOT NULL DEFAULT 'api'
      );
      CREATE TABLE trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ts TEXT NOT NULL,
        end_ts TEXT,
        start_odometer REAL,
        end_odometer REAL,
        start_soc REAL,
        end_soc REAL,
        distance_km REAL,
        energy_kwh REAL,
        consumption REAL,
        duration_min REAL,
        notes TEXT,
        source TEXT NOT NULL DEFAULT 'auto'
      );
      CREATE TABLE charging_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ts TEXT NOT NULL,
        end_ts TEXT,
        start_soc REAL,
        end_soc REAL,
        energy_kwh REAL,
        cost REAL,
        price_per_kwh REAL,
        max_power_kw REAL,
        charger_type TEXT CHECK(charger_type IN ('home','ac','dc')),
        location TEXT,
        lat REAL,
        lon REAL,
        notes TEXT,
        source TEXT NOT NULL DEFAULT 'auto'
      );
      CREATE TABLE trip_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE INDEX idx_status_ts ON vehicle_status(ts);
      CREATE INDEX idx_trips_start ON trips(start_ts);
      CREATE INDEX idx_charging_start ON charging_sessions(start_ts);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r: any) => r.id)
  );
  const insert = db.prepare(
    "INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)"
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, m.name, new Date().toISOString());
    })();
  }
}
