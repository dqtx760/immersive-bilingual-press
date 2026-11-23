(() => {
  const { providers, i18n, defaults, normalizeEngine } = window.PressUI;
  const API_KEYS = ["apiProvider", "apiBaseUrl", "apiKey", "apiModel"];
  const API_PROVIDER_DEFAULTS = {
    apiProvider: defaults.apiProvider,
    apiBaseUrl: defaults.apiBaseUrl,
    apiKey: defaults.apiKey,
    apiModel: defaults.apiModel
  };
  const PANEL_IDS = ["panel-translate", "panel-appearance", "panel-controls", "panel-guide"];
  const settingsContent = document.querySelector(".settings-content");
  const SOURCE_LANGUAGES = Object.keys(i18n["zh-CN"].langNames);
  const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter(code => code !== "auto");

  let currentConfig = { ...defaults };
  let apiDraft = { ...API_PROVIDER_DEFAULTS };
  let apiDraftDirty = false;
  let apiDraftRevision = 0;
  let apiStatus = "loaded";
  let apiStatusModel = "";
  let footerStatus = "";
  let preferenceSaveRevision = 0;
  let apiKeyVisible = false;
  let initialized = false;
  const pendingExternalChanges = {};

  const sourceLangSelect = document.getElementById("source-lang-select");
  const targetLangSelect = document.getElementById("target-lang-select");
  const uiLangSelect = document.getElementById("ui-lang-select");
  const apiProviderSelect = document.getElementById("api-provider-select");
  const apiKeyInput = document.getElementById("api-key-input");
  const apiModelInput = document.getElementById("api-model-input");
  const apiBaseUrlInput = document.getElementById("api-base-url-input");
  const apiModelSuggestions = document.getElementById("api-model-suggestions");
  const apiHint = document.getElementById("api-hint");
  const footerStatusEl = document.getElementById("settings-footer-save-status");

  function t() {
    return i18n[currentConfig.uiLang] || i18n["zh-CN"];
  }

  function setStatus(element, text, isError = false) {
    element.textContent = text || "";
    element.classList.toggle("error", Boolean(isError));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderFooterStatus() {
    const dict = t();
    const text = footerStatus === "saving"
      ? dict.saving
      : footerStatus === "saved"
        ? dict.saved
        : footerStatus === "failed"
          ? dict.saveFailed
          : "";
    setStatus(footerStatusEl, text, footerStatus === "failed");
  }

  function renderApiStatus() {
    const dict = t();
    if (apiStatus === "saving") {
      setStatus(apiHint, dict.saving);
    } else if (apiStatus === "failed") {
      setStatus(apiHint, dict.saveFailed, true);
    } else if (apiStatus === "model-required") {
      setStatus(apiHint, dict.apiModelRequiredErr, true);
    } else if (apiStatus === "key-required") {
      setStatus(apiHint, dict.apiKeyRequiredErr, true);
    } else if (apiStatus === "base-url-required") {
      setStatus(apiHint, dict.apiBaseUrlRequiredErr || "请填写接口地址", true);
    } else if (apiStatus === "saved" || (apiStatus === "loaded" && apiStatusModel)) {
      apiHint.innerHTML = dict.apiHintSaved(escapeHtml(apiStatusModel));
      apiHint.classList.remove("error");
    } else {
      setStatus(apiHint, dict.apiHintDefault);
    }
  }

  function populateLanguageSelect(select, codes, selectedCode) {
    const names = t().langNames;
    select.replaceChildren();
    for (const code of codes) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = names[code] || code;
      select.appendChild(option);
    }
    select.value = selectedCode;
    if (!select.value && codes.length) select.value = codes[0];
  }

  function populateApiProviders(selectedProvider) {
    apiProviderSelect.replaceChildren();
    if (selectedProvider && !providers[selectedProvider]) {
      const option = document.createElement("option");
      option.value = selectedProvider;
      option.textContent = selectedProvider;
      apiProviderSelect.appendChild(option);
    }
    for (const [id, provider] of Object.entries(providers)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = provider.label;
      apiProviderSelect.appendChild(option);
    }
    apiProviderSelect.value = selectedProvider || defaults.apiProvider;
  }

  function updateApiModelSuggestions() {
    apiModelSuggestions.replaceChildren();
    const provider = providers[apiProviderSelect.value];
    for (const model of provider && Array.isArray(provider.models) ? provider.models : []) {
      const option = document.createElement("option");
      option.value = model;
      apiModelSuggestions.appendChild(option);
    }
  }

  function applyApiConfig(config) {
    apiDraft = {
      apiProvider: config.apiProvider || defaults.apiProvider,
      apiBaseUrl: config.apiBaseUrl ?? defaults.apiBaseUrl,
      apiKey: config.apiKey || "",
      apiModel: config.apiModel || defaults.apiModel
    };
    apiDraftDirty = false;
    populateApiProviders(apiDraft.apiProvider);
    apiKeyInput.value = apiDraft.apiKey;
    apiModelInput.value = apiDraft.apiModel;
    apiBaseUrlInput.value = apiDraft.apiBaseUrl;
    updateApiModelSuggestions();
    apiStatus = apiDraft.apiKey && apiDraft.apiModel ? "loaded" : "help";
    apiStatusModel = apiDraft.apiKey && apiDraft.apiModel ? apiDraft.apiModel : "";
    renderApiStatus();
  }

  function updateApiDraftFromInputs() {
    apiDraft.apiProvider = apiProviderSelect.value;
    apiDraft.apiKey = apiKeyInput.value;
    apiDraft.apiModel = apiModelInput.value;
    apiDraft.apiBaseUrl = apiBaseUrlInput.value;
    apiDraftDirty = true;
    apiDraftRevision += 1;
    apiStatus = "help";
    renderApiStatus();
  }

  function updateApiKeyToggle() {
    const dict = t();
    const key = apiKeyVisible ? "hideApiKey" : "showApiKey";
    const fallback = apiKeyVisible ? "Hide API key" : "Show API key";
    const label = dict[key] || fallback;
    document.getElementById("toggle-api-key-label").textContent = label;
    const toggleButton = document.getElementById("toggle-api-key-btn");
    toggleButton.setAttribute("aria-label", label);
    toggleButton.setAttribute("aria-pressed", String(apiKeyVisible));
  }

  function applyUiLanguage() {
    const lang = Object.hasOwn(i18n, currentConfig.uiLang) ? currentConfig.uiLang : "zh-CN";
    currentConfig.uiLang = lang;
    uiLangSelect.value = lang;
    document.documentElement.lang = lang;
    const dict = t();

    for (const element of document.querySelectorAll("[data-i18n]")) {
      const key = element.dataset.i18n;
      if (dict[key] !== undefined && typeof dict[key] !== "function") {
        element.textContent = dict[key];
      }
    }
    for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
      const key = element.dataset.i18nAriaLabel;
      if (dict[key]) element.setAttribute("aria-label", dict[key]);
    }
    document.getElementById("guide-list-content").innerHTML = dict.guideListHtml;
    document.getElementById("brand-mark").textContent = dict.logoBadge;
    document.getElementById("brand-title").textContent = dict.appTitle;
    document.querySelector(".settings-brand").setAttribute("aria-label", `${dict.appTitle} · ${dict.settingsTitle}`);
    document.title = `${dict.settingsTitle} · ${dict.appTitle}`;

    populateLanguageSelect(sourceLangSelect, SOURCE_LANGUAGES, currentConfig.sourceLang || defaults.sourceLang);
    populateLanguageSelect(targetLangSelect, TARGET_LANGUAGES, currentConfig.targetLang || defaults.targetLang);
    document.getElementById("swap-lang-btn").setAttribute("aria-label", dict.swapLanguages);
    document.getElementById("swap-lang-btn").title = dict.swapLanguages;
    document.getElementById("display-mode-hint").textContent = currentConfig.displayMode === "bilingual"
      ? dict.bilingualHint
      : dict.translationOnlyHint;
    document.getElementById("ui-lang-label").textContent = dict.labelUiLang;
    document.getElementById("sw-selection-label").textContent = dict.swTitleSelection;
    document.getElementById("sw-alt-hover-label").textContent = dict.swTitleAltHover;
    document.getElementById("sw-floating-ball-label").textContent = dict.swTitleBall;
    apiKeyInput.placeholder = dict.apiKeyPlaceholder;
    apiModelInput.placeholder = dict.apiModelPlaceholder;
    apiBaseUrlInput.placeholder = providers[apiProviderSelect.value]?.baseUrl || "https://api.example.com/v1";
    document.querySelector(".author-qr").alt = dict.authorRowWechat;

    updateApiKeyToggle();
    applyEngineUi();
    applyDisplayModeUi();
    applyThemeUi();
    renderApiStatus();
    renderFooterStatus();
  }

  function applyEngineUi() {
    const engine = normalizeEngine(currentConfig.translateEngine);
    currentConfig.translateEngine = engine;
    for (const button of document.querySelectorAll("#engine-switcher [data-engine-val]")) {
      const selected = button.dataset.engineVal === engine;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    document.getElementById("google-panel").hidden = engine !== "google";
    document.getElementById("api-panel").hidden = engine !== "api";
  }

  function applyDisplayModeUi() {
    const mode = currentConfig.displayMode === "bilingual" ? "bilingual" : "translation-only";
    currentConfig.displayMode = mode;
    for (const button of document.querySelectorAll("#display-mode-switcher [data-display-val]")) {
      const selected = button.dataset.displayVal === mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    document.getElementById("display-mode-hint").textContent = mode === "bilingual"
      ? t().bilingualHint
      : t().translationOnlyHint;
  }

  function applyThemeUi() {
    const theme = currentConfig.uiTheme === "liquid-glass" ? "liquid-glass" : "retro-paper";
    currentConfig.uiTheme = theme;
    document.body.dataset.theme = theme;
    for (const button of document.querySelectorAll("#theme-switcher [data-theme-val]")) {
      const selected = button.dataset.themeVal === theme;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function applyPreferences() {
    populateLanguageSelect(sourceLangSelect, SOURCE_LANGUAGES, currentConfig.sourceLang || defaults.sourceLang);
    populateLanguageSelect(targetLangSelect, TARGET_LANGUAGES, currentConfig.targetLang || defaults.targetLang);
    uiLangSelect.value = currentConfig.uiLang;
    document.getElementById("sw-selection").checked = currentConfig.enableSelection !== false;
    document.getElementById("sw-alt-hover").checked = currentConfig.enableAltHover !== false;
    document.getElementById("sw-floating-ball").checked = currentConfig.enableFloatingBall !== false;
    applyEngineUi();
    applyDisplayModeUi();
    applyThemeUi();
    applyUiLanguage();
  }

  function showPanel(panelId) {
    const activePanel = PANEL_IDS.includes(panelId) ? panelId : PANEL_IDS[0];
    if (settingsContent) settingsContent.scrollTop = 0;
    for (const id of PANEL_IDS) {
      document.getElementById(id).hidden = id !== activePanel;
    }
    for (const link of document.querySelectorAll("[data-target-panel]")) {
      if (link.dataset.targetPanel === activePanel) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  }

  function showCurrentHashPanel() {
    showPanel(location.hash.slice(1));
  }

  function navigateToPanel(panelId) {
    const activePanel = PANEL_IDS.includes(panelId) ? panelId : PANEL_IDS[0];
    const nextHash = `#${activePanel}`;
    if (location.hash !== nextHash) history.pushState(null, "", nextHash);
    showPanel(activePanel);
  }

  function setFooterStatus(status) {
    footerStatus = status;
    renderFooterStatus();
  }

  async function savePreferences(updates) {
    const revision = ++preferenceSaveRevision;
    setFooterStatus("saving");
    try {
      await chrome.storage.local.set(updates);
      if (revision === preferenceSaveRevision) setFooterStatus("saved");
    } catch (_) {
      if (revision === preferenceSaveRevision) setFooterStatus("failed");
    }
  }

  async function saveApiConfig(event) {
    event.preventDefault();
    const apiKey = (apiDraft.apiKey || "").trim();
    const apiModel = (apiDraft.apiModel || "").trim();
    const provider = apiDraft.apiProvider;
    const baseUrl = (apiDraft.apiBaseUrl || "").trim().replace(/\/+$/, "");
    if (!apiModel) {
      apiStatus = "model-required";
      renderApiStatus();
      setFooterStatus("failed");
      return;
    }
    if (!apiKey) {
      apiStatus = "key-required";
      renderApiStatus();
      setFooterStatus("failed");
      return;
    }

    const effectiveBaseUrl = baseUrl || providers[provider]?.baseUrl || "";
    if (!effectiveBaseUrl) {
      apiStatus = "base-url-required";
      renderApiStatus();
      setFooterStatus("failed");
      apiBaseUrlInput.focus();
      return;
    }

    const snapshot = {
      apiProvider: provider,
      apiKey,
      apiModel,
      apiBaseUrl: effectiveBaseUrl
    };
    const revision = apiDraftRevision;
    apiStatus = "saving";
    renderApiStatus();
    setFooterStatus("saving");
    const saveButton = document.getElementById("save-api-btn");
    saveButton.disabled = true;
    try {
      await chrome.storage.local.set(snapshot);
      Object.assign(currentConfig, snapshot);
      if (revision === apiDraftRevision) {
        apiDraft = { ...snapshot };
        apiBaseUrlInput.value = snapshot.apiBaseUrl;
        apiDraftDirty = false;
      }
      apiStatus = revision === apiDraftRevision ? "saved" : "help";
      apiStatusModel = snapshot.apiModel;
      renderApiStatus();
      setFooterStatus("saved");
    } catch (_) {
      apiDraftDirty = true;
      apiStatus = "failed";
      renderApiStatus();
      setFooterStatus("failed");
    } finally {
      saveButton.disabled = false;
    }
  }

  async function refreshPageShortcut() {
    const shortcutElement = document.getElementById("page-shortcut");
    const unassigned = t().unassignedShortcut;
    if (!chrome.commands || typeof chrome.commands.getAll !== "function") {
      shortcutElement.textContent = unassigned;
      return;
    }
    try {
      const commands = await new Promise((resolve, reject) => {
        chrome.commands.getAll(result => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result || []);
        });
      });
      const command = commands.find(item => item.name === "toggle-page-translate");
      shortcutElement.textContent = command && command.shortcut ? command.shortcut : unassigned;
    } catch (_) {
      shortcutElement.textContent = unassigned;
    }
  }

  async function syncApiConfigFromStorage() {
    if (apiDraftDirty) return;
    try {
      const stored = await chrome.storage.local.get(API_KEYS);
      if (apiDraftDirty) return;
      for (const key of API_KEYS) {
        currentConfig[key] = stored[key] === undefined ? API_PROVIDER_DEFAULTS[key] : stored[key];
      }
      if (stored.apiProvider === "custom" && !stored.apiBaseUrl) {
        currentConfig.apiBaseUrl = "";
      }
      applyApiConfig(currentConfig);
    } catch (_) {
      setStatus(apiHint, t().saveFailed, true);
    }
  }

  function handleStorageChanges(changes, areaName) {
    if (areaName !== "local") return;
    let preferencesChanged = false;
    let apiChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!Object.hasOwn(defaults, key)) continue;
      const value = change.newValue === undefined ? defaults[key] : change.newValue;
      if (API_KEYS.includes(key)) {
        currentConfig[key] = value;
        apiChanged = true;
      } else {
        currentConfig[key] = value;
        preferencesChanged = true;
      }
      if (!initialized) pendingExternalChanges[key] = value;
    }
    if (!initialized) return;

    if (preferencesChanged) {
      if (currentConfig.translateEngine !== normalizeEngine(currentConfig.translateEngine)) {
        currentConfig.translateEngine = normalizeEngine(currentConfig.translateEngine);
        chrome.storage.local.set({ translateEngine: currentConfig.translateEngine }).catch(() => setFooterStatus("failed"));
      }
      applyPreferences();
    }
    if (apiChanged && !apiDraftDirty) syncApiConfigFromStorage();
  }

  function bindEvents() {
    document.getElementById("settings-nav").addEventListener("click", event => {
      const link = event.target.closest("[data-target-panel]");
      if (!link) return;
      event.preventDefault();
      navigateToPanel(link.dataset.targetPanel);
    });
    document.querySelector(".settings-brand").addEventListener("click", event => {
      event.preventDefault();
      navigateToPanel(PANEL_IDS[0]);
    });
    window.addEventListener("hashchange", showCurrentHashPanel);
    window.addEventListener("popstate", showCurrentHashPanel);

    sourceLangSelect.addEventListener("change", () => {
      currentConfig.sourceLang = sourceLangSelect.value;
      savePreferences({ sourceLang: currentConfig.sourceLang });
    });
    targetLangSelect.addEventListener("change", () => {
      currentConfig.targetLang = targetLangSelect.value;
      savePreferences({ targetLang: currentConfig.targetLang });
    });
    document.getElementById("swap-lang-btn").addEventListener("click", () => {
      const source = sourceLangSelect.value;
      const target = targetLangSelect.value;
      const nextSource = target;
      const nextTarget = source === "auto" ? (target === "zh-CN" ? "en" : "zh-CN") : source;
      currentConfig.sourceLang = nextSource;
      currentConfig.targetLang = nextTarget;
      sourceLangSelect.value = nextSource;
      targetLangSelect.value = nextTarget;
      savePreferences({ sourceLang: nextSource, targetLang: nextTarget });
    });

    document.getElementById("engine-switcher").addEventListener("click", event => {
      const button = event.target.closest("[data-engine-val]");
      if (!button) return;
      const engine = normalizeEngine(button.dataset.engineVal);
      currentConfig.translateEngine = engine;
      applyEngineUi();
      savePreferences({ translateEngine: engine });
    });
    document.getElementById("display-mode-switcher").addEventListener("click", event => {
      const button = event.target.closest("[data-display-val]");
      if (!button) return;
      const mode = button.dataset.displayVal === "bilingual" ? "bilingual" : "translation-only";
      currentConfig.displayMode = mode;
      applyDisplayModeUi();
      savePreferences({ displayMode: mode });
    });

    document.getElementById("theme-switcher").addEventListener("click", event => {
      const button = event.target.closest("[data-theme-val]");
      if (!button) return;
      currentConfig.uiTheme = button.dataset.themeVal === "liquid-glass" ? "liquid-glass" : "retro-paper";
      applyThemeUi();
      savePreferences({ uiTheme: currentConfig.uiTheme });
    });
    uiLangSelect.addEventListener("change", () => {
      currentConfig.uiLang = uiLangSelect.value;
      applyUiLanguage();
      savePreferences({ uiLang: currentConfig.uiLang });
    });

    document.getElementById("sw-selection").addEventListener("change", event => {
      currentConfig.enableSelection = event.target.checked;
      savePreferences({ enableSelection: event.target.checked });
    });
    document.getElementById("sw-alt-hover").addEventListener("change", event => {
      currentConfig.enableAltHover = event.target.checked;
      savePreferences({ enableAltHover: event.target.checked });
    });
    document.getElementById("sw-floating-ball").addEventListener("change", event => {
      currentConfig.enableFloatingBall = event.target.checked;
      savePreferences({ enableFloatingBall: event.target.checked });
    });

    apiProviderSelect.addEventListener("change", () => {
      const provider = apiProviderSelect.value;
      const preset = providers[provider];
      apiDraft.apiProvider = provider;
      if (preset) {
        apiDraft.apiBaseUrl = preset.baseUrl || "";
        apiBaseUrlInput.value = apiDraft.apiBaseUrl;
        if (preset.models && preset.models.length) {
          apiDraft.apiModel = preset.models[0];
          apiModelInput.value = apiDraft.apiModel;
        }
      }
      apiDraftDirty = true;
      apiDraftRevision += 1;
      updateApiModelSuggestions();
      apiStatus = "help";
      renderApiStatus();
    });
    for (const input of [apiKeyInput, apiModelInput, apiBaseUrlInput]) {
      input.addEventListener("input", updateApiDraftFromInputs);
    }
    document.getElementById("toggle-api-key-btn").addEventListener("click", () => {
      apiKeyVisible = !apiKeyVisible;
      apiKeyInput.type = apiKeyVisible ? "text" : "password";
      updateApiKeyToggle();
      apiKeyInput.focus();
    });
    document.getElementById("api-config-form").addEventListener("submit", saveApiConfig);

    document.getElementById("manage-shortcuts-btn").addEventListener("click", async () => {
      const url = /Edg\//.test(navigator.userAgent)
        ? "edge://extensions/shortcuts"
        : "chrome://extensions/shortcuts";
      try {
        await chrome.tabs.create({ url });
      } catch (_) {
        setFooterStatus("failed");
      }
    });
    window.addEventListener("focus", refreshPageShortcut);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshPageShortcut();
    });

  }

  async function initialize() {
    try {
      const stored = await chrome.storage.local.get(Object.keys(defaults));
      Object.assign(currentConfig, stored, pendingExternalChanges);
      if (stored.apiProvider === "custom" && !stored.apiBaseUrl && pendingExternalChanges.apiBaseUrl === undefined) {
        currentConfig.apiBaseUrl = "";
      }
      currentConfig.translateEngine = normalizeEngine(currentConfig.translateEngine);
      currentConfig.displayMode = currentConfig.displayMode === "bilingual" ? "bilingual" : "translation-only";
      currentConfig.uiTheme = currentConfig.uiTheme === "liquid-glass" ? "liquid-glass" : "retro-paper";
      currentConfig.uiLang = Object.hasOwn(i18n, currentConfig.uiLang) ? currentConfig.uiLang : "zh-CN";
      if (stored.translateEngine !== currentConfig.translateEngine) {
        await chrome.storage.local.set({ translateEngine: currentConfig.translateEngine });
      }
      if (stored.displayMode !== currentConfig.displayMode) {
        await chrome.storage.local.set({ displayMode: currentConfig.displayMode });
      }
    } catch (_) {
      setFooterStatus("failed");
    }

    applyPreferences();
    applyApiConfig(currentConfig);
    bindEvents();
    showCurrentHashPanel();
    initialized = true;
    document.body.dataset.ready = "true";
    await refreshPageShortcut();
  }

  chrome.storage.onChanged.addListener(handleStorageChanges);
  initialize();
})();
