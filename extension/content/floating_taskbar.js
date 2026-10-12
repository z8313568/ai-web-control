/**
 * 浮动任务栏——注入到页面左上角，可拖动、可折叠。
 * 显示 tasks.md 摘要（进行中/待办/已完成）。
 * 初始 3s 后加载，之后每 30s 自动刷新。
 */
(() => {
  if (document.getElementById("__webctl_taskbar")) return;

  const bar = document.createElement("div");
  bar.id = "__webctl_taskbar";
  bar.innerHTML = '<style>'
    + '#__webctl_taskbar{position:fixed;left:12px;top:60px;z-index:2147483646;background:#1e1e2e;color:#e4e4ef;border:1px solid #3b3b52;border-radius:8px;font:12px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:200px;max-width:320px;overflow:hidden}'
    + '.__wh{padding:6px 10px;background:#2a2a3c;cursor:move;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #3b3b52;font-weight:600;color:#7aa2f7}'
    + '.__wh button{background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 4px}'
    + '.__wb{padding:8px 10px;display:none;color:#e4e4ef}'
    + '.__wb.open{display:block}'
    + '.__ws{display:flex;gap:8px;padding:6px 10px;font-size:11px;color:#e4e4ef}'
    + '.__wl{padding:3px 0;font-size:11px;border-bottom:1px solid #2a2a3c;color:#e4e4ef}'
    + '</style>'
    + '<div class="__wh" id="__wh"><span>📋 任务面板</span><div><button id="__wt">−</button><button id="__wr">↻</button></div></div>'
    + '<div class="__ws" id="__ws">加载中…</div>'
    + '<div class="__wb open" id="__wb">加载中…</div>';
  document.body.appendChild(bar);

  const head = bar.querySelector("#__wh"), toggle = bar.querySelector("#__wt"),
        refresh = bar.querySelector("#__wr"), body = bar.querySelector("#__wb"),
        summary = bar.querySelector("#__ws");
  let collapsed = false;
  toggle.onclick = (e) => { e.stopPropagation(); collapsed = !collapsed; body.classList.toggle("open", !collapsed); toggle.textContent = collapsed ? "+" : "−"; };

  // 拖动
  let d = false, ox = 0, oy = 0;
  head.onmousedown = (e) => { if (e.target.tagName === "BUTTON") return; d = true; ox = e.clientX - bar.offsetLeft; oy = e.clientY - bar.offsetTop; bar.style.transition = "none"; };
  document.addEventListener("mousemove", (e) => { if (!d) return; bar.style.left = (e.clientX - ox) + "px"; bar.style.top = (e.clientY - oy) + "px"; });
  document.addEventListener("mouseup", () => { d = false; });

  let retryTimer = null;

  // 从 URL 提取会话 ID（DeepSeek 格式: /a/chat/s/{id}）
  function getSessionId() {
    const m = location.pathname.match(/\/s\/([a-f0-9-]+)/i);
    return m ? m[1] : location.hostname + location.pathname.replace(/\//g, "_");
  }

  function getSessionTasksPath() {
    return "~/ai-workspace/.memory/sessions/" + getSessionId() + "/tasks.md";
  }
  async function load() {
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "exec", id: "tb-" + Date.now(), action: "file_read", params: { path: getSessionTasksPath() } },
          (r) => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else if (!r?.ok) reject(new Error(r?.error || "失败")); else resolve(r); });
      });
      const md = res.data?.content || "";
      let active = 0, todo = 0, done = 0, ai = [], ti = [], di = [], sec = "active";
      for (const ln of md.split("\n")) {
        const t = ln.trim();
        if (/进行中|Active|Doing/i.test(t) && /^##?/.test(t)) { sec = "active"; continue; }
        if (/已完成|Done|Completed/i.test(t) && /^##?/.test(t)) { sec = "done"; continue; }
        if (/待办|Todo|Backlog/i.test(t) && /^##?/.test(t)) { sec = "todo"; continue; }
        const m = t.match(/^-\s*\[([ xX])\]\s*(.+)/);
        if (!m) continue;
        const isD = m[1] !== " ", text = m[2].replace(/[*_]{1,2}/g, "").slice(0, 60);
        if (isD) { done++; di.push(text); }
        else if (sec === "todo") { todo++; ti.push(text); }
        else { active++; ai.push(text); }
      }
      summary.innerHTML = '<b style="color:#e0af68">🔄' + active + '</b> &nbsp; <b style="color:#7aa2f7">📝' + todo + '</b> &nbsp; <b style="color:#9ece6a">✅' + done + '</b>';
      let h = "";
      if (active) { h += '<div style="color:#e0af68;font-weight:600">🔄 进行中</div>' + ai.map(t => '<div class="__wl">▌' + t + '</div>').join(""); }
      if (todo) { h += '<div style="color:#7aa2f7;font-weight:600;margin-top:6px">📝 待办</div>' + ti.map(t => '<div class="__wl" style="color:#888">☐ ' + t + '</div>').join(""); }
      if (done) { h += '<div style="color:#9ece6a;font-weight:600;margin-top:6px">✅ 已完成</div>' + di.map(t => '<div class="__wl" style="color:#888">✓ ' + t + '</div>').join(""); }
      body.innerHTML = h || '<div style="color:#888">暂无任务</div>';
    } catch (e) {
      // 文件不存在 = 新会话，正常
      if (/not found|no such file|FileNotFound/i.test(e.message)) {
        summary.innerHTML = '<b style="color:#e0af68">🔄0</b> &nbsp; <b style="color:#7aa2f7">📝0</b> &nbsp; <b style="color:#9ece6a">✅0</b>';
        body.innerHTML = '<div style="color:#888">新会话，暂无任务</div>';
        return;
      }
      console.warn("[taskbar]", e.message);
      summary.innerHTML = '<span style="color:#e0af68">⏳</span>';
      clearTimeout(retryTimer);
      retryTimer = setTimeout(load, 5000);
      return;
    }
  }

  // 立即尝试加载 + 失败 2s 后重试
  load();
  setTimeout(load, 2000);
  setInterval(load, 15000);
  refresh.onclick = (e) => { e.stopPropagation(); load(); };
})();
