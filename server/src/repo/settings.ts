import type Database from "better-sqlite3";

export function getSetting(db: Database.Database, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function deleteSetting(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function getAllSettings(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.prepare("SELECT key, value FROM settings").all() as any[]) {
    out[r.key] = r.value;
  }
  return out;
}

export function getNumberSetting(
  db: Database.Database,
  key: string,
  fallback: number
): number {
  const v = getSetting(db, key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getBoolSetting(
  db: Database.Database,
  key: string,
  fallback: boolean
): boolean {
  const v = getSetting(db, key);
  return v === null ? fallback : v === "true" || v === "1";
}
