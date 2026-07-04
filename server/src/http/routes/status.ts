import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../server.js";
import * as snapshotsRepo from "../../repo/snapshots.js";
import { getSetting, setSetting } from "../../repo/settings.js";
import { loadCredentials } from "../../vw/api/tokens.js";
import { extractLiveExtras } from "../../vw/api/extract.js";
import type { VwIdData } from "../../vw/api/types.js";
import { DEFAULT_BATTERY_KWH } from "../../domain/types.js";

export function registerStatusRoutes(app: FastifyInstance, deps: AppDeps): void {
  // Latest stored snapshot + connection state. The UI always renders from
  // stored data, so this works fine when VW is unreachable.
  app.get("/api/status", async () => {
    const snapshot = snapshotsRepo.latestSnapshot(deps.db);
    let extras = { climatisationState: null as string | null, doorLockStatus: null as string | null, targetTemperatureC: null as number | null };
    if (snapshot?.source === "api" && snapshot.raw) {
      try {
        extras = extractLiveExtras(JSON.parse(snapshot.raw) as VwIdData);
      } catch {
        /* raw unparseable — extras stay null */
      }
    }
    return {
      snapshot,
      ...extras,
      connection: {
        state: deps.source.state,
        lastError: deps.source.lastError,
        pollerRunning: deps.poller.running,
        lastPollAt: deps.poller.lastPollAt,
      },
    };
  });

  // Force an immediate poll.
  app.post("/api/sync", async () => {
    const snapshot = await deps.poller.syncNow();
    return {
      synced: snapshot !== null,
      snapshot,
      state: deps.source.state,
      lastError: deps.source.lastError,
    };
  });

  // Connect & Sync from Settings: one immediate poll + (re)start the loop.
  app.post("/api/connect", async () => {
    const snapshot = await deps.poller.syncNow();
    // Start on any successful connection — the poll may have deduped (snapshot
    // null) while the source is perfectly healthy.
    if (deps.source.state !== "disconnected" && !deps.poller.running) deps.poller.start();
    await maybeDetectBattery(deps);
    return {
      connected: deps.source.state !== "disconnected",
      state: deps.source.state,
      lastError: deps.source.lastError,
      snapshot,
    };
  });
}

// One-time battery-capacity detection via the portal spec (docs §10 area).
// detected_battery_kwh doubles as the "already checked" marker; the user's
// capacity is only filled while it is absent or still the app default, so a
// manual value is never overwritten. Delete detected_battery_kwh to re-run.
async function maybeDetectBattery(deps: AppDeps): Promise<void> {
  if (deps.source.state === "disconnected") return;
  if (getSetting(deps.db, "detected_battery_kwh") !== null) return;
  const creds = loadCredentials(deps.db);
  const vin = getSetting(deps.db, "vw_vin");
  if (!creds || !vin) return;
  const spec = await deps.fetchWebSpec(creds.username, creds.password, vin);
  if (spec?.modelName) setSetting(deps.db, "vehicle_model", spec.modelName);
  if (!spec?.netBatteryKwh) return;
  setSetting(deps.db, "detected_battery_kwh", String(spec.netBatteryKwh));
  const current = getSetting(deps.db, "battery_capacity_kwh");
  if (current === null || Number(current) === DEFAULT_BATTERY_KWH) {
    setSetting(deps.db, "battery_capacity_kwh", String(spec.netBatteryKwh));
  }
}
