const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(process.env.CONTENT_SCRIPT_PATH || path.join(root, "content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const fixture = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; } body { margin: 24px; font: 16px/1.4 Arial, sans-serif; }
  main { width: 960px; } h1 { font-size: 28px; } p { margin: 0; }
  .row { display: flex; gap: 16px; } .card { width: 360px; padding: 20px; border: 1px solid; border-radius: 20px; }
  .label { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .icon { flex: none; width: 24px; height: 24px; background: #b6f200; }
  .value { display: flex; align-items: center; gap: 8px; font-size: 40px; font-weight: 700; }
  #chart { display: flex; align-items: end; gap: 28px; margin-top: 24px; }
  .column { width: 28px; text-align: center; } .column p { font-size: 12px; }
  .bar { height: 100px; background: #f0ffd0; border: 1px solid; border-radius: 6px; }
  #mixed { margin-top: 20px; } #mixed strong { color: #087830; } #mixed a { color: #164fc4; }
</style><main>
  <h1 id="heading">仪表板</h1>
  <div class="row"><section id="earnings" class="card">
    <p id="label" class="label"><svg id="icon" class="icon" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg><span>收益</span></p>
    <p id="value" class="value"><span class="icon"></span>102.085K</p>
  </section><section id="network" class="card"><p id="status">您当前没有连接的网络。</p></section></div>
  <div id="chart"><div class="column"><p id="metric">6K</p><div class="bar"></div><p id="month">十月</p></div></div>
  <p id="mixed">查看 <strong id="emphasis">收益</strong>，点击 <a id="link" href="#details">奖励</a>。</p>
  <p id="protected"><code>doNotTranslate()</code><span translate="no">Grass</span><span contenteditable="true">可编辑文字</span></p>
</main>`;

let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" }); });
after(async () => { await browser?.close(); });

async function openPage(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  t.after(() => page.close());
  await page.setContent(fixture);
  await page.addStyleTag({ content: css });
  await page.evaluate(options => {
    const messages = [], receivers = [], storageReceivers = [], portReceivers = [];
    const dictionary = { "仪表板": "Dashboard", "收益": "Earnings", "您当前没有连接的网络。": "No connected network.", "十月": "October", "查看": "View", "，点击": ", click", "奖励": "Rewards" };
    window.mock = { messages, hold: options.hold, fail: options.fail, dictionary, reply: (request, type, fullText) => portReceivers.forEach(fn => fn({ requestId: request.requestId, type, fullText, error: "测试错误" })),
      toggle: () => receivers.forEach(fn => fn({ type: "TOGGLE_PAGE_TRANSLATE" }, {}, () => {})),
      change: changes => storageReceivers.forEach(fn => fn(changes)),
      snapshot: () => Array.from(document.querySelectorAll("main, main *"), el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return [el.tagName, el.id, r.x, r.y, r.width, r.height, s.display, s.padding, s.margin, s.font, s.color, s.backgroundColor];
      }) };
    window.chrome = { storage: { local: { get: (_, cb) => cb({ translateEngine: options.engine || "google", targetLang: "en", displayMode: "translation-only", enableFloatingBall: false, uiTheme: options.theme || "retro-paper" }), set: async () => {} }, onChanged: { addListener: fn => storageReceivers.push(fn) } },
      runtime: { onMessage: { addListener: fn => receivers.push(fn) }, connect: () => ({ onMessage: { addListener: fn => portReceivers.push(fn) }, onDisconnect: { addListener: () => {} }, postMessage: msg => {
        if (msg.action !== "TRANSLATE") return;
        messages.push(msg);
        if (!window.mock.hold) queueMicrotask(() => window.mock.reply(msg, window.mock.fail ? "ERROR" : "DONE", window.mock.dictionary[msg.text] || msg.text));
      } }) } };
    window.originalChildren = Array.from(document.querySelectorAll("main, main *"), el => [el, Array.from(el.childNodes)]);
    window.originalHtml = document.querySelector("main").innerHTML;
    document.querySelector("#link").addEventListener("click", e => { e.preventDefault(); window.linkClicks = (window.linkClicks || 0) + 1; });
  }, options);
  await page.addScriptTag({ content: script });
  return page;
}

async function translate(page) {
  await page.evaluate(() => window.mock.toggle());
  await page.waitForFunction(() => window.mock.messages.length && !document.querySelector('[data-oit-state="queued"], [data-oit-state="translating"]'));
}

test("仅显示译文保留节点、图标、文字样式和链接交互", async t => {
  const page = await openPage(t);
  const styles = await page.locator("#label").evaluate(el => { const s = getComputedStyle(el); return [s.font, s.padding, s.background, s.display]; });
  await translate(page);
  assert.equal(await page.locator("#heading").innerText(), "Dashboard");
  assert.equal(await page.locator(".oit-bilingual-block, .oit-source-hidden").count(), 0);
  assert.equal(await page.evaluate(() => window.originalChildren.every(([el, children]) => children.length === el.childNodes.length && children.every((node, i) => node === el.childNodes[i]))), true);
  assert.deepEqual(await page.locator("#label").evaluate(el => { const s = getComputedStyle(el); return [s.font, s.padding, s.background, s.display]; }), styles);
  assert.equal(await page.locator("#icon").isVisible(), true);
  assert.equal(await page.locator("#emphasis").innerText(), "Earnings");
  assert.equal(await page.locator("#link").innerText(), "Rewards");
  await page.locator("#link").click();
  assert.equal(await page.evaluate(() => window.linkClicks), 1);
  assert.equal(await page.locator("#metric").innerText(), "6K");
  assert.equal(await page.locator("#value").innerText(), "102.085K");
  if (process.env.LAYOUT_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.LAYOUT_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.LAYOUT_SCREENSHOT_DIR, "translated.png") });
  }
});

test("原文保持可见直到翻译完成，流式片段不会插入占位卡", async t => {
  const page = await openPage(t, { hold: true });
  const before = await page.evaluate(() => window.mock.snapshot());
  await page.evaluate(() => window.mock.toggle());
  await page.waitForFunction(() => window.mock.messages.length > 0);
  assert.equal(await page.locator("#heading").innerText(), "仪表板");
  assert.deepEqual(await page.evaluate(() => window.mock.snapshot()), before);
  await page.evaluate(() => window.mock.reply(window.mock.messages[0], "CHUNK", "Dash"));
  assert.equal(await page.locator("#heading").innerText(), "仪表板");
});

test("引擎返回原样文字时，两套主题的布局与原文完全相同", async t => {
  for (const theme of ["retro-paper", "liquid-glass"]) {
    const page = await openPage(t, { theme });
    await page.evaluate(() => { window.mock.dictionary = {}; });
    const before = await page.evaluate(() => window.mock.snapshot());
    await translate(page);
    assert.deepEqual(await page.evaluate(() => window.mock.snapshot()), before);
  }
});

test("还原精确保留原始内容、空白和 DOM，支持重复翻译", async t => {
  const page = await openPage(t);
  for (let i = 0; i < 2; i++) {
    await translate(page);
    await page.evaluate(() => window.mock.toggle());
    assert.equal(await page.locator("main").innerHTML(), await page.evaluate(() => window.originalHtml));
  }
});

test("翻译失败保留原文且不改变布局", async t => {
  const page = await openPage(t, { fail: true });
  const before = await page.evaluate(() => window.mock.snapshot());
  await translate(page);
  assert.deepEqual(await page.evaluate(() => window.mock.snapshot()), before);
  assert.equal(await page.locator("#heading").innerText(), "仪表板");
});

test("模式切换后双语对照仍有译文块，切回译文模式清理块并可还原", async t => {
  const page = await openPage(t);
  await translate(page);
  await page.evaluate(() => window.mock.change({ displayMode: { newValue: "bilingual" } }));
  await page.waitForFunction(() => document.querySelector(".oit-bilingual-block") && !document.querySelector('[data-oit-state="queued"], [data-oit-state="translating"]'));
  assert.ok((await page.locator("#heading").innerText()).includes("仪表板"));
  await page.evaluate(() => window.mock.change({ displayMode: { newValue: "translation-only" } }));
  await page.waitForFunction(() => document.querySelector("#heading").innerText === "Dashboard" && !document.querySelector('[data-oit-state="queued"], [data-oit-state="translating"]'));
  assert.equal(await page.locator(".oit-bilingual-block").count(), 0);
  await page.evaluate(() => window.mock.toggle());
  assert.equal(await page.locator("main").innerHTML(), await page.evaluate(() => window.originalHtml));
});

test("还原后忽略迟到响应，不覆盖网站自行更新的数据", async t => {
  const page = await openPage(t, { hold: true });
  await page.evaluate(() => window.mock.toggle());
  await page.waitForFunction(() => window.mock.messages.length > 0);
  await page.evaluate(() => { window.mock.toggle(); window.mock.messages.forEach(msg => window.mock.reply(msg, "DONE", "迟到译文")); });
  assert.equal(await page.locator("main").innerHTML(), await page.evaluate(() => window.originalHtml));
  await page.evaluate(() => { window.mock.hold = false; });
  await translate(page);
  await page.locator("#status").evaluate(el => { el.firstChild.data = "网络状态已由网页更新"; });
  await page.evaluate(() => window.mock.toggle());
  assert.equal(await page.locator("#status").innerText(), "网络状态已由网页更新");
});

test("代码、禁止翻译内容和可编辑文字保持原样", async t => {
  const page = await openPage(t);
  await translate(page);
  assert.equal(await page.locator("#protected").innerHTML(), '<code>doNotTranslate()</code><span translate="no">Grass</span><span contenteditable="true">可编辑文字</span>');
  assert.equal(await page.evaluate(() => window.mock.messages.some(msg => /doNotTranslate|Grass|可编辑文字/.test(msg.text))), false);
});

test("段落部分翻译失败后重试，仍可恢复最初原文", async t => {
  const page = await openPage(t, { hold: true });
  const original = await page.locator("#mixed").innerHTML();
  await page.locator("#mixed").hover();
  await page.keyboard.down("Alt");
  await page.waitForFunction(() => window.mock.messages.length === 1);
  await page.keyboard.up("Alt");
  await page.evaluate(() => window.mock.reply(window.mock.messages[0], "DONE", "View"));
  await page.waitForFunction(() => window.mock.messages.length === 2);
  await page.evaluate(() => window.mock.reply(window.mock.messages[1], "ERROR"));
  await page.waitForFunction(() => document.querySelector("#mixed").dataset.oitState === "error");
  await page.evaluate(() => { window.mock.hold = false; });
  await page.keyboard.down("Alt");
  await page.waitForFunction(() => document.querySelector("#mixed").dataset.oitState === "translated");
  await page.keyboard.up("Alt");
  await page.keyboard.down("Alt");
  await page.waitForFunction(() => !document.querySelector("#mixed").dataset.oitState);
  await page.keyboard.up("Alt");
  assert.equal(await page.locator("#mixed").innerHTML(), original);
});

test("嵌套候选段落中的同一文字只提交一次翻译", async t => {
  const page = await openPage(t, { hold: true });
  await page.locator("main").evaluate(el => { el.innerHTML = '<blockquote>外层句子<dl><dd>内层句子</dd></dl></blockquote>'; });
  await page.evaluate(() => window.mock.toggle());
  await page.waitForFunction(() => window.mock.messages.length === 2);
  await page.evaluate(() => { window.mock.hold = false; window.mock.messages.slice().forEach(msg => window.mock.reply(msg, "DONE", msg.text)); });
  await page.waitForFunction(() => !document.querySelector('[data-oit-state="queued"], [data-oit-state="translating"]'));
  assert.deepEqual(await page.evaluate(() => window.mock.messages.map(msg => msg.text).sort()), ["内层句子", "外层句子"]);
});

test("字体图标的连字保持原样，旁边的文字正常翻译", async t => {
  const page = await openPage(t);
  await page.locator("main").evaluate(el => {
    el.innerHTML = '<p><i id="font-icon" style="font-family: Material Icons">language</i> <span id="settings-label">设置</span></p>';
    window.mock.dictionary.language = "语言";
    window.mock.dictionary["设置"] = "Settings";
  });
  await translate(page);
  assert.equal(await page.locator("#font-icon").innerText(), "language");
  assert.equal(await page.locator("#settings-label").innerText(), "Settings");
  assert.equal(await page.evaluate(() => window.mock.messages.some(msg => msg.text === "language")), false);
});

test("display: contents 中的可见文字可翻译，隐藏文字保持原样", async t => {
  const page = await openPage(t);
  await page.locator("main").evaluate(el => {
    el.innerHTML = '<p>请阅读 <span id="contents-text" style="display:contents">重要内容</span><span style="display:none"><span style="display:contents">隐藏内容</span></span></p>';
    window.mock.dictionary["重要内容"] = "Important content";
  });
  await translate(page);
  assert.equal(await page.locator("#contents-text").innerText(), "Important content");
  assert.equal(await page.evaluate(() => window.mock.messages.some(msg => msg.text === "隐藏内容")), false);
});

test("旧网页配置中的本地或未知引擎自动改用 Google", async t => {
  for (const engine of ["ollama", "unknown"]) {
    const page = await openPage(t, { engine });
    await translate(page);
    assert.equal(await page.locator("#heading").innerText(), "Dashboard");
    assert.equal(await page.evaluate(() => window.mock.messages.every(msg => msg.translateEngine === "google")), true);
  }
});

test("网页脚本不重复处理已交给浏览器的整页快捷键", async t => {
  const page = await openPage(t);
  await page.keyboard.press("Alt+a");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.mock.messages.length), 0);
  assert.equal(await page.locator("#heading").innerText(), "仪表板");
});
