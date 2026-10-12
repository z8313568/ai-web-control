/**
 * 侧边栏逻辑：手动触发命令 + 状态 + 日志。
 *
 * 所有命令通过 chrome.runtime.sendMessage({type:"exec", ...}) 发给 background。
 * 不直接碰 native host。
 */

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------- //
// 标签切换
// --------------------------------------------------------------------------- //
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(`pane-${t.dataset.pane}`).classList.add("active");
    if (t.dataset.pane === "log") renderLog();
  });
});

// --------------------------------------------------------------------------- //
// 总开关
// --------------------------------------------------------------------------- //
const toggleEl = $("enableToggle");
toggleEl.addEventListener("click", async () => {
  const st = await send({ type: "getStatus" });
  const next = !(st.data.enabled);
  await send({ type: "setEnabled", enabled: next });
  refreshStatus();
});

// --------------------------------------------------------------------------- //
// 自动注入提示词开关（存 chrome.storage.local.injectPrompt，content script 读）
// --------------------------------------------------------------------------- //
const injectEl = $("injectToggle");
injectEl.addEventListener("click", async () => {
  const cur = await new Promise((r) => chrome.storage.local.get(["injectPrompt"], r));
  const next = !(cur.injectPrompt === false); // 默认 true，点一下切换
  await new Promise((r) => chrome.storage.local.set({ injectPrompt: next }, r));
  refreshInjectToggle(next);
});

function refreshInjectToggle(on) {
  injectEl.textContent = on ? "自动注入提示词 · 开" : "自动注入提示词 · 关";
  injectEl.classList.toggle("on", on);
  injectEl.classList.toggle("off", !on);
}
// 初始化显示
chrome.storage.local.get(["injectPrompt"], (st) => {
  refreshInjectToggle(st.injectPrompt !== false);
});

async function refreshStatus() {
  try {
    const st = await send({ type: "getStatus" });
    const on = st.data.enabled;
    $("dot").className = "status-dot " + (on ? "on" : "off");
    $("statusText").textContent = on ? "运行中" : "已停用";
    toggleEl.textContent = on ? "已启用 · 点击关闭" : "已关闭 · 点击启用";
    toggleEl.classList.toggle("on", on);
    toggleEl.classList.toggle("off", !on);
  } catch (e) {
    $("dot").className = "status-dot off";
    $("statusText").textContent = "错误: " + e.message;
  }
}
refreshStatus();
setInterval(refreshStatus, 3000);

// --------------------------------------------------------------------------- //
// 发消息工具
// --------------------------------------------------------------------------- //
function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("无响应"));
      if (!res.ok) return reject(new Error(res.error || "未知错误"));
      resolve(res);
    });
  });
}

function showResult(elId, ok, text) {
  const el = $(elId);
  el.className = "result " + (ok ? "ok" : "err");
  el.textContent = text;
}

// 旧 recordLog 保留兼容（sidepanel 手动操作仍然写入日志）
function recordLog(entry) {
  chrome.storage.local.get(["agentLog"], (st) => {
    const log = st.agentLog || [];
    log.push({ ts: Date.now(), type: "exec", summary: entry.summary, detail: {} });
    if (log.length > 200) log.splice(0, log.length - 200);
    chrome.storage.local.set({ agentLog: log });
  });
}

// 从 storage 读取全链路日志（content script 写入的 agent 日志）
async function renderLog() {
  const st = await new Promise((r) => chrome.storage.local.get(["agentLog"], r));
  const log = (st.agentLog || []).slice(-100).reverse();
  const list = $("logList");
  if (log.length === 0) {
    list.innerHTML = '<div class="log-empty">暂无 Agent 活动记录</div>';
    return;
  }
  const emoji = { detect: "\uD83D\uDD0D", exec: "\u26A1", result: "\uD83D\uDCE4", agent: "\uD83E\uDD16", warn: "\u26A0\uFE0F", error: "\u274C" };
  list.innerHTML = log.map((e) => {
    const time = new Date(e.ts).toLocaleTimeString();
    const icon = emoji[e.type] || "\u00B7";
    const detailStr = e.detail && Object.keys(e.detail).length
      ? Object.entries(e.detail).map(([k,v]) => `${k}=${String(v).slice(0,60)}`).join(", ")
      : "";
    const cls = e.type === "error" ? " danger" : (e.type === "warn" ? "" : "");
    const detailHtml = detailStr ? ` <span style="color:var(--muted);font-size:10px">${escapeHtml(detailStr)}</span>` : "";
    return '<div class="log-line' + cls + '"><span class="t">' + time + '</span>' + icon + ' ' + escapeHtml(e.summary) + detailHtml + '</div>';
  }).join("");
}

// 切到日志标签时自动刷新
let logRefreshTimer = null;
document.querySelectorAll(".tab").forEach((t) => {
  if (t.dataset.pane === "log") {
    t.addEventListener("click", () => {
      renderLog();
      clearInterval(logRefreshTimer);
      logRefreshTimer = setInterval(renderLog, 2000);
    });
    if (t.classList.contains("active")) { renderLog(); logRefreshTimer = setInterval(renderLog, 2000); }
  }
});

// 清空日志按钮
$("btnClearLog").addEventListener("click", async () => {
  await new Promise((r) => chrome.storage.local.remove(["agentLog"], r));
  renderLog();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// --------------------------------------------------------------------------- //
// 手动执行
// --------------------------------------------------------------------------- //
$("btnExec").addEventListener("click", async () => {
  const raw = $("manualJson").value.trim();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    showResult("manualResult", false, "JSON 解析失败: " + e.message);
    return;
  }
  await runAndShow("manualResult", payload, { action: payload.action, summary: `手动: ${payload.action}` });
});

// --------------------------------------------------------------------------- //
// Shell
// --------------------------------------------------------------------------- //
$("btnShell").addEventListener("click", async () => {
  const cmd = $("shellCmd").value.trim();
  if (!cmd) return;
  $("shellCmd").value = "";
  await runAndShow("shellResult",
    { action: "shell", cmd },
    { action: "shell", summary: `$ ${cmd}`, cmd });
});

$("btnShellPing").addEventListener("click", async () => {
  try {
    const res = await send({ type: "ping-native" });
    showResult("shellResult", true, "Host 在线: " + JSON.stringify(res.data));
  } catch (e) {
    showResult("shellResult", false, e.message);
  }
});

// 诊断：一键检查 offscreen / 权限 / native 全链路状态
$("btnDiag").addEventListener("click", async () => {
  const el = $("shellResult");
  el.className = "result";
  el.textContent = "诊断中…";
  const lines = [];
  const push = (k, v, ok = true) => lines.push(`${ok ? "✓" : "✗"} ${k}: ${v}`);

  // 1. 扩展基本信息
  push("扩展 ID", chrome.runtime.id);
  push("Chrome 版本", navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || "未知");

  // 2. 权限检查（<all_urls> 是 origin，不是 permission）
  try {
    const allUrls = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    push("optional <all_urls> 已授予", allUrls ? "是" : "否（拾取内网站点时会弹框申请）");
  } catch (e) { push("权限检查", e.message, false); }

  // 3. 总开关
  try {
    const st = await send({ type: "getStatus" });
    push("总开关", st.data.enabled ? "开" : "关", st.data.enabled);
  } catch (e) { push("状态查询", e.message, false); }

  // 4. native host 连通性（核心诊断：直接 ping host）
  try {
    const res = await send({ type: "ping-native" });
    const d = res.data || {};
    if (d.type === "pong") {
      push("native host", `在线 ✓ (host 已响应 ping)`, true);
    } else if (d.type === "ready") {
      push("native host", `在线 ✓ (收到 ready，host 运行中)`, true);
    } else if (d.error) {
      push("native host", `错误: ${d.error}`, false);
    } else {
      push("native host", `响应: ${JSON.stringify(d).slice(0, 80)}`, true);
    }
  } catch (e) {
    push("native host", `连不上 — ${e.message}`, false);
    push("排查", "若提示 'native messaging host 未找到'：检查 host 是否已装、扩展 ID 是否匹配 manifest 的 allowed_origins", false);
  }

  el.className = "result ok";
  el.textContent = lines.join("\n");
});

// --------------------------------------------------------------------------- //
// 文件
// --------------------------------------------------------------------------- //
$("btnRead").addEventListener("click", async () => {
  const path = $("filePath").value.trim();
  if (!path) return;
  await runAndShow("fileResult",
    { action: "file_read", path },
    { action: "file_read", summary: `read ${path}` });
});

$("btnList").addEventListener("click", async () => {
  const path = $("filePath").value.trim() || ".";
  await runAndShow("fileResult",
    { action: "file_list", path },
    { action: "file_list", summary: `list ${path}` });
});

$("btnWrite").addEventListener("click", async () => {
  const path = $("filePath").value.trim();
  const content = $("fileWrite").value;
  if (!path) return;
  await runAndShow("fileResult",
    { action: "file_write", path, content, append: true },
    { action: "file_write", summary: `write ${content.length} bytes → ${path}` });
});

// --------------------------------------------------------------------------- //
// 通用执行 + 渲染
// --------------------------------------------------------------------------- //
async function runAndShow(resultElId, payload, logEntry) {
  const orig = $(resultElId).innerHTML;
  $(resultElId).className = "result";
  $(resultElId).textContent = "执行中…";
  console.log("[panel] exec:", JSON.stringify(payload));
  try {
    const res = await send({
      type: "exec",
      id: `sidepanel-${Date.now()}`,
      action: payload.action,
      params: strip(payload, ["action"]),
    });
    console.log("[panel] raw res:", JSON.stringify(res));
    const data = res.data;
    console.log("[panel] data:", JSON.stringify(data));
    const dangerous = data?.dangerous;
    recordLog({ ...logEntry, dangerous });
    showResult(resultElId, true, formatResult(payload.action, data));
  } catch (e) {
    console.error("[panel] exec error:", e);
    recordLog({ ...logEntry, summary: `[失败] ${logEntry.summary} — ${e.message}` });
    showResult(resultElId, false, e.message);
  }
}

function strip(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) if (!keys.includes(k)) out[k] = obj[k];
  return out;
}

function formatResult(action, data) {
  if (action === "shell") {
    let s = `[退出码 ${data.returncode}]`;
    if (data.dangerous) s += `  ⚠ 命中危险模式: ${data.danger_match}`;
    if (data.stdout) s += `\n--- stdout ---\n${data.stdout}`;
    if (data.stderr) s += `\n--- stderr ---\n${data.stderr}`;
    return s;
  }
  if (action === "file_read") {
    return `[${data.size} 字节${data.truncated ? "，已截断" : ""}]\n${data.content}`;
  }
  if (action === "file_list") {
    return data.entries.map((e) =>
      `${e.is_dir ? "📁" : "  "} ${e.name}${e.is_dir ? "/" : ""}`).join("\n");
  }
  if (action === "file_write") {
    return `已写入 ${data.bytes} 字节 → ${data.path}`;
  }
  return JSON.stringify(data, null, 2);
}

// 回车快捷执行
$("shellCmd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btnShell").click();
});

// --------------------------------------------------------------------------- //
// 任务面板：读取 .memory/tasks.md 并可视化
// --------------------------------------------------------------------------- //
async function refreshTasks() {
  const panel = $("taskPanel");
  panel.innerHTML = '<div class="log-empty">加载中…</div>';
  try {
    // 获取当前激活标签页的 URL，提取会话 ID
    const [tab] = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const url = tab?.url || "";
    const m = url.match(/\/s\/([a-f0-9-]+)/i);
    const sessionId = m ? m[1] : "global";
    const path = `~/ai-workspace/.memory/sessions/${sessionId}/tasks.md`;
    const res = await send({
      type: "exec", id: `task-${Date.now()}`, action: "file_read",
      params: { path },
    });
    const content = res.data?.content || "";
    panel.innerHTML = renderTaskPanel(content);
  } catch (e) {
    if (/not found|no such|FileNotFound/i.test(e.message)) {
      panel.innerHTML = '<div class="log-empty">新会话，暂无任务</div>';
    } else {
      panel.innerHTML = `<div class="log-empty">加载失败: ${escapeHtml(e.message)}</div>`;
    }
  }
}

function renderTaskPanel(md) {
  const lines = md.split("\n");
  const sections = { active: [], todo: [], done: [] };
  let currentSection = "active";
  for (const line of lines) {
    const t = line.trim();
    if (/^##?\s*.*(Active|进行中|Doing)/i.test(t)) { currentSection = "active"; continue; }
    if (/^##?\s*.*(Done|已完成|Completed)/i.test(t)) { currentSection = "done"; continue; }
    if (/^##?\s*.*(Todo|待办|Backlog|计划)/i.test(t)) { currentSection = "todo"; continue; }
    if (/^##/.test(t)) { currentSection = "active"; continue; }
    const m = t.match(/^-\s*\[([ xX])\]\s*(.+)/);
    if (m) {
      const done = m[1] !== " ";
      const taskText = escapeHtml(m[2].replace(/[*_]{1,2}/g, "").slice(0, 80));
      const target = done ? "done" : currentSection;
      sections[target].push({ done, text: taskText });
    }
  }

  let html = "";
  // 进行中
  html += '<div style="margin-bottom:10px;"><span style="color:#e0af68; font-weight:600;">🔄 进行中</span></div>';
  html += sections.active.length === 0
    ? '<div class="log-empty" style="margin-bottom:8px;">无</div>'
    : sections.active.map(t => '<div style="padding:6px 8px;background:var(--panel);border-radius:4px;margin-bottom:4px;font-size:12px;"><span style="display:inline-block;width:6px;height:14px;background:#e0af68;border-radius:2px;margin-right:6px;animation:pulse 1.5s infinite"></span>' + t.text + '</div>').join("");
  // 待办
  html += '<div style="margin-top:12px;margin-bottom:10px;"><span style="color:#7aa2f7; font-weight:600;">📝 待办</span></div>';
  html += sections.todo.length === 0
    ? '<div class="log-empty" style="margin-bottom:8px;">无</div>'
    : sections.todo.map(t => '<div style="padding:4px 8px;font-size:11px;border-bottom:1px solid var(--border);color:var(--muted);">☐ ' + t.text + '</div>').join("");
  // 已完成
  html += '<div style="margin-top:12px;margin-bottom:10px;"><span style="color:#9ece6a; font-weight:600;">✅ 已完成</span></div>';
  html += sections.done.length === 0
    ? '<div class="log-empty">无</div>'
    : sections.done.map(t => '<div style="padding:4px 8px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border);">✓ ' + t.text + '</div>').join("");
  html += '<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}</style>';
  return html;
}

$("btnRefreshTasks").addEventListener("click", refreshTasks);

// 切到任务标签自动刷新
document.querySelectorAll(".tab").forEach((t) => {
  if (t.dataset.pane === "tasks") {
    t.addEventListener("click", () => refreshTasks());
  }
});
// --------------------------------------------------------------------------- //
const DEFAULT_WS = "~/ai-workspace";

async function refreshWorkspace() {
  const st = await new Promise((r) => chrome.storage.local.get(["workspacePath"], r));
  const ws = st.workspacePath || DEFAULT_WS;
  $("wsPath").textContent = ws;
}
refreshWorkspace();

$("btnWsEdit").addEventListener("click", async () => {
  const cur = $("wsPath").textContent;
  const p = prompt("输入工作空间路径（~ 表示家目录）：", cur);
  if (p && p.trim()) {
    await new Promise((r) => chrome.storage.local.set({ workspacePath: p.trim() }, r));
    $("wsPath").textContent = p.trim();
    showResult("shellResult", true, "工作空间已设为: " + p.trim() + "\n刷新 DeepSeek 页面后新对话生效。");
  }
});

$("btnWsCreate").addEventListener("click", async () => {
  await runAndShow("shellResult",
    { action: "shell", cmd: `mkdir -p ${$("wsPath").textContent}` },
    { action: "shell", summary: "创建工作空间目录" });
});

$("btnWsList").addEventListener("click", async () => {
  await runAndShow("shellResult",
    { action: "file_list", path: $("wsPath").textContent },
    { action: "file_list", summary: "列出工作空间" });
});

// --------------------------------------------------------------------------- //
// 网站配置面板
// --------------------------------------------------------------------------- //

// 切到「网站配置」标签时刷新列表
document.querySelectorAll(".tab").forEach((t) => {
  if (t.dataset.pane === "sites") {
    t.addEventListener("click", () => refreshSiteList());
  }
});

// 在当前页面拾取
$("btnPick").addEventListener("click", async () => {
  try {
    // 权限必须在用户手势中申请，先在 sidepanel 里请求
    const [tab] = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tab?.url) throw new Error("无法获取当前页面");
    const origin = new URL(tab.url).origin + "/*";
    const has = await new Promise((r) => chrome.permissions.contains({ origins: [origin] }, r));
    if (!has) {
      const granted = await new Promise((r) => chrome.permissions.request({ origins: [origin] }, r));
      if (!granted) throw new Error("未授权访问该网站");
    }
    // 权限已获取，发消息给 background 注入 picker
    const res = await send({ type: "pick-element" });
    $("adapterResult").textContent = "拾取模式已启动，请切到网页操作（悬停高亮 → 点按钮归类 → 完成）";
    $("adapterResult").className = "result ok";
  } catch (e) {
    $("adapterResult").textContent = `拾取失败: ${e.message}`;
    $("adapterResult").className = "result err";
  }
});

// 重载当前页适配器（拾取保存后，让 adapter 重新读配置）
$("btnReloadAdapter").addEventListener("click", async () => {
  try {
    const res = await send({ type: "reload-adapter" });
    $("adapterResult").textContent = `已重新注入适配器: ${JSON.stringify(res.data)}`;
    $("adapterResult").className = "result ok";
  } catch (e) {
    $("adapterResult").textContent = `失败: ${e.message}`;
    $("adapterResult").className = "result err";
  }
});

// 测试选择器
$("btnTestSel").addEventListener("click", async () => {
  const sel = $("testSel").value.trim();
  if (!sel) return;
  try {
    const res = await send({ type: "test-selector", selector: sel });
    const n = res.data.count;
    $("testSelResult").textContent = `匹配到 ${n} 个元素${n > 0 ? " ✓" : "（无匹配）"}`;
    $("testSelResult").className = "result " + (n > 0 ? "ok" : "err");
  } catch (e) {
    $("testSelResult").textContent = `失败: ${e.message}`;
    $("testSelResult").className = "result err";
  }
});

// 手动保存配置
$("btnSaveAdapter").addEventListener("click", async () => {
  const raw = $("manualAdapter").value.trim();
  if (!raw) return;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    $("adapterResult").textContent = "JSON 解析失败: " + e.message;
    $("adapterResult").className = "result err";
    return;
  }
  if (!cfg.host) {
    $("adapterResult").textContent = "缺少 host 字段";
    $("adapterResult").className = "result err";
    return;
  }
  try {
    await send({ type: "save-adapter", config: cfg });
    $("adapterResult").textContent = `已保存: ${cfg.host}`;
    $("adapterResult").className = "result ok";
    $("manualAdapter").value = "";
    refreshSiteList();
  } catch (e) {
    $("adapterResult").textContent = `保存失败: ${e.message}`;
    $("adapterResult").className = "result err";
  }
});

async function refreshSiteList() {
  try {
    const res = await send({ type: "list-adapters" });
    renderSiteList(res.data || {});
  } catch (e) {
    $("siteList").innerHTML = `<div class="log-empty">加载失败: ${e.message}</div>`;
  }
}

function renderSiteList(adapters) {
  const list = $("siteList");
  const hosts = Object.keys(adapters);
  if (hosts.length === 0) {
    list.innerHTML = '<div class="log-empty">暂无配置。点上方「拾取」添加网站。</div>';
    return;
  }
  list.innerHTML = hosts.map((h) => {
    const a = adapters[h];
    const esc = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    return `
      <div style="padding:8px; background:var(--panel); border-radius:4px; margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>${esc(a.label || h)}</strong>
          <button class="ghost" data-del="${esc(h)}" style="font-size:11px; padding:3px 8px;">删除</button>
        </div>
        <div style="font-size:11px; color:var(--muted); margin-top:4px;">${esc(h)}</div>
        <div style="font-size:11px; margin-top:4px; font-family:ui-monospace,Menlo,monospace;">
          <div>输入框: <span style="color:#9ece6a">${esc(a.input || "—")}</span></div>
          <div>发送: <span style="color:#9ece6a">${esc(a.send || "—")}</span></div>
          <div>输出: <span style="color:#9ece6a">${esc(a.output || "—")}</span></div>
        </div>
      </div>`;
  }).join("");

  // 绑定删除按钮
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const host = btn.getAttribute("data-del");
      await send({ type: "delete-adapter", host });
      refreshSiteList();
    });
  });
}

// --------------------------------------------------------------------------- //
// 待安装面板
// --------------------------------------------------------------------------- //
async function refreshInstalls() {
  const st = await new Promise((r) => chrome.storage.local.get(["pendingInstalls"], r));
  const list = (st.pendingInstalls || []).reverse();
  const panel = $("installList");
  if (!panel) return;
  if (list.length === 0) {
    panel.innerHTML = '<div class="log-empty">暂无待安装</div>';
    return;
  }
  panel.innerHTML = list.map((e) => {
    var si = e.status === "pending" ? '<span style="color:#e0af68">待处理</span>' : '<span style="color:#9ece6a">已安装</span>';
    return '<div style="padding:8px;background:var(--panel);border-radius:4px;margin-bottom:6px;">'
      + '<div style="display:flex;justify-content:space-between;">'
      + '<strong style="color:#e0af68">' + escapeHtml(e.pkg) + '</strong>'
      + '<div>' + si + ' <button data-done="' + escapeHtml(e.pkg) + '" class="ghost" style="font-size:10px;padding:2px 6px;">已安装</button></div></div>'
      + '<div style="font-family:monospace;font-size:10px;color:var(--muted);margin-top:2px;">' + escapeHtml(e.cmd) + '</div>'
      + '<div style="font-size:9px;color:var(--muted);">' + e.time + '</div></div>';
  }).join("");
  panel.querySelectorAll("[data-done]").forEach(function(btn) {
    btn.addEventListener("click", async function() {
      var pkg = btn.getAttribute("data-done");
      var updated = list.map(function(e) { return e.pkg === pkg ? Object.assign({}, e, {status: "done"}) : e; });
      await new Promise(function(r) { chrome.storage.local.set({ pendingInstalls: updated.reverse() }, r); });
      refreshInstalls();
    });
  });
}
$("btnRefreshInstalls")?.addEventListener("click", refreshInstalls);
document.querySelectorAll(".tab").forEach(function(t) {
  if (t.dataset.pane === "installs") t.addEventListener("click", refreshInstalls);
});

// --------------------------------------------------------------------------- //
// 配置向导：分步引导用户完成新网站适配
// --------------------------------------------------------------------------- //
const wizard = { step: 0, host: "", collected: {} };

function setWizStep(n) {
  wizard.step = n;
  const steps = $("wizSteps").querySelectorAll("span");
  steps.forEach((s, i) => {
    if (i % 2 === 0) { // step labels (even indices)
      const sn = Math.floor(i / 2) + 1;
      if (sn === n) s.style.cssText = "padding:2px 8px;border-radius:10px;font-size:11px;background:#7aa2f7;color:#111;";
      else if (sn < n) s.style.cssText = "padding:2px 8px;border-radius:10px;font-size:11px;background:#9ece6a;color:#111;";
      else s.style.cssText = "padding:2px 8px;border-radius:10px;font-size:11px;background:var(--panel);color:var(--muted);";
    }
  });
}

function renderWizContent() {
  const c = $("wizContent");
  const s = wizard.step;
  if (s === 0) {
    c.innerHTML = '<div class="hint">打开你要适配的 AI 网站（如豆包、通义千问等），然后点下方按钮开始。</div>'
      + '<button id="btnWizStart2" style="width:100%;margin-top:6px;">🚀 开始配置</button>';
    setTimeout(() => { const b = document.getElementById("btnWizStart2"); if (b) b.onclick = startWizard; }, 100);
    return;
  }
  if (s === 1) {
    c.innerHTML = '<div style="font-weight:600;color:#e0af68;margin-bottom:6px;">📝 第1步：找到输入框</div>'
      + '<div class="hint">切到目标网页 → 点下方按钮启动拾取 → 悬停输入框点击锁定</div>'
      + '<button id="btnWizPick1" style="width:100%;margin-top:6px;">🔍 拾取输入框</button>'
      + '<div id="wiz1Sel" style="font-family:monospace;font-size:10px;color:var(--muted);margin-top:4px;">未选择</div>'
      + '<div class="hint" style="margin-top:6px;">选择后会<b>自动填入测试文字</b>，请你去网页上点发送</div>'
      + '<button id="btnWizFill1" class="secondary" style="width:100%;margin-top:6px;" disabled>📝 填入测试文字："你好，请回复：测试成功"</button>'
      + '<button id="btnWizCheck1" class="secondary" style="width:100%;margin-top:6px;" disabled>🔍 检测：AI 是否已回复？</button>'
      + '<div id="wiz1Result" style="margin-top:4px;"></div>'
      + '<button id="btnWizNext1" style="width:100%;margin-top:8px;" disabled>下一步 →</button>';
    setTimeout(bindWiz1, 100); return;
  }
  if (s === 2) {
    c.innerHTML = '<div style="font-weight:600;color:#e0af68;margin-bottom:6px;">📝 第2步：确认输出区域</div>'
      + '<div class="hint">上一步 AI 回复后，输出区应自动检测到。如需调整可重新拾取。</div>'
      + '<button id="btnWizPick2" class="secondary" style="width:100%;margin-top:6px;">🔍 重新拾取输出区</button>'
      + '<div id="wiz2Sel" style="font-family:monospace;font-size:10px;color:var(--muted);margin-top:4px;">' + (wizard.collected.output || "使用自动探测") + '</div>'
      + '<button id="btnWizCheck2" style="width:100%;margin-top:6px;">🔍 检测输出区</button>'
      + '<div id="wiz2Result" style="margin-top:4px;"></div>'
      + '<button id="btnWizNext2" style="width:100%;margin-top:8px;" disabled>下一步 →</button>';
    setTimeout(bindWiz2, 100); return;
  }
  if (s === 3) {
    c.innerHTML = '<div style="font-weight:600;color:#e0af68;margin-bottom:6px;">📝 第3步：代码块格式</div>'
      + '<div class="hint">让 AI 输出 webctl 格式代码块来验证代码块渲染是否兼容。</div>'
      + '<button id="btnWizFill3" style="width:100%;margin-top:6px;">📝 填入测试消息（让AI输出webctl）</button>'
      + '<div class="hint" style="margin-top:4px;">填入后请去网页点发送，等 AI 回复后回来点检测。</div>'
      + '<button id="btnWizCheck3" style="width:100%;margin-top:6px;">🔍 检测 webctl 代码块</button>'
      + '<div id="wiz3Result" style="margin-top:4px;"></div>'
      + '<button id="btnWizSave" style="width:100%;margin-top:8px;" disabled>💾 保存配置并完成</button>';
    setTimeout(bindWiz3, 100); return;
  }
}

async function startWizard() {
  const tabs = await new Promise(r => chrome.tabs.query({ currentWindow: true }, r));
  const target = tabs.find(t => t.active && !t.url?.startsWith("chrome"));
  if (!target?.url) { alert("请先切换到目标AI网站的标签页"); return; }
  wizard.host = new URL(target.url).hostname;
  wizard.collected = {};
  $("wizHint").textContent = "目标网站: " + wizard.host;
  setWizStep(1); renderWizContent();
}

function bindWiz1() {
  document.getElementById("btnWizPick1").onclick = async () => {
    await ensureWizPermission();
    await send({ type: "pick-element" });
    $("wizInputResult").textContent = "请在网页上点击输入框，然后回来点「下一步」";
    // Poll for picker result
    pollPickerResult("input");
  };
  document.getElementById("btnWizTest1").onclick = async () => {
    const sel = wizard.collected.input;
    if (!sel) return;
    const res = await send({ type: "test-selector", selector: sel });
    $("wizInputTest").textContent = "匹配 " + res.data.count + " 个元素" + (res.data.count === 1 ? " ✓" : res.data.count > 1 ? " (多个)" : " ✗");
    if (res.data.count >= 1) document.getElementById("btnWizNext1").disabled = false;
  };
  document.getElementById("btnWizNext1").onclick = () => { setWizStep(2); renderWizContent(); };
}

function bindWiz2() {
  document.getElementById("btnWizPickOutput").onclick = async () => {
    await ensureWizPermission();
    await send({ type: "pick-element" });
    $("wizOutputResult").textContent = "请在网页上点击 AI 回复区域，然后回来";
    pollPickerResult("output");
  };
  document.getElementById("btnWizTestOutput").onclick = async () => {
    const sel = wizard.collected.output;
    if (!sel) return;
    const res = await send({ type: "test-selector", selector: sel });
    $("wizOutputTest").textContent = "匹配 " + res.data.count + " 个元素" + (res.data.count >= 1 ? " ✓" : " ✗");
    if (res.data.count >= 1) document.getElementById("btnWizNext2").disabled = false;
  };
  document.getElementById("btnWizNext2").onclick = () => { setWizStep(3); renderWizContent(); };
}

function bindWiz3() {
  document.getElementById("btnWizTestLive").onclick = async () => {
    const sel = wizard.collected.output;
    if (!sel) { $("wizLiveResult").innerHTML = '<div class="result err">请先完成第2步</div>'; return; }
    const res = await send({ type: "test-selector", selector: sel });
    const ok = res.data.count >= 1;
    let html = '<div class="result ' + (ok ? "ok" : "err") + '">';
    html += ok ? '✅ 输出区域: 找到 ' + res.data.count + ' 个元素。' : '❌ 未找到输出区域。';
    html += '</div>';

    // 代码块格式检测：在输出区里找各种代码块容器
    try {
      const cbRes = await send({ type: "test-codeblocks", selector: sel });
      const cbData = cbRes.data || {};
      const hasCB = cbData.totalCodeBlocks > 0;
      const hasWebctl = cbData.webctlBlocks > 0;
      html += '<div class="result ' + (hasCB ? "ok" : "") + '" style="margin-top:6px;">';
      if (hasWebctl) {
        html += '✅ 代码块: 检测到 ' + cbData.webctlBlocks + ' 个 webctl 块，格式兼容！';
      } else if (hasCB) {
        html += '⚠️ 代码块: 找到 ' + cbData.totalCodeBlocks + ' 个代码块，但未检测到 webctl 标签。<br>请先在网页上发消息给AI让它输出 webctl 格式的回复。';
      } else {
        html += '⚠️ 代码块: 未找到代码块。请先在网页上让AI回复一段含代码的消息来验证。';
      }
      html += '</div>';
    } catch (e) {
      html += '<div class="result" style="margin-top:6px;">代码块检测跳过: ' + escapeHtml(e.message) + '</div>';
    }

    $("wizLiveResult").innerHTML = html;
    if (ok) document.getElementById("btnWizSave").disabled = false;
  };
  document.getElementById("btnWizSave").onclick = async () => {
    await send({ type: "save-adapter", config: { host: wizard.host, label: wizard.host, ...wizard.collected, injectPrompt: true } });
    $("wizContent").innerHTML = '<div style="color:#9ece6a;font-weight:600;padding:10px;">🎉 配置完成！<br><br>刷新目标网页即可使用。右侧菜单「网站配置」可查看/修改。<br><br>提示词需要AI用 webctl 格式回复，首次对话会自动注入。</div>';
    setWizStep(4);
  };
}

async function ensureWizPermission() {
  // 权限由 background 的 startPicker 处理，此处只需确保有激活的普通标签页
  const tabs = await new Promise(r => chrome.tabs.query({ currentWindow: true }, r));
  const target = tabs.find(t => t.active && !t.url?.startsWith("chrome"));
  if (!target) throw new Error("请先切换到目标AI网站的标签页");
  return target;
}

function pollPickerResult(kind, callback) {
  const handler = (msg) => {
    if (msg?.type !== "picker-result") return;
    const sel = msg.result?.input || msg.result?.output || msg.result?.send;
    if (!sel) return;
    if (kind === "input" && msg.result.input) {
      wizard.collected.input = msg.result.input;
      if (callback) callback(msg.result.input);
    }
    if (kind === "output" && msg.result.output) {
      wizard.collected.output = msg.result.output;
      if (callback) callback(msg.result.output);
    }
  };
  chrome.runtime.onMessage.addListener(handler);
  setTimeout(() => chrome.runtime.onMessage.removeListener(handler), 30000);
}

$("btnWizStart").onclick = startWizard;
document.querySelectorAll(".tab").forEach(t => {
  if (t.dataset.pane === "wizard") t.addEventListener("click", () => { if (wizard.step === 0) renderWizContent(); });
});
