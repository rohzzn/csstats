(function () {
  const ROOT_ID  = "spx-cs2-profile-intel";
  const CLIPS_ID = "spx-cs2-clips-intel";
  const DISPLAY_ORDER = ["steam", "faceit", "leetify", "csstats"];

  const state = {
    steamId: null,
    profileUrl: null,
    root: null,
    clipsRoot: null
  };

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

    // Clips section goes directly after the stats section
    const clipsRoot = ensureRoot(CLIPS_ID);
    state.clipsRoot = clipsRoot;
    if (!context.target.contains(clipsRoot)) {
      root.insertAdjacentElement("afterend", clipsRoot);
    }

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

      renderBundle(state.root, response);
      renderClipsSection(state.clipsRoot, response);
    } catch (error) {
      renderFatal(state.root, error.message || "The extension could not load provider data.");
    }
  }

  function renderLoading(root) {
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
    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Stats</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          <div class="spx-inline-note">${escapeHtml(message)}</div>
        </div>
      </div>
    `;
  }

  function renderBundle(root, bundle) {
    const providerMap = new Map(
      (Array.isArray(bundle.providers) ? bundle.providers : []).map((provider) => [provider.id, provider])
    );

    // Merge GC commendations into the Steam row so they appear side-by-side
    const gcProvider    = providerMap.get("gc");
    const steamProvider = providerMap.get("steam");
    if (steamProvider && gcProvider?.state === "ready" && gcProvider.commendations?.length) {
      providerMap.set("steam", { ...steamProvider, commendations: gcProvider.commendations });
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
      root.innerHTML = "";
      return;
    }

    root.innerHTML = `
      <div class="profile_customization_header spx-showcase-header">Stats</div>
      <div class="profile_customization_block">
        <div class="showcase_content_bg spx-shell">
          <div class="spx-row-list">${providers.map((provider) => renderProviderRow(provider)).join("")}</div>
        </div>
      </div>
    `;
  }

  function renderClipsSection(root, bundle) {
    if (!root) return;

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
      ? `
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
    if (metric.label === "Premier" || metric.label === "Peak Premier") {
      return renderPremierMetric(metric);
    }

    if (metric.label === "Ban") {
      return renderBanMetric(metric);
    }

    return `
      <div class="spx-metric">
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-metric-value">${escapeHtml(metric.value)}</div>
        ${metric.meta ? `<div class="spx-metric-meta">${escapeHtml(metric.meta)}</div>` : ""}
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
    return `
      <div class="spx-metric spx-metric-premier spx-premier-${tier}">
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-premier-badge">
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

  function makeFallbackProvider(providerId) {
    return {
      id: providerId,
      state: "error",
      message: providerId === "faceit" ? "No FACEIT profile was found for this Steam account." : "Stats are not available right now.",
      metrics: []
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
