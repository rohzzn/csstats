(function () {
  const ROOT_ID = "spx-cs2-profile-intel";
  const MATCHES_ID = "spx-cs2-matches-intel";
  const CLIPS_ID = "spx-cs2-clips-intel";
  const HEADER_MEDALS_ID = "spx-cs2-header-medals";
  const TOOLTIP_ID = "spx-tooltip";
  const PLAYER_ID = "spx-clip-player";
  const ROOT_SELECTOR = `#${ROOT_ID}, #${MATCHES_ID}, #${CLIPS_ID}, #${HEADER_MEDALS_ID}`;
  const DEFAULT_ERROR = "The extension could not load provider data.";
  const MATCH_LIMIT = 10;
  const CLIP_LIMIT = 8;
  const MEDAL_GAP = 8;
  const MEDAL_MIN_SLOT = 14;
  const MEDAL_NAV_WIDTH = 58;
  const VERDICT_LEVELS = ["legit", "suspicious", "likely", "banned", "unverified"];
  const VERDICT_NOTE = "Estimate from public stats, not proof.";
  const COMMENDATION_LABELS = Object.freeze({ friendly: "Friendly", teaching: "Teacher", leader: "Leader" });
  const RESULT_NAMES = Object.freeze({ W: "win", L: "loss", D: "draw" });
  const RESULT_LABELS = Object.freeze({ W: "Win", L: "Loss", D: "Draw" });
  const SEASON_WORDS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 });
  const PREMIER_PIN_HEIGHT = 30;
  // FACEIT CS2 skill levels by ELO (level 10 is 2,001+).
  const FACEIT_LEVEL_FLOORS = [1, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
  // Second grid row, column-aligned under Aim · K/D · Win Rate · Last 5.
  const INSIGHT_ORDER = ["Time to Damage", "Utility", "Total Matches", "Account Age"];
  const PROFILE_PATH = /^\/(id|profiles)\/[^/]+\/?$/;
  const PREMIER_BADGE_ASSETS = Object.freeze({
    grey: chrome.runtime.getURL("premier/0-4999.png"),
    lightblue: chrome.runtime.getURL("premier/5000-9999.png"),
    blue: chrome.runtime.getURL("premier/10000-14999.png"),
    purple: chrome.runtime.getURL("premier/15000-19999.png"),
    pink: chrome.runtime.getURL("premier/20000-24999.png"),
    red: chrome.runtime.getURL("premier/25000-29999.png"),
    gold: chrome.runtime.getURL("premier/30000+.png")
  });
  const MAP_GLYPH = `<svg class="spx-map-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 4.5 3.5 6.6v12.9L9 17.4l6 2.1 5.5-2.1V4.5L15 6.6 9 4.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 4.5v12.9M15 6.6v12.9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  const PLAY_GLYPH = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8.5 5.8v12.4a.6.6 0 0 0 .9.5l9.7-6.2a.6.6 0 0 0 0-1L9.4 5.3a.6.6 0 0 0-.9.5Z" fill="currentColor"/></svg>`;
  const FULLSCREEN_GLYPH = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const CLOSE_GLYPH = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  const CHEVRON_GLYPHS = Object.freeze({
    previous: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    next: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  });

  const state = {
    steamId: null,
    profileUrl: null,
    root: null,
    matchesRoot: null,
    clipsRoot: null,
    settings: { ...SPX_DEFAULT_USER_SETTINGS },
    loadToken: 0,
    html: new Map(),
    medals: { list: [], key: "", start: 0, count: 0, slots: [], listBudget: 0, signature: "", observer: null },
    tooltipAnchor: null,
    clips: [],
    player: { open: false, list: [], index: 0, opener: null, scroll: "" }
  };

  let resizeQueued = false;

  window.addEventListener("resize", () => {
    hideTooltip();
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      layoutHeaderMedals(false);
      fitPremierPins();
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!Object.keys(changes || {}).some((key) => SPX_isUserSettingKey(key))) return;
    if (!state.steamId) return;

    loadBundle();
  });

  installTooltip();
  start();

  function start() {
    if (!PROFILE_PATH.test(window.location.pathname) && !document.documentElement.hasAttribute("data-spx-harness")) {
      return;
    }

    waitForSteamProfile()
      .then((context) => {
        mount(context);
        loadBundle();
      })
      .catch((error) => {
        console.warn("[Steam CS2 Profile Intel]", error.message);
      });
  }

  async function waitForSteamProfile() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const context = detectContext();
      if (context) {
        return context;
      }

      await delay(250);
    }

    throw new Error("Steam profile data was not available on this page.");
  }

  function detectContext() {
    const steamId = resolveSteamId();
    const target = resolveShowcaseTarget();

    if (!steamId || !target) {
      return null;
    }

    return {
      steamId,
      profileUrl: resolveProfileUrl(),
      target
    };
  }

  function resolveSteamId() {
    if (window.g_rgProfileData && window.g_rgProfileData.steamid) {
      return String(window.g_rgProfileData.steamid);
    }

    const profileMatch = window.location.pathname.match(/\/profiles\/(\d{17})/);
    if (profileMatch) {
      return profileMatch[1];
    }

    for (const script of document.querySelectorAll("script:not([src])")) {
      const inlineMatch = script.textContent.match(/g_rgProfileData\s*=\s*\{[^}]*"steamid":"(\d{17})"/);
      if (inlineMatch) {
        return inlineMatch[1];
      }
    }

    return null;
  }

  function resolveProfileUrl() {
    if (window.g_rgProfileData && window.g_rgProfileData.url) {
      return String(window.g_rgProfileData.url);
    }

    return window.location.href;
  }

  function resolveShowcaseTarget() {
    const area = document.querySelector(".profile_customization_area");
    if (area) {
      return area;
    }

    // Private / showcase-less profiles still have the persona header; other pages do not.
    if (!document.querySelector(".profile_header_centered_persona")) {
      return null;
    }

    return document.querySelector(".profile_leftcol") || document.querySelector(".profile_rightcol");
  }

  function mount(context) {
    state.steamId = context.steamId;
    state.profileUrl = context.profileUrl;

    state.root = ensureRoot(ROOT_ID);
    if (!context.target.contains(state.root)) {
      context.target.prepend(state.root);
    }

    state.matchesRoot = ensureRoot(MATCHES_ID);
    state.root.insertAdjacentElement("afterend", state.matchesRoot);

    state.clipsRoot = ensureRoot(CLIPS_ID);
    state.matchesRoot.insertAdjacentElement("afterend", state.clipsRoot);

    bindRoot(state.root, handleStatsClick);
    bindRoot(state.matchesRoot, null);
    bindRoot(state.clipsRoot, handleClipsClick);

    renderLoading();
  }

  function ensureRoot(id) {
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      root.className = "profile_customization spx-showcase";
    }
    return root;
  }

  function bindRoot(root, onClick) {
    if (!root || root.dataset.spxBound === "1") return;
    root.dataset.spxBound = "1";
    root.addEventListener("error", handleImageError, true);
    if (onClick) {
      root.addEventListener("click", onClick);
    }
  }

  async function loadBundle() {
    const token = ++state.loadToken;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "SPX_GET_PROFILE_BUNDLE",
        steamId: state.steamId,
        profileUrl: state.profileUrl
      });
      if (token !== state.loadToken) return;

      if (!response || !response.ok) {
        renderFatal(response?.error || DEFAULT_ERROR);
        return;
      }

      const settings = await SPX_readUserSettings();
      if (token !== state.loadToken) return;

      state.settings = settings;
      renderAll({ ...response, settings });
    } catch (error) {
      if (token === state.loadToken) {
        renderFatal(error?.message || DEFAULT_ERROR);
      }
    }
  }

  // ── Render pipeline ───────────────────────────────

  function renderAll(bundle) {
    const view = buildView(bundle);
    const focusKey = getFocusKey();

    setHtml(state.root, renderStats(view));
    applyPremierBadgeArt(state.root);
    fitPremierPins();
    document.fonts?.ready?.then(fitPremierPins);
    setSection(state.matchesRoot, renderMatchesSection(view));
    setSection(state.clipsRoot, renderClipsSection(view));
    renderHeaderMedals(view.medals);
    restoreFocus(focusKey);
  }

  function renderLoading() {
    clearHeaderMedals();
    setSection(state.matchesRoot, "");
    setSection(state.clipsRoot, "");
    setHtml(state.root, renderShell("Stats", `
      <div class="spx-skeleton" role="status" aria-label="Loading stats">
        ${[1, 2, 3].map((index) => `<div class="spx-skeleton-row"><span class="spx-skeleton-bar spx-skeleton-bar-${index}"></span></div>`).join("")}
      </div>
    `));
  }

  function renderFatal(message) {
    clearHeaderMedals();
    setSection(state.matchesRoot, "");
    setSection(state.clipsRoot, "");
    setHtml(state.root, renderShell("Stats", `<div class="spx-inline-note">${escapeHtml(message)}</div>`));
  }

  function setHtml(root, html) {
    if (!root || state.html.get(root.id) === html) return;
    if (state.tooltipAnchor && root.contains(state.tooltipAnchor)) {
      hideTooltip();
    }
    state.html.set(root.id, html);
    root.innerHTML = html;
  }

  function setSection(root, html) {
    if (!root) return;
    root.hidden = !html;
    setHtml(root, html);
  }

  function renderShell(title, content) {
    return `
      <div class="profile_customization_header spx-showcase-header">${escapeHtml(title)}</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">${content}</div>
      </div>
    `;
  }

  function buildView(bundle) {
    const providers = new Map(
      listOf(bundle?.providers)
        .filter((provider) => provider.id)
        .map((provider) => [provider.id, provider])
    );
    const ready = (id) => {
      const provider = providers.get(id);
      return provider && provider.state === "ready" ? provider : null;
    };
    const gc = ready("gc");
    const medals = listOf(gc?.medals).filter((medal) => medal.image);

    return {
      steam: ready("steam"),
      gc,
      faceit: ready("faceit"),
      leetify: ready("leetify"),
      insights: ready("insights"),
      allstar: ready("allstar"),
      settings: resolveUserSettings(bundle),
      premierPins: collectPremierPins(medals),
      medals: medals.filter((medal) => !getPremierSeason(medal))
    };
  }

  function getFocusKey() {
    const active = document.activeElement;
    return active && active.closest && active.closest(ROOT_SELECTOR)
      ? active.getAttribute("data-spx-focus")
      : null;
  }

  function restoreFocus(key) {
    if (!key) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;

    const target = document.querySelector(`[data-spx-focus="${key}"]`);
    if (target) {
      target.focus({ preventScroll: true });
    }
  }

  // ── Stats panel ───────────────────────────────────

  function renderStats(view) {
    const rows = [
      renderSteamRow(view),
      renderPerformanceRow(view)
    ].filter(Boolean);
    const strip = renderRankStrip(collectRanks(view));

    if (!rows.length && !strip) {
      return renderShell("Stats", `<div class="spx-inline-note">No stats visible right now.</div>`);
    }

    if (strip) {
      if (rows.length > 1) {
        rows[rows.length - 1].body += strip;
      } else {
        rows.push({ id: "ranks", body: strip });
      }
    }

    return renderShell("Stats", `
      <div class="spx-row-list">
        ${rows.map((row) => `<article class="spx-provider-row spx-provider-${row.id}">${row.body}</article>`).join("")}
      </div>
    `);
  }

  function renderSteamRow({ steam, gc, leetify, insights, premierPins }) {
    const commendations = firstList(gc?.commendations, steam?.commendations);
    const verdict = insights?.verdict?.label ? insights.verdict : null;
    const bannedLobbies = renderBannedLobbiesMetric(leetify?.stats);

    const primary = [
      commendations.length ? renderCommendationStrip(commendations) : "",
      premierPins.length ? renderPremierPins(premierPins) : ""
    ].filter(Boolean);
    const secondary = [
      verdict ? renderVerdictMetric(verdict) : "",
      bannedLobbies
    ].filter(Boolean);

    if (!primary.length && !secondary.length) {
      return null;
    }

    return {
      id: "steam",
      body: `
        <div class="spx-stat-line spx-stat-line-steam">
          ${primary.length ? `<div class="spx-steam-primary">${primary.join("")}</div>` : ""}
          ${secondary.length ? `<div class="spx-metric-grid spx-steam-secondary">${secondary.join("")}</div>` : ""}
        </div>
      `
    };
  }

  function renderPerformanceRow({ leetify, faceit, insights }) {
    const leetifyMetrics = listOf(leetify?.metrics);
    const premier = leetifyMetrics.find(isPremierMetric);
    const ratings = [
      premier ? renderPremierMetric(premier) : "",
      faceit ? renderFaceitMetric(faceit) : ""
    ].filter(Boolean);
    const primary = leetify
      ? leetifyMetrics.filter((metric) => !isPremierMetric(metric))
      : ["K/D", "HS%"].map((label) => listOf(faceit?.metrics).find((metric) => metric.label === label)).filter(Boolean);
    const secondary = sortByOrder(listOf(insights?.metrics), INSIGHT_ORDER);

    if (!ratings.length && !primary.length && !secondary.length) {
      return null;
    }

    // Rail column (ratings) + four stat columns; every cell is placed explicitly so a
    // missing value never shifts the columns. Rows: [Premier, primary…] [FACEIT, insights…].
    const hasRail = ratings.length > 0;
    const firstColumn = hasRail ? 2 : 1;
    const statRows = [primary, secondary].filter((list) => list.length);
    const cells = [
      ...ratings.map((item, index) => `<div class="spx-perf-rating spx-r${index + 1}">${item}</div>`),
      ...statRows.flatMap((list, rowIndex) => list.slice(0, 4).map((metric, index) => renderMetric(metric, {
        focusable: list === secondary,
        className: [
          "spx-stat",
          `spx-r${rowIndex + 1}`,
          `spx-c${firstColumn + index}`,
          index > 0 || ratings[rowIndex] ? "spx-sep" : ""
        ].filter(Boolean).join(" ")
      })))
    ];

    return {
      id: leetify ? "leetify" : "performance",
      body: `<div class="spx-perf${hasRail ? "" : " spx-perf-norail"}">${cells.join("")}</div>`
    };
  }

  function sortByOrder(metrics, order) {
    const rank = (metric) => {
      const index = order.indexOf(metric.label);
      return index === -1 ? order.length : index;
    };
    return metrics.slice().sort((left, right) => rank(left) - rank(right));
  }

  function collectRanks({ gc, leetify }) {
    const wingman = firstList(gc?.wingmanRanks, leetify?.wingmanRanks).find((rank) => rank.image);
    const ranks = listOf(leetify?.competitiveRanks).filter((rank) => rank.image);
    return wingman ? [{ ...wingman, mapName: "Wingman" }, ...ranks] : ranks;
  }

  function renderRankStrip(ranks) {
    if (!ranks.length) {
      return "";
    }

    return `
      <div class="spx-competitive-strip">
        ${ranks.map((entry) => {
          const label = entry.rankLabel || "Unranked";
          return `
            <div class="spx-competitive-rank" data-spx-tip="${escapeAttribute(`${entry.mapName}: ${label}`)}">
              <img class="spx-competitive-image" src="${escapeAttribute(entry.image)}" width="74" height="30" alt="${escapeAttribute(label)}" decoding="async" />
              <div class="spx-competitive-map">${escapeHtml(entry.mapName)}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // Newest season first; one medal per season (the highest variant if several came back).
  function collectPremierPins(medals) {
    const bySeason = new Map();
    for (const medal of medals) {
      const season = getPremierSeason(medal);
      const current = bySeason.get(season);
      if (season && (!current || Number(medal.id) > Number(current.id))) {
        bySeason.set(season, medal);
      }
    }

    return [...bySeason.entries()]
      .sort(([left], [right]) => right - left)
      .map(([season, medal]) => ({ season, medal }));
  }

  // Keep the Steam row on one line: when it would wrap (big commendation counts, long verdict,
  // narrow profile), drop Premier pins from the oldest season first.
  function fitPremierPins() {
    const line = state.root?.querySelector(".spx-stat-line-steam");
    const group = line?.querySelector(".spx-premier-pins");
    if (!group) return;

    const pins = [...group.querySelectorAll(".spx-premier-pin")];
    group.hidden = false;
    pins.forEach((pin) => { pin.hidden = false; });

    for (let index = pins.length - 1; index >= 0 && steamRowWraps(line); index -= 1) {
      pins[index].hidden = true;
      group.hidden = index === 0;
    }
  }

  function steamRowWraps(line) {
    const primary = line.querySelector(".spx-steam-primary");
    if (!primary) return false;

    const items = [...primary.children].filter((item) => !item.hidden);
    const first = items[0]?.getBoundingClientRect();
    if (first && items.some((item) => item.getBoundingClientRect().top >= first.bottom - 1)) {
      return true;
    }

    const commendations = primary.querySelector(".spx-commend-strip");
    if (commendations && commendations.getBoundingClientRect().height > 34) {
      return true;
    }

    // Below the narrow breakpoint the verdict group drops to its own line by design.
    const secondary = line.querySelector(".spx-steam-secondary");
    if (!secondary || getComputedStyle(secondary).flexBasis === "100%") {
      return false;
    }

    return secondary.getBoundingClientRect().top >= primary.getBoundingClientRect().bottom - 1;
  }

  function getPremierSeason(medal) {
    const match = String(medal?.title || "").match(/^Premier Season (\w+) Medal$/i);
    if (!match) {
      return 0;
    }

    const word = match[1].toLowerCase();
    return SEASON_WORDS[word] || Number(word) || 0;
  }

  function renderPremierPins(pins) {
    return `
      <div class="spx-premier-pins" role="list" aria-label="Premier season medals">
        ${pins.map(({ season, medal }) => {
          const title = medal.title || `Premier Season ${season} Medal`;
          const width = getMedalWidth(medal, PREMIER_PIN_HEIGHT);
          return `
            <span class="spx-premier-pin" role="listitem" data-spx-tip="${escapeAttribute(title)}">
              <img src="${escapeAttribute(medal.image)}" ${width ? `width="${width}" ` : ""}height="${PREMIER_PIN_HEIGHT}" alt="${escapeAttribute(title)}" decoding="async" />
            </span>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderCommendationStrip(commendations) {
    return `
      <div class="spx-commend-strip">
        ${commendations.map((commendation) => {
          const label = COMMENDATION_LABELS[commendation.type] || "Commendation";
          return `
            <div class="spx-commend-item spx-commend-${escapeAttribute(commendation.type)}" role="img" aria-label="${escapeAttribute(`${commendation.value} ${label} commendations`)}" data-spx-tip="${escapeAttribute(label)}">
              <img class="spx-commend-icon" src="${escapeAttribute(commendation.image)}" width="19" height="19" alt="" decoding="async" />
              <span class="spx-commend-value">${escapeHtml(commendation.value)}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderVerdictMetric(verdict) {
    const level = VERDICT_LEVELS.includes(verdict.level) ? verdict.level : "unverified";
    const reasons = textList(verdict.reasons);
    const note = verdict.disclaimer || VERDICT_NOTE;
    const label = String(verdict.label);

    return `
      <div class="spx-metric spx-metric-verdict spx-verdict-${level}" tabindex="0" role="group"
        data-spx-tip="${escapeAttribute(reasons.join("\n"))}"
        data-spx-tip-title="${escapeAttribute(label)}"
        data-spx-tip-note="${escapeAttribute(note)}"
        aria-label="${escapeAttribute(["Verdict: " + label, ...reasons, note].join(". "))}">
        <div class="spx-metric-value"><span class="spx-verdict-tag">${escapeHtml(label)}</span></div>
      </div>
    `;
  }

  // "Played with banned": recent matches that had a player who was banned afterwards.
  function renderBannedLobbiesMetric(stats) {
    const count = Number(stats?.bannedLobbies);
    const sample = Number(stats?.bannedLobbySample);
    if (!Number.isFinite(count) || !Number.isFinite(sample) || sample <= 0) {
      return "";
    }

    const tip = count === 0
      ? `None of their last ${sample} matches had a player who was later banned (Leetify).`
      : `${count} of their last ${sample} matches had a player who was later banned (Leetify).`;

    return `
      <div class="spx-metric spx-metric-banned${count / sample >= 0.1 ? " spx-banned-high" : ""}" tabindex="0" role="group"
        aria-label="${escapeAttribute(`Played with banned players: ${count} of ${sample} matches`)}" data-spx-tip="${escapeAttribute(tip)}">
        <div class="spx-metric-label">Played with banned</div>
        <div class="spx-metric-value">${count} / ${sample}</div>
      </div>
    `;
  }

  function renderFaceitMetric(faceit) {
    const elo = listOf(faceit.metrics).find((metric) => metric.label === "ELO" || metric.label === "Peak ELO");
    const isPeak = elo?.label === "Peak ELO";
    const tooltip = String(elo?.tooltip || "");
    const other = (tooltip.match(isPeak ? /Current ELO:\s*([0-9][\d,]*)/i : /Peak ELO:\s*([0-9][\d,]*)/i) || [])[1] || "";
    const scope = (tooltip.match(/\(([^)]+)\)\s*$/) || [])[1] || "";

    // The level badge follows the ELO on display (Challenger stays Challenger).
    const shownLevel = isPeak ? getFaceitLevel(elo.value) : 0;
    const keepBadge = !shownLevel || (shownLevel >= 10 && /\/11\.svg$/.test(String(faceit.rankImage || "")));
    const badgeImage = keepBadge ? faceit.rankImage : chrome.runtime.getURL(`faceit/${shownLevel}.svg`);
    const label = keepBadge ? (faceit.rankLabel ? `FACEIT ${faceit.rankLabel}` : "FACEIT") : `FACEIT Level ${shownLevel} (peak)`;
    const badge = badgeImage
      ? `<span class="spx-badge spx-faceit-badge" data-spx-tip="${escapeAttribute(label)}"><img class="spx-level-image" src="${escapeAttribute(badgeImage)}" width="30" height="30" alt="${escapeAttribute(label)}" decoding="async" /></span>`
      : "";

    if (!badge && !elo) {
      return "";
    }

    // No label, like the Premier badge: the tooltip says whether this is the peak or current ELO.
    const body = elo ? `<span class="spx-metric-value spx-faceit-elo">${escapeHtml(elo.value)}</span>` : "";

    if (!other) {
      return `<div class="spx-metric spx-metric-faceit">${badge}${body}</div>`;
    }

    const tip = [
      isPeak ? `Peak FACEIT ELO · click to show current (${other})` : `Current FACEIT ELO · click to show peak (${other})`,
      scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : ""
    ].filter(Boolean).join("\n");

    return `
      <button type="button" class="spx-metric spx-metric-faceit" data-spx-faceit-toggle="1" data-spx-focus="faceit" aria-pressed="${isPeak ? "true" : "false"}"
        aria-label="${escapeAttribute(`${isPeak ? "Peak" : "Current"} FACEIT ELO ${elo.value}. Show ${isPeak ? "current" : "peak"} ELO`)}"
        data-spx-tip="${escapeAttribute(tip)}">${badge}${body}</button>
    `;
  }

  function getFaceitLevel(value) {
    const elo = parseInt(String(value || "").replace(/,/g, ""), 10);
    if (!Number.isFinite(elo) || elo <= 0) {
      return 0;
    }

    let level = 1;
    FACEIT_LEVEL_FLOORS.forEach((floor, index) => {
      if (elo >= floor) {
        level = index + 1;
      }
    });
    return level;
  }

  function renderMetric(metric, { focusable = false, className = "" } = {}) {
    if (metric.kind === "recentform") {
      return renderRecentFormMetric(metric, className);
    }

    if (isPremierMetric(metric)) {
      return renderPremierMetric(metric);
    }

    const tip = metric.tooltip ? ` data-spx-tip="${escapeAttribute(metric.tooltip)}"` : "";
    const tab = focusable && metric.tooltip
      ? ` tabindex="0" role="group" aria-label="${escapeAttribute(`${metric.label}: ${metric.value}`)}"`
      : "";

    return `
      <div class="spx-metric${className ? ` ${className}` : ""}"${tip}${tab}>
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-metric-value">${escapeHtml(metric.value)}</div>
      </div>
    `;
  }

  function renderRecentFormMetric(metric, className = "") {
    const tokens = textList(metric.tokens);
    const summary = tokens.map((token) => RESULT_LABELS[token] || token).join(", ");

    return `
      <div class="spx-metric spx-metric-form${className ? ` ${className}` : ""}">
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-form-list" role="img" aria-label="${escapeAttribute(`${metric.label}: ${summary}`)}">
          ${tokens.map((token) => renderResultToken(token)).join("")}
        </div>
      </div>
    `;
  }

  function renderResultToken(token) {
    const name = RESULT_NAMES[token] || "draw";
    return `<span class="spx-form-token spx-form-token-${name}" aria-hidden="true">${escapeHtml(token)}</span>`;
  }

  function isPremierMetric(metric) {
    return metric?.label === "Premier" || metric?.label === "Peak Premier";
  }

  function renderPremierMetric(metric) {
    const isPeak = metric.label === "Peak Premier";
    const value = String(metric.value || "");
    const rating = parseInt(value.replace(/,/g, ""), 10);
    const tier = getPremierTier(rating);
    const otherMatch = String(metric.tooltip || "").match(isPeak ? /Current Premier:\s*([0-9][\d,]*)/i : /Peak Premier:\s*([0-9][\d,]*)/i);
    const other = otherMatch ? otherMatch[1] : "";
    const badge = `<span class="spx-premier-badge" data-spx-premier-tier="${tier}"><span class="spx-metric-value">${escapeHtml(value)}</span></span>`;
    const className = `spx-metric spx-metric-premier spx-premier-${tier}`;

    if (!other) {
      return `<div class="${className}" data-spx-tip="${escapeAttribute(isPeak ? "Peak Premier" : "Premier rating")}">${badge}</div>`;
    }

    const tip = isPeak
      ? `Peak Premier · click to show current (${other})`
      : `Current Premier · click to show peak (${other})`;

    return `
      <button type="button" class="${className}" data-spx-premier-toggle="1" data-spx-focus="premier" aria-pressed="${isPeak ? "true" : "false"}"
        aria-label="${escapeAttribute(`${isPeak ? "Peak" : "Current"} Premier rating ${value}. Show ${isPeak ? "current" : "peak"} rating`)}"
        data-spx-tip="${escapeAttribute(tip)}">${badge}</button>
    `;
  }

  function applyPremierBadgeArt(root) {
    root?.querySelectorAll("[data-spx-premier-tier]").forEach((badge) => {
      const asset = PREMIER_BADGE_ASSETS[badge.dataset.spxPremierTier];
      if (asset) {
        badge.style.backgroundImage = `url("${asset}")`;
      }
    });
  }

  function getPremierTier(rating) {
    if (!Number.isFinite(rating) || rating <= 0) { return "none"; }
    if (rating < 5000) { return "grey"; }
    if (rating < 10000) { return "lightblue"; }
    if (rating < 15000) { return "blue"; }
    if (rating < 20000) { return "purple"; }
    if (rating < 25000) { return "pink"; }
    if (rating < 30000) { return "red"; }
    return "gold";
  }

  function handleStatsClick(event) {
    const target = event.target.closest("[data-spx-premier-toggle], [data-spx-faceit-toggle]");
    if (!target || !state.root.contains(target)) return;

    event.preventDefault();
    const settings = resolveUserSettings();
    writeInlineSettings(target.hasAttribute("data-spx-faceit-toggle")
      ? { showPeakFaceit: !settings.showPeakFaceit }
      : { showPeakPremier: !settings.showPeakPremier });
  }

  async function writeInlineSettings(partial) {
    state.settings = SPX_normalizeUserSettings({ ...state.settings, ...partial });

    try {
      // chrome.storage.onChanged triggers the single re-render.
      state.settings = await SPX_writeUserSettings(partial);
    } catch (error) {
      console.warn("[Steam CS2 Profile Intel] Could not save profile settings:", error.message || error);
    }
  }

  function resolveUserSettings(bundle) {
    return SPX_normalizeUserSettings(bundle?.settings || state.settings || SPX_DEFAULT_USER_SETTINGS);
  }

  // ── Matches ───────────────────────────────────────

  function renderMatchesSection({ leetify }) {
    const matches = listOf(leetify?.matches).slice(0, MATCH_LIMIT);
    if (!matches.length) {
      return "";
    }

    return renderShell("Matches", `<div class="spx-matches-grid">${matches.map(renderMatchCard).join("")}</div>`);
  }

  function renderMatchCard(match) {
    const result = RESULT_NAMES[match.result] ? match.result : "D";
    const mapName = match.mapName || "Unknown map";
    const mode = match.mode || "Match";
    const hasKd = String(match.kills ?? "") !== "" || String(match.deaths ?? "") !== "";
    const rating = match.rating ? `Leetify rating ${match.rating}` : "";
    const tip = [mapName, mode, formatMatchDate(match.finishedAt), rating].filter(Boolean).join(" · ");
    const mapVisual = match.mapIcon
      ? `<img class="spx-match-map-icon" src="${escapeAttribute(match.mapIcon)}" width="34" height="34" alt="" loading="lazy" decoding="async" />`
      : renderMapFallback();

    return `
      <article class="spx-match spx-match-${RESULT_NAMES[result]}" data-spx-tip="${escapeAttribute(tip)}">
        <div class="spx-match-map">${mapVisual}</div>
        <div class="spx-match-info">
          <div class="spx-match-name">${escapeHtml(mapName)}</div>
          <div class="spx-match-mode">${escapeHtml(mode)}</div>
        </div>
        <div class="spx-match-result" role="img" aria-label="${escapeAttribute(`${RESULT_LABELS[result]} ${match.score || ""}`.trim())}">
          ${match.score ? `<span class="spx-match-score" aria-hidden="true">${escapeHtml(match.score)}</span>` : ""}
        </div>
        ${hasKd
          ? `<div class="spx-match-kd" data-spx-tip="Kills / Deaths" aria-label="${escapeAttribute(`${match.kills || 0} kills, ${match.deaths || 0} deaths`)}">${escapeHtml(`${match.kills || "0"} / ${match.deaths || "0"}`)}</div>`
          : `<div class="spx-match-kd spx-match-kd-empty" aria-hidden="true">–</div>`}
      </article>
    `;
  }

  function renderMapFallback() {
    return `<span class="spx-match-map-fallback" role="img" aria-label="Map">${MAP_GLYPH}</span>`;
  }

  function formatMatchDate(value) {
    if (!value) {
      return "";
    }

    const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    const day = new Date(date);
    const today = new Date();
    day.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today - day) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;

    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString("en-US", sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" });
  }

  // ── Clips ─────────────────────────────────────────

  function renderClipsSection({ allstar }) {
    const clips = listOf(allstar?.clips).filter((clip) => clip.thumbnail).slice(0, CLIP_LIMIT);
    if (!clips.length) {
      return "";
    }

    state.clips = clips;
    return renderShell("Clips", `<div class="spx-clips-grid" data-count="${clips.length}">${clips.map(renderClipCard).join("")}</div>`);
  }

  function renderClipCard(clip, index) {
    const title = String(clip.title || "CS2 Clip");
    const url = /^https:\/\//i.test(String(clip.url || "")) ? clip.url : "";
    const media = `
      <img class="spx-clip-thumb" src="${escapeAttribute(clip.thumbnail)}" width="320" height="180" alt="" loading="lazy" decoding="async" />
      <span class="spx-clip-play" aria-hidden="true">${PLAY_GLYPH}</span>
    `;
    const mediaControl = clip.video
      ? `<button type="button" class="spx-clip-media" data-spx-clip-index="${index}" aria-haspopup="dialog" aria-label="${escapeAttribute(`Play clip: ${title}`)}">${media}</button>`
      : url
        ? `<a class="spx-clip-media" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttribute(`Open clip on Allstar: ${title}`)}">${media}</a>`
        : `<div class="spx-clip-media">${media}</div>`;

    return `
      <figure class="spx-clip">
        ${mediaControl}
        <figcaption class="spx-clip-caption">
          <span class="spx-clip-title" data-spx-tip="${escapeAttribute(title)}">${escapeHtml(title)}</span>
        </figcaption>
      </figure>
    `;
  }

  function handleClipsClick(event) {
    const button = event.target.closest("[data-spx-clip-index]");
    if (!button || !state.clipsRoot.contains(button)) return;

    event.preventDefault();
    openClipPlayer(Number(button.dataset.spxClipIndex), button);
  }

  // ── Clip player (lightbox) ────────────────────────

  function openClipPlayer(index, opener) {
    const playable = state.clips.filter((clip) => clip.video);
    const start = playable.indexOf(state.clips[index]);
    if (start < 0) return;

    const player = ensureClipPlayer();
    state.player.list = playable;
    state.player.opener = opener || null;
    if (!state.player.open) {
      state.player.open = true;
      state.player.scroll = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      player.root.hidden = false;
      document.addEventListener("keydown", handlePlayerKeys, true);
    }

    hideTooltip();
    showClipInPlayer(start);
    player.close.focus({ preventScroll: true });
  }

  function ensureClipPlayer() {
    if (state.player.root?.isConnected) {
      return state.player;
    }

    const root = document.createElement("div");
    root.id = PLAYER_ID;
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Clip player");
    root.innerHTML = `
      <div class="spx-player-backdrop" data-spx-player="close"></div>
      <div class="spx-player-panel">
        <div class="spx-player-bar">
          <div class="spx-player-title"></div>
          <div class="spx-player-count" aria-live="polite"></div>
          <button type="button" class="spx-player-btn" data-spx-player="fullscreen" aria-label="Full screen (F)" title="Full screen (F)">${FULLSCREEN_GLYPH}</button>
          <button type="button" class="spx-player-btn" data-spx-player="close" aria-label="Close (Esc)" title="Close (Esc)">${CLOSE_GLYPH}</button>
        </div>
        <div class="spx-player-stage">
          <video class="spx-player-video" controls playsinline preload="auto"></video>
          <div class="spx-player-error" hidden>This clip couldn't be played here. <a target="_blank" rel="noopener noreferrer">Open it on Allstar</a></div>
          <button type="button" class="spx-player-nav spx-player-prev" data-spx-player="prev" aria-label="Previous clip (Left arrow)">${CHEVRON_GLYPHS.previous}</button>
          <button type="button" class="spx-player-nav spx-player-next" data-spx-player="next" aria-label="Next clip (Right arrow)">${CHEVRON_GLYPHS.next}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const video = root.querySelector("video");
    video.addEventListener("error", () => {
      if (!video.getAttribute("src")) return;
      root.querySelector(".spx-player-error").hidden = false;
    });
    root.addEventListener("click", (event) => {
      const action = event.target.closest("[data-spx-player]")?.dataset.spxPlayer;
      if (action === "close") closeClipPlayer();
      else if (action === "prev") stepClipPlayer(-1);
      else if (action === "next") stepClipPlayer(1);
      else if (action === "fullscreen") toggleClipFullscreen();
    });

    state.player = {
      ...state.player,
      root,
      video,
      title: root.querySelector(".spx-player-title"),
      count: root.querySelector(".spx-player-count"),
      error: root.querySelector(".spx-player-error"),
      close: root.querySelector('[data-spx-player="close"].spx-player-btn'),
      prev: root.querySelector('[data-spx-player="prev"]'),
      next: root.querySelector('[data-spx-player="next"]')
    };
    return state.player;
  }

  function showClipInPlayer(index) {
    const player = state.player;
    const list = player.list;
    const clip = list[index];
    if (!clip) return;

    player.index = index;
    player.title.textContent = String(clip.title || "CS2 Clip");
    player.count.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : "";
    player.prev.hidden = list.length < 2;
    player.next.hidden = list.length < 2;
    player.error.hidden = true;
    const link = player.error.querySelector("a");
    if (/^https:\/\//i.test(String(clip.url || ""))) link.href = clip.url;
    else link.removeAttribute("href");

    player.video.poster = clip.thumbnail || "";
    player.video.src = clip.video;
    player.video.play().catch(() => {});
  }

  function stepClipPlayer(direction) {
    const count = state.player.list.length;
    if (count < 2) return;
    showClipInPlayer((state.player.index + direction + count) % count);
  }

  function toggleClipFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    state.player.video?.requestFullscreen?.().catch(() => {});
  }

  function closeClipPlayer() {
    const player = state.player;
    if (!player.open) return;

    player.open = false;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    player.video.pause();
    player.video.removeAttribute("src");
    player.video.load();
    player.root.hidden = true;
    document.documentElement.style.overflow = player.scroll || "";
    document.removeEventListener("keydown", handlePlayerKeys, true);
    if (player.opener?.isConnected) {
      player.opener.focus({ preventScroll: true });
    }
  }

  function handlePlayerKeys(event) {
    if (!state.player.open || event.altKey || event.ctrlKey || event.metaKey) return;

    // While the browser is in fullscreen, let it handle Escape itself.
    if (event.key === "Escape" && !document.fullscreenElement) {
      event.preventDefault();
      event.stopPropagation();
      closeClipPlayer();
    } else if ((event.key === "f" || event.key === "F") && !event.repeat) {
      event.preventDefault();
      toggleClipFullscreen();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && document.activeElement !== state.player.video) {
      // Arrow keys seek when the video itself has focus; otherwise they switch clips.
      event.preventDefault();
      stepClipPlayer(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Tab") {
      trapPlayerFocus(event);
    }
  }

  function trapPlayerFocus(event) {
    const focusable = [...state.player.root.querySelectorAll("button:not([hidden]), video, a[href]")]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ── Header medals ─────────────────────────────────

  function renderHeaderMedals(medals) {
    const target = resolveHeaderMedalTarget();
    if (!medals.length || !target) {
      clearHeaderMedals();
      return;
    }

    const medalState = state.medals;
    const key = medals.map((medal) => `${medal.id}:${medal.image}`).join("|");
    if (medalState.key !== key) {
      medalState.key = key;
      medalState.list = medals;
      medalState.start = 0;
      medalState.signature = "";
    }

    target.classList.add("spx-header-medal-target");
    let root = document.getElementById(HEADER_MEDALS_ID);
    if (!root) {
      root = createHeaderMedalShell();
    }
    if (root.parentElement !== target) {
      mountHeaderMedalRoot(target, root);
      medalState.signature = "";
    }

    observeHeaderTarget(target);
    layoutHeaderMedals(false);
  }

  function createHeaderMedalShell() {
    const root = document.createElement("span");
    root.id = HEADER_MEDALS_ID;
    root.className = "spx-header-medals";
    root.innerHTML = `
      <span class="spx-header-medal-list" role="group" aria-label="CS2 medals"></span>
      <span class="spx-header-medal-navs" hidden>
        <button class="spx-header-medal-nav" type="button" data-direction="previous" aria-label="Previous medals">${CHEVRON_GLYPHS.previous}</button>
        <button class="spx-header-medal-nav" type="button" data-direction="next" aria-label="Next medals">${CHEVRON_GLYPHS.next}</button>
      </span>
    `;
    root.addEventListener("click", handleMedalNavClick);
    root.addEventListener("error", handleImageError, true);
    return root;
  }

  function handleMedalNavClick(event) {
    const button = event.target.closest(".spx-header-medal-nav");
    const medalState = state.medals;
    if (!button || button.disabled || !medalState.list.length) return;

    if (button.dataset.direction === "previous") {
      medalState.start = findMedalPageStart(medalState.slots, medalState.start - 1, medalState.listBudget);
    } else {
      medalState.start += medalState.count;
    }

    layoutHeaderMedals(true);

    if (button.disabled) {
      const other = button.parentElement.querySelector(`.spx-header-medal-nav:not([data-direction="${button.dataset.direction}"])`);
      if (other && !other.disabled) {
        other.focus({ preventScroll: true });
      }
    }
  }

  function layoutHeaderMedals(force) {
    const root = document.getElementById(HEADER_MEDALS_ID);
    const target = root?.parentElement;
    const medalState = state.medals;
    const medals = medalState.list;
    if (!root || !target || !medals.length) return;

    const height = window.innerWidth <= 910 || target.clientWidth < 360 ? 24 : 28;
    const slots = medals.map((medal) => getMedalSlotWidth(medal, height));
    const budget = getMedalBudget(target);
    const overflow = sumMedalSlots(slots, 0, slots.length) > budget;
    // Paging only pays off when a page holds at least two medals; otherwise show what fits.
    const paged = overflow && budget - MEDAL_NAV_WIDTH >= 2 * height + MEDAL_GAP;
    const listBudget = paged ? budget - MEDAL_NAV_WIDTH : budget;

    let start = 0;
    let count = overflow && !paged ? fitMedalsForward(slots, 0, budget) : slots.length;
    if (paged) {
      start = Math.max(0, Math.min(medalState.start, slots.length - 1));
      count = fitMedalsForward(slots, start, listBudget);
      if (start + count >= slots.length) {
        start = findMedalPageStart(slots, slots.length - 1, listBudget);
        count = slots.length - start;
      }
    }

    medalState.start = start;
    medalState.count = count;
    medalState.slots = slots;
    medalState.listBudget = listBudget;

    const signature = `${start}:${count}:${height}:${paged}`;
    if (!force && medalState.signature === signature) return;
    medalState.signature = signature;

    root.classList.toggle("spx-header-medals-compact", height === 24);
    const list = root.querySelector(".spx-header-medal-list");
    list.innerHTML = medals.slice(start, start + count).map((medal) => renderHeaderMedal(medal, height)).join("");
    list.setAttribute("aria-label", paged ? `CS2 medals ${start + 1}–${start + count} of ${medals.length}` : `CS2 medals (${medals.length})`);

    const navs = root.querySelector(".spx-header-medal-navs");
    navs.hidden = !paged;
    navs.querySelector('[data-direction="previous"]').disabled = start <= 0;
    navs.querySelector('[data-direction="next"]').disabled = start + count >= medals.length;
  }

  function renderHeaderMedal(medal, height) {
    const width = getMedalWidth(medal, height);
    const title = medal.title || "CS2 medal";
    return `
      <span class="spx-header-medal-item" data-spx-tip="${escapeAttribute(title)}">
        <img class="spx-header-medal-image" src="${escapeAttribute(medal.image)}" ${width ? `width="${width}" ` : ""}height="${height}" alt="${escapeAttribute(title)}" decoding="async" />
      </span>
    `;
  }

  function getMedalWidth(medal, height) {
    const width = Number(medal.width);
    const naturalHeight = Number(medal.height);
    return width > 0 && naturalHeight > 0 ? Math.max(1, Math.round((width * height) / naturalHeight)) : 0;
  }

  function getMedalSlotWidth(medal, height) {
    return Math.max(MEDAL_MIN_SLOT, getMedalWidth(medal, height) || height);
  }

  function getMedalBudget(target) {
    const width = target.clientWidth;
    const name = target.querySelector(".actual_persona_name");
    const arrow = target.querySelector(".namehistory_link");
    const nickname = target.querySelector(".nickname");
    const arrowWidth = arrow && arrow.getClientRects().length ? Math.ceil(arrow.getBoundingClientRect().width) + 6 : 0;
    // The nickname is expendable: reserve at most 80px for it.
    const nicknameWidth = nickname && nickname.getClientRects().length ? Math.min(Math.ceil(nickname.scrollWidth), 80) + 6 : 0;
    const nameWidth = name ? Math.ceil(name.scrollWidth) : 0;
    const free = width - nameWidth - nicknameWidth - arrowWidth - 12 - 1;
    return Math.max(free, Math.min(width * 0.45, 200));
  }

  function sumMedalSlots(slots, start, end) {
    let total = 0;
    for (let index = start; index < end; index += 1) {
      total += slots[index] + (index > start ? MEDAL_GAP : 0);
    }
    return total;
  }

  function fitMedalsForward(slots, start, budget) {
    let used = 0;
    let count = 0;
    for (let index = start; index < slots.length; index += 1) {
      const next = used + slots[index] + (count ? MEDAL_GAP : 0);
      if (next > budget && count) break;
      used = next;
      count += 1;
    }
    return Math.max(1, count);
  }

  function findMedalPageStart(slots, end, budget) {
    let start = Math.max(0, end);
    let used = slots[start] || 0;
    while (start > 0) {
      const next = used + slots[start - 1] + MEDAL_GAP;
      if (next > budget) break;
      used = next;
      start -= 1;
    }
    return start;
  }

  function observeHeaderTarget(target) {
    const medalState = state.medals;
    if (medalState.observer || typeof ResizeObserver !== "function") return;

    medalState.observer = new ResizeObserver(() => layoutHeaderMedals(false));
    medalState.observer.observe(target);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => layoutHeaderMedals(false));
    }
  }

  function resolveHeaderMedalTarget() {
    return (
      document.querySelector(".profile_header_centered_persona > .persona_name") ||
      document.querySelector(".profile_header_centered_col .profile_header_centered_persona .persona_name")
    );
  }

  function mountHeaderMedalRoot(target, root) {
    const popup = target.querySelector("#NamePopup");
    if (popup) {
      target.insertBefore(root, popup);
      return;
    }

    target.appendChild(root);
  }

  function clearHeaderMedals() {
    const root = document.getElementById(HEADER_MEDALS_ID);
    if (root) {
      if (state.tooltipAnchor && root.contains(state.tooltipAnchor)) {
        hideTooltip();
      }
      root.remove();
    }

    document.querySelectorAll(".spx-header-medal-target").forEach((target) => {
      target.classList.remove("spx-header-medal-target");
    });

    const medalState = state.medals;
    if (medalState.observer) {
      medalState.observer.disconnect();
    }
    state.medals = { list: [], key: "", start: 0, count: 0, slots: [], listBudget: 0, signature: "", observer: null };
  }

  // ── Tooltip ───────────────────────────────────────

  function installTooltip() {
    document.addEventListener("mouseover", (event) => {
      const anchor = findTooltipAnchor(event.target);
      if (anchor && anchor !== state.tooltipAnchor) {
        showTooltip(anchor);
      }
    }, true);

    document.addEventListener("mouseout", (event) => {
      const anchor = state.tooltipAnchor;
      if (!anchor) return;
      const next = event.relatedTarget;
      if (next instanceof Node && anchor.contains(next)) return;
      if (!(event.target instanceof Node) || !anchor.contains(event.target)) return;
      hideTooltip();
    }, true);

    document.addEventListener("focusin", (event) => {
      const anchor = findTooltipAnchor(event.target);
      if (anchor) {
        showTooltip(anchor);
      } else if (state.tooltipAnchor) {
        hideTooltip();
      }
    }, true);

    document.addEventListener("focusout", (event) => {
      if (state.tooltipAnchor && event.target === state.tooltipAnchor) {
        hideTooltip();
      }
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideTooltip();
      }
    }, true);

    window.addEventListener("scroll", hideTooltip, { capture: true, passive: true });
    window.addEventListener("blur", hideTooltip);
  }

  function findTooltipAnchor(node) {
    if (!(node instanceof Element)) return null;
    const anchor = node.closest("[data-spx-tip], [data-spx-tip-title]");
    return anchor && anchor.closest(ROOT_SELECTOR) ? anchor : null;
  }

  function ensureTooltip() {
    let tooltip = document.getElementById(TOOLTIP_ID);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = TOOLTIP_ID;
      tooltip.setAttribute("role", "tooltip");
      tooltip.hidden = true;
      (document.body || document.documentElement).appendChild(tooltip);
    }
    return tooltip;
  }

  function showTooltip(anchor) {
    const title = anchor.getAttribute("data-spx-tip-title") || "";
    const lines = String(anchor.getAttribute("data-spx-tip") || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const note = anchor.getAttribute("data-spx-tip-note") || "";
    if (!title && !lines.length) {
      hideTooltip();
      return;
    }

    const tooltip = ensureTooltip();
    const parts = [];
    if (title) parts.push(makeTooltipLine(title, "spx-tooltip-title"));
    lines.forEach((line) => parts.push(makeTooltipLine(line, "spx-tooltip-line")));
    if (note) parts.push(makeTooltipLine(note, "spx-tooltip-note"));
    tooltip.replaceChildren(...parts);

    if (state.tooltipAnchor && state.tooltipAnchor !== anchor) {
      state.tooltipAnchor.removeAttribute("aria-describedby");
    }
    state.tooltipAnchor = anchor;
    anchor.setAttribute("aria-describedby", TOOLTIP_ID);

    tooltip.hidden = false;
    tooltip.classList.remove("spx-tooltip-visible");
    positionTooltip(tooltip, anchor);
    tooltip.classList.add("spx-tooltip-visible");
  }

  function makeTooltipLine(text, className) {
    const line = document.createElement("div");
    line.className = className;
    line.textContent = text;
    return line;
  }

  function positionTooltip(tooltip, anchor) {
    const edge = 6;
    const gap = 8;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;

    let placement = "top";
    let top = rect.top - height - gap;
    if (top < edge) {
      placement = "bottom";
      top = Math.min(rect.bottom + gap, viewportHeight - height - edge);
    }

    const center = rect.left + rect.width / 2;
    const left = Math.max(edge, Math.min(center - width / 2, viewportWidth - width - edge));
    const arrow = Math.max(10, Math.min(center - left, width - 10));

    tooltip.dataset.placement = placement;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(edge, top))}px`;
    tooltip.style.setProperty("--spx-tip-arrow", `${Math.round(arrow)}px`);
  }

  function hideTooltip() {
    const anchor = state.tooltipAnchor;
    if (anchor) {
      anchor.removeAttribute("aria-describedby");
    }
    state.tooltipAnchor = null;

    const tooltip = document.getElementById(TOOLTIP_ID);
    if (tooltip && !tooltip.hidden) {
      tooltip.classList.remove("spx-tooltip-visible");
      tooltip.hidden = true;
    }
  }

  // ── Images ────────────────────────────────────────

  function handleImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;

    if (image.classList.contains("spx-match-map-icon")) {
      const holder = document.createElement("span");
      holder.innerHTML = renderMapFallback();
      image.replaceWith(holder.firstElementChild);
      return;
    }

    const medal = image.closest(".spx-header-medal-item");
    (medal || image).hidden = true;
  }

  // ── Helpers ───────────────────────────────────────

  function listOf(value) {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
  }

  function textList(value) {
    return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  }

  function firstList(...lists) {
    for (const list of lists) {
      const items = listOf(list);
      if (items.length) {
        return items;
      }
    }
    return [];
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
