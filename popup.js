(() => {
  const pressUI = window.PressUI;
  const { defaults, i18n, normalizeEngine } = pressUI;
  const currentConfig = { ...defaults };
  const state = {
    activeTab: null,
    pageAllowed: false,
    pageStateReadFailed: false,
    isPageTranslated: false,
    busy: false
  };

  const appTitle = document.getElementById("app-title");
  const logoBadge = document.getElementById("logo-badge-text");
  const sourceLangSelect = document.getElementById("source-lang-select");
  const targetLangSelect = document.getElementById("target-lang-select");
  const swapLangBtn = document.getElementById("swap-lang-btn");
  const engineSwitcher = document.getElementById("engine-switcher");
  const togglePageBtn = document.getElementById("toggle-page-btn");
  const toggleBtnText = document.getElementById("toggle-btn-text");
  const openSettingsBtn = document.getElementById("open-settings-btn");
  const popupMessage = document.getElementById("popup-message");
  const popupMessageText = document.getElementById("popup-message-text");
  const configureApiBtn = document.getElementById("configure-api-btn");

  function t() {
    return i18n[currentConfig.uiLang] || i18n["zh-CN"];
  }

  function languageValues(includeAuto) {
    return Object.entries(t().langNames).filter(([code]) => includeAuto || code !== "auto");
  }

  function renderLanguageOptions(select, selectedValue, includeAuto, fallback) {
    const values = languageValues(includeAuto);
    select.replaceChildren();
    for (const [code, label] of values) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = values.some(([code]) => code === selectedValue) ? selectedValue : fallback;
    return select.value;
  }

  function setMessage(message, { error = false, showConfigure = false } = {}) {
    popupMessageText.textContent = message;
    popupMessage.dataset.empty = message ? "false" : "true";
    popupMessage.classList.toggle("error", error);
    popupMessage.setAttribute("role", error ? "alert" : "status");
    popupMessage.setAttribute("aria-live", error ? "assertive" : "polite");
    configureApiBtn.textContent = t().configureApi;
    configureApiBtn.classList.toggle("hidden", !showConfigure);
  }

  function renderMessage() {
    if (!state.pageAllowed || state.pageStateReadFailed) {
      setMessage(t().unavailablePage, { error: true });
      return;
    }
    if (currentConfig.translateEngine === "api" && !isApiConfigured()) {
      setMessage(t().apiNeedsConfig, { showConfigure: true });
      return;
    }
    setMessage("");
  }

  function isApiConfigured() {
    return Boolean(
      String(currentConfig.apiKey || "").trim() &&
      String(currentConfig.apiModel || "").trim() &&
      String(currentConfig.apiBaseUrl || "").trim()
    );
  }

  function renderButton() {
    const dict = t();
    toggleBtnText.textContent = state.isPageTranslated ? dict.btnRestoreOriginal : dict.btnStartTranslate;
    togglePageBtn.classList.toggle("active", state.isPageTranslated);
    togglePageBtn.disabled = state.busy || !state.pageAllowed;
  }

  function renderEngine() {
    for (const button of engineSwitcher.querySelectorAll("[data-engine-val]")) {
      const selected = button.dataset.engineVal === currentConfig.translateEngine;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = state.busy;
    }
  }

  function applyLanguage() {
    const dict = t();
    document.documentElement.lang = currentConfig.uiLang;
    appTitle.textContent = dict.appTitle;
    logoBadge.textContent = dict.logoBadge;
    document.getElementById("open-settings-label").textContent = dict.openSettings;
    document.getElementById("label-lang-direction").textContent = dict.labelLangDirection;
    document.getElementById("label-source-lang").textContent = dict.labelSourceLang;
    document.getElementById("label-target-lang").textContent = dict.labelTargetLang;
    sourceLangSelect.setAttribute("aria-label", dict.labelSourceLang);
    targetLangSelect.setAttribute("aria-label", dict.labelTargetLang);
    document.getElementById("label-engine-select").textContent = dict.labelEngineSelect;
    document.getElementById("btn-engine-google").textContent = dict.btnEngineGoogle;
    document.getElementById("btn-engine-api").textContent = dict.btnEngineApi;
    swapLangBtn.setAttribute("aria-label", dict.swapLanguages);
    swapLangBtn.title = dict.swapLanguages;

    currentConfig.sourceLang = renderLanguageOptions(
      sourceLangSelect,
      currentConfig.sourceLang,
      true,
      defaults.sourceLang
    );
    currentConfig.targetLang = renderLanguageOptions(
      targetLangSelect,
      currentConfig.targetLang,
      false,
      defaults.targetLang
    );
    renderButton();
    renderEngine();
  }

  function applyTheme() {
    document.body.dataset.theme = currentConfig.uiTheme === "liquid-glass" ? "liquid-glass" : "retro-paper";
  }

  function isSupportedPage(tab) {
    if (!tab || !tab.id || !tab.url) return false;
    try {
      const protocol = new URL(tab.url).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function queryActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, response => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response || null);
      });
    });
  }

  async function savePreferences(updates) {
    const previous = {};
    for (const [key, value] of Object.entries(updates)) {
      previous[key] = currentConfig[key];
      currentConfig[key] = value;
    }
    applyTheme();
    applyLanguage();
    renderMessage();

    try {
      await chrome.storage.local.set(updates);
      renderMessage();
      if (popupMessage.dataset.empty === "true") setMessage(t().saved);
    } catch (_) {
      for (const [key, value] of Object.entries(updates)) {
        if (currentConfig[key] === value) currentConfig[key] = previous[key];
      }
      applyTheme();
      applyLanguage();
      setMessage(t().saveFailed, { error: true });
      return false;
    }
    return true;
  }

  async function openSettings(event) {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch (_) {
      setMessage(t().openSettingsError, { error: true });
    } finally {
      trigger.disabled = false;
    }
  }

  async function togglePageTranslation() {
    if (state.busy || !state.pageAllowed) return;
    if (!state.isPageTranslated && !state.pageStateReadFailed && currentConfig.translateEngine === "api" && !isApiConfigured()) {
      renderMessage();
      return;
    }

    state.busy = true;
    renderButton();
    renderEngine();
    try {
      state.activeTab = await queryActiveTab();
      if (!isSupportedPage(state.activeTab)) {
        state.pageAllowed = false;
        state.pageStateReadFailed = false;
        renderButton();
        renderMessage();
        return;
      }
      const response = await sendTabMessage(state.activeTab.id, { type: "TOGGLE_PAGE_TRANSLATE" });
      if (!response || typeof response.isPageTranslated !== "boolean") {
        throw new Error("No page state response");
      }
      state.pageStateReadFailed = false;
      state.isPageTranslated = response.isPageTranslated;
      renderButton();
      renderMessage();
      window.close();
    } catch (_) {
      state.pageStateReadFailed = true;
      renderMessage();
    } finally {
      state.busy = false;
      renderButton();
      renderEngine();
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;
    let changed = false;
    for (const key of Object.keys(defaults)) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      currentConfig[key] = changes[key].newValue === undefined ? defaults[key] : changes[key].newValue;
      changed = true;
    }
    if (!changed) return;

    const normalizedEngine = normalizeEngine(currentConfig.translateEngine);
    const normalizedTheme = currentConfig.uiTheme === "liquid-glass" ? "liquid-glass" : "retro-paper";
    const normalizedLang = Object.prototype.hasOwnProperty.call(i18n, currentConfig.uiLang) ? currentConfig.uiLang : "zh-CN";
    const needsNormalize = normalizedEngine !== currentConfig.translateEngine || normalizedTheme !== currentConfig.uiTheme || normalizedLang !== currentConfig.uiLang;
    currentConfig.translateEngine = normalizedEngine;
    currentConfig.uiTheme = normalizedTheme;
    currentConfig.uiLang = normalizedLang;
    applyTheme();
    applyLanguage();
    renderMessage();
    if (needsNormalize) {
      chrome.storage.local.set({
        translateEngine: normalizedEngine,
        uiTheme: normalizedTheme,
        uiLang: normalizedLang
      });
    }
  }

  sourceLangSelect.addEventListener("change", () => {
    savePreferences({ sourceLang: sourceLangSelect.value });
  });

  targetLangSelect.addEventListener("change", () => {
    savePreferences({ targetLang: targetLangSelect.value });
  });

  swapLangBtn.addEventListener("click", () => {
    const source = sourceLangSelect.value;
    const target = targetLangSelect.value;
    const nextTarget = source === "auto" ? (target === "zh-CN" ? "en" : "zh-CN") : source;
    savePreferences({ sourceLang: target, targetLang: nextTarget });
  });

  engineSwitcher.addEventListener("click", event => {
    const button = event.target.closest("[data-engine-val]");
    if (!button || state.busy) return;
    const engine = normalizeEngine(button.dataset.engineVal);
    savePreferences({ translateEngine: engine });
  });

  togglePageBtn.addEventListener("click", togglePageTranslation);
  openSettingsBtn.addEventListener("click", openSettings);
  configureApiBtn.addEventListener("click", openSettings);
  chrome.storage.onChanged.addListener(handleStorageChange);

  async function initPopup() {
    try {
      const stored = await chrome.storage.local.get(Object.keys(defaults));
      Object.assign(currentConfig, defaults, stored);
      if (stored.apiProvider === "custom" && !String(stored.apiBaseUrl || "").trim()) {
        currentConfig.apiBaseUrl = "";
      }
      const normalizedEngine = normalizeEngine(stored.translateEngine);
      if (stored.translateEngine !== normalizedEngine) {
        currentConfig.translateEngine = normalizedEngine;
        await chrome.storage.local.set({ translateEngine: normalizedEngine });
      }
      currentConfig.uiTheme = currentConfig.uiTheme === "liquid-glass" ? "liquid-glass" : "retro-paper";
      currentConfig.uiLang = Object.prototype.hasOwnProperty.call(i18n, currentConfig.uiLang) ? currentConfig.uiLang : "zh-CN";
      currentConfig.translateEngine = normalizedEngine;

      applyTheme();
      applyLanguage();
      try {
        state.activeTab = await queryActiveTab();
        state.pageAllowed = isSupportedPage(state.activeTab);
        if (state.pageAllowed) {
          try {
            const response = await sendTabMessage(state.activeTab.id, { type: "GET_PAGE_STATE" });
            if (!response || typeof response.isPageTranslated !== "boolean") {
              throw new Error("No page state response");
            }
            state.isPageTranslated = response.isPageTranslated;
          } catch (_) {
            state.pageStateReadFailed = true;
          }
        }
      } catch (_) {
        state.pageAllowed = false;
      }
      renderButton();
      renderEngine();
      renderMessage();
    } catch (_) {
      setMessage(t().saveFailed, { error: true });
    } finally {
      document.body.dataset.ready = "true";
    }
  }

  initPopup();
})();
