import { describe, it, expect } from "vitest";
import { fetchVehicleRelations } from "../../../src/vw/web/fetch-status.js";
import type { MyVwSession } from "../../../src/vw/web/session.js";

const SESSION: MyVwSession = { cookies: { SESSION: "abc", csrf_token: "tok" }, csrfToken: "tok" };

const RELATIONS = {
  user: { idKitUserId: "u1" },
  relations: [
    { vehicleNickname: "ID.7", role: "PRIMARY_USER", vehicle: { vin: "WVWZZZED4SE034784", commissionId: null } },
    { vehicleNickname: "no-vin car", role: "GUEST_USER", vehicle: { vin: null, commissionId: "123" } },
  ],
};

function fakeFetch(status: number, body: unknown): { fn: typeof fetch; calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("fetchVehicleRelations", () => {
  it("extracts VINs from the VUM relations response", async () => {
    const { fn } = fakeFetch(200, RELATIONS);
    const r = await fetchVehicleRelations(SESSION, fn);
    expect(r.unauthorized).toBe(false);
    expect(r.vins).toEqual(["WVWZZZED4SE034784"]);
  });

  it("calls the vw-phs VUM proxy with session cookies and a traceId header", async () => {
    const { fn, calls } = fakeFetch(200, RELATIONS);
    await fetchVehicleRelations(SESSION, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://www.myvolkswagen.net/app/authproxy/vw-phs/proxy/v2/users/me/relations?resourceHost=myvw-vum-prod"
    );
    expect(calls[0].headers.get("Cookie")).toContain("SESSION=abc");
    expect(calls[0].headers.get("traceId")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports an expired session as unauthorized", async () => {
    const { fn } = fakeFetch(401, "");
    const r = await fetchVehicleRelations(SESSION, fn);
    expect(r.unauthorized).toBe(true);
    expect(r.vins).toBeNull();
  });

  it("returns null vins on non-ok status and malformed bodies", async () => {
    const { fn: f500 } = fakeFetch(500, "boom");
    expect((await fetchVehicleRelations(SESSION, f500)).vins).toBeNull();
    const { fn: fJunk } = fakeFetch(200, "not json");
    expect((await fetchVehicleRelations(SESSION, fJunk)).vins).toBeNull();
    const { fn: fEmpty } = fakeFetch(200, { relations: [] });
    expect((await fetchVehicleRelations(SESSION, fEmpty)).vins).toEqual([]);
  });
});
