import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Poller } from "../poller/poller.js";
import type { VehicleSource } from "../vw/source.js";
import type { WebVehicleSpec } from "../vw/web/index.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerTripRoutes } from "./routes/trips.js";
import { registerChargingRoutes } from "./routes/charging.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerDataRoutes } from "./routes/data.js";

export interface AppDeps {
  db: Database.Database;
  poller: Poller;
  source: VehicleSource;
  fetchWebSpec: (username: string, password: string, vin: string) => Promise<WebVehicleSpec | null>;
}

export function buildServer(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // CSV import posts the raw file body; keep it as an unparsed string.
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) =>
    done(null, body)
  );

  app.setErrorHandler((err, _req, reply) => {
    const anyErr = err as { statusCode?: number; message?: string };
    const status = anyErr.statusCode && anyErr.statusCode < 500 ? anyErr.statusCode : 500;
    void reply.status(status).send({ error: anyErr.message ?? "internal error" });
  });

  registerStatusRoutes(app, deps);
  registerTripRoutes(app, deps);
  registerChargingRoutes(app, deps);
  registerStatsRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerDataRoutes(app, deps);

  return app;
}

export function parsePagination(query: Record<string, unknown>): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  return { limit, offset };
}
