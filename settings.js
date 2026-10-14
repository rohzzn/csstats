(function (globalScope) {
  const DEFAULT_USER_SETTINGS = Object.freeze({
    showMedals: true,
    showPeakPremier: true,
    showPeakFaceit: true,
    showCompetitiveRanks: true,
    showMatches: true,
    matchesToShow: 10,
    showClips: true
  });

  const USER_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_USER_SETTINGS));

  // Only showPeakPremier and showPeakFaceit are user-configurable; the other keys stay for storage compatibility.
  function normalizeUserSettings(raw = {}) {
    return {
      showMedals: true,
      showPeakPremier: raw?.showPeakPremier !== false,
      showPeakFaceit: raw?.showPeakFaceit !== false,
      showCompetitiveRanks: true,
      showMatches: true,
      matchesToShow: 10,
      showClips: true
    };
  }

  function isUserSettingKey(key) {
    return USER_SETTING_KEYS.includes(String(key || ""));
  }

  function storageGet(defaults) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.get(defaults, (items) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
            return;
          }

          resolve(items || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageSet(values) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set(values, () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
            return;
          }

          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function readUserSettings() {
    if (!globalScope.chrome?.storage?.sync) {
      return { ...DEFAULT_USER_SETTINGS };
    }

    try {
      const stored = await storageGet(DEFAULT_USER_SETTINGS);
      return normalizeUserSettings(stored);
    } catch (_error) {
      return { ...DEFAULT_USER_SETTINGS };
    }
  }

  async function writeUserSettings(partial = {}) {
    const current = await readUserSettings();
    const next = normalizeUserSettings({ ...current, ...partial });
    const changed = {};
    for (const key of Object.keys(partial || {}).filter(isUserSettingKey)) {
      changed[key] = next[key];
    }

    if (Object.keys(changed).length) {
      await storageSet(changed);
    }

    return next;
  }

  globalScope.SPX_DEFAULT_USER_SETTINGS = DEFAULT_USER_SETTINGS;
  globalScope.SPX_USER_SETTING_KEYS = USER_SETTING_KEYS;
  globalScope.SPX_normalizeUserSettings = normalizeUserSettings;
  globalScope.SPX_isUserSettingKey = isUserSettingKey;
  globalScope.SPX_readUserSettings = readUserSettings;
  globalScope.SPX_writeUserSettings = writeUserSettings;
})(typeof globalThis !== "undefined" ? globalThis : self);
