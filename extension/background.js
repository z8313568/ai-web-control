/**
 * Service Worker（后台）。
 *
 * 职责：
 *   1. 把来自 sidepanel / content script 的请求转发给 native host；
 *   2. 处理 browse 类 action（打开 URL / 截图，走 chrome.tabs，不经 host）；
 *   3. 全局开关 + 速率限制（安全闸）；
 *   4. 网站适配：动态注入 adapter、拾取工具、权限流程。
 *
 * native 通信方式：chrome.runtime.sendNativeMessage（单次消息）。
 *   - 无状态：每次发一条、等一条回复，不维护长连接；
 *   - 因此 Service Worker 休眠/重启不影响（休眠只在没有请求时发生，有请求时 SW 是活的）；
 *   - 不需要 offscreen document（offscreen 的 NATIVE_COMMUNICATION reason 在当前
 *     Chrome 已不被接受，且单次消息模式更简单可靠）。
 *
 * 消息路由：
 *   sidepanel/content --[chrome.runtime.sendMessage]--> here
 *   here --[chrome.runtime.sendNativeMessage]--> native host
 */

const NATIVE_HOST = "com.zcode.aiwebcontrol";

// 全局开关，存 storage 以跨 SW 重启持久化
const DEFAULTS = { enabled: true, lastDangerous: null };

// --------------------------------------------------------------------------- //
// 初始化
// --------------------------------------------------------------------------- //
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...cur });
  await ensureSidePanelBehavior();
});

// 点扩展图标 → 开关侧边栏
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

async function ensureSidePanelBehavior() {
  // 允许任意页面打开 side panel
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

// --------------------------------------------------------------------------- //
// native 通信：单次消息模式（无状态，抗 SW 休眠）
// --------------------------------------------------------------------------- //
// 用 sendNativeMessage 发一条消息，包成 Promise。host 收到后处理并回复一条。
// 注意：host 端必须用 sendNativeMessage 兼容的模式（读写完即退出，不维持循环）。
//       但当前 host 是长连接循环模式——也能工作，因为 Chrome 用 sendNativeMessage
//       时会启动 host、发消息、收到第一条回复后不关闭 stdin（host 继续循环），
//       后续 sendNativeMessage 复用同一 host 进程。已实测可行。
function sendNative(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// --------------------------------------------------------------------------- //
// 消息中枢
// --------------------------------------------------------------------------- //
// (1) 一次性请求-响应：来自 sidepanel（chrome.runtime.sendMessage）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const res = await handle(msg, sender);
      sendResponse({ ok: true, data: res });
    } catch (e) {
      console.error("[bg] handle error:", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // 异步响应
});

// (2) 长连接：来自 content script（chrome.runtime.connect，name="webctl-content"）
// content script 持续发 exec 请求，我们用 port.postMessage 回结果。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "webctl-content") return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "exec") return;
    const sender = { tab: { id: -1 }, id: port.sender?.id }; // 速率限流键
    try {
      const data = await handleExec(msg, sender);
      // 统一把 action 带回去，方便 content script 渲染
      port.postMessage({ type: "result", id: msg.id, action: msg.action, ok: true, data });
    } catch (e) {
      console.error("[bg] content exec error:", e);
      port.postMessage({ type: "result", id: msg.id, action: msg.action, ok: false, error: e.message });
    }
  });
});

async function handle(msg, sender) {
  const type = msg?.type;

  // ---- 内部管理消息 ----
  if (type === "getStatus") {
    const st = await chrome.storage.local.get(["enabled"]);
    return { enabled: st.enabled !== false };
  }
  if (type === "setEnabled") {
    await chrome.storage.local.set({ enabled: !!msg.enabled });
    return { enabled: !!msg.enabled };
  }

  // ---- 转发到 native 的请求 ----
  if (type === "exec") {
    return await handleExec(msg, sender);
  }

  if (type === "ping-native") {
    const reply = await sendNative({ type: "ping", id: "manual" });
    return reply || { error: "无响应" };
  }

  // ---- 网站适配配置 ----
  if (type === "list-adapters") return await listAdapters();
  if (type === "save-adapter") return await saveAdapter(msg.config);
  if (type === "delete-adapter") return await deleteAdapter(msg.host);
  if (type === "pick-element") return await startPicker();
  if (type === "reload-adapter") return await reloadAdapter();
  if (type === "test-selector") return await testSelector(msg.selector);
  if (type === "test-codeblocks") return await testCodeblocks(msg.selector);
  if (type === "fill-input") return await fillInput(msg.selector, msg.text);
  if (type === "detect-output") return await detectOutput();

  // ---- native 诊断 ----
  if (type === "diagnose-offscreen") {
    // 兼容旧诊断按钮：直接测 native 是否能连通
    try {
      const r = await sendNative({ type: "ping", id: "diag" });
      return { exists: true, reasons: `native 在线: ${r?.platform || "?"}` };
    } catch (e) {
      return { exists: false, reasons: e.message };
    }
  }
  if (type === "create-offscreen") {
    // 兼容旧诊断按钮：直接试发一条 ping
    const r = await sendNative({ type: "ping", id: "diag-create" });
    return { ok: true, data: r };
  }

  // picker.js 回传的拾取结果（从 content script 发来）
  if (type === "picker-result") {
    const r = msg.result || {};
    if (!r.host || (!r.input && !r.send && !r.output)) {
      return { ok: false, reason: "未拾取到任何元素" };
    }
    // 合并进现有配置（保留用户之前设的其他字段）
    const st = await chrome.storage.local.get(["adapters"]);
    const adapters = st.adapters || {};
    const existing = adapters[r.host] || {};
    adapters[r.host] = {
      ...existing,
      host: r.host,
      label: existing.label || r.host,
      input: r.input || existing.input || "",
      send: r.send || existing.send || "",
      output: r.output || existing.output || "",
      injectPrompt: existing.injectPrompt !== undefined ? existing.injectPrompt : true,
    };
    await chrome.storage.local.set({ adapters });
    console.log(`[bg] 拾取结果已保存: ${r.host}`, adapters[r.host]);
    // 立即重注适配器到该域名所有标签页（使配置立即生效）
    await injectAdapterIntoMatchingTabs(r.host);
    return { ok: true, host: r.host };
  }

  throw new Error(`unknown message type: ${type}`);
}

// --------------------------------------------------------------------------- //
// exec 主流程：被 onMessage（sidepanel）和 onConnect（content）共用
// --------------------------------------------------------------------------- //
async function handleExec(msg, sender) {
  const st = await chrome.storage.local.get(["enabled"]);
  if (st.enabled === false) {
    throw new Error("扩展已被关闭，请在侧边栏重新启用");
  }

  const action = msg.action;
  if (!action) throw new Error("missing action");

  // browse 类走 chrome.tabs，不经 host
  if (action === "browse") {
    return await handleBrowse(msg);
  }

  if (action === "notify") {
    // 仅提示，不执行
    return { action: "notify", message: msg.params?.message };
  }

  // 其余（shell/file_*）走 native host（单次消息模式）
  rateLimitCheck(sender);
  const payload = { id: msg.id, action, ...(msg.params || {}) };
  console.log("[bg] → native:", JSON.stringify(payload));
  const reply = await sendNative(payload);
  console.log("[bg] ← native:", JSON.stringify(reply));
  if (!reply) throw new Error("native 无响应");

  // host 回复格式: { type:"result", id, ok, data:{...} } 或 { type:"pong", ... }
  if (reply.type === "result") {
    if (!reply.ok) {
      // 文件不存在 → 返回空内容（非致命）
      if (reply.error === "FileNotFoundError" || reply.error === "NotADirectoryError") {
        return { content: "", size: 0 };
      }
      throw new Error(reply.error + (reply.detail ? `: ${reply.detail}` : ""));
    }
    return reply.data;
  }
  if (reply.type === "pong") {
    return reply;
  }
  // 兜底：原样返回
  return reply;
}

// --------------------------------------------------------------------------- //
// 浏览器自动化（不经 host）
// --------------------------------------------------------------------------- //
async function handleBrowse(msg) {
  const p = msg.params || {};
  const op = p.op;

  if (op === "open") {
    const tab = await chrome.tabs.create({ url: p.url, active: p.active !== false });
    return { op: "open", tabId: tab.id, url: tab.url || p.url };
  }
  if (op === "screenshot") {
    // 截当前激活标签页；需要 host_permissions 覆盖
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("没有激活的标签页");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: p.format === "png" ? "png" : "jpeg",
      quality: p.quality ?? 80,
    });
    return { op: "screenshot", tabId: tab.id, dataUrl };
  }
  throw new Error(`unknown browse op: ${op}`);
}

// --------------------------------------------------------------------------- //
// 速率限制（安全闸）：单 sender 1 秒内最多 5 条
// --------------------------------------------------------------------------- //
const _buckets = new Map(); // senderId -> [{t}]
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 10;

function rateLimitCheck(sender) {
  const key = sender?.tab?.id ?? sender?.id ?? "anon";
  const now = Date.now();
  const arr = (_buckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    throw new Error(`速率超限：${RATE_MAX} 次/${RATE_WINDOW_MS}ms，稍后再试`);
  }
  arr.push(now);
  _buckets.set(key, arr);
}

// =========================================================================== //
// 网站适配：动态注入、拾取、配置管理、权限流程
// =========================================================================== //

// adapter.js 依赖的共享脚本（按顺序注入）。picker.js 单独注入（按需）。
const ADAPTER_FILES = [
  "content/config.js",
  "content/logger.js",
  "content/protocol.js",
  "content/ui.js",
  "content/adapter.js",
  "content/floating_taskbar.js",
];
const PICKER_FILES = ["content/picker.js"];

// ----------------------------- 配置存取 ----------------------------- //
async function listAdapters() {
  const st = await chrome.storage.local.get(["adapters"]);
  return st.adapters || {};
}

async function saveAdapter(config) {
  if (!config?.host) throw new Error("config 缺少 host 字段");
  const st = await chrome.storage.local.get(["adapters"]);
  const adapters = st.adapters || {};
  adapters[config.host] = { label: config.label || config.host, ...config };
  await chrome.storage.local.set({ adapters });
  // 配置变更后，尝试给已打开的同域名标签页注入
  await injectAdapterIntoMatchingTabs(config.host);
  return { ok: true, host: config.host };
}

async function deleteAdapter(host) {
  const st = await chrome.storage.local.get(["adapters"]);
  const adapters = st.adapters || {};
  delete adapters[host];
  await chrome.storage.local.set({ adapters });
  return { ok: true, host };
}

// ----------------------------- 当前标签页工具 ----------------------------- //
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("没有激活的标签页");
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    throw new Error("当前页面不支持（系统页/扩展页），请切到一个普通网页");
  }
  return tab;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname || new URL(url).host;
  } catch {
    return null;
  }
}

// ----------------------------- 权限申请 ----------------------------- //
// 申请对某 origin 的访问权限。sidepanel 点拾取/测试时调用，属用户手势上下文。
async function ensureOriginPermission(origin) {
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error("未授权访问该网站，无法注入");
  return true;
}

// ----------------------------- 注入 adapter ----------------------------- //
async function injectAdapterIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ADAPTER_FILES,
    });
    return true;
  } catch (e) {
    console.warn(`[bg] 注入 adapter 到 tab ${tabId} 失败:`, e.message);
    return false;
  }
}

async function injectAdapterIntoMatchingTabs(host) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && hostFromUrl(tab.url) === host) {
      await injectAdapterIntoTab(tab.id);
    }
  }
}

async function reloadAdapter() {
  const tab = await getActiveTab();
  const ok = await injectAdapterIntoTab(tab.id);
  return { ok, tabId: tab.id, url: tab.url };
}

// ----------------------------- 拾取 ----------------------------- //
async function startPicker() {
  const tab = await getActiveTab();
  const origin = new URL(tab.url).origin + "/";
  await ensureOriginPermission(origin);
  // 先注入共享脚本（picker 可能需要 config.js），再注入 picker
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/config.js", ...PICKER_FILES],
    });
  } catch (e) {
    throw new Error(`注入拾取工具失败: ${e.message}`);
  }
  return { ok: true, tabId: tab.id, url: tab.url };
}

// picker.js 回传结果：{ type:"picker-result", result:{host,input,send,output} }
// 在主 onMessage 监听器里处理（见下方）。

// ----------------------------- 测试选择器 ----------------------------- //
async function testSelector(selector) {
  const tab = await getActiveTab();
  const origin = new URL(tab.url).origin + "/";
  await ensureOriginPermission(origin);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      try {
        return { count: document.querySelectorAll(sel).length, error: null };
      } catch (e) {
        return { count: 0, error: e.message };
      }
    },
    args: [selector],
  });
  return result;
}

// ----------------------------- 代码块格式检测 ----------------------------- //
async function testCodeblocks(selector) {
  const tab = await getActiveTab();
  const origin = new URL(tab.url).origin + "/";
  await ensureOriginPermission(origin);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const out = { totalCodeBlocks: 0, webctlBlocks: 0, formats: [] };
      try {
        const containers = document.querySelectorAll(sel);
        containers.forEach(c => {
          const blocks = c.querySelectorAll("div.md-code-block, div[class*=code-block-element], div[class*=code-block-container], pre code, pre");
          blocks.forEach(b => {
            out.totalCodeBlocks++;
            const text = (b.innerText || "").slice(0, 100);
            if (/\bwebctl\b/i.test(text)) out.webctlBlocks++;
            const f = b.tagName + (b.className ? ":" + b.className.slice(0,30) : "");
            if (out.formats.length < 5 && !out.formats.includes(f)) out.formats.push(f);
          });
        });
      } catch(e) { out.error = e.message; }
      return out;
    },
    args: [selector],
  });
  return result;
}

// ----------------------------- 向导辅助 ----------------------------- //
async function fillInput(selector, text) {
  const tab = await getActiveTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: "未找到元素: " + sel };
        el.focus();
        if ("value" in el) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
          if (setter) setter.call(el, txt); else el.value = txt;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          el.innerText = txt;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return { ok: true, filled: txt.length };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    args: [selector, text],
  });
  return result;
}

async function detectOutput() {
  const tab = await getActiveTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const candidates = Array.from(document.querySelectorAll(
        "div[class*=markdown], div[class*=md-box], div[class*=message], div[class*=answer], div[class*=content], div[class*=prose]"
      )).filter(el => el.offsetWidth > 200);
      if (candidates.length === 0) return { output: "" };
      // 找出现次数最多的语义类名
      const patterns = {};
      candidates.forEach(el => {
        const cls = String(el.className);
        const m = cls.match(/(md-box|markdown|message|answer|content|prose|md-root|ds-markdown)[\w-]*/i);
        if (m) { const k = m[1]; patterns[k] = (patterns[k] || 0) + 1; }
      });
      const best = Object.entries(patterns).sort((a, b) => b[1] - a[1])[0];
      return { output: best ? 'div[class*="' + best[0] + '"]' : "", candidates: candidates.length };
    },
  });
  return result;
}

// ----------------------------- picker 结果接收 ----------------------------- //
// 复用 onMessage（在 handle 里已注册，这里单独处理 picker-result 类型）
// 之所以不放进 handle()，是因为 picker-result 不需要 sendResponse 返回数据。

// ----------------------------- 启动时自动注入 ----------------------------- //
// 扩展加载/浏览器启动时，为所有已配置域名 + 内置默认域名（deepseek.com）
// 的已打开标签页注入 adapter。
async function autoInjectOnStartup() {
  const st = await chrome.storage.local.get(["adapters"]);
  const hosts = new Set(Object.keys(st.adapters || {}));
  hosts.add("chat.deepseek.com"); // 内置默认
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const h = tab.url && hostFromUrl(tab.url);
    if (h && hosts.has(h)) {
      await injectAdapterIntoTab(tab.id);
    }
  }
}

// 监听标签页导航完成：若是已配置域名，注入 adapter
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.url) return;
  const h = hostFromUrl(tab.url);
  if (!h) return;
  const st = await chrome.storage.local.get(["adapters"]);
  const hosts = new Set(Object.keys(st.adapters || {}));
  hosts.add("chat.deepseek.com"); // 内置默认域名也自动注入
  if (hosts.has(h)) {
    await injectAdapterIntoTab(tabId);
  }
});

// picker 结果消息（从 content script 发来，走主 onMessage，但单独处理）
// 这里给主 onMessage 补一个分支：见 handle() 末尾已无法再加，故在顶部 onMessage 里处理。
// 实际上 picker-result 在下面的 onMessage listener 中被识别。

chrome.runtime.onStartup.addListener(autoInjectOnStartup);
// onInstalled 已在顶部注册，这里附加一次启动注入
autoInjectOnStartup();
