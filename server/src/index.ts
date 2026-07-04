import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { getDb } from "./db/connection.js";
import {
  getBoolSetting,
  getNumberSetting,
  getSetting,
  setSetting,
} from "./repo/settings.js";
import * as snapshotsRepo from "./repo/snapshots.js";
import { DEFAULT_BATTERY_KWH, DEFAULT_POLL_INTERVAL_MIN } from "./domain/types.js";
import { VwApiClient } from "./vw/api/client.js";
import { createSettingsTokenStore, loadCredentials } from "./vw/api/tokens.js";
import { fetchWebStatus } from "./vw/web/index.js";
import { VehicleSource } from "./vw/source.js";
import { Detector } from "./poller/detection.js";
import { Poller } from "./poller/poller.js";
import { buildServer } from "./http/server.js";

const db = getDb(); // opens + migrates

const apiClient = new VwApiClient(createSettingsTokenStore(db), () => loadCredentials(db));

const source = new VehicleSource({
  api: apiClient,
  fetchWeb: fetchWebStatus,
  getCredentials: () => loadCredentials(db),
  getVin: () => getSetting(db, "vw_vin"),
  setVin: (vin) => setSetting(db, "vw_vin", vin),
});

const pollIntervalMin = () =>
  getNumberSetting(db, "poll_interval", DEFAULT_POLL_INTERVAL_MIN);

const detector = new Detector(db, {
  batteryKwh: () => getNumberSetting(db, "battery_capacity_kwh", DEFAULT_BATTERY_KWH),
  positionTrackingEnabled: () => getBoolSetting(db, "position_tracking", true),
  socDeltaEnabled: () => getBoolSetting(db, "soc_delta_detection", false),
  socDeltaThresholdPct: () => getNumberSetting(db, "soc_delta_threshold", 2),
  pollIntervalMs: () => pollIntervalMin() * 60_000,
  debounceMs: () => 3 * 60_000,
  now: () => new Date(),
});

const poller = new Poller(db, source, detector, {
  intervalMin: pollIntervalMin,
  now: () => new Date(),
});

// Stop events that happened while the app was down never fire — reconcile
// open trips/sessions against the last stored API status before polling
// resumes. (API-source only: web rows lack the parked flag, and detected
// open rows are api-source; the poller re-runs this on primary recovery.)
detector.reconcile(snapshotsRepo.latestSnapshotBySource(db, "api"));

const app = buildServer({ db, poller, source });

// Serve the built frontend when present (single-container deployment).
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    // SPA fallback for client-side routes; API misses stay JSON 404s.
    if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`[boot] EV tracker listening on :${port}`);

if (loadCredentials(db)) {
  poller.start();
} else {
  console.log("[boot] VW credentials not configured — poller idle until Settings are saved");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    poller.stop();
    detector.stop();
    void app.close().then(() => process.exit(0));
  });
}
