import type { SnapshotInsert } from "../domain/types.js";
import type { Credentials } from "./api/client.js";
import type { VwIdData } from "./api/types.js";
import { extractSnapshot } from "./api/extract.js";
import type { WebStatus } from "./web/index.js";

export type SourceState = "disconnected" | "api" | "web";

export interface VehicleSourceDeps {
  api: {
    listVehicles(): Promise<string[]>;
    fetchIdData(vin: string): Promise<VwIdData>;
  };
  fetchWeb(username: string, password: string, vin: string): Promise<WebStatus | null>;
  getCredentials(): Credentials | null;
  getVin(): string | null;
  setVin(vin: string): void;
  log?: (msg: string) => void;
}

/**
 * Primary/fallback orchestration: every poll tries the WeConnect app API
 * first; on failure it falls back to the myvolkswagen.net portal (range +
 * odometer + charging signal). Because primary is retried each tick, recovery
 * is automatic — the next successful primary poll simply flips the state back.
 */
export class VehicleSource {
  state: SourceState = "disconnected";
  lastError: string | null = null;

  constructor(private deps: VehicleSourceDeps) {}

  private log(msg: string): void {
    (this.deps.log ?? console.log)(msg);
  }

  /** One poll: returns a snapshot to store, or null when nothing was reachable. */
  async poll(now: Date = new Date()): Promise<SnapshotInsert | null> {
    const creds = this.deps.getCredentials();
    if (!creds) {
      this.state = "disconnected";
      this.lastError = "credentials not configured";
      return null;
    }

    // --- primary: WeConnect app API ---
    try {
      let vin = this.deps.getVin();
      if (!vin) {
        const vins = await this.deps.api.listVehicles();
        if (vins.length === 0) throw new Error("VW account has no vehicles");
        vin = vins[0];
        this.deps.setVin(vin);
        this.log(`[source] auto-detected VIN ${vin}`);
      }
      const idData = await this.deps.api.fetchIdData(vin);
      if (this.state !== "api") this.log("[source] primary API active");
      this.state = "api";
      this.lastError = null;
      return extractSnapshot(idData, now.toISOString());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`[source] primary failed: ${this.lastError}`);
    }

    // --- fallback: web portal (requires a configured VIN) ---
    const vin = this.deps.getVin();
    if (!vin) {
      this.state = "disconnected";
      return null;
    }
    const web = await this.deps.fetchWeb(creds.username, creds.password, vin);
    if (!web) {
      this.state = "disconnected";
      return null;
    }
    if (this.state !== "web") this.log("[source] web fallback active");
    this.state = "web";
    return {
      ts: (web.capturedAt ?? now).toISOString(),
      soc: web.socPercent,
      rangeKm: web.rangeKm,
      odometerKm: web.odometerKm,
      isParked: null,
      isCharging: web.isCharging,
      isPlugged: web.isPlugged,
      chargingState: web.chargingState,
      externalPower: web.externalPower,
      targetSoc: null,
      lat: null,
      lon: null,
      raw: JSON.stringify(web.raw ?? null),
      source: "web",
    };
  }
}
