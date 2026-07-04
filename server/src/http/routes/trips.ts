import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../server.js";
import { parsePagination } from "../server.js";
import * as tripsRepo from "../../repo/trips.js";
import * as positionsRepo from "../../repo/positions.js";
import { getNumberSetting } from "../../repo/settings.js";
import { finalizeTrip, mergeTripPatch } from "../../domain/metrics.js";
import { tripCrossFieldError } from "../../domain/validate.js";
import { DEFAULT_BATTERY_KWH, type TripInsert } from "../../domain/types.js";

const isoDate = z.string().datetime({ offset: true });
const soc = z.number().min(0).max(100);

// Client-supplied identity/source fields are stripped, not trusted: the
// schema simply has no id/source keys and .strip() drops unknown keys.
const tripBody = z
  .object({
    startTs: isoDate,
    endTs: isoDate.nullish(),
    startOdometer: z.number().min(0).nullish(),
    endOdometer: z.number().min(0).nullish(),
    startSoc: soc.nullish(),
    endSoc: soc.nullish(),
    distanceKm: z.number().min(0).nullish(),
    energyKwh: z.number().nullish(),
    consumption: z.number().min(0).nullish(),
    durationMin: z.number().min(0).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strip();

const tripPatch = tripBody.partial();

export function registerTripRoutes(app: FastifyInstance, deps: AppDeps): void {
  const battery = () => getNumberSetting(deps.db, "battery_capacity_kwh", DEFAULT_BATTERY_KWH);

  app.get("/api/trips", async (req) => {
    return tripsRepo.listTrips(deps.db, parsePagination(req.query as Record<string, unknown>));
  });

  app.get("/api/trips/:id/positions", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!tripsRepo.getTrip(deps.db, id)) return reply.status(404).send({ error: "trip not found" });
    return positionsRepo.listPositions(deps.db, id);
  });

  app.post("/api/trips", async (req, reply) => {
    const parsed = tripBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const b = parsed.data;
    const insert: TripInsert = {
      startTs: b.startTs,
      endTs: b.endTs ?? null,
      startOdometer: b.startOdometer ?? null,
      endOdometer: b.endOdometer ?? null,
      startSoc: b.startSoc ?? null,
      endSoc: b.endSoc ?? null,
      distanceKm: b.distanceKm ?? null,
      energyKwh: b.energyKwh ?? null,
      consumption: b.consumption ?? null,
      durationMin: b.durationMin ?? null,
      notes: b.notes ?? null,
      source: "manual",
    };
    const crossErr = tripCrossFieldError(insert);
    if (crossErr) return reply.status(400).send({ error: crossErr });
    return reply.status(201).send(tripsRepo.createTrip(deps.db, finalizeTrip(insert, battery())));
  });

  app.patch("/api/trips/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = tripsRepo.getTrip(deps.db, id);
    if (!existing) return reply.status(404).send({ error: "trip not found" });
    const parsed = tripPatch.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    // Manual values in this write win; a derived field is recomputed only
    // when this patch touches one of its inputs — otherwise a manual value
    // from an earlier request survives (manual always wins).
    const finalized = mergeTripPatch(existing, parsed.data as Partial<TripInsert>, battery());
    const crossErr = tripCrossFieldError(finalized);
    if (crossErr) return reply.status(400).send({ error: crossErr });
    const { id: _id, source: _src, ...patch } = finalized;
    return tripsRepo.updateTrip(deps.db, id, patch);
  });

  app.delete("/api/trips/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!tripsRepo.deleteTrip(deps.db, id)) return reply.status(404).send({ error: "trip not found" });
    return { deleted: true };
  });
}
