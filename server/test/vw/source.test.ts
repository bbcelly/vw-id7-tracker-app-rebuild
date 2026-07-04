import { describe, it, expect, vi } from "vitest";
import { VehicleSource, type VehicleSourceDeps } from "../../src/vw/source.js";
import type { WebStatus } from "../../src/vw/web/index.js";

const WEB_STATUS: WebStatus = {
  capturedAt: new Date("2026-07-04T10:00:00Z"),
  socPercent: 72,
  rangeKm: 433,
  odometerKm: 12639,
  isCharging: false,
  isPlugged: false,
  chargingState: "notReadyForCharging",
  externalPower: "unavailable",
  raw: null,
} as WebStatus;

function makeDeps(overrides: Partial<VehicleSourceDeps> = {}): VehicleSourceDeps & {
  setVin: ReturnType<typeof vi.fn>;
  fetchWebVins: ReturnType<typeof vi.fn>;
  fetchWeb: ReturnType<typeof vi.fn>;
} {
  return {
    api: {
      listVehicles: vi.fn().mockRejectedValue(new Error("Token request failed: 502")),
      fetchIdData: vi.fn().mockRejectedValue(new Error("Token request failed: 502")),
    },
    fetchWeb: vi.fn().mockResolvedValue(WEB_STATUS),
    fetchWebVins: vi.fn().mockResolvedValue(["WVWZZZED4SE034784"]),
    getCredentials: () => ({ username: "u@example.com", password: "pw" }),
    getVin: () => null,
    setVin: vi.fn(),
    log: () => {},
    ...overrides,
  } as any;
}

describe("VehicleSource VIN bootstrap via web portal", () => {
  it("discovers the VIN through the web portal when the primary is down and no VIN is set", async () => {
    const deps = makeDeps();
    const source = new VehicleSource(deps);
    const snapshot = await source.poll(new Date("2026-07-04T10:05:00Z"), true);
    expect(deps.setVin).toHaveBeenCalledWith("WVWZZZED4SE034784");
    expect(deps.fetchWeb).toHaveBeenCalledWith("u@example.com", "pw", "WVWZZZED4SE034784");
    expect(source.state).toBe("web");
    expect(snapshot?.source).toBe("web");
  });

  it("stays disconnected when web VIN discovery finds nothing", async () => {
    const deps = makeDeps({ fetchWebVins: vi.fn().mockResolvedValue(null) as any });
    const source = new VehicleSource(deps);
    const snapshot = await source.poll(new Date(), true);
    expect(snapshot).toBeNull();
    expect(source.state).toBe("disconnected");
    expect(deps.setVin).not.toHaveBeenCalled();
    expect(deps.fetchWeb).not.toHaveBeenCalled();
  });

  it("does not attempt discovery when a VIN is already configured", async () => {
    const deps = makeDeps({ getVin: () => "WVWALREADY0CONFIG" });
    const source = new VehicleSource(deps);
    const snapshot = await source.poll(new Date(), true);
    expect(deps.fetchWebVins).not.toHaveBeenCalled();
    expect(deps.fetchWeb).toHaveBeenCalledWith("u@example.com", "pw", "WVWALREADY0CONFIG");
    expect(snapshot?.source).toBe("web");
  });
});
