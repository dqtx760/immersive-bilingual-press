const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" }); });
after(async () => { await browser?.close(); });

async function createUI(t, config = {}, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(options.edge ? { userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0" } : {}) });
  const state = { stored: { ...config }, writes: [], errors: [], failWrites: false };
  await context.exposeBinding("readPrefs", (_, keys) => Object.fromEntries(keys.filter(key => key in state.stored).map(key => [key, state.stored[key]])));
  await context.exposeBinding("writePrefs", async (_, updates) => {
    if (state.failWrites) throw new Error("test storage unavailable");
    const changes = Object.fromEntries(Object.entries(updates).filter(([key, value]) => state.stored[key] !== value).map(([key, newValue]) => [key, { oldValue: state.stored[key], newValue }]));
    Object.assign(state.stored, updates);
    state.writes.push(updates);
    await Promise.allSettled(context.pages().map(page => page.evaluate(changes => window.extensionMock?.emit(changes), changes)));
  });
  await context.addInitScript(options => {
    const changed = [];
    window.extensionMock = {
      messages: [], optionsOpened: 0, createdTabs: [], closed: 0,
      isTranslated: Boolean(options.isTranslated), pageUnavailable: false, optionsUnavailable: false,
      shortcut: "Ctrl+Shift+Y", emit: changes => changed.forEach(fn => fn(changes, "local"))
    };
    const mock = window.extensionMock;
    window.close = () => { mock.closed++; };
    window.chrome = {
      storage: { local: {
        get: async (keys, callback) => { const value = await window.readPrefs(keys); callback?.(value); return value; },
        set: async updates => { await window.writePrefs(updates); }
      }, onChanged: { addListener: fn => changed.push(fn) } },
      runtime: { lastError: null,
        getManifest: () => ({ version: "2.1.0" }), getURL: name => new URL(name, location.href).href,
        openOptionsPage: async () => { if (mock.optionsUnavailable) throw new Error("test options unavailable"); mock.optionsOpened++; }
      },
      commands: { getAll: async callback => { const commands = [{ name: "toggle-page-translate", shortcut: mock.shortcut }]; callback?.(commands); return commands; } },
      tabs: {
        query: async (_, callback) => { const tabs = [{ id: 1, url: "https://example.test/" }]; callback?.(tabs); return tabs; },
        create: async info => { mock.createdTabs.push(info); return { id: 2 }; },
        sendMessage: async (_, message, callback) => {
          mock.messages.push(message);
          if (mock.pageUnavailable) {
            if (callback) { chrome.runtime.lastError = { message: "test page unavailable" }; callback(); chrome.runtime.lastError = null; return; }
            throw new Error("test page unavailable");
          }
          if (message.type === "TOGGLE_PAGE_TRANSLATE") mock.isTranslated = !mock.isTranslated;
          const result = { isPageTranslated: mock.isTranslated };
          callback?.(result);
          return result;
        }
      }
    };
  }, options);
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, []); });
  return {
    state,
    open: async (filename, width = 1440, height = 1000) => {
      const page = await context.newPage();
      page.on("pageerror", error => state.errors.push(error.message));
      await page.setViewportSize({ width, height });
      await page.goto(pathToFileURL(path.join(root, filename)).href);
      await page.waitForFunction(() => document.body.dataset.ready === "true");
      return page;
    }
  };
}

async function navigate(page, section) {
  await page.locator('[data-target-panel="panel-' + section + '"]').click();
}

async function screenshot(page, name, selector) {
  if (!process.env.LAYOUT_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.LAYOUT_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  const options = { path: path.join(process.env.LAYOUT_SCREENSHOT_DIR, name + ".png"), animations: "disabled" };
  if (selector) await page.locator(selector).screenshot(options);
  else await page.screenshot({ ...options, fullPage: true });
}

test("精简弹窗只保留语种、双引擎、翻译与设置入口", async t => {
  const ui = await createUI(t, { sourceLang: "zh-CN", targetLang: "en" });
  const page = await ui.open("popup.html", 352, 600);
  assert.deepEqual(await page.locator("#engine-switcher [data-engine-val]").evaluateAll(nodes => nodes.map(node => node.dataset.engineVal).sort()), ["api", "google"]);
  assert.equal(await page.locator("#source-lang-select").inputValue(), "zh-CN");
  assert.equal(await page.locator("#target-lang-select").inputValue(), "en");
  assert.equal(await page.locator(".nav-icon-card, #api-key-input, #display-mode-switcher, #sw-selection").count(), 0);
  assert.equal(await page.locator("#toggle-page-btn").isVisible(), true);
  assert.equal(await page.locator("#btn-engine-google").innerText(), "Google翻译");
  assert.equal(await page.locator("#toggle-btn-text").innerText(), "翻译");
  assert.equal(await page.locator("#toggle-page-btn [aria-hidden='true'] svg").count(), 1);
  assert.match(await page.locator("#open-settings-btn").innerText(), /打开设置页/);
  const bounds = await page.locator("body").boundingBox();
  assert.ok(bounds.width <= 352 && bounds.height <= 440, "弹窗进一步收窄且保持精简");
  await screenshot(page, "popup", "body");
});

test("弹窗设置即时保存，语种可换向，已保存API配置不丢失", async t => {
  const ui = await createUI(t, { translateEngine: "ollama", apiKey: "test-key", apiModel: "saved-model" });
  const page = await ui.open("popup.html", 352, 600);
  assert.equal(ui.state.stored.translateEngine, "google");
  await page.locator("#btn-engine-api").click();
  await page.locator("#source-lang-select").selectOption("ja");
  await page.locator("#target-lang-select").selectOption("en");
  await page.locator("#swap-lang-btn").click();
  await page.waitForFunction(() => document.querySelector("#target-lang-select").value === "ja");
  assert.equal(ui.state.stored.translateEngine, "api");
  assert.equal(ui.state.stored.sourceLang, "en");
  assert.equal(ui.state.stored.targetLang, "ja");
  assert.equal(ui.state.stored.apiKey, "test-key");
  assert.equal(ui.state.stored.apiModel, "saved-model");
});

test("设置入口可打开，失败时显示可重试的错误", async t => {
  const ui = await createUI(t);
  const page = await ui.open("popup.html", 352, 600);
  await page.evaluate(() => { window.extensionMock.optionsUnavailable = true; });
  await page.locator("#open-settings-btn").click();
  await page.waitForFunction(() => document.querySelector("#popup-message").textContent.length > 0);
  assert.equal(await page.evaluate(() => window.extensionMock.closed), 0);
  await page.evaluate(() => { window.extensionMock.optionsUnavailable = false; });
  await page.locator("#open-settings-btn").click();
  assert.equal(await page.evaluate(() => window.extensionMock.optionsOpened), 1);
});

test("翻译按钮处理普通页面、不可用页面与未配置API的还原", async t => {
  const ui = await createUI(t);
  const page = await ui.open("popup.html", 352, 600);
  await page.evaluate(() => { window.extensionMock.pageUnavailable = true; });
  await page.locator("#toggle-page-btn").click();
  await page.waitForFunction(() => document.querySelector("#popup-message").textContent.length > 0);
  await page.evaluate(() => { window.extensionMock.pageUnavailable = false; });
  await page.locator("#toggle-page-btn").click();
  assert.equal(await page.evaluate(() => window.extensionMock.isTranslated), true);
  const translated = await createUI(t, { translateEngine: "api", apiKey: "" }, { isTranslated: true });
  const restore = await translated.open("popup.html", 352, 600);
  assert.equal(await restore.locator("#toggle-btn-text").innerText(), "还原");
  await restore.locator("#toggle-page-btn").click();
  assert.equal(await restore.evaluate(() => window.extensionMock.isTranslated), false);
});

test("设置页默认优先仅显示译文，保留语种及两引擎", async t => {
  const ui = await createUI(t, { sourceLang: "zh-CN", targetLang: "en", translateEngine: "unknown" });
  const page = await ui.open("settings.html");
  assert.deepEqual(await page.locator("#display-mode-switcher [data-display-val]").evaluateAll(nodes => nodes.map(node => node.dataset.displayVal)), ["translation-only", "bilingual"]);
  assert.equal(await page.locator('[data-display-val="translation-only"]').evaluate(el => el.classList.contains("active")), true);
  assert.equal(await page.locator("#source-lang-select").inputValue(), "zh-CN");
  assert.equal(await page.locator("#target-lang-select").inputValue(), "en");
  assert.equal(ui.state.stored.translateEngine, "google");
  await screenshot(page, "settings-translation");
});

test("API表单在大页面保存，支持隐藏密钥且保留自定义模型地址", async t => {
  const ui = await createUI(t, { translateEngine: "api", apiKey: "test-key", apiModel: "saved-model", apiBaseUrl: "https://example.test/v1" });
  const page = await ui.open("settings.html");
  assert.equal(await page.locator("#api-key-input").inputValue(), "test-key");
  assert.equal(await page.locator("#api-key-input").getAttribute("type"), "password");
  await page.locator("#toggle-api-key-btn").click();
  assert.equal(await page.locator("#api-key-input").getAttribute("type"), "text");
  await page.locator("#api-model-input").fill("new-model");
  await page.locator("#save-api-btn").click();
  await page.waitForFunction(() => document.querySelector("#api-hint").textContent.includes("new-model"));
  assert.equal(ui.state.stored.apiModel, "new-model");
  assert.equal(ui.state.stored.apiKey, "test-key");
  assert.equal(ui.state.stored.apiBaseUrl, "https://example.test/v1");
  await page.locator("#toggle-api-key-btn").click();
  await screenshot(page, "settings-api");
});

test("弹窗与设置页双向同步，不覆盖未保存的API草稿", async t => {
  const ui = await createUI(t, { translateEngine: "api", apiKey: "test-key", apiModel: "saved-model" });
  const settings = await ui.open("settings.html");
  const popup = await ui.open("popup.html", 352, 600);
  await settings.locator("#api-model-input").fill("draft-model");
  await popup.locator("#btn-engine-google").click();
  await settings.waitForFunction(() => document.querySelector("#btn-engine-google").classList.contains("active"));
  assert.equal(await settings.locator("#api-model-input").inputValue(), "draft-model");
  await settings.locator("#target-lang-select").selectOption("ja");
  await popup.waitForFunction(() => document.querySelector("#target-lang-select").value === "ja");
  assert.equal(ui.state.stored.targetLang, "ja");
});

test("交互设置保存，实际快捷键可从浏览器管理", async t => {
  for (const edge of [false, true]) {
    const ui = await createUI(t, {}, { edge });
    const page = await ui.open("settings.html");
    await navigate(page, "controls");
    assert.match(await page.locator("#page-shortcut").innerText(), /Ctrl\+Shift\+Y/);
    if (!edge) await screenshot(page, "settings-shortcuts");
    await page.locator("#sw-alt-hover").uncheck();
    await page.waitForFunction(() => !document.querySelector("#sw-alt-hover").checked);
    assert.equal(ui.state.stored.enableAltHover, false);
    await page.locator("#manage-shortcuts-btn").click();
    assert.equal(await page.evaluate(() => window.extensionMock.createdTabs[0].url), edge ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts");
    await page.evaluate(() => { window.extensionMock.shortcut = ""; window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => document.querySelector("#page-shortcut").textContent.includes("未设置"));
  }
});

test("设置页保留个人资料、七个指定链接和左对齐的完整公众号图片", async t => {
  const ui = await createUI(t);
  const page = await ui.open("settings.html");
  await navigate(page, "guide");
  assert.match(await page.locator("#author-heading").innerText(), /大强同学.*AI工具与自动化/);
  assert.equal(await page.locator("#settings-eyebrow, #settings-description").count(), 0, "设置区不重复品牌和副说明");
  assert.equal(await page.locator("#settings-title").innerText(), "设置");
  assert.equal(await page.locator("#panel-title-guide").innerText(), "插件说明");
  assert.equal(await page.locator("#guide-section-title").innerText(), "核心功能使用说明");
  assert.equal(await page.locator("#guide-list-content li").count(), 5);
  assert.equal(await page.locator("#guide-list-content li").evaluateAll(items => items.every(item => item.getBoundingClientRect().height <= parseFloat(getComputedStyle(item).lineHeight) + 1)), true, "桌面每项功能说明保持一行");
  assert.deepEqual(await page.locator("#panel-guide .social-link").evaluateAll(nodes => nodes.map(node => node.href)), ["https://www.dqtx.cc/", "https://os.dqtx.cc/", "https://blog.dqtx.cc/", "https://space.bilibili.com/491358682/upload/video", "https://www.youtube.com/@dqtx760/videos", "https://web.okjike.com/u/24236868-c3e9-49ef-ab93-93a60e1a25db", "https://blog.csdn.net/2402_82616859?type=blog"]);
  assert.deepEqual(await page.locator(".author-link-row").nth(1).locator("a").allTextContents(), ["B 站 ↗", "YouTube ↗", "即刻 ↗", "CSDN ↗"]);
  await page.waitForFunction(() => { const img = document.querySelector("#panel-guide img"); return img.complete && img.naturalWidth > 0; });
  assert.equal(await page.locator("#panel-guide img").evaluate(img => Math.abs(img.width / img.height - img.naturalWidth / img.naturalHeight) < 0.02), true);
  assert.equal(await page.locator("#panel-guide img").evaluate(img => Math.abs(img.getBoundingClientRect().left - img.parentElement.getBoundingClientRect().left) < 1), true);
  await page.locator("#panel-guide img").scrollIntoViewIfNeeded();
  await screenshot(page, "settings-about");
});

test("四个设置分类切换保持外框和导航固定，长内容可达", async t => {
  const ui = await createUI(t, { translateEngine: "api" });
  const page = await ui.open("settings.html");
  const measure = () => page.evaluate(() => ({
    rects: [".settings-main", ".settings-sidebar", ".settings-header", "#settings-nav"].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth
  }));
  for (const [width, height] of [[1440, 900], [1440, 720], [900, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await navigate(page, "translate");
    const expected = await measure();
    for (const panel of ["guide", "appearance", "controls", "translate"]) {
      await navigate(page, panel);
      const actual = await measure();
      for (let i = 0; i < expected.rects.length; i++) {
        for (const key of ["x", "y", "width", "height"]) {
          assert.ok(Math.abs(actual.rects[i][key] - expected.rects[i][key]) < 1, `${width}px ${panel} 分区改变外框 ${i} ${key}`);
        }
      }
      assert.equal(actual.scrollY, 0, "分类导航不得滚动整个页面");
      assert.ok(actual.documentHeight <= height && actual.documentWidth <= width, "外层不得出现滚动或溢出");
    }
    await page.locator("#save-api-btn").scrollIntoViewIfNeeded();
    const savedView = await measure();
    assert.deepEqual(savedView.rects, expected.rects, "滚动API表单时框架不移动");
    await navigate(page, "guide");
    await page.locator("#panel-guide img").scrollIntoViewIfNeeded();
    const posterView = await measure();
    assert.deepEqual(posterView.rects, expected.rects, "滚动说明时框架不移动");
    assert.equal(posterView.scrollY, 0);
  }
});

test("设置分类保留刷新和前进后退导航，切换后内容从顶部显示", async t => {
  const ui = await createUI(t);
  const page = await ui.open("settings.html");
  await page.goto(page.url() + "#panel-guide");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  assert.equal(await page.locator("#panel-guide").isVisible(), true);
  await page.locator("#panel-guide img").scrollIntoViewIfNeeded();
  await navigate(page, "controls");
  await page.waitForFunction(() => location.hash === "#panel-controls");
  assert.equal(await page.locator(".settings-content").evaluate(el => el.scrollTop), 0);
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector("#panel-guide").hidden);
  await page.goForward();
  await page.waitForFunction(() => !document.querySelector("#panel-controls").hidden);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  assert.equal(await page.locator("#panel-controls").isVisible(), true);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("设置页适配手机、平板和桌面，四语言及两主题没有脚本错误", async t => {
  for (const [uiLang, uiTheme] of [["zh-CN", "retro-paper"], ["zh-TW", "liquid-glass"], ["en", "retro-paper"], ["ja", "liquid-glass"]]) {
    const ui = await createUI(t, { uiLang, uiTheme });
    const page = await ui.open("settings.html");
    for (const width of [390, 900, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      if (uiLang === "zh-CN" && width === 390) await screenshot(page, "settings-mobile");
      for (const panel of ["guide", "appearance", "controls", "translate"]) {
        await navigate(page, panel);
        assert.equal(await page.locator(".settings-content").evaluate(el => el.scrollWidth <= el.clientWidth), true, `${uiLang} ${width}px ${panel} 内容不得横向溢出`);
      }
    }
    assert.equal(await page.locator("#engine-switcher [data-engine-val]").count(), 2);
    if (uiLang === "zh-TW") await screenshot(page, "settings-cool");
    const popup = await ui.open("popup.html", 352, 600);
    assert.equal(await popup.locator("#engine-switcher [data-engine-val]").count(), 2);
    assert.ok((await popup.locator("#open-settings-btn").innerText()).length > 0);
    assert.equal(await popup.evaluate(() => document.body.scrollWidth <= document.body.clientWidth), true, `${uiLang} 弹窗不得横向溢出`);
    if (uiLang === "zh-TW") await screenshot(popup, "popup-cool", "body");
    if (uiLang === "en" || uiLang === "ja") await screenshot(popup, `popup-${uiLang}`, "body");
  }
});

test("存储失败有可见提示，不伪装成已保存", async t => {
  const ui = await createUI(t, { translateEngine: "google" });
  const page = await ui.open("settings.html");
  ui.state.failWrites = true;
  await page.locator('[data-display-val="bilingual"]').click();
  await page.waitForFunction(() => /失败|重试/.test(document.querySelector("#settings-footer-save-status").textContent));
  assert.notEqual(ui.state.stored.displayMode, "bilingual");
});

test("自定义API未填地址时显示错误并阻止保存", async t => {
  const ui = await createUI(t, { translateEngine: "api", apiKey: "test-key", apiModel: "saved-model", apiBaseUrl: "https://example.test/v1" });
  const page = await ui.open("settings.html");
  await page.locator("#api-provider-select").selectOption("custom");
  await page.locator("#api-model-input").fill("custom-model");
  await page.locator("#api-base-url-input").fill("");
  await page.locator("#save-api-btn").click();
  await page.waitForFunction(() => /地址/.test(document.querySelector("#api-hint").textContent));
  assert.equal(ui.state.stored.apiBaseUrl, "https://example.test/v1");
  assert.equal(ui.state.stored.apiModel, "saved-model");
});

test("旧自定义API缺少地址时不预填其他服务，弹窗提示配置", async t => {
  for (const apiBaseUrl of [undefined, ""]) {
    const ui = await createUI(t, { translateEngine: "api", apiProvider: "custom", apiKey: "test-key", apiModel: "custom-model", apiBaseUrl });
    const settings = await ui.open("settings.html");
    assert.equal(await settings.locator("#api-base-url-input").inputValue(), "");
    const popup = await ui.open("popup.html", 352, 600);
    await popup.locator("#toggle-page-btn").click();
    assert.equal(await popup.evaluate(() => window.extensionMock.messages.some(msg => msg.type === "TOGGLE_PAGE_TRANSLATE")), false);
    assert.match(await popup.locator("#popup-message").innerText(), /配置云端 API/);
  }
});
