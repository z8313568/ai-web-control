/**
 * 元素拾取工具——悬停预览(粉框) → 点击锁定(蓝框) → 点按钮分类。
 * Esc 解锁或退出。
 */
(() => {
  if (window.__webctlPickerActive) return;
  window.__webctlPickerActive = true;
  const HOST = location.hostname;
  const collected = {};

  // ---- 浮条 ----
  const hostEl = document.createElement("div");
  hostEl.id = "__webctl_picker_host";
  hostEl.style.cssText = "all:initial;position:fixed;left:0;top:0;width:100%;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(hostEl);
  const shadow = hostEl.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
    *{all:revert;box-sizing:border-box}
    .bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1e1e2e;color:#e4e4ef;border:1px solid #3b3b52;border-radius:8px;padding:10px 14px;font:13px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.4);min-width:420px;max-width:90vw;pointer-events:auto}
    .t{font-weight:600;margin-bottom:6px;color:#7aa2f7}
    .sel{font-family:ui-monospace,monospace;font-size:11px;color:#9ece6a;word-break:break-all;margin-bottom:6px;background:#2a2a3c;padding:4px 6px;border-radius:4px}
    .sel.locked{color:#7aa2f7;border-left:3px solid #7aa2f7}
    .hint{font-size:11px;color:#888;margin-bottom:6px}
    .btns{display:flex;gap:6px;flex-wrap:wrap}
    button{background:#7aa2f7;color:#111;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600}
    button.gh{background:#2a2a3c;color:#e4e4ef;border:1px solid #3b3b52}
    button.danger{background:#f7768e}
    button:disabled{opacity:.4;cursor:not-allowed}
    .slot{display:flex;align-items:center;gap:4px;font-size:11px}
    .slot .ok{color:#9ece6a}.slot .empty{color:#565666}
    .done{margin-top:6px;color:#9ece6a;font-weight:600}
  </style>
  <div class="bar">
    <div class="t">🟦 拾取 — <span id="host"></span></div>
    <div class="sel" id="curSel">移动鼠标预览，点击元素锁定</div>
    <div class="hint">悬停→粉框预览 | 点击元素→蓝框锁定 | 再点按钮归类 | Esc解锁 | Esc两次退出</div>
    <div class="btns">
      <button id="bInput" disabled>设为输入框</button>
      <button id="bSend" disabled>设为发送按钮</button>
      <button id="bOutput" disabled>设为输出区域</button>
      <button id="bTest" class="gh" disabled>测试此选择器</button>
      <button id="bDone" class="gh">完成保存</button>
      <button id="bCancel" class="danger">取消</button>
    </div>
    <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap">
      <div class="slot">输入框: <span id="sInput" class="empty">未设</span></div>
      <div class="slot">发送: <span id="sSend" class="empty">未设</span></div>
      <div class="slot">输出: <span id="sOutput" class="empty">未设</span></div>
    </div>
    <div class="done" id="doneMsg"></div>
  </div>`;
  const el = (id) => shadow.getElementById(id);
  el("host").textContent = HOST;

  // ---- 状态 ----
  let curTarget = null, curSel = null, locked = false, lockTarget = null, lockSel = null;
  const highlight = document.createElement("div");
  highlight.style.cssText = "position:fixed;border:2px solid #f7768e;background:rgba(247,118,142,.12);pointer-events:none;z-index:2147483646;display:none;";
  document.documentElement.appendChild(highlight);

  function updateSlots() {
    ["input","send","output"].forEach(k => {
      const s = el("s"+k.charAt(0).toUpperCase()+k.slice(1));
      if (collected[k]) { s.textContent = collected[k]; s.className = "ok"; }
      else { s.textContent = "未设"; s.className = "empty"; }
    });
  }
  function showCur(txt, locked) {
    el("curSel").textContent = txt || "移动鼠标预览，点击元素锁定";
    el("curSel").className = "sel" + (locked ? " locked" : "");
  }
  function enableBtns(on) {
    ["bInput","bSend","bOutput","bTest"].forEach(id => el(id).disabled = !on);
  }

  // ---- 选择器生成 ----
  function isStableClass(c) {
    if (!c) return false;
    if (/^[_-]?[a-z0-9]{6,}$/i.test(c)) return false;
    if (/^(css|scss|styled|emotion|mui|chakra)[-:]/i.test(c)) return false;
    if (/^[a-z]+[-_][a-z0-9]+[_-][a-z0-9]{4,}$/i.test(c)) return false;
    return true;
  }
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return "#"+CSS.escape(el.id);
    for (const a of ["data-testid","data-test","data-role"]) { const v = el.getAttribute(a); if (v) return tag+"["+a+"=\""+CSS.escape(v)+"\"]"; }
    const aria = el.getAttribute("aria-label"); if (aria && aria.trim()) return tag+"[aria-label*=\""+CSS.escape(aria.trim())+"\"]";
    const ph = el.getAttribute("placeholder"); if (ph && ph.trim()) return tag+"[placeholder*=\""+CSS.escape(ph.trim().slice(0,12))+"\"]";
    if (el.getAttribute("contenteditable")==="true") return tag+"[contenteditable=true]";
    const cls = (el.className||"").toString().split(/\s+/).filter(Boolean).filter(isStableClass);
    if (cls.length) return tag+"."+cls.slice(0,2).join(".");
    return tag;
  }

  // ---- 高亮 ----
  function updateHighlight() {
    const t = locked ? lockTarget : curTarget;
    if (!t || t === document.documentElement || t === document.body) { highlight.style.display = "none"; return; }
    const r = t.getBoundingClientRect();
    highlight.style.display = "block"; highlight.style.left = r.left+"px"; highlight.style.top = r.top+"px";
    highlight.style.width = r.width+"px"; highlight.style.height = r.height+"px";
    highlight.style.borderColor = locked ? "#7aa2f7" : "#f7768e";
    highlight.style.background = locked ? "rgba(122,162,247,.15)" : "rgba(247,118,142,.08)";
  }

  // ---- 事件 ----
  function onMove(e) {
    if (locked || hostEl.contains(e.target)) return;
    const t = e.target;
    if (!t || t === document.documentElement || t === document.body) return;
    curTarget = t; curSel = buildSelector(t);
    showCur(curSel || "无法生成选择器");
    updateHighlight();
  }
  function onClickCapture(e) {
    if (hostEl.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (locked) { unlock(); return; }
    // 点击锁定
    locked = true; lockTarget = curTarget; lockSel = curSel;
    showCur("🔒 已锁定: "+(lockSel||"无"), true);
    enableBtns(true);
    updateHighlight();
    el("doneMsg").textContent = "已锁定。点按钮分类，点页面解锁，Esc两次退出。";
  }
  function unlock() {
    locked = false; lockTarget = null; lockSel = null;
    showCur(curSel || "已解锁，移动鼠标预览");
    enableBtns(false);
    updateHighlight();
    el("doneMsg").textContent = "";
  }
  let escCount = 0;
  function onKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (locked) { unlock(); escCount = 0; return; }
    escCount++;
    if (escCount >= 2) finish(true);
    else el("doneMsg").textContent = "再按一次 Esc 完成并退出";
  }
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKey, true);

  // ---- 按钮 ----
  function assign(kind) {
    if (!lockSel) return;
    collected[kind] = lockSel; updateSlots();
    el("doneMsg").textContent = "✓ "+{input:"输入框",send:"发送按钮",output:"输出区域"}[kind]+" 已设: "+lockSel;
    unlock();
  }
  el("bInput").onclick = (e) => { e.stopPropagation(); assign("input"); };
  el("bSend").onclick = (e) => { e.stopPropagation(); assign("send"); };
  el("bOutput").onclick = (e) => { e.stopPropagation(); assign("output"); };
  el("bTest").onclick = (e) => {
    e.stopPropagation();
    const sel = lockSel || curSel;
    if (!sel) return;
    try { const n = document.querySelectorAll(sel).length; el("doneMsg").textContent = "测试「"+sel+"」→ 匹配 "+n+" 个"; } catch (err) { el("doneMsg").textContent = "无效: "+err.message; }
  };
  el("bDone").onclick = (e) => { e.stopPropagation(); finish(true); };
  el("bCancel").onclick = (e) => { e.stopPropagation(); finish(false); };
  updateSlots(); enableBtns(false);

  // ---- 完成 ----
  function finish(save) {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("keydown", onKey, true);
    highlight.remove(); hostEl.remove(); delete window.__webctlPickerActive;
    if (save) {
      try { chrome.runtime.sendMessage({ type: "picker-result", result: { host: HOST, ...collected } }); } catch(_){}
      console.log("[picker] 已保存:", collected);
    }
  }
})();
