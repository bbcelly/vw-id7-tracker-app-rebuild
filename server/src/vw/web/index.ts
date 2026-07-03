import { loginMyVw, loadSession, saveSession, type MyVwSession } from "./session.js";
import { fetchRangeAndOdometer } from "./fetch-status.js";
import { extractWebStatus, type WebStatus } from "./extract.js";

export type { WebStatus };

/** Ensure a portal session (reuse persisted one, else log in), fetch
 *  range+odometer, and return the parsed status. Never throws — null on failure. */
export async function fetchWebStatus(
  username: string,
  password: string,
  vin: string
): Promise<WebStatus | null> {
  try {
    // 1. Try the cached session first.
    const cached = loadSession();
    if (cached) {
      const bodies = await fetchRangeAndOdometer(cached, vin);
      if (!bodies.unauthorized && (bodies.rangeBody || bodies.maintenanceBody || bodies.chargingBody)) {
        return extractWebStatus(bodies.rangeBody, bodies.maintenanceBody, bodies.chargingBody);
      }
    }
    // 2. (Re)login and retry once.
    const fresh: MyVwSession = await loginMyVw(username, password);
    saveSession(fresh);
    const bodies = await fetchRangeAndOdometer(fresh, vin);
    if (!bodies.rangeBody && !bodies.maintenanceBody && !bodies.chargingBody) {
      console.warn("[VW WEB] login ok but no data returned");
      return null;
    }
    return extractWebStatus(bodies.rangeBody, bodies.maintenanceBody, bodies.chargingBody);
  } catch (err) {
    console.warn(`[VW WEB] fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
