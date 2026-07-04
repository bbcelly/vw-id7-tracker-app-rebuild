// Cross-field sanity checks that zod's per-field schemas can't express.
// Used on POST (after parse) and PATCH (after merging into the existing row).

export function tripCrossFieldError(t: {
  startTs: string;
  endTs: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
}): string | null {
  if (t.endTs !== null && Date.parse(t.endTs) < Date.parse(t.startTs)) {
    return "end time must not be before start time";
  }
  if (
    t.startOdometer !== null &&
    t.endOdometer !== null &&
    t.endOdometer < t.startOdometer
  ) {
    return "end odometer must not be below start odometer";
  }
  return null;
}

export function chargeCrossFieldError(c: {
  startTs: string;
  endTs: string | null;
  startSoc: number | null;
  endSoc: number | null;
}): string | null {
  if (c.endTs !== null && Date.parse(c.endTs) < Date.parse(c.startTs)) {
    return "end time must not be before start time";
  }
  if (c.startSoc !== null && c.endSoc !== null && c.endSoc < c.startSoc) {
    return "end SOC must not be below start SOC for a charge";
  }
  return null;
}
