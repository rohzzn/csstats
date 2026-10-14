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

Is this CS2 player any good, or cheating? See Premier, FACEIT ELO, a cheat verdict and recent matches on every Steam profile.

## Description

The Web Store shows this as plain text. Paste it as-is: the line breaks and • bullets carry through.

```
Size up any Counter-Strike 2 player without leaving Steam.

CS Stats adds a Stats panel to every Steam profile, built in Steam's own style, so you can check a teammate, an opponent or a new friend request in seconds. No extra tabs, no searching, no sign-up.

IS THIS PLAYER CHEATING?
• A clear verdict: Legit, Suspicious, Likely Cheating, VAC Banned or Game Banned
• Hover to see why: time to damage, crosshair placement, headshot accuracy, aim rating, account age, FACEIT history and bans
• "Played with banned": how many of their last 100 matches had a player who was later banned

HOW GOOD ARE THEY?
• Premier rating in its in-game tier colour, peak or current with one click
• FACEIT level and ELO, peak or current with one click
• Aim rating, K/D, win rate and their last 5 results
• Time to damage, utility rating, account age and total matches across Premier, Competitive, Wingman and FACEIT
• Wingman rank and competitive rank for every map

WHAT HAVE THEY BEEN PLAYING?
• Their last 10 matches with map, mode, score and K-D, coloured by result
• Their best-rated Allstar clips: click one to watch it big or full screen, and flip through the rest

FEELS LIKE PART OF STEAM
• Matches every Steam profile theme and works at any window size
• Loads only on profile pages and caches results for a few minutes
• Two settings, peak or current for Premier and FACEIT, saved with your Chrome profile

POWER USERS
Run the free companion server (instructions on GitHub) to also show commendations, Premier season medals and CS2 coins and service medals, pulled live from the CS2 Game Coordinator.

PRIVACY
Stats come from Leetify, FACEIT, the Steam Web API and Allstar, looked up by the Steam ID of the profile you're viewing. Nothing about you is collected or sent anywhere.

A NOTE ON THE VERDICT
It's an estimate from public stats, not proof. Great players can look suspicious and careful cheaters can look clean, so please don't harass or report anyone based on the verdict alone.

CS Stats is not affiliated with Valve, Steam, Leetify, FACEIT or Allstar.
```

## What's new in 1.2.0

```
• Cheating verdict with reasons, plus "played with banned" for recent matches
• New stats: time to damage, utility, account age and total matches across all modes
• Peak or current FACEIT ELO, one click to switch (just like Premier)
• Redesigned Stats panel that lines up neatly at every screen size
• Last 10 matches now show map names
• Clips: the player's best-rated Allstar clips, in a big player with one-click full screen
• Leetify stats and matches load again (moved to Leetify's new public API)
• Much smaller download: about 23 MB, down from over 140 MB
```

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
