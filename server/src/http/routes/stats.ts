import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../server.js";
import * as chargingRepo from "../../repo/charging.js";
import * as snapshotsRepo from "../../repo/snapshots.js";
import { round } from "../../domain/metrics.js";

const RANGE_HOURS: Record<string, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

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

  // Per-month breakdown of usage, newest month first, capped to the last 12
  // months with any activity. Months are bucketed by UTC calendar month, like
  // every other aggregate here.
  app.get("/api/stats/monthly", async () => {
    const tripRows = deps.db
      .prepare(
        `SELECT strftime('%Y-%m', start_ts) month,
                COUNT(*) tripCount,
                COALESCE(SUM(distance_km), 0) distance,
                COALESCE(SUM(CASE WHEN distance_km > 0 AND energy_kwh IS NOT NULL THEN distance_km END), 0) cd,
                COALESCE(SUM(CASE WHEN distance_km > 0 AND energy_kwh IS NOT NULL THEN energy_kwh END), 0) ce
         FROM trips GROUP BY month`
      )
      .all() as Array<{ month: string; tripCount: number; distance: number; cd: number; ce: number }>;

    const chargeRows = deps.db
      .prepare(
        `SELECT strftime('%Y-%m', start_ts) month,
                COUNT(*) chargeCount,
                COALESCE(SUM(energy_kwh), 0) chargedKwh,
                COALESCE(SUM(cost), 0) chargeCost
         FROM charging_sessions GROUP BY month`
      )
      .all() as Array<{ month: string; chargeCount: number; chargedKwh: number; chargeCost: number }>;

    const byMonth = new Map<
      string,
      { month: string; distanceKm: number; avgConsumption: number | null; chargedKwh: number; chargeCost: number; tripCount: number; chargeCount: number }
    >();
    const get = (month: string) => {
      let row = byMonth.get(month);
      if (!row) {
        row = { month, distanceKm: 0, avgConsumption: null, chargedKwh: 0, chargeCost: 0, tripCount: 0, chargeCount: 0 };
        byMonth.set(month, row);
      }
      return row;
    };

    for (const r of tripRows) {
      const row = get(r.month);
      row.tripCount = r.tripCount;
      row.distanceKm = round(r.distance, 1) ?? 0;
      row.avgConsumption = r.cd > 0 ? round((r.ce / r.cd) * 100, 2) : null;
    }
    for (const r of chargeRows) {
      const row = get(r.month);
      row.chargeCount = r.chargeCount;
      row.chargedKwh = round(r.chargedKwh, 2) ?? 0;
      row.chargeCost = round(r.chargeCost, 2) ?? 0;
    }

    return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12);
  });

  // Battery SoC over time for the vehicle history chart. `range` is one of
  // 24h/7d/30d (default and fallback: 7d); anything else clamps to 7d so an
  // arbitrary query string can't widen the window.
  app.get("/api/snapshots/history", async (req) => {
    const range = (req.query as { range?: string }).range ?? "7d";
    const hours = RANGE_HOURS[range] ?? RANGE_HOURS["7d"];
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return snapshotsRepo.socHistory(deps.db, since);
  });
}
