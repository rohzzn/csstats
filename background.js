importScripts("settings.js");

try {
  importScripts("collectibles-map.js");
} catch (_error) {
  self.SPX_COLLECTIBLE_ASSETS = self.SPX_COLLECTIBLE_ASSETS || {};
}

const SETTINGS = Object.freeze({
  steamApiKey: "2855FF7B8929866B9CD7AD3265D1C0C2",
  faceitApiKey: "b0ce56e8-e9a2-45e7-82ee-7310a0549d0f",
  enableLeetify: true,
  enableFaceit: true,
  // Public GC server first; a self-hosted server on this machine is the fallback.
  // The public server answers with CORS headers for extension origins, so it needs no host permission.
  gcServerUrls: ["https://csstats.rohan.my", "http://127.0.0.1:3000"],
  allstarPublicKey: "3b717a42-ef7e-48d6-bd12-eba0daad9d7f",
  allstarServerKey: "90a30aed-0dfe-4220-9ac6-4e5c36a7c559",
  cacheTtlMs: 5 * 60 * 1000
});

const PROVIDER_ORDER = ["steam", "gc", "faceit", "leetify", "allstar"];
const LEETIFY_API_BASE = "https://api-public.cs-prod.leetify.com";
const LEETIFY_MATCH_LIMIT = 10;
const CLIP_LIMIT = 12; // three rows of four
const LEETIFY_KD_SAMPLE_SIZE = 30;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const VERDICT_DISCLAIMER = "Estimate from public stats, not proof.";
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
  const userSettings = await SPX_readUserSettings();
  const settings = SETTINGS;

  const providerTasks = {
    steam:   () => getCachedProvider("steam",   steamId, settings, force, () => fetchSteamData(steamId, settings)),
    gc:      () => getCachedProvider("gc",      steamId, settings, force, () => fetchGcData(steamId, settings)),
    faceit:  () => getCachedProvider("faceit",  steamId, settings, force, () => fetchFaceitData(steamId, settings)),
    leetify: () => getCachedProvider("leetify", steamId, settings, force, () => fetchLeetifyData(steamId, settings)),
    allstar: () => getCachedProvider("allstar", steamId, settings, force, () => fetchAllstarData(steamId, settings))
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

  try {
    providers.push(buildInsightsProvider(providers, Date.now()));
  } catch (error) {
    providers.push(makeProviderResult("insights", "error", {
      message: error.message || "Insights could not be computed."
    }));
  }

  return {
    ok: true,
    steamId,
    profileUrl,
    fetchedAt: new Date().toISOString(),
    settings: userSettings,
    providers: applyUserSettingsToProviders(providers, userSettings)
  };
}

function applyUserSettingsToProviders(providers, userSettings) {
  return providers.map((provider) => {
    if (!provider || typeof provider !== "object") {
      return provider;
    }

    const metrics = applyPremierPreferenceToMetrics(provider.metrics, userSettings.showPeakPremier);
    const nextProvider = {
      ...provider,
      metrics: provider.id === "faceit"
        ? applyFaceitPeakPreference(metrics, provider.peakElo, provider.peakEloScope, userSettings.showPeakFaceit)
        : metrics,
      competitiveRanks: Array.isArray(provider.competitiveRanks) ? provider.competitiveRanks : [],
      wingmanRanks: Array.isArray(provider.wingmanRanks) ? provider.wingmanRanks : []
    };

    if (provider.id === "leetify" && Array.isArray(provider.matches)) {
      return {
        ...nextProvider,
        matches: provider.matches.slice(0, userSettings.matchesToShow)
      };
    }

    return nextProvider;
  });
}

// Mirrors the Premier toggle: "Peak ELO" with the current value in the tooltip, or the reverse.
function applyFaceitPeakPreference(metrics, peakElo, scope, preferPeak) {
  const peak = asNumber(peakElo);
  const note = scope ? ` (${scope})` : "";

  return (Array.isArray(metrics) ? metrics : []).map((metric) => {
    if (metric?.label !== "ELO") {
      return metric;
    }

    const current = asNumber(metric.value);
    if (peak === null || current === null || peak <= current) {
      return metric;
    }

    return preferPeak
      ? { ...metric, label: "Peak ELO", value: formatInteger(peak), tooltip: `Current ELO: ${metric.value}${note}` }
      : { ...metric, tooltip: `Peak ELO: ${formatInteger(peak)}${note}` };
  });
}

function applyPremierPreferenceToMetrics(metrics, preferPeak) {
  const list = Array.isArray(metrics)
    ? metrics.map((metric) => ({ ...metric }))
    : [];

  return list.flatMap((metric) => {
    if (!metric || typeof metric !== "object") {
      return [];
    }

    if (metric.label !== "Premier" || !preferPeak) {
      return [metric];
    }

    const peakValue = resolvePeakPremierValue(metric);
    if (!peakValue) {
      return [metric];
    }

    return [{
      ...metric,
      label: "Peak Premier",
      value: peakValue,
      tooltip: metric.value ? `Current Premier: ${metric.value}` : metric.tooltip
    }];
  });
}

function resolvePeakPremierValue(metric) {
  const tooltip = String(metric?.tooltip || "");
  const match = tooltip.match(/Peak Premier:\s*([0-9][\d,]*)/i);
  return match ? match[1] : null;
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
  if (providerResult?.partial) {
    return 30 * 1000;
  }

  if (state === "ready" || state === "not_found") {
    return defaultTtl;
  }

  return 30 * 1000;
}

async function fetchSteamData(steamId, settings) {
  const profileUrl = `https://steamcommunity.com/profiles/${steamId}`;
  const friendCode = getSteamFriendCode(steamId);

  const metrics = compact([makeMetric("Friend Code", friendCode)]);
  const fallback = makeProviderResult("steam", "ready", {
    title: "Steam",
    url: profileUrl,
    metrics,
    details: [],
    accountCreated: null,
    bans: null
  });

  if (!settings.steamApiKey) {
    return fallback;
  }

  const key = settings.steamApiKey;

  try {
    const [summaryRes, bansRes] = await Promise.all([
      fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamId}`).catch(() => null),
      fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${steamId}`).catch(() => null)
    ]);

    const player = summaryRes?.response?.players?.[0];
    const created = asNumber(player?.timecreated);
    const bans = normalizeSteamBans(bansRes?.players?.[0]);

    // Always return at least friend code — Steam row shows on every profile
    return makeProviderResult("steam", "ready", {
      title: player?.personaname || "Steam",
      url: profileUrl,
      metrics,
      details: [],
      accountCreated: created !== null && created > 0 ? created : null,
      bans,
      partial: !bans
    });
  } catch (_error) {
    return fallback;
  }
}

function normalizeSteamBans(banInfo) {
  if (!banInfo || typeof banInfo !== "object") {
    return null;
  }

  const vac = Math.max(asNumber(banInfo.NumberOfVACBans) || 0, banInfo.VACBanned ? 1 : 0);
  const game = asNumber(banInfo.NumberOfGameBans) || 0;
  const daysSinceLast = asNumber(banInfo.DaysSinceLastBan);

  return {
    vac,
    game,
    daysSinceLast: vac + game > 0 ? daysSinceLast : null,
    community: Boolean(banInfo.CommunityBanned),
    economy: String(banInfo.EconomyBan || "none")
  };
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

function formatAccountAge(timecreated, now = Date.now()) {
  const ageMs = Math.max(0, now - timecreated * 1000);
  const years = Math.floor(ageMs / YEAR_MS);
  const months = Math.floor((ageMs % YEAR_MS) / (30.44 * 24 * 60 * 60 * 1000));
  if (years >= 1) {
    return months > 0 ? `${years}y ${months}m` : `${years}y`;
  }
  return months > 0 ? `${months}m` : "<1m";
}

function formatCalendarDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}


// A GC server that just failed is skipped for a minute, so an overloaded or hanging server
// costs one slow profile load instead of holding up every panel until the 5 s timeout.
const GC_SERVER_RETRY_MS = 60 * 1000;
const gcServerDownUntil = new Map();

async function fetchGcProfile(steamId, settings) {
  const serverUrls = (settings?.gcServerUrls || [])
    .map((url) => String(url || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);

  for (const serverUrl of serverUrls) {
    if ((gcServerDownUntil.get(serverUrl) || 0) > Date.now()) continue;
    try {
      const data = await fetchJson(`${serverUrl}/profile/${steamId}`, {
        headers: { Accept: "application/json" }
      }, 5000);
      if (data?.ok) {
        gcServerDownUntil.delete(serverUrl);
        return data;
      }
    } catch (_err) {
      // Unreachable, hanging or not ready: try the next server.
    }
    gcServerDownUntil.set(serverUrl, Date.now() + GC_SERVER_RETRY_MS);
  }

  return null;
}

async function fetchGcData(steamId, settings) {
  const steamProfileUrl = `https://steamcommunity.com/profiles/${steamId}`;

  try {
    const data = await fetchGcProfile(steamId, settings);

    if (!data) {
      return makeProviderResult("gc", "disabled", {});
    }

    if (!data.found) {
      return makeProviderResult("gc", "not_found", {});
    }

    const friendly = asNumber(data.commend_friendly);
    const teaching = asNumber(data.commend_teaching);
    const leader   = asNumber(data.commend_leader);
    const playerLevel = asNumber(data.player_level);
    const medals = resolveCollectibleMedals(data);

    // Premier — currently always null (Valve restricted), wired up for when it returns
    const premier     = asNumber(data.premier_rating);
    const wingmanRank = asNumber(data.wingman_rank);

    // Commendations as icon+value pairs
    const commendations = compact([
      friendly !== null ? { type: "friendly", value: formatInteger(friendly), image: chrome.runtime.getURL("commendations/smile.svg") }   : null,
      teaching !== null ? { type: "teaching", value: formatInteger(teaching), image: chrome.runtime.getURL("commendations/teacher.svg") } : null,
      leader   !== null ? { type: "leader",   value: formatInteger(leader),   image: chrome.runtime.getURL("commendations/leader.svg") }  : null
    ]);

    // Rank strips — future-proof for when Valve re-enables rankings
    const wingmanRanks = makeWingmanRanks(wingmanRank);

    const metrics = compact([
      premier !== null ? makeMetric("Premier", formatInteger(premier)) : null
    ]);

    const levelMetric = playerLevel !== null
      ? {
          kind: "cslevel",
          label: "CS Level",
          value: formatInteger(playerLevel),
          image: chrome.runtime.getURL(`levels/${Math.max(1, Math.min(40, Math.round(playerLevel)))}.png`)
        }
      : null;

    if (!commendations.length && !metrics.length && !wingmanRanks.length && !levelMetric && !medals.length) {
      return makeProviderResult("gc", "not_found", {});
    }

    return makeProviderResult("gc", "ready", {
      title: "CS2",
      url: steamProfileUrl,
      commendations,
      medals,
      metrics,
      levelMetric,
      wingmanRanks,
      details: []
    });
  } catch (_err) {
    return makeProviderResult("gc", "disabled", {});
  }
}

function resolveCollectibleMedals(data) {
  const ids = Array.isArray(data?.medal_ids)
    ? data.medal_ids.map((id) => asNumber(id)).filter((id) => id !== null)
    : [];

  if (!ids.length) {
    return [];
  }

  const seen = new Set();
  return ids
    .filter((id) => {
      const key = String(id);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(resolveCollectibleMedal)
    .filter(Boolean)
    .sort(compareCollectibleMedals);
}

function resolveCollectibleMedal(id) {
  const key = String(id || "").trim();
  const asset = self.SPX_COLLECTIBLE_ASSETS?.[key];
  if (!asset?.file) {
    return null;
  }

  const width = asNumber(asset.w);
  const height = asNumber(asset.h);

  return {
    id: key,
    title: asset.title || `Collectible ${key}`,
    image: chrome.runtime.getURL(`collectibles-images/${asset.file}`),
    width: width !== null && width > 0 ? width : null,
    height: height !== null && height > 0 ? height : null
  };
}

function compareCollectibleMedals(left, right) {
  const leftMeta = getCollectibleSortMeta(left);
  const rightMeta = getCollectibleSortMeta(right);

  if (leftMeta.groupPriority !== rightMeta.groupPriority) {
    return leftMeta.groupPriority - rightMeta.groupPriority;
  }

  if (leftMeta.releaseStamp !== rightMeta.releaseStamp) {
    return rightMeta.releaseStamp - leftMeta.releaseStamp;
  }

  if (leftMeta.typePriority !== rightMeta.typePriority) {
    return leftMeta.typePriority - rightMeta.typePriority;
  }

  if (leftMeta.variantPriority !== rightMeta.variantPriority) {
    return leftMeta.variantPriority - rightMeta.variantPriority;
  }

  if (leftMeta.family !== rightMeta.family) {
    return leftMeta.family.localeCompare(rightMeta.family);
  }

  return asNumber(right?.id) - asNumber(left?.id);
}

function getCollectibleSortMeta(medal) {
  const title = String(medal?.title || "").trim();
  const id = asNumber(medal?.id) || 0;

  const proTrophyPriority = inferProTrophyPriority(title);
  const tournamentReleaseStamp = inferTournamentReleaseStamp(title);
  if (proTrophyPriority !== null && tournamentReleaseStamp) {
    return {
      groupPriority: 0,
      releaseStamp: tournamentReleaseStamp,
      typePriority: proTrophyPriority,
      variantPriority: 0,
      family: title
    };
  }

  const serviceReleaseStamp = inferServiceMedalReleaseStamp(title);
  if (serviceReleaseStamp) {
    return {
      groupPriority: 1,
      releaseStamp: serviceReleaseStamp,
      typePriority: 0,
      variantPriority: 0,
      family: title
    };
  }

  const premierReleaseStamp = inferPremierSeasonReleaseStamp(title);
  if (premierReleaseStamp) {
    return {
      groupPriority: 1,
      releaseStamp: premierReleaseStamp,
      typePriority: 1,
      variantPriority: 0,
      family: "premier"
    };
  }

  const specialReleaseStamp = inferSpecialCollectibleReleaseStamp(title);
  if (specialReleaseStamp) {
    return {
      groupPriority: 1,
      releaseStamp: specialReleaseStamp,
      typePriority: 2,
      variantPriority: 0,
      family: title
    };
  }

  const operationReleaseStamp = inferOperationReleaseStamp(title);
  if (operationReleaseStamp) {
    return {
      groupPriority: 1,
      releaseStamp: operationReleaseStamp,
      typePriority: inferOperationTierPriority(title),
      variantPriority: 0,
      family: inferOperationFamily(title)
    };
  }

  const pinMeta = inferPinReleaseMeta(title);
  if (pinMeta) {
    return {
      groupPriority: 1,
      releaseStamp: pinMeta.releaseStamp,
      typePriority: 4,
      variantPriority: pinMeta.variantPriority,
      family: pinMeta.family
    };
  }

  if (tournamentReleaseStamp) {
    return {
      groupPriority: 1,
      releaseStamp: tournamentReleaseStamp,
      typePriority: inferTournamentItemPriority(title),
      variantPriority: 0,
      family: inferTournamentFamily(title)
    };
  }

  return {
    groupPriority: 1,
    releaseStamp: inferFallbackReleaseStamp(title, id),
    typePriority: inferGenericTierPriority(title),
    variantPriority: 0,
    family: title
  };
}

function inferProTrophyPriority(title) {
  if (/^Champion at /i.test(title)) {
    return 0;
  }
  if (/^Finalist at /i.test(title)) {
    return 1;
  }
  if (/^Semifinalist at /i.test(title)) {
    return 2;
  }
  if (/^Quarterfinalist at /i.test(title)) {
    return 3;
  }

  return null;
}

function inferServiceMedalReleaseStamp(title) {
  const match = title.match(/^(\d{4}) Service Medal$/i);
  if (!match) {
    return 0;
  }

  const year = Number(match[1]);
  if (!Number.isInteger(year)) {
    return 0;
  }

  return year === 2015 ? 20150610 : (year * 10000) + 101;
}

function inferPremierSeasonReleaseStamp(title) {
  for (const [pattern, releaseStamp] of COLLECTIBLE_PREMIER_SEASON_RELEASES) {
    if (pattern.test(title)) {
      return releaseStamp;
    }
  }

  // Seasons not in the table yet: roughly two per year after Season Three.
  const word = title.match(/^Premier Season (\w+) Medal$/i)?.[1]?.toLowerCase() || "";
  const season = ["four", "five", "six", "seven", "eight", "nine", "ten"].indexOf(word) + 4;
  return season >= 4 ? (2024 + Math.ceil(season / 2)) * 10000 + (season % 2 ? 101 : 701) : 0;
}

function inferSpecialCollectibleReleaseStamp(title) {
  for (const [pattern, releaseStamp] of COLLECTIBLE_SPECIAL_RELEASES) {
    if (pattern.test(title)) {
      return releaseStamp;
    }
  }

  return 0;
}

function inferOperationReleaseStamp(title) {
  for (const [pattern, releaseStamp] of COLLECTIBLE_OPERATION_RELEASES) {
    if (pattern.test(title)) {
      return releaseStamp;
    }
  }

  return 0;
}

function inferOperationFamily(title) {
  for (const [pattern] of COLLECTIBLE_OPERATION_RELEASES) {
    if (pattern.test(title)) {
      return pattern.source;
    }
  }

  return title;
}

function inferOperationTierPriority(title) {
  if (/Diamond/i.test(title)) {
    return 0;
  }
  if (/Gold/i.test(title)) {
    return 1;
  }
  if (/Silver/i.test(title)) {
    return 2;
  }
  if (/Bronze|Challenge Coin|Mission Coin/i.test(title)) {
    return 3;
  }
  if (/Access Pass|All Access Pass|Premium Pass|Pass/i.test(title)) {
    return 4;
  }

  return 5;
}

function inferPinReleaseMeta(title) {
  const isGenuine = /^Genuine /i.test(title);
  const normalizedTitle = title.replace(/^Genuine\s+/i, "");

  for (const pinFamily of COLLECTIBLE_PIN_RELEASES) {
    if (pinFamily.pattern.test(normalizedTitle)) {
      return {
        family: pinFamily.family,
        releaseStamp: isGenuine && pinFamily.genuineReleaseStamp ? pinFamily.genuineReleaseStamp : pinFamily.releaseStamp,
        variantPriority: isGenuine ? 0 : 1
      };
    }
  }

  return null;
}

function inferTournamentReleaseStamp(title) {
  for (const [pattern, releaseStamp] of COLLECTIBLE_TOURNAMENT_RELEASES) {
    if (pattern.test(title)) {
      return releaseStamp;
    }
  }

  return 0;
}

function inferTournamentFamily(title) {
  for (const [pattern] of COLLECTIBLE_TOURNAMENT_RELEASES) {
    if (pattern.test(title)) {
      return pattern.source;
    }
  }

  return title;
}

function inferTournamentItemPriority(title) {
  if (/Diamond/i.test(title)) {
    return 0;
  }
  if (/Gold/i.test(title)) {
    return 1;
  }
  if (/Silver/i.test(title)) {
    return 2;
  }
  if (/Bronze/i.test(title)) {
    return 3;
  }
  if (/Coin/i.test(title)) {
    return 4;
  }
  if (/Viewer Pass \+ 3 Souvenir Tokens/i.test(title)) {
    return 5;
  }
  if (/Viewer Pass/i.test(title)) {
    return 6;
  }
  if (/Souvenir Token|Souvenir Package/i.test(title)) {
    return 7;
  }

  return 8;
}

function inferGenericTierPriority(title) {
  if (/Diamond/i.test(title)) {
    return 0;
  }
  if (/Gold/i.test(title)) {
    return 1;
  }
  if (/Silver/i.test(title)) {
    return 2;
  }
  if (/Bronze/i.test(title)) {
    return 3;
  }

  return 9;
}

function inferFallbackReleaseStamp(title, id) {
  const explicitYearMatch = title.match(/\b(20\d{2})\b/);
  if (explicitYearMatch) {
    return (Number(explicitYearMatch[1]) * 10000) + 101;
  }

  return 100000 + id;
}

const COLLECTIBLE_SPECIAL_RELEASES = Object.freeze([
  [/5 Year Veteran Coin/i, 20130822],
  [/10 Year Veteran Coin/i, 20181217],
  [/Loyalty Badge/i, 20181206],
  [/10 Year Birthday Coin/i, 20220816],
  [/Global Offensive Badge/i, 20230927]
]);

const COLLECTIBLE_PREMIER_SEASON_RELEASES = Object.freeze([
  [/Premier Season One Medal/i, 20250124],
  [/Premier Season Two Medal/i, 20250715],
  [/Premier Season Three Medal/i, 20260121]
]);

const COLLECTIBLE_OPERATION_RELEASES = Object.freeze([
  [/Operation Riptide|Riptide (?:Challenge Coin|Coin|Premium Pass|Pass)/i, 20210921],
  [/Operation Broken Fang|Broken Fang (?:Challenge Coin|Coin|Premium Pass|Pass)/i, 20201203],
  [/Operation Shattered Web|Shattered Web (?:Challenge Coin|Coin|Premium Pass|Pass)/i, 20191118],
  [/Operation Hydra|Hydra (?:Challenge Coin|Coin|All Access Pass|Pass)/i, 20170523],
  [/Operation Wildfire|Wildfire (?:Challenge Coin|Coin|Access Pass|Pass)/i, 20160217],
  [/Operation Bloodhound|Bloodhound (?:Challenge Coin|Coin|Access Pass|Pass)/i, 20150526],
  [/Operation Vanguard|Vanguard (?:Challenge Coin|Coin|Access Pass|Pass)/i, 20141111],
  [/Operation Breakout|Breakout (?:Challenge Coin|Coin|All Access Pass|Pass)/i, 20140701],
  [/Operation Phoenix|Phoenix (?:Challenge Coin|Coin|Pass)/i, 20140220],
  [/Operation Bravo|Bravo (?:Challenge Coin|Coin|Pass)/i, 20130919],
  [/Operation Payback|Payback (?:Challenge Coin|Coin|Pass)/i, 20130425]
]);

const COLLECTIBLE_PIN_RELEASES = Object.freeze([
  {
    family: "pin-half-life-alyx",
    pattern: /Alyx Pin|Civil Protection Pin|Sustenance! Pin|Vortigaunt Pin|Headcrab Glyph Pin|Health Pin|Lambda Pin|Copper Lambda Pin|CMB Pin|Black Mesa Pin|Combine Helmet Pin|City 17 Pin/i,
    releaseStamp: 20200322,
    genuineReleaseStamp: 20200322
  },
  {
    family: "pin-series-3",
    pattern: /Guardian 3 Pin|Canals Pin|Welcome to the Clutch Pin|Death Sentence Pin|Inferno 2 Pin|Wildfire Pin|Easy Peasy Pin|Aces High Pin|Hydra Pin|Howl Pin|Brigadier General Pin/i,
    releaseStamp: 20180301,
    genuineReleaseStamp: 20180112
  },
  {
    family: "pin-series-2",
    pattern: /Phoenix Pin|Guardian 2 Pin|Bravo Pin|Baggage Pin|Overpass Pin|Office Pin|Cobblestone Pin|Cache Pin|Bloodhound Pin|Valeria Phoenix Pin|Chroma Pin/i,
    releaseStamp: 20160928,
    genuineReleaseStamp: 20160705
  },
  {
    family: "pin-series-1",
    pattern: /Dust II Pin|Guardian Elite Pin|Mirage Pin|Inferno Pin|Italy Pin|Victory Pin|Militia Pin|Nuke Pin|Train Pin|Guardian Pin|Tactics Pin/i,
    releaseStamp: 20160531,
    genuineReleaseStamp: 20150226
  }
]);

const COLLECTIBLE_TOURNAMENT_RELEASES = Object.freeze([
  [/Budapest 2025/i, 20251112],
  [/Austin 2025/i, 20250522],
  [/Shanghai 2024/i, 20241127],
  [/Copenhagen 2024/i, 20240313],
  [/Paris 2023/i, 20230504],
  [/Rio 2022/i, 20221021],
  [/Antwerp 2022/i, 20220503],
  [/Stockholm 2021/i, 20211021],
  [/Berlin 2019/i, 20190814],
  [/Katowice 2019/i, 20190206],
  [/London 2018/i, 20180829],
  [/Boston 2018/i, 20171219],
  [/Krakow 2017/i, 20170707],
  [/Atlanta 2017/i, 20170112],
  [/Cologne 2016/i, 20160624],
  [/Columbus 2016/i, 20160317],
  [/Cluj-Napoca 2015/i, 20151020],
  [/Cologne 2015/i, 20150814],
  [/Katowice 2015/i, 20150226],
  [/DreamHack Winter 2014|DreamHack 2014/i, 20141125],
  [/Cologne 2014/i, 20140804],
  [/Katowice 2014/i, 20140313],
  [/DreamHack 2013/i, 20131201]
]);

async function fetchLeetifyData(steamId, settings) {
  if (!settings.enableLeetify) {
    return makeProviderResult("leetify", "not_found", {});
  }

  const profileUrl = `https://leetify.com/app/profile/${steamId}`;
  const query = `steam64_id=${encodeURIComponent(steamId)}`;
  const options = { headers: { Accept: "application/json" } };
  const fetchMatches = () => fetchJson(`${LEETIFY_API_BASE}/v3/profile/matches?${query}`, options, 10000);
  let [profileResult, matchesResult] = await Promise.allSettled([
    fetchJson(`${LEETIFY_API_BASE}/v3/profile?${query}`, options, 10000),
    fetchMatches()
  ]);

  if (profileResult.status === "rejected") {
    const error = profileResult.reason;
    if (isLeetifyMissingProfileError(error)) {
      // The public API only knows Leetify's own users. Leetify's site also has everyone seen in their
      // matches, so fall back to that data (fetched through the CS Stats server, which allows this extension).
      const site = await fetchLeetifySiteProfile(steamId, settings);
      if (site) {
        const { profile, matches } = convertLeetifySiteProfile(site, steamId);
        const normalized = normalizeLeetifyProfile(profile, indexLeetifyMatchStats(matches, steamId), profileUrl);
        // The site data has no banned-player flags, so leave "played with banned" out rather than show 0.
        return { ...normalized, stats: { ...normalized.stats, bannedLobbies: null, bannedLobbySample: null } };
      }
      return makeProviderResult("leetify", "not_found", { url: profileUrl });
    }

    return makeProviderResult("leetify", "error", {
      url: profileUrl,
      message: describeLeetifyError(error)
    });
  }

  const profile = profileResult.value;
  if (!profile || typeof profile !== "object") {
    return makeProviderResult("leetify", "error", { url: profileUrl, message: "Leetify is unavailable right now." });
  }

  if (isLeetifyPrivateProfile(profile)) {
    return makeProviderResult("leetify", "error", { url: profileUrl, message: "This Leetify profile is private." });
  }

  if (matchesResult.status === "rejected" && !isLeetifyMissingProfileError(matchesResult.reason)) {
    await delay(1500);
    [matchesResult] = await Promise.allSettled([fetchMatches()]);
  }

  const matchStats = matchesResult.status === "fulfilled"
    ? indexLeetifyMatchStats(matchesResult.value, steamId)
    : new Map();
  const normalized = normalizeLeetifyProfile(profile, matchStats, profileUrl);

  return {
    ...normalized,
    stats: { ...normalized.stats, ...summarizeBannedLobbies(matchesResult.status === "fulfilled" ? matchesResult.value : null) },
    partial: matchesResult.status !== "fulfilled"
  };
}

async function fetchLeetifySiteProfile(steamId, settings) {
  const serverUrls = (settings?.gcServerUrls || [])
    .map((url) => String(url || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);

  for (const serverUrl of serverUrls) {
    if ((gcServerDownUntil.get(serverUrl) || 0) > Date.now()) continue;
    try {
      const data = await fetchJson(`${serverUrl}/providers/leetify/${steamId}`, {
        headers: { Accept: "application/json" }
      }, 8000);
      if (data?.recent || data?.history?.games?.length) return data;
    } catch (error) {
      // 404 means Leetify has nothing on this player; anything else, try the next server.
      if (error?.status === 404) return null;
    }
  }

  return null;
}

// Reshape Leetify's site data (meta, sidebar-games, recent-games/5v5, match-history) into the public v3
// profile and matches shapes, so the rest of the pipeline treats both sources the same way.
function convertLeetifySiteProfile(site, steamId) {
  const recent = site?.recent || {};
  const sidebar = site?.sidebar || {};
  const games = Array.isArray(site?.history?.games) ? site.history.games : [];
  const sidebarRanks = Array.isArray(sidebar.ranks) ? sidebar.ranks : [];
  const rankFor = (source) => sidebarRanks.find((rank) => rank?.dataSource === source) || null;
  const premier = rankFor("matchmaking");
  const wingman = rankFor("matchmaking_wingman");
  const totalMatches = Object.values(sidebar.platforms || {})
    .reduce((sum, platform) => sum + (asNumber(platform?.totalGames) || 0), 0);

  // Leetify hides match dates for players who haven't joined it. The list is newest first, and the
  // stable sorts downstream keep that order when every date is empty.
  const recentMatches = games.map((game, index) => ({
    id: `leetify-site-${index}`,
    finished_at: "",
    data_source: game?.dataSource,
    outcome: game?.matchResult,
    rank: game?.rank,
    rank_type: game?.matchmakingRankType,
    map_name: game?.mapName,
    leetify_rating: game?.leetifyRating,
    score: game?.scores
  }));

  // Newest competitive rank per map, as the public API's ranks.competitive.
  const competitive = [];
  for (const game of games) {
    if (asNumber(game?.matchmakingRankType) !== 12 || !game?.mapName) continue;
    if (competitive.some((entry) => entry.map_name === game.mapName)) continue;
    competitive.push({ map_name: game.mapName, rank: game.rank });
  }

  return {
    profile: {
      name: site?.meta?.name || "",
      privacy_mode: "public",
      winrate: recent.winRate,
      total_matches: totalMatches || recent.matchesPlayed,
      first_match_date: null,
      bans: [],
      ranks: {
        premier: premier?.latest,
        premier_peak: premier?.max,
        wingman: wingman?.latest,
        competitive
      },
      rating: {
        aim: recent.aimRating,
        utility: recent.utilityRating
      },
      stats: {
        reaction_time_ms: recent.reactionTime,
        preaim: recent.preaim,
        accuracy_head: recent.accuracyHead,
        accuracy_enemy_spotted: recent.accuracyEnemySpotted
      },
      recent_matches: recentMatches
    },
    matches: recentMatches.map((match, index) => ({
      id: match.id,
      finished_at: "",
      stats: [{ steam64_id: steamId, total_kills: games[index]?.kills, total_deaths: games[index]?.deaths }]
    }))
  };
}

// Leetify flags every match that had a player who was banned afterwards.
function summarizeBannedLobbies(payload) {
  const matches = Array.isArray(payload) ? payload : Array.isArray(payload?.matches) ? payload.matches : [];
  if (!matches.length) {
    return { bannedLobbies: null, bannedLobbySample: null };
  }

  return {
    bannedLobbies: matches.filter((match) => match?.has_banned_player === true).length,
    bannedLobbySample: matches.length
  };
}

function normalizeLeetifyProfile(profile, matchStats, profileUrl) {
  const ranks = profile?.ranks || {};
  const rating = profile?.rating || {};
  const stats = profile?.stats || {};
  const recentMatches = sortByFinishedAt(profile?.recent_matches);
  const premier = asNumber(ranks.premier);
  const peakPremier = resolveLeetifyPeakPremier(ranks, recentMatches);
  const recentForm = recentMatches
    .map((match) => normalizeLeetifyMatchResult(match?.outcome))
    .filter(Boolean)
    .slice(0, 5);
  const winRate = asNumber(profile?.winrate);

  const metrics = compact([
    makeMetric("Premier", premier !== null && premier > 0 ? formatInteger(premier) : null, "", {
      tooltip: peakPremier !== null ? `Peak Premier: ${formatInteger(peakPremier)}` : ""
    }),
    makeMetric("Aim", formatDecimal(rating.aim, 1)),
    makeMetric("K/D", formatDecimal(resolveLeetifyRecentKd(matchStats), 2)),
    makeMetric("Win Rate", formatPercent(winRate === null ? null : (winRate <= 1 ? winRate * 100 : winRate), 1)),
    makeMetric("Last 5", recentForm.join(" "), "", { kind: "recentform", tokens: recentForm })
  ]);

  const recentModes = recentMatches.map(resolveLeetifyMatchMode);
  const modes = new Set(recentModes);

  return makeProviderResult("leetify", "ready", {
    title: String(profile?.name || "").trim() || "Leetify",
    message: "",
    url: profileUrl,
    metrics,
    competitiveRanks: resolveRankEntries(ranks.competitive, "csranks"),
    wingmanRanks: makeWingmanRanks(asNumber(ranks.wingman)),
    matches: resolveLeetifyMatches(recentMatches, matchStats),
    stats: {
      reactionTimeMs: asNumber(stats.reaction_time_ms),
      preaim: asNumber(stats.preaim),
      accuracyHead: asNumber(stats.accuracy_head),
      accuracyEnemySpotted: asNumber(stats.accuracy_enemy_spotted),
      aimRating: asNumber(rating.aim),
      utilityRating: asNumber(rating.utility),
      totalMatches: asNumber(profile?.total_matches),
      firstMatchDate: profile?.first_match_date ? String(profile.first_match_date) : null,
      tracksFaceit: modes.has("FACEIT"),
      faceitShare: recentModes.length ? recentModes.filter((mode) => mode === "FACEIT").length / recentModes.length : null,
      sources: LEETIFY_SOURCE_ORDER.filter((mode) => modes.has(mode)),
      faceitLevel: asNumber(ranks.faceit),
      faceitElo: asNumber(ranks.faceit_elo)
    },
    bans: Array.isArray(profile?.bans) ? profile.bans : [],
    details: []
  });
}

const LEETIFY_SOURCE_ORDER = Object.freeze(["Premier", "Competitive", "Wingman", "FACEIT", "Pro", "Esplay"]);

function describeLeetifyError(error) {
  if (error?.status === 403) {
    return "This Leetify profile is private.";
  }

  return error?.status === 429 ? "Leetify is busy, try again in a minute." : "Leetify is unavailable right now.";
}

function isLeetifyPrivateProfile(profile) {
  const mode = String(profile?.privacy_mode || "").trim().toLowerCase();
  const hasMatches = Array.isArray(profile?.recent_matches) && profile.recent_matches.length > 0;
  return Boolean(mode) && mode !== "public" && !hasMatches;
}

function indexLeetifyMatchStats(payload, steamId) {
  const matches = Array.isArray(payload) ? payload : Array.isArray(payload?.matches) ? payload.matches : [];
  const index = new Map();

  for (const match of matches) {
    const player = Array.isArray(match?.stats)
      ? match.stats.find((entry) => String(entry?.steam64_id || "") === steamId)
      : null;
    if (!match?.id || !player) {
      continue;
    }

    index.set(String(match.id), {
      finishedAt: String(match.finished_at || ""),
      kills: asNumber(player.total_kills),
      deaths: asNumber(player.total_deaths),
      score: resolveLeetifyTeamScore(match.team_scores, asNumber(player.initial_team_number))
    });
  }

  return index;
}

function resolveLeetifyTeamScore(teamScores, teamNumber) {
  if (!Array.isArray(teamScores) || teamNumber === null) {
    return "";
  }

  const ours = teamScores.find((team) => asNumber(team?.team_number) === teamNumber);
  const theirs = teamScores.find((team) => asNumber(team?.team_number) !== teamNumber);
  return formatScorePair([ours?.score, theirs?.score]);
}

function formatScorePair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) {
    return "";
  }

  const ours = asNumber(pair[0]);
  const theirs = asNumber(pair[1]);
  return ours === null || theirs === null ? "" : `${Math.round(ours)}-${Math.round(theirs)}`;
}

function resolveLeetifyRecentKd(matchStats) {
  const recent = Array.from(matchStats.values())
    .filter((match) => match.kills !== null && match.deaths !== null)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))
    .slice(0, LEETIFY_KD_SAMPLE_SIZE);
  const kills = recent.reduce((sum, match) => sum + match.kills, 0);
  const deaths = recent.reduce((sum, match) => sum + match.deaths, 0);

  return recent.length && deaths > 0 ? kills / deaths : null;
}

function resolveLeetifyPeakPremier(ranks, recentMatches) {
  const values = [
    asNumber(ranks?.premier),
    asNumber(ranks?.premier_peak),
    ...recentMatches
      .filter((match) => asNumber(match?.rank_type) === 11)
      .map((match) => asNumber(match?.rank))
  ].filter((value) => value !== null && value > 0);

  return values.length ? Math.max(...values) : null;
}

function resolveLeetifyMatches(recentMatches, matchStats) {
  return recentMatches
    .map((match) => {
      const result = normalizeLeetifyMatchResult(match?.outcome);
      const rawMapName = String(match?.map_name || "").trim();
      if (!result || !rawMapName) {
        return null;
      }

      const joined = matchStats.get(String(match?.id || "")) || null;

      return {
        id: String(match?.id || ""),
        mapKey: normalizeLeetifyMapKey(rawMapName),
        mapName: formatMatchMapName(rawMapName),
        mapIcon: resolveLeetifyMapIcon(rawMapName),
        result,
        mode: resolveLeetifyMatchMode(match),
        score: formatScorePair(match?.score) || joined?.score || "",
        kills: joined?.kills === null || joined?.kills === undefined ? "" : String(Math.round(joined.kills)),
        deaths: joined?.deaths === null || joined?.deaths === undefined ? "" : String(Math.round(joined.deaths)),
        rating: formatLeetifyRating(match?.leetify_rating),
        finishedAt: String(match?.finished_at || "")
      };
    })
    .filter(Boolean)
    .slice(0, LEETIFY_MATCH_LIMIT);
}

function formatLeetifyRating(value) {
  const number = asNumber(value);
  if (number === null) {
    return "";
  }

  const scaled = number * 100;
  return `${scaled > 0 ? "+" : ""}${scaled.toFixed(2)}`;
}

function sortByFinishedAt(list) {
  return (Array.isArray(list) ? list.filter((item) => item && typeof item === "object") : [])
    .sort((left, right) => String(right.finished_at || "").localeCompare(String(left.finished_at || "")));
}

function makeWingmanRanks(rank) {
  if (rank === null || rank === undefined || rank <= 0) {
    return [];
  }

  const normalizedRank = Math.max(1, Math.min(18, Math.round(rank)));
  return [{
    mapName: "Wingman",
    rank: normalizedRank,
    rankLabel: competitiveRankLabel(normalizedRank),
    image: chrome.runtime.getURL(`wingman/${CSGO_RANK_ASSET_MAP[normalizedRank]}`)
  }];
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
    const player = await fetchJson(
      `https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${encodeURIComponent(steamId)}`,
      { headers }
    );

    const [stats, history] = await Promise.all([
      fetchJson(
        `https://open.faceit.com/data/v4/players/${encodeURIComponent(player.player_id)}/stats/cs2`,
        { headers }
      ).catch(() => null),
      fetchFaceitEloHistory(player.player_id)
    ]);

    const cs2 = player?.games?.cs2 || {};
    const lifetime = stats?.lifetime || {};
    const rankImage = resolveFaceitRankAsset(cs2);
    const kd = formatDecimal(
      pickAliasedNumber(lifetime, ["Average K/D Ratio", "Average K/D", "K/D Ratio"]),
      2
    );
    const lifetimeMatches = pickAliasedNumber(lifetime, ["Matches"]);
    const hsPercent = formatPercent(
      pickAliasedNumber(lifetime, ["Average Headshots %", "Headshots %", "Average Headshots"]),
      1
    );
    const statusMetric = resolveFaceitStatusMetric(player);

    const metrics = compact([
      makeMetric("ELO", formatInteger(cs2.faceit_elo)),
      makeMetric("Matches", formatInteger(lifetimeMatches)),
      makeMetric("K/D", kd),
      makeMetric("HS%", hsPercent),
      statusMetric
    ]);

    if (!metrics.length) {
      return makeProviderResult("faceit", "not_found", {});
    }

    return makeProviderResult("faceit", "ready", {
      title: player.nickname || "FACEIT",
      url: player.faceit_url || `https://www.faceit.com/en/players/${encodeURIComponent(player.nickname || "")}`,
      rankImage,
      rankLabel: resolveFaceitRankLabel(cs2),
      metrics,
      details: [],
      lifetimeMatches,
      skillLevel: asNumber(cs2.skill_level),
      elo: asNumber(cs2.faceit_elo),
      peakElo: history ? Math.max(asNumber(cs2.faceit_elo) || 0, history.peak) : null,
      peakEloScope: history?.capped ? `peak over the last ${formatInteger(history.matches)} matches` : ""
    });
  } catch (_error) {
    return makeProviderResult("faceit", "not_found", {});
  }
}

// FACEIT's open API has no ELO history; its site's stats feed carries the post-match ELO of every
// ELO-affecting game, 100 rows per page. Read newest-first until a short page, capped at 1,000 games.
async function fetchFaceitEloHistory(playerId) {
  if (!playerId) {
    return null;
  }

  const peaks = [];
  let matches = 0;
  for (let page = 0; page < FACEIT_HISTORY_MAX_PAGES; page += 1) {
    const rows = await fetchJson(
      `https://www.faceit.com/api/stats/v1/stats/time/users/${encodeURIComponent(playerId)}/games/cs2?page=${page}&size=${FACEIT_HISTORY_PAGE_SIZE}`,
      { headers: { Accept: "application/json" } },
      8000
    ).catch(() => null);
    if (!Array.isArray(rows)) {
      break;
    }

    matches += rows.length;
    for (const row of rows) {
      const elo = asNumber(row?.elo);
      if (elo !== null && elo > 0) {
        peaks.push(elo);
      }
    }

    if (rows.length < FACEIT_HISTORY_PAGE_SIZE) {
      return peaks.length ? { peak: Math.max(...peaks), matches, capped: false } : null;
    }
  }

  return peaks.length ? { peak: Math.max(...peaks), matches, capped: true } : null;
}

const FACEIT_HISTORY_PAGE_SIZE = 100;
const FACEIT_HISTORY_MAX_PAGES = 10;

function resolveFaceitStatusMetric(player) {
  const membershipType = String(player?.membership_type || "").trim().toLowerCase();
  const memberships = Array.isArray(player?.memberships)
    ? player.memberships
        .map((membership) => String(membership || "").trim().toLowerCase())
        .filter(Boolean)
    : [];
  const flags = new Set([membershipType, ...memberships].filter(Boolean));

  if (flags.has("premium")) {
    return makeMetric("Status", "Premium");
  }

  if (flags.has("plus")) {
    return makeMetric("Status", "Plus");
  }

  if (Boolean(player?.verified)) {
    return makeMetric("Status", "Verified");
  }

  return null;
}


function resolveAllstarThumbnail(raw) {
  if (!raw) return null;
  // CS2 clips/thumbs live in Backblaze B2
  if (raw.startsWith("b2://allstar-cs2-clip-prod/")) {
    return `https://f005.backblazeb2.com/file/allstar-cs2-clip-prod/${raw.slice(27)}`;
  }
  if (raw.startsWith("b2://")) return null;
  // Older clips use AllStar's own CDN
  return `https://media.allstar.gg/${raw}`;
}

async function fetchAllstarData(steamId, settings) {
  const key = settings.allstarServerKey;
  if (!key) return makeProviderResult("allstar", "disabled", {});

  const GRAPHQL = "https://a1.allstar.gg/graphql";
  const headers = { "Content-Type": "application/json", "x-api-key": key };

  try {
    // Step 1: resolve Steam ID → AllStar user ID
    const userRes = await postJson(GRAPHQL, {
      query: `query($s:String!){ playerSearch(gameIdentifier:$s,game:CS){ success user{ _id username avatarUrl } } }`,
      variables: { s: steamId }
    }, { headers });

    const user = userRes?.data?.playerSearch?.user;
    if (!user?._id) {
      return makeProviderResult("allstar", "not_found", {});
    }

    // Step 2: fetch their best-rated CS2 clips (Allstar's own "Best" ranking). Pages hold 10 clips,
    // so a second page is needed to fill three rows of four.
    const fetchClipsPage = (page) => postJson(GRAPHQL, {
      query: `query($page:Int!,$user:String!,$game:Int){
        videos:clips(search:best,page:$page,user:$user,mobile:false,game:$game){
          data{ _id clipTitle clipImageThumb clipLink views createdDate }
        }
      }`,
      variables: { page, user: user._id, game: 7302 }
    }, { headers }).then((res) => res?.data?.videos?.data || []);

    const rawClips = await fetchClipsPage(1);
    if (rawClips.length >= 10) {
      rawClips.push(...await fetchClipsPage(2).catch(() => []));
    }

    const seenClipIds = new Set();
    const clips = rawClips
      .filter((c) => c._id && c.clipImageThumb && !seenClipIds.has(c._id) && seenClipIds.add(c._id))
      .slice(0, CLIP_LIMIT)
      .map((c) => ({
        id:        c._id,
        title:     c.clipTitle || "CS2 Clip",
        thumbnail: resolveAllstarThumbnail(c.clipImageThumb),
        video:     resolveAllstarThumbnail(c.clipLink),
        url:       `https://allstar.gg/clip?clip=${c._id}`,
        views:     asNumber(c.views) ?? 0,
        timestamp: asNumber(c.createdDate) ?? 0,
        source:    "allstar"
      }))
      .filter((c) => c.thumbnail !== null);

    if (!clips.length) {
      return makeProviderResult("allstar", "not_found", {});
    }

    return makeProviderResult("allstar", "ready", {
      title: user.username || "AllStar",
      url: `https://allstar.gg/u/${user._id}`,
      clips,
      metrics: []
    });
  } catch (_err) {
    return makeProviderResult("allstar", "not_found", {});
  }
}

function buildInsightsProvider(providers, now) {
  const byId = new Map((Array.isArray(providers) ? providers : []).filter(Boolean).map((provider) => [provider.id, provider]));
  const steam = readyProvider(byId.get("steam"));
  const leetify = readyProvider(byId.get("leetify"));
  const faceit = readyProvider(byId.get("faceit"));
  const totals = resolveTotalMatches(leetify?.stats, faceit);
  const leetifyError = byId.get("leetify")?.state === "error" ? byId.get("leetify").message : "";

  return makeProviderResult("insights", "ready", {
    verdict: computeVerdict(collectVerdictInputs({ steam, leetify, faceit, totals, now, leetifyError })),
    metrics: buildInsightMetrics({ steam, leetify, totals, now })
  });
}

function readyProvider(provider) {
  return provider?.state === "ready" ? provider : null;
}

function buildInsightMetrics({ steam, leetify, totals, now }) {
  const stats = leetify?.stats || {};
  const reactionTimeMs = asNumber(stats.reactionTimeMs);
  const created = asNumber(steam?.accountCreated);

  return compact([
    makeMetric("Time to Damage", reactionTimeMs !== null && reactionTimeMs > 0 ? `${Math.round(reactionTimeMs)}ms` : null, "", {
      tooltip: "Average time from spotting an enemy to dealing damage (Leetify). Lower is faster."
    }),
    makeMetric("Total Matches", totals ? formatInteger(totals.total) : null, "", { tooltip: totals?.breakdown }),
    makeMetric("Account Age", created ? formatAccountAge(created, now) : null, "", {
      tooltip: created ? `Steam account created ${formatCalendarDate(created * 1000)}` : ""
    }),
    makeMetric("Utility", formatDecimal(stats.utilityRating, 1), "", { tooltip: "Leetify utility rating (50 = average)" })
  ]);
}

function resolveTotalMatches(leetifyStats, faceit) {
  const leetifyTotal = asNumber(leetifyStats?.totalMatches);
  const faceitTotal = asNumber(faceit?.lifetimeMatches);

  if (leetifyTotal === null || leetifyTotal <= 0) {
    return faceitTotal ? { total: faceitTotal, breakdown: `FACEIT ${formatInteger(faceitTotal)}` } : null;
  }

  const sources = Array.isArray(leetifyStats.sources) && leetifyStats.sources.length
    ? ` (${leetifyStats.sources.join(" · ")})`
    : "";
  const leetifyPart = `Leetify ${formatInteger(leetifyTotal)}${sources}`;

  if (!faceitTotal) {
    return { total: leetifyTotal, breakdown: leetifyPart };
  }

  if (!leetifyStats.tracksFaceit) {
    return { total: leetifyTotal + faceitTotal, breakdown: `${leetifyPart} + FACEIT ${formatInteger(faceitTotal)}` };
  }

  // Leetify already imports this player's FACEIT games and the overlap is unknown: the larger count is a safe floor.
  return faceitTotal > leetifyTotal
    ? { total: faceitTotal, breakdown: `FACEIT ${formatInteger(faceitTotal)} · ${leetifyPart}, overlap counted once` }
    : { total: leetifyTotal, breakdown: leetifyPart };
}

function collectVerdictInputs({ steam, leetify, faceit, totals, now, leetifyError = "" }) {
  const stats = leetify?.stats || {};
  const bans = steam?.bans || {};
  const created = asNumber(steam?.accountCreated);

  return {
    bansKnown: Boolean(steam?.bans),
    noDataReason: leetifyError,
    vacBans: bans.vac,
    gameBans: bans.game,
    daysSinceLastBan: bans.daysSinceLast,
    leetifyBans: leetify?.bans,
    leetifyMatches: stats.totalMatches,
    reactionTimeMs: stats.reactionTimeMs,
    preaim: stats.preaim,
    accuracyHead: stats.accuracyHead,
    accuracyEnemySpotted: stats.accuracyEnemySpotted,
    aimRating: stats.aimRating,
    totalMatches: totals ? totals.total : null,
    accountAgeYears: created ? Math.max(0, (now - created * 1000) / YEAR_MS) : null,
    faceitLevel: firstNumber(faceit?.skillLevel, stats.faceitLevel),
    faceitElo: firstNumber(faceit?.elo, stats.faceitElo)
  };
}

const VERDICT_NUMBER_KEYS = Object.freeze([
  "vacBans", "gameBans", "daysSinceLastBan", "leetifyMatches", "reactionTimeMs", "preaim", "accuracyHead",
  "accuracyEnemySpotted", "aimRating", "totalMatches", "accountAgeYears", "faceitLevel", "faceitElo"
]);

const VERDICT_LABELS = Object.freeze({
  legit: "Legit",
  suspicious: "Suspicious",
  likely: "Likely Cheating",
  banned: "Banned",
  unverified: "No Data"
});

// tiers are [limit, points, note]: "below" scores value < limit, "atLeast" value >= limit, "above" value > limit.
const VERDICT_MECHANIC_RULES = Object.freeze([
  {
    key: "reactionTimeMs",
    compare: "below",
    tiers: [[330, 3, "very fast"], [380, 2, "fast"], [420, 1, "quick"]],
    describe: (value, note) => `Time to damage ${Math.round(value)}ms (${note})`
  },
  {
    key: "preaim",
    compare: "below",
    tiers: [[4, 3, "inhuman"], [5, 2, "very precise"], [6, 1, "precise"]],
    describe: (value, note) => `Preaim ${value.toFixed(1)}° (${note})`
  },
  {
    key: "accuracyHead",
    compare: "above",
    tiers: [[40, 3, "extreme"], [33, 2, "very high"], [28, 1, "high"]],
    describe: (value, note) => `Headshot accuracy ${value.toFixed(1)}% (${note})`
  },
  {
    key: "aimRating",
    compare: "atLeast",
    tiers: [[99, 2, "near max"], [95, 1, "elite"]],
    describe: (value, note) => `Aim rating ${value.toFixed(1)} (${note})`
  },
  {
    key: "accuracyEnemySpotted",
    compare: "above",
    tiers: [[55, 2, "very high"], [48, 1, "high"]],
    describe: (value, note) => `Spotted accuracy ${value.toFixed(1)}% (${note})`
  }
]);

function computeVerdict(rawInputs) {
  const inputs = normalizeVerdictInputs(rawInputs);
  const banVerdict = resolveBanVerdict(inputs);
  if (banVerdict) {
    return banVerdict;
  }

  const banNote = inputs.bansKnown === false ? ["Steam ban status unavailable"] : [];
  if (!hasVerdictStats(inputs)) {
    return makeVerdict("unverified", [...banNote, inputs.noDataReason || "Not enough public match data"], null);
  }

  const mechanics = scoreVerdictMechanics(inputs);
  const mechanicalScore = sumVerdictPoints(mechanics);
  const signals = [
    ...mechanics,
    ...(mechanicalScore >= 2 ? scoreVerdictContext(inputs) : []),
    ...scoreVerdictMitigators(inputs)
  ];
  const score = sumVerdictPoints(signals);
  const level = score >= 6 ? "likely" : score >= 3 ? "suspicious" : "legit";
  const reasons = signals.map((signal) => signal.reason);

  if (mechanicalScore <= 0) {
    reasons.unshift("Aim stats within normal human range");
  }

  // Never call an account legit without a ban check.
  if (banNote.length) {
    return makeVerdict(level === "legit" ? "unverified" : level, [...banNote, ...reasons], score);
  }

  return makeVerdict(level, reasons, score);
}

function normalizeVerdictInputs(rawInputs) {
  const inputs = { ...(rawInputs || {}) };
  for (const key of VERDICT_NUMBER_KEYS) {
    inputs[key] = asNumber(inputs[key]);
  }

  inputs.vacBans = inputs.vacBans || 0;
  inputs.gameBans = inputs.gameBans || 0;
  inputs.leetifyBans = Array.isArray(inputs.leetifyBans) ? inputs.leetifyBans.filter(Boolean) : [];
  return inputs;
}

function makeVerdict(level, reasons, score, label = VERDICT_LABELS[level]) {
  return {
    level,
    label,
    reasons,
    score,
    disclaimer: VERDICT_DISCLAIMER,
    tooltip: [label, ...reasons, VERDICT_DISCLAIMER].join("\n")
  };
}

function resolveBanVerdict(inputs) {
  const lastBan = formatLastBan(inputs.daysSinceLastBan);
  const when = lastBan ? ` · ${lastBan}` : "";
  const leetifyReasons = inputs.leetifyBans.map(describeLeetifyBan);

  if (inputs.vacBans > 0) {
    return makeVerdict("banned", compact([
      `${pluralize(inputs.vacBans, "VAC ban")}${when}`,
      inputs.gameBans > 0 ? pluralize(inputs.gameBans, "game ban") : null,
      ...leetifyReasons
    ]), null, "VAC Banned");
  }

  if (inputs.gameBans > 0) {
    return makeVerdict("banned", [`${pluralize(inputs.gameBans, "game ban")}${when}`, ...leetifyReasons], null, "Game Banned");
  }

  return leetifyReasons.length ? makeVerdict("banned", leetifyReasons, null, "Banned") : null;
}

function describeLeetifyBan(ban) {
  if (typeof ban !== "object") {
    return `${String(ban)} ban on record (Leetify)`;
  }

  const platform = String(ban.platform || ban.source || "").trim();
  const since = formatCalendarDate(ban.banned_since || ban.bannedSince || ban.created_at || "");
  const name = { faceit: "FACEIT", steam: "Steam", esea: "ESEA" }[platform.toLowerCase()] || platform;
  return `${name ? `${name} ban` : "Ban"} on record (Leetify)${since ? ` · since ${since}` : ""}`;
}

function hasVerdictStats(inputs) {
  const mechanics = VERDICT_MECHANIC_RULES.map((rule) => inputs[rule.key]);
  return inputs.leetifyMatches !== null && inputs.leetifyMatches >= 10 && mechanics.some((value) => value !== null && value > 0);
}

function scoreVerdictMechanics(inputs) {
  return VERDICT_MECHANIC_RULES
    .map((rule) => {
      const value = inputs[rule.key];
      if (value === null || value <= 0) {
        return null;
      }

      const tier = rule.tiers.find(([limit]) => compareVerdictLimit(value, limit, rule.compare));
      return tier ? { points: tier[1], reason: rule.describe(value, tier[2]) } : null;
    })
    .filter(Boolean);
}

function compareVerdictLimit(value, limit, compare) {
  if (compare === "below") {
    return value < limit;
  }

  return compare === "atLeast" ? value >= limit : value > limit;
}

function scoreVerdictContext(inputs) {
  const signals = [];
  const age = inputs.accountAgeYears;

  if (age !== null && age < 1) {
    const months = Math.floor(age * 12);
    signals.push({ points: 2, reason: `New Steam account (${months > 0 ? `${pluralize(months, "month")} old` : "under a month old"})` });
  } else if (age !== null && age < 2) {
    signals.push({ points: 1, reason: "Steam account under 2 years old" });
  }

  if (inputs.totalMatches !== null && inputs.totalMatches < 100) {
    signals.push({ points: 1, reason: `Only ${pluralize(inputs.totalMatches, "match", "matches")} tracked` });
  }

  return signals;
}

function scoreVerdictMitigators(inputs) {
  const signals = [];

  if (inputs.faceitLevel !== null && inputs.faceitLevel >= 9) {
    signals.push({ points: -2, reason: `FACEIT level ${Math.round(inputs.faceitLevel)} (anti-cheat)` });
  } else if (inputs.faceitElo !== null && inputs.faceitElo >= 2000) {
    signals.push({ points: -2, reason: `FACEIT ${formatInteger(inputs.faceitElo)} ELO (anti-cheat)` });
  }

  if (inputs.totalMatches !== null && inputs.totalMatches >= 1500) {
    signals.push({ points: -1, reason: `${formatInteger(inputs.totalMatches)} matches on record (long history)` });
  }

  if (inputs.accountAgeYears !== null && inputs.accountAgeYears >= 8) {
    signals.push({ points: -1, reason: `Steam account ${Math.floor(inputs.accountAgeYears)} years old` });
  }

  return signals;
}

function sumVerdictPoints(signals) {
  return signals.reduce((sum, signal) => sum + signal.points, 0);
}

function formatLastBan(days) {
  if (days === null || days === undefined || days < 0) {
    return "";
  }

  if (days === 0) {
    return "banned today";
  }

  return days < 365 ? `last ${pluralize(days, "day")} ago` : `last ${pluralize(Math.floor(days / 365), "year")} ago`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatInteger(count)} ${Math.round(count) === 1 ? singular : plural}`;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== null) {
      return number;
    }
  }

  return null;
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
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

async function postJson(url, body, options = {}) {
  const response = await fetchWithTimeout(url, {
    ...options,
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...options.headers }
  });

  if (!response.ok) {
    throw await buildHttpError(response);
  }

  return response.json();
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
    gc: "CS2",
    allstar: "AllStar",
    insights: "Insights"
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
        mapName: formatMatchMapName(entry?.map_name),
        rank: normalizedRank,
        rankLabel: competitiveRankLabel(normalizedRank),
        image: chrome.runtime.getURL(`${folder}/${assetName}`)
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.rank - left.rank)
    .slice(0, 6);
}

function isLeetifyMissingProfileError(error) {
  return error?.status === 404 || error?.status === 422;
}

function normalizeLeetifyMatchResult(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "win" || normalized.includes("win")) {
    return "W";
  }

  if (
    normalized === "loss" ||
    normalized === "lose" ||
    normalized.includes("loss") ||
    normalized.includes("lose")
  ) {
    return "L";
  }

  if (
    normalized === "draw" ||
    normalized === "tie" ||
    normalized.includes("draw") ||
    normalized.includes("tie")
  ) {
    return "D";
  }

  return null;
}

function resolveLeetifyMatchMode(match) {
  const rankType = asNumber(match?.rank_type);
  const dataSource = String(match?.data_source || "").trim().toLowerCase();

  if (rankType === 11) {
    return "Premier";
  }

  if (rankType === 12 || dataSource === "matchmaking_competitive") {
    return "Competitive";
  }

  if (rankType === 7 || dataSource === "matchmaking_wingman") {
    return "Wingman";
  }

  if (dataSource === "faceit") {
    return "FACEIT";
  }

  if (dataSource === "hltv") {
    return "Pro";
  }

  return dataSource === "esplay" ? "Esplay" : "Match";
}

function normalizeLeetifyMapKey(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveLeetifyMapIcon(value) {
  const key = normalizeLeetifyMapKey(value);
  if (!key) {
    return "";
  }

  const isCommunityMap = LEETIFY_COMMUNITY_MAP_ICON_KEYS.has(key);
  const isCoreMap = LEETIFY_CORE_MAP_ICON_KEYS.has(key);
  if (!isCommunityMap && !isCoreMap) {
    return "";
  }

  const basePath = isCommunityMap
    ? `maps-icons/community/${key}.svg`
    : `maps-icons/${key}.svg`;

  return chrome.runtime.getURL(basePath);
}

function formatMatchMapName(value) {
  return formatCompetitiveMapName(value).replace(/(\d+)/g, " $1").replace(/\s+/g, " ").trim();
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

const LEETIFY_CORE_MAP_ICON_KEYS = new Set([
  "ar_baggage",
  "ar_shoots",
  "cs_italy",
  "cs_office",
  "de_ancient",
  "de_anubis",
  "de_cache",
  "de_dust",
  "de_dust2",
  "de_inferno",
  "de_mirage",
  "de_nuke",
  "de_overpass",
  "de_train",
  "de_vertigo"
]);

const LEETIFY_COMMUNITY_MAP_ICON_KEYS = new Set([
  "ar_pool_day",
  "cs_agency",
  "de_assembly",
  "de_basalt",
  "de_brewery",
  "de_dogtown",
  "de_edin",
  "de_grail",
  "de_jura",
  "de_memento",
  "de_mills",
  "de_palais",
  "de_thera",
  "de_whistle"
]);

function makeMetric(label, value, meta = "", options = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return {
    label,
    value: String(value),
    meta: meta ? String(meta) : "",
    tooltip: options?.tooltip ? String(options.tooltip) : "",
    kind: options?.kind ? String(options.kind) : "",
    tokens: Array.isArray(options?.tokens) ? options.tokens.map((token) => String(token)) : []
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
