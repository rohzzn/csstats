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
  enableCsStats: true,
  gcServerUrl: "http://127.0.0.1:3000",
  allstarPublicKey: "3b717a42-ef7e-48d6-bd12-eba0daad9d7f",
  allstarServerKey: "90a30aed-0dfe-4220-9ac6-4e5c36a7c559",
  cacheTtlMs: 5 * 60 * 1000
});

const PROVIDER_ORDER = ["steam", "gc", "faceit", "leetify", "csstats", "allstar"];
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
    csstats: () => getCachedProvider("csstats", steamId, settings, force, () => fetchCsStatsData(steamId, settings)),
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

    const nextProvider = {
      ...provider,
      metrics: applyPremierPreferenceToMetrics(provider.metrics, userSettings.showPeakPremier),
      competitiveRanks: userSettings.showCompetitiveRanks
        ? (Array.isArray(provider.competitiveRanks) ? provider.competitiveRanks : [])
        : [],
      wingmanRanks: userSettings.showCompetitiveRanks
        ? (Array.isArray(provider.wingmanRanks) ? provider.wingmanRanks : [])
        : []
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

function applyPremierPreferenceToMetrics(metrics, preferPeak) {
  const list = Array.isArray(metrics)
    ? metrics.map((metric) => ({ ...metric }))
    : [];

  if (!list.length) {
    return list;
  }

  const bestMetric = list.find((metric) => metric?.label === "Best") || null;

  return list.flatMap((metric) => {
    if (!metric || typeof metric !== "object") {
      return [];
    }

    if (metric.label === "Best") {
      return [];
    }

    if (metric.label !== "Premier") {
      return [metric];
    }

    if (!preferPeak) {
      return [metric];
    }

    const peakValue = resolvePeakPremierValue(metric, bestMetric);
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

function resolvePeakPremierValue(metric, bestMetric) {
  if (bestMetric?.value) {
    return String(bestMetric.value);
  }

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
  if (state === "ready" || state === "not_found") {
    return defaultTtl;
  }

  return 30 * 1000;
}

async function fetchSteamData(steamId, settings) {
  const profileUrl = `https://steamcommunity.com/profiles/${steamId}`;
  const friendCode = getSteamFriendCode(steamId);

  if (!settings.steamApiKey) {
    return makeProviderResult("steam", "ready", {
      title: "Steam",
      url: profileUrl,
      metrics: compact([makeMetric("Friend Code", friendCode)]),
      details: []
    });
  }

  const key = settings.steamApiKey;

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

    // Ban — only shown when account actually has a ban
    let banLabel = null;
    if (banInfo) {
      if (banInfo.VACBanned) {
        banLabel = `VAC ×${banInfo.NumberOfVACBans}`;
      } else if (banInfo.NumberOfGameBans > 0) {
        banLabel = `Game ×${banInfo.NumberOfGameBans}`;
      }
    }

    const metrics = compact([
      makeMetric("Friend Code", friendCode),
      banLabel ? makeMetric("Ban", banLabel) : null
    ]);

    // Always return at least friend code — Steam row shows on every profile
    return makeProviderResult("steam", "ready", {
      title: player?.personaname || "Steam",
      url: profileUrl,
      metrics: metrics.length > 0 ? metrics : compact([makeMetric("Friend Code", friendCode)]),
      details: []
    });
  } catch (_error) {
    return makeProviderResult("steam", "ready", {
      title: "Steam",
      url: profileUrl,
      metrics: compact([makeMetric("Friend Code", friendCode)]),
      details: []
    });
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


async function fetchGcData(steamId, settings) {
  const serverUrl = String(settings?.gcServerUrl || "").trim().replace(/\/+$/, "");
  if (!serverUrl) return makeProviderResult("gc", "disabled", {});
  const steamProfileUrl = `https://steamcommunity.com/profiles/${steamId}`;

  try {
    const data = await fetchJson(`${serverUrl}/profile/${steamId}`, {
      headers: { Accept: "application/json" }
    }, 5000);

    if (!data?.ok) {
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
    const wingmanRanks = (wingmanRank !== null && wingmanRank > 0)
      ? [{
          mapName: "Wingman",
          rank: Math.min(18, Math.max(1, wingmanRank)),
          rankLabel: competitiveRankLabel(wingmanRank),
          image: chrome.runtime.getURL(`wingman/${CSGO_RANK_ASSET_MAP[Math.min(18, wingmanRank)] || "none.svg"}`)
        }]
      : [];

    const competitiveRanks = Array.isArray(data.competitive_ranks)
      ? data.competitive_ranks
          .filter((r) => r.rank_id > 0)
          .map((r) => {
            const rank = Math.min(18, Math.max(1, r.rank_id));
            return {
              mapName: "Competitive",
              rank,
              rankLabel: competitiveRankLabel(rank),
              image: chrome.runtime.getURL(`csranks/${CSGO_RANK_ASSET_MAP[rank] || "none.svg"}`)
            };
          })
          .slice(0, 6)
      : [];

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

    if (!commendations.length && !metrics.length && !wingmanRanks.length && !competitiveRanks.length && !levelMetric && !medals.length) {
      return makeProviderResult("gc", "not_found", {});
    }

    return makeProviderResult("gc", "ready", {
      title: "CS2",
      url: steamProfileUrl,
      commendations,
      medals,
      metrics,
      levelMetric,
      competitiveRanks,
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

  return {
    id: key,
    title: asset.title || `Collectible ${key}`,
    image: chrome.runtime.getURL(`collectibles-images/${asset.file}`)
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

  return 0;
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
  const internalApiUrl = `https://api.cs-prod.leetify.com/api/profile/id/${encodeURIComponent(steamId)}`;
  let internalProfile = null;

  try {
    internalProfile = await fetchJson(internalApiUrl, { headers: { Accept: "application/json" } }, 10000);
  } catch (error) {
    return isLeetifyMissingProfileError(error)
      ? makeProviderResult("leetify", "not_found", { url: profileUrl })
      : makeProviderResult("leetify", "error", {
          url: profileUrl,
          message: "Leetify is unavailable right now."
        });
  }

  const aim = asNumber(internalProfile?.recentGameRatings?.aim);
  const kd = resolveLeetifyKd(internalProfile);
  const winRate = resolveLeetifyWinRate(internalProfile);
  const recentForm = resolveLeetifyRecentForm(internalProfile);
  const recentMatches = resolveLeetifyRecentMatches(internalProfile);
  const peakPremier = resolveLeetifyPeakPremier(internalProfile);
  const premier = resolveLeetifyPremier(internalProfile);
  const competitiveRanks = resolveLeetifyCompetitiveRanks(internalProfile);

  const premierTooltip = peakPremier !== null
    ? `Peak Premier: ${formatInteger(peakPremier)}`
    : "";

  const metrics = compact([
    makeMetric("Premier", formatInteger(premier), "", { tooltip: premierTooltip }),
    makeMetric("Aim", formatDecimal(aim, 1)),
    makeMetric("K/D", formatDecimal(kd, 2)),
    makeMetric("Win Rate", formatPercent(winRate, 1)),
    makeMetric("Last 5", recentForm.join(" "), "", { kind: "recentform", tokens: recentForm })
  ]);

  return makeProviderResult("leetify", "ready", {
    title: internalProfile?.meta?.name || "Leetify",
    message: "",
    url: profileUrl,
    competitiveRanks,
    matches: recentMatches,
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
    const player = await fetchJson(
      `https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${encodeURIComponent(steamId)}`,
      { headers }
    );

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
    const wins = formatInteger(pickAliasedNumber(lifetime, ["Matches"]));
    const hsPercent = formatPercent(
      pickAliasedNumber(lifetime, ["Average Headshots %", "Headshots %", "Average Headshots"]),
      1
    );
    const statusMetric = resolveFaceitStatusMetric(player);

    const metrics = compact([
      makeMetric("ELO", formatInteger(cs2.faceit_elo)),
      makeMetric("Matches", wins),
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
      details: []
    });
  } catch (_error) {
    return makeProviderResult("faceit", "not_found", {});
  }
}

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

    // Step 2: fetch their recent CS2 clips
    const clipsRes = await postJson(GRAPHQL, {
      query: `query($page:Int!,$user:String!,$game:Int){
        videos:clips(search:createdDate,page:$page,user:$user,mobile:false,game:$game){
          data{ _id clipTitle clipImageThumb clipLink views createdDate }
        }
      }`,
      variables: { page: 1, user: user._id, game: 7302 }
    }, { headers });

    const rawClips = clipsRes?.data?.videos?.data || [];
    const clips = rawClips
      .filter((c) => c._id && c.clipImageThumb)
      .slice(0, 8)
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
    csstats: "CSStats",
    gc: "CS2",
    allstar: "AllStar"
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

function resolveLeetifyCompetitiveRanks(internalProfile) {
  return resolveRankEntries(
    getLeetifyLatestRankEntries(internalProfile, isLeetifyCompetitiveGame),
    "csranks"
  );
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

function isLeetifyMissingProfileError(error) {
  return error?.status === 404 || error?.status === 422;
}

function resolveLeetifyPeakPremier(internalProfile) {
  const currentPremier = resolveLeetifyPremier(internalProfile);
  const internalPeak = resolveLeetifyInternalPeakPremier(internalProfile);
  const candidates = [currentPremier, internalPeak].filter((value) => value !== null && value > 0);
  return candidates.length ? Math.max(...candidates) : null;
}

function resolveLeetifyPremier(internalProfile) {
  const recentPremierGame = getLeetifyPremierGames(internalProfile)
    .find((game) => {
      const skillLevel = asNumber(game?.skillLevel);
      return skillLevel !== null && skillLevel > 0;
    });
  return asNumber(recentPremierGame?.skillLevel);
}

function resolveLeetifyKd(internalProfile) {
  const recentGames = getLeetifyRecentGames(internalProfile)
    .map((game) => ({
      kills: asNumber(game?.kills),
      deaths: asNumber(game?.deaths)
    }))
    .filter((game) => game.kills !== null && game.deaths !== null);

  if (!recentGames.length) {
    return null;
  }

  const kills = recentGames.reduce((sum, game) => sum + game.kills, 0);
  const deaths = recentGames.reduce((sum, game) => sum + game.deaths, 0);

  if (deaths <= 0) {
    return null;
  }

  return kills / deaths;
}

function resolveLeetifyWinRate(internalProfile) {
  const recentGames = getLeetifyRecentGames(internalProfile)
    .map((game) => String(game?.matchResult || "").trim().toLowerCase())
    .filter(Boolean);

  if (!recentGames.length) {
    return null;
  }

  const wins = recentGames.filter((result) => result === "win").length;
  return (wins / recentGames.length) * 100;
}

function resolveLeetifyRecentForm(internalProfile) {
  return getLeetifyRecentGames(internalProfile)
    .map((game) => normalizeLeetifyMatchResult(game?.matchResult))
    .filter(Boolean)
    .slice(0, 5);
}

function resolveLeetifyRecentMatches(internalProfile) {
  return getSortedLeetifyGames(internalProfile)
    .filter((game) => String(game?.mapName || "").trim())
    .map((game) => {
      const result = normalizeLeetifyMatchResult(game?.matchResult);
      if (!result) {
        return null;
      }

      const mapKey = normalizeLeetifyMapKey(game?.mapName);
      const kills = asNumber(game?.kills);
      const deaths = asNumber(game?.deaths);
      const scores = Array.isArray(game?.scores) ? game.scores.map((score) => asNumber(score)) : [];
      const partySize = Math.round(asNumber(game?.partySize) || 0);

      return {
        mapKey,
        mapName: formatMatchMapName(game?.mapName),
        mapIcon: resolveLeetifyMapIcon(game?.mapName),
        result,
        mode: resolveLeetifyMatchMode(game),
        score: scores.length >= 2 && scores[0] !== null && scores[1] !== null
          ? `${Math.round(scores[0])}-${Math.round(scores[1])}`
          : "",
        kills: kills === null ? "" : String(Math.round(kills)),
        deaths: deaths === null ? "" : String(Math.round(deaths)),
        party: partySize > 1 ? `Party ${partySize}` : "Solo",
        finishedAt: String(game?.gameFinishedAt || "")
      };
    })
    .filter(Boolean)
    .slice(0, 15);
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

function resolveLeetifyInternalPeakPremier(internalProfile) {
  const premierGames = getLeetifyPremierGames(internalProfile)
    .map((game) => asNumber(game?.skillLevel))
    .filter((value) => value !== null && value > 0);

  return premierGames.length ? Math.max(...premierGames) : null;
}

function getLeetifyPremierGames(internalProfile) {
  return getSortedLeetifyGames(internalProfile)
    .filter((game) => asNumber(game?.rankType) === 11)
    .filter((game) => asNumber(game?.skillLevel) !== null);
}

function getLeetifyRecentGames(internalProfile) {
  const sampleSize = Math.max(
    1,
    Math.round(asNumber(internalProfile?.recentGameRatings?.gamesPlayed) || 30)
  );

  return getSortedLeetifyGames(internalProfile).slice(0, sampleSize);
}

function getLeetifyLatestRankEntries(internalProfile, predicate) {
  const latestByMap = new Map();

  for (const game of getSortedLeetifyGames(internalProfile)) {
    if (!predicate(game)) {
      continue;
    }

    const rank = asNumber(game?.skillLevel);
    if (rank === null || rank <= 0 || rank > 18) {
      continue;
    }

    const mapName = String(game?.mapName || "").trim();
    if (!mapName || latestByMap.has(mapName)) {
      continue;
    }

    latestByMap.set(mapName, {
      map_name: mapName,
      rank
    });
  }

  return Array.from(latestByMap.values());
}

function getSortedLeetifyGames(internalProfile) {
  return (Array.isArray(internalProfile?.games) ? internalProfile.games.slice() : [])
    .filter((game) => game?.isCs2 !== false)
    .sort((left, right) => String(right?.gameFinishedAt || "").localeCompare(String(left?.gameFinishedAt || "")));
}

function resolveLeetifyMatchMode(game) {
  const rankType = asNumber(game?.rankType);
  const dataSource = String(game?.dataSource || "").trim().toLowerCase();

  if (rankType === 11) {
    return "Premier";
  }

  if (rankType === 12 || dataSource.includes("matchmaking_competitive")) {
    return "Competitive";
  }

  if (dataSource.includes("faceit")) {
    return "FACEIT";
  }

  if (dataSource.includes("wingman")) {
    return "Wingman";
  }

  return "Match";
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

function isLeetifyCompetitiveGame(game) {
  const rankType = asNumber(game?.rankType);
  const dataSource = String(game?.dataSource || "").trim().toLowerCase();
  return rankType === 12 || dataSource.includes("matchmaking_competitive");
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
