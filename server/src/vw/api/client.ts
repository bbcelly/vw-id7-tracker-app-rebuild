import { login, refreshAccessToken } from "./auth.js";
import {
  VW_HOST_BFF,
  VW_USER_AGENT,
  type VwIdData,
  type VwParkingPositionResponse,
  type VwSelectiveStatusResponse,
  type VwTokens,
  type VwVehiclesResponse,
} from "./types.js";

export interface TokenStore {
  load(): VwTokens | null;
  save(t: VwTokens): void;
  clear(): void;
}

export interface Credentials {
  username: string;
  password: string;
}

const STATUS_JOBS = "access,charging,climatisation,measurements";

function isAccessTokenStale(t: VwTokens, skewMs = 60_000): boolean {
  return Date.now() + skewMs >= t.expiresAt;
}

/**
 * Authenticated data-plane client for the WeConnect app API. Token lifecycle:
 * stored token → refresh_token grant when stale → full headless re-login when
 * refresh fails or a data call 401s.
 */
export class VwApiClient {
  constructor(
    private store: TokenStore,
    private getCredentials: () => Credentials | null
  ) {}

  private async relogin(): Promise<VwTokens> {
    const creds = this.getCredentials();
    if (!creds) throw new Error("Cannot re-authenticate: VW credentials not configured");
    const tokens = await login(creds.username, creds.password);
    this.store.save(tokens);
    return tokens;
  }

  private async ensureFreshToken(): Promise<VwTokens> {
    const t = this.store.load();
    if (!t) return this.relogin();
    if (isAccessTokenStale(t)) {
      if (t.refreshToken) {
        try {
          const next = await refreshAccessToken(t.refreshToken);
          this.store.save(next);
          return next;
        } catch {
          return this.relogin();
        }
      }
      return this.relogin();
    }
    return t;
  }

  private async authedGet<T>(url: string): Promise<T> {
    let tokens = await this.ensureFreshToken();
    const call = (accessToken: string) =>
      fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": VW_USER_AGENT,
        },
      });

    let resp = await call(tokens.accessToken);
    if (resp.status === 401) {
      // Token rejected — re-login once, retry.
      tokens = await this.relogin();
      resp = await call(tokens.accessToken);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`VW GET ${url} failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    return (await resp.json()) as T;
  }

  /** Verify credentials/tokens work; returns the account's VINs. */
  async listVehicles(): Promise<string[]> {
    try {
      const resp = await this.authedGet<VwVehiclesResponse>(
        `${VW_HOST_BFF}/vehicle/v1/vehicles`
      );
      return resp.data.map((v) => v.vin);
    } catch (err) {
      // A fresh login only helps when the tokens were rejected (401/403 after
      // authedGet's own refresh+retry). Network errors and VW outages must
      // propagate — re-logging-in on every poll would hammer the IDP.
      if (!/failed: 40[13]\b/.test(String(err))) throw err;
      this.store.clear();
      const resp = await this.authedGet<VwVehiclesResponse>(
        `${VW_HOST_BFF}/vehicle/v1/vehicles`
      );
      return resp.data.map((v) => v.vin);
    }
  }

  async fetchIdData(vin: string): Promise<VwIdData> {
    const statusUrl = `${VW_HOST_BFF}/vehicle/v1/vehicles/${vin}/selectivestatus?jobs=${STATUS_JOBS}`;
    const parkingUrl = `${VW_HOST_BFF}/vehicle/v1/vehicles/${vin}/parkingposition`;

    const status = await this.authedGet<VwSelectiveStatusResponse>(statusUrl);

    let parkingData: VwIdData["parking"] = { data: { carIsParked: false } };
    try {
      const parking = await this.authedGet<VwParkingPositionResponse>(parkingUrl);
      if (parking.data?.lat != null && parking.data?.lon != null) {
        parkingData = {
          data: { carIsParked: true, lat: parking.data.lat, lon: parking.data.lon },
        };
      }
    } catch (err) {
      // The API returns 400/404 when the car is not parked (no last-known
      // location stored). That's not an error — leave carIsParked=false. Match
      // the status in the thrown "VW GET ... failed: <status>" message.
      if (!/failed: 40[04]\b/.test(String(err))) throw err;
    }

    return { ...(status as VwIdData), parking: parkingData };
  }
}
