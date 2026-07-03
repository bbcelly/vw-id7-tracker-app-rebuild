# GOAL — Self-Hosted EV Tracker for a VW ID.7

This document defines **what** this project does, so it can be rebuilt from scratch.
It deliberately avoids prescribing architecture, frameworks, languages, or libraries —
a new build should make its own technology decisions. Only external constraints
(VW's APIs, units, domain rules) are fixed.

## Purpose

A self-hosted web application for the owner of a single electric car (VW ID.7 Pro S)
that automatically tracks the vehicle's usage over time by talking to Volkswagen's
connected-car backend, and lets the owner review, annotate, and analyze:

- **Live vehicle status** — battery %, range, odometer, charging/plug state,
  parked/driving, parked location, climate, door locks.
- **Trips** — detected automatically from vehicle telemetry, or entered manually.
- **Charging sessions** — detected automatically or entered manually, with energy and cost.
- **Statistics** — totals, averages, and a consumption trend over time.

Single user, single vehicle. The app itself has **no login** — it assumes a trusted
self-hosted deployment (e.g. home server / Docker). The only credentials involved
are the owner's VW account credentials, which the app stores and uses server-side.

## Core domain model (semantics, not schema)

Metric units throughout: km, kWh, kW, %, EUR. Timestamps stored as unambiguous
UTC instants; user enters times in local time and the client converts.

- **Vehicle status snapshot** — one record per meaningful poll of the car:
  timestamp, SOC %, range km, odometer km, parked/charging/plugged flags,
  charging state, external power state, target SOC, parked coordinates,
  the raw upstream payload, and which data source produced it (`api` / `web` / `manual`).
- **Trip** — start/end time, start/end odometer, start/end SOC, distance,
  energy used, consumption, duration, free-text notes, source.
- **Charging session** — start/end time, start/end SOC, energy charged, cost,
  price per kWh, max power, charger type (`home` / `ac` / `dc`), location
  (text + optional coordinates), notes, source.
- **Trip positions** — optional GPS breadcrumbs per trip for route mapping
  (in practice only start/end points: VW reports position only while parked).
- **Settings** — key/value store for user configuration and persisted VW tokens.

### Derived metrics (fixed domain rules)

- Distance = end odometer − start odometer (unless explicitly given).
- Trip energy = (startSOC − endSOC)/100 × battery capacity (default 77 kWh, configurable).
- Charged energy = (endSOC − startSOC)/100 × battery capacity.
- Consumption = energy / distance × 100 (kWh/100km).
- Manually supplied values always win; computed values only fill gaps.
- SOC bounded 0–100; validate all input server-side.

## Features (screens / capabilities)

1. **Dashboard** — stat cards (total distance, average consumption, total energy
   charged, total cost, trip/session counts), a consumption-trend chart over recent
   trips, and short "recent trips" / "recent charges" lists.
2. **Trips** — full list (newest first), manual add, edit, delete. Optional route
   map from stored trip positions.
3. **Charging** — full list with summary header (count, total kWh, total spend),
   manual add, edit, delete.
4. **Vehicle (live status)** — auto-refreshing view with a map of the parked
   location, battery gauge with target SOC, range, odometer, charging/plug badges,
   climate and lock state, and a "Sync Now" button that forces an immediate poll.
   Falls back to the latest stored snapshot when the car is unreachable.
5. **Settings** — VW credentials (password write-only/masked), VIN (auto-detected
   on first connect, editable), poll interval (1–60 min, default 5), battery
   capacity, electricity price + currency, position-tracking toggle, SOC-delta
   charging-detection toggle + threshold; connection-status indicator and a
   "Connect & Sync" action.

Responsive layout (desktop sidebar / mobile tabs). Display formatting: `en-GB`
dates, durations as `Hh Mmin`, energy/consumption rounded to 2 decimals,
distance to 1.

## VW integration (external constraints — this knowledge is hard-won, keep it)

The full, live-verified protocol details are in **`docs/vw-auth-migration.md`**
(and design docs under `docs/superpowers/`). A rebuild must preserve that document;
the essentials:

- **Primary path — WeConnect app API.** Impersonate the VW WeConnect mobile app.
  Auth is OIDC **authorization-code + PKCE** against `identity.vwgroup.io`
  (Auth0 Universal Login, HTML scraping of the login form), then a token exchange
  at the CARIAD BFF. The pre-2026 BFF login endpoints and the hybrid/implicit flow
  are **dead** — do not resurrect community libraries built on them. Data calls
  are plain Bearer-token GETs (`selectivestatus` + `parkingposition`) and did not
  change. Tokens are persisted; refresh on expiry, headless re-login on 401/403.
  No MFA support required (password-only account).
- **Fallback path — myvolkswagen.net web portal.** A different OAuth client whose
  token exchange VW performs server-side (`authproxy`), so it survives app-client
  breakage. Provides only **range + odometer + a charging signal** (no SOC, plug,
  position, climate). Requires the VIN to be configured. The app must switch to
  this path automatically when the primary login fails and step back when the
  primary recovers, tagging every record with its source so mixed-source data
  never fabricates phantom trips.
- **Polling, not push.** Poll on the configured interval from a background loop
  inside the app (started automatically on boot; no external cron). Manual
  "Sync Now" triggers an immediate poll.

### Automatic detection rules (the heart of the app)

Compare consecutive polls and derive events:

- Charging started/stopped → open/close a charging session; bridge short gaps in
  the charging signal so one charge isn't fragmented into several sessions.
- Vehicle left parked state → after a **~3-minute debounce** (noise guard), open a
  trip; parked again → close it. Discard trips under ~2 km or with negative
  energy (SOC rose ⇒ it was actually charging).
- On the event-less web path, reconstruct activity from state deltas: odometer
  increase ⇒ trip; SOC rise while odometer flat ⇒ charging.
- Optional SOC-delta charging heuristic with a configurable minimum-% threshold
  (filters regenerative-braking noise).
- After a restart, reconcile any orphaned open trips/sessions against current
  status so detection isn't permanently stuck.
- A failing event handler must never crash the poll loop.

## Non-functional expectations

- Self-hosted, easy single-container deployment; persistent local data store with
  migrations applied automatically on boot; data lives in a mounted volume so a
  file-level copy is a backup.
- Server API validates all writes, strips client-supplied identity/source fields,
  and paginates list endpoints.
- Works fine offline from VW's side: the UI always renders from stored data.

## Explicitly out of scope

Multi-vehicle, multi-user, app-level authentication, in-app backup/export,
MFA-protected VW accounts, mid-trip GPS tracking (VW doesn't expose it).
