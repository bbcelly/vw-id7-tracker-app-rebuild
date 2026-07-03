import type Database from "better-sqlite3";
import { deleteSetting, getSetting, setSetting } from "../../repo/settings.js";
import type { Credentials, TokenStore } from "./client.js";
import type { VwTokens } from "./types.js";

const KEYS = {
  access: "vw_access_token",
  refresh: "vw_refresh_token",
  id: "vw_id_token",
  expiresAt: "vw_token_expires_at",
} as const;

/** Token persistence in the settings table, matching the original's key names. */
export function createSettingsTokenStore(db: Database.Database): TokenStore {
  return {
    load(): VwTokens | null {
      const accessToken = getSetting(db, KEYS.access);
      const expiresAtRaw = getSetting(db, KEYS.expiresAt);
      // Only the access token (Bearer) is used on data calls. id_token is
      // optional (the code flow may omit it); refresh_token may be absent.
      if (!accessToken || !expiresAtRaw) return null;
      const expiresAt = Number(expiresAtRaw);
      if (!Number.isFinite(expiresAt)) return null;
      return {
        accessToken,
        idToken: getSetting(db, KEYS.id) ?? "",
        expiresAt,
        refreshToken: getSetting(db, KEYS.refresh) ?? undefined,
      };
    },
    save(t: VwTokens): void {
      setSetting(db, KEYS.access, t.accessToken);
      setSetting(db, KEYS.id, t.idToken);
      setSetting(db, KEYS.expiresAt, String(t.expiresAt));
      if (t.refreshToken) setSetting(db, KEYS.refresh, t.refreshToken);
    },
    clear(): void {
      for (const k of Object.values(KEYS)) deleteSetting(db, k);
    },
  };
}

export function loadCredentials(db: Database.Database): Credentials | null {
  const username = getSetting(db, "vw_username");
  const password = getSetting(db, "vw_password");
  if (!username || !password) return null;
  return { username, password };
}
