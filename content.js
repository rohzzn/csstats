(function () {
  const ROOT_ID = "spx-cs2-profile-intel";
  const DISPLAY_ORDER = ["steam", "faceit", "leetify", "csstats"];

  const state = {
    steamId: null,
    profileUrl: null,
    root: null
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

    const root = ensureRoot();
    state.root = root;

    if (!context.target.contains(root)) {
      context.target.prepend(root);
    }

    renderLoading(root);
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);

    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
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

    const providers = DISPLAY_ORDER
      .map((providerId) => providerMap.get(providerId) || makeFallbackProvider(providerId))
      .filter((provider) => {
        if (provider.state !== "ready") { return false; }
        const hasMetrics = Array.isArray(provider.metrics) && provider.metrics.length > 0;
        const hasRanks = (Array.isArray(provider.competitiveRanks) && provider.competitiveRanks.length > 0) ||
                         (Array.isArray(provider.wingmanRanks) && provider.wingmanRanks.length > 0);
        return hasMetrics || hasRanks;
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
    const metrics = Array.isArray(provider.metrics) ? provider.metrics : [];
    const competitiveRanks = Array.isArray(provider.competitiveRanks) ? provider.competitiveRanks : [];
    const wingmanRanks = Array.isArray(provider.wingmanRanks) ? provider.wingmanRanks : [];
    const note = provider.message ? `<div class="spx-provider-note">${escapeHtml(provider.message)}</div>` : "";

    const rankIcon = provider.rankImage
      ? `<img class="spx-rank-image" src="${escapeAttribute(provider.rankImage)}" alt="${escapeAttribute(provider.rankLabel || "")}" title="${escapeAttribute(provider.rankLabel || "")}" />`
      : "";

    const isReady = provider.state === "ready" && (metrics.length || competitiveRanks.length || wingmanRanks.length);

    const body = isReady
      ? `
          <div class="spx-stat-line">
            ${rankIcon}
            ${metrics.length ? `<div class="spx-metric-grid">${metrics.map(renderMetric).join("")}</div>` : ""}
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

  function renderMetric(metric) {
    if (metric.label === "Premier" || metric.label === "Peak Premier") {
      return renderPremierMetric(metric);
    }

    return `
      <div class="spx-metric">
        <div class="spx-metric-label">${escapeHtml(metric.label)}</div>
        <div class="spx-metric-value">${escapeHtml(metric.value)}</div>
        ${metric.meta ? `<div class="spx-metric-meta">${escapeHtml(metric.meta)}</div>` : ""}
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
