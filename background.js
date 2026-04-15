const SETTINGS = Object.freeze({
  leetifyApiKey: "6d7de76a-726a-460d-a41b-34d581bf2013",
  faceitApiKey: "b0ce56e8-e9a2-45e7-82ee-7310a0549d0f",
  enableLeetify: true,
  enableFaceit: true,
  enableCsRep: true,
  enableCsStats: true,
  enableProtectedScraping: true,
  cacheTtlMs: 5 * 60 * 1000,
  protectedScrapeDelayMs: 2200
});

const PROVIDER_ORDER = ["faceit", "leetify"];
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
    faceit: () => getCachedProvider("faceit", steamId, settings, force, () => fetchFaceitData(steamId, settings)),
    leetify: () => getCachedProvider("leetify", steamId, settings, force, () => fetchLeetifyData(steamId, settings)),
    csrep: () => getCachedProvider("csrep", steamId, settings, force, () => fetchCsRepData(steamId, settings)),
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

async function fetchLeetifyData(steamId, settings) {
  if (!settings.enableLeetify) {
    return makeProviderResult("leetify", "disabled", {
      message: "Leetify is disabled."
    });
  }

  const headers = {
    Accept: "application/json"
  };

  if (settings.leetifyApiKey) {
    headers.Authorization = `Bearer ${settings.leetifyApiKey}`;
  }

  try {
    const profile = await fetchJson(
      `https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${encodeURIComponent(steamId)}`,
      { headers }
    );

    if (!profile) {
      return makeProviderResult("leetify", "not_found", {
        message: "No Leetify profile was found for this Steam account."
      });
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
      message: profile.privacy_mode && profile.privacy_mode !== "public" ? `Profile privacy is set to ${profile.privacy_mode}.` : "",
      url: `https://leetify.com/app/profile/${steamId}`,
      competitiveRanks,
      wingmanRanks,
      metrics,
      details: []
    });
  } catch (error) {
    if (error.status === 404) {
      return makeProviderResult("leetify", "not_found", {
        message: "No Leetify profile was found for this Steam account.",
        url: `https://leetify.com/app/profile/${steamId}`
      });
    }

    if (error.status === 401) {
      return makeProviderResult("leetify", "setup", {
        message: "The bundled Leetify API key was rejected.",
        url: `https://leetify.com/app/profile/${steamId}`
      });
    }

    return makeProviderResult("leetify", "error", {
      message: normalizeHttpError(error, "Leetify could not be reached right now."),
      url: `https://leetify.com/app/profile/${steamId}`
    });
  }
}

async function fetchFaceitData(steamId, settings) {
  if (!settings.enableFaceit) {
    return makeProviderResult("faceit", "disabled", {
      message: "FACEIT is disabled."
    });
  }

  if (!settings.faceitApiKey) {
    return makeProviderResult("faceit", "setup", {
      message: "The bundled FACEIT API key is missing."
    });
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

    const metrics = compact([
      makeMetric("ELO", formatInteger(cs2.faceit_elo)),
      makeMetric("Matches", formatInteger(pickAliasedNumber(lifetime, ["Matches"]))),
      makeMetric("Win rate", formatPercent(pickAliasedNumber(lifetime, ["Win Rate %", "Win Rate"]), 1)),
      makeMetric("K/D", kd)
    ]);

    const details = compact([
      makeDetail("Nickname", player.nickname),
      makeDetail("Country", player.country),
      makeDetail("Headshots", formatPercent(pickAliasedNumber(lifetime, ["Average Headshots %", "Headshots %", "Average HS %"]), 1)),
      makeDetail("Longest streak", formatInteger(pickAliasedNumber(lifetime, ["Longest Win Streak"]))),
      makeDetail("Region", normalizeText(cs2.region))
    ]);

    return makeProviderResult("faceit", "ready", {
      title: player.nickname || "FACEIT",
      message: "",
      url: player.faceit_url || `https://www.faceit.com/en/players/${encodeURIComponent(player.nickname || "")}`,
      rankImage,
      rankLabel: resolveFaceitRankLabel(cs2),
      metrics,
      details
    });
  } catch (error) {
    if (error.status === 404) {
      return makeProviderResult("faceit", "not_found", {
        message: "No FACEIT profile was found for this Steam account."
      });
    }

    if (error.status === 401 || error.status === 403) {
      return makeProviderResult("faceit", "setup", {
        message: "The bundled FACEIT API key was rejected."
      });
    }

    return makeProviderResult("faceit", "error", {
      message: normalizeHttpError(error, "FACEIT could not be reached right now.")
    });
  }
}

async function fetchCsRepData(steamId, settings) {
  if (!settings.enableCsRep) {
    return makeProviderResult("csrep", "disabled", {
      message: "CSRep is disabled in the extension settings."
    });
  }

  const profileUrl = `https://csrep.gg/player/${steamId}`;
  const endpoints = [
    `/api/player/${steamId}`,
    `/api/player/${steamId}/reputation`,
    `/api/player/${steamId}/reviews/stats`,
    `/api/player/${steamId}/reports?tab=against`
  ];

  try {
    const settled = await Promise.allSettled(
      endpoints.map((endpoint) =>
        fetchJson(`https://csrep.gg${endpoint}`, {
          credentials: "include",
          headers: {
            Accept: "application/json"
          }
        })
      )
    );

    const profile = getSettledJsonResult(settled[0]);
    const reputation = getSettledJsonResult(settled[1]);
    const reviewStats = getSettledJsonResult(settled[2]);
    const reports = getSettledJsonResult(settled[3]);

    if (!profile && !reputation && !reviewStats && !reports) {
      throw firstSettledError(settled) || new Error("CSRep returned no usable data.");
    }

    return normalizeCsRepApiBundle({ steamId, profile, reputation, reviewStats, reports, profileUrl });
  } catch (error) {
    if ((error.status === 401 || error.status === 403) && settings.enableProtectedScraping) {
      const scraped = await scrapeProtectedPage(profileUrl, settings.protectedScrapeDelayMs);
      return normalizeCsRepScrape(steamId, profileUrl, scraped);
    }

    if (error.status === 404) {
      return makeProviderResult("csrep", "not_found", {
        message: "No CSRep profile was found for this Steam account.",
        url: profileUrl
      });
    }

    if (error.status === 401 || error.status === 403) {
      return makeProviderResult("csrep", "setup", {
        message: "Log in to csrep.gg in this browser to unlock CSRep data.",
        url: profileUrl
      });
    }

    return makeProviderResult("csrep", "error", {
      message: normalizeHttpError(error, "CSRep could not be reached right now."),
      url: profileUrl
    });
  }
}

async function fetchCsStatsData(steamId, settings) {
  if (!settings.enableCsStats) {
    return makeProviderResult("csstats", "disabled", {
      message: "CSStats is disabled in the extension settings."
    });
  }

  const profileUrl = `https://csstats.gg/player/${steamId}`;

  try {
    const html = await fetchText(profileUrl, {
      credentials: "include",
      headers: {
        Accept: "text/html"
      }
    });

    return normalizeCsStatsText(steamId, profileUrl, extractReadableText(html));
  } catch (error) {
    if ((error.status === 401 || error.status === 403) && settings.enableProtectedScraping) {
      const scraped = await scrapeProtectedPage(profileUrl, settings.protectedScrapeDelayMs);
      return normalizeCsStatsText(steamId, profileUrl, scraped.bodyText || "");
    }

    if (error.status === 404) {
      return makeProviderResult("csstats", "not_found", {
        message: "No CSStats page was found for this Steam account.",
        url: profileUrl
      });
    }

    if (error.status === 401 || error.status === 403) {
      return makeProviderResult("csstats", "setup", {
        message: "Log in to csstats.gg in this browser to unlock CSStats data.",
        url: profileUrl
      });
    }

    return makeProviderResult("csstats", "error", {
      message: normalizeHttpError(error, "CSStats could not be reached right now."),
      url: profileUrl
    });
  }
}

function normalizeCsRepApiBundle({ steamId, profile, reputation, reviewStats, reports, profileUrl }) {
  const trust = asNumber(reputation?.trust_rating ?? reputation?.trust_score ?? reputation?.score);
  const positive = asNumber(reviewStats?.positive ?? reputation?.positive);
  const negative = asNumber(reviewStats?.negative ?? reputation?.negative);
  const totalReports = Array.isArray(reports) ? reports.length : null;
  const convictions = Array.isArray(reports)
    ? reports.filter((entry) => asNumber(entry?.case?.final_score) !== null && asNumber(entry.case.final_score) >= 0.75).length
    : null;
  const totalMatches = asNumber(reputation?.metadata?.total_matches);
  const cs2Hours = asNumber(profile?.cs2_hours);

  let status = "Clean";
  if (convictions !== null && convictions > 0) {
    status = "Convicted";
  } else if (trust !== null && trust <= 30) {
    status = "Flagged";
  }

  return makeProviderResult("csrep", "ready", {
    title: profile?.user?.username || profile?.user?.display_name || "CSRep",
    message: "",
    url: profileUrl,
    metrics: compact([
      makeMetric("Trust", formatDecimal(trust, 2)),
      makeMetric("Positive", formatInteger(positive)),
      makeMetric("Reports", formatInteger(totalReports)),
      makeMetric("Status", status)
    ]),
    details: compact([
      makeDetail("Negative", formatInteger(negative)),
      makeDetail("Convictions", formatInteger(convictions)),
      makeDetail("Matches", formatInteger(totalMatches)),
      makeDetail("CS2 hours", formatInteger(cs2Hours)),
      makeDetail("Roles", Array.isArray(profile?.user?.roles) && profile.user.roles.length ? profile.user.roles.join(", ") : null),
      makeDetail("Steam64", steamId)
    ])
  });
}

function normalizeCsRepScrape(steamId, profileUrl, scraped) {
  const text = normalizeTextBlock(scraped?.bodyText || "");

  if (!text) {
    return makeProviderResult("csrep", "error", {
      message: "CSRep loaded, but no readable data was captured.",
      url: profileUrl
    });
  }

  if (hasAny(text, ["just a moment", "verify you are human", "attention required"])) {
    return makeProviderResult("csrep", "setup", {
      message: "CSRep is behind Cloudflare right now. Open the CSRep profile once in this browser, then reload Steam.",
      url: profileUrl
    });
  }

  if (hasAny(text, ["sign in", "log in", "login"])) {
    return makeProviderResult("csrep", "setup", {
      message: "Log in to csrep.gg in this browser to unlock CSRep data.",
      url: profileUrl
    });
  }

  const lines = toLines(text);
  const trust = findLabeledNumber(lines, /trust score/i);
  const positive = findLabeledNumber(lines, /positive reviews?/i) || findLabeledNumber(lines, /^positive$/i);
  const negative = findLabeledNumber(lines, /negative reviews?/i) || findLabeledNumber(lines, /^negative$/i);
  const reports = findLabeledNumber(lines, /reports against player/i) || findLabeledNumber(lines, /^reports$/i);

  const metrics = compact([
    makeMetric("Trust", trust),
    makeMetric("Positive", positive),
    makeMetric("Negative", negative),
    makeMetric("Reports", reports)
  ]);

  if (!metrics.length) {
    return makeProviderResult("csrep", "setup", {
      message: "Open the CSRep profile in this browser once so its protected stats finish loading, then reload Steam.",
      url: profileUrl
    });
  }

  return makeProviderResult("csrep", "ready", {
    title: extractPossibleTitle(scraped?.title, "CSRep"),
    message: "Loaded from the rendered CSRep page.",
    url: profileUrl,
    metrics,
    details: compact([
      makeDetail("Steam64", steamId)
    ])
  });
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

  if (!metrics.length && trackingMessage) {
    return makeProviderResult("csstats", "ready", {
      title: "CSStats",
      message: trackingMessage,
      url: profileUrl,
      metrics: compact([
        makeMetric("Tracking", "Limited")
      ]),
      details: compact([
        makeDetail("Steam64", steamId)
      ])
    });
  }

  if (!metrics.length) {
    return makeProviderResult("csstats", "setup", {
      message: "CSStats loaded, but its profile data was not exposed yet. Open the CSStats page once, then reload Steam.",
      url: profileUrl
    });
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

async function scrapeProtectedPage(url, delayMs) {
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await waitForTabComplete(tab.id);
    await delay(Number(delayMs) || SETTINGS.protectedScrapeDelayMs);

    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        bodyText: document.body ? document.body.innerText : "",
        html: document.documentElement ? document.documentElement.outerHTML : "",
        href: location.href
      })
    });

    return execution?.[0]?.result || { title: "", bodyText: "", html: "", href: url };
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (_error) {
      // Ignore cleanup failures.
    }
  }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      reject(new Error("Timed out while loading a protected provider page."));
    }, timeoutMs);

    const handleUpdate = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(handleUpdate);
        resolve(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(handleUpdate);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(handleUpdate);
        resolve(tab);
      }
    }).catch(() => {
      // Ignore lookup failures here and let the update listener or timeout handle them.
    });
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
    csrep: "CSRep",
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

function getSettledJsonResult(result) {
  return result?.status === "fulfilled" ? result.value?.result ?? result.value : null;
}

function firstSettledError(settled) {
  const failed = settled.find((entry) => entry.status === "rejected");
  return failed ? failed.reason : null;
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
