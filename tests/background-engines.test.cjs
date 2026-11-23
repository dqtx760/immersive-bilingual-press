const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function loadBackground(config = {}, options = {}) {
  const stored = { ...config }, requests = [], installed = [], connected = [], startup = [], commands = [], tabMessages = [];
  const context = vm.createContext({
    console, AbortController, AbortSignal, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (/translate.googleapis.com|clients5.google.com/.test(url)) return new Response(JSON.stringify([[["你好", "Hello"]]]));
      if (String(url).startsWith("https://api.example.test/")) return new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n');
      throw new Error("测试禁止访问本地模型服务");
    },
    chrome: {
      commands: { onCommand: { addListener: fn => commands.push(fn) } },
      tabs: {
        query: async () => options.noTab ? [] : [{ id: 9 }],
        sendMessage: async (tabId, msg) => {
          if (options.pageUnavailable) throw new Error("没有内容脚本");
          tabMessages.push({ tabId, ...msg });
        }
      },
      storage: { local: {
        get: async keys => Object.fromEntries((keys || Object.keys(stored)).filter(key => key in stored).map(key => [key, stored[key]])),
        set: async updates => { Object.assign(stored, updates); }
      } },
      runtime: { onInstalled: { addListener: fn => installed.push(fn) }, onStartup: { addListener: fn => startup.push(fn) },
        onConnect: { addListener: fn => connected.push(fn) }, onMessage: { addListener: () => {} } }
    }
  });
  vm.runInContext(source, context);
  function connect() {
    const listeners = [], messages = [];
    const port = { name: "ollama-translate-stream", postMessage: msg => messages.push(msg), onDisconnect: { addListener: () => {} }, onMessage: { addListener: fn => listeners.push(fn) } };
    connected.forEach(fn => fn(port));
    assert.ok(listeners.length, "兼容现有内容脚本的翻译端口");
    return { messages, send: msg => Promise.all(listeners.map(fn => fn(msg))) };
  }
  return { stored, requests, installed, connect, tabMessages, command: (name, tab) => Promise.all(commands.map(fn => fn(name, tab))) };
}

test("更新时迁移本地引擎，不探测本地服务且保留已保存配置", async () => {
  const worker = loadBackground({ translateEngine: "ollama", apiKey: "test-key", apiModel: "saved-model", selectedModel: "old-model" });
  await Promise.all(worker.installed.map(fn => fn()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.stored.translateEngine, "google");
  assert.equal(worker.stored.apiKey, "test-key");
  assert.equal(worker.stored.apiModel, "saved-model");
  assert.equal(worker.stored.selectedModel, "old-model");
  assert.equal(worker.requests.length, 0);
});

test("旧内容脚本指定本地引擎时改用 Google", async () => {
  const worker = loadBackground({ translateEngine: "ollama" });
  const port = worker.connect();
  await port.send({ action: "TRANSLATE", requestId: "legacy", text: "Hello", translateEngine: "ollama", targetLang: "zh-CN" });
  assert.equal(port.messages.find(msg => msg.type === "DONE")?.fullText, "你好");
  assert.equal(port.messages.some(msg => msg.type === "ERROR"), false);
  assert.ok(worker.requests.every(request => request.url.startsWith("https://translate.googleapis.com/") || request.url.startsWith("https://clients5.google.com/")));
});

test("新设置和未知引擎无配置时均可使用 Google", async () => {
  for (const translateEngine of [undefined, "unknown"]) {
    const worker = loadBackground({ translateEngine });
    const port = worker.connect();
    await port.send({ action: "TRANSLATE", requestId: "default", text: "Hello", targetLang: "zh-CN" });
    assert.equal(port.messages.find(msg => msg.type === "DONE")?.fullText, "你好");
    assert.equal(worker.requests.length, 1);
  }
});

test("云端 API 流式翻译及配置保持可用", async () => {
  const worker = loadBackground({ translateEngine: "api", apiKey: "test-key", apiModel: "saved-model", apiBaseUrl: "https://api.example.test/v1" });
  await Promise.all(worker.installed.map(fn => fn()));
  assert.equal(worker.stored.translateEngine, "api");
  const port = worker.connect();
  await port.send({ action: "TRANSLATE", requestId: "api", text: "Hello", translateEngine: "api", targetLang: "zh-CN" });
  assert.equal(port.messages.find(msg => msg.type === "DONE")?.fullText, "你好");
  assert.ok(port.messages.some(msg => msg.type === "CHUNK" && msg.fullText === "你好"));
  assert.equal(worker.requests[0].url, "https://api.example.test/v1/chat/completions");
  assert.equal(JSON.parse(worker.requests[0].options.body).model, "saved-model");
  assert.equal(worker.stored.apiKey, "test-key");
});

test("清单不再申请本地引擎专用权限或注册 CORS 改写规则", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.permissions.includes("declarativeNetRequest"), false);
  assert.equal("declarative_net_request" in manifest, false);
  assert.equal(manifest.host_permissions.some(permission => /localhost|127\.0\.0\.1/.test(permission)), false);
  assert.doesNotMatch(manifest.name + manifest.description + manifest.action.default_title, /Ollama|本地大模型/);
});

test("原生快捷键只向目标标签页发送一次翻译切换", async () => {
  const worker = loadBackground();
  await worker.command("toggle-page-translate", { id: 27 });
  assert.deepEqual(worker.tabMessages, [{ tabId: 27, type: "TOGGLE_PAGE_TRANSLATE" }]);
  await worker.command("unknown", { id: 27 });
  assert.equal(worker.tabMessages.length, 1);
});

test("快捷键可查询当前标签页，浏览器内部页面不产生未处理错误", async () => {
  const worker = loadBackground();
  await worker.command("toggle-page-translate");
  assert.deepEqual(worker.tabMessages, [{ tabId: 9, type: "TOGGLE_PAGE_TRANSLATE" }]);
  for (const options of [{ noTab: true }, { pageUnavailable: true }]) {
    const unavailable = loadBackground({}, options);
    await unavailable.command("toggle-page-translate");
    assert.equal(unavailable.tabMessages.length, 0);
  }
});

test("清单注册独立设置页和可由浏览器修改的快捷键", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.options_ui, { page: "settings.html", open_in_tab: true });
  assert.equal(manifest.commands["toggle-page-translate"].suggested_key.default, "Alt+A");
});

test("自定义API缺少地址时禁止发出请求，不回退到默认服务", async () => {
  for (const apiBaseUrl of ["", undefined]) {
    const worker = loadBackground({ translateEngine: "api", apiProvider: "custom", apiKey: "test-other-provider-key", apiModel: "custom-model", apiBaseUrl });
    const port = worker.connect();
    await port.send({ action: "TRANSLATE", requestId: "custom", text: "Hello", translateEngine: "api", targetLang: "zh-CN" });
    assert.equal(worker.requests.length, 0);
    assert.ok(port.messages.some(msg => msg.type === "ERROR" && /地址/.test(msg.error)));
    await Promise.all(worker.installed.map(fn => fn()));
    const afterUpdate = worker.connect();
    await afterUpdate.send({ action: "TRANSLATE", requestId: "custom-after-update", text: "Hello", translateEngine: "api" });
    assert.equal(worker.requests.length, 0);
  }
});
