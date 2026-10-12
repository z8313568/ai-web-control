/**
 * 通用网站适配器（取代写死的 deepseek.js）。
 *
 * 工作方式：
 *   1. 取当前域名（location.hostname）；
 *   2. 读配置：先查 chrome.storage.local.adapters[域名]，查不到回退内置默认；
 *   3. 用配置里的 output 选择器做 MutationObserver 监听 + webctl 解析；
 *   4. 用配置里的 input 选择器做新对话提示词注入（若 injectPrompt 开启）。
 *
 * 所有选择器都是参数化的，本文件不含任何写死选择器。
 * picker.js 拾取的结果存进 storage.adapters，本文件自动生效。
 */

(() => {
  // 等待依赖就绪（最多等 5 秒，防止脚本加载时序问题）
  let retries = 0;
  const MAX_WAIT = 50; // 50 * 100ms = 5s
  function tryStart() {
    const P = window.__webctlParse;
    const U = window.__webctlUI;
    const C = window.__webctlConfig;
    const L = window.__webctlLogger;
    if (P && U && C && L) {
      initAdapter(P, U, C, L);
      return;
    }
    retries++;
    if (retries < MAX_WAIT) {
      setTimeout(tryStart, 100);
    } else {
      console.warn("[webctl] 依赖超时未就绪，adapter 退出。缺失:", {
        parse: !!P, ui: !!U, config: !!C, logger: !!L
      });
    }
  }
  tryStart();
})();

function initAdapter(PARSER, UI, CFG, LOG) {

  const HOST = location.hostname;
  const STABLE_MS = 1200;
  const states = new WeakMap();
  let adapterConfig = null;

  // ----------------------------------------------------------------------- //
  // 读取配置（用户配置优先，否则回退内置默认）
  // ----------------------------------------------------------------------- //
  function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["adapters"], (st) => {
        const userCfg = (st.adapters || {})[HOST];
        const defaultCfg = CFG.DEFAULT_ADAPTERS[HOST];
        // 用户配置 > 内置默认 > 自动探测
        const merged = { ...(defaultCfg || {}), ...(userCfg || {}), host: HOST };
        if (!merged.output && !merged.input) {
          // 无任何配置，自动探测页面元素
          resolve(autodetectConfig());
        } else {
          resolve(merged);
        }
      });
    });
  }

  // 自动探测当前页面的输入框和输出容器
  function autodetectConfig() {
    console.log(`[webctl] ${HOST}: 无预设配置，自动探测...`);
    let input = "", output = "";

    // 探测输入框：最大可见的 textarea 或 contenteditable
    const inputs = Array.from(document.querySelectorAll("textarea, [contenteditable=true], [role=textbox]"))
      .filter(el => el.offsetWidth > 100 && el.offsetHeight > 20);
    if (inputs.length > 0) {
      inputs.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
      const el = inputs[0];
      const ph = el.getAttribute("placeholder") || "";
      if (ph) { input = el.tagName.toLowerCase() + '[placeholder*="' + CSS.escape(ph.slice(0, 15)) + '"]'; }
      else if (el.id) { input = "#" + CSS.escape(el.id); }
      else { input = el.tagName.toLowerCase(); }
    }

    // 探测输出容器：找页面中同时含 markdown/content/message 类名的最大容器
    const outputCandidates = Array.from(document.querySelectorAll(
      "div[class*=markdown], div[class*=md-box], div[class*=message], div[class*=answer], div[class*=content], div[class*=prose]"
    )).filter(el => el.offsetWidth > 200);
    if (outputCandidates.length > 0) {
      // 取出现次数最多的类名模式
      const patterns = {};
      outputCandidates.forEach(el => {
        const cls = String(el.className);
        const m = cls.match(/(md-box|markdown|message|answer|content|prose)[\w-]*/i);
        if (m) { const k = m[0]; patterns[k] = (patterns[k] || 0) + 1; }
      });
      const best = Object.entries(patterns).sort((a, b) => b[1] - a[1])[0];
      if (best) { output = 'div[class*="' + best[0] + '"]'; }
    }
    if (!output) { output = "div"; } // 兜底

    const cfg = { host: HOST, label: HOST, input, output, injectPrompt: true, send: "", autodetected: true };
    console.log(`[webctl] ${HOST}: 自动探测结果 →`, cfg);
    return cfg;
  }

  // ----------------------------------------------------------------------- //
  // background 长连接
  // ----------------------------------------------------------------------- //
  let port = null;
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "webctl-content" });
    } catch (e) {
      port = null;
      setTimeout(connectPort, 2000);
      return;
    }
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 1000);
    });
    port.onMessage.addListener((msg) => {
      if (msg?.type === "result") onResult(msg);
    });
  }

  // 安装命令检测——内网不能自动安装软件
  const INSTALL_PATTERNS = [
    /\b(pip|pip3)\s+install\b/, /\bnpm\s+(i|install)\s+(-g|--global)?\s*\S/,
    /\bbrew\s+install\b/, /\bapt(-get)?\s+install\b/, /\byum\s+install\b/,
    /\bconda\s+install\b/, /\bgem\s+install\b/, /\bcargo\s+install\b/,
    /\bnpx\s/, /\bpipx\s+install\b/,
  ];

  function isInstallCommand(call) {
    if (call.action !== "shell" || !call.cmd) return false;
    const cmd = typeof call.cmd === "string" ? call.cmd : call.cmd.join(" ");
    for (const re of INSTALL_PATTERNS) {
      if (re.test(cmd)) return true;
    }
    return false;
  }

  function exec(call) {
    if (globalDisabled) return;
    console.log(`[webctl] exec: id=${call.id} action=${call.action}`);
    LOG.info("exec", `${call.action}: ${summary(call)}`, {id: call.id, action: call.action});
    if (!port) connectPort();
    // 防止 port 重连导致同一条消息发两次：catch 里先标记再重试
    let sent = false;
    const send = () => {
      if (sent) return;
      if (!port) { console.warn("[webctl] port null, 跳过发送"); return; }
      sent = true;
      port.postMessage({
        type: "exec", id: call.id, action: call.action,
        params: strip(call, ["id", "action"]),
      });
    };
    try {
      send();
    } catch (e) {
      console.warn(`[webctl] exec send failed, reconnecting:`, e);
      connectPort();
      try { send(); } catch (_) { /* ignore */ }
    }
  }

  // Agent 模式：执行完自动把结果发回 AI，形成自动循环
  let agentEnabled = true;         // 默认开
  let agentRound = 0;              // 当前连续轮数
  let globalDisabled = false;      // 全局开关（侧边栏控制）
  let injectDisabled = false;      // 提示词注入开关
  const AGENT_MAX_ROUNDS = 20;     // 最大连续轮数（批量模式下每轮是一次回传）
  const AGENT_MIN_INTERVAL = 8000; // 两次自动发送间最少隔 8 秒
  const BLOCK_EXEC_DELAY_MS = 2000; // 同一回复中多个 webctl 块之间至少隔 2 秒
  let agentLastSendTime = 0;
  let workspacePath = CFG.DEFAULT_WORKSPACE; // 工作空间路径（可从 storage 自定义）
  const executedCallIds = new Set(); // 二级去重兜底
  const sentAgentResults = new Set(); // 已回传给 AI 的 msg.id

  // 批量结果收集：同一轮 AI 回复中的多个 webctl 结果合并成一条消息发回
  let batchId = null;
  let batchTotal = 0;       // 本批次预期结果数
  let batchReceived = 0;    // 已收到结果数
  let batchResults = [];    // [{action, summary, ok}]
  let batchTimer = null;
  let batchStartedAt = 0;
  // 兜底：每 10 秒检查批次是否卡住，超时 15 秒强制发送
  setInterval(() => {
    if (batchId && batchReceived > 0 && Date.now() - batchStartedAt > 15000) {
      console.log("[webctl] batch 强制发送（超时兜底）");
      flushBatch();
    }
  }, 10000);

  // 待安装软件列表（内网不能自动安装，记录供用户手动处理）
  function addPendingInstall(id, cmd) {
    try {
      chrome.storage.local.get(["pendingInstalls"], (st) => {
        const list = st.pendingInstalls || [];
        const pkgMatch = cmd.match(/(?:pip|pip3|npm|brew|apt|yum|conda)\s+(?:install|i)\s+(?:-g\s+)?(\S+)/);
        const pkg = pkgMatch ? pkgMatch[1] : cmd.slice(0, 60);
        list.push({ id, cmd, pkg, time: new Date().toLocaleString(), status: "pending" });
        const seen = new Set();
        const unique = list.filter(e => { const k = e.pkg; if (seen.has(k)) return false; seen.add(k); return true; });
        chrome.storage.local.set({ pendingInstalls: unique.slice(-50) });
      });
    } catch (_) { /* ignore */ }
  }

  // 从 AI 文本回复中扫描安装建议，自动加入待安装列表
  function scanTextForInstalls(text) {
    if (!text) return;
    const patterns = [
      /(pip3?\s+install\s+\S+)/g,
      /(brew\s+install\s+\S+)/g,
      /(npm\s+(?:i|install)\s+(?:-g\s+)?\S+)/g,
      /(apt(?:-get)?\s+install\s+\S+)/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const cmd = m[1].trim();
        // 过滤掉已经在代码块里的（可能是 Python 代码里的示例）
        if (text.slice(Math.max(0, m.index - 20), m.index).includes("`")) continue;
        console.log("[webctl] 检测到安装建议:", cmd);
        addPendingInstall("text-" + Date.now(), cmd);
      }
    }
  }
  let processedBlocks = new WeakSet(); // 主去重：已处理的 md-code-block DOM 元素

  // 从 storage 读 agent 开关
  chrome.storage.local.get(["agentMode"], (st) => {
    agentEnabled = st.agentMode !== false;
  });

  // 检测操作系统
  function detectOS() {
    const p = navigator.platform || "";
    if (/mac/i.test(p)) return "macOS";
    if (/win/i.test(p)) return "Windows";
    if (/linux/i.test(p)) return "Linux";
    return p || "未知";
  }

  // 构建提示词（工作空间路径已在 start 里预加载）
  function buildSystemPrompt() {
    const os = detectOS();
    const m = location.pathname.match(/\/s\/([a-f0-9-]+)/i);
    const sessionId = m ? m[1] : "global";
    // 确保会话目录存在
    try { port?.postMessage({ type: "exec", id: "init-session-dir", action: "shell",
      params: { cmd: `mkdir -p ~/ai-workspace/.memory/sessions/${sessionId}` } }); } catch (_) {}
    // 注入会话 ID
    let prompt = CFG.buildSystemPrompt(os, workspacePath);
    prompt = prompt.replace(/\{会话ID\}/g, sessionId);
    return prompt;
  }

  // 开启新批次：本批预期 total 个结果，收到全部后合并发送
  function startBatch(total) {
    if (batchTimer) clearTimeout(batchTimer);
    batchId = `batch-${Date.now()}`;
    batchTotal = total;
    batchReceived = 0;
    batchResults = [];
    batchStartedAt = Date.now();
  }

  // 合并批次结果并发送给 AI
  function flushBatch() {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    if (batchResults.length === 0) { batchId = null; return; }

    agentRound++;
    const combined = batchResults.map((r, i) => {
      const status = r.ok ? "✓" : "✗";
      return `[${status} #${i+1}] ${r.action}: ${r.summary || (r.ok ? "完成" : "失败")}`;
    }).join("\n");

    const text = `[工具执行结果 #${agentRound} — 批量 ${batchResults.length} 条]\n${combined}\n\n（请根据结果继续，或更新 tasks.md 标记已完成，或告知任务完成。）`;

    LOG.info("agent", `回传批量结果 #${agentRound} 共${batchResults.length}条`, {round: agentRound});
    console.log(`[webctl] batch flush #${agentRound}: ${batchResults.length} 条结果合并发送`);

    batchId = null;
    sendToAI(text);
  }

  function onResult(msg) {
    const ok = msg.ok;
    const data = msg.data || {};
    const danger = data.dangerous;
    const action = msg.action || data?.action || "?";
    const text = formatResult(action, data) || (ok ? "完成" : msg.error);

    // 结果日志
    if (!ok) {
      LOG.error("result", `${action} 失败: ${msg.error || ""}`, {id: msg.id, action, error: msg.error});
    } else if (action === "shell" && data.returncode !== 0) {
      LOG.warn("result", `${action} 退出码非零: ${data.returncode}`, {returncode: data.returncode, stderr: (data.stderr||"").slice(0,200)});
    }

    // 批量模式：积累结果
    if (!globalDisabled && batchId && msg.id && !String(msg.id).startsWith("manual-") && !String(msg.id).startsWith("init-")) {
      batchResults.push({ ok, action, summary: formatForAgent(action, data, 0), danger });
      batchReceived++;
      LOG.info("result", `${action}: ${ok ? "完成" : "失败"} (${batchReceived}/${batchTotal})`, {id: msg.id, action, ok});
      console.log(`[webctl] batch ${batchReceived}/${batchTotal}: ${action} ${ok ? "ok" : "err"}`);
      if (batchReceived >= batchTotal) {
        flushBatch(); // 全部到齐，合并发送
      }
      return; // 不单独发送，等批次完成
    }

    // 非批量模式（手动触发或 init 命令）：按原逻辑
    if (!globalDisabled && agentEnabled && ok && msg.id && !String(msg.id).startsWith("manual-") && !String(msg.id).startsWith("init-") && !String(msg.id).startsWith("ws-")) {
      if (sentAgentResults.has(msg.id)) { console.log("[webctl] agent skip dup", msg.id); return; }
      sentAgentResults.add(msg.id);
      agentRound++;
      LOG.info("result", `${action}: 执行完成`, {id: msg.id, action, agentRound, ok});
      const r = formatForAgent(action, data, agentRound);
      if (r !== null) sendToAI(r);
    }
  }

  // 格式化结果为发给 AI 的简洁文本
  function formatForAgent(action, data, round) {
    if (round > AGENT_MAX_ROUNDS) {
      LOG.warn("agent", `达到最大轮数 ${AGENT_MAX_ROUNDS}，停止自动循环`);
      return null;
    }

    let body = "";
    if (action === "shell") {
      body = `退出码: ${data.returncode}`;
      if (data.stdout) body += `\n输出: ${data.stdout.slice(0, 2000)}`;
      if (data.stderr) body += `\n错误: ${data.stderr.slice(0, 300)}`;
      if (data.dangerous) body += `\n⚠ 命中危险模式: ${data.danger_match}`;
    } else if (action === "file_read") {
      body = data.truncated
        ? `[${data.size} 字节，已截断]\n${(data.content || "").slice(0, 800)}`
        : (data.content || "").slice(0, 800);
    } else if (action === "file_list") {
      body = (data.entries || []).slice(0, 50).map((e) =>
        `${e.is_dir ? "📁" : "  "} ${e.name}  (${e.size} 字节)`).join("\n");
    } else if (action === "file_write") {
      body = `已写入 ${data.bytes} 字节到 ${data.path}`;
    } else if (action === "browse") {
      body = data.dataUrl
        ? `已截图（${Math.round((data.dataUrl.length * 0.75) / 1024)} KB）`
        : JSON.stringify(data);
    } else {
      body = JSON.stringify(data).slice(0, 500);
    }

    return `[工具执行结果 #${round} — ${action}]\n${body}\n\n（请根据结果继续，完成后更新 tasks.md，或告知任务完成。）`;
  }

  // 把结果贴进输入框并自动发送
  function sendToAI(text) {
    if (!adapterConfig.input) return;
    // 速率限制：两次发送至少间隔 AGENT_MIN_INTERVAL
    const now = Date.now();
    if (now - agentLastSendTime < AGENT_MIN_INTERVAL) {
      console.log("[webctl] agent send skipped (rate limit)");
      return;
    }
    agentLastSendTime = now;

    let inputEl;
    try { inputEl = document.querySelector(adapterConfig.input); } catch (_) { return; }
    if (!inputEl) return;

    // 短暂延迟，等 AI 回复完全渲染
    setTimeout(() => {
      try {
        inputEl.focus();
        if ("value" in inputEl) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputEl), "value")?.set;
          setter?.call(inputEl, "");
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.execCommand("selectall");
        document.execCommand("delete");
        const ok = document.execCommand("insertText", false, text);
        if (!ok && "value" in inputEl) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputEl), "value")?.set;
          setter?.call(inputEl, text);
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
        // 自动发送
        inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));

        // 发送后清除输入框残留（延迟执行，等框架处理完 Enter）
        setTimeout(() => {
          try {
            const ta = document.querySelector(adapterConfig.input);
            if (ta && ("value" in ta ? ta.value.trim() : (ta.textContent || "").trim())) {
              if ("value" in ta) {
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")?.set;
                setter?.call(ta, "");
              } else {
                ta.textContent = "";
              }
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              ta.dispatchEvent(new Event("change", { bubbles: true }));
            }
          } catch (_) { /* ignore */ }
        }, 800);
      } catch (e) { console.warn("[webctl] agent send failed:", e); }
    }, 600);
  }

  // ----------------------------------------------------------------------- //
  // 输出监听（参数化 output 选择器）
  // ----------------------------------------------------------------------- //
  let globalTimer = null;

  function startOutputWatcher() {
    if (!adapterConfig.output) {
      console.warn(`[webctl] ${HOST}: 未配置 output 选择器，跳过输出监听`);
      return;
    }
    const obs = new MutationObserver(() => scheduleGlobal());
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleGlobal();
    setTimeout(scheduleGlobal, 2500);

    // 轮询兜底：每 5 秒强制扫描一次，防止 MutationObserver 在某些时序下漏节点
    setInterval(() => {
      console.log(`[webctl] poll: 强制扫描 ${adapterConfig.output}, 当前节点数=${document.querySelectorAll(adapterConfig.output).length}`);
      processFinished();
    }, 5000);
  }

  function scheduleGlobal() {
    clearTimeout(globalTimer);
    globalTimer = setTimeout(processFinished, STABLE_MS);
  }

  function processFinished() {
    if (!adapterConfig.output) return;
    let nodes;
    try {
      nodes = document.querySelectorAll(adapterConfig.output);
    } catch (e) {
      console.warn(`[webctl] output 选择器无效: ${adapterConfig.output}`, e);
      return;
    }
    let foundWithCalls = 0;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!PARSER.hasCalls(node)) {
        const st = states.get(node);
        if (st) st.fingerprint = null;
        continue;
      }
      foundWithCalls++;
      scheduleNode(node);
    }
    if (foundWithCalls > 0) {
      console.log(`[webctl] processFinished: 总节点=${nodes.length}, 含webctl=${foundWithCalls}`);
    }
  }

  function scheduleNode(node) {
    let st = states.get(node);
    if (!st) {
      st = { timer: null, fingerprint: null };
      states.set(node, st);
    }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => processNode(node), 200);
  }

  function processNode(node) {
    if (globalDisabled) return;
    const st = states.get(node);
    if (!st) return;
    const text = node.innerText || "";
    const fp = fingerprint(text);
    if (fp === st.fingerprint) return;
    st.fingerprint = fp;

    console.log(`[webctl] processNode: 内容变化，开始解析 (指纹=${fp.slice(0,40)})`);

    const allCalls = PARSER.parse(node);
    console.log(`[webctl] parse 结果: ${allCalls.length} 个调用`, allCalls.map(c => c.ok ? c.call.action : c.error));

    // 本批次的 webctl 块：开启新批次，收集所有结果后合并发送
    const okCalls = allCalls.filter(c => c.ok);
    if (okCalls.length > 0) {
      startBatch(okCalls.length);
    }

    // 逐条延迟执行，避免同一时间多条 webctl 触发 DeepSeek 速率限制
    let execDelay = 0;
    allCalls.forEach((c, ci) => {
      if (!c.ok) {
        LOG.error("detect", `JSON解析失败: ${c.error}`, {raw: (c.raw || "").slice(0, 150)});
        return;
      }
      if (c.block && processedBlocks.has(c.block)) { console.log(`[webctl] 跳过已处理 DOM block`, c.call.id); LOG.warn("skip", `跳过(DOM): ${c.call.id}`, {reason:"dom-dup"}); return; }
      if (c.block) processedBlocks.add(c.block);
      if (executedCallIds.has(c.call.id)) { console.log(`[webctl] 跳过已执行 call id`, c.call.id); LOG.warn("skip", `跳过(ID): ${c.call.id}`, {reason:"id-dup"}); return; }
      executedCallIds.add(c.call.id);
      LOG.info("detect", `发现: ${c.call.action}`, {id:c.call.id, action:c.call.action});
      console.log(`[webctl] → 延迟${execDelay}ms 执行: id=${c.call.id} action=${c.call.action}`);
      const call = c.call;
      // 安装命令拦截：内网不能自动装软件，记录到待安装列表
      if (isInstallCommand(call)) {
        const cmd = typeof call.cmd === "string" ? call.cmd : call.cmd.join(" ");
        LOG.warn("blocked", `安装命令已拦截: ${cmd.slice(0,80)}`, {id: call.id});
        addPendingInstall(call.id, cmd);
        // 立即标记为"已收到"，避免阻塞批次完成
        batchResults.push({ ok: false, action: call.action, summary: `安装已拦截: ${cmd.slice(0,50)}` });
        batchReceived++;
        return;
      }
      setTimeout(() => exec(call), execDelay);
      execDelay += BLOCK_EXEC_DELAY_MS;
    });
    // 同时检查是否有 install 块（需要安装的软件）
    const installs = PARSER.parseInstalls(node);
    installs.forEach((inst) => {
      console.log("[webctl] 发现 install 块:", inst.cmd);
      addPendingInstall("install-" + Date.now(), inst.cmd);
    });
    // 文本扫描作为兜底（AI 没按规定用 install 块时仍能捕获）
    if (allCalls.length > 0 || installs.length > 0) {
      scanTextForInstalls(node.innerText || "");
    }
  }

  // ----------------------------------------------------------------------- //
  // 输入框提示词注入（参数化 input 选择器）
  // ----------------------------------------------------------------------- //
  let injected = false;
  let lastUrl = location.href;

  function maybeInject() {
    if (globalDisabled) return;
    if (injectDisabled) return;
    if (!adapterConfig.injectPrompt) return;
    if (!adapterConfig.input) return;
    if (injected) return;

    let inputEl;
    try {
      inputEl = document.querySelector(adapterConfig.input);
    } catch (e) {
      return;
    }
    if (!inputEl) return;

    // 输入框为空才注入，绝不覆盖用户内容
    const val = inputEl.value ?? inputEl.textContent ?? "";
    if (val.trim() !== "") return;

    // 旧对话检测：如果有 AI 回复 OR 任何对话消息（含用户消息），都不注入。
    if (adapterConfig.output) {
      try {
        const hasReply = document.querySelector(adapterConfig.output);
        if (hasReply) { console.log("[webctl] 已有AI回复，跳过注入"); return; }
      } catch (_) { /* ignore */ }
    }
    // 额外检测：对话容器中是否有任何消息（防止 AI 回复未渲染时误判为新对话）
    // 注意: 只查语义类名，避免 TailwindCSS 原子类误匹配（如 sidebar 里的 message 文字）
    try {
      const anyMsg = document.querySelector("div.ds-message, div[class~=ds-message], div[data-role=message], div[class*=conversation-item]");
      if (anyMsg) { console.log("[webctl] 对话中已有消息，跳过注入"); return; }
    } catch (_) { /* ignore */ }

	    try {
	      inputEl.focus();
	      // 构建带操作系统信息的系统提示词
	      const promptWithOS = buildSystemPrompt();
	      const ok = document.execCommand("insertText", false, promptWithOS);
      if (!ok) {
        const cur = inputEl.value ?? inputEl.textContent ?? "";
        if (!cur.trim()) {
          // 兜底：直接设 value + input 事件
          if ("value" in inputEl) {
            const setter = Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(inputEl), "value"
            )?.set;
            setter?.call(inputEl, promptWithOS);
          } else {
            inputEl.textContent = promptWithOS;
          }
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      injected = true; // 先标记已注入，防止下一条消息触发再注入
      console.log(`[webctl] ${HOST}: 系统提示词已注入，自动发送`);
      showToast(`已自动发送系统提示词（${adapterConfig.label || HOST}），等待 AI 回复…`);

      // 自动发送：延迟 500ms 等框架注册完输入内容，然后模拟 Enter
      setTimeout(() => {
        try {
          const el = document.querySelector(adapterConfig.input);
          if (el) {
            el.focus();
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          }
        } catch (_) { /* ignore */ }
      }, 500);
    } catch (e) {
      console.warn(`[webctl] ${HOST}: 提示词注入失败`, e);
    }
  }

  function checkConversationSwitch() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      injected = false;
      agentRound = 0;
      agentLastSendTime = 0;
      executedCallIds.clear();
      sentAgentResults.clear();
      processedBlocks = new WeakSet();
      if (batchTimer) clearTimeout(batchTimer); batchId = null; batchResults = [];
      LOG.clear(); // 新对话清空日志
    }
  }

  function showToast(text) {
    const id = "__webctl_inject_toast";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText = [
        "position:fixed", "left:50%", "top:80px", "transform:translateX(-50%)",
        "background:#1e1e2e", "color:#9ece6a", "border:1px solid #9ece6a",
        "border-radius:6px", "padding:10px 16px", "z-index:2147483647",
        "font:13px/1.5 -apple-system,system-ui,sans-serif",
        "box-shadow:0 4px 16px rgba(0,0,0,.3)",
      ].join(";");
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.transition = "opacity .5s";
      el.style.opacity = "0";
    }, 4000);
  }

  // 页面右下角绿色小标：adapter 已启动的可见证明
  function showAdapterBadge() {
    const id = "__webctl_badge";
    if (document.getElementById(id)) return;
    const el = document.createElement("div");
    el.id = id;
    el.textContent = "⚡";
    el.title = "AI Web Control 适配器已就绪";
    el.style.cssText = [
      "position:fixed", "right:12px", "bottom:12px",
      "width:20px", "height:20px", "border-radius:50%",
      "background:#9ece6a", "color:#1e1e2e", "font-size:12px",
      "display:flex", "align-items:center", "justify-content:center",
      "z-index:2147483646", "cursor:default", "opacity:0.7",
      "box-shadow:0 2px 8px rgba(0,0,0,.3)",
    ].join(";");
    document.body.appendChild(el);
  }

  // ----------------------------------------------------------------------- //
  // 启动
  // ----------------------------------------------------------------------- //
  let bootTimer = null;
  function scheduleBoot() {
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => {
      checkConversationSwitch();
      maybeInject();
    }, 600);
  }

  async function start() {
    adapterConfig = await getConfig();
    console.log(`[webctl] ${HOST}: adapter 启动，配置=`, adapterConfig);

    // 预加载工作空间路径（避免 buildSystemPrompt 里 async 调用）
    try {
      const st = await new Promise((r) => chrome.storage.local.get(["workspacePath"], r));
      if (st.workspacePath) workspacePath = st.workspacePath;
    } catch (_) { /* ignore */ }
    // 创建工作空间目录（异步，不阻塞）
    if (port || true) {
      try {
        const wCmd = { type:"exec", id:"init-ws", action:"shell", params:{cmd:`mkdir -p ${workspacePath}`} };
        // 等连接建立后发送
        setTimeout(() => {
          if (port) port.postMessage(wCmd);
        }, 2000);
      } catch (_) { /* ignore */ }
    }

    // 读全局开关 + 提示词注入开关
    chrome.storage.local.get(["enabled", "injectPrompt"], (st) => {
      globalDisabled = st.enabled === false;
      injectDisabled = st.injectPrompt === false;
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.enabled) globalDisabled = changes.enabled.newValue === false;
      if (changes.injectPrompt) injectDisabled = changes.injectPrompt.newValue === false;
      if (changes.agentMode) agentEnabled = changes.agentMode.newValue !== false;
    });

    // 关键：启动时扫描页面上已存在的所有 webctl 块，把它们的 call id 和 DOM
    // 预先登记到去重集合里。这样页面刷新/扩展重载后，历史 webctl 不会重新执行。
    prescanExistingBlocks();

    connectPort();
    // 确保会话 tasks 目录存在（通过 background 发 shell 命令）
    setTimeout(() => {
      const m2 = location.pathname.match(/\/s\/([a-f0-9-]+)/i);
      const sid = m2 ? m2[1] : "global";
      try { port?.postMessage({ type: "exec", id: "init-session", action: "shell",
        params: { cmd: `mkdir -p ~/ai-workspace/.memory/sessions/${sid}` } }); } catch (_) {}
    }, 3000);
    startOutputWatcher();

    // 页面可见标记：右下角绿色小标，确认 adapter 已启动
    showAdapterBadge();

    const obs = new MutationObserver(scheduleBoot);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleBoot();
    setTimeout(scheduleBoot, 2000);
  }

  // 启动时预扫描：登记所有已存在的 webctl 块，防止重启后重复执行
  function prescanExistingBlocks() {
    if (!adapterConfig.output) return;
    let nodes;
    try { nodes = document.querySelectorAll(adapterConfig.output); } catch (_) { return; }
    let count = 0;
    nodes.forEach((node) => {
      const calls = PARSER.parse(node);
      calls.forEach((c) => {
        if (c.ok) {
          if (c.block) processedBlocks.add(c.block);
          if (c.call.id) executedCallIds.add(c.call.id);
          count++;
        }
      });
    });
    if (count > 0) {
      console.log(`[webctl] 预扫描: 登记了 ${count} 个已有 webctl 块，重启后不会重复执行`);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // ----------------------------------------------------------------------- //
  function fingerprint(text) {
    const n = text.length;
    if (n < 64) return `L${n}:${text}`;
    return `L${n}:${text.slice(0, 32)}|${text.slice(n >> 1, (n >> 1) + 16)}|${text.slice(-32)}`;
  }

  function summary(call) {
    if (call.action === "shell") return `$ ${call.cmd}`;
    if (call.action === "file_read") return `read ${call.path}`;
    if (call.action === "file_write") return `write ${call.path}`;
    if (call.action === "file_list") return `list ${call.path}`;
    if (call.action === "browse") return `browse ${call.op} ${call.url || ""}`;
    if (call.action === "notify") return String(call.message || "");
    return JSON.stringify(call);
  }

  function formatResult(action, data) {
    if (!data) return null;
    if (action === "shell") {
      const head = `exit=${data.returncode}`;
      const body = (data.stdout || "") + (data.stderr ? `\n${data.stderr}` : "");
      return `${head}\n${body}`.trim();
    }
    if (action === "file_read") return data.content;
    if (action === "file_list") {
      return (data.entries || []).map((e) => `${e.is_dir ? "📁" : "  "} ${e.name}`).join("\n");
    }
    if (action === "browse") {
      if (data.dataUrl) return `已截图（${Math.round((data.dataUrl.length * 0.75) / 1024)} KB）`;
      return JSON.stringify(data);
    }
    return JSON.stringify(data).slice(0, 500);
  }

  function strip(obj, keys) {
    const out = {};
    for (const k of Object.keys(obj)) if (!keys.includes(k)) out[k] = obj[k];
    return out;
  }
} // initAdapter 结束
