import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../server.js";
import { getAllSettings, getSetting, setSetting } from "../../repo/settings.js";

// User-facing settings (never includes the raw password on the way out).
const KEYS = [
  "vw_username",
  "vw_vin",
  "poll_interval",
  "battery_capacity_kwh",
  "price_per_kwh",
  "currency",
  "position_tracking",
  "soc_delta_detection",
  "soc_delta_threshold",
] as const;

const settingsBody = z
  .object({
    vw_username: z.string().max(200).optional(),
    // Write-only: an empty/missing password means "keep the stored one".
    vw_password: z.string().max(200).optional(),
    vw_vin: z.string().max(20).optional(),
    poll_interval: z.coerce.number().int().min(1).max(60).optional(),
    battery_capacity_kwh: z.coerce.number().positive().max(300).optional(),
    price_per_kwh: z.coerce.number().min(0).optional(),
    currency: z.string().min(1).max(8).optional(),
    position_tracking: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
    soc_delta_detection: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
    soc_delta_threshold: z.coerce.number().min(1).max(50).optional(),
  })
  .strip();

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/settings", async () => {
    const all = getAllSettings(deps.db);
    const out: Record<string, string | null> = {};
    for (const k of KEYS) out[k] = all[k] ?? null;
    out.vw_password_set = all.vw_password ? "true" : "false";
    return out;
  });

  app.put("/api/settings", async (req, reply) => {
    const parsed = settingsBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const b = parsed.data;

    const prevInterval = getSetting(deps.db, "poll_interval");

    for (const k of KEYS) {
      const v = (b as Record<string, unknown>)[k];
      if (v !== undefined) setSetting(deps.db, k, String(v));
    }
    if (b.vw_password !== undefined && b.vw_password !== "") {
      setSetting(deps.db, "vw_password", b.vw_password);
    }

    if (
      b.poll_interval !== undefined &&
      String(b.poll_interval) !== prevInterval &&
      deps.poller.running
    ) {
      deps.poller.restart();
    }
    return { saved: true };
  });
}
