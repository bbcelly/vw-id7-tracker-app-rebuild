import type { FastifyInstance, FastifyReply } from "fastify";
import { z, type ZodTypeAny } from "zod";
import type { AppDeps } from "../server.js";
import * as tripsRepo from "../../repo/trips.js";
import * as chargingRepo from "../../repo/charging.js";
import * as snapshotsRepo from "../../repo/snapshots.js";
import { getNumberSetting } from "../../repo/settings.js";
import { finalizeTrip, finalizeCharge } from "../../domain/metrics.js";
import { tripCrossFieldError, chargeCrossFieldError } from "../../domain/validate.js";
import {
  DEFAULT_BATTERY_KWH,
  type Trip,
  type ChargingSession,
  type Snapshot,
} from "../../domain/types.js";
import { serializeCsv, parseCsv } from "../../domain/csv.js";

const isoDate = z.string().datetime({ offset: true });
const soc = z.number().min(0).max(100);
const id = z.number().int().positive();
const source = z.enum(["api", "web", "manual"]);

// How each CSV column maps to a JS value on import. Order defines the export
// column order. Keys match the camelCase domain field names shown in the app.
type CoerceType = "num" | "int" | "str" | "bool";

interface EntityCsv<T> {
  filename: string;
  fields: Record<string, CoerceType>; // ordered: insertion order = column order
  schema: ZodTypeAny; // validates the coerced row
  toEntity: (d: any) => T; // build a full row (with id/source defaults) from validated data
  finalize?: (e: T, battery: number) => T; // fill derived gaps like the create API does
  crossFieldError?: (e: T) => string | null;
  upsert: (db: import("better-sqlite3").Database, e: T) => "inserted" | "updated";
  all: (db: import("better-sqlite3").Database) => T[];
}

function nn<V>(v: V | null | undefined): V | null {
  return v ?? null;
}

const TRIP: EntityCsv<Trip> = {
  filename: "trips.csv",
  fields: {
    id: "int", startTs: "str", endTs: "str", startOdometer: "num", endOdometer: "num",
    startSoc: "num", endSoc: "num", distanceKm: "num", energyKwh: "num",
    consumption: "num", durationMin: "num", notes: "str", source: "str",
  },
  schema: z.object({
    id: id.nullish(),
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
    source: source.nullish(),
  }),
  toEntity: (d): Trip => ({
    id: d.id ?? 0,
    startTs: d.startTs,
    endTs: nn(d.endTs),
    startOdometer: nn(d.startOdometer),
    endOdometer: nn(d.endOdometer),
    startSoc: nn(d.startSoc),
    endSoc: nn(d.endSoc),
    distanceKm: nn(d.distanceKm),
    energyKwh: nn(d.energyKwh),
    consumption: nn(d.consumption),
    durationMin: nn(d.durationMin),
    notes: nn(d.notes),
    source: d.source ?? "manual",
  }),
  finalize: finalizeTrip,
  crossFieldError: tripCrossFieldError,
  upsert: tripsRepo.upsertTrip,
  all: tripsRepo.allTrips,
};

const CHARGING: EntityCsv<ChargingSession> = {
  filename: "charging.csv",
  fields: {
    id: "int", startTs: "str", endTs: "str", startSoc: "num", endSoc: "num",
    energyKwh: "num", cost: "num", pricePerKwh: "num", maxPowerKw: "num",
    chargerType: "str", location: "str", lat: "num", lon: "num", notes: "str", source: "str",
  },
  schema: z.object({
    id: id.nullish(),
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
    source: source.nullish(),
  }),
  toEntity: (d): ChargingSession => ({
    id: d.id ?? 0,
    startTs: d.startTs,
    endTs: nn(d.endTs),
    startSoc: nn(d.startSoc),
    endSoc: nn(d.endSoc),
    energyKwh: nn(d.energyKwh),
    cost: nn(d.cost),
    pricePerKwh: nn(d.pricePerKwh),
    maxPowerKw: nn(d.maxPowerKw),
    chargerType: nn(d.chargerType),
    location: nn(d.location),
    lat: nn(d.lat),
    lon: nn(d.lon),
    notes: nn(d.notes),
    source: d.source ?? "manual",
  }),
  finalize: finalizeCharge,
  crossFieldError: chargeCrossFieldError,
  upsert: chargingRepo.upsertSession,
  all: chargingRepo.allSessions,
};

const SNAPSHOT: EntityCsv<Snapshot> = {
  filename: "snapshots.csv",
  fields: {
    id: "int", ts: "str", soc: "num", rangeKm: "num", odometerKm: "num",
    isParked: "bool", isCharging: "bool", isPlugged: "bool", chargingState: "str",
    externalPower: "str", targetSoc: "num", lat: "num", lon: "num", raw: "str", source: "str",
  },
  schema: z.object({
    id: id.nullish(),
    ts: isoDate,
    soc: soc.nullish(),
    rangeKm: z.number().nullish(),
    odometerKm: z.number().nullish(),
    isParked: z.boolean().nullish(),
    isCharging: z.boolean().nullish(),
    isPlugged: z.boolean().nullish(),
    chargingState: z.string().nullish(),
    externalPower: z.string().nullish(),
    targetSoc: soc.nullish(),
    lat: z.number().min(-90).max(90).nullish(),
    lon: z.number().min(-180).max(180).nullish(),
    raw: z.string().nullish(),
    source: source.nullish(),
  }),
  toEntity: (d): Snapshot => ({
    id: d.id ?? 0,
    ts: d.ts,
    soc: nn(d.soc),
    rangeKm: nn(d.rangeKm),
    odometerKm: nn(d.odometerKm),
    isParked: nn(d.isParked),
    isCharging: nn(d.isCharging),
    isPlugged: nn(d.isPlugged),
    chargingState: nn(d.chargingState),
    externalPower: nn(d.externalPower),
    targetSoc: nn(d.targetSoc),
    lat: nn(d.lat),
    lon: nn(d.lon),
    raw: nn(d.raw),
    source: d.source ?? "api",
  }),
  upsert: snapshotsRepo.upsertSnapshot,
  all: snapshotsRepo.allSnapshots,
};

function coerce(type: CoerceType, raw: string): number | string | boolean | null {
  const v = raw.trim();
  if (v === "") return null;
  if (type === "num" || type === "int") {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`"${raw}" is not a number`);
    return type === "int" ? Math.trunc(n) : n;
  }
  if (type === "bool") {
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    throw new Error(`"${raw}" is not a boolean`);
  }
  return v;
}

interface ImportResult {
  inserted: number;
  updated: number;
  failed: number;
  errors: { row: number; message: string }[];
}

function toExportRows<T extends Record<string, any>>(cfg: EntityCsv<T>, items: T[]): string {
  const headers = Object.keys(cfg.fields);
  const rows = items.map((it) => headers.map((h) => it[h] as any));
  return serializeCsv(headers, rows);
}

function runImport<T>(
  db: import("better-sqlite3").Database,
  cfg: EntityCsv<T>,
  csv: string,
  battery: number
): ImportResult {
  const table = parseCsv(csv);
  const result: ImportResult = { inserted: 0, updated: 0, failed: 0, errors: [] };
  if (table.length === 0) return result;

  const headers = table[0].map((h) => h.trim());
  const known = Object.keys(cfg.fields);
  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => {
    if (known.includes(h) && !colIndex.has(h)) colIndex.set(h, i);
  });

  const fields = cfg.fields as Record<string, CoerceType>;
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    // A trailing blank line parses to a single empty cell — skip it silently.
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const rowNum = r + 1; // 1-based, header is row 1
    try {
      const coerced: Record<string, unknown> = {};
      for (const key of known) {
        const idx = colIndex.get(key);
        if (idx === undefined) continue; // column not in this file
        coerced[key] = coerce(fields[key], cells[idx] ?? "");
      }
      const parsed = cfg.schema.safeParse(coerced);
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);

      let entity = cfg.toEntity(parsed.data);
      if (cfg.finalize) entity = cfg.finalize(entity, battery);
      const crossErr = cfg.crossFieldError?.(entity);
      if (crossErr) throw new Error(crossErr);

      const outcome = cfg.upsert(db, entity);
      if (outcome === "inserted") result.inserted++;
      else result.updated++;
    } catch (e) {
      result.failed++;
      result.errors.push({ row: rowNum, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

function sendCsv(reply: FastifyReply, filename: string, csv: string): void {
  void reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${filename}"`)
    .send(csv);
}

export function registerDataRoutes(app: FastifyInstance, deps: AppDeps): void {
  const battery = () => getNumberSetting(deps.db, "battery_capacity_kwh", DEFAULT_BATTERY_KWH);

  const register = <T>(name: string, cfg: EntityCsv<T>) => {
    app.get(`/api/${name}/export.csv`, async (_req, reply) => {
      sendCsv(reply, cfg.filename, toExportRows(cfg as EntityCsv<any>, cfg.all(deps.db)));
    });
    app.post(`/api/${name}/import`, async (req, reply) => {
      if (typeof req.body !== "string") {
        return reply.status(400).send({ error: "expected text/csv body" });
      }
      return runImport(deps.db, cfg, req.body, battery());
    });
  };

  register("trips", TRIP);
  register("charging", CHARGING);
  register("snapshots", SNAPSHOT);
}
