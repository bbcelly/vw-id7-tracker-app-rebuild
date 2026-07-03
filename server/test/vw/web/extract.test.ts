import { describe, it, expect } from "vitest";
import { extractWebStatus } from "../../../src/vw/web/extract.js";

const RANGE = {
  data: [
    {
      id: "range",
      carCapturedTimestamp: "2026-06-03T07:38:39.239Z",
      properties: [
        { name: "electricRange_km", value: "458" },
        { name: "primaryEngineType", value: "electric" },
      ],
    },
  ],
};
const MAINT = {
  data: { carCapturedTimestamp: "2026-06-03T07:38:39.293Z", mileage_km: 11784, inspectionDue_days: 292 },
};
const CHARGING = {
  data: {
    batteryStatus: { carCapturedTimestamp: "2026-06-03T07:38:51Z", currentSOC_pct: 73, cruisingRangeElectric_km: 458 },
    chargingStatus: { carCapturedTimestamp: "2026-06-03T07:38:51Z", chargingState: "charging", chargePower_kW: 11 },
    plugStatus: { plugConnectionState: "connected", externalPower: "active" },
  },
};

describe("extractWebStatus (ported fixtures from original)", () => {
  it("extracts range, odometer and capturedAt", () => {
    const s = extractWebStatus(RANGE, MAINT);
    expect(s.rangeKm).toBe(458);
    expect(s.odometerKm).toBe(11784);
    expect(s.capturedAt?.toISOString()).toBe("2026-06-03T07:38:39.239Z");
  });

  it("extracts SOC, charging state and plug status from charging/status", () => {
    const s = extractWebStatus(RANGE, MAINT, CHARGING);
    expect(s.socPercent).toBe(73);
    expect(s.chargingState).toBe("charging");
    expect(s.isCharging).toBe(true);
    expect(s.externalPower).toBe("active");
    expect(s.isPlugged).toBe(true);
    expect(s.capturedAt?.toISOString()).toBe("2026-06-03T07:38:51.000Z");
  });

  it("idle car → flags false; charging body fills range when range body absent", () => {
    const idle = {
      data: {
        batteryStatus: { carCapturedTimestamp: "2026-06-03T07:38:51Z", currentSOC_pct: 73, cruisingRangeElectric_km: 458 },
        chargingStatus: { chargingState: "notReadyForCharging" },
        plugStatus: { externalPower: "unavailable" },
      },
    };
    const s = extractWebStatus(null, MAINT, idle);
    expect(s.socPercent).toBe(73);
    expect(s.rangeKm).toBe(458);
    expect(s.isCharging).toBe(false);
    expect(s.isPlugged).toBe(false);
  });

  it("no charging body → soc/charging fields null", () => {
    const s = extractWebStatus(RANGE, MAINT);
    expect([s.socPercent, s.isCharging, s.isPlugged, s.chargingState, s.externalPower]).toEqual([
      null, null, null, null, null,
    ]);
  });

  it("range missing → odometer still parsed, capturedAt falls back to maintenance", () => {
    const s = extractWebStatus(null, MAINT);
    expect(s.rangeKm).toBeNull();
    expect(s.odometerKm).toBe(11784);
    expect(s.capturedAt?.toISOString()).toBe("2026-06-03T07:38:39.293Z");
  });

  it("garbage bodies yield nulls, never throws", () => {
    const s = extractWebStatus(undefined, undefined);
    expect([s.rangeKm, s.odometerKm, s.capturedAt]).toEqual([null, null, null]);
  });

  it("empty electricRange value → null range", () => {
    const s = extractWebStatus(
      { data: [{ id: "range", properties: [{ name: "electricRange_km", value: "" }] }] },
      MAINT
    );
    expect(s.rangeKm).toBeNull();
  });
});
