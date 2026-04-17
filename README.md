# CS2 Recon

A Chrome extension that shows CS2 player stats directly on Steam profiles — no tab switching, no searching.

## What it shows

Every Steam profile gets an inline **Stats** panel with data from multiple sources:

| Row | Source | Data |
|---|---|---|
| **Steam** | Steam Web API | Wins · K/D · HS% · Hours · Account age · Friend code · VAC/Game ban |
| **CS2** ⭐ | Game Coordinator (local server) | Premier CS Rating · Premier wins · Competitive ranks · Wingman rank — **works on every profile** |
| **Leetify** | Leetify profile feed | Premier (coloured by tier, peak on hover) · FACEIT ELO · Aim · K/D · Win Rate · Competitive rank images |
| **CSStats** | csstats.gg | Premier (coloured by tier) · Peak Premier · Wins |

- **Steam row always appears** — account info (age, friend code) and CS2 stats (wins, K/D, HS%) are shown whenever available from the Steam API. No sign-up required.
- **CS2 row (Game Coordinator)** shows real-time Premier CS Rating for literally any Steam account, even private profiles, by querying Valve's game servers directly. Requires the local server (see below).
- VAC bans and game bans are highlighted in red/orange on the Steam row.
- Premier CS Rating is colour-coded to match the in-game tier (grey → light blue → blue → purple → pink → red → gold).
- Competitive rank images are shown per map.

## Install

### From the Chrome Web Store
Search for **CS2 Recon** or install directly from the store listing.

### Load unpacked (development)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Game Coordinator server (optional — unlocks stats on every profile)

The **CS2 row** requires a small Node.js server. It can run on your machine or on a host like Railway. It connects to the CS2 Game Coordinator using a spare Steam account and exposes an HTTP API the extension calls.

### Prerequisites

- [Node.js 18+](https://nodejs.org/)
- A **spare / dedicated Steam account** (create a free one) that owns CS2 (free to play). It must **not** be running CS2 anywhere else while the server is active.

### Setup

```bash
# 1. Install dependencies
cd server
npm install

# 2. Create your config file
copy .env.example .env
# Edit .env and set STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD

# 3. Start the server
npm start
```

For Railway:

- Set the service root to `server/`
- Set `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`, and optionally `STEAM_BOT_SHARED_SECRET` as Railway environment variables
- For the most reliable reconnects, also set `STEAM_BOT_REFRESH_TOKEN` once you have one
- Do not hardcode Railway's assigned `PORT`; Railway injects it automatically
- Keep `HOST=0.0.0.0` so Railway can reach the process
- Point Railway's health check at `/readyz` if you want the platform to treat a lost GC session as unhealthy

On first run, Steam may prompt for a Steam Guard code sent to your email. Enter it in the terminal. After that the server remembers the session.

If the bot account has a **Mobile Authenticator**, set `STEAM_BOT_SHARED_SECRET` in `.env` and the server will generate TOTP codes automatically (requires `npm install steam-totp`).

### How it works

```
Extension                  Local server (port 3000)        Valve Game Coordinator
   │  GET /profile/765…        │                                    │
   │ ─────────────────────────▶│  requestPlayersProfile(steamId)   │
   │                           │ ──────────────────────────────────▶│
   │                           │ ◀─────────────── profile data ─────│
   │ ◀── { premier_rating, … } │                                    │
```

The server keeps a persistent GC session and processes one request at a time with a 500 ms throttle to respect Valve's rate limits. Responses are cached for 5 minutes.

If Steam or the GC drops, the server now tries to recover automatically by restoring the Steam session, reasserting `gamesPlayed(730)`, waiting briefly for GC recovery on live requests, and on Railway optionally exiting after a long unhealthy period so the platform can restart it.

The extension points at the hosted GC proxy. If that proxy is unavailable, the CS2 row is silently hidden while the other rows keep working.

You can verify the server quickly with:

- `/`
- `/healthz`
- `/readyz`
- `/status`

### Running on startup (optional)

On Windows, create a shortcut to `start_server.bat`:

```bat
@echo off
cd /d "%~dp0server"
node server.js
```

Or use [PM2](https://pm2.keymetrics.io/) for automatic restarts:

```bash
npm install -g pm2
pm2 start server/server.js --name cs2-recon
pm2 save && pm2 startup
```

---

## Data sources

- **Steam Web API** — account age, friend code, wins, K/D, HS%, hours, ban info (API key required, bundled). Works on every public Steam profile.
- **CS2 Game Coordinator** — Premier CS Rating, rank, wins queried directly from Valve's servers. Works on every Steam account. Requires the GC proxy server above.
- **FACEIT** — ELO and level icon (API key required, bundled). Merged into the Leetify row when the player has a FACEIT account.
- **Leetify** — CS Rating, skill ratings, and ranks from Leetify's live profile data
- **CSStats** — CS Rating, wins (public page fetch, no key needed; requires login on csstats.gg for some profiles)

## Privacy

The extension reads the Steam64 ID from the profile page you are already viewing. That ID is used to look up stats from the services listed above. No data is stored or transmitted anywhere other than those services. GC lookups are sent to your configured proxy server, which may be a hosted deployment such as Railway.
