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

## Local Steam stats server

The **CS2 row** requires a small server on this Mac. It connects to the CS2 Game Coordinator using a spare Steam account and exposes a local HTTP API the extension calls at `http://127.0.0.1:3000`.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- A **spare / dedicated Steam account** (create a free one) that owns CS2 (free to play). It must **not** be running CS2 anywhere else while the server is active.

### Docker setup

```bash
# 1. Put your Steam bot login in server/.env
cp -n server/.env.example server/.env

# 2. Start the local service
docker compose up -d --build
```

The Compose service is named `steam-stats`. It restarts automatically if the process crashes, saves Steam session data and profile cache in a Docker volume, and only exposes the API to this Mac.

On first run, Steam may email a Steam Guard code. If that happens, put the one-time code in `server/.env` as `STEAM_BOT_GUARD_CODE=12345`, then run:

```bash
docker compose up -d --force-recreate
```

After a successful login, the server saves a refresh token in the Docker volume. You can remove `STEAM_BOT_GUARD_CODE` from `server/.env` after that.

If the bot account has a **Mobile Authenticator**, set `STEAM_BOT_SHARED_SECRET` in `server/.env` and the server will generate codes automatically.

### How it works

```
Extension                  Local server (port 3000)        Valve Game Coordinator
   │  GET /profile/765…        │                                    │
   │ ─────────────────────────▶│  requestPlayersProfile(steamId)   │
   │                           │ ──────────────────────────────────▶│
   │                           │ ◀─────────────── profile data ─────│
   │ ◀── { premier_rating, … } │                                    │
```

The server keeps a persistent GC session and processes one request at a time with a 500 ms throttle to respect Valve's rate limits. Fresh responses are cached for 5 minutes, and the server persists the last known GC results to disk so it can continue serving stale-but-useful data while GC reconnects.

If Steam or the GC drops, the server tries to recover automatically by restoring the Steam session, reasserting `gamesPlayed(730)`, waiting briefly for GC recovery on live requests, serving the last persisted GC result when the live session is unavailable, and exiting after a long unhealthy period so Docker can restart it cleanly.

The extension points at the local GC proxy. If that proxy is unavailable, the CS2 row is silently hidden while the other rows keep working.

You can verify the server quickly with:

- `/`
- `/healthz`
- `/readyz`
- `/status`

### Keeping it running

Use these commands from this folder:

```bash
docker compose ps
docker compose logs -f steam-stats
docker compose restart steam-stats
docker compose down
```

In Docker Desktop settings, enable **Start Docker Desktop when you log in**. With the Compose restart policy, the service will come back when Docker Desktop starts.

---

## Data sources

- **Steam Web API** — account age, friend code, wins, K/D, HS%, hours, ban info (API key required, bundled). Works on every public Steam profile.
- **CS2 Game Coordinator** — Premier CS Rating, rank, wins queried directly from Valve's servers. Works on every Steam account. Requires the GC proxy server above.
- **FACEIT** — ELO and level icon (API key required, bundled). Merged into the Leetify row when the player has a FACEIT account.
- **Leetify** — CS Rating, skill ratings, and ranks from Leetify's live profile data
- **CSStats** — CS Rating, wins (public page fetch, no key needed; requires login on csstats.gg for some profiles)

## Privacy

The extension reads the Steam64 ID from the profile page you are already viewing. That ID is used to look up stats from the services listed above. No data is stored or transmitted anywhere other than those services. GC lookups are sent to the local proxy server running on this Mac.
