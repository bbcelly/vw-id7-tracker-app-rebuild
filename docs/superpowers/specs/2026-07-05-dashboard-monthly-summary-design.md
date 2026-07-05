# Dashboard — Monthly Breakdown

**Status:** approved · **Date:** 2026-07-05

## Goal

Add a per-month summary to the Dashboard so the owner can see recent
month-over-month usage, complementing the existing lifetime totals.

## What the user sees

A new `.panel` titled **"Monthly breakdown"**, placed **below the consumption
trend panel** (i.e. after the trend, above the recent trips/charges grid). It
renders a table, newest month first:

| Month | Distance | Charged | Cost | Consumption | Trips |
|-------|----------|---------|------|-------------|-------|
| Jul 2026 | 412.0 km | 68.00 kWh | 24.00 EUR | 16.50 kWh/100 | 9 |

- Empty state: `No activity yet` (reuse existing `.empty` style).
- At most the **last 12 months** that have any activity are shown.

## Backend — `GET /api/stats/monthly`

Added in `server/src/http/routes/stats.ts`.

Two grouped queries keyed by `strftime('%Y-%m', start_ts)`:

- **trips** per month:
  - `tripCount = COUNT(*)`
  - `distanceKm = SUM(distance_km)`
  - weighted-consumption components: `SUM(distance_km)` and `SUM(energy_kwh)`
    over rows where `distance_km > 0 AND energy_kwh IS NOT NULL` — same rule as
    the lifetime `avgConsumption`. Per-month `avgConsumption = e/d*100` when
    `d > 0`, else `null`.
- **charging_sessions** per month:
  - `chargeCount = COUNT(*)`
  - `chargedKwh = SUM(energy_kwh)`
  - `chargeCost = SUM(cost)`

Merge the two result sets in JS into a map keyed by `YYYY-MM` so a month with
only charges (or only trips) still appears. Emit one row per month with any
activity, sorted **newest-first**, capped to 12 rows.

Row shape returned to the client:

```ts
{ month: "2026-07", distanceKm, avgConsumption, chargedKwh, chargeCost, tripCount, chargeCount }
```

Numbers rounded with the existing `round()` helper (distance 1dp, energy/cost/
consumption 2dp), consistent with `/api/stats`.

### Known simplification — UTC month bucketing

Months are bucketed by **UTC** calendar month via `strftime`, consistent with
every other aggregate in `stats.ts`. A trip near a month boundary could land in
the neighbouring month in the user's local zone. Accepted tradeoff for a
single-user self-hosted app; not worth threading a timezone offset through SQL.

## API client — `web/src/api.ts`

- Add `MonthlyStat` interface matching the row shape above.
- Add `api.monthly()` → `request<MonthlyStat[]>("/api/stats/monthly")`.

## Frontend — `web/src/pages/Dashboard.tsx`

- `const monthly = useApi(api.monthly);`
- New panel below the trend chart, above the two-column recent-activity grid.
- New formatter in `web/src/format.ts`: `fmtMonth("2026-07") → "Jul 2026"`
  (parse year/month, format with a `month: "short", year: "numeric"` Intl
  formatter). Returns `—` on malformed input.
- Reuse `fmtKm`, `fmtKwh`, `fmtMoney`, `fmtConsumption`. Currency from settings.

## Tests

- `server/test/http/api.test.ts`: seed one trip + one charge in a month, hit
  `/api/stats/monthly`, assert a single row with correct sums and consumption.
  Also assert a month with only a charge still appears.
- `web/src/format.test.ts`: `fmtMonth("2026-07")` → `"Jul 2026"`; malformed → `—`.

## Out of scope

Bar chart of monthly values, month drill-down/filtering, calendar-month picker,
CSV export, local-timezone bucketing.
