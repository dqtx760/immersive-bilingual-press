/**
 * Google 与云端 API 沉浸式翻译 - 后台服务脚本 (Manifest V3 Service Worker)
 * 支持多语言互译、Google 在线翻译与 OpenAI 兼容云端 API。
 */

const DEFAULT_SETTINGS = {
  translateEngine: "google", // "google" | "api"
  sourceLang: "auto",
  targetLang: "zh-CN",
  displayMode: "translation-only", // "bilingual" | "translation-only"
  uiTheme: "retro-paper", // "retro-paper" | "liquid-glass"
  uiLang: "zh-CN", // "zh-CN" | "zh-TW" | "en" | "ja"
  enableSelection: true,
  enableAltHover: true,
  enableFloatingBall: true,
  apiProvider: "deepseek",
  apiBaseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  apiModel: "deepseek-chat"
};

// 支持的语言元数据表
const LANGUAGE_MAP = {
  "auto": {
    name: "自动检测 (Auto)",
    enName: "Auto Detect",
    googleCode: "auto",
    promptName: "自动识别的源语言",
    scriptHint: ""
  },
  "zh-CN": {
    name: "简体中文",
    enName: "Simplified Chinese",
    googleCode: "zh-CN",
    promptName: "简体中文 (Simplified Chinese)",
    scriptHint: "必须使用规范的现代简体中文汉字输出。"
  },
  "zh-TW": {
    name: "繁體中文",
    enName: "Traditional Chinese",
    googleCode: "zh-TW",
    promptName: "繁體中文 (Traditional Chinese)",
    scriptHint: "必須使用道地的台灣/香港正體中文（繁體字）輸出，切勿混用簡體字。"
  },
  "en": {
    name: "英语 (English)",
    enName: "English",
    googleCode: "en",
    promptName: "英语 (English)",
    scriptHint: "You MUST output ONLY in natural, idiomatic English."
  },
  "ja": {
    name: "日语 (日本語)",
    enName: "Japanese",
    googleCode: "ja",
    promptName: "日语 (Japanese / 日本語)",
    scriptHint: "必ず自然な日本語（漢字・ひらがな・カタカナを適切に混ぜた日本語の文体）に翻訳して出力してください。中国語のまま出力することは絶対に禁止です。"
  },
  "ko": {
    name: "韩语 (한국어)",
    enName: "Korean",
    googleCode: "ko",
    promptName: "韩语 (Korean / 한국어)",
    scriptHint: "반드시 자연스러운 한국어(한글)로 번역하여 출력하세요. 원문(중국어 등)을 그대로 출력하지 마세요."
  },
  "fr": {
    name: "法语 (Français)",
    enName: "French",
    googleCode: "fr",
    promptName: "法语 (French / Français)",
    scriptHint: "Vous devez traduire et répondre uniquement en français naturel."
  },
  "de": {
    name: "德语 (Deutsch)",
    enName: "German",
    googleCode: "de",
    promptName: "德语 (German / Deutsch)",
    scriptHint: "Sie müssen ausschließlich in natürlichem Deutsch übersetzen und antworten."
  },
  "es": {
    name: "西班牙语 (Español)",
    enName: "Spanish",
    googleCode: "es",
    promptName: "西班牙语 (Spanish / Español)",
    scriptHint: "Debes traducir y responder únicamente en español natural."
  },
  "ru": {
    name: "俄语 (Русский)",
    enName: "Russian",
    googleCode: "ru",
    promptName: "俄语 (Russian / Русский)",
    scriptHint: "Вы должны переводить и отвечать исключительно на естественном русском языке."
  },
  "pt": {
    name: "葡萄牙语 (Português)",
    enName: "Portuguese",
    googleCode: "pt",
    promptName: "葡萄牙语 (Portuguese / Português)",
    scriptHint: "Você deve traduzir e responder exclusivamente em português natural."
  },
  "ar": {
    name: "阿拉伯语 (العربية)",
    enName: "Arabic",
    googleCode: "ar",
    promptName: "阿拉伯语 (Arabic / العربية)",
    scriptHint: "يجب عليك الترجمة والرد باللغة العربية الفصحى الطبيعية فقط."
  }
};

// 初始化默认配置
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.translateEngine = normalizeTranslateEngine(merged.translateEngine);
  if (stored.apiProvider === "custom" && !stored.apiBaseUrl) merged.apiBaseUrl = "";
  await chrome.storage.local.set(merged);
});

function normalizeTranslateEngine(engine) {
  return engine === "api" || engine === "google" ? engine : "google";
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-page-translate") return;
  try {
    const target = tab && tab.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (target && target.id) {
      await chrome.tabs.sendMessage(target.id, { type: "TOGGLE_PAGE_TRANSLATE" });
    }
  } catch (_) {
    // 浏览器内部页面等没有内容脚本的页面无法执行翻译。
  }
});

async function getTranslationSettings() {
  const cfg = await chrome.storage.local.get([
    "translateEngine",
    "sourceLang",
    "targetLang",
    "apiBaseUrl",
    "apiKey",
    "apiModel"
  ]);
  const translateEngine = normalizeTranslateEngine(cfg.translateEngine);
  if (cfg.translateEngine !== translateEngine) {
    await chrome.storage.local.set({ translateEngine });
  }
  return { ...DEFAULT_SETTINGS, ...cfg, translateEngine, apiBaseUrl: cfg.apiBaseUrl || "" };
}

/**
 * 过滤推理模型可能输出的 <think>...</think>、<thought>...</thought> 标签及多余前缀
 */
function stripThinkingAndMeta(text) {
  if (!text) return "";
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/◁think▷[\s\S]*?◁\/think▷/gi, "");

  const openTags = ["<think>", "<thought>", "◁think▷"];
  for (const tag of openTags) {
    const openIdx = cleaned.toLowerCase().indexOf(tag.toLowerCase());
    if (openIdx !== -1) {
      cleaned = cleaned.slice(0, openIdx);
    }
  }

  cleaned = cleaned.replace(/^(译文|翻译结果|翻译|Translation|Translated text|Here is the translation)\s*[:：]\s*/i, "");
  return cleaned.trimStart();
}

/**
 * 判断译文是否与原文几乎完全相同（用于检测中文译日语/外语时本地模型“直接照抄原文”的 Bug）
 */
function isUnchangedOutput(sourceText, translatedText, targetLang) {
  const s = (sourceText || "").replace(/\s+/g, "").trim();
  const t = (translatedText || "").replace(/\s+/g, "").trim();
  if (!s || !t) return true;
  if (s.length >= 4 && s === t) return true;

  if (targetLang === "ja" && s.length >= 4) {
    const sourceHasKana = /[\u3040-\u30ff]/.test(s);
    const targetHasKana = /[\u3040-\u30ff]/.test(t);
    const sourceHasHan = /[\u4e00-\u9faf]/.test(s);
    if (sourceHasHan && !sourceHasKana && !targetHasKana && s.slice(0, 4) === t.slice(0, 4)) {
      return true;
    }
  }

  if (targetLang === "ko" && s.length >= 3) {
    const targetHasHangul = /[\uac00-\ud7af\u1100-\u11ff]/.test(t);
    const sourceHasHan = /[\u4e00-\u9faf]/.test(s);
    if (sourceHasHan && !targetHasHangul) {
      return true;
    }
  }

  return false;
}

/**
 * 构建多语种互译专用 Prompt
 */
function buildTranslationMessages(text, sourceLang = "auto", targetLang = "zh-CN", strictRetry = false) {
  const srcMeta = LANGUAGE_MAP[sourceLang] || LANGUAGE_MAP["auto"];
  const tgtMeta = LANGUAGE_MAP[targetLang] || LANGUAGE_MAP["zh-CN"];

  const srcDesc = sourceLang === "auto" ? "自动检测的源语言文本" : `${srcMeta.promptName}文本`;
  const tgtDesc = tgtMeta.promptName;

  const systemPrompt =
    `你是一个顶尖的多语种沉浸式网页翻译引擎。你的唯一任务是将用户提供的【${srcDesc}】准确、地道、自然地翻译为【${tgtDesc}】。\n` +
    `请严格遵守以下铁律：\n` +
    `1. 无论用户输入的是中文、英文、日文还是任何其他语言，都必须将其完整翻译为目标语言【${tgtDesc}】！绝对禁止原样照抄或复读原文！\n` +
    `2. ${tgtMeta.scriptHint}\n` +
    `3. 只输出翻译后的【${tgtDesc}】译文正文，严禁输出任何解释、思考过程、前缀（如“译文：”）、引号或寒暄；\n` +
    `4. 保留专有名词、代码标识符、URL 与原有的段落语气。`;

  const userContent = strictRetry
    ? `请务必将以下文本翻译为【${tgtDesc}】（注意：切勿返回原文，必须使用${tgtDesc}表达）：\n\n${text.trim()}`
    : `Translate the following text into ${tgtMeta.enName} (${tgtDesc}). Output ONLY the translated ${tgtMeta.enName} text:\n\n${text.trim()}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];
}

/**
 * 在线 Google 翻译实现
 */
async function translateWithGoogle(text, sourceLang = "auto", targetLang = "zh-CN", signal) {
  const sl = (LANGUAGE_MAP[sourceLang] && LANGUAGE_MAP[sourceLang].googleCode) || "auto";
  const tl = (LANGUAGE_MAP[targetLang] && LANGUAGE_MAP[targetLang].googleCode) || "zh-CN";

  const url1 =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}` +
    `&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text.trim())}`;

  try {
    const res = await fetch(url1, {
      method: "GET",
      signal
    });
    if (!res.ok) {
      throw new Error(`Google 翻译 HTTP ${res.status}`);
    }
    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const translated = data[0]
        .map(seg => (Array.isArray(seg) && seg[0] ? seg[0] : ""))
        .join("");
      if (translated) return translated;
    }
  } catch (err) {
    if (err.name === "AbortError") throw err;
    const url2 =
      `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}` +
      `&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text.trim())}`;
    const res2 = await fetch(url2, { method: "GET", signal });
    if (!res2.ok) {
      throw new Error(`Google 在线翻译连接失败 (${res2.status})，请检查网络`);
    }
    const data2 = await res2.json();
    if (Array.isArray(data2)) {
      if (typeof data2[0] === "string") return data2[0];
      if (Array.isArray(data2[0]) && typeof data2[0][0] === "string") return data2[0][0];
    } else if (data2 && Array.isArray(data2.sentences)) {
      return data2.sentences.map(s => s.trans || "").join("");
    }
    throw err;
  }

  throw new Error("Google 翻译未返回有效译文");
}

/**
 * 将用户填写的云端 API 地址规范化为 OpenAI 兼容的 /chat/completions 端点
 */
function normalizeChatCompletionsUrl(baseUrl) {
  let url = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

/**
 * 调用云端大模型（OpenAI 兼容 /v1/chat/completions）流式翻译
 * 支持 OpenAI / DeepSeek / Moonshot / OpenRouter / Groq / xAI / Qwen 等任意 OpenAI 兼容服务商
 */
async function streamOpenAICompatTranslation({
  baseUrl,
  apiKey,
  model,
  text,
  sourceLang,
  targetLang,
  strictRetry = false,
  signal,
  onProgress
}) {
  const messages = buildTranslationMessages(text, sourceLang, targetLang, strictRetry);
  const endpoint = normalizeChatCompletionsUrl(baseUrl);
  if (!endpoint) throw new Error("云端 API 接口地址无效");

  const headers = { "Content-Type": "application/json" };
  if (apiKey && apiKey.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      temperature: strictRetry ? 0.35 : 0.2,
      messages
    }),
    signal
  });

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch (_) {}
    throw new Error(
      `云端 API [${model}] 响应异常 (HTTP ${response.status}): ${
        errText.slice(0, 300) || "请检查 API Key、模型名与接口地址是否正确"
      }`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let rawAccumulated = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.replace(/^data:\s*/, "");
      if (dataStr === "[DONE]") break;
      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        const piece = (delta && delta.content) || "";
        if (piece) {
          rawAccumulated += piece;
          onProgress(stripThinkingAndMeta(rawAccumulated));
        }
      } catch (_) {}
    }
  }

  return stripThinkingAndMeta(rawAccumulated).trim();
}

/**
 * 处理流式翻译长连接 (chrome.runtime.onConnect)
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "ollama-translate-stream") return;

  const activeControllers = new Map();

  port.onDisconnect.addListener(() => {
    for (const ctrl of activeControllers.values()) {
      ctrl.abort();
    }
    activeControllers.clear();
  });

  port.onMessage.addListener(async msg => {
    if (msg.action === "CANCEL" && msg.requestId) {
      const ctrl = activeControllers.get(msg.requestId);
      if (ctrl) {
        ctrl.abort();
        activeControllers.delete(msg.requestId);
      }
      return;
    }

    if (msg.action === "CANCEL_ALL") {
      for (const ctrl of activeControllers.values()) {
        ctrl.abort();
      }
      activeControllers.clear();
      return;
    }

    if (msg.action !== "TRANSLATE") return;

    const { requestId, text } = msg;
    if (!text || !text.trim()) {
      try {
        port.postMessage({ type: "DONE", requestId, fullText: "" });
      } catch (_) {}
      return;
    }

    const controller = new AbortController();
    activeControllers.set(requestId, controller);

    try {
      const cfg = await getTranslationSettings();
      const requestedEngine = msg.translateEngine !== undefined ? msg.translateEngine : cfg.translateEngine;
      const engine = normalizeTranslateEngine(requestedEngine);
      const sourceLang = msg.sourceLang || cfg.sourceLang || DEFAULT_SETTINGS.sourceLang;
      const targetLang = msg.targetLang || cfg.targetLang || DEFAULT_SETTINGS.targetLang;

      if (engine === "api") {
        const baseUrl = (cfg.apiBaseUrl || "").trim();
        const apiKey = cfg.apiKey || "";
        const apiModel = (cfg.apiModel || "").trim();

        if (!apiModel) {
          throw new Error("未配置云端模型，请在「语种与引擎」中填写服务商、API Key 与模型名");
        }
        if (!baseUrl) {
          throw new Error("请在设置页填写云端 API 接口地址");
        }

        const engineLabel = apiModel;
        port.postMessage({
          type: "CHUNK",
          requestId,
          model: engineLabel,
          fullText: "..."
        });

        let finalClean = await streamOpenAICompatTranslation({
          baseUrl,
          apiKey,
          model: apiModel,
          text,
          sourceLang,
          targetLang,
          strictRetry: false,
          signal: controller.signal,
          onProgress: cleanText => {
            port.postMessage({
              type: "CHUNK",
              requestId,
              model: engineLabel,
              fullText: cleanText
            });
          }
        });

        if (isUnchangedOutput(text, finalClean, targetLang)) {
          finalClean = await streamOpenAICompatTranslation({
            baseUrl,
            apiKey,
            model: apiModel,
            text,
            sourceLang,
            targetLang,
            strictRetry: true,
            signal: controller.signal,
            onProgress: cleanText => {
              port.postMessage({
                type: "CHUNK",
                requestId,
                model: engineLabel,
                fullText: cleanText
              });
            }
          });
        }

        port.postMessage({
          type: "DONE",
          requestId,
          model: engineLabel,
          fullText: finalClean || text
        });
        activeControllers.delete(requestId);
        return;
      }

      const engineLabel = "Google Translate";
      port.postMessage({
        type: "CHUNK",
        requestId,
        model: engineLabel,
        fullText: "..."
      });

      const googleResult = await translateWithGoogle(
        text,
        sourceLang,
        targetLang,
        controller.signal
      );

      port.postMessage({
        type: "DONE",
        requestId,
        model: engineLabel,
        fullText: googleResult
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        try {
          port.postMessage({
            type: "ERROR",
            requestId,
            error: err.message || "翻译请求失败"
          });
        } catch (_) {}
      }
    } finally {
      activeControllers.delete(requestId);
    }
  });
});
