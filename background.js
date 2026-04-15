const SETTINGS = Object.freeze({
  steamApiKey: "2855FF7B8929866B9CD7AD3265D1C0C2",
  leetifyApiKey: "6d7de76a-726a-460d-a41b-34d581bf2013",
  faceitApiKey: "b0ce56e8-e9a2-45e7-82ee-7310a0549d0f",
  enableLeetify: true,
  enableFaceit: true,
  enableCsStats: true,
  cacheTtlMs: 5 * 60 * 1000
});

const PROVIDER_ORDER = ["steam", "faceit", "leetify", "csstats"];
const providerCache = new Map();
const inflightRequests = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SPX_GET_PROFILE_BUNDLE") {
    buildProfileBundle(message)
      .then((payload) => sendResponse(payload))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function buildProfileBundle(message) {
  const steamId = String(message?.steamId || "").trim();
  if (!/^\d{17}$/.test(steamId)) {
    return { ok: false, error: "Could not resolve a Steam64 ID on this profile." };
  }

  const profileUrl = String(message?.profileUrl || "");
  const force = Boolean(message?.force);
  const settings = SETTINGS;

  const providerTasks = {
    steam: () => getCachedProvider("steam", steamId, settings, force, () => fetchSteamData(steamId, settings)),
    faceit: () => getCachedProvider("faceit", steamId, settings, force, () => fetchFaceitData(steamId, settings)),
    leetify: () => getCachedProvider("leetify", steamId, settings, force, () => fetchLeetifyData(steamId, settings)),
    csstats: () => getCachedProvider("csstats", steamId, settings, force, () => fetchCsStatsData(steamId, settings))
  };

  const providers = await Promise.all(
    PROVIDER_ORDER.map(async (providerId) => {
      try {
        return await providerTasks[providerId]();
      } catch (error) {
        return makeProviderResult(providerId, "error", {
          message: error.message || "The provider could not be loaded."
        });
      }
    })
  );

  return {
    ok: true,
    steamId,
    profileUrl,
    fetchedAt: new Date().toISOString(),
    providers
  };
}

async function getCachedProvider(providerId, steamId, settings, force, loader) {
  const key = `${providerId}:${steamId}`;
  const ttl = Number(settings.cacheTtlMs) || SETTINGS.cacheTtlMs;
  const cached = providerCache.get(key);

  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (!force && inflightRequests.has(key)) {
    return inflightRequests.get(key);
  }

  const pending = loader()
    .then((value) => {
      providerCache.set(key, {
        expiresAt: Date.now() + getProviderCacheTtl(value, ttl),
        value
      });
      inflightRequests.delete(key);
      return value;
    })
    .catch((error) => {
      inflightRequests.delete(key);
      throw error;
    });

  inflightRequests.set(key, pending);
  return pending;
}

function getProviderCacheTtl(providerResult, defaultTtl) {
  const state = providerResult?.state;
  if (state === "ready" || state === "not_found" || state === "disabled") {
    return defaultTtl;
  }

  return 30 * 1000;
}

async function fetchSteamData(steamId, settings) {
  if (!settings.steamApiKey) {
    return makeProviderResult("steam", "not_found", {});
  }

  const key = settings.steamApiKey;
  const profileUrl = `https://steamcommunity.com/profiles/${steamId}`;

  try {
    const [summaryRes, bansRes, statsRes] = await Promise.all([
      fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamId}`).catch(() => null),
      fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${steamId}`).catch(() => null),
      fetchJson(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${key}&steamid=${steamId}&appid=730`).catch(() => null)
    ]);

    const player = summaryRes?.response?.players?.[0];
    const banInfo = bansRes?.players?.[0];
    const rawStats = statsRes?.playerstats?.stats || [];

    const statMap = {};
    for (const s of rawStats) { statMap[s.name] = s.value; }

    const accountAge = player?.timecreated ? formatAccountAge(player.timecreated) : null;
    const friendCode = getSteamFriendCode(steamId);

    let banStatus = null;
    if (banInfo) {
      if (banInfo.VACBanned) {
        banStatus = `${banInfo.NumberOfVACBans} VAC`;
      } else if (banInfo.NumberOfGameBans > 0) {
        banStatus = `${banInfo.NumberOfGameBans} Game Ban`;
      } else {
        banStatus = "Clean";
      }
    }

    const commendFriendly = asNumber(statMap.total_commendation_friendly ?? statMap.commendation_friendly);
    const commendTeaching = asNumber(statMap.total_commendation_teaching ?? statMap.commendation_teaching);
    const commendLeader   = asNumber(statMap.total_commendation_leader   ?? statMap.commendation_leader);
    const totalCommend = compact([commendFriendly, commendTeaching, commendLeader])
      .reduce((sum, v) => sum + v, 0);

    const metrics = compact([
      makeMetric("Commends", totalCommend > 0 ? formatInteger(totalCommend) : null)
    ]);

    if (!metrics.length) {
      return makeProviderResult("steam", "not_found", {});
    }

    return makeProviderResult("steam", "ready", {
      title: player?.personaname || "Steam",
      message: "",
      url: profileUrl,
      metrics,
      details: []
    });
  } catch (_error) {
    return makeProviderResult("steam", "not_found", {});
  }
}

function getSteamFriendCode(steamId64Str) {
  const DICT = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  // Minimal MD5 for 8-byte input — needed for the checksum bits in the friend code.
  // Web Crypto API does not support MD5, so this is implemented inline.
  function md5FirstWord(accountId32) {
    const T = [
      0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
      0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
      0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
      0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
      0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
      0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
      0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
      0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
    ];
    const S = [
      7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
      5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
      4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
      6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
    ];
    // Single 512-bit MD5 block for our 8-byte message
    // bytes 0-3: accountId LE, bytes 4-7: 0x4F,0x47,0x53,0x43 ('CSGO' LE)
    // then 0x80 padding, length 64 bits at offset 56
    const M = new Uint32Array(16);
    M[0] = accountId32 >>> 0;
    M[1] = 0x4353474F;
    M[2] = 0x00000080;
    M[14] = 64;

    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const A = a;

    for (let i = 0; i < 64; i++) {
      let f, g;
      if      (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d;           g = (3 * i + 5) & 15; }
      else             { f = c ^ (b | ~d);         g = (7 * i) & 15; }

      f = (f + a + T[i] + M[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << S[i]) | (f >>> (32 - S[i])))) >>> 0;
    }

    return (a + A) >>> 0;
  }

  function swapBytes32(n) {
    return ((n & 0xFFn) << 24n) | (((n >> 8n) & 0xFFn) << 16n) |
           (((n >> 16n) & 0xFFn) << 8n) | ((n >> 24n) & 0xFFn);
  }

  function reverseEndianness64(val) {
    const lo = val & 0xFFFFFFFFn;
    const hi = (val >> 32n) & 0xFFFFFFFFn;
    return (swapBytes32(lo) << 32n) | swapBytes32(hi);
  }

  try {
    const steamId = BigInt(steamId64Str);
    const accountId32 = Number(steamId & 0xFFFFFFFFn);
    const hash = md5FirstWord(accountId32);

    let h = steamId;
    let mask = 0n;

    for (let i = 0; i < 8; i++) {
      const nibble = h & 0xFn;
      h >>= 4n;
      const hashNibble = BigInt((hash >> i) & 1);
      const a = (mask << 4n) | nibble;
      mask = ((mask >> 28n) << 32n) | a;
      mask = ((mask >> 31n) << 32n) | (a << 1n) | hashNibble;
    }

    mask = reverseEndianness64(mask);
    mask >>= 20n; // skip 4-char AAAA prefix (4 × 5 bits)

    let codes = "";
    for (let i = 0; i < 9; i++) {
      codes += DICT[Number(mask & 0x1Fn)];
      mask >>= 5n;
    }

    // CS2 format: XXXXX-YYYY (no CSGO- prefix)
    return codes.slice(0, 5) + "-" + codes.slice(5);
  } catch (_e) {
    return null;
  }
}

function formatAccountAge(timecreated) {
  const ageMs = Date.now() - timecreated * 1000;
  const years = Math.floor(ageMs / (365.25 * 24 * 60 * 60 * 1000));
  const months = Math.floor((ageMs % (365.25 * 24 * 60 * 60 * 1000)) / (30.44 * 24 * 60 * 60 * 1000));
  if (years >= 1) {
    return months > 0 ? `${years}y ${months}m` : `${years}y`;
  }
  return `${months}m`;
}

async function fetchLeetifyData(steamId, settings) {
  if (!settings.enableLeetify) {
    return makeProviderResult("leetify", "not_found", {});
  }

  const profileUrl = `https://leetify.com/app/profile/${steamId}`;
  const apiUrl = `https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${encodeURIComponent(steamId)}`;

  let profile = null;

  try {
    const headers = { Accept: "application/json" };
    if (settings.leetifyApiKey) {
      headers.Authorization = `Bearer ${settings.leetifyApiKey}`;
    }
    profile = await fetchJson(apiUrl, { headers });
  } catch (firstError) {
    if (firstError.status === 401 && settings.leetifyApiKey) {
      try {
        profile = await fetchJson(apiUrl, { headers: { Accept: "application/json" } });
      } catch (_) {
        // Both attempts failed — profile stays null.
      }
    }
  }

  if (!profile) {
    return makeProviderResult("leetify", "not_found", { url: profileUrl });
  }

  const aim = asNumber(profile?.rating?.aim);
  const positioning = asNumber(profile?.rating?.positioning);
  const utility = asNumber(profile?.rating?.utility);
  const reaction = asNumber(profile?.stats?.reaction_time_ms);
  const peakPremier = resolveLeetifyPeakPremier(profile);
  const premier = asNumber(profile?.ranks?.premier);
  const competitiveRanks = resolveLeetifyCompetitiveRanks(profile?.ranks?.competitive);
  const wingmanRanks = resolveLeetifyWingmanRanks(profile?.ranks?.wingman_competitive ?? profile?.ranks?.wingman);

  const metrics = compact([
    makeMetric("Premier", formatInteger(premier)),
    makeMetric("Peak Premier", formatInteger(peakPremier)),
    makeMetric("Aim", formatDecimal(aim, 1)),
    makeMetric("Positioning", formatDecimal(positioning, 1)),
    makeMetric("Utility", formatDecimal(utility, 1)),
    makeMetric("Reaction", formatMilliseconds(reaction))
  ]);

  return makeProviderResult("leetify", "ready", {
    title: profile.name || "Leetify",
    message: "",
    url: profileUrl,
    competitiveRanks,
    wingmanRanks,
    metrics,
    details: []
  });
}

async function fetchFaceitData(steamId, settings) {
  if (!settings.enableFaceit || !settings.faceitApiKey) {
    return makeProviderResult("faceit", "not_found", {});
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${settings.faceitApiKey}`
  };

  try {
    const [player, summaryRes] = await Promise.all([
      fetchJson(
        `https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${encodeURIComponent(steamId)}`,
        { headers }
      ),
      settings.steamApiKey
        ? fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${settings.steamApiKey}&steamids=${steamId}`).catch(() => null)
        : Promise.resolve(null)
    ]);

    const stats = await fetchJson(
      `https://open.faceit.com/data/v4/players/${encodeURIComponent(player.player_id)}/stats/cs2`,
      { headers }
    ).catch(() => null);

    const cs2 = player?.games?.cs2 || {};
    const lifetime = stats?.lifetime || {};
    const rankImage = resolveFaceitRankAsset(cs2);
    const kd = formatDecimal(
      pickAliasedNumber(lifetime, ["Average K/D Ratio", "Average K/D", "K/D Ratio"]),
      2
    );

    const steamPlayer = summaryRes?.response?.players?.[0];
    const accountAge = steamPlayer?.timecreated ? formatAccountAge(steamPlayer.timecreated) : null;
    const friendCode = getSteamFriendCode(steamId);

    const metrics = compact([
      makeMetric("ELO", formatInteger(cs2.faceit_elo)),
      makeMetric("Matches", formatInteger(pickAliasedNumber(lifetime, ["Matches"]))),
      makeMetric("K/D", kd),
      makeMetric("Account Age", accountAge),
      makeMetric("Friend Code", friendCode)
    ]);

    if (!metrics.length) {
      return makeProviderResult("faceit", "not_found", {});
    }

    return makeProviderResult("faceit", "ready", {
      title: player.nickname || "FACEIT",
      message: "",
      url: player.faceit_url || `https://www.faceit.com/en/players/${encodeURIComponent(player.nickname || "")}`,
      rankImage,
      rankLabel: resolveFaceitRankLabel(cs2),
      metrics,
      details: []
    });
  } catch (_error) {
    return makeProviderResult("faceit", "not_found", {});
  }
}


async function fetchCsStatsData(steamId, settings) {
  if (!settings.enableCsStats) {
    return makeProviderResult("csstats", "not_found", {});
  }

  const profileUrl = `https://csstats.gg/player/${steamId}`;

  try {
    const html = await fetchText(profileUrl, {
      credentials: "include",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Referer": "https://steamcommunity.com/"
      }
    });

    return normalizeCsStatsText(steamId, profileUrl, extractReadableText(html));
  } catch (_error) {
    return makeProviderResult("csstats", "not_found", {});
  }
}


function normalizeCsStatsText(steamId, profileUrl, textInput) {
  const text = normalizeTextBlock(textInput || "");

  if (!text) {
    return makeProviderResult("csstats", "error", {
      message: "CSStats loaded, but no readable data was captured.",
      url: profileUrl
    });
  }

  if (hasAny(text, ["please login to view player stats", "please login to continue"])) {
    return makeProviderResult("csstats", "setup", {
      message: "Log in to csstats.gg in this browser to unlock CSStats data.",
      url: profileUrl
    });
  }

  if (hasAny(text, ["just a moment", "verify you are human", "attention required"])) {
    return makeProviderResult("csstats", "setup", {
      message: "CSStats is behind Cloudflare right now. Open the CSStats page once in this browser, then reload Steam.",
      url: profileUrl
    });
  }

  const lines = toLines(text);
  const premierBlock = findPremierBlock(lines);
  const faceitValue = findLabeledNumber(lines, /^faceit$/i, 8);
  const trackingMessage = lines.find((line) => /tracking not enabled/i.test(line));

  const metrics = compact([
    makeMetric("Premier", premierBlock.current),
    makeMetric("Best", premierBlock.best),
    makeMetric("Wins", premierBlock.wins),
    makeMetric("FACEIT", faceitValue)
  ]);

  if (!metrics.length) {
    return makeProviderResult("csstats", "not_found", {});
  }

  return makeProviderResult("csstats", "ready", {
    title: "CSStats",
    message: trackingMessage || "",
    url: profileUrl,
    metrics,
    details: compact([
      makeDetail("Steam64", steamId)
    ])
  });
}


async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw await buildHttpError(response);
  }

  if (!contentType.includes("application/json")) {
    const text = await response.text();
    return JSON.parse(text);
  }

  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);

  if (!response.ok) {
    throw await buildHttpError(response);
  }

  return response.text();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function buildHttpError(response) {
  const error = new Error(`HTTP ${response.status} ${response.statusText}`);
  error.status = response.status;
  error.statusText = response.statusText;

  try {
    error.body = await response.text();
  } catch (_ignored) {
    error.body = "";
  }

  return error;
}

function makeProviderResult(id, state, extras = {}) {
  return {
    id,
    title: providerTitle(id),
    state,
    message: extras.message || "",
    url: extras.url || "",
    metrics: Array.isArray(extras.metrics) ? extras.metrics : [],
    details: Array.isArray(extras.details) ? extras.details : [],
    subtitle: extras.subtitle || "",
    ...extras
  };
}

function providerTitle(id) {
  return {
    faceit: "FACEIT",
    leetify: "Leetify",
    steam: "Steam",
    csstats: "CSStats"
  }[id] || id;
}

function resolveFaceitRankAsset(gameData) {
  const label = String(gameData?.skill_level_label || "").trim().toLowerCase();
  if (label.includes("challenger")) {
    return chrome.runtime.getURL("faceit/11.svg");
  }

  const level = asNumber(gameData?.skill_level);
  if (level === null) {
    return "";
  }

  const normalizedLevel = Math.max(1, Math.min(10, Math.round(level)));
  return chrome.runtime.getURL(`faceit/${normalizedLevel}.svg`);
}

function resolveFaceitRankLabel(gameData) {
  const label = String(gameData?.skill_level_label || "").trim();
  if (label) {
    return label;
  }

  const level = asNumber(gameData?.skill_level);
  return level === null ? "FACEIT" : `Level ${Math.round(level)}`;
}

function resolveLeetifyCompetitiveRanks(ranks) {
  return resolveRankEntries(ranks, "csranks");
}

function resolveLeetifyWingmanRanks(ranks) {
  if (typeof ranks === "number") {
    const rank = Math.max(0, Math.min(18, Math.round(ranks)));
    if (rank === 0 || !CSGO_RANK_ASSET_MAP[rank]) { return []; }
    return [{
      mapName: "Wingman",
      rank,
      rankLabel: competitiveRankLabel(rank),
      image: chrome.runtime.getURL(`wingman/${CSGO_RANK_ASSET_MAP[rank]}`)
    }];
  }

  return resolveRankEntries(ranks, "wingman");
}

function resolveRankEntries(ranks, folder) {
  if (!Array.isArray(ranks)) {
    return [];
  }

  return ranks
    .map((entry) => {
      const rank = asNumber(entry?.rank);
      if (rank === null) { return null; }

      const normalizedRank = Math.max(0, Math.min(18, Math.round(rank)));
      if (normalizedRank === 0) { return null; }

      const assetName = CSGO_RANK_ASSET_MAP[normalizedRank];
      if (!assetName) { return null; }

      return {
        mapName: formatCompetitiveMapName(entry?.map_name),
        rank: normalizedRank,
        rankLabel: competitiveRankLabel(normalizedRank),
        image: chrome.runtime.getURL(`${folder}/${assetName}`)
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.rank - left.rank)
    .slice(0, 6);
}

function resolveLeetifyPeakPremier(profile) {
  const currentPremier = asNumber(profile?.ranks?.premier);
  const recentMatches = Array.isArray(profile?.recent_matches) ? profile.recent_matches : [];

  const recentPeak = recentMatches
    .map((match) => {
      const rankType = asNumber(match?.rank_type);
      const rank = asNumber(match?.rank);
      return rankType === 11 && rank !== null && rank > 0 ? rank : null;
    })
    .filter((rank) => rank !== null)
    .reduce((peak, rank) => Math.max(peak, rank), 0);

  if (recentPeak > 0 && currentPremier !== null) {
    return Math.max(currentPremier, recentPeak);
  }

  if (recentPeak > 0) {
    return recentPeak;
  }

  return currentPremier;
}

function formatCompetitiveMapName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "Map";
  }

  return raw
    .replace(/^de_/i, "")
    .replace(/^cs_/i, "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function competitiveRankLabel(rank) {
  return {
    1: "Silver I",
    2: "Silver II",
    3: "Silver III",
    4: "Silver IV",
    5: "Silver Elite",
    6: "Silver Elite Master",
    7: "Gold Nova I",
    8: "Gold Nova II",
    9: "Gold Nova III",
    10: "Gold Nova Master",
    11: "Master Guardian I",
    12: "Master Guardian II",
    13: "Master Guardian Elite",
    14: "Distinguished Master Guardian",
    15: "Legendary Eagle",
    16: "Legendary Eagle Master",
    17: "Supreme Master First Class",
    18: "Global Elite"
  }[rank] || "Competitive rank";
}

const CSGO_RANK_ASSET_MAP = Object.freeze({
  1: "1.svg",
  2: "2.svg",
  3: "3.svg",
  4: "4.svg",
  5: "5.svg",
  6: "6.svg",
  7: "7.svg",
  8: "8.svg",
  9: "9.svg",
  10: "10.svg",
  11: "11.svg",
  12: "12.svg",
  13: "13.svg",
  14: "14.svg",
  15: "15.svg",
  16: "16.svg",
  17: "17.svg",
  18: "18.svg"
});

function makeMetric(label, value, meta = "") {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return {
    label,
    value: String(value),
    meta: meta ? String(meta) : ""
  };
}

function makeDetail(label, value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return {
    label,
    value: String(value)
  };
}

function compact(values) {
  return values.filter(Boolean);
}


function pickAliasedNumber(record, aliases) {
  const value = pickAliasedValue(record, aliases);
  return asNumber(value);
}

function pickAliasedValue(record, aliases) {
  if (!record || typeof record !== "object") {
    return null;
  }

  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) {
      return record[alias];
    }
  }

  const normalizedRecord = Object.entries(record);
  for (const alias of aliases) {
    const normalizedAlias = normalizeKey(alias);
    const match = normalizedRecord.find(([key]) => normalizeKey(key) === normalizedAlias);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value)
    .replace(/,/g, "")
    .replace(/%/g, "")
    .trim();

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatInteger(value) {
  const number = asNumber(value);
  return number === null ? null : Math.round(number).toLocaleString("en-US");
}

function formatDecimal(value, digits = 1) {
  const number = asNumber(value);
  return number === null ? null : number.toFixed(digits);
}

function formatPercent(value, digits = 1) {
  const number = asNumber(value);
  return number === null ? null : `${number.toFixed(digits)}%`;
}

function formatMilliseconds(value) {
  const number = asNumber(value);
  return number === null ? null : `${Math.round(number)} ms`;
}

function extractReadableText(html) {
  return normalizeTextBlock(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, "\"")
  );
}

function normalizeTextBlock(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toLines(text) {
  return normalizeTextBlock(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function hasAny(text, snippets) {
  const lowered = String(text || "").toLowerCase();
  return snippets.some((snippet) => lowered.includes(snippet.toLowerCase()));
}

function findLabeledNumber(lines, labelRegex, lookahead = 4) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!labelRegex.test(line)) {
      continue;
    }

    const inline = line.match(/(-?\d[\d,.]*)/);
    if (inline) {
      return inline[1];
    }

    for (let offset = 1; offset <= lookahead; offset += 1) {
      const nextLine = lines[index + offset];
      if (!nextLine) {
        break;
      }

      const direct = nextLine.match(/^(-?\d[\d,.]*%?)$/);
      if (direct) {
        return direct[1];
      }

      const labeled = nextLine.match(/(-?\d[\d,.]*)/);
      if (labeled) {
        return labeled[1];
      }
    }
  }

  return null;
}

function findPremierBlock(lines) {
  const index = lines.findIndex((line) => /^Premier\b/i.test(line) || /Premier - Season/i.test(line));
  if (index < 0) {
    return { current: null, best: null, wins: null };
  }

  const windowLines = lines.slice(index, index + 12);
  const numbers = windowLines.filter((line) => /^\d[\d,]*$/.test(line));
  const winsLine = windowLines.find((line) => /^Wins:\s*\d[\d,]*/i.test(line));
  const wins = winsLine ? winsLine.match(/\d[\d,]*/)?.[0] || null : null;

  return {
    current: numbers[0] || null,
    best: numbers[1] || null,
    wins
  };
}

function extractPossibleTitle(rawTitle, fallback) {
  const title = String(rawTitle || "").replace(/\s+\|\s+.*/, "").trim();
  return title || fallback;
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeHttpError(error, fallback) {
  if (!error) {
    return fallback;
  }

  if (error.name === "AbortError") {
    return "The request timed out.";
  }

  if (error.status) {
    return `${fallback} (HTTP ${error.status})`;
  }

  return error.message || fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
