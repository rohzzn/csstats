# CS Stats

A Chrome extension that shows CS2 player stats directly on Steam profiles — no tab switching, no searching. Everything is drawn in Steam's own showcase style, so it reads like part of the profile.

## What it shows

Every Steam profile gets a **Stats** showcase, a **Matches** showcase (when Leetify has recent matches), a **Clips** showcase (when the player has clips) and CS2 medals in the profile header.

### Stats showcase (top → bottom)

| Row | Shows | Source |
|---|---|---|
| **Steam** | Premier season medals (newest season first, missing seasons skipped) · commendations (Friendly / Teacher / Leader) · **Verdict** tag · **Played with banned** (recent matches that had a player who was later banned, e.g. `1 / 100`) | GC server · Leetify · Steam Web API · derived |
| **Performance** | A ratings column (Premier rating · FACEIT level + peak or current ELO) beside a column-aligned grid: Aim · K/D · Win Rate · Last 5 over Time to Damage · Utility · Total Matches · Account Age | Leetify · FACEIT · Steam Web API |
| **Per-map ranks** | Wingman rank + competitive rank for each map | Leetify (Wingman from the GC server when available) |

- Metrics without data are left out. Without a Leetify profile, the FACEIT level, ELO, K/D and HS% take the Leetify stats' place. On narrow screens the ratings sit above a two-column grid.
- **Premier** is colour-coded to match the in-game tier (grey → light blue → blue → purple → pink → red → gold). Click the badge to switch between current and peak rating; hover it to see the other value.
- **FACEIT ELO** shows the peak by default, and the level badge matches the ELO on display. Click it to switch to the current ELO; hover it to see which one is showing. The peak comes from FACEIT's match history (up to the last 1,000 games); if that history can't be loaded, only the current ELO is shown.
- **Total Matches** counts everything: Premier, Competitive, Wingman and FACEIT. If Leetify doesn't import the player's FACEIT games, FACEIT lifetime matches are added to Leetify's total; if it does, the larger of the two counts is shown so nothing is counted twice. Hover for the breakdown.
- **Account Age** comes from the Steam account creation date (hidden when the profile is private).
- **Matches** always shows the past **10** matches: map, mode, score and K-D. The coloured edge and score show the result (green win, red loss, grey draw).
- **Clips** shows the player's 8 best-rated Allstar clips (Allstar's own "Best" ranking). Click one to watch it in a large player: full screen with the button or **F**, switch clips with the arrows or **← →**, close with **Esc**.
- **Header medals** (CS2 coins, pins, service medals and trophies) sit next to the persona name and page with arrows when they don't all fit. Premier season medals are shown in the Steam row instead, not here.

### Cheating verdict

The verdict tag in the Steam row is a quick read on whether the player might be cheating. Hover it to see the reasons.

1. **Bans first.** A Steam VAC ban shows **VAC Banned**, a game ban shows **Game Banned**, and a ban recorded by Leetify shows **Banned**.
2. **Otherwise, public stats are scored** (needs at least 10 Leetify matches). Points are added for unusually fast time to damage, very low preaim (crosshair placement), very high headshot accuracy, a near-perfect aim rating and very high accuracy on spotted enemies. A young account or a low match count adds a little more, but only when the mechanical signals already look unusual. Points are taken off for FACEIT level 9+ or 2,000+ ELO (FACEIT runs its own anti-cheat), 1,500+ matches and accounts older than 8 years.
3. **Result:** a score of 6 or more is **Likely Cheating**, 3 to 5 is **Suspicious**, anything lower is **Legit**. When there is no usable data the verdict shows **No Data** with the reason (for example a private or rate-limited Leetify profile). If Steam's ban check can't be reached, the verdict never says **Legit**.

The thresholds were checked against real profiles, and professional players (s1mple, FalleN, huNter-) come out **Legit**. Still, it is an **estimate from public stats, not proof**: good players can look suspicious and careful cheaters can look clean. Don't report or harass anyone on the strength of the verdict alone.

### Settings

The toolbar popup has two settings, **Premier rating** and **FACEIT ELO**, each **Current | Peak**. Clicking the Premier badge or the FACEIT ELO on any profile changes the same settings. The popup also opens as the extension's options page.

## Install

### From the Chrome Web Store
Search for **CS Stats** or install directly from the [store listing](https://chromewebstore.google.com/detail/cs-stats/fdnhgmlohooaabloinhbgmkhpebckapp).

### In Steam's in-game browser
Steam's overlay browser (Shift+Tab in CS2) can install Chrome Web Store extensions, but only from inside the overlay: `steam://openurl` links from outside Steam open in the system browser instead. So the install page at **[csstats.rohan.my](https://csstats.rohan.my)** is made to be typed into the overlay:

1. In CS2, press **Shift+Tab**, open the **web browser** and go to `csstats.rohan.my`.
2. Click **Add to Steam**. The store opens in a new window; click **Add to Chrome**, then **Add extension**.
3. The page switches to **installed and on** by itself (1.2.1+), and every profile opened in the overlay shows the stats.

The page is `site/` (static files). On the Mac it is served from `~/srv/csstats-site/public` by Caddy on `127.0.0.1:8095` (launchd agent `my.rohan.csstats.site`), and the `csstats` Cloudflare tunnel routes every `csstats.rohan.my` path except the API to it. To update it, copy `site/*` to `~/srv/csstats-site/public/`.

### Load unpacked (development)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Steam stats server

CS level, commendations, Premier season medals and header medals come from a small server that connects to the CS2 Game Coordinator using a spare Steam account. The extension calls the public instance at `https://csstats.rohan.my` (only `/profile/<steam64>` is exposed, through a Cloudflare Tunnel), and falls back to a self-hosted server on this computer at `http://127.0.0.1:3000`.

To self-host your own copy, follow the steps below.

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

The Compose service is named `steam-stats`. It restarts automatically if the process crashes, saves Steam session data and profile cache in a Docker volume, and only exposes the API to this computer.

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

The extension points at the local GC proxy. If that proxy is unavailable, the CS level, commendations and medals are simply left out while everything else keeps working.

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

## Releasing

```bash
python tools/build-zip.py
```

This validates the manifest, assets and syntax, then writes `dist/cs-stats-<version>.zip` with only the files the extension loads. Store images and the listing text live in `store/` (`store/listing.md`).

## Data sources

- **Leetify public API** (`api-public.cs-prod.leetify.com/v3`, no key needed): Premier, Wingman and per-map competitive ranks, Aim and Utility ratings, time to damage, preaim and accuracy stats, win rate, total matches, recent matches and per-match K/D.
- **FACEIT Data API** (API key bundled): level, ELO, lifetime matches, K/D and HS%. Shown alongside the Leetify row. Peak ELO comes from FACEIT's public match-history feed on faceit.com.
- **Steam Web API** (API key bundled): account creation date and VAC / game ban status.
- **Allstar**: the player's best-rated CS2 clips.
- **CS2 Game Coordinator** (optional, via the local server above): CS level, commendations and medals, queried directly from Valve's servers.

CSStats (csstats.gg) is no longer used.

## Privacy

The extension reads the Steam64 ID from the profile page you are already viewing. That ID is used to look up stats from the services listed above. Responses are cached in memory for a few minutes; nothing is stored or transmitted anywhere other than those services. The only thing saved is your Premier rating preference (Chrome sync storage). GC lookups are sent to the local proxy server running on this computer.
