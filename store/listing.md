# Chrome Web Store listing — CS Stats 1.2.0

Package: `dist/cs-stats-1.2.0.zip` (build with `python tools/build-zip.py`)

## Store images (all 24-bit PNG, no alpha)

| File | Size | Use |
|---|---|---|
| `screenshot-01-stats.png` | 1280×800 | Screenshot 1 |
| `screenshot-02-verdict.png` | 1280×800 | Screenshot 2 |
| `screenshot-03-matches.png` | 1280×800 | Screenshot 3 |
| `screenshot-04-clips-medals.png` | 1280×800 | Screenshot 4 |
| `screenshot-05-themes.png` | 1280×800 | Screenshot 5 |
| `promo-small-440x280.png` | 440×280 | Small promo tile |
| `marquee-1400x560.png` | 1400×560 | Marquee promo tile |

## Summary (132 characters max)

CS2 stats on every Steam profile: Premier & FACEIT ratings, Leetify stats, a cheating verdict, recent matches, medals and clips.

## Description

CS Stats puts a player's CS2 stats right on their Steam profile, drawn in Steam's own showcase style so it looks like part of the page.

**Stats showcase**
• Commendations and Premier season medals (newest season first)
• A cheating verdict (Legit, Suspicious, Likely Cheating, VAC Banned) with the reasons on hover
• How many recent matches had a player who was later banned
• Premier rating and FACEIT ELO, peak or current with one click
• Aim, K/D, win rate and last 5 results
• Time to damage, utility, total matches (Premier, Competitive, Wingman and FACEIT) and account age
• Wingman and per-map competitive ranks

**Matches**: the last 10 games with map, mode, score and K-D.
**Clips**: the player's Allstar highlights, playable in place.
**Medals**: CS2 coins, pins and service medals beside the player's name.

Works with every Steam profile theme and screen size.

The verdict is an estimate from public stats, not proof. Please don't harass or report anyone based on it alone.

## What's new in 1.2.0

• Redesigned Stats panel: everything lines up on one grid, with no overlaps at any screen size
• New: cheating verdict, "played with banned players", time to damage, utility, total matches and account age
• New: FACEIT peak ELO (click to see current), Premier season medals in the Stats row
• Matches now show map names and the last 10 games; clips are always shown
• Sharper, evenly spaced medals, now including Premier Season Five and Cologne 2026 items
• Leetify data moved to Leetify's public API, so Leetify stats and matches load again
• Package is much smaller (about 23 MB, down from 140+ MB)

## Category / language

Category: Tools (or Fun). Language: English.

## Single purpose

Shows Counter-Strike 2 statistics for the player whose Steam Community profile you are viewing, directly on that profile page.

## Permission justifications

- **storage**: saves two display preferences (Premier and FACEIT ELO: peak or current).
- **https://steamcommunity.com/\***: the content script runs on Steam Community profile pages to show the stats.
- **https://api.steampowered.com/\***: Steam Web API for account creation date and VAC / game ban status.
- **https://api-public.cs-prod.leetify.com/\***: Leetify public API for ratings, ranks and recent matches.
- **https://open.faceit.com/\***: FACEIT Data API for level, ELO and lifetime stats.
- **https://www.faceit.com/\***: FACEIT match history, used to find the peak ELO.
- **https://a1.allstar.gg/\***: Allstar API for the player's CS2 clips.
- **http://127.0.0.1/\***, **http://localhost/\***: optional local Game Coordinator server run by the user (CS level, commendations, medals).
- **Remote code**: none. All code ships in the package.

## Data usage (privacy practices tab)

- The extension reads the Steam64 ID of the profile page being viewed and sends it to the services above to look up that player's public stats.
- It does not collect, store or transmit personal data about the person using the extension. Only the two display preferences are saved, in Chrome sync storage.
- No data is sold, used for advertising, or used for creditworthiness.
