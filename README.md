# Steam CS2 Profile Intel

A Manifest V3 browser extension that injects a transparent Steam-style `Stats` showcase at the top of Steam profiles.

## What it shows

- A FACEIT stats row with the bundled FACEIT rank image plus ELO, matches, win rate, and K/D
- A Leetify-backed stats row with Premier, Peak Premier, Aim, Positioning, Utility, Reaction, and competitive-rank images from the local `csranks/` folder

## Data sources

### FACEIT

- Uses FACEIT's official API.
- The FACEIT API key is hardcoded in `background.js`.

### Leetify

- Uses Leetify's official public API.
- The Leetify API key is hardcoded in `background.js`.

## Load it locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.

## Notes

- There is no user-facing config UI in the extension anymore; provider settings are fixed in code.
- The Steam injection renders a single `Stats` showcase heading with two source-backed stat rows, no usernames, no buttons, no outbound profile links, and a transparent layout.
