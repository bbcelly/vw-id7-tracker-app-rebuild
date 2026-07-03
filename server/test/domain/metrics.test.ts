import { describe, it, expect } from "vitest";
import { finalizeTrip, finalizeCharge, round } from "../../src/domain/metrics.js";
import type { TripInsert, ChargingInsert } from "../../src/domain/types.js";

const baseTrip: TripInsert = {
  startTs: "2026-07-01T08:00:00.000Z",
  endTs: "2026-07-01T09:30:00.000Z",
  startOdometer: 1000,
  endOdometer: 1085.4,
  startSoc: 80,
  endSoc: 60,
  distanceKm: null,
  energyKwh: null,
  consumption: null,
  durationMin: null,
  notes: null,
  source: "auto",
};

describe("finalizeTrip", () => {
  it("computes distance, energy, consumption and duration from raw fields", () => {
    const t = finalizeTrip(baseTrip, 77);
    expect(t.distanceKm).toBe(85.4); // 1dp
    expect(t.energyKwh).toBe(15.4); // (80-60)/100*77, 2dp
    expect(t.consumption).toBe(18.03); // 15.4/85.4*100 → 2dp
    expect(t.durationMin).toBe(90);
  });

  it("manual values always win over computed ones", () => {
    const t = finalizeTrip(
      { ...baseTrip, distanceKm: 90, energyKwh: 14, consumption: 10 },
      77
    );
    expect(t.distanceKm).toBe(90);
    expect(t.energyKwh).toBe(14);
    expect(t.consumption).toBe(10);
  });

  it("missing SOC → null energy and consumption", () => {
    const t = finalizeTrip({ ...baseTrip, startSoc: null }, 77);
    expect(t.energyKwh).toBeNull();
    expect(t.consumption).toBeNull();
    expect(t.distanceKm).toBe(85.4);
  });

  it("zero or missing distance → null consumption", () => {
    const same = finalizeTrip(
      { ...baseTrip, endOdometer: 1000 },
      77
    );
    expect(same.consumption).toBeNull();
    const noOdo = finalizeTrip({ ...baseTrip, startOdometer: null }, 77);
    expect(noOdo.distanceKm).toBeNull();
    expect(noOdo.consumption).toBeNull();
  });

  it("open trip (no endTs) → null duration", () => {
    const t = finalizeTrip({ ...baseTrip, endTs: null }, 77);
    expect(t.durationMin).toBeNull();
  });
});

describe("finalizeCharge", () => {
  const baseCharge: ChargingInsert = {
    startTs: "2026-07-01T20:00:00.000Z",
    endTs: "2026-07-01T23:00:00.000Z",
    startSoc: 40,
    endSoc: 80,
    energyKwh: null,
    cost: null,
    pricePerKwh: null,
    maxPowerKw: null,
    chargerType: null,
    location: null,
    lat: null,
    lon: null,
    notes: null,
    source: "auto",
  };

  it("computes charged energy from SOC delta", () => {
    const c = finalizeCharge(baseCharge, 77);
    expect(c.energyKwh).toBe(30.8); // (80-40)/100*77
  });

  it("fills cost from energy × price when cost missing", () => {
    const c = finalizeCharge({ ...baseCharge, pricePerKwh: 0.25 }, 77);
    expect(c.cost).toBe(7.7);
  });

  it("manual energy and cost win", () => {
    const c = finalizeCharge(
      { ...baseCharge, energyKwh: 28, cost: 5, pricePerKwh: 0.25 },
      77
    );
    expect(c.energyKwh).toBe(28);
    expect(c.cost).toBe(5);
  });

  it("missing SOC → null energy, no cost fill", () => {
    const c = finalizeCharge({ ...baseCharge, endSoc: null, pricePerKwh: 0.3 }, 77);
    expect(c.energyKwh).toBeNull();
    expect(c.cost).toBeNull();
  });
});

describe("round", () => {
  it("rounds to given decimals", () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(85.349, 1)).toBe(85.3);
    expect(round(null, 2)).toBeNull();
  });
});
