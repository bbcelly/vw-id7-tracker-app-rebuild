import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../server.js";
import * as snapshotsRepo from "../../repo/snapshots.js";
import { extractLiveExtras } from "../../vw/api/extract.js";
import type { VwIdData } from "../../vw/api/types.js";

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
    if (snapshot && !deps.poller.running) deps.poller.start();
    return {
      connected: deps.source.state !== "disconnected",
      state: deps.source.state,
      lastError: deps.source.lastError,
      snapshot,
    };
  });
}
