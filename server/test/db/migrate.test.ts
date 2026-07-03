import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
}

describe("runMigrations", () => {
  it("creates all domain tables on an empty database", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tables = tableNames(db);
    for (const t of [
      "vehicle_status",
      "trips",
      "charging_sessions",
      "trip_positions",
      "settings",
      "_migrations",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("is idempotent — running twice applies each migration once", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db);
    const applied = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as {
      n: number;
    };
    expect(applied.n).toBeGreaterThan(0);
    // no error thrown and count is stable across a third run
    runMigrations(db);
    const again = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as {
      n: number;
    };
    expect(again.n).toBe(applied.n);
  });

  it("enforces charger_type check constraint", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO charging_sessions (start_ts, charger_type) VALUES ('2026-07-03T10:00:00Z', 'nuclear')"
        )
        .run()
    ).toThrow();
    db.prepare(
      "INSERT INTO charging_sessions (start_ts, charger_type) VALUES ('2026-07-03T10:00:00Z', 'dc')"
    ).run();
  });
});
