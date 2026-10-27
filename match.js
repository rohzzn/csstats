// Match preview on FACEIT match rooms: both rosters with trust, peak Premier and FACEIT ratings and each
// player's best map, plus each team's win chance and a per-map prediction. Pinned on top of the room
// from the moment it opens and kept for the whole match; the arrow collapses it to one line.
(function () {
  const ROOM_PATH = /\/cs2\/room\/(1-[0-9a-f-]{36})/i;
  const HOST_ID = "spx-match-preview";
  const REFRESH_MS = 30 * 1000;
  const DONE_STATUSES = ["FINISHED", "CANCELLED", "ABORTED"];
  // FACEIT CS2 skill levels by ELO (level 10 is 2,001+).
  const FACEIT_LEVEL_FLOORS = [1, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
  const PREMIER_TIERS = [
    [30000, "gold", "30000+"], [25000, "red", "25000-29999"], [20000, "pink", "20000-24999"],
    [15000, "purple", "15000-19999"], [10000, "blue", "10000-14999"], [5000, "lightblue", "5000-9999"], [1, "grey", "0-4999"]
  ];
  // A best-map win rate this high over this many games is far past normal.
  const UNUSUAL_WIN_RATE = 80;
  const UNUSUAL_MIN_MATCHES = 15;
  const CHEVRON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const state = { matchId: null, host: null, shadow: null, timer: 0, token: 0, data: null, error: "", myId: null, collapsed: false };

  // FACEIT is a single-page app: rooms open and close without a page load.
  checkRoute();
  setInterval(checkRoute, 1000);

  function checkRoute() {
    const matchId = (window.location.pathname.match(ROOM_PATH) || [])[1] || null;
    if (matchId === state.matchId) return;
    unmount();
    if (matchId) mount(matchId);
  }

  async function mount(matchId) {
    state.matchId = matchId;
    state.data = null;
    state.error = "";
    state.collapsed = readCollapsed(matchId);

    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL("match.css")}"><div class="root"></div>`;
    shadow.addEventListener("click", handleClick);
    (document.body || document.documentElement).append(host);
    state.host = host;
    state.shadow = shadow;
    render();

    const stored = await chrome.storage.local.get("spxMySteamId").catch(() => null);
    state.myId = stored?.spxMySteamId || null;
    load();
  }

  function unmount() {
    clearTimeout(state.timer);
    state.token += 1;
    state.host?.remove();
    state.host = null;
    state.shadow = null;
    state.matchId = null;
  }

  async function load() {
    const token = ++state.token;
    clearTimeout(state.timer);
    const response = await chrome.runtime.sendMessage({ type: "SPX_GET_MATCH_PREVIEW", matchId: state.matchId })
      .catch((error) => ({ ok: false, error: error?.message }));
    if (token !== state.token) return;

    if (response?.ok) {
      state.data = response;
      state.error = "";
    } else if (!state.data) {
      state.error = response?.error || "The match preview couldn't load.";
    }
    render();

    if (!DONE_STATUSES.includes(state.data?.status)) {
      state.timer = setTimeout(load, REFRESH_MS);
    }
  }

  function handleClick(event) {
    if (!event.target.closest("[data-toggle]")) return;
    state.collapsed = !state.collapsed;
    writeCollapsed(state.matchId, state.collapsed);
    render();
  }

  function readCollapsed(matchId) {
    try {
      return sessionStorage.getItem(`spx-preview-collapsed:${matchId}`) === "1";
    } catch (_error) {
      return false;
    }
  }

  function writeCollapsed(matchId, collapsed) {
    try {
      sessionStorage.setItem(`spx-preview-collapsed:${matchId}`, collapsed ? "1" : "0");
    } catch (_error) {
      // Private mode or blocked storage: the panel still collapses for this view.
    }
  }

  // ── Render ──

  function render() {
    const root = state.shadow?.querySelector(".root");
    if (!root) return;

    const view = buildView(state.data);
    root.innerHTML = `
      <section class="panel${state.collapsed ? " collapsed" : ""}" aria-label="Match preview">
        <header class="bar">
          <span class="title">Match preview</span>
          ${view ? renderChips(view) : ""}
          ${state.collapsed && view ? `<span class="summary">${renderSummary(view)}</span>` : ""}
          <button type="button" class="toggle" data-toggle aria-expanded="${!state.collapsed}" aria-label="${state.collapsed ? "Expand" : "Collapse"} match preview">${CHEVRON}</button>
        </header>
        ${state.collapsed ? "" : `<div class="body">${view ? renderBody(view) : `<p class="note">${escapeHtml(state.error || "Loading both teams…")}</p>`}</div>`}
      </section>
    `;
    // Sizes and badge art go through the DOM rather than style attributes, which a page's CSP may block.
    root.querySelectorAll("[data-w]").forEach((element) => { element.style.width = `${element.dataset.w}%`; });
    root.querySelectorAll("[data-bg]").forEach((element) => { element.style.backgroundImage = `url("${element.dataset.bg}")`; });
    // An avatar that can't load shows the player's initial instead of a broken image.
    root.querySelectorAll("img.avatar").forEach((image) => {
      image.addEventListener("error", () => {
        const initial = document.createElement("span");
        initial.className = "avatar";
        initial.textContent = image.dataset.initial || "?";
        image.replaceWith(initial);
      }, { once: true });
    });
  }

  // Your team first when your Steam account is in the room; otherwise FACEIT's order and team names.
  function buildView(data) {
    if (!data?.teams?.length) return null;
    const mineIndex = state.myId ? data.teams.findIndex((team) => team.players.some((player) => player.steamId === state.myId)) : -1;
    const order = mineIndex === 1 ? [1, 0] : [0, 1];
    const teams = order.map((index) => ({
      ...data.teams[index],
      label: mineIndex === -1 ? data.teams[index].name || `Team ${index + 1}` : index === mineIndex ? "Your team" : "Enemy team",
      chip: mineIndex === -1 ? shortTeamName(data.teams[index].name, index) : index === mineIndex ? "Yours" : "Theirs",
      chance: data.winChance ? data.winChance[index] : null
    }));
    const prediction = (data.prediction || []).map((map) => ({ ...map, rates: order.map((index) => map.rates[index]) }));
    return { ...data, teams, prediction, hasPick: prediction.some((map) => map.picked) };
  }

  function shortTeamName(name, index) {
    return String(name || "").replace(/^Team\s+/i, "") || `Team ${index + 1}`;
  }

  function renderChips(view) {
    const map = view.map
      ? `<span class="chip">${escapeHtml(view.map)} <span class="muted">${view.hasPick ? "picked" : ""}</span></span>`
      : `<span class="chip">Map veto</span>`;
    const mode = view.mode ? `<span class="chip">${escapeHtml(view.mode)}</span>` : "";
    return `<span class="chips">${map}${mode}</span>`;
  }

  function renderSummary(view) {
    const [first, second] = view.teams;
    const flagged = view.teams.flatMap((team) => team.players).filter(isFlagged).length;
    return [
      first.chance !== null ? `${first.chance}% – ${second.chance}%` : "",
      flagged ? `${flagged} to look at` : ""
    ].filter(Boolean).join(" · ");
  }

  function renderBody(view) {
    return `
      <div class="top">
        ${renderWinChance(view)}
        ${renderPrediction(view)}
      </div>
      <div class="teams">
        ${view.teams.map(renderTeam).join("")}
      </div>
    `;
  }

  function renderWinChance(view) {
    const [first, second] = view.teams;
    if (first.chance === null) {
      return `
        <div class="card">
          <div class="card-title"><b>Team win chance</b><span>from both rosters</span></div>
          <p class="note">Not enough FACEIT data for a guess.</p>
        </div>
      `;
    }

    const picked = view.prediction.find((map) => map.picked);
    const favoured = picked?.edge && picked.edge !== "flip" ? view.teams.find((team) => team.id === picked.edge) : null;
    const reason = [
      `Average FACEIT Elo ${formatWhole(first.avgElo)} vs ${formatWhole(second.avgElo)}`,
      favoured ? `and ${picked.name} favours ${favoured.label === "Your team" ? "your team" : favoured.label === "Enemy team" ? "the enemy" : favoured.label}` : ""
    ].filter(Boolean).join(", ");

    return `
      <div class="card chance">
        <div class="card-title"><b>Team win chance</b><span>from both rosters</span></div>
        <div class="chance-names"><span>${escapeHtml(first.label)}</span><span>${escapeHtml(second.label)}</span></div>
        <div class="chance-numbers"><b class="a">${first.chance}%</b><b class="b">${second.chance}%</b></div>
        <div class="split big" role="img" aria-label="${escapeAttribute(`Win chance: ${first.label} ${first.chance} percent, ${second.label} ${second.chance} percent`)}"><span class="a" data-w="${first.chance}"></span><span class="b" data-w="${second.chance}"></span></div>
        <p class="reason">${escapeHtml(reason)}.</p>
        <p class="fine">A guess from public numbers, not a sure thing.</p>
      </div>
    `;
  }

  function renderPrediction(view) {
    const [first, second] = view.teams;
    const rows = view.prediction.map((map) => {
      const [a, b] = map.rates;
      const known = a !== null && b !== null;
      const chip = !map.edge ? `<span class="tag none">No data</span>`
        : map.edge === "flip" ? `<span class="tag flip">Coin flip</span>`
        : map.edge === first.id ? `<span class="tag a">${escapeHtml(first.chip)}</span>` : `<span class="tag b">${escapeHtml(second.chip)}</span>`;
      const total = known && a + b > 0 ? a + b : 0;
      return `
        <div class="map${map.picked ? " picked" : view.hasPick ? " banned" : ""}">
          <span class="map-name">${escapeHtml(map.name)}</span>
          <span class="pct a">${a !== null ? `${a}%` : "–"}</span>
          <span class="split">${total ? `<span class="a" data-w="${Math.round((a / total) * 100)}"></span><span class="b" data-w="${Math.round((b / total) * 100)}"></span>` : ""}</span>
          <span class="pct b">${b !== null ? `${b}%` : "–"}</span>
          ${chip}
        </div>
      `;
    }).join("");

    return `
      <div class="card">
        <div class="card-title"><b>Match prediction</b><span>both sides' best maps and the coin flips</span></div>
        <div class="map head"><span>Map</span><span class="pct a">${escapeHtml(first.chip)}</span><span></span><span class="pct b">${escapeHtml(second.chip)}</span><span></span></div>
        <div class="maps">${rows || `<p class="note">No map records yet.</p>`}</div>
      </div>
    `;
  }

  function renderTeam(team) {
    return `
      <div class="team">
        <div class="row head"><span>${escapeHtml(team.label)}</span><span>Trust</span><span>Peak Premier</span><span>Peak FACEIT</span><span>Best map</span></div>
        ${team.players.map(renderPlayer).join("")}
        <div class="foot">
          <span>Avg peak Premier <b>${team.avgPeakPremier ? formatWhole(team.avgPeakPremier) : "–"}</b></span>
          <span>Avg peak FACEIT <b>${team.avgPeakFaceit ? formatWhole(team.avgPeakFaceit) : "–"}</b></span>
        </div>
      </div>
    `;
  }

  function isFlagged(player) {
    return Boolean(player.ban || player.trust?.autoflag || (player.trust && player.trust.score < 50));
  }

  function renderPlayer(player) {
    const flagged = isFlagged(player);
    const why = player.ban ? (player.ban.vac ? "VAC banned" : "Game banned")
      : player.trust?.autoflag ? "Auto-flagged"
      : player.trust && player.trust.score < 50 ? "Low trust" : "";
    const name = escapeHtml(player.nickname || "Player");
    const link = player.steamId
      ? `<a class="name" href="https://steamcommunity.com/profiles/${player.steamId}" target="_blank" rel="noopener noreferrer" title="Open their Steam profile">${name}</a>`
      : `<span class="name">${name}</span>`;
    const initial = (player.nickname || "?").charAt(0).toUpperCase();
    const avatar = player.avatar
      ? `<img class="avatar" src="${escapeAttribute(player.avatar)}" width="30" height="30" alt="" loading="lazy" decoding="async" data-initial="${escapeAttribute(initial)}">`
      : `<span class="avatar">${escapeHtml(initial)}</span>`;

    return `
      <div class="row${flagged ? " flagged" : ""}">
        <span class="who">${avatar}<span class="who-text">${link}${player.steamId && player.steamId === state.myId ? `<span class="you">you</span>` : ""}${why ? `<span class="why">${why}</span>` : ""}</span></span>
        ${renderTrust(player)}
        ${renderPremier(player.premierPeak)}
        ${renderFaceit(player.faceitPeak)}
        ${renderBestMap(player.bestMap)}
      </div>
    `;
  }

  function renderTrust(player) {
    if (player.ban) {
      return `<span class="ban" title="${escapeAttribute([player.ban.vac ? `${player.ban.vac} VAC ban(s)` : "", player.ban.game ? `${player.ban.game} game ban(s)` : ""].filter(Boolean).join(" · "))}">${player.ban.vac ? "VAC" : "Ban"}</span>`;
    }
    if (!player.trust) {
      return `<span class="muted" title="${player.trust === null ? "No trust data for this player" : "Not checked yet"}">–</span>`;
    }
    const score = player.trust.score;
    const shown = Math.floor(score);
    const band = score >= 80 ? "high" : score >= 50 ? "medium" : score >= 25 ? "low" : "critical";
    const tip = [`Trust score ${shown} / 100`, player.trust.autoflag ? `Auto-flagged: ${player.trust.autoflag}` : "", "An estimate from public data, not proof."].filter(Boolean).join("\n");
    return `<span class="trust trust-${band}" title="${escapeAttribute(tip)}">${renderRing(score)}${shown}</span>`;
  }

  // 270° gauge open at the bottom, like the Stats panel's trust score.
  function renderRing(score) {
    const path = "M 3.52 14.48 A 7.75 7.75 0 1 1 14.48 14.48";
    const filled = Math.max(0, Math.min(100, score));
    return `<svg class="ring" width="14" height="14" viewBox="0 0 18 18" aria-hidden="true" focusable="false"><path class="track" d="${path}" pathLength="100" fill="none" stroke-width="2.6" stroke-linecap="round"/>${filled > 0 ? `<path class="fill" d="${path}" pathLength="100" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} 100"/>` : ""}</svg>`;
  }

  function renderPremier(rating) {
    if (!rating) return `<span class="muted">–</span>`;
    const [, tier, file] = PREMIER_TIERS.find(([floor]) => rating >= floor);
    return `<span class="premier premier-${tier}" data-bg="${escapeAttribute(chrome.runtime.getURL(`premier/${file}.png`))}">${formatWhole(rating)}</span>`;
  }

  function renderFaceit(elo) {
    if (!elo) return `<span class="muted">–</span>`;
    let level = 1;
    FACEIT_LEVEL_FLOORS.forEach((floor, index) => { if (elo >= floor) level = index + 1; });
    return `<span class="elo"><img src="${chrome.runtime.getURL(`faceit/${level}.svg`)}" width="22" height="22" alt="FACEIT level ${level}">${formatWhole(elo)}</span>`;
  }

  function renderBestMap(best) {
    if (!best) return `<span class="muted">–</span>`;
    const unusual = best.winRate >= UNUSUAL_WIN_RATE && best.matches >= UNUSUAL_MIN_MATCHES;
    return `<span class="best${unusual ? " unusual" : ""}" title="${escapeAttribute(`${best.winRate}% wins over ${formatWhole(best.matches)} FACEIT matches${unusual ? " · far past normal" : ""}`)}"><b>${escapeHtml(best.name)}</b><span>${best.winRate}%</span></span>`;
  }

  // ── Helpers ──

  function formatWhole(value) {
    return Math.round(Number(value) || 0).toLocaleString("en-US");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }
})();
