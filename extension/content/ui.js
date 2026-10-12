/**
 * 在网页上注入状态气泡，反馈每条工具调用的执行结果。
 *
 * 不依赖任何 AI 网页的 DOM 结构——气泡是独立 fixed 定位的容器，
 * 浮在页面右下角，几秒后自动收起。用户可点击展开查看明细。
 *
 * 挂到 window.__webctlUI 供 content 适配器调用。
 */

(() => {
  const ROOT_ID = "__webctl_toast_root";
  let root = null;

  function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px",
      "z-index:2147483647", "width:360px", "max-width:90vw",
      "display:flex", "flex-direction:column", "gap:6px",
      "font:12px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(root);
    return root;
  }

  function toast({ id, action, status, text, danger }) {
    const r = ensureRoot();
    const el = document.createElement("div");
    const color = status === "ok" ? "#9ece6a"
      : status === "err" ? "#f7768e"
      : status === "warn" ? "#e0af68"
      : "#7aa2f7";
    el.style.cssText = [
      "background:#1e1e2e", "color:#e4e4ef",
      "border:1px solid #3b3b52", `border-left:3px solid ${color}`,
      "border-radius:6px", "padding:8px 10px",
      "pointer-events:auto", "box-shadow:0 4px 16px rgba(0,0,0,.3)",
      "word-break:break-all", "white-space:pre-wrap",
    ].join(";");

    const tag = danger ? "⚠ " : (status === "ok" ? "✓ " : status === "err" ? "✗ " : "… ");
    const title = `${tag}[${action}]`;
    const body = text ? `\n${text}` : "";

    el.textContent = title + body;
    r.appendChild(el);

    // 成功/失败 5 秒后淡出；pending 不自动消失
    if (status !== "pending") {
      setTimeout(() => {
        el.style.transition = "opacity .4s";
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 400);
      }, 5000);
    }
    return el;
  }

  window.__webctlUI = { toast };
  console.log("[webctl] ui.js 就绪");
})();
