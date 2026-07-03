# VW ID.7 EV Tracker Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-hosted single-user VW ID.7 EV tracker defined in `GOAL.md` from scratch: automatic polling of VW's backend, trip/charging detection, and a five-screen web UI.

**Architecture:** A single Node.js process serves a REST API (Fastify) and the static frontend build (Vite + React), runs the poll loop + detection engine in-process, and persists to SQLite (better-sqlite3) with a tiny built-in migration runner. The VW protocol layer is **ported, not reinvented** from the live-verified original at `/Users/celly/q_projects/wv/src/lib/vw/` (external constraint per GOAL.md).

**Tech Stack:** Node 20+, TypeScript, Fastify 4, better-sqlite3, zod, Vitest; frontend: Vite, React 18, react-router, Leaflet (OSM tiles), Recharts. Single multi-stage Dockerfile.

## Global Constraints

- Metric units everywhere: km, kWh, kW, %, EUR. Battery capacity default **77 kWh**, configurable.
- Timestamps stored as **UTC ISO-8601 strings**; client converts local↔UTC.
- Display: `en-GB` dates, durations `Hh Mmin`, energy/consumption 2 decimals, distance 1 decimal.
- Derived metrics (server-side, only fill gaps — manual values always win):
  - distance = endOdometer − startOdometer
  - tripEnergy = (startSoc − endSoc)/100 × batteryCapacityKwh
  - chargedEnergy = (endSoc − startSoc)/100 × batteryCapacityKwh
  - consumption = energy/distance × 100 (kWh/100km)
- SOC bounded 0–100; server validates ALL writes; server strips client-supplied `id`/`source` fields; list endpoints paginated (`?limit=&offset=`, default limit 50, max 200).
- Detection rules: trip-start debounce **~3 min**; discard trips **< 2 km** or with negative energy; bridge short charging-signal gaps (one gap ≤ 2 polls); web-path reconstruction from odometer/SOC deltas; orphan reconciliation on boot; a failing event handler must never crash the poll loop.
- Poll interval 1–60 min, default 5. Poll loop starts on boot; no external cron.
- No app-level auth. Single vehicle, single user.
- VW protocol: preserve `docs/vw-auth-migration.md`; port code from `wv/src/lib/vw/` **as-is in behavior** (constants, header quirks, cookie handling). Current truth = code flow + PKCE + BFF exchange with `x-qmauth` (the doc's hybrid-fragment section is superseded — Task 0 appends an addendum saying so).
- Data dir `./data` (Docker volume): SQLite DB `data/tracker.db`, web session `data/myvw-session.json`.

## File Structure

```
package.json            # workspaces: server/, web/
server/
  src/
    db/{connection.ts, migrate.ts, migrations/001-init.sql}
    repo/{snapshots.ts, trips.ts, charging.ts, settings.ts, positions.ts}
    domain/{metrics.ts, validate.ts, types.ts}
    vw/api/{crypto.ts, cookies.ts, auth.ts, client.ts, extract.ts, types.ts}
    vw/web/{session.ts, fetch-status.ts, extract.ts}
    vw/source.ts        # primary/fallback orchestration state machine
    poller/{poller.ts, detection.ts, reconcile.ts}
    http/{server.ts, routes/{status.ts, trips.ts, charging.ts, stats.ts, settings.ts, sync.ts}}
    index.ts            # boot: migrate → reconcile → start poller → listen
  test/ (mirrors src/)
web/
  src/{main.tsx, App.tsx, api.ts, format.ts,
       pages/{Dashboard.tsx, Trips.tsx, Charging.tsx, Vehicle.tsx, Settings.tsx},
       components/{Layout.tsx, StatCard.tsx, BatteryGauge.tsx, MapView.tsx, TrendChart.tsx, EntityModal.tsx}}
Dockerfile
README.md
```

---

### Task 0: Repo bootstrap + preserved docs
**Files:** Create `package.json`, `server/package.json`, `web/` (vite scaffold), `server/tsconfig.json`, `.gitignore`, `README.md` stub; append addendum to `docs/vw-auth-migration.md`.
- [x] Copy `docs/vw-auth-migration.md` + web-fallback spec from wv (DONE 2026-07-03)
- [x] Append addendum to `docs/vw-auth-migration.md`: "2026-06 update — implicit grant disabled; use `response_type=code` + PKCE, exchange at `POST {BFF}/auth/v1/idk/oidc/token` with headers `x-qmauth` (HMAC scheme, see crypto.ts), `x-android-package-name: com.volkswagen.weconnect`, `x-platform: android`, `x-assertion: 0`, VW app UA, and body echoing `response_type=token id_token` (omitting it 502s). Refresh token IS returned; use `grant_type=refresh_token` (same header/echo quirks) before falling back to full re-login."
- [x] npm workspaces root; `server`: typescript, fastify, better-sqlite3, zod, vitest, tsx; `web`: vite react-ts template + react-router-dom, recharts, leaflet, react-leaflet
- [x] `git add -A && git commit -m "chore: bootstrap workspaces, preserve VW protocol docs"` (first commit — include GOAL.md, run-goal.sh)

### Task 1: SQLite layer + migrations
**Files:** `server/src/db/connection.ts`, `migrate.ts`, `migrations/001-init.sql`; tests `server/test/db/migrate.test.ts`.
**Produces:** `getDb(path?): Database` (singleton, WAL mode), `runMigrations(db): void` (idempotent, tracks in `_migrations` table).
Schema (001-init.sql):
```sql
CREATE TABLE vehicle_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  soc REAL, range_km REAL, odometer_km REAL,
  is_parked INTEGER, is_charging INTEGER, is_plugged INTEGER,
  charging_state TEXT, external_power TEXT, target_soc REAL,
  lat REAL, lon REAL, raw TEXT, source TEXT NOT NULL DEFAULT 'api');
CREATE TABLE trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts TEXT NOT NULL, end_ts TEXT,
  start_odometer REAL, end_odometer REAL, start_soc REAL, end_soc REAL,
  distance_km REAL, energy_kwh REAL, consumption REAL, duration_min REAL,
  notes TEXT, source TEXT NOT NULL DEFAULT 'auto');
CREATE TABLE charging_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts TEXT NOT NULL, end_ts TEXT,
  start_soc REAL, end_soc REAL, energy_kwh REAL, cost REAL, price_per_kwh REAL,
  max_power_kw REAL, charger_type TEXT CHECK(charger_type IN ('home','ac','dc')),
  location TEXT, lat REAL, lon REAL, notes TEXT, source TEXT NOT NULL DEFAULT 'auto');
CREATE TABLE trip_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ts TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX idx_status_ts ON vehicle_status(ts);
```
- [x] TDD: failing test (migrations run twice → no error, tables exist) → implement → pass → commit

### Task 2: Repositories + domain metrics
**Files:** `server/src/repo/*.ts`, `server/src/domain/{metrics.ts,types.ts}`; tests for each.
**Produces:** typed CRUD per entity — `insertSnapshot(s)`, `latestSnapshot()`, `latestSnapshotBySource(src)`, `listTrips({limit,offset})`, `createTrip/updateTrip/deleteTrip`, `openTrip()/closeTrip()`, same for charging; `getSetting(key)/setSetting(key,value)/getSettings()`; `finalizeTrip(trip, caps): Trip` and `finalizeCharge(sess, caps)` in metrics.ts applying the Global Constraints formulas (manual wins, computed fills gaps, round energy/consumption 2dp, distance 1dp).
- [x] TDD each metric rule incl. edge cases (missing SOC → null energy; zero distance → null consumption; manual override preserved) → commit

### Task 3: VW primary client (port from wv)
**Files:** `server/src/vw/api/{crypto,cookies,auth,client,extract,types}.ts`; tests `crypto.test.ts` (port), `extract.test.ts` (fixtures from wv `events.test.ts` where applicable).
**Port faithfully from `/Users/celly/q_projects/wv/src/lib/vw/api/`** — constants (`VW_CLIENT_ID a24fba63-…`, `weconnect://authenticated`, scope, `VW_RESPONSE_TYPE="code"`, hosts), `qmauthNow()` HMAC, cookie jar + manual-redirect walker, Auth0 `/u/login` scrape (browser UA!), resume chain, code exchange + refresh at `/auth/v1/idk/oidc/token` (VW app UA + qmauth headers + response_type echo). Adapt only: token/credential persistence → `settings` repo (keys `vw_tokens`, `vw_username`, `vw_password`); fail-loudly HTML dumps → logger.
**Produces:** `VwClient` with `connect()`, `ensureToken()` (refresh→relogin ladder on expiry/401), `listVehicles(): vin[]`, `fetchStatus(vin): RawSelectiveStatus`, `fetchParkingPosition(vin)`; `extractSnapshot(raw, parking): SnapshotInsert` (pure, fixture-tested).
- [x] Port + adapt, TDD extract/crypto (network code covered by types + a manual smoke script `server/scripts/smoke-vw.ts`) → commit

### Task 4: VW web fallback (port from wv)
**Files:** `server/src/vw/web/{session,fetch-status,extract}.ts`; test `extract.test.ts`.
Port from `wv/src/lib/vw/web/` per `docs/superpowers/specs/2026-06-03-myvw-web-data-source-design.md`: authproxy login chain (separate cookie jars per domain), session persistence to `data/myvw-session.json`, data GETs with `x-csrf-token` + `content-type: application/json;version=1` + `user-id: __userId__`.
**Produces:** `fetchWebStatus(username, password, vin): Promise<WebStatus|null>` (never throws) where `WebStatus={rangeKm,odometerKm,capturedAt,raw}`.
- [x] Port, TDD extract with fixtures → commit

### Task 5: Source orchestration + poller
**Files:** `server/src/vw/source.ts`, `server/src/poller/poller.ts`; tests with injected fakes.
**Produces:** `VehicleSource.poll(): Snapshot|null` — try primary; on primary auth/network failure switch to web fallback (insert range+odometer rows, `source='web'`, SOC/parking null, dedup on capturedAt); every fallback tick retries primary first and steps back on recovery. `Poller.start(intervalMin)/stop()/syncNow()` — overlap guard, reads interval from settings, restartable when settings change; each successful snapshot is passed to detection (Task 6 interface: `onSnapshot(prev, next)`); handler errors caught + logged, never crash the loop.
- [ ] TDD state machine (primary-ok, primary-fail→web, web→recovery, dedup) → commit

### Task 6: Detection engine (the heart)
**Files:** `server/src/poller/detection.ts`, `reconcile.ts`; extensive tests.
**Produces:** `Detector.onSnapshot(prev: Snapshot|null, next: Snapshot)` implementing:
- charging start (`is_charging` false→true): open session (start_ts, start_soc); stop: close + finalize; **gap bridging**: if charging resumes within 2 polls of stopping, reopen/merge instead of new session.
- trip: parked→moving starts a **pending** trip; confirm only after moving persists ≥3 min (debounce); moving→parked closes it; finalize; **discard** distance <2 km or energy <0 (SOC rose ⇒ was charging).
- positions: record parked coordinates at trip start/end when position tracking enabled.
- web-source rows: no flags available → delta reconstruction: odometer increased ⇒ synthesize closed trip; SOC rose while odometer flat ⇒ synthesize charging session. Never mix: only compare snapshots of the same source for delta logic.
- SOC-delta heuristic (toggle + threshold setting): SOC rise ≥ threshold while parked and not flagged charging ⇒ charging session.
- `reconcileOnBoot()`: close/discard orphaned open trips/sessions against latest snapshot.
- [ ] TDD every rule above as its own test case before implementing → commit per rule-group

### Task 7: HTTP API
**Files:** `server/src/http/server.ts` + `routes/*`; tests via `fastify.inject`.
Endpoints (JSON): `GET /api/status` (latest snapshot + connection state + poller state), `POST /api/sync` (syncNow), `GET/POST /api/trips`, `PATCH/DELETE /api/trips/:id`, same for `/api/charging`, `GET /api/stats` (totals: distance, avg consumption, energy charged, cost, counts + last-20-trips consumption series), `GET /api/settings` (password masked as `"•••"` when set, never returned), `PUT /api/settings` (password only updated when non-empty value sent; validates poll_interval 1–60, battery capacity >0, SOC threshold 1–50), `POST /api/connect` (connect & sync, returns {connected, vin, source}), `GET /api/trips/:id/positions`. zod validation on every write; strip `id`/`source` from client payloads; pagination per Global Constraints.
- [ ] TDD routes (validation rejects, pagination, password masking, source stripping) → commit per route group

### Task 8: Frontend scaffold + API layer
**Files:** `web/src/{main.tsx, App.tsx, api.ts, format.ts}`, `components/Layout.tsx`.
Layout: desktop fixed sidebar (Dashboard/Trips/Charging/Vehicle/Settings), mobile bottom tabs (CSS breakpoint 768px). `api.ts`: thin typed fetch wrapper. `format.ts`: en-GB date, `Hh Mmin`, 2dp/1dp rounding helpers (unit-tested with vitest).
- [ ] Scaffold, format tests, routing renders all 5 pages → commit

### Task 9: Dashboard page
StatCards (total km, avg kWh/100km, total kWh, total EUR, trips, sessions) from `/api/stats`; Recharts line chart of consumption trend; recent 5 trips/charges lists.
- [ ] Implement + commit

### Task 10: Trips page
Paginated list newest-first, add/edit/delete via `EntityModal` (local-time datetime inputs → UTC), optional Leaflet route map from `/api/trips/:id/positions`.
- [ ] Implement + commit

### Task 11: Charging page
Summary header (count, Σ kWh, Σ EUR) + list + CRUD modal (charger type select home/ac/dc, price auto-fills cost = energy × price when cost empty).
- [ ] Implement + commit

### Task 12: Vehicle live page
Auto-refresh `/api/status` every 30 s; Leaflet map of parked position; battery gauge (SOC + target-SOC marker); range/odometer; charging/plug/climate/lock badges; Sync Now button → `POST /api/sync`; stale-data banner showing snapshot age when VW unreachable.
- [ ] Implement + commit

### Task 13: Settings page
Form: VW email, password (write-only field, placeholder shows "set"), VIN, poll interval, battery capacity, price + currency, position toggle, SOC-delta toggle + threshold; Connect & Sync button; connection status indicator (source: api/web/disconnected).
- [ ] Implement + commit

### Task 14: Boot integration, Docker, README
`server/src/index.ts`: migrate → reconcileOnBoot → poller.start (if credentials configured) → serve `web/dist` static + SPA fallback → listen :3000. Multi-stage Dockerfile (build web+server → slim runtime, `VOLUME /app/data`). README: setup, docker run, architecture map.
- [ ] Full test suite green, `docker build` succeeds (or documented if docker unavailable locally), commit

### Task 15: End-to-end verification
- [ ] `npm test` all green; `npm run build` both workspaces; boot server against empty data dir; drive UI (verify skill): add manual trip + charge, check stats, settings round-trip, sync-now error path without credentials → fix anything found → final commit

## Self-Review Notes
- Spec coverage checked against GOAL.md sections: domain model→T1/2, VW primary→T3, fallback→T4, polling→T5, detection rules→T6, API/validation→T7, five screens→T8–13, non-functional (container, migrations-on-boot, offline-friendly UI)→T14. Trips route map optional→T10. No-login constraint: no auth anywhere.
- Types: `Snapshot`/`SnapshotInsert` defined in `domain/types.ts`, consumed by repo/vw/detection; `finalizeTrip/finalizeCharge` used by both detection (auto) and HTTP routes (manual writes).
