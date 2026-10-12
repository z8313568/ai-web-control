/**
 * 全链路日志（content script + sidepanel 共享）。
 *
 * 所有 Agent 操作步骤写入 chrome.storage.local.agentLog，
 * sidepanel 的"日志"标签实时读取展示。
 *
 * 用法：
 *   logger.info("detect", "发现 webctl 块", {id:"t1", action:"shell"})
 *   logger.info("exec",   "发送到 native",   {id:"t1"})
 *   logger.info("result", "收到执行结果",     {exitCode:0})
 *   logger.info("agent",  "回传结果给 AI",    {round:1})
 *   logger.warn("跳过",   "call id 重复",     {id:"t1"})
 *   logger.error("失败",  "native 无响应")
 *
 * 挂到 window.__webctlLogger。
 */

(() => {
  if (window.__webctlLogger) return;

  const MAX_ENTRIES = 200;
  const STORAGE_KEY = "agentLog";
  let buffer = [];
  let flushTimer = null;

  // 批量写入 storage（避免每个事件都单独写）
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      chrome.storage.local.get([STORAGE_KEY], (st) => {
        const existing = st[STORAGE_KEY] || [];
        const merged = [...existing, ...batch].slice(-MAX_ENTRIES);
        chrome.storage.local.set({ [STORAGE_KEY]: merged });
      });
    } catch (_) { /* ignore */ }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 500);
  }

  function log(type, summary, detail) {
    const entry = {
      ts: Date.now(),
      type,
      summary,
      detail: detail || {},
    };
    buffer.push(entry);
    scheduleFlush();
    // 同时打 console，方便 F12 看
    const emoji = { detect: "🔍", exec: "⚡", result: "📤", agent: "🤖", warn: "⚠️", error: "❌" };
    console.log(`${emoji[type] || "·"} [webctl-${type}] ${summary}`, detail);
    return entry;
  }

  function info(type, summary, detail) { return log(type, summary, detail); }
  function warn(type, summary, detail) { return log(type, summary, detail); }
  function error(type, summary, detail) { return log(type, summary, detail); }

  // 清空日志（新对话时调用）
  function clear() {
    buffer = [];
    try {
      chrome.storage.local.remove([STORAGE_KEY]);
    } catch (_) { /* ignore */ }
  }

  window.__webctlLogger = { info, warn, error, clear, flush };
  console.log("[webctl] logger.js 就绪");
})();
