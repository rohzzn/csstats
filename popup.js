(function () {
  const SAVED_VISIBLE_MS = 1800;

  // Each segmented control maps a radio group (Current | Peak) to one boolean setting.
  const MODE_SETTINGS = Object.freeze([
    { key: "showPeakPremier", name: "premierMode", label: "Premier" },
    { key: "showPeakFaceit", name: "faceitMode", label: "FACEIT ELO" }
  ]);

  const elements = {
    version: document.getElementById("appVersion"),
    saveState: document.getElementById("saveState"),
    saveError: document.getElementById("saveError")
  };

  const modes = MODE_SETTINGS.map((setting) => ({
    ...setting,
    radios: [...document.querySelectorAll(`input[name="${setting.name}"]`)],
    stored: true
  })).filter((mode) => mode.radios.length);

  let pendingWrites = 0;
  let writeId = 0;
  let savedTimer = null;

  renderVersion();
  init().catch((error) => {
    console.error("[CS Stats Popup]", error);
    showError("Could not load settings.");
  });

  async function init() {
    const settings = await SPX_readUserSettings();
    modes.forEach((mode) => {
      mode.stored = settings[mode.key] !== false;
      applyMode(mode, mode.stored);
      mode.radios.forEach((radio) => radio.addEventListener("change", (event) => onModeChange(mode, event)));
    });
    subscribeToStorage();
  }

  function renderVersion() {
    const version = readManifestVersion();
    if (!version) return;
    elements.version.textContent = `v${version}`;
    elements.version.hidden = false;
  }

  function readManifestVersion() {
    try {
      return String(globalThis.chrome?.runtime?.getManifest?.()?.version || "");
    } catch (_error) {
      return "";
    }
  }

  async function onModeChange(mode, event) {
    if (!event.target.checked) return;

    const showPeak = event.target.value === "peak";
    const id = ++writeId;
    pendingWrites += 1;
    clearSaved();

    try {
      await writeSetting(mode.key, showPeak);
      mode.stored = showPeak;
      if (id === writeId) {
        hideError();
        showSaved();
      }
    } catch (error) {
      console.error("[CS Stats Popup]", error);
      if (id === writeId) {
        applyMode(mode, mode.stored);
        showError(`Couldn't save. ${mode.label}: ${mode.stored ? "Peak" : "Current"} is still active.`, describeError(error));
      }
    } finally {
      pendingWrites -= 1;
    }
  }

  function writeSetting(key, value) {
    return new Promise((resolve, reject) => {
      const storage = globalThis.chrome?.storage?.sync;
      if (!storage?.set) {
        reject(new Error("storage unavailable"));
        return;
      }

      try {
        storage.set({ [key]: value }, () => {
          const lastError = globalThis.chrome?.runtime?.lastError;
          if (lastError) {
            reject(new Error(lastError.message || "storage error"));
            return;
          }

          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function subscribeToStorage() {
    const onChanged = globalThis.chrome?.storage?.onChanged;
    if (!onChanged?.addListener) return;

    onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      modes.forEach((mode) => {
        if (!changes?.[mode.key]) return;
        mode.stored = changes[mode.key].newValue !== false;
        if (!pendingWrites) {
          applyMode(mode, mode.stored);
          hideError();
        }
      });
    });
  }

  function applyMode(mode, showPeak) {
    mode.radios.forEach((radio) => {
      radio.checked = (radio.value === "peak") === showPeak;
    });
  }

  function describeError(error) {
    const message = String(error?.message || "").trim().replace(/\.$/, "");
    return message || "unknown error";
  }

  function showSaved() {
    clearTimeout(savedTimer);
    elements.saveState.textContent = "Saved";
    elements.saveState.classList.add("is-visible");
    savedTimer = setTimeout(clearSaved, SAVED_VISIBLE_MS);
  }

  function clearSaved() {
    clearTimeout(savedTimer);
    elements.saveState.textContent = "";
    elements.saveState.classList.remove("is-visible");
  }

  function showError(message, detail = "") {
    const title = document.createElement("span");
    title.className = "spx-save-error-title";
    title.textContent = message;
    elements.saveError.replaceChildren(title);

    if (detail) {
      const reason = document.createElement("span");
      reason.className = "spx-save-error-detail";
      reason.textContent = detail;
      elements.saveError.append(reason);
    }

    elements.saveError.hidden = false;
  }

  function hideError() {
    elements.saveError.textContent = "";
    elements.saveError.hidden = true;
  }
})();
