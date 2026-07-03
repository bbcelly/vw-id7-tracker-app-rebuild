import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../server.js";
import * as chargingRepo from "../../repo/charging.js";
import { round } from "../../domain/metrics.js";

export function registerStatsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/stats", async () => {
    const t = deps.db
      .prepare(
        `SELECT COUNT(*) count,
                COALESCE(SUM(distance_km), 0) distance,
                COALESCE(SUM(energy_kwh), 0) energy
         FROM trips`
      )
      .get() as { count: number; distance: number; energy: number };

    // Weighted average over trips that have both values — a per-trip average
    // would let short trips dominate.
    const c = deps.db
      .prepare(
        `SELECT COALESCE(SUM(distance_km), 0) d, COALESCE(SUM(energy_kwh), 0) e
         FROM trips WHERE distance_km > 0 AND energy_kwh IS NOT NULL`
      )
      .get() as { d: number; e: number };

    const charging = chargingRepo.summary(deps.db);

    // Consumption trend: the most recent 20 trips with a consumption value,
    // returned oldest-first for charting.
    const trend = (
      deps.db
        .prepare(
          `SELECT id, start_ts startTs, consumption, distance_km distanceKm
           FROM (SELECT * FROM trips WHERE consumption IS NOT NULL ORDER BY start_ts DESC LIMIT 20)
           ORDER BY start_ts ASC`
        )
        .all() as Array<{ id: number; startTs: string; consumption: number; distanceKm: number | null }>
    );

    return {
      totalDistanceKm: round(t.distance, 1),
      totalEnergyUsedKwh: round(t.energy, 2),
      avgConsumption: c.d > 0 ? round((c.e / c.d) * 100, 2) : null,
      totalChargedKwh: round(charging.totalEnergyKwh, 2),
      totalChargeCost: round(charging.totalCost, 2),
      tripCount: t.count,
      chargeCount: charging.count,
      trend,
    };
  });
}
