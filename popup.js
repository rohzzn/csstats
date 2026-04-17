(function () {
  const controls = {
    showMedals: document.getElementById("showMedals"),
    showPeakPremier: document.getElementById("showPeakPremier"),
    showCompetitiveRanks: document.getElementById("showCompetitiveRanks"),
    showMatches: document.getElementById("showMatches"),
    showClips: document.getElementById("showClips"),
    matchesToShow5: document.getElementById("matchesToShow5"),
    matchesToShow10: document.getElementById("matchesToShow10"),
    matchesToShow15: document.getElementById("matchesToShow15"),
    matchesGroup: document.getElementById("matchesGroup"),
    saveState: document.getElementById("saveState")
  };

  let saveTimer = null;

  init().catch((error) => {
    console.error("[CS Stats Popup]", error);
    setSaveState("Could not load settings.");
  });

  async function init() {
    const settings = await SPX_readUserSettings();
    applySettingsToControls(settings);
    bindEvents();
  }

  function bindEvents() {
    controls.showMedals.addEventListener("change", onToggleChange);
    controls.showPeakPremier.addEventListener("change", onToggleChange);
    controls.showCompetitiveRanks.addEventListener("change", onToggleChange);
    controls.showMatches.addEventListener("change", onToggleChange);
    controls.showClips.addEventListener("change", onToggleChange);
    controls.matchesToShow5.addEventListener("change", onMatchesCountChange);
    controls.matchesToShow10.addEventListener("change", onMatchesCountChange);
    controls.matchesToShow15.addEventListener("change", onMatchesCountChange);
  }

  async function onToggleChange() {
    const settings = readSettingsFromControls();
    applySettingsToControls(settings);
    await SPX_writeUserSettings(settings);
    setSaveState("Saved");
  }

  async function onMatchesCountChange() {
    const settings = readSettingsFromControls();
    await SPX_writeUserSettings(settings);
    setSaveState("Saved");
  }

  function readSettingsFromControls() {
    return SPX_normalizeUserSettings({
      showMedals: controls.showMedals.checked,
      showPeakPremier: controls.showPeakPremier.checked,
      showCompetitiveRanks: controls.showCompetitiveRanks.checked,
      showMatches: controls.showMatches.checked,
      matchesToShow: controls.matchesToShow15.checked ? 15 : controls.matchesToShow10.checked ? 10 : 5,
      showClips: controls.showClips.checked
    });
  }

  function applySettingsToControls(settings) {
    controls.showMedals.checked = settings.showMedals;
    controls.showPeakPremier.checked = settings.showPeakPremier;
    controls.showCompetitiveRanks.checked = settings.showCompetitiveRanks;
    controls.showMatches.checked = settings.showMatches;
    controls.showClips.checked = settings.showClips;
    controls.matchesToShow5.checked = settings.matchesToShow === 5;
    controls.matchesToShow10.checked = settings.matchesToShow === 10;
    controls.matchesToShow15.checked = settings.matchesToShow === 15;
    controls.matchesGroup.classList.toggle("is-disabled", !settings.showMatches);
  }

  function setSaveState(message) {
    clearTimeout(saveTimer);
    controls.saveState.textContent = message;

    saveTimer = setTimeout(() => {
      controls.saveState.textContent = "";
    }, 1800);
  }
})();
