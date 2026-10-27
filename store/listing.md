# Chrome Web Store listing — CS Stats 1.3.0

Package: `dist/cs-stats-1.3.0.zip` (build with `python tools/build-zip.py`)

## Store images (all 24-bit PNG, no alpha)

| File | Size | Use |
|---|---|---|
| `screenshot-01-stats.png` | 1280×800 | Screenshot 1: the Stats panel |
| `screenshot-02-trust.png` | 1280×800 | Screenshot 2: trust score and its breakdown |
| `screenshot-03-match-preview.png` | 1280×800 | Screenshot 3: FACEIT match preview |
| `screenshot-04-friends.png` | 1280×800 | Screenshot 4: friends list (friends' names and avatars blurred) |
| `screenshot-05-matches-clips.png` | 1280×800 | Screenshot 5: matches and clips |
| `promo-small-440x280.png` | 440×280 | Small promo tile |
| `marquee-1400x560.png` | 1400×560 | Marquee promo tile |

All in the install page's red and white style, from real renders of n0thing's profile and a real FACEIT match room.

## Summary (132 characters max)

Is this CS2 player any good, or cheating? Premier, FACEIT, a trust score and recent matches on Steam, plus FACEIT match previews.

## Description

The Web Store shows this as plain text. Paste it as-is: the line breaks and • bullets carry through.

```
Size up any Counter-Strike 2 player without leaving Steam.

CS Stats adds a Stats panel to every Steam profile, built in Steam's own style, so you can check a teammate, an opponent or a new friend request in seconds. No extra tabs, no searching, no sign-up.

IS THIS PLAYER CHEATING?
• A trust score from 0 to 100, or a clear verdict: Legit, Suspicious, Likely Cheating, VAC Banned or Game Banned
• Hover the trust score for its breakdown: statistical, anomalies and account flags, plus any auto-flag reason
• Hover the verdict to see why it says what it says
• Inventory value and CS2 playtime with the account age: cheat accounts rarely have either
• "Played with banned": how many of their last 100 matches had a player who was later banned

HOW GOOD ARE THEY?
• Premier rating in its in-game tier colour, peak or current with one click, with every season's peak on hover
• FACEIT level and ELO, all-time peak or current with one click
• Aim rating, K/D, win rate and their last 5 results
• Time to damage, utility rating, account age and total matches across every mode
• Wingman rank and competitive rank for every map

THEIR CS2 PROFILE
• CS level, commendations (friendly, teacher, leader) and every Premier season medal
• Coins, pins and service medals, straight from the CS2 Game Coordinator

WHAT HAVE THEY BEEN PLAYING?
• Their last 10 matches with map, mode, score and K-D, coloured by result
• Their 12 best-rated clips: click one to watch it big or full screen, and flip through the rest

YOUR FRIENDS
• On your Steam friends list: a trust badge or ban tag on every friend, and counts of trusted, low-trust, flagged and banned friends (click one to show only those)
• On your own profile: a Friends section with the friends worth a look

FACEIT MATCH PREVIEW
• Opens on top of every FACEIT match room: both teams with trust, peak Premier, peak FACEIT and each player's best map
• Each team's chance to win, and a match prediction with both sides' best maps and the coin flips
• Stays up after the veto, with the picked map highlighted; collapse it to one line any time

USE IT IN-GAME
In CS2, press Shift+Tab, open the web browser, go to csstats.rohan.my and click Add to Steam. From then on, every Steam profile you open in the overlay shows the stats.

FEELS LIKE PART OF STEAM
• Matches every Steam profile theme and works at any window size
• Loads only where it has something to show, and caches results for a few minutes
• Two settings, peak or current ratings, saved with your Chrome profile

PRIVACY
Stats are looked up from public CS2 stats services and the CS Stats server, using only the Steam IDs of the profile you're viewing, its friends on a friends list, or the players in a match room. Nothing about you is collected or stored.

A NOTE ON THE VERDICT
It's an estimate from public stats, not proof. Great players can look suspicious and careful cheaters can look clean, so please don't harass or report anyone based on the verdict alone.

CS Stats is an independent project and is not affiliated with Valve.
```

## What's new in 1.3.0

```
• Trust score on every profile: a 0–100 fair-play rating with its breakdown on hover (bans still show first)
• FACEIT match preview on top of every match room: trust, peak ratings, best maps, win chance and a map prediction
• Friends: trust badges and ban tags on your friends list, and a Friends section on your own profile
• Inventory value and CS2 playtime with account age, Premier peaks for every season, and the all-time FACEIT peak
```

## What's new in 1.2.2

```
• Stats for far more players: far fewer "No Data" profiles
• Clips: the 12 best-rated clips, three rows
• Commendations, CS level, Premier season medals and coins for everyone, no setup needed
• Install page at csstats.rohan.my for Steam's in-game browser
```

## What's new in 1.2.1

```
• Commendations, CS level, Premier season medals and coins now show for everyone, no setup needed
• New install page, csstats.rohan.my: add CS Stats to Steam's in-game browser in a couple of clicks
```

## What's new in 1.2.0

```
• Cheating verdict with reasons, plus "played with banned" for recent matches
• New stats: time to damage, utility, account age and total matches across all modes
• Peak or current FACEIT ELO, one click to switch (just like Premier)
• Redesigned Stats panel that lines up neatly at every screen size
• Last 10 matches now show map names
• Clips: the player's best-rated Allstar clips, in a big player with one-click full screen
• Ratings and recent matches load again
• Much smaller download: about 23 MB, down from over 140 MB
```

## Website

Homepage URL field: `https://csstats.rohan.my` (the install page; it also tells people when CS Stats is installed and on).

## Category / language

Category: Tools (or Fun). Language: English.

## Single purpose

Shows Counter-Strike 2 player statistics where you look players up: on Steam Community profiles and friends lists, and for the ten players in a FACEIT match room.

## Permission justifications

Dashboard fields (Privacy tab), paste as-is. The host field allows 1,000 characters; this is 782.

**storage justification**

```
saves two display preferences (Premier and FACEIT ELO: peak or current), and, on this device only, the Steam ID you're signed in to Steam Community with, so a FACEIT match preview can mark your team.
```

**Host permission justification**

```
steamcommunity.com: runs on Steam profile and friends pages to read the Steam64 IDs shown there and display the stats on the page.

api.steampowered.com: account creation date and VAC / game ban status for those Steam IDs.

open.faceit.com: FACEIT level, ELO and stats for a player, and the two teams in a FACEIT match room.

www.faceit.com: the FACEIT match room page, where the match preview is shown, and FACEIT's match history, used for the peak ELO.

api-public.cs-prod.leetify.com: Premier rating, performance stats, ranks and recent matches for a player.

a1.allstar.gg: the player's CS2 clips.

127.0.0.1 and localhost: an optional stats server the user can run on their own computer.

Only Steam IDs of players being looked at are sent. Nothing about the user is collected.
```

Details per permission:

- **storage**: saves two display preferences (Premier and FACEIT ELO: peak or current), and, on this device only, the Steam ID you're signed in to Steam Community with, so a FACEIT match preview can mark your team.
- **https://steamcommunity.com/\***: the content script runs on Steam Community profile and friends pages to show the stats.
- **https://api.steampowered.com/\***: Steam Web API for account creation date and VAC / game ban status.
- **https://api-public.cs-prod.leetify.com/\***: Leetify public API for ratings, ranks and recent matches.
- **https://open.faceit.com/\***: FACEIT Data API for level, ELO and lifetime stats.
- **https://www.faceit.com/\***: FACEIT match history, used to find the peak ELO, and a content script on FACEIT match rooms that shows the match preview.
- **https://a1.allstar.gg/\***: Allstar API for the player's CS2 clips.
- **http://127.0.0.1/\***, **http://localhost/\***: optional self-hosted Game Coordinator server run by the user (CS level, commendations, medals).
- **https://csstats.rohan.my** (no host permission; the server allows the extension via CORS): the public CS Stats Game Coordinator server for CS level, commendations and medals. Only the viewed profile's Steam64 ID is sent.
- **web_accessible_resources** `icon48.png` for `https://csstats.rohan.my/*`: lets the install page show "installed and on". `match.css`, FACEIT level and Premier badge images for `https://www.faceit.com/*`: the match preview's styles and badges. No permission prompt.
- **Remote code**: none. All code ships in the package.

## Data usage (privacy practices tab)

- The extension reads the Steam64 IDs of the profile being viewed, of its friends on a friends page, or of the players in a FACEIT match room, and sends them to the services above (including the CS Stats server at csstats.rohan.my) to look up those players' public stats.
- It does not collect, store or transmit personal data about the person using the extension. The two display preferences are saved in Chrome sync storage, and the signed-in Steam ID is kept only in local storage on the device to mark your team in match previews; it is never sent anywhere.
- No data is sold, used for advertising, or used for creditworthiness.
