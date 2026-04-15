# CS2 Recon

A Chrome extension that shows CS2 player stats directly on Steam profiles — no tab switching, no searching.

## What it shows

Every Steam profile gets an inline **Stats** panel with data from multiple sources:

| Row | Source | Data |
|---|---|---|
| **Steam** | Steam Web API | Account age · Friend code · Commendations |
| **FACEIT** | FACEIT API | Rank icon · ELO · Matches · K/D · Account age · Friend code |
| **Leetify** | Leetify API | Premier (coloured by tier) · Peak Premier · Aim · Positioning · Utility · Reaction time · Competitive & wingman rank images |
| **CSStats** | csstats.gg | Premier (coloured by tier) · Peak Premier · Wins |

- Premier CS Rating is colour-coded to match the in-game tier (grey → light blue → blue → purple → pink → red → gold).
- Competitive and wingman rank images are shown per map.
- All data loads silently in the background — nothing is shown if a profile has no stats.

## Install

### From the Chrome Web Store
Search for **CS2 Recon** or install directly from the store listing.

### Load unpacked (development)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Data sources

- **Steam Web API** — account age, commendations (API key required, bundled)
- **FACEIT** — rank, ELO, match stats (API key required, bundled)
- **Leetify** — CS Rating, skill ratings, ranks (public API, works for registered Leetify users)
- **CSStats** — CS Rating, wins (public page fetch, no key needed)

## Privacy

The extension reads the Steam64 ID from the profile page you are already viewing. That ID is used to look up stats from the services listed above. No data is stored or transmitted anywhere other than those services.
