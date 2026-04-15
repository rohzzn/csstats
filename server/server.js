require("dotenv").config();
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");
const express = require("express");
const cors = require("cors");

// ── Config ────────────────────────────────────────────────────────────────────

const PORT                = Number(process.env.PORT)       || 3000;
const STEAM_USERNAME      = process.env.STEAM_BOT_USERNAME;
const STEAM_PASSWORD      = process.env.STEAM_BOT_PASSWORD;
const SHARED_SECRET       = process.env.STEAM_BOT_SHARED_SECRET || null;
const GC_THROTTLE_MS      = 500;   // min ms between GC requests
const GC_TIMEOUT_MS       = 10000; // ms to wait for a GC response
const CACHE_TTL_MS        = 5 * 60 * 1000;

if (!STEAM_USERNAME || !STEAM_PASSWORD) {
  console.error("[Server] ERROR: set STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD in server/.env");
  process.exit(1);
}

// Never let an unhandled rejection crash the process — log it and keep going
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason?.message ?? reason);
});

// ── Steam / GC ─────────────────────────────────────────────────────────────────

const steamClient = new SteamUser();
const csgo        = new GlobalOffensive(steamClient);
let   gcReady     = false;

steamClient.logOn({ accountName: STEAM_USERNAME, password: STEAM_PASSWORD });

steamClient.on("loggedOn", () => {
  console.log("[Steam] Logged on as", STEAM_USERNAME);
  steamClient.setPersona(SteamUser.EPersonaState.Offline);
  steamClient.gamesPlayed([730]);
});

steamClient.on("steamGuard", (_domain, callback) => {
  if (!SHARED_SECRET) {
    console.error("[Steam] Steam Guard code required. Set STEAM_BOT_SHARED_SECRET in .env, or disable 2FA on the bot account.");
    process.exit(1);
  }
  const SteamTotp = requireOptional("steam-totp", "npm install steam-totp");
  callback(SteamTotp.generateAuthCode(SHARED_SECRET));
});

steamClient.on("error",       (e)    => console.error("[Steam] Error:", e.message));
steamClient.on("disconnected", (_, m) => { gcReady = false; console.warn("[Steam] Disconnected:", m); });

csgo.on("connectedToGC",    () => { gcReady = true;  console.log("[CS2 GC] Connected — ready"); });
csgo.on("disconnectedFromGC", (r) => { gcReady = false; console.warn("[CS2 GC] Disconnected:", r); });

// ── GC request queue ──────────────────────────────────────────────────────────
// One request at a time, throttled, with a per-request timeout.

const pendingQueue  = [];           // { steamId, resolve, reject }
const inflightMap   = new Map();    // steamId → Promise  (de-dupe concurrent same-ID requests)
let   queueRunning  = false;

function enqueueProfile(steamId) {
  if (inflightMap.has(steamId)) return inflightMap.get(steamId);

  const promise = new Promise((resolve, reject) => {
    pendingQueue.push({ steamId, resolve, reject });
    if (!queueRunning) runQueue();
  });

  inflightMap.set(steamId, promise);
  promise.finally(() => inflightMap.delete(steamId));
  return promise;
}

async function runQueue() {
  queueRunning = true;
  while (pendingQueue.length > 0) {
    const item = pendingQueue.shift();
    try {
      item.resolve(await gcFetchOne(item.steamId));
    } catch (e) {
      item.reject(e);
    }
    if (pendingQueue.length > 0) await sleep(GC_THROTTLE_MS);
  }
  queueRunning = false;
}

// Ask the GC for one profile. Returns the raw profile object the library emits,
// or null if the GC responds with no data.
// Rejects if not connected or timed out.
function gcFetchOne(steamId) {
  return new Promise((resolve, reject) => {
    if (!gcReady) return reject(new Error("CS2 GC not connected"));

    let settled = false;
    function settle(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    }

    // Timeout — some accounts produce no GC response (no CS2 data / hidden)
    const timer = setTimeout(() => settle(resolve, null), GC_TIMEOUT_MS);

    const result = csgo.requestPlayersProfile(steamId, (profile) => {
      settle(resolve, profile || null);
    });

    // Returns false if the steamId is structurally invalid
    if (result === false) {
      settle(reject, new Error("Invalid Steam64 ID for GC request"));
    }
  });
}

// ── Profile parsing ───────────────────────────────────────────────────────────
// The library's handler already extracts account_profiles[0] before calling
// our callback, so `profile` IS the CMsgGCCStrike15_v2_MatchmakingGC2ClientHello.
//
// Note: Valve no longer returns ranking data for third-party requests.
// rankings[] is always empty. We use the commendation/medal/level fields
// which ARE returned for every CS2 player.
//
// rank_type_id reference (future-proof):
//   6 = Competitive  |  7 = Wingman  |  11 = Premier CS Rating

function parseProfile(profile) {
  if (!profile) return null;

  // Rankings — currently always empty from Valve's side for third-party lookups,
  // but kept here so it works automatically if Valve ever re-enables it.
  const rankings    = Array.isArray(profile.rankings) ? [...profile.rankings] : [];
  const singular    = profile.ranking;
  if (singular?.rank_type_id > 0 && !rankings.some((r) => r.rank_type_id === singular.rank_type_id)) {
    rankings.push(singular);
  }

  const premier     = rankings.find((r) => r.rank_type_id === 11) ?? null;
  const wingman     = rankings.find((r) => r.rank_type_id === 7)  ?? null;
  const competitive = rankings.filter((r) => r.rank_type_id === 6);

  // Commendations — always returned for any CS2 player
  const cmd = profile.commendation ?? null;

  return {
    // Ranking data (empty until Valve re-enables)
    premier_rating:    premier?.rank_id  ?? null,
    premier_wins:      premier?.wins     ?? null,
    wingman_rank:      wingman?.rank_id  ?? null,
    wingman_wins:      wingman?.wins     ?? null,
    competitive_ranks: competitive.map((r) => ({ rank_id: r.rank_id, wins: r.wins })),

    // Always-available CS2 player data
    player_level:      profile.player_level ?? null,
    medal_count:       profile.medals?.display_items_defidx?.length ?? 0,
    commend_friendly:  cmd?.cmd_friendly ?? null,
    commend_teaching:  cmd?.cmd_teaching ?? null,
    commend_leader:    cmd?.cmd_leader   ?? null,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map(); // steamId → { data, expiresAt }

function getCached(steamId)         { const e = cache.get(steamId); return (e && e.expiresAt > Date.now()) ? e.data : null; }
function setCached(steamId, data)   { cache.set(steamId, { data, expiresAt: Date.now() + CACHE_TTL_MS }); }

// ── HTTP server ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: [/^chrome-extension:\/\//, /^http:\/\/127\.0\.0\.1/, /^http:\/\/localhost/] }));

app.get("/status", (_req, res) => {
  res.json({ gcReady, queueLength: pendingQueue.length, cacheSize: cache.size, uptime: Math.round(process.uptime()) });
});

app.get("/profile/:steamId", async (req, res) => {
  const { steamId } = req.params;

  if (!/^\d{17}$/.test(steamId)) {
    return res.status(400).json({ ok: false, error: "Invalid Steam64 ID" });
  }

  const cached = getCached(steamId);
  if (cached) return res.json(cached);

  if (!gcReady) {
    return res.status(503).json({ ok: false, error: "GC not connected yet — retry in a few seconds" });
  }

  try {
    const raw    = await enqueueProfile(steamId);
    const parsed = parseProfile(raw);

    // "found" = GC returned any useful data (commendations, level, or rankings)
    const hasData = parsed && (
      parsed.commend_friendly !== null ||
      parsed.player_level     !== null ||
      parsed.premier_rating   !== null
    );

    const result = hasData
      ? { ok: true, found: true,  ...parsed }
      : { ok: true, found: false };

    setCached(steamId, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[Server] CS2 Recon GC proxy → http://127.0.0.1:${PORT}`);
  console.log("[Server] Waiting for Steam login...");
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function requireOptional(pkg, hint) {
  try { return require(pkg); } catch {
    console.error(`[Server] Missing package: ${pkg}. Run: ${hint}`);
    process.exit(1);
  }
}
