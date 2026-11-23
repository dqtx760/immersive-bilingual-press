const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(process.env.CONTENT_SCRIPT_PATH || path.join(root, "content.js"), "utf8");
let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" }); });
after(async () => { await browser?.close(); });

async function openPage(t) {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <p id="english-word">hello</p>
    <p id="english-sentence">The quick brown fox jumps over the lazy dog.</p>
    <p id="chinese">你好世界</p>
    <p id="japanese">こんにちは世界</p>
    <p id="korean">안녕하세요 세계</p>
    <p id="digits">12345</p>
    <p id="mixed">hello 世界</p>
  </body></html>`);
  await page.evaluate(() => {
    const portReceivers = [];
    const mock = window.mock = { messages: [] };
    window.chrome = {
      storage: {
        local: {
          get: (_, cb) => cb({ translateEngine: "google", sourceLang: "auto", targetLang: "zh-CN", uiLang: "zh-CN", enableSelection: true }),
          set: async () => {}
        },
        onChanged: { addListener: () => {} }
      },
      runtime: {
        onMessage: { addListener: () => {} },
        connect: () => ({
          onMessage: { addListener: fn => portReceivers.push(fn) }, onDisconnect: { addListener: () => {} },
          postMessage: msg => {
            if (msg.action !== "TRANSLATE") return;
            mock.messages.push(msg);
            queueMicrotask(() => portReceivers.forEach(fn => fn({ type: "DONE", requestId: msg.requestId, fullText: "Translated text." })));
          }
        })
      }
    };
  });
  await page.addScriptTag({ content: script });
  return page;
}

async function selectText(page, selector) {
  await page.evaluate(selector => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const el = document.querySelector(selector);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 180, clientY: 180 }));
  }, selector);
}

test("仅英文划词显示译按钮，中文/日文/韩文/数字/中英混合不显示", async t => {
  const page = await openPage(t);
  const cases = [
    ["#english-word", true],
    ["#english-sentence", true],
    ["#chinese", false],
    ["#japanese", false],
    ["#korean", false],
    ["#digits", false],
    ["#mixed", false]
  ];
  for (const [selector, shouldShow] of cases) {
    await selectText(page, selector);
    if (shouldShow) {
      await page.locator("#oit-selection-btn").waitFor({ state: "visible", timeout: 1000 });
    } else {
      await page.waitForTimeout(100);
      assert.equal(await page.locator("#oit-selection-btn").count(), 0, `${selector} 不应显示译按钮`);
    }
  }
});

test("英文划词点击译按钮后正常打开译文卡片并发送翻译请求", async t => {
  const page = await openPage(t);
  await selectText(page, "#english-sentence");
  await page.locator("#oit-selection-btn").click();
  await page.locator("#oit-selection-popup").waitFor();
  await page.waitForFunction(() => document.querySelector("#oit-popup-content")?.textContent === "Translated text.");
  const messages = await page.evaluate(() => window.mock.messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "The quick brown fox jumps over the lazy dog.");
});
