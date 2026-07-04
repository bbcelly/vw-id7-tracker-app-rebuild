import type Database from "better-sqlite3";
import type { Snapshot, SnapshotInsert } from "../domain/types.js";
import * as snapshotsRepo from "../repo/snapshots.js";
import { extractLiveExtras } from "../vw/api/extract.js";
import type { VwIdData } from "../vw/api/types.js";
import type { Detector } from "./detection.js";
import type { VehicleSource } from "../vw/source.js";

export interface PollerConfig {
  intervalMin(): number; // 1–60
  now(): Date;
}

/** Climate/lock/target-temp live in the raw payload only — compare them too,
 *  or a remote climate/target change would be deduped away and /api/status
 *  would serve stale extras indefinitely while parked. */
function extras(s: { source: string; raw: string | null }) {
  if (s.source !== "api" || !s.raw) return null;
  try {
    return extractLiveExtras(JSON.parse(s.raw) as VwIdData);
  } catch {
    return null;
  }
}

/** Same values as the stored row (ignoring timestamps)? */
function sameValues(a: Snapshot, b: SnapshotInsert): boolean {
  if (
    a.soc !== b.soc ||
    a.rangeKm !== b.rangeKm ||
    a.odometerKm !== b.odometerKm ||
    a.isParked !== b.isParked ||
    a.isCharging !== b.isCharging ||
    a.isPlugged !== b.isPlugged ||
    a.chargingState !== b.chargingState ||
    a.externalPower !== b.externalPower ||
    a.targetSoc !== b.targetSoc ||
    a.lat !== b.lat ||
    a.lon !== b.lon
  ) {
    return false;
  }
  const ea = extras(a);
  const eb = extras(b);
  return (
    ea?.climatisationState === eb?.climatisationState &&
    ea?.doorLockStatus === eb?.doorLockStatus &&
    ea?.targetTemperatureC === eb?.targetTemperatureC
  );
}

/**
 * Background poll loop: source.poll() → carry-forward → dedup → insert →
 * detection. Started on boot; restart() picks up a changed interval. A
 * failing tick never kills the loop.
 */
export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  lastPollAt: string | null = null;

  constructor(
    private db: Database.Database,
    private source: VehicleSource,
    private detector: Detector,
    private cfg: PollerConfig,
    private log: (msg: string) => void = (m) => console.log(m)
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    this.stop();
    const min = Math.min(60, Math.max(1, this.cfg.intervalMin()));
    this.timer = setInterval(() => {
      void this.tick(false);
    }, min * 60_000);
    void this.tick(false); // immediate first poll
    this.log(`[poller] started, interval ${min} min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  restart(): void {
    this.start();
  }

  /** Force an immediate poll (Sync Now) — bypasses the outage backoff. */
  async syncNow(): Promise<Snapshot | null> {
    return this.tick(true);
  }

  private async tick(force: boolean): Promise<Snapshot | null> {
    if (this.ticking) return null; // overlap guard
    this.ticking = true;
    try {
      const now = this.cfg.now();
      this.lastPollAt = now.toISOString();
      let next = await this.source.poll(now, force);
      if (!next) return null;

      // prev is the latest row of ANY source: detection's own source guards
      // then skip edge detection across a source flip (fresh start), instead
      // of pairing against an arbitrarily old same-source row — which would
      // fabricate phantom mega-trips or suppress real events after an outage.
      const prev = snapshotsRepo.latestSnapshot(this.db);

      // selectivestatus occasionally omits the charging job for a poll; a
      // stored null would read as stop+restart on the NEXT tick and fragment
      // one charge into several sessions. Patch BEFORE storing so the bridge
      // survives the DB round-trip.
      if (
        next.source === "api" &&
        next.isCharging === null &&
        prev?.source === "api" &&
        prev.isCharging != null
      ) {
        next = { ...next, isCharging: prev.isCharging, chargingState: prev.chargingState };
      }

      // Dedup. While charging, write every poll — a deduped SOC ramp would
      // starve detection. Web rows additionally dedup on the car-captured
      // timestamp (an asleep car repeats it while our receive-time moves on).
      if (prev) {
        const charging = next.isCharging === true || prev.isCharging === true;
        if (next.source === "web" && prev.ts === next.ts) return null;
        if (!charging && sameValues(prev, next)) return null;
      }

      // Primary recovery (or very first api row): stop events that happened
      // while the api path was dark never fired — reconcile open rows against
      // this fresh reading before detection resumes.
      const recovered = next.source === "api" && prev?.source !== "api";

      const inserted = snapshotsRepo.insertSnapshot(this.db, next);
      if (recovered) this.detector.reconcile(inserted);
      this.detector.onSnapshot(prev, inserted);
      return inserted;
    } catch (err) {
      this.log(`[poller] tick failed: ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      this.ticking = false;
    }
  }
}
