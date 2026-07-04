import { describe, it, expect } from "vitest";
import { chargeSignal, chargerTypeFromSignal } from "../../src/domain/charge-signal.js";

const API_RAW = JSON.stringify({
  charging: { chargingStatus: { value: { chargingState: "charging", chargePower_kW: 45.5, chargeType: "dc" } } },
});
const WEB_RAW = JSON.stringify({
  range: null,
  maintenance: null,
  charging: { data: { chargingStatus: { chargingState: "charging", chargePower_kW: 4.8, chargeType: "ac" } } },
});

describe("chargeSignal", () => {
  it("reads power and charge type from api raw telemetry", () => {
    expect(chargeSignal("api", API_RAW)).toEqual({ powerKw: 45.5, chargeType: "dc" });
  });

  it("reads power and charge type from web raw telemetry", () => {
    expect(chargeSignal("web", WEB_RAW)).toEqual({ powerKw: 4.8, chargeType: "ac" });
  });

  it("returns nulls for missing or malformed raw", () => {
    expect(chargeSignal("api", null)).toEqual({ powerKw: null, chargeType: null });
    expect(chargeSignal("api", "not json")).toEqual({ powerKw: null, chargeType: null });
    expect(chargeSignal("web", "{}")).toEqual({ powerKw: null, chargeType: null });
  });
});

describe("chargerTypeFromSignal", () => {
  it("labels DC from the explicit charge-type signal", () => {
    expect(chargerTypeFromSignal({ powerKw: 11, chargeType: "dc" })).toBe("dc");
  });

  it("labels DC from power above the 22 kW AC ceiling when the type signal is missing", () => {
    expect(chargerTypeFromSignal({ powerKw: 50, chargeType: null })).toBe("dc");
  });

  it("defaults to home for AC and for missing signals", () => {
    expect(chargerTypeFromSignal({ powerKw: 11, chargeType: "ac" })).toBe("home");
    expect(chargerTypeFromSignal({ powerKw: null, chargeType: null })).toBe("home");
  });
});
