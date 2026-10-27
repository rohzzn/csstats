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
const CSREP_USAGE_FILE = path.join(process.env.STEAM_STATE_DIR || __dirname, "csrep-usage.json");

function reserveCsrepRequest() {
  const month = new Date().toISOString().slice(0, 7);
  let usage = {month, count: 0};
  try {
    const saved = JSON.parse(fs.readFileSync(CSREP_USAGE_FILE, "utf8"));
    if (saved?.month === month && Number.isFinite(saved.count)) usage = saved;
  } catch (_error) {
    // First request this month, or no usage file yet.
  }
  if (usage.count >= CSREP_MONTHLY_LIMIT) {
    const error = new Error("CSRep monthly allowance used up");
    error.status = 503;
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

async function load(provider, steamId) {
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
    reserveCsrepRequest();
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

module.exports = async function providerRoute(req, res) {
  const {provider, steamId} = req.params;
  if (!/^[0-9]{17}$/.test(steamId) || !["steam", "faceit", "allstar", "leetify", "csrep"].includes(provider)) {
    return res.status(400).json({ok: false, error: "Invalid provider or Steam ID"});
  }
  const key = `${provider}:${steamId}`;
  const cached = cache.get(key);
  const now = Date.now();
  const ttl = provider === "csrep" ? CSREP_TTL_MS : CACHE_TTL_MS;
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=86400");
  if (cached?.expiresAt > now) return res.json(cached.data);
  if ((notFound.get(key) || 0) > now) return res.status(404).json({ok: false, error: "Profile not found"});
  if (!pending.has(key)) {
    if (pending.size >= 60) return res.status(503).json({ok: false, error: "Busy. Retry shortly."});
    pending.set(key, load(provider, steamId).then((data) => {
      cache.delete(key);
      cache.set(key, {data, cachedAt: Date.now(), expiresAt: Date.now() + ttl});
      while (cache.size > 2000) cache.delete(cache.keys().next().value);
      return data;
    }).catch((error) => {
      // Remember players csrep doesn't have, so repeat views don't spend the monthly allowance.
      if (provider === "csrep" && error.status === 404) {
        notFound.set(key, Date.now() + CSREP_NOT_FOUND_TTL_MS);
        while (notFound.size > 5000) notFound.delete(notFound.keys().next().value);
      }
      throw error;
    }).finally(() => pending.delete(key)));
  }
  // Stale data stays within 24 hours, csrep's caching limit as well as ours.
  if (cached?.cachedAt && now - cached.cachedAt <= STALE_TTL_MS) {
    pending.get(key).catch(() => {});
    return res.json(cached.data);
  }
  try {
    res.json(await pending.get(key));
  } catch (error) {
    const status = [401, 403, 404, 429, 503].includes(error.status) ? error.status : 502;
    res.status(status).json({ok: false, error: status === 404 ? "Profile not found" : "Provider unavailable. Retry shortly."});
  }
};
