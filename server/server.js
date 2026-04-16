require("dotenv").config();
const fs = require("fs");
const path = require("path");
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");
const express = require("express");
const cors = require("cors");

const PORT                   = Number(process.env.PORT) || 3000;
const HOST                   = process.env.HOST || "0.0.0.0";
const STEAM_USERNAME         = process.env.STEAM_BOT_USERNAME;
const STEAM_PASSWORD         = process.env.STEAM_BOT_PASSWORD;
const SHARED_SECRET          = process.env.STEAM_BOT_SHARED_SECRET || null;
const REFRESH_TOKEN_ENV      = process.env.STEAM_BOT_REFRESH_TOKEN || "";
const GC_THROTTLE_MS         = Number(process.env.GC_THROTTLE_MS) || 500;
const GC_TIMEOUT_MS          = Number(process.env.GC_TIMEOUT_MS) || 10000;
const GC_REQUEST_WAIT_MS     = Number(process.env.GC_REQUEST_WAIT_MS) || 8000;
const CACHE_TTL_MS           = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS   = Number(process.env.WATCHDOG_INTERVAL_MS) || 30 * 1000;
const GC_CONNECT_GRACE_MS    = Number(process.env.GC_CONNECT_GRACE_MS) || 45 * 1000;
const GC_STALE_RELOG_MS      = Number(process.env.GC_STALE_RELOG_MS) || 3 * 60 * 1000;
const GC_STALE_EXIT_MS       = Number(process.env.GC_STALE_EXIT_MS) || 8 * 60 * 1000;
const RECOVERY_COOLDOWN_MS   = Number(process.env.RECOVERY_COOLDOWN_MS) || 45 * 1000;
const MANUAL_RETRY_BASE_MS   = Number(process.env.MANUAL_RETRY_BASE_MS) || 15 * 1000;
const MANUAL_RETRY_MAX_MS    = Number(process.env.MANUAL_RETRY_MAX_MS) || 2 * 60 * 1000;
const IS_RAILWAY             = Object.keys(process.env).some((key) => key.startsWith("RAILWAY_"));
const EXIT_ON_STALE_GC       = parseBooleanEnv(process.env.GC_STALE_EXIT_ENABLED, IS_RAILWAY);
const APP_ID_CS2             = 730;

if (!STEAM_USERNAME || (!STEAM_PASSWORD && !REFRESH_TOKEN_ENV)) {
  console.error("[Server] ERROR: set STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD, or provide STEAM_BOT_REFRESH_TOKEN.");
  process.exit(1);
}

const STATE_DIR = path.join(__dirname, ".steam-state");
const REFRESH_TOKEN_FILE = path.join(STATE_DIR, "refresh-token.json");
fs.mkdirSync(STATE_DIR, { recursive: true });

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason?.message ?? reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Server] Uncaught exception:", error?.stack || error?.message || error);
});

const steamClient = new SteamUser({
  autoRelogin: true,
  renewRefreshTokens: true,
  dataDirectory: STATE_DIR
});
const csgo = new GlobalOffensive(steamClient);

const runtime = {
  startedAt: Date.now(),
  steamStatus: "starting",
  loginMode: "unknown",
  loginAttempts: 0,
  manualRelogAttempts: 0,
  recoveryAttemptsSinceReady: 0,
  lastSteamLogOnAt: null,
  lastSteamDisconnectAt: null,
  lastSteamErrorAt: null,
  lastGcConnectAt: null,
  lastGcDisconnectAt: null,
  lastGcReadyAt: null,
  lastRecoveryAction: "",
  lastRecoveryAt: 0,
  lastManualRelogAt: 0,
  lastLoginAttemptAt: 0,
  nextManualRetryMs: MANUAL_RETRY_BASE_MS,
  lastSteamError: "",
  lastGcError: "",
  lastProfileError: "",
  lastGcStatus: null,
  logOnTimer: null,
  gcRecoveryTimer: null,
  shuttingDown: false
};

let gcReady = false;
let gcReadyWaiters = [];

steamClient.on("loggedOn", () => {
  runtime.steamStatus = "connected";
  runtime.lastSteamLogOnAt = Date.now();
  runtime.nextManualRetryMs = MANUAL_RETRY_BASE_MS;
  clearTimer("logOnTimer");
  console.log(`[Steam] Logged on as ${STEAM_USERNAME} via ${runtime.loginMode}`);
  steamClient.setPersona(SteamUser.EPersonaState.Offline);
  ensurePlayingCs2("post-logon");
});

steamClient.on("steamGuard", (_domain, callback, lastCodeWrong) => {
  if (!SHARED_SECRET) {
    console.error("[Steam] Steam Guard code required. Set STEAM_BOT_SHARED_SECRET or STEAM_BOT_REFRESH_TOKEN.");
    process.exit(1);
  }

  if (lastCodeWrong) {
    console.warn("[Steam] Steam Guard code was rejected. Waiting 30 seconds before retry.");
    setTimeout(() => callback(requireOptional("steam-totp", "npm install steam-totp").generateAuthCode(SHARED_SECRET)), 30000);
    return;
  }

  callback(requireOptional("steam-totp", "npm install steam-totp").generateAuthCode(SHARED_SECRET));
});

steamClient.on("refreshToken", (refreshToken) => {
  persistRefreshToken(refreshToken);
  console.log("[Steam] Stored refreshed Steam login token.");
});

steamClient.on("playingState", (blocked, appid) => {
  if (blocked) {
    console.warn(`[Steam] Playing session is blocked by another login (appid ${appid || 0}). Forcing CS2 session.`);
    scheduleGcRecovery("playing session blocked", 1000, true);
  }
});

steamClient.on("error", (error) => {
  gcReady = false;
  runtime.steamStatus = "error";
  runtime.lastSteamErrorAt = Date.now();
  runtime.lastSteamError = formatError(error);
  resolveGcReadyWaiters(false);
  console.error("[Steam] Error:", runtime.lastSteamError);
  scheduleManualSteamRecovery("steam error");
});

steamClient.on("disconnected", (eresult, message) => {
  gcReady = false;
  runtime.steamStatus = "reconnecting";
  runtime.lastSteamDisconnectAt = Date.now();
  runtime.lastSteamError = message ? `Disconnected: ${message}` : `Disconnected with eresult ${eresult}`;
  resolveGcReadyWaiters(false);
  console.warn("[Steam] Disconnected:", message || eresult);
});

csgo.on("connectedToGC", () => {
  gcReady = true;
  runtime.lastGcConnectAt = Date.now();
  runtime.lastGcReadyAt = runtime.lastGcConnectAt;
  runtime.recoveryAttemptsSinceReady = 0;
  runtime.lastGcError = "";
  clearTimer("gcRecoveryTimer");
  resolveGcReadyWaiters(true);
  console.log("[CS2 GC] Connected - ready");
});

csgo.on("disconnectedFromGC", (reason) => {
  gcReady = false;
  runtime.lastGcDisconnectAt = Date.now();
  runtime.lastGcError = `Disconnected from GC (${reason})`;
  resolveGcReadyWaiters(false);
  console.warn("[CS2 GC] Disconnected:", reason);
  scheduleGcRecovery("gc disconnected", 5000, false);
});

csgo.on("error", (error) => {
  gcReady = false;
  runtime.lastGcDisconnectAt = Date.now();
  runtime.lastGcError = formatError(error);
  resolveGcReadyWaiters(false);
  console.error("[CS2 GC] Fatal error:", runtime.lastGcError);
  scheduleManualSteamRecovery("gc fatal error", 10000);
});

csgo.on("connectionStatus", (status) => {
  runtime.lastGcStatus = status;
});

const pendingQueue = [];
const inflightMap = new Map();
let queueRunning = false;

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
    } catch (error) {
      item.reject(error);
    }

    if (pendingQueue.length > 0) {
      await sleep(GC_THROTTLE_MS);
    }
  }
  queueRunning = false;
}

function gcFetchOne(steamId) {
  return new Promise((resolve, reject) => {
    if (!gcReady) return reject(new Error("CS2 GC not connected"));

    let settled = false;
    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    const timer = setTimeout(() => settle(resolve, null), GC_TIMEOUT_MS);

    const result = csgo.requestPlayersProfile(steamId, (profile) => {
      settle(resolve, profile || null);
    });

    if (result === false) {
      settle(reject, new Error("Invalid Steam64 ID for GC request"));
    }
  });
}

function parseProfile(profile) {
  if (!profile) return null;

  const rankings = Array.isArray(profile.rankings) ? [...profile.rankings] : [];
  const singular = profile.ranking;
  if (singular?.rank_type_id > 0 && !rankings.some((rank) => rank.rank_type_id === singular.rank_type_id)) {
    rankings.push(singular);
  }

  const premier = rankings.find((rank) => rank.rank_type_id === 11) ?? null;
  const wingman = rankings.find((rank) => rank.rank_type_id === 7) ?? null;
  const competitive = rankings.filter((rank) => rank.rank_type_id === 6);
  const commendation = profile.commendation ?? null;
  const featuredMedalId = Number(profile.medals?.featured_display_item_defidx) || null;
  const rawMedalIds = Array.isArray(profile.medals?.display_items_defidx)
    ? profile.medals.display_items_defidx
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const medalIds = rawMedalIds.length
    ? rawMedalIds
    : featuredMedalId ? [featuredMedalId] : [];

  return {
    premier_rating: premier?.rank_id ?? null,
    premier_wins: premier?.wins ?? null,
    wingman_rank: wingman?.rank_id ?? null,
    wingman_wins: wingman?.wins ?? null,
    competitive_ranks: competitive.map((rank) => ({ rank_id: rank.rank_id, wins: rank.wins })),
    player_level: profile.player_level ?? null,
    medal_count: medalIds.length,
    medal_ids: medalIds,
    featured_medal_id: featuredMedalId,
    commend_friendly: commendation?.cmd_friendly ?? null,
    commend_teaching: commendation?.cmd_teaching ?? null,
    commend_leader: commendation?.cmd_leader ?? null
  };
}

const cache = new Map();
function getCached(steamId) {
  const entry = cache.get(steamId);
  return entry && entry.expiresAt > Date.now() ? entry.data : null;
}

function setCached(steamId, data) {
  cache.set(steamId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

const app = express();
app.use(cors({ origin: [/^chrome-extension:\/\//, /^http:\/\/127\.0\.0\.1/, /^http:\/\/localhost/] }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "cs2-recon-server",
    ...buildStatus(false),
    endpoints: ["/status", "/healthz", "/readyz", "/profile/:steamId"]
  });
});

app.get("/healthz", (_req, res) => {
  const body = buildStatus(true);
  res.status(body.gcReady ? 200 : 503).json(body);
});

app.get("/readyz", (_req, res) => {
  const body = buildStatus(true);
  res.status(body.gcReady ? 200 : 503).json(body);
});

app.get("/status", (_req, res) => {
  res.json(buildStatus(true));
});

app.get("/profile/:steamId", async (req, res) => {
  const { steamId } = req.params;

  if (!/^\d{17}$/.test(steamId)) {
    return res.status(400).json({ ok: false, error: "Invalid Steam64 ID" });
  }

  const cached = getCached(steamId);
  if (cached) return res.json(cached);

  if (!gcReady) {
    scheduleGcRecovery("profile request", 0, shouldForceGameSession());
    const ready = await waitForGcReady(GC_REQUEST_WAIT_MS);
    if (!ready) {
      return res.status(503).json({ ok: false, error: "GC not connected yet - retry in a few seconds" });
    }
  }

  try {
    const raw = await enqueueProfile(steamId);
    const parsed = parseProfile(raw);

    const hasData = parsed && (
      parsed.commend_friendly !== null ||
      parsed.player_level !== null ||
      parsed.premier_rating !== null ||
      (Array.isArray(parsed.medal_ids) && parsed.medal_ids.length > 0)
    );

    const result = hasData
      ? { ok: true, found: true, ...parsed }
      : { ok: true, found: false };

    setCached(steamId, result);
    res.json(result);
  } catch (error) {
    runtime.lastProfileError = formatError(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[Server] CS2 Recon GC proxy listening on ${HOST}:${PORT}`);
  console.log("[Server] Starting Steam / GC session manager...");
  scheduleLogOn("startup", 0);
  startWatchdog();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function scheduleLogOn(reason, delayMs = 0) {
  if (runtime.shuttingDown) return;
  clearTimer("logOnTimer");
  runtime.logOnTimer = setTimeout(() => {
    runtime.logOnTimer = null;
    performLogOn(reason);
  }, Math.max(0, delayMs));
}

function performLogOn(reason) {
  if (runtime.shuttingDown) return;
  if (steamClient.steamID && runtime.steamStatus === "connected") return;

  const details = buildLogOnDetails();
  runtime.loginAttempts += 1;
  runtime.lastLoginAttemptAt = Date.now();
  runtime.loginMode = details.refreshToken ? "refresh_token" : "password";
  runtime.steamStatus = "connecting";

  console.log(`[Steam] Attempting login via ${runtime.loginMode} (${reason})`);

  try {
    steamClient.logOn(details);
  } catch (error) {
    runtime.lastSteamErrorAt = Date.now();
    runtime.lastSteamError = formatError(error);
    console.error("[Steam] logOn() failed:", runtime.lastSteamError);
    scheduleLogOn("logOn threw", getNextManualRetryMs());
  }
}

function buildLogOnDetails() {
  const refreshToken = loadRefreshToken();
  if (refreshToken) {
    return { refreshToken };
  }

  return {
    accountName: STEAM_USERNAME,
    password: STEAM_PASSWORD
  };
}

function ensurePlayingCs2(reason, force = false) {
  if (runtime.shuttingDown) return;

  if (!steamClient.steamID) {
    scheduleLogOn(`${reason} (steam offline)`, getNextManualRetryMs());
    return;
  }

  runtime.lastRecoveryAt = Date.now();
  runtime.lastRecoveryAction = force ? `gamesPlayed(force) - ${reason}` : `gamesPlayed - ${reason}`;
  runtime.recoveryAttemptsSinceReady += 1;

  try {
    steamClient.setPersona(SteamUser.EPersonaState.Offline);
    steamClient.gamesPlayed([APP_ID_CS2], force);
    console.log(`[Recovery] Requested CS2 game session${force ? " (force)" : ""}: ${reason}`);
  } catch (error) {
    runtime.lastSteamErrorAt = Date.now();
    runtime.lastSteamError = formatError(error);
    console.error("[Recovery] Failed to request CS2 game session:", runtime.lastSteamError);
    scheduleManualSteamRecovery("gamesPlayed failed", 5000);
  }
}

function scheduleGcRecovery(reason, delayMs = 0, force = false) {
  if (runtime.shuttingDown || gcReady) return;
  clearTimer("gcRecoveryTimer");
  runtime.gcRecoveryTimer = setTimeout(() => {
    runtime.gcRecoveryTimer = null;
    ensurePlayingCs2(reason, force);
  }, Math.max(0, delayMs));
}

function scheduleManualSteamRecovery(reason, delayMs = null) {
  if (runtime.shuttingDown) return;

  const retryMs = delayMs === null ? getNextManualRetryMs() : delayMs;
  runtime.lastRecoveryAt = Date.now();
  runtime.lastRecoveryAction = `steam relog - ${reason}`;

  clearTimer("logOnTimer");
  runtime.logOnTimer = setTimeout(() => {
    runtime.logOnTimer = null;

    if (runtime.shuttingDown) return;
    if (gcReady && runtime.steamStatus === "connected") return;

    try {
      if (steamClient.steamID && typeof steamClient.relog === "function") {
        runtime.manualRelogAttempts += 1;
        runtime.lastManualRelogAt = Date.now();
        runtime.steamStatus = "reconnecting";
        console.warn(`[Recovery] Relogging Steam session (${reason})`);
        steamClient.relog();
        return;
      }
    } catch (error) {
      runtime.lastSteamErrorAt = Date.now();
      runtime.lastSteamError = formatError(error);
      console.error("[Recovery] steamClient.relog() failed:", runtime.lastSteamError);
    }

    performLogOn(`manual recovery: ${reason}`);
  }, Math.max(0, retryMs));
}

function startWatchdog() {
  setInterval(() => {
    if (runtime.shuttingDown) return;

    const now = Date.now();
    if (!gcReady) {
      const disconnectedFor = msSince(runtime.lastGcDisconnectAt || runtime.lastSteamLogOnAt || runtime.startedAt, now);

      if (steamClient.steamID) {
        if (disconnectedFor >= GC_STALE_RELOG_MS && msSince(runtime.lastManualRelogAt, now) >= GC_STALE_RELOG_MS) {
          scheduleManualSteamRecovery("watchdog stale gc", 0);
          return;
        }

        if (disconnectedFor >= GC_CONNECT_GRACE_MS && msSince(runtime.lastRecoveryAt, now) >= RECOVERY_COOLDOWN_MS) {
          scheduleGcRecovery("watchdog gc grace exceeded", 0, shouldForceGameSession());
        }
      } else if (runtime.steamStatus !== "connecting" && msSince(runtime.lastLoginAttemptAt, now) >= runtime.nextManualRetryMs) {
        scheduleLogOn("watchdog steam offline", 0);
      }

      if (
        EXIT_ON_STALE_GC &&
        disconnectedFor >= GC_STALE_EXIT_MS &&
        runtime.recoveryAttemptsSinceReady >= 2
      ) {
        console.error(`[Recovery] GC has been unhealthy for ${Math.round(disconnectedFor / 1000)}s. Exiting so Railway can restart the process.`);
        process.exit(1);
      }
    }
  }, WATCHDOG_INTERVAL_MS).unref?.();
}

function shouldForceGameSession() {
  const blocked = Boolean(steamClient.playingState?.blocked);
  const staleFor = msSince(runtime.lastGcDisconnectAt || runtime.lastSteamLogOnAt || runtime.startedAt);
  return blocked || staleFor >= GC_CONNECT_GRACE_MS;
}

function waitForGcReady(timeoutMs) {
  if (gcReady) return Promise.resolve(true);

  return new Promise((resolve) => {
    const waiter = {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      gcReadyWaiters = gcReadyWaiters.filter((entry) => entry !== waiter);
      resolve(false);
    }, timeoutMs);

    gcReadyWaiters.push(waiter);
  });
}

function resolveGcReadyWaiters(value) {
  if (!gcReadyWaiters.length) return;
  const waiters = gcReadyWaiters;
  gcReadyWaiters = [];
  for (const waiter of waiters) {
    waiter.resolve(value);
  }
}

function buildStatus(verbose) {
  const status = {
    ok: gcReady,
    steamConnected: Boolean(steamClient.steamID),
    steamStatus: runtime.steamStatus,
    gcReady,
    loginMode: runtime.loginMode,
    loginAttempts: runtime.loginAttempts,
    manualRelogAttempts: runtime.manualRelogAttempts,
    queueLength: pendingQueue.length,
    cacheSize: cache.size,
    uptime: Math.round(process.uptime()),
    hasRefreshToken: Boolean(loadRefreshToken()),
    lastRecoveryAction: runtime.lastRecoveryAction || null
  };

  if (!verbose) {
    return status;
  }

  return {
    ...status,
    startedAt: new Date(runtime.startedAt).toISOString(),
    lastSteamLogOnAt: toIso(runtime.lastSteamLogOnAt),
    lastSteamDisconnectAt: toIso(runtime.lastSteamDisconnectAt),
    lastSteamErrorAt: toIso(runtime.lastSteamErrorAt),
    lastGcConnectAt: toIso(runtime.lastGcConnectAt),
    lastGcDisconnectAt: toIso(runtime.lastGcDisconnectAt),
    lastGcReadyAt: toIso(runtime.lastGcReadyAt),
    lastGcStatus: runtime.lastGcStatus,
    recoveryAttemptsSinceReady: runtime.recoveryAttemptsSinceReady,
    nextManualRetryMs: runtime.nextManualRetryMs,
    exitOnStaleGc: EXIT_ON_STALE_GC,
    lastSteamError: runtime.lastSteamError || null,
    lastGcError: runtime.lastGcError || null,
    lastProfileError: runtime.lastProfileError || null
  };
}

function loadRefreshToken() {
  if (REFRESH_TOKEN_ENV) {
    return REFRESH_TOKEN_ENV.trim();
  }

  try {
    const saved = JSON.parse(fs.readFileSync(REFRESH_TOKEN_FILE, "utf8"));
    return String(saved?.refreshToken || "").trim() || "";
  } catch {
    return "";
  }
}

function persistRefreshToken(refreshToken) {
  if (!refreshToken) return;
  try {
    fs.writeFileSync(
      REFRESH_TOKEN_FILE,
      JSON.stringify({ refreshToken, updatedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[Steam] Failed to persist refresh token:", error?.message || error);
  }
}

function getNextManualRetryMs() {
  const current = runtime.nextManualRetryMs;
  runtime.nextManualRetryMs = Math.min(MANUAL_RETRY_MAX_MS, Math.max(MANUAL_RETRY_BASE_MS, current * 2));
  return current;
}

function clearTimer(key) {
  if (!runtime[key]) return;
  clearTimeout(runtime[key]);
  runtime[key] = null;
}

function formatError(error) {
  if (!error) return "Unknown error";
  if (error.stack) return String(error.stack);
  if (error.message) return String(error.message);
  return String(error);
}

function toIso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

function msSince(timestamp, now = Date.now()) {
  return timestamp ? Math.max(0, now - timestamp) : Number.MAX_SAFE_INTEGER;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function requireOptional(pkg, hint) {
  try {
    return require(pkg);
  } catch {
    console.error(`[Server] Missing package: ${pkg}. Run: ${hint}`);
    process.exit(1);
  }
}

function shutdown() {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  console.log("[Server] Shutting down...");
  try {
    steamClient.gamesPlayed([]);
  } catch (_ignored) {}
  try {
    steamClient.logOff();
  } catch (_ignored) {}
  setTimeout(() => process.exit(0), 250).unref?.();
}
