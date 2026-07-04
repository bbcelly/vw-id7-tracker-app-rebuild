import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../server.js";
import { parsePagination } from "../server.js";
import * as chargingRepo from "../../repo/charging.js";
import { getNumberSetting } from "../../repo/settings.js";
import { finalizeCharge, mergeChargePatch } from "../../domain/metrics.js";
import { chargeCrossFieldError } from "../../domain/validate.js";
import { DEFAULT_BATTERY_KWH, type ChargingInsert } from "../../domain/types.js";

const isoDate = z.string().datetime({ offset: true });
const soc = z.number().min(0).max(100);

const chargeBody = z
  .object({
    startTs: isoDate,
    endTs: isoDate.nullish(),
    startSoc: soc.nullish(),
    endSoc: soc.nullish(),
    energyKwh: z.number().min(0).nullish(),
    cost: z.number().min(0).nullish(),
    pricePerKwh: z.number().min(0).nullish(),
    maxPowerKw: z.number().min(0).nullish(),
    chargerType: z.enum(["home", "ac", "dc"]).nullish(),
    location: z.string().max(500).nullish(),
    lat: z.number().min(-90).max(90).nullish(),
    lon: z.number().min(-180).max(180).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strip();

const chargePatch = chargeBody.partial();

export function registerChargingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const battery = () => getNumberSetting(deps.db, "battery_capacity_kwh", DEFAULT_BATTERY_KWH);

  app.get("/api/charging", async (req) => {
    const page = chargingRepo.listSessions(
      deps.db,
      parsePagination(req.query as Record<string, unknown>)
    );
    return { ...page, summary: chargingRepo.summary(deps.db) };
  });

  app.post("/api/charging", async (req, reply) => {
    const parsed = chargeBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const b = parsed.data;
    const insert: ChargingInsert = {
      startTs: b.startTs,
      endTs: b.endTs ?? null,
      startSoc: b.startSoc ?? null,
      endSoc: b.endSoc ?? null,
      energyKwh: b.energyKwh ?? null,
      cost: b.cost ?? null,
      pricePerKwh: b.pricePerKwh ?? null,
      maxPowerKw: b.maxPowerKw ?? null,
      chargerType: b.chargerType ?? null,
      location: b.location ?? null,
      lat: b.lat ?? null,
      lon: b.lon ?? null,
      notes: b.notes ?? null,
      source: "manual",
    };
    const crossErr = chargeCrossFieldError(insert);
    if (crossErr) return reply.status(400).send({ error: crossErr });
    return reply
      .status(201)
      .send(chargingRepo.createSession(deps.db, finalizeCharge(insert, battery())));
  });

  app.patch("/api/charging/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = chargingRepo.getSession(deps.db, id);
    if (!existing) return reply.status(404).send({ error: "session not found" });
    const parsed = chargePatch.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    // Recompute a derived field only when this patch touches its inputs —
    // manual values from earlier requests survive (manual always wins).
    const finalized = mergeChargePatch(existing, parsed.data as Partial<ChargingInsert>, battery());
    const crossErr = chargeCrossFieldError(finalized);
    if (crossErr) return reply.status(400).send({ error: crossErr });
    const { id: _id, source: _src, ...patch } = finalized;
    return chargingRepo.updateSession(deps.db, id, patch);
  });

  app.delete("/api/charging/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!chargingRepo.deleteSession(deps.db, id))
      return reply.status(404).send({ error: "session not found" });
    return { deleted: true };
  });
}
