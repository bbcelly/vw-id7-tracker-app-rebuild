# myvolkswagen.net web data source (API-down fallback)

**Date:** 2026-06-03
**Status:** Approved design (revised to pure-HTTP), pending implementation plan

## Problem

VW reconfigured their Auth0 tenant (~2026-05-27/30): the OAuth **implicit grant is disabled**, and the CARIAD BFF token-exchange hop (`emea.bff.cariad.digital/auth/v1/idk/oidc/token`) returns 502 — its own upstream call to Auth0 uses the now-disabled implicit grant. This breaks the WeConnect app client (`a24fba63-…@apps_vw-dilab_com`) that this project impersonates, for the whole community. Data updates stopped after the last token expired 2026-05-30; last `vehicle_status` row is id 23. No client-side fix until VW restores the endpoint. See `memory/project_vw_api_break_2026_05.md`.

The myvolkswagen.net **web portal** uses a *different* OAuth client (`3bef4f28-…@apps_vw-dilab_com`) whose token exchange is performed **server-side by VW's `app/authproxy`** — so it still works. A probe (2026-06-03) confirmed we can log in and read **range + odometer** (fresh, timestamped today) **over pure HTTP — no browser required**. See `memory/project_myvw_web_portal_path.md`.

## Goal

Add the myvolkswagen.net web portal as an **automatic fallback data source** that keeps `vehicle_status` updating (range + odometer) while the WeConnect API is down, and **steps aside automatically** when VW restores the API.

### Non-goals
- SOC %, charging state, plug status, parking position, climate — **not available** via the portal's reachable views. The fallback provides range + odometer only.
- Trips and charging sessions — remain driven solely by the primary WeConnect client/events.
- Replacing the WeConnect client. It stays primary; this is strictly a fallback.

## What the probe established (verified live 2026-06-03, pure HTTP)

The entire flow is plain `fetch` + a per-domain cookie jar (the same style as `src/lib/vw/api/auth.ts`). **No Playwright / headless browser.**

**Login** — GET `https://www.myvolkswagen.net/app/authproxy/login` with the full query (REQUIRED — a truncated query 400s):
`?fag=vw-phs,vwag-weconnect&scope-vw-phs=profile,cars,vin&scope-vwag-weconnect=openid,mbb&prompt-vwag-weconnect=none&redirectUrl=https%3A%2F%2Fwww.myvolkswagen.net%2Fcz%2Fcs%2Fmyvolkswagen.html&sessionTimeout=1800`
Follow all redirects with **separate cookie jars** for `myvolkswagen.net` and `vwgroup.io`. At the Auth0 `/u/login` page (200), POST `state` (hidden form field) + `username` + `password` + `action=default` with `Origin`/`Referer` = `https://identity.vwgroup.io`. Keep following the resume chain — it auto-chains **both** federated grants (vw-phs then vwag-weconnect) — until it lands back on `/cz/cs/myvolkswagen.html`. Result: `myvolkswagen.net` cookies `SESSION`, `csrf_token`, `salt`, `authproxy_session_timeout`.

**Data** — GET `https://www.myvolkswagen.net/app/authproxy/{provider}/proxy/{path}?…&resourceHost=…` with headers:
- `Cookie`: the myvolkswagen.net jar
- `x-csrf-token`: the `csrf_token` cookie value (double-submit)
- **`content-type: application/json;version=1`** — THE UNLOCK. VCF rejects `charset=UTF-8` with `400 {code:2105 "request is incorrect"}`; the `;version=1` API-version content-type is mandatory.
- `user-id: __userId__` (literal placeholder; the authproxy substitutes the real id server-side)
- `Accept: */*`, `Referer` = portal, `sec-fetch-site: same-origin`

Endpoints:
- range: `vwag-weconnect/proxy/vehicles/{vin}/measurements?gdc=myvw-wcar-prod&id=range&resourceHost=myvw-vcf-prod` → `data[0].properties[name=electricRange_km].value` (e.g. "458"), with `carCapturedTimestamp`.
- odometer: `vwag-weconnect/proxy/vehicles/{vin}/maintenance/status?gdc=myvw-wcar-prod&resourceHost=myvw-vcf-prod` → `data.mileage_km` (e.g. 11784), with `carCapturedTimestamp`.

## Architecture

New isolated module `src/lib/vw/web/` (mirrors the `src/lib/vw/api/` HTTP/cookie style):

| File | Responsibility | Depends on |
|------|----------------|-----------|
| `cookies.ts` | Per-domain cookie jar: `mergeSetCookie`, `cookieHeader`, `followRedirect` (manual-redirect fetch wrapper). | — |
| `session.ts` | `loginMyVw(username, password)`: run the authproxy login chain → returns `{ cookies (myvw jar), csrfToken }`. Persist/reuse to `data/myvw-session.json`; re-login when a data call shows the session expired. | cookies.ts |
| `fetch-status.ts` | `fetchRangeAndOdometer(session, vin)`: GET the range + maintenance proxy endpoints with the required headers; return the two raw JSON bodies. | cookies.ts |
| `extract.ts` | **Pure**: raw proxy JSON → `WebStatus { rangeKm, odometerKm, capturedAt, raw }`. Defines `WebStatus`. Unit-tested. | — |
| `index.ts` | `fetchWebStatus(username, password, vin): Promise<WebStatus \| null>` — ensure session → fetch → extract. Never throws. Re-exports `WebStatus`. | above |
| `fallback.ts` | `WebFallback` DI state machine (primary-retry / web-fetch / stop). Unit-tested. | extract.ts |

`WebStatus = { rangeKm: number \| null; odometerKm: number \| null; capturedAt: Date \| null; raw: unknown }`.

### Fallback orchestration (in `src/lib/vw/client.ts`)

- Module-level `webFallback: WebFallback | null` and a `webTickRunning` guard.
- `autoConnect()`: try primary `connect()`; on failure call `startWebFallback()`.
- `startWebFallback()`: if not already active, start `setInterval(tick, poll_interval*60_000)` and run one tick now.
- Each tick: first retry primary `connect()` — on success `stop()` (RECOVERY; primary loop + events resume); else `fetchWebStatus()` and, if non-duplicate, insert a `vehicle_status` row with range + odometer, `source='web'`, SOC/charging/parking `null`.
- `disconnect()` stops the fallback. `/api/sync` does the same try-primary-then-web one-shot.

## Schema change

Add to `vehicle_status` (Drizzle migration): `source TEXT DEFAULT 'api'`. Existing rows backfill to `'api'`; web rows are `'web'`. Enables UI labeling and documents provenance. The SOC-delta/trip/charging logic already keys off non-null SOC and primary-only events, so partial web rows can't trigger spurious sessions.

## Data flow

```
poll tick (fallback mode)
  └─ connect()  [primary WeConnect]
       ├─ success → stopWebFallback(); primary resumes        (RECOVERY)
       └─ fail → fetchWebStatus(user, pass, vin)   [pure HTTP]
                   ├─ reuse data/myvw-session.json, or run authproxy login chain
                   ├─ GET range + maintenance proxy endpoints (version=1 content-type)
                   ├─ extract.ts → { rangeKm, odometerKm, capturedAt }
                   └─ insert vehicle_status (source='web', SOC/charging/parking null)
```
Dedup: skip the insert if `capturedAt` equals the latest `source='web'` row's timestamp.

## Error handling

- Login or fetch failures (network, markup change, expired session, non-200) → `fetchWebStatus` logs via the existing `[VW WEB]` console pattern and returns `null`; the tick writes nothing and retries next interval. Server never crashes.
- Session expiry → a data GET returns 401/redirects to login → discard the saved session and re-login once.
- Overlapping ticks prevented by `webTickRunning`.
- Bad credentials → login chain never reaches the portal → logged clearly; primary is still retried each tick so recovery is never blocked.

## Deployment

- **No new heavy dependencies.** Pure `fetch` (global in Node 20+) + cookie handling, identical in spirit to `src/lib/vw/api/`. **No Playwright, no Chromium, no Dockerfile/base-image changes.** Session file `data/myvw-session.json` lives alongside the SQLite DB.
- Cadence: matches `poll_interval` (default 5 min) while in fallback; session reuse avoids re-login on most ticks.

## Testing

- `extract.ts`: unit tests with captured proxy-JSON fixtures → range/odometer/capturedAt parsing, missing-field/null handling. TDD.
- `session.ts` / `fetch-status.ts`: unit-testable by injecting a fake `fetch` (assert the login chain follows redirects + posts credentials; assert data GETs send `x-csrf-token` + `content-type: application/json;version=1`). A live manual smoke script under `scripts/` covers the real endpoint.
- `fallback.ts`: unit tests for primary-fails→web-insert and primary-recovers→stop transitions, with `fetchWebStatus`/`connect` mocked.

## Risks / open items

- The portal could add bot protection or change the login markup / the `;version=1` contract. Mitigation: failures are non-fatal and primary keeps being retried; the smoke script aids quick re-diagnosis.
- Live SOC/charging may become reachable if the EU Data Act consent (unaccepted banner in portal) is granted, or via a charging view not yet found — out of scope, noted as a future enhancement.
