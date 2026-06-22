(function () {
  const ROOT_ID  = "spx-cs2-profile-intel";
  const MATCHES_ID = "spx-cs2-matches-intel";
  const CLIPS_ID = "spx-cs2-clips-intel";
  const HEADER_MEDALS_ID = "spx-cs2-header-medals";
  const DISPLAY_ORDER = ["steam", "leetify", "csstats"];
  const PREMIER_BADGE_ASSETS = Object.freeze({
    grey: chrome.runtime.getURL("premier/0-4999.png"),
    lightblue: chrome.runtime.getURL("premier/5000-9999.png"),
    blue: chrome.runtime.getURL("premier/10000-14999.png"),
    purple: chrome.runtime.getURL("premier/15000-19999.png"),
    pink: chrome.runtime.getURL("premier/20000-24999.png"),
    red: chrome.runtime.getURL("premier/25000-29999.png"),
    gold: chrome.runtime.getURL("premier/30000+.png")
  });

  const state = {
    steamId: null,
    profileUrl: null,
    root: null,
    matchesRoot: null,
    clipsRoot: null,
    settings: { ...SPX_DEFAULT_USER_SETTINGS },
    headerMedals: [],
    headerMedalIndex: 0,
    headerMedalKey: ""
  };

  let resizeQueued = false;

  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      renderHeaderMedals();
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!Object.keys(changes || {}).some((key) => SPX_isUserSettingKey(key))) return;
    if (!state.steamId || !state.profileUrl) return;

    loadBundle({
      steamId: state.steamId,
      profileUrl: state.profileUrl
    });
  });

  start();

  function start() {
    waitForSteamProfile()
      .then((context) => {
        mount(context);
        loadBundle(context);
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

    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const inlineMatch = html.match(/g_rgProfileData\s*=\s*\{[^}]*"steamid":"(\d{17})"/);
    return inlineMatch ? inlineMatch[1] : null;
  }

  function resolveProfileUrl() {
    if (window.g_rgProfileData && window.g_rgProfileData.url) {
      return String(window.g_rgProfileData.url);
    }

    return window.location.href;
  }

  function resolveShowcaseTarget() {
    return (
      document.querySelector(".profile_customization_area") ||
      document.querySelector(".profile_leftcol") ||
      document.querySelector(".profile_rightcol")
    );
  }

  function mount(context) {
    state.steamId = context.steamId;
    state.profileUrl = context.profileUrl;

    const root = ensureRoot(ROOT_ID);
    state.root = root;
    if (!context.target.contains(root)) {
      context.target.prepend(root);
    }

    const matchesRoot = ensureRoot(MATCHES_ID);
    state.matchesRoot = matchesRoot;
    root.insertAdjacentElement("afterend", matchesRoot);

    // Clips section goes directly after the matches section
    const clipsRoot = ensureRoot(CLIPS_ID);
    state.clipsRoot = clipsRoot;
    matchesRoot.insertAdjacentElement("afterend", clipsRoot);

    matchesRoot.innerHTML = "";
    clipsRoot.innerHTML = "";
    renderLoading(root);
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

  async function loadBundle(context) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SPX_GET_PROFILE_BUNDLE",
        steamId: context.steamId,
        profileUrl: context.profileUrl
      });

      if (!response || !response.ok) {
        renderFatal(state.root, response?.error || "The extension could not load provider data.");
        return;
      }

      const latestSettings = await SPX_readUserSettings();
      const hydratedResponse = {
        ...response,
        settings: latestSettings
      };

      state.settings = latestSettings;
      renderBundle(state.root, hydratedResponse);
      renderMatchesSection(state.matchesRoot, hydratedResponse);
      renderClipsSection(state.clipsRoot, hydratedResponse);
      renderHeaderMedals(hydratedResponse);
    } catch (error) {
      renderFatal(state.root, error.message || "The extension could not load provider data.");
    }
  }

  function renderLoading(root) {
    clearHeaderMedals();
    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Stats</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          <div class="spx-row-list">
            ${renderLoadingRow()}
            ${renderLoadingRow()}
          </div>
        </div>
      </div>
    `;
  }

  function renderFatal(root, message) {
    clearHeaderMedals();
    if (state.matchesRoot) {
      state.matchesRoot.innerHTML = "";
    }
    if (state.clipsRoot) {
      state.clipsRoot.innerHTML = "";
    }
    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Stats</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          ${renderProfileSettings(resolveUserSettings())}
          <div class="spx-inline-note">${escapeHtml(message)}</div>
        </div>
      </div>
    `;
    bindProfileSettings(root);
  }

  function renderBundle(root, bundle) {
    const settings = resolveUserSettings(bundle);
    const providerMap = new Map(
      (Array.isArray(bundle.providers) ? bundle.providers : []).map((provider) => [provider.id, provider])
    );

    const gcProvider    = providerMap.get("gc");
    const steamProvider = providerMap.get("steam");
    const gcWingmanRanks = gcProvider?.state === "ready" && Array.isArray(gcProvider.wingmanRanks)
      ? gcProvider.wingmanRanks
      : [];
    const gcCompetitiveRanks = gcProvider?.state === "ready" && Array.isArray(gcProvider.competitiveRanks)
      ? gcProvider.competitiveRanks
      : [];

    if (steamProvider && gcProvider?.state === "ready") {
      providerMap.set("steam", {
        ...steamProvider,
        metrics: mergeSteamMetrics(steamProvider.metrics, gcProvider.levelMetric),
        commendations: Array.isArray(gcProvider.commendations) && gcProvider.commendations.length
          ? gcProvider.commendations
          : Array.isArray(steamProvider.commendations) ? steamProvider.commendations : [],
        wingmanRanks: gcCompetitiveRanks.length
          ? mergeRankLists(gcWingmanRanks, steamProvider.wingmanRanks)
          : [],
        competitiveRanks: gcCompetitiveRanks.length
          ? gcCompetitiveRanks
          : Array.isArray(steamProvider.competitiveRanks) ? steamProvider.competitiveRanks : []
      });
    }

    const faceitProvider = providerMap.get("faceit");
    const leetifyProvider = providerMap.get("leetify");
    if (leetifyProvider?.state === "ready" && faceitProvider?.state === "ready") {
      providerMap.set("leetify", mergeLeetifyWithFaceit(leetifyProvider, faceitProvider));
    }

    const mergedLeetifyProvider = providerMap.get("leetify");
    if (
      gcWingmanRanks.length &&
      mergedLeetifyProvider?.state === "ready" &&
      Array.isArray(mergedLeetifyProvider.competitiveRanks) &&
      mergedLeetifyProvider.competitiveRanks.length
    ) {
      providerMap.set("leetify", {
        ...mergedLeetifyProvider,
        wingmanRanks: mergeRankLists(gcWingmanRanks, mergedLeetifyProvider.wingmanRanks)
      });
    }

    const providers = DISPLAY_ORDER
      .map((providerId) => providerMap.get(providerId) || makeFallbackProvider(providerId))
      .filter((provider) => {
        if (provider.state !== "ready") { return false; }
        const hasMetrics       = Array.isArray(provider.metrics)       && provider.metrics.length > 0;
        const hasCommendations = Array.isArray(provider.commendations) && provider.commendations.length > 0;
        const hasRanks         = (Array.isArray(provider.competitiveRanks) && provider.competitiveRanks.length > 0) ||
                                 (Array.isArray(provider.wingmanRanks)     && provider.wingmanRanks.length > 0);
        return hasMetrics || hasCommendations || hasRanks;
      });

    if (!providers.length) {
      root.innerHTML = `
        <div class="profile_customization_header spx-showcase-header">Stats</div>
        <div class="profile_customization_block">
          <div class="showcase_content_bg spx-shell">
            ${renderProfileSettings(settings)}
            <div class="spx-inline-note">No stats visible right now.</div>
          </div>
        </div>
      `;
      bindProfileSettings(root);
      return;
    }

    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Stats</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          ${renderProfileSettings(settings)}
          <div class="spx-row-list">${providers.map((provider) => renderProviderRow(provider)).join("")}</div>
        </div>
      </div>
    `;
    bindProfileSettings(root);
  }

  function renderProfileSettings(settingsInput) {
    const settings = SPX_normalizeUserSettings(settingsInput);
    const toggle = (key, label) => `
      <label class="spx-profile-setting-pill${settings[key] ? " is-active" : ""}">
        <input type="checkbox" data-spx-setting="${escapeAttribute(key)}" ${settings[key] ? "checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </label>
    `;

    const matchCount = (value) => `
      <label class="spx-profile-count-pill${settings.matchesToShow === value ? " is-active" : ""}">
        <input type="radio" name="spxMatchesToShow" data-spx-setting="matchesToShow" value="${value}" ${settings.matchesToShow === value ? "checked" : ""} ${settings.showMatches ? "" : "disabled"} />
        <span>${value}</span>
      </label>
    `;

    return `
      <div class="spx-profile-settings" data-spx-profile-settings>
        <span class="spx-profile-settings-title">Display</span>
        ${toggle("showMedals", "Medals")}
        ${toggle("showPeakPremier", "Peak")}
        ${toggle("showCompetitiveRanks", "Ranks")}
        <span class="spx-profile-match-settings${settings.showMatches ? "" : " is-disabled"}">
          ${toggle("showMatches", "Matches")}
          <span class="spx-profile-counts" role="radiogroup" aria-label="Matches to show">
            ${matchCount(5)}
            ${matchCount(10)}
            ${matchCount(15)}
          </span>
        </span>
        ${toggle("showClips", "Clips")}
      </div>
    `;
  }

  function bindProfileSettings(root) {
    const settingsRoot = root.querySelector("[data-spx-profile-settings]");
    if (!settingsRoot) return;

    settingsRoot.addEventListener("change", async (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;

      const key = input.dataset.spxSetting;
      if (!SPX_isUserSettingKey(key)) return;

      const partial = {};
      partial[key] = input.type === "radio" ? Number(input.value) : input.checked;
      const nextSettings = SPX_normalizeUserSettings({ ...state.settings, ...partial });

      state.settings = nextSettings;
      updateProfileSettingsControls(settingsRoot, nextSettings);

      try {
        settingsRoot.classList.add("is-saving");
        state.settings = await SPX_writeUserSettings(partial);
      } catch (error) {
        settingsRoot.classList.add("is-error");
        console.warn("[Steam CS2 Profile Intel] Could not save profile settings:", error.message || error);
      } finally {
        settingsRoot.classList.remove("is-saving");
      }
    });
  }

  function updateProfileSettingsControls(settingsRoot, settingsInput) {
    const settings = SPX_normalizeUserSettings(settingsInput);
    const matchGroup = settingsRoot.querySelector(".spx-profile-match-settings");
    if (matchGroup) {
      matchGroup.classList.toggle("is-disabled", !settings.showMatches);
    }

    settingsRoot.querySelectorAll("input[data-spx-setting]").forEach((input) => {
      const key = input.dataset.spxSetting;
      if (input.type === "radio") {
        input.checked = Number(input.value) === settings.matchesToShow;
        input.disabled = !settings.showMatches;
      } else {
        input.checked = Boolean(settings[key]);
      }

      input.closest("label")?.classList.toggle("is-active", input.checked);
    });
  }

  function renderHeaderMedals(bundle = null) {
    const settings = resolveUserSettings(bundle);
    if (!settings.showMedals) {
      clearHeaderMedals();
      return;
    }

    const medals = bundle ? getGcMedals(bundle) : state.headerMedals;
    const target = resolveHeaderMedalTarget();
    let root = document.getElementById(HEADER_MEDALS_ID);

    if (!medals.length || !target) {
      clearHeaderMedals();
      return;
    }

    prepareHeaderMedalTarget(target);
    state.headerMedals = medals;

    const medalKey = medals.map((medal) => `${medal.id}:${medal.image}`).join("|");
    if (state.headerMedalKey !== medalKey) {
      state.headerMedalKey = medalKey;
      state.headerMedalIndex = 0;
    }

    if (!root) {
      root = document.createElement("span");
      root.id = HEADER_MEDALS_ID;
      root.className = "spx-header-medals";
    }

    mountHeaderMedalRoot(target, root);

    const visibleCount = getVisibleHeaderMedalCount();
    const startIndex = normalizeHeaderMedalStart(state.headerMedalIndex, medals.length);
    state.headerMedalIndex = startIndex;
    const visibleMedals = getVisibleMedals(medals, startIndex, visibleCount);
    const hasNavigation = medals.length > visibleCount;
    const hasPrevious = startIndex > 0;
    const hasNext = startIndex + visibleCount < medals.length;

    root.innerHTML = `
      <span class="spx-header-medals-shell">
        <span class="spx-header-medal-list" aria-label="CS2 medals">
          ${visibleMedals.map((medal) => `
            <span class="spx-header-medal-item">
              <img class="spx-header-medal-image" src="${escapeAttribute(medal.image)}" alt="${escapeAttribute(medal.title)}" title="${escapeAttribute(medal.title)}" />
            </span>
          `).join("")}
        </span>
        ${hasNavigation ? `
          <span class="spx-header-medal-navs">
            <button class="spx-header-medal-nav" type="button" data-direction="previous" aria-label="Show newer medals" ${hasPrevious ? "" : "disabled"}>
              &#8249;
            </button>
            <button class="spx-header-medal-nav" type="button" data-direction="next" aria-label="Show older medals" ${hasNext ? "" : "disabled"}>
              &#8250;
            </button>
          </span>
        ` : ""}
      </span>
    `;

    root.querySelectorAll(".spx-header-medal-nav").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.disabled) {
          return;
        }

        state.headerMedalIndex = button.dataset.direction === "previous"
          ? getPreviousHeaderMedalStart(state.headerMedalIndex, visibleCount)
          : getNextHeaderMedalStart(state.headerMedalIndex, medals.length, visibleCount);

        renderHeaderMedals();
      });
    });
  }

  function renderClipsSection(root, bundle) {
    if (!root) return;
    const settings = resolveUserSettings(bundle);
    if (!settings.showClips) {
      root.innerHTML = "";
      return;
    }

    const providers = Array.isArray(bundle?.providers) ? bundle.providers : [];
    const allstar = providers.find((p) => p.id === "allstar");
    const clips = (allstar?.state === "ready" && Array.isArray(allstar.clips)) ? allstar.clips : [];

    if (!clips.length) {
      root.innerHTML = "";
      return;
    }

    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Clips</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          <div class="spx-clips-grid">
            ${clips.map(renderClipThumb).join("")}
          </div>
        </div>
      </div>
    `;

    // Wire up click-to-play
    root.querySelectorAll(".spx-clip[data-playable]").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.classList.contains("spx-clip-playing")) return;
        el.classList.add("spx-clip-playing");
        const videoUrl = el.dataset.video;
        if (videoUrl) {
          el.innerHTML = `<video class="spx-clip-video" src="${escapeAttribute(videoUrl)}" autoplay controls></video>`;
        }
      });
    });
  }

  function renderMatchesSection(root, bundle) {
    if (!root) return;
    const settings = resolveUserSettings(bundle);
    if (!settings.showMatches) {
      root.innerHTML = "";
      return;
    }

    const providers = Array.isArray(bundle?.providers) ? bundle.providers : [];
    const leetify = providers.find((provider) => provider.id === "leetify");
    const matches = (leetify?.state === "ready" && Array.isArray(leetify.matches))
      ? leetify.matches.slice(0, settings.matchesToShow)
      : [];

    if (!matches.length) {
      root.innerHTML = "";
      return;
    }

    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Matches</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          <div class="spx-matches-grid">
            ${matches.map(renderMatchCard).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function renderClipThumb(clip) {
    const views   = clip.views === 1 ? "1 view" : `${Number(clip.views).toLocaleString()} views`;
    const canPlay = !!clip.video;
    const dataAttrs = [
      canPlay ? `data-playable="1"` : "",
      clip.video ? `data-video="${escapeAttribute(clip.video)}"` : ""
    ].filter(Boolean).join(" ");

    return `
      <div class="spx-clip" ${dataAttrs}>
        <img class="spx-clip-thumb" src="${escapeAttribute(clip.thumbnail)}" alt="${escapeAttribute(clip.title)}" loading="lazy" />
        <div class="spx-clip-info">
          <span class="spx-clip-title">${escapeHtml(clip.title)}</span>
          <span class="spx-clip-views">${escapeHtml(views)}</span>
        </div>
        ${canPlay ? `<div class="spx-play-btn">▶</div>` : ""}
      </div>
    `;
  }

  function renderMatchCard(match) {
    const resultClass = match.result === "W"
      ? "spx-match-result-win"
      : match.result === "L"
        ? "spx-match-result-loss"
        : "spx-match-result-draw";
    const mapVisual = match.mapIcon
      ? `<img class="spx-match-map-icon" src="${escapeAttribute(match.mapIcon)}" alt="${escapeAttribute(match.mapName)}" loading="lazy" />`
      : `<div class="spx-match-map-fallback">${escapeHtml(getMatchMapFallback(match.mapName))}</div>`;
    const kdValue = (match.kills || match.deaths) ? `${match.kills || "0"}-${match.deaths || "0"}` : "";

    return `
      <article class="spx-match-card ${resultClass}" title="${escapeAttribute(match.mapName || "Map")}">
        <div class="spx-match-map-stack">
          ${mapVisual}
        </div>
        <div class="spx-match-mode">${escapeHtml(match.mode || "Match")}</div>
        ${match.score ? `<div class="spx-match-stat"><span class="spx-match-stat-label">Score</span><span class="spx-match-stat-value">${escapeHtml(match.score)}</span></div>` : ""}
        ${kdValue ? `<div class="spx-match-stat"><span class="spx-match-stat-label">K-D</span><span class="spx-match-stat-value">${escapeHtml(kdValue)}</span></div>` : ""}
      </article>
    `;
  }

  function getMatchMapFallback(value) {
    return String(value || "Map")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "MP";
  }

  function resolveHeaderMedalTarget() {
    return (
      document.querySelector(".profile_header_centered_persona > .persona_name") ||
      document.querySelector(".profile_header_centered_col .profile_header_centered_persona .persona_name")
    );
  }

  function prepareHeaderMedalTarget(target) {
    if (!target) {
      return;
    }

    target.classList.add("spx-header-medal-target");
  }

  function mountHeaderMedalRoot(target, root) {
    const popup = target.querySelector("#NamePopup");
    if (popup) {
      target.insertBefore(root, popup);
      return;
    }

    target.appendChild(root);
  }

  function getGcMedals(bundle) {
    const providers = Array.isArray(bundle?.providers) ? bundle.providers : [];
    const gcProvider = providers.find((provider) => provider.id === "gc");
    return gcProvider?.state === "ready" && Array.isArray(gcProvider.medals)
      ? gcProvider.medals
      : [];
  }

  function clearHeaderMedals() {
    const root = document.getElementById(HEADER_MEDALS_ID);
    if (root) {
      root.remove();
    }
    state.headerMedals = [];
    state.headerMedalKey = "";
    state.headerMedalIndex = 0;
  }

  function getVisibleHeaderMedalCount() {
    return window.matchMedia("(max-width: 910px)").matches ? 3 : 4;
  }

  function getVisibleMedals(medals, startIndex, count) {
    if (!medals.length) {
      return [];
    }

    return medals.slice(startIndex, startIndex + Math.min(count, medals.length));
  }

  function normalizeHeaderMedalStart(index, total) {
    if (!total) {
      return 0;
    }

    return Math.max(0, Math.min(index, total - 1));
  }

  function getPreviousHeaderMedalStart(index, count) {
    return Math.max(0, index - count);
  }

  function getNextHeaderMedalStart(index, total, count) {
    return Math.min(Math.max(total - 1, 0), index + count);
  }

  function renderLoadingRow() {
    return `
      <article class="spx-provider-row spx-provider-row-loading">
        <div class="spx-stat-line">
          <div class="spx-loading-copy">Loading stats…</div>
        </div>
      </article>
    `;
  }

  function renderProviderRow(provider) {
    const metrics       = Array.isArray(provider.metrics)        ? provider.metrics        : [];
    const commendations = Array.isArray(provider.commendations)  ? provider.commendations  : [];
    const competitiveRanks = Array.isArray(provider.competitiveRanks) ? provider.competitiveRanks : [];
    const wingmanRanks     = Array.isArray(provider.wingmanRanks)     ? provider.wingmanRanks     : [];
    const note = provider.message ? `<div class="spx-provider-note">${escapeHtml(provider.message)}</div>` : "";

    const rankIcon = provider.rankImage
      ? `<img class="spx-rank-image" src="${escapeAttribute(provider.rankImage)}" alt="${escapeAttribute(provider.rankLabel || "")}" title="${escapeAttribute(provider.rankLabel || "")}" />`
      : "";

    const isReady = provider.state === "ready" && (metrics.length || commendations.length || competitiveRanks.length || wingmanRanks.length);

    const body = isReady
      ? provider.id === "steam"
        ? renderSteamProviderBody({
            rankIcon,
            metrics,
            commendations,
            note,
            ranks: [...wingmanRanks, ...competitiveRanks]
          })
        : `
            <div class="spx-stat-line">
              ${rankIcon}
              ${metrics.length ? `<div class="spx-metric-grid">${metrics.map(renderMetric).join("")}</div>` : ""}
              ${metrics.length && commendations.length ? `<div class="spx-stat-divider"></div>` : ""}
              ${commendations.length ? renderCommendationStrip(commendations) : ""}
              ${note}
            </div>
            ${(wingmanRanks.length || competitiveRanks.length) ? renderRankStrip([...wingmanRanks, ...competitiveRanks]) : ""}
          `
      : `<div class="spx-stat-line">
          ${rankIcon}
          ${note || `<div class="spx-provider-note">Stats are not available right now.</div>`}
        </div>`;

    return `
      <article class="spx-provider-row spx-state-${escapeAttribute(provider.state)} spx-provider-${escapeAttribute(provider.id)}">
        ${body}
      </article>
    `;
  }

  function renderSteamProviderBody({ rankIcon, metrics, commendations, note, ranks }) {
    const levelMetric = metrics.find((metric) => metric?.kind === "cslevel" || metric?.label === "CS Level") || null;
    const friendCodeMetric = metrics.find((metric) => metric?.label === "Friend Code") || null;
    const secondaryMetrics = metrics.filter((metric) => metric !== levelMetric && metric !== friendCodeMetric);
    if (friendCodeMetric) {
      secondaryMetrics.push(friendCodeMetric);
    }

    const hasPrimary = Boolean(levelMetric) || commendations.length > 0;
    const hasSecondary = secondaryMetrics.length > 0;

    return `
      <div class="spx-stat-line spx-stat-line-steam">
        ${rankIcon}
        ${hasPrimary ? `
          <div class="spx-steam-primary">
            ${levelMetric ? `<div class="spx-metric-grid spx-metric-grid-steam-primary">${renderMetric(levelMetric)}</div>` : ""}
            ${levelMetric && commendations.length ? `<div class="spx-stat-divider"></div>` : ""}
            ${commendations.length ? renderCommendationStrip(commendations) : ""}
          </div>
        ` : ""}
        ${hasSecondary ? `<div class="spx-metric-grid spx-steam-secondary">${secondaryMetrics.map(renderMetric).join("")}</div>` : ""}
      </div>
      ${note}
      ${ranks.length ? renderRankStrip(ranks) : ""}
    `;
  }

  function renderRankStrip(ranks) {
    return `
      <div class="spx-competitive-strip">
        ${ranks.map((entry) => `
          <div class="spx-competitive-rank" title="${escapeAttribute(`${entry.mapName}: ${entry.rankLabel}`)}">
            <img class="spx-competitive-image" src="${escapeAttribute(entry.image)}" alt="${escapeAttribute(entry.rankLabel)}" />
            <div class="spx-competitive-map">${escapeHtml(entry.mapName)}</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderCommendationStrip(commendations) {
    return `
      <div class="spx-commend-strip">
        ${commendations.map((c) => `
          <div class="spx-commend-item spx-commend-${escapeAttribute(c.type)}">
            <img class="spx-commend-icon" src="${escapeAttribute(c.image)}" alt="${escapeAttribute(c.type)}" />
            <span class="spx-commend-value">${escapeHtml(c.value)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderMetric(metric) {
    if (metric?.kind === "cslevel" || metric?.kind === "faceitlevel") {
      return renderLevelMetric(metric);
    }

    if (metric?.kind === "recentform") {
      return renderRecentFormMetric(metric);
    }

    if (metric.label === "Premier" || metric.label === "Peak Premier") {
      return renderPremierMetric(metric);
    }

    if (metric.label === "Ban") {
      return renderBanMetric(metric);
    }

    const tooltip = metric.tooltip
      ? ` class="spx-metric spx-tooltip-anchor" title="${escapeAttribute(metric.tooltip)}" data-tooltip="${escapeAttribute(metric.tooltip)}"`
      : ` class="spx-metric"`;

    return `
      <div${tooltip}>
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-metric-value">${escapeHtml(metric.value)}</div>
        ${metric.meta ? `<div class="spx-metric-meta">${escapeHtml(metric.meta)}</div>` : ""}
      </div>
    `;
  }

  function resolveUserSettings(bundle) {
    return SPX_normalizeUserSettings(bundle?.settings || state.settings || SPX_DEFAULT_USER_SETTINGS);
  }

  function renderLevelMetric(metric) {
    const image = metric.image
      ? `<img class="spx-level-image" src="${escapeAttribute(metric.image)}" alt="${escapeAttribute(metric.label || "CS Level")}" title="${escapeAttribute(metric.label || "CS Level")}" />`
      : "";
    const metricClass = metric?.kind === "faceitlevel"
      ? "spx-metric spx-metric-level spx-metric-faceitlevel"
      : "spx-metric spx-metric-level";

    return `
      <div class="${metricClass}">
        <div class="spx-level-badge">
          ${image}
        </div>
      </div>
    `;
  }

  function renderRecentFormMetric(metric) {
    const tokens = Array.isArray(metric?.tokens) ? metric.tokens : [];

    return `
      <div class="spx-metric spx-metric-form">
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-form-list">
          ${tokens.map((token) => {
            const tokenClass = token === "W"
              ? "spx-form-token spx-form-token-win"
              : token === "L"
                ? "spx-form-token spx-form-token-loss"
                : "spx-form-token spx-form-token-draw";
            return `<span class="${tokenClass}">${escapeHtml(token)}</span>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderBanMetric(metric) {
    const isVac = String(metric.value).toLowerCase().includes("vac");
    const banClass = isVac ? "spx-ban-vac" : "spx-ban-game";
    return `
      <div class="spx-metric spx-metric-ban ${banClass}">
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-ban-badge">
          <div class="spx-metric-value">${escapeHtml(metric.value)}</div>
        </div>
      </div>
    `;
  }

  function renderPremierMetric(metric) {
    const rawNum = parseInt(String(metric.value || "").replace(/,/g, ""), 10);
    const tier = getPremierTier(rawNum);
    const badgeAsset = getPremierBadgeAsset(rawNum);
    const tooltip = metric.tooltip || metric.label;
    const tooltipClass = metric.tooltip ? " spx-tooltip-anchor" : "";
    const tooltipAttributes = metric.tooltip
      ? ` title="${escapeAttribute(tooltip)}" data-tooltip="${escapeAttribute(tooltip)}"`
      : ` title="${escapeAttribute(tooltip)}"`;
    const badgeStyle = badgeAsset ? ` style="background-image: url('${badgeAsset}');"` : "";

    return `
      <div class="spx-metric spx-metric-premier spx-premier-${tier}${tooltipClass}"${tooltipAttributes}>
        <div class="spx-premier-badge"${badgeStyle}>
          <div class="spx-metric-value">${escapeHtml(metric.value)}</div>
        </div>
      </div>
    `;
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

  function getPremierBadgeAsset(rating) {
    const tier = getPremierTier(rating);
    return PREMIER_BADGE_ASSETS[tier] || "";
  }

  function makeFallbackProvider(providerId) {
    return {
      id: providerId,
      state: "error",
      message: providerId === "faceit" ? "No FACEIT profile was found for this Steam account." : "Stats are not available right now.",
      metrics: []
    };
  }

  function mergeSteamMetrics(metrics, levelMetric) {
    const base = Array.isArray(metrics) ? [...metrics] : [];
    if (!levelMetric) {
      return base;
    }

    if (base.some((metric) => metric?.kind === "cslevel" || metric?.label === "CS Level")) {
      return base;
    }

    base.push(levelMetric);
    return base;
  }

  function mergeRankLists(primaryRanks, secondaryRanks) {
    const merged = [];
    const seen = new Set();

    for (const rank of [...(Array.isArray(primaryRanks) ? primaryRanks : []), ...(Array.isArray(secondaryRanks) ? secondaryRanks : [])]) {
      if (!rank || typeof rank !== "object") {
        continue;
      }

      const key = `${rank.mapName || ""}:${rank.rankLabel || ""}:${rank.image || ""}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(rank);
    }

    return merged;
  }

  function mergeLeetifyWithFaceit(leetifyProvider, faceitProvider) {
    const leetifyMetrics = Array.isArray(leetifyProvider.metrics) ? [...leetifyProvider.metrics] : [];
    const faceitMetrics = Array.isArray(faceitProvider.metrics) ? faceitProvider.metrics : [];
    const eloMetric = faceitMetrics.find((metric) => metric?.label === "ELO");

    if (eloMetric && !leetifyMetrics.some((metric) => metric?.label === "ELO")) {
      const mergedMetrics = [];
      if (faceitProvider.rankImage && !leetifyMetrics.some((metric) => metric?.kind === "faceitlevel")) {
        mergedMetrics.push({
          kind: "faceitlevel",
          label: faceitProvider.rankLabel || "FACEIT level",
          image: faceitProvider.rankImage
        });
      }
      mergedMetrics.push(eloMetric);

      const premierIndex = leetifyMetrics.findIndex((metric) => metric?.label === "Premier" || metric?.label === "Peak Premier");
      if (premierIndex >= 0) {
        leetifyMetrics.splice(premierIndex + 1, 0, ...mergedMetrics);
      } else {
        leetifyMetrics.unshift(...mergedMetrics);
      }
    }

    return {
      ...leetifyProvider,
      rankImage: "",
      rankLabel: "",
      metrics: leetifyMetrics
    };
  }

  function escapeHtml(value) {
    return String(value || "")
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
