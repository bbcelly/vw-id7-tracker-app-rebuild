import type Database from "better-sqlite3";
import type { Snapshot, SnapshotInsert } from "../domain/types.js";
import * as snapshotsRepo from "../repo/snapshots.js";
import type { Detector } from "./detection.js";
import type { VehicleSource } from "../vw/source.js";

export interface PollerConfig {
  intervalMin(): number; // 1–60
  now(): Date;
}

/** Same values as the stored row (ignoring timestamps)? */
function sameValues(a: Snapshot, b: SnapshotInsert): boolean {
  return (
    a.soc === b.soc &&
    a.rangeKm === b.rangeKm &&
    a.odometerKm === b.odometerKm &&
    a.isParked === b.isParked &&
    a.isCharging === b.isCharging &&
    a.isPlugged === b.isPlugged &&
    a.chargingState === b.chargingState &&
    a.externalPower === b.externalPower &&
    a.lat === b.lat &&
    a.lon === b.lon
  );
}

/**
 * Background poll loop: source.poll() → dedup → insert snapshot → detection.
 * Started on boot; restart() picks up a changed interval. A failing tick never
 * kills the loop.
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
      void this.tick();
    }, min * 60_000);
    void this.tick(); // immediate first poll
    this.log(`[poller] started, interval ${min} min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  restart(): void {
    this.start();
  }

  /** Force an immediate poll (Sync Now). Returns the stored snapshot, if any. */
  async syncNow(): Promise<Snapshot | null> {
    return this.tick();
  }

  private async tick(): Promise<Snapshot | null> {
    if (this.ticking) return null; // overlap guard
    this.ticking = true;
    try {
      const now = this.cfg.now();
      this.lastPollAt = now.toISOString();
      const next = await this.source.poll(now);
      if (!next) return null;

      const prev = snapshotsRepo.latestSnapshotBySource(this.db, next.source);

      // Dedup. Web rows repeat the car's last captured timestamp while it is
      // asleep; API rows repeat identical values while parked. While charging,
      // write every poll — a deduped SOC ramp would starve detection.
      if (prev) {
        if (next.source === "web" && prev.ts === next.ts) return null;
        const charging = next.isCharging === true || prev.isCharging === true;
        if (next.source === "api" && !charging && sameValues(prev, next)) return null;
      }

      const inserted = snapshotsRepo.insertSnapshot(this.db, next);
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
