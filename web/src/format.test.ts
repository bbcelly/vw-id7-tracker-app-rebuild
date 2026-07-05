import { describe, it, expect } from "vitest";
import { fmtDuration, fmtKm, fmtKwh, fmtMonth, fmtPct, isoToLocalInput, localInputToIso } from "./format";

describe("format helpers", () => {
  it("formats durations as Hh Mmin", () => {
    expect(fmtDuration(90)).toBe("1h 30min");
    expect(fmtDuration(45)).toBe("45min");
    expect(fmtDuration(null)).toBe("—");
  });

  it("rounds distance to 1dp and energy to 2dp", () => {
    expect(fmtKm(85.349)).toBe("85.3");
    expect(fmtKwh(7.7)).toBe("7.70");
    expect(fmtKwh(null)).toBe("—");
  });

  it("formats a YYYY-MM month label", () => {
    expect(fmtMonth("2026-07")).toBe("Jul 2026");
    expect(fmtMonth("2025-12")).toBe("Dec 2025");
    expect(fmtMonth("nope")).toBe("—");
    expect(fmtMonth(null)).toBe("—");
  });

  it("formats SOC percent", () => {
    expect(fmtPct(72.6)).toBe("73%");
    expect(fmtPct(null)).toBe("—");
  });

  it("round-trips local datetime input ↔ ISO UTC", () => {
    const iso = localInputToIso("2026-07-01T10:30");
    expect(iso).not.toBeNull();
    expect(isoToLocalInput(iso)).toBe("2026-07-01T10:30");
    expect(localInputToIso("")).toBeNull();
  });
});
