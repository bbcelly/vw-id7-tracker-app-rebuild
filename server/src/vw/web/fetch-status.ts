import { UA, type MyVwSession } from "./session.js";

const PORTAL = "https://www.myvolkswagen.net/cz/cs/myvolkswagen.html";
const BASE = "https://www.myvolkswagen.net/app/authproxy";

export interface RawBodies {
  rangeBody: unknown | null;
  maintenanceBody: unknown | null;
  chargingBody: unknown | null;
  unauthorized: boolean;
}

function dataHeaders(s: MyVwSession): Record<string, string> {
  return {
    Cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join("; "),
    "x-csrf-token": s.csrfToken,
    "content-type": "application/json;version=1",
    "user-id": "__userId__",
    Accept: "*/*",
    "Accept-Language": "cs-CZ",
    Referer: PORTAL,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "User-Agent": UA,
  };
}

async function getJson(
  s: MyVwSession,
  pathAndQuery: string,
  fetchFn: typeof fetch
): Promise<{ body: unknown | null; unauthorized: boolean }> {
  const resp = await fetchFn(`${BASE}/${pathAndQuery}`, { headers: dataHeaders(s) });
  if (resp.status === 401) return { body: null, unauthorized: true };
  if (!resp.ok) return { body: null, unauthorized: false };
  try {
    return { body: await resp.json(), unauthorized: false };
  } catch {
    return { body: null, unauthorized: false };
  }
}

/** List the account's vehicles via the VUM relations endpoint. Used to
 *  bootstrap the VIN when the primary API is down (it normally auto-detects).
 *  vins: null = request failed, [] = account genuinely has no vehicles. */
export async function fetchVehicleRelations(
  s: MyVwSession,
  fetchFn: typeof fetch = fetch
): Promise<{ vins: string[] | null; unauthorized: boolean }> {
  // VUM rejects requests without a traceId header outright (400).
  const headers = { ...dataHeaders(s), traceId: crypto.randomUUID() };
  const resp = await fetchFn(`${BASE}/vw-phs/proxy/v2/users/me/relations?resourceHost=myvw-vum-prod`, {
    headers,
  });
  if (resp.status === 401) return { vins: null, unauthorized: true };
  if (!resp.ok) return { vins: null, unauthorized: false };
  try {
    const body = (await resp.json()) as { relations?: { vehicle?: { vin?: string | null } }[] };
    const vins = (body.relations ?? [])
      .map((r) => r.vehicle?.vin)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    return { vins, unauthorized: false };
  } catch {
    return { vins: null, unauthorized: false };
  }
}

// Usable (net) capacity per VW ID gross pack size — VW only publishes gross.
// Unknown packs fall back to the ~94% net/gross ratio the known packs share.
const GROSS_TO_NET_KWH: Record<number, number> = { 48: 45, 62: 58, 82: 77, 84: 79, 91: 86 };

export function netFromGrossKwh(gross: number): number {
  return GROSS_TO_NET_KWH[gross] ?? Math.round(gross * 0.94);
}

/** Vehicle spec via the GVF (group-vehicle-file) service: gross HV-battery
 *  capacity + model name. The battery is the largest kWh figure in the spec
 *  list (the 12 V battery is listed in Ah), locale-independent. */
export async function fetchVehicleSpec(
  s: MyVwSession,
  vin: string,
  fetchFn: typeof fetch = fetch
): Promise<{ grossBatteryKwh: number | null; modelName: string | null; unauthorized: boolean }> {
  const headers = { ...dataHeaders(s), traceId: crypto.randomUUID() };
  const resp = await fetchFn(
    `${BASE}/vw-phs/proxy/vehicles/${vin}/details/cs-CZ?resourceHost=cwat-group-vehicle-file-service-prod`,
    { headers }
  );
  if (resp.status === 401) return { grossBatteryKwh: null, modelName: null, unauthorized: true };
  if (!resp.ok) return { grossBatteryKwh: null, modelName: null, unauthorized: false };
  try {
    const body = (await resp.json()) as { modelName?: unknown; specifications?: { codeText?: unknown }[] };
    let gross: number | null = null;
    for (const spec of body.specifications ?? []) {
      if (typeof spec.codeText !== "string") continue;
      const m = /(\d+(?:[.,]\d+)?)\s*kWh/i.exec(spec.codeText);
      if (!m) continue;
      const v = parseFloat(m[1].replace(",", "."));
      if (gross === null || v > gross) gross = v;
    }
    return {
      grossBatteryKwh: gross,
      modelName: typeof body.modelName === "string" ? body.modelName : null,
      unauthorized: false,
    };
  } catch {
    return { grossBatteryKwh: null, modelName: null, unauthorized: false };
  }
}

export async function fetchRangeAndOdometer(
  s: MyVwSession,
  vin: string,
  fetchFn: typeof fetch = fetch
): Promise<RawBodies> {
  // The three endpoints are independent — fetch them concurrently.
  // charging/status: SOC + charging state + plug status (no consent needed, verified 2026-06-03).
  const [range, maint, charging] = await Promise.all([
    getJson(
      s,
      `vwag-weconnect/proxy/vehicles/${vin}/measurements?gdc=myvw-wcar-prod&id=range&resourceHost=myvw-vcf-prod`,
      fetchFn
    ),
    getJson(
      s,
      `vwag-weconnect/proxy/vehicles/${vin}/maintenance/status?gdc=myvw-wcar-prod&resourceHost=myvw-vcf-prod`,
      fetchFn
    ),
    getJson(
      s,
      `vwag-weconnect/proxy/vehicles/${vin}/charging/status?gdc=myvw-wcar-prod&resourceHost=myvw-vcf-prod`,
      fetchFn
    ),
  ]);
  return {
    rangeBody: range.body,
    maintenanceBody: maint.body,
    chargingBody: charging.body,
    unauthorized: range.unauthorized || maint.unauthorized || charging.unauthorized,
  };
}
