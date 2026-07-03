import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runMigrations } from "./migrate.js";

let db: Database.Database | null = null;

export function getDb(path?: string): Database.Database {
  if (db) return db;
  const dbPath = path ?? process.env.DB_PATH ?? resolve("data", "tracker.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Test hook: swap in an isolated database (e.g. in-memory). */
export function setDb(next: Database.Database | null): void {
  db = next;
}
