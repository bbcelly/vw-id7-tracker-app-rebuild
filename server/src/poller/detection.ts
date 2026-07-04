import type Database from "better-sqlite3";
import type { Snapshot } from "../domain/types.js";
import { finalizeTrip } from "../domain/metrics.js";
import * as tripsRepo from "../repo/trips.js";
import * as chargingRepo from "../repo/charging.js";
import * as positionsRepo from "../repo/positions.js";
import {
  deriveChargingAction,
  deriveChargingFromSocDelta,
  deriveTripAction,
  type SessionRow,
  type StatusRow,
  type TripRow,
} from "./derive.js";

export interface DetectorConfig {
  batteryKwh(): number;
  positionTrackingEnabled(): boolean;
  socDeltaEnabled(): boolean;
  socDeltaThresholdPct(): number;
  pollIntervalMs(): number;
  /** Trip-start debounce (noise guard). ~3 min in production. */
  debounceMs(): number;
  now(): Date;
}

const iso = (d: Date) => d.toISOString();

function toStatusRow(s: Snapshot): StatusRow {
  return {
    timestamp: new Date(s.ts),
    socPercent: s.soc,
    odometerKm: s.odometerKm,
    isCharging: s.isCharging,
  };
}

/**
 * Turns consecutive status snapshots into trips and charging sessions.
 * API snapshots use edge detection (flag transitions); web snapshots are
 * reconstructed from state deltas via derive.ts. Sources never mix.
 * Every handler is guarded — a detection failure must not kill the poll loop.
 */
export class Detector {
  private pendingTripStart: {
    time: Date;
    soc: number | null;
    odo: number | null;
    lat: number | null;
    lon: number | null;
  } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private db: Database.Database,
    private cfg: DetectorConfig,
    private log: (msg: string) => void = (m) => console.log(m)
  ) {}

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.pendingTripStart = null;
  }

  onSnapshot(prev: Snapshot | null, next: Snapshot): void {
    const guarded = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        this.log(`[detect] ${name} failed: ${err instanceof Error ? err.message : err}`);
      }
    };

    if (next.source === "web") {
      guarded("webDerive", () => this.webDerive(prev, next));
      return;
    }
    // Source purity: after a primary/fallback flip the previous row belongs to
    // the other source — skip edge detection entirely (fresh start), exactly
    // like the original's prevIdData reset on reconnect. The charging-job
    // carry-forward happens in the poller BEFORE the snapshot is stored, so
    // the bridged value survives the DB round-trip into the next tick's prev.
    if (next.source !== "api" || (prev !== null && prev.source !== "api")) return;

    guarded("charging", () => this.apiCharging(prev, next));
    guarded("trips", () => this.apiTrips(prev, next));
    guarded("socDelta", () => this.apiSocDelta(prev, next));
  }

  // --- API path: edge detection ---

  private apiCharging(prev: Snapshot | null, next: Snapshot): void {
    if (prev === null) return;
    if (prev.isCharging !== true && next.isCharging === true) {
      // Never stack sessions: if one is already open (e.g. a signal gap the
      // carry-forward couldn't bridge), treat this as the same charge.
      if (chargingRepo.openSession(this.db, "api")) return;
      // selectivestatus carries no AC/DC signal (maxChargeCurrentAC is a car
      // setting, not charger telemetry) — charger type stays unknown.
      chargingRepo.createSession(this.db, {
        startTs: iso(this.cfg.now()),
        endTs: null,
        startSoc: next.soc,
        endSoc: null,
        energyKwh: null,
        cost: null,
        pricePerKwh: null,
        maxPowerKw: null,
        chargerType: null,
        location: null,
        lat: prev.lat ?? next.lat,
        lon: prev.lon ?? next.lon,
        notes: null,
        source: "api",
      });
      this.log(`[detect] charging started at SOC ${next.soc ?? "?"}%`);
    }
    if (prev.isCharging === true && next.isCharging !== true) {
      this.closeOpenChargingSession(next.soc, this.cfg.now());
      this.log(`[detect] charging stopped at SOC ${next.soc ?? "?"}%`);
    }
  }

  private apiTrips(prev: Snapshot | null, next: Snapshot): void {
    if (prev === null) return;

    if (prev.isParked === true && next.isParked === false) {
      // Debounce: only commit the trip if still driving after ~3 minutes.
      this.pendingTripStart = {
        time: this.cfg.now(),
        soc: next.soc,
        odo: next.odometerKm,
        lat: prev.lat,
        lon: prev.lon,
      };
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        try {
          this.commitPendingTrip();
        } catch (err) {
          // Timer callbacks run outside onSnapshot's guards — an unhandled
          // throw here would crash the whole process.
          this.log(`[detect] debounced trip commit failed: ${err instanceof Error ? err.message : err}`);
        }
      }, this.cfg.debounceMs());
    }

    if (prev.isParked === false && next.isParked === true) {
      if (this.pendingTripStart) {
        // Left-parked signal was noise — never became a real trip.
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.pendingTripStart = null;
        this.debounceTimer = null;
        this.log("[detect] cleared pending trip start (parked again within debounce)");
      }
      this.closeOpenTrip(next.soc, next.odometerKm, this.cfg.now(), next.lat, next.lon);
    }
  }

  private commitPendingTrip(): void {
    const p = this.pendingTripStart;
    if (!p) return;
    const trip = tripsRepo.createTrip(this.db, {
      startTs: iso(p.time),
      endTs: null,
      startOdometer: p.odo,
      endOdometer: null,
      startSoc: p.soc,
      endSoc: null,
      distanceKm: null,
      energyKwh: null,
      consumption: null,
      durationMin: null,
      notes: null,
      source: "api",
    });
    if (this.cfg.positionTrackingEnabled() && p.lat != null && p.lon != null) {
      positionsRepo.addPosition(this.db, trip.id, iso(p.time), p.lat, p.lon);
    }
    this.log(`[detect] trip #${trip.id} confirmed after debounce`);
    this.pendingTripStart = null;
    this.debounceTimer = null;
  }

  private apiSocDelta(prev: Snapshot | null, next: Snapshot): void {
    if (!this.cfg.socDeltaEnabled() || prev === null) return;
    // Event-based detection owns the window while a session is open.
    if (chargingRepo.openSession(this.db, "api")) return;

    const latest = chargingRepo.latestSession(this.db, "api");
    const action = deriveChargingFromSocDelta(
      toStatusRow(prev),
      toStatusRow(next),
      latest ? toSessionRow(latest) : null,
      this.deriveOpts()
    );
    if (action.kind === "insert") {
      if (chargingRepo.sessionCoveringWindow(this.db, "api", prev.ts, next.ts)) return;
      chargingRepo.createSession(this.db, {
        startTs: iso(action.values.startTime),
        endTs: iso(action.values.endTime),
        startSoc: action.values.startSocPct,
        endSoc: action.values.endSocPct,
        energyKwh: action.values.energyChargedKwh,
        cost: null,
        pricePerKwh: null,
        maxPowerKw: null,
        chargerType: null,
        location: null,
        lat: prev.lat,
        lon: prev.lon,
        notes: null,
        source: "api",
      });
      this.log(
        `[detect] SOC-delta charge: ${action.values.startSocPct}% → ${action.values.endSocPct}%`
      );
    } else if (action.kind === "extend") {
      chargingRepo.updateSession(this.db, action.id, {
        endTs: iso(action.values.endTime),
        endSoc: action.values.endSocPct,
        energyKwh: action.values.energyChargedKwh,
      });
    }
  }

  // --- web path: delta reconstruction (no events, no parking flags) ---

  private webDerive(prev: Snapshot | null, next: Snapshot): void {
    if (prev === null || prev.source !== "web") return;

    const opts = this.deriveOpts();
    const latestTrip = tripsRepo.latestTrip(this.db, "web");
    const ta = deriveTripAction(
      toStatusRow(prev),
      toStatusRow(next),
      latestTrip ? toTripRow(latestTrip) : null,
      opts
    );
    if (ta.kind === "insert") {
      tripsRepo.createTrip(this.db, {
        startTs: iso(ta.values.startTime),
        endTs: iso(ta.values.endTime),
        startOdometer: ta.values.startOdoKm,
        endOdometer: ta.values.endOdoKm,
        startSoc: ta.values.startSocPct,
        endSoc: ta.values.endSocPct,
        distanceKm: ta.values.distanceKm,
        energyKwh: ta.values.energyUsedKwh,
        consumption: ta.values.consumptionKwhPer100km,
        durationMin: ta.values.durationMinutes,
        notes: null,
        source: "web",
      });
    } else if (ta.kind === "extend") {
      tripsRepo.updateTrip(this.db, ta.id, {
        endTs: iso(ta.values.endTime),
        endOdometer: ta.values.endOdoKm,
        endSoc: ta.values.endSocPct,
        distanceKm: ta.values.distanceKm,
        energyKwh: ta.values.energyUsedKwh,
        consumption: ta.values.consumptionKwhPer100km,
        durationMin: ta.values.durationMinutes,
      });
    }

    const latestSession = chargingRepo.latestSession(this.db, "web");
    const ca = deriveChargingAction(
      toStatusRow(prev),
      toStatusRow(next),
      latestSession ? toSessionRow(latestSession) : null,
      opts
    );
    if (ca.kind === "insert") {
      chargingRepo.createSession(this.db, {
        startTs: iso(ca.values.startTime),
        endTs: iso(ca.values.endTime),
        startSoc: ca.values.startSocPct,
        endSoc: ca.values.endSocPct,
        energyKwh: ca.values.energyChargedKwh,
        cost: null,
        pricePerKwh: null,
        maxPowerKw: null,
        chargerType: null,
        location: null,
        lat: null,
        lon: null,
        notes: null,
        source: "web",
      });
    } else if (ca.kind === "extend") {
      chargingRepo.updateSession(this.db, ca.id, {
        endTs: iso(ca.values.endTime),
        endSoc: ca.values.endSocPct,
        energyKwh: ca.values.energyChargedKwh,
      });
    }
  }

  // --- shared closers + boot reconciliation ---

  /** Close the open api charging session at the given SOC/time. */
  closeOpenChargingSession(socNow: number | null, endTime: Date): boolean {
    const open = chargingRepo.openSession(this.db, "api");
    if (!open) return false;
    const energy =
      socNow != null && open.startSoc != null
        ? Math.round(((socNow - open.startSoc) / 100) * this.cfg.batteryKwh() * 100) / 100
        : null;
    chargingRepo.updateSession(this.db, open.id, {
      endTs: iso(endTime),
      endSoc: socNow,
      energyKwh: energy,
    });
    return true;
  }

  /** Close (or discard) the open api trip at the given readings. */
  closeOpenTrip(
    socNow: number | null,
    odoNow: number | null,
    endTime: Date,
    lat: number | null = null,
    lon: number | null = null
  ): boolean {
    const open = tripsRepo.openTrip(this.db, "api");
    if (!open) return false;

    const distance =
      odoNow != null && open.startOdometer != null ? odoNow - open.startOdometer : null;
    const energy =
      open.startSoc != null && socNow != null
        ? ((open.startSoc - socNow) / 100) * this.cfg.batteryKwh()
        : null;

    // Discard: under 2 km, or SOC rose (negative energy ⇒ it was charging).
    if ((distance != null && distance < 2) || (energy != null && energy < 0)) {
      tripsRepo.deleteTrip(this.db, open.id);
      this.log(
        `[detect] discarded invalid trip #${open.id}: ${distance ?? "?"} km, ${energy?.toFixed(1) ?? "?"} kWh`
      );
      return true;
    }

    if (this.cfg.positionTrackingEnabled() && lat != null && lon != null) {
      positionsRepo.addPosition(this.db, open.id, iso(endTime), lat, lon);
    }
    const finalized = finalizeTrip(
      { ...open, endTs: iso(endTime), endOdometer: odoNow, endSoc: socNow },
      this.cfg.batteryKwh()
    );
    tripsRepo.updateTrip(this.db, open.id, {
      endTs: finalized.endTs,
      endOdometer: finalized.endOdometer,
      endSoc: finalized.endSoc,
      distanceKm: finalized.distanceKm,
      energyKwh: finalized.energyKwh,
      consumption: finalized.consumption,
      durationMin: finalized.durationMin,
    });
    return true;
  }

  /**
   * After a restart the in-memory prev-state is gone, so stop events that
   * happened while the app was down never fire. Close any open rows the
   * current status contradicts — a dangling open session otherwise suppresses
   * SOC-delta detection indefinitely.
   */
  reconcile(latest: Snapshot | null): void {
    if (!latest || latest.source !== "api") return;
    // Only close an orphaned charge when the car explicitly reports NOT
    // charging (null = dropped charging job, not evidence). The plug check
    // avoids closing a charge that is merely paused while still plugged in.
    if (latest.isCharging === false && latest.isPlugged !== true) {
      if (this.closeOpenChargingSession(latest.soc, this.cfg.now())) {
        this.log("[detect] closed charging session orphaned across an outage/restart");
      }
    }
    // Only close an orphaned trip when the car is explicitly parked. isParked
    // is null on web rows and can be unknown mid-drive — `!== false` here
    // would truncate an in-progress trip on any mid-drive reconnect.
    if (latest.isParked === true) {
      if (this.closeOpenTrip(latest.soc, latest.odometerKm, this.cfg.now())) {
        this.log("[detect] closed trip orphaned across an outage/restart");
      }
    }
  }

  private deriveOpts() {
    const pollMs = this.cfg.pollIntervalMs();
    return {
      pollIntervalMs: pollMs,
      continueGapMs: Math.round(pollMs * 2.6),
      batteryCapacityKwh: this.cfg.batteryKwh(),
      minTripKm: 1,
      minChargePct: this.cfg.socDeltaThresholdPct(),
    };
  }
}

function toTripRow(t: {
  id: number;
  startTs: string;
  endTs: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
  startSoc: number | null;
  endSoc: number | null;
}): TripRow {
  return {
    id: t.id,
    startTime: new Date(t.startTs),
    endTime: t.endTs ? new Date(t.endTs) : null,
    startOdoKm: t.startOdometer,
    endOdoKm: t.endOdometer,
    startSocPct: t.startSoc,
    endSocPct: t.endSoc,
  };
}

function toSessionRow(s: {
  id: number;
  endTs: string | null;
  startSoc: number | null;
  endSoc: number | null;
}): SessionRow {
  return {
    id: s.id,
    endTime: s.endTs ? new Date(s.endTs) : null,
    startSocPct: s.startSoc,
    endSocPct: s.endSoc,
  };
}
