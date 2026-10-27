// Only fixed provider operations are exposed. Credentials never reach clients.
const fs = require("fs");
const path = require("path");

const cache = new Map();
const pending = new Map();
const notFound = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

// csrep.gg: the key allows 5,000 requests a month and their API terms cap caching at 24 hours,
// so each player is fresh for 12 hours, never served older than 24, and a monthly counter
// (kept on disk so restarts can't reset it) stops requests before the allowance runs out.
const CSREP_TTL_MS = 12 * 60 * 60 * 1000;
const CSREP_NOT_FOUND_TTL_MS = 12 * 60 * 60 * 1000;
const CSREP_MONTHLY_LIMIT = Number(process.env.CSREP_MONTHLY_LIMIT) || 4800;
// Bulk lookups (friends lists, match rooms; ?bulk=1) may only spend this share of the month,
// so the profile trust score never runs dry because of them.
const CSREP_BULK_SHARE = Number(process.env.CSREP_BULK_SHARE) || 0.5;
const CSREP_USAGE_FILE = path.join(process.env.STEAM_STATE_DIR || __dirname, "csrep-usage.json");

function reserveCsrepRequest(bulk) {
  const month = new Date().toISOString().slice(0, 7);
  let usage = {month, count: 0};
  try {
    const saved = JSON.parse(fs.readFileSync(CSREP_USAGE_FILE, "utf8"));
    if (saved?.month === month && Number.isFinite(saved.count)) usage = saved;
  } catch (_error) {
    // First request this month, or no usage file yet.
  }
  if (usage.count >= (bulk ? Math.floor(CSREP_MONTHLY_LIMIT * CSREP_BULK_SHARE) : CSREP_MONTHLY_LIMIT)) {
    const error = new Error(bulk ? "CSRep bulk allowance used up" : "CSRep monthly allowance used up");
    error.status = bulk ? 429 : 503;
    throw error;
  }
  usage.count += 1;
  try {
    fs.writeFileSync(CSREP_USAGE_FILE, JSON.stringify(usage));
  } catch (_error) {
    // Counting is best effort; the in-memory caches still limit traffic.
  }
}

async function json(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(12000)});
  if (!response.ok) {
    const error = new Error(`Provider returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  if (data.errors?.length) {
    const error = new Error("Provider could not complete the request");
    error.status = 502;
    throw error;
  }
  return data;
}

function credential(name) {
  if (!process.env[name]) {
    const error = new Error("Provider credentials are not configured");
    error.status = 503;
    throw error;
  }
  return process.env[name];
}

async function load(provider, steamId, {bulk = false} = {}) {
  if (provider === "steam") {
    const key = encodeURIComponent(credential("STEAM_WEB_API_KEY"));
    const base = "https://api.steampowered.com";
    const bans = await json(`${base}/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${steamId}`);
    return {bans};
  }
  if (provider === "faceit") {
    const headers = {Authorization: `Bearer ${credential("FACEIT_API_KEY")}`};
    const player = await json(`https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${steamId}`, {headers});
    const stats = await json(`https://open.faceit.com/data/v4/players/${encodeURIComponent(player.player_id)}/stats/cs2`, {headers}).catch(() => null);
    return {player, stats};
  }
  if (provider === "allstar") {
    const headers = {"Content-Type": "application/json", "x-api-key": credential("ALLSTAR_SERVER_KEY")};
    const query = (query, variables) => json("https://a1.allstar.gg/graphql", {method: "POST", headers, body: JSON.stringify({query, variables})});
    const userResponse = await query("query($s:String!){ playerSearch(gameIdentifier:$s,game:CS){ success user{ _id username } } }", {s: steamId});
    const user = userResponse?.data?.playerSearch?.user;
    if (!user?._id) return {user: null, clips: []};
    const clipsResponse = await query("query($page:Int!,$user:String!,$game:Int){ videos:clips(search:createdDate,page:$page,user:$user,mobile:false,game:$game){ data{ _id clipTitle clipImageThumb clipLink views createdDate } } }", {page: 1, user: user._id, game: 7302});
    return {user, clips: clipsResponse?.data?.videos?.data || []};
  }
  if (provider === "leetify") {
    // Leetify's site API also covers players its public API does not (anyone seen in a Leetify user's matches).
    const base = `https://api.cs-prod.leetify.com/api/profile/${steamId}`;
    const get = (path) => json(`${base}/${path}`, {headers: {Accept: "application/json"}}).catch(() => null);
    const [meta, sidebar, recent, history] = await Promise.all([get("meta"), get("sidebar-games"), get("recent-games/5v5"), get("match-history")]);
    if (!recent && !history?.games?.length) {
      const error = new Error("Profile not found");
      error.status = 404;
      throw error;
    }
    return {meta, sidebar, recent, history};
  }
  if (provider === "csrep") {
    const apiKey = credential("CSREP_API_KEY");
    reserveCsrepRequest(bulk);
    const response = await json(`https://csrep.gg/api/players/${steamId}`, {
      headers: {"X-API-Key": apiKey, Accept: "application/json", "User-Agent": "CSStats (+https://csstats.rohan.my)"}
    });
    const player = response?.result;
    // Honour csrep's privacy mode and restricted profiles: nothing is passed on for them.
    if (!player || player.redacted || player.deleted_at) {
      const error = new Error("Profile not found");
      error.status = 404;
      throw error;
    }
    return {player};
  }
  const error = new Error("Unknown provider");
  error.status = 404;
  throw error;
}

// Delete anything older than 24 hours (csrep's API terms require deleting, not just skipping, expired data).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > STALE_TTL_MS) cache.delete(key);
  }
  for (const [key, until] of notFound) {
    if (until <= now) notFound.delete(key);
  }
}, 60 * 60 * 1000).unref();

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// One provider answer for one player: fresh cache, then a shared in-flight request, then stale data
// up to 24 hours old (csrep's caching limit as well as ours). cachedOnly never starts a request.
async function resolveProvider(provider, steamId, {bulk = false, cachedOnly = false} = {}) {
  const key = `${provider}:${steamId}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.expiresAt > now) return cached.data;
  if ((notFound.get(key) || 0) > now) throw failure(404, "Profile not found");
  const stale = cached?.cachedAt && now - cached.cachedAt <= STALE_TTL_MS ? cached.data : null;
  if (cachedOnly) {
    if (stale) return stale;
    throw failure(404, "Not cached");
  }
  const pendingKey = bulk ? `${key}:bulk` : key;
  if (!pending.has(pendingKey)) {
    if (pending.size >= 60) throw failure(503, "Busy. Retry shortly.");
    const ttl = provider === "csrep" ? CSREP_TTL_MS : CACHE_TTL_MS;
    pending.set(pendingKey, load(provider, steamId, {bulk}).then((data) => {
      cache.delete(key);
      cache.set(key, {data, cachedAt: Date.now(), expiresAt: Date.now() + ttl});
      while (cache.size > 4000) cache.delete(cache.keys().next().value);
      return data;
    }).catch((error) => {
      // Remember players csrep doesn't have, so repeat views don't spend the monthly allowance.
      if (provider === "csrep" && error.status === 404) {
        notFound.set(key, Date.now() + CSREP_NOT_FOUND_TTL_MS);
        while (notFound.size > 5000) notFound.delete(notFound.keys().next().value);
      }
      throw error;
    }).finally(() => pending.delete(pendingKey)));
  }
  if (stale) {
    pending.get(pendingKey).catch(() => {});
    return stale;
  }
  return pending.get(pendingKey);
}

function hasAnswer(key, now) {
  const cached = cache.get(key);
  return (cached?.cachedAt && now - cached.cachedAt <= STALE_TTL_MS) || (notFound.get(key) || 0) > now;
}

function sendFailure(res, error) {
  const status = [401, 403, 404, 429, 503].includes(error.status) ? error.status : 502;
  res.status(status).json({ok: false, error: status === 404 ? "Profile not found" : "Provider unavailable. Retry shortly."});
}

module.exports = async function providerRoute(req, res) {
  const {provider, steamId} = req.params;
  if (!/^[0-9]{17}$/.test(steamId) || !["steam", "faceit", "allstar", "leetify", "csrep"].includes(provider)) {
    return res.status(400).json({ok: false, error: "Invalid provider or Steam ID"});
  }
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=86400");
  try {
    res.json(await resolveProvider(provider, steamId, {
      bulk: provider === "csrep" && req.query.bulk === "1",
      // ?cached=1 answers from the cache only and never spends the allowance (a miss is a 404).
      cachedOnly: provider === "csrep" && req.query.cached === "1"
    }));
  } catch (error) {
    sendFailure(res, error);
  }
};

const TRUST_BATCH_MAX = 100;
// New csrep lookups one batch may start; everything else answers from the cache.
const TRUST_BATCH_NEW_MAX = 20;

// Only what friends lists and match rooms show.
function slimTrust(player) {
  const reputation = player?.reputation || {};
  const ranks = player?.ranks || {};
  const premierPeaks = Object.entries(ranks)
    .filter(([name]) => name.startsWith("premier:"))
    .map(([, rank]) => Number(rank?.peak) || 0);
  return {
    trust_score: reputation.trust_score ?? null,
    autoflag: player?.autoflag ? String(player.autoflag.reason || player.autoflag.label || player.autoflag) : null,
    faceit_peak: Number(ranks.faceit?.peak) || null,
    premier_peak: Math.max(0, ...premierPeaks) || null
  };
}

// GET /trust?ids=<steam64>,<steam64>…[&mode=bulk]. players[id] is the trust data, null when csrep
// has no profile, and missing when the player wasn't looked up (no cache and no budget left).
module.exports.trustBatch = async function trustBatchRoute(req, res) {
  const ids = [...new Set(String(req.query.ids || "").split(",").filter((id) => /^[0-9]{17}$/.test(id)))].slice(0, TRUST_BATCH_MAX);
  if (!ids.length) return res.status(400).json({ok: false, error: "No Steam IDs"});
  const lookup = req.query.mode === "bulk";
  const now = Date.now();
  const players = {};
  const queue = [...ids];
  let budget = TRUST_BATCH_NEW_MAX;
  let exhausted = false;

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const spend = lookup && !exhausted && budget > 0 && !hasAnswer(`csrep:${id}`, now);
      if (spend) budget -= 1;
      try {
        players[id] = slimTrust((await resolveProvider("csrep", id, {bulk: true, cachedOnly: !spend})).player);
      } catch (error) {
        if (error.status === 404 && (spend || hasAnswer(`csrep:${id}`, Date.now()))) players[id] = null;
        if (error.status === 429 || error.status === 503) exhausted = true;
      }
    }
  }

  await Promise.all(Array.from({length: 4}, worker));
  res.set("Cache-Control", "no-store");
  // exhausted: the bulk allowance is used up, so asking again this month won't help.
  res.json({ok: true, players, unchecked: ids.filter((id) => !(id in players)).length, exhausted});
};
