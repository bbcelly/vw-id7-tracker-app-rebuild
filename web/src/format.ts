// Display formatting per GOAL.md: en-GB dates, durations "Hh Mmin",
// energy/consumption 2 decimals, distance 1 decimal.

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

export function fmtDuration(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const whole = Math.round(min);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function fixed(v: number | null | undefined, dp: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(dp);
}

export const fmtKm = (v: number | null | undefined) => fixed(v, 1);
export const fmtKwh = (v: number | null | undefined) => fixed(v, 2);
export const fmtConsumption = (v: number | null | undefined) => fixed(v, 2);
export const fmtMoney = (v: number | null | undefined, currency = "EUR") =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(2)} ${currency}`;
export const fmtPct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}%`;

/** ISO UTC → value for <input type="datetime-local"> in the user's zone. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (user's zone) → ISO UTC for the API. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
