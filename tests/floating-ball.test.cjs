const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(process.env.CONTENT_SCRIPT_PATH || path.join(root, "content.js"), "utf8");
const css = fs.readFileSync(process.env.CONTENT_STYLE_PATH || path.join(root, "content.css"), "utf8");
let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", ignoreDefaultArgs: ["--hide-scrollbars"] }); });
after(async () => { await browser?.close(); });

async function openPage(t, config = {}) {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; min-height: 2200px; background: #f5f6f8; font: 16px/1.5 Arial, sans-serif; }
    main { width: 620px; max-width: calc(100% - 64px); margin: 48px 32px; }
    p { padding: 24px; border-radius: 12px; background: white; }
    button { padding: 20px 30px; border-radius: 4px; font-size: 30px; }
  </style></head><body><main><p id="sample">这是一段用于验证悬浮球的文字。</p></main></body></html>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(config => {
    const storageReceivers = [], portReceivers = [];
    const mock = window.mock = { messages: [], pointerId: null, change: changes => storageReceivers.forEach(fn => fn(changes, "local")) };
    window.chrome = {
      storage: { local: {
        get: (_, cb) => cb({ translateEngine: "google", sourceLang: "zh-CN", targetLang: "en", displayMode: "translation-only", uiTheme: "retro-paper", uiLang: "zh-CN", enableFloatingBall: true, ...config }),
        set: async () => {}
      }, onChanged: { addListener: fn => storageReceivers.push(fn) } },
      runtime: {
        onMessage: { addListener: () => {} },
        connect: () => ({
          onMessage: { addListener: fn => portReceivers.push(fn) }, onDisconnect: { addListener: () => {} },
          postMessage: msg => {
            if (msg.action !== "TRANSLATE") return;
            mock.messages.push(msg);
            queueMicrotask(() => portReceivers.forEach(fn => fn({ type: "DONE", requestId: msg.requestId, fullText: "A paragraph for testing the floating button." })));
          }
        })
      }
    };
    document.addEventListener("pointerdown", event => { if (event.target.closest("#oit-floating-ball")) mock.pointerId = event.pointerId; }, true);
  }, config);
  await page.addScriptTag({ content: script });
  await page.locator("#oit-floating-ball").waitFor();
  return page;
}

async function drag(page, x, y) {
  const box = await page.locator("#oit-floating-ball").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

async function assertUntranslated(page) {
  assert.equal(await page.locator("#sample").innerText(), "这是一段用于验证悬浮球的文字。");
  assert.equal(await page.evaluate(() => window.mock.messages.length), 0, "拖动不能发送翻译请求");
}

async function screenshot(page, name) {
  if (!process.env.LAYOUT_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.LAYOUT_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.LAYOUT_SCREENSHOT_DIR, name + ".png"), animations: "disabled" });
}

test("悬浮球两主题和翻译状态都保持小圆形，支持键盘操作", async t => {
  for (const uiTheme of ["retro-paper", "liquid-glass"]) {
    const page = await openPage(t, { uiTheme });
    const ball = page.locator("#oit-floating-ball");
    const before = await ball.boundingBox();
    assert.ok(before.width <= 40 && Math.abs(before.width - before.height) < 1, "悬浮球应为不大于40px的圆形");
    assert.equal(await ball.evaluate(el => el.tagName), "BUTTON");
    await screenshot(page, `floating-ball-${uiTheme}`);
    await ball.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#oit-floating-ball").classList.contains("oit-active"));
    const after = await ball.boundingBox();
    assert.deepEqual([after.width, after.height], [before.width, before.height]);
    assert.equal(await ball.getAttribute("aria-pressed"), "true");
    await screenshot(page, `floating-ball-${uiTheme}-restore`);
    await page.keyboard.press("Space");
    assert.equal(await ball.getAttribute("aria-pressed"), "false");
  }
});

test("左键拖动到任意位置，不触发翻译，随后点击仍可翻译和还原", async t => {
  const page = await openPage(t);
  await drag(page, 300, 220);
  const moved = await page.locator("#oit-floating-ball").boundingBox();
  assert.ok(Math.abs(moved.x + moved.width / 2 - 300) < 1 && Math.abs(moved.y + moved.height / 2 - 220) < 1, "拖动后应到达鼠标位置");
  await assertUntranslated(page);
  await screenshot(page, "floating-ball-dragged");
  await page.locator("#oit-floating-ball").click();
  await page.waitForFunction(() => document.querySelector("#sample").textContent.startsWith("A paragraph"));
  await page.locator("#oit-floating-ball").click();
  assert.equal(await page.locator("#sample").innerText(), "这是一段用于验证悬浮球的文字。");
});

test("拖动保留抓取偏移并限制边缘，窗口缩小和滚动后仍可访问", async t => {
  const page = await openPage(t);
  const ball = page.locator("#oit-floating-ball");
  const before = await ball.boundingBox();
  await page.mouse.move(before.x + 5, before.y + 7);
  await page.mouse.down();
  await page.mouse.move(205, 157, { steps: 8 });
  await page.mouse.up();
  const moved = await ball.boundingBox();
  assert.ok(Math.abs(moved.x - 200) < 1 && Math.abs(moved.y - 150) < 1, "抓取点不应跳到圆心");
  await drag(page, 0, 0);
  const topLeft = await ball.boundingBox();
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0);
  await page.addStyleTag({ content: "html { overflow: scroll; } body { min-width: 1400px; }" });
  await drag(page, 959, 719);
  assert.equal(await ball.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.right <= document.documentElement.clientWidth && r.bottom <= document.documentElement.clientHeight;
  }), true, "悬浮球不得盖入页面滚动条");
  await page.setViewportSize({ width: 420, height: 360 });
  await page.waitForFunction(() => { const r = document.querySelector("#oit-floating-ball").getBoundingClientRect(); return r.right <= document.documentElement.clientWidth && r.bottom <= document.documentElement.clientHeight; });
  const resized = await ball.boundingBox();
  await page.evaluate(() => window.scrollTo(0, 500));
  assert.deepEqual(await ball.boundingBox(), resized);
  await assertUntranslated(page);
});

test("主题语言切换和关闭重开悬浮球不重置已拖动的位置", async t => {
  const page = await openPage(t);
  await drag(page, 280, 250);
  const ball = page.locator("#oit-floating-ball");
  const moved = await ball.boundingBox();
  await page.evaluate(() => window.mock.change({ uiTheme: { newValue: "liquid-glass" }, uiLang: { newValue: "en" }, targetLang: { newValue: "ja" } }));
  assert.deepEqual(await ball.boundingBox(), moved);
  await page.evaluate(() => window.mock.change({ enableFloatingBall: { newValue: false } }));
  assert.equal(await ball.isVisible(), false);
  await page.evaluate(() => window.mock.change({ enableFloatingBall: { newValue: true } }));
  assert.deepEqual(await ball.boundingBox(), moved);
  assert.match(await ball.getAttribute("title"), /drag/i);
});

test("小幅抖动仍可点击，右键不会移动悬浮球", async t => {
  const page = await openPage(t);
  const ball = page.locator("#oit-floating-ball");
  const before = await ball.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(300, 220, { steps: 4 });
  await page.mouse.up({ button: "right" });
  assert.deepEqual(await ball.boundingBox(), before);
  await assertUntranslated(page);
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 2, before.y + before.height / 2 + 1);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#oit-floating-ball").classList.contains("oit-active"));
});

test("取消拖动或丢失捕获后不误翻译，再次操作不受影响", async t => {
  for (const action of ["pointercancel", "lostcapture", "blur"]) {
    const page = await openPage(t);
    const ball = page.locator("#oit-floating-ball");
    const before = await ball.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(280, 250, { steps: 4 });
    await page.evaluate(action => {
      const el = document.querySelector("#oit-floating-ball");
      if (action === "lostcapture") el.releasePointerCapture(window.mock.pointerId);
      else if (action === "blur") window.dispatchEvent(new Event("blur"));
      else el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: window.mock.pointerId }));
    }, action);
    await page.mouse.up();
    await assertUntranslated(page);
    await ball.click();
    await page.waitForFunction(() => document.querySelector("#oit-floating-ball").classList.contains("oit-active"));
  }
});
