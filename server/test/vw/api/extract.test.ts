import { describe, it, expect } from "vitest";
import { extractSnapshot, extractLiveExtras } from "../../../src/vw/api/extract.js";
import type { VwIdData } from "../../../src/vw/api/types.js";

const FULL: VwIdData = {
  access: { accessStatus: { value: { overallStatus: "safe", doorLockStatus: "locked" } } },
  charging: {
    batteryStatus: { value: { currentSOC_pct: 63, cruisingRangeElectric_km: 342 } },
    chargingStatus: { value: { chargingState: "charging" } },
    chargingSettings: { value: { targetSOC_pct: 80, maxChargeCurrentAC: "maximum" } },
    plugStatus: { value: { externalPower: "active" } },
  },
  climatisation: {
    climatisationStatus: { value: { climatisationState: "off" } },
    climatisationSettings: { value: { targetTemperature_C: 21.5 } },
  },
  measurements: { odometerStatus: { value: { odometer: 11784 } } },
  parking: { data: { carIsParked: true, lat: 50.0755, lon: 14.4378 } },
};

describe("extractSnapshot", () => {
  it("maps a full payload", () => {
    const s = extractSnapshot(FULL, "2026-07-03T10:00:00.000Z");
    expect(s).toMatchObject({
      ts: "2026-07-03T10:00:00.000Z",
      soc: 63,
      rangeKm: 342,
      odometerKm: 11784,
      isParked: true,
      isCharging: true,
      isPlugged: true,
      chargingState: "charging",
      externalPower: "active",
      targetSoc: 80,
      lat: 50.0755,
      lon: 14.4378,
      source: "api",
    });
    expect(JSON.parse(s.raw!)).toEqual(FULL);
  });

  it("maps an empty payload to all-null fields (never throws)", () => {
    const s = extractSnapshot({}, "2026-07-03T10:00:00.000Z");
    expect(s.soc).toBeNull();
    expect(s.isCharging).toBeNull();
    expect(s.isPlugged).toBeNull();
    expect(s.isParked).toBeNull();
    expect(s.lat).toBeNull();
  });

  it("readyForCharging is not charging; plug 'ready' counts as plugged", () => {
    const s = extractSnapshot(
      {
        charging: {
          chargingStatus: { value: { chargingState: "readyForCharging" } },
          plugStatus: { value: { externalPower: "ready" } },
        },
      },
      "2026-07-03T10:00:00.000Z"
    );
    expect(s.isCharging).toBe(false);
    expect(s.isPlugged).toBe(true);
  });
});

describe("extractLiveExtras", () => {
  it("pulls climate and lock state", () => {
    expect(extractLiveExtras(FULL)).toEqual({
      climatisationState: "off",
      doorLockStatus: "locked",
      targetTemperatureC: 21.5,
    });
    expect(extractLiveExtras({})).toEqual({
      climatisationState: null,
      doorLockStatus: null,
      targetTemperatureC: null,
    });
  });
});
