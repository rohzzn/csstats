# CS Stats — Privacy Policy

**Last updated:** October 27, 2026

## Overview

CS Stats shows public Counter-Strike 2 stats where you look players up: on Steam Community profiles and friends lists, and in FACEIT match rooms. It needs no account, runs no advertising or analytics, does not sell data and does not track your browsing.

## Where it runs

- Steam Community profile and friends pages (`steamcommunity.com/id/…` and `steamcommunity.com/profiles/…`)
- FACEIT match rooms (`www.faceit.com/…/cs2/room/…`)

It reads nothing from any other page.

## What it reads and sends

To look players up, the extension reads public Steam64 IDs:

- the profile you are viewing,
- the friends shown on a Steam friends list,
- the ten players in a FACEIT match room (taken from FACEIT's API, using the room's match ID).

On your own profile, it also loads your Steam friends page from steamcommunity.com, the way your browser normally would, to get your friends' Steam IDs.

These IDs (and, for FACEIT, the match ID and FACEIT player IDs) are sent only to these services:

| Service | Used for |
|---|---|
| Steam Web API (`api.steampowered.com`) | Account creation date, VAC and game bans |
| FACEIT (`open.faceit.com`, `www.faceit.com`) | FACEIT level, ELO and stats, ELO history for the peak, and match room teams |
| Leetify public API (`api-public.cs-prod.leetify.com`) | Premier rating, performance stats, ranks and recent matches |
| Allstar (`a1.allstar.gg`) | The player's CS2 clips |
| CS Stats server (`csstats.rohan.my`) | CS level, commendations and medals from Valve's CS2 Game Coordinator; Leetify data for players its public API doesn't cover; trust scores from csrep.gg |

The CS Stats server passes a Steam64 ID on to Valve's Game Coordinator, Leetify or csrep.gg only to answer that lookup.

## What is stored

**In your browser**

- Two display preferences (peak or current Premier rating and FACEIT ELO), in Chrome's synced extension storage.
- The Steam ID you are signed in to Steam Community with, in local extension storage on this device only, so a FACEIT match preview can mark your team. It is never sent anywhere.
- Whether you collapsed a match preview, per match, in that FACEIT tab's session storage until the tab is closed.
- Lookup results, in memory for up to ten minutes.

**On the CS Stats server**

- Game Coordinator profile data, keyed by public Steam64 ID: fresh for five minutes and kept as a fallback for up to 30 days.
- Other provider responses: no longer than 24 hours. Trust data from csrep.gg is refreshed after 12 hours and deleted after 24 hours.
- A monthly count of trust lookups (a number only, no IDs).
- IP addresses are used in memory for one-minute rate limiting and are not stored. Error logs kept in memory may include a Steam64 ID when a lookup fails.

The server does not build user profiles or link requests to a Chrome or Google account. Cloudflare provides HTTPS for the CS Stats server and may process connection data such as IP addresses under its own privacy policy.

## Sharing

Steam64 IDs go only to the services above, only to show the stats you are looking at. CS Stats does not sell data, use it for advertising or creditworthiness, or transfer it for anything unrelated to showing stats.

## Security

All of the extension's code ships in its package; it runs no remotely hosted code. The trust-score API key is held only on the CS Stats server.

## Contact

For privacy questions, contact work@rohzzn.me.
