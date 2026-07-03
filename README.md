# VW ID.7 EV Tracker

Self-hosted, single-user web app that tracks a VW ID.7 (or other WeConnect ID
car) by polling Volkswagen's connected-car backend: live status, automatically
detected trips and charging sessions, manual entries, and statistics.

Built per [`GOAL.md`](GOAL.md). The hard-won VW protocol knowledge lives in
[`docs/vw-auth-migration.md`](docs/vw-auth-migration.md) — read it before
touching the login code.

## Features

- **Dashboard** — lifetime totals, consumption trend, recent activity.
- **Trips** — auto-detected from telemetry (3-min debounce, <2 km noise
  filter), plus manual add/edit/delete and an optional route map.
- **Charging** — auto-detected sessions with gap bridging, energy/cost math,
  manual CRUD.
- **Vehicle** — live battery gauge with target SOC, range, odometer,
  charging/plug/climate/lock badges, parked-position map, Sync Now.
- **Settings** — VW credentials (password write-only), VIN auto-detect, poll
  interval, battery capacity, electricity price, detection toggles.

## Data sources

1. **Primary — WeConnect app API** (`emea.bff.cariad.digital`): full status.
   Login impersonates the VW app: Auth0 Universal Login + PKCE code flow +
   BFF token exchange (see the auth doc's addendum).
2. **Fallback — myvolkswagen.net portal**: survives app-client breakage;
   provides range, odometer and a charging signal. Switches in automatically
   when the primary fails and steps back on recovery. Every record is tagged
   with its source; detection never mixes sources.

No MFA support — the VW account must be password-only.

## Run with Docker

```bash
docker build -t ev-tracker .
docker run -d --name ev-tracker -p 3000:3000 -v ev_data:/app/data ev-tracker
```

Open http://localhost:3000, enter your VW credentials under **Settings**, hit
**Connect & Sync**. The poll loop starts automatically (default every 5 min).

The SQLite database and the web-portal session file live in `/app/data` — a
file-level copy of that volume is a complete backup.

## Development

```bash
npm install
npm run dev -w server        # API + poller on :3000 (tsx watch)
npm run dev -w web           # Vite dev server on :5173, proxies /api
npm test                     # server + web test suites
npm run build                # web dist + server dist
VW_USER=me@x.com VW_PASS=… npm run smoke:vw -w server   # live VW login smoke test
```

- `server/src/vw/api` — WeConnect client (ported, live-verified 2026-06)
- `server/src/vw/web` — myvolkswagen.net fallback
- `server/src/poller` — poll loop + trip/charge detection engine
- `server/src/http` — Fastify REST API (also serves `web/dist`)
- `web/` — Vite + React UI

There is no app-level login: deploy it only on a trusted network.
