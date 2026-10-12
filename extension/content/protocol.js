/**
 * 工具调用协议解析（content script 共享）。
 *
 * 解析 AI 回复里的 webctl 工具调用。支持两种形态：
 *
 *   1. 原始 markdown 围栏（AI 还没渲染时，或纯文本场景）：
 *        ```webctl
 *        {"id":"t1","action":"shell","cmd":"echo hi"}
 *        ```
 *
 *   2. 渲染后的代码块 DOM（DeepSeek 等把 ```webctl 渲染成带 UI 的代码块）：
 *        <div class="md-code-block">
 *          <div class="...-banner"><span>webctl</span><button>复制</button>...</div>
 *          <pre><code>{"id":"t1",...}</code></pre>
 *        </div>
 *      这种形态下 innerText 会混入"复制/下载"按钮文字，围栏也没了，
 *      所以必须从 DOM 结构里精确取 pre/code 的内容。
 *
 * 挂到 window.__webctlParse 供各 content 适配器调用。
 */

(() => {
  // 匹配原始 markdown 围栏 ```webctl ... ```
  const FENCE_RE = /```webctl\s*\n([\s\S]*?)```/g;

  const VALID_ACTIONS = new Set([
    "shell", "file_read", "file_write", "file_list",
    "browse", "notify",
  ]);

  // 解析单个 JSON 文本为工具调用对象（带校验）
  function parseOne(raw, idx) {
    const trimmed = raw.trim();
    try {
      const obj = JSON.parse(trimmed);
      if (!obj || typeof obj !== "object") {
        return { ok: false, error: "block_not_object", raw: trimmed };
      }
      const action = obj.action;
      if (!action) return { ok: false, error: "missing_action", raw: trimmed };
      if (!VALID_ACTIONS.has(action)) {
        return { ok: false, error: "unknown_action", action, raw: trimmed };
      }
      if (!obj.id) obj.id = `auto-${Date.now()}-${idx}`;
      return { ok: true, call: obj };
    } catch (e) {
      return { ok: false, error: "json_parse_failed", detail: e.message, raw: trimmed };
    }
  }

  /**
   * 从一段文本里解析所有 webctl 围栏块（模式 1）。
   * 用于没有 DOM、只有纯文本的场景。
   */
  function parseText(text) {
    const out = [];
    let m;
    FENCE_RE.lastIndex = 0;
    while ((m = FENCE_RE.exec(text)) !== null) {
      out.push(parseOne(m[1], out.length));
    }
    return out;
  }

	  /**
	   * 从 DOM 子树里解析所有渲染后的 webctl 代码块（模式 2）。
	   * 返回 [{ok, call, block: DOM元素}]——带 sourceBlock 用于 DOM 级去重。
	   */
	  function parseDOM(root) {
	    const out = [];
	    if (!root || !root.querySelectorAll) return out;

	    const codeBlocks = root.querySelectorAll(
	      "div.md-code-block, div[class*=code-block-element], div[class*=code-block-container], pre code[class*=webctl], pre[class*=webctl]"
	    );

	    // 用 Set 去重：同一次 parseDOM 里同一个 DOM 元素只处理一次
	    const seen = new Set();
	    codeBlocks.forEach((block) => {
	      // 跳过嵌套的子元素（如 banner-wrap、banner 也被 [class*=code-block] 匹配）
	      // 只处理最外层的 md-code-block div
	      const realBlock = block.closest("div.md-code-block") || block.closest("div[class*=code-block-element]") || block;
	      if (seen.has(realBlock)) return;
	      seen.add(realBlock);

		      const langText = getBlockLang(realBlock);
		      // 接受 webctl 标签，也接受 json/text/plain 标签（做内容检测）
		      const isWebctl = langText && /^webctl$/i.test(langText.trim());
		      const isFallback = langText && /^(json|text|plain)$/i.test(langText.trim());
		      if (!isWebctl && !isFallback) return;

		      const codeEl = realBlock.querySelector("pre code") || realBlock.querySelector("pre") || realBlock.querySelector("code");
		      const raw = codeEl ? codeEl.innerText : "";
		      if (!raw.trim()) return;

            // 对于 json/text 标签：只接受内容是一个合法 webctl JSON 对象
            if (!isWebctl) {
              try {
                const obj = JSON.parse(raw.trim());
                if (!obj || typeof obj !== "object" || !obj.action) return;
                if (!VALID_ACTIONS.has(obj.action)) return;
              } catch (_) { return; }
            }

            const parsed = parseOne(raw, out.length);
            out.push({ ...parsed, block: realBlock });
          });

		    return out;
		  }

	  /**
	   * parseInstalls(root) — 从 DOM 子树里提取所有 install 代码块。
	   * 返回安装命令数组 [{cmd, block}]。
	   */
	  function parseInstalls(root) {
	    const out = [];
	    if (!root || !root.querySelectorAll) return out;
	    const codeBlocks = root.querySelectorAll("div.md-code-block, div[class*=code-block]");
	    const seen = new Set();
	    codeBlocks.forEach((block) => {
	      const realBlock = block.closest("div.md-code-block") || block.closest("div[class*=code-block-element]") || block;
	      if (seen.has(realBlock)) return;
	      seen.add(realBlock);
	      const langText = getBlockLang(realBlock);
	      if (!langText || !/^install$/i.test(langText.trim())) return;
	      const codeEl = realBlock.querySelector("pre code") || realBlock.querySelector("pre") || realBlock.querySelector("code");
	      const raw = codeEl ? codeEl.innerText : "";
	      if (raw.trim()) {
	        raw.split("\n").forEach((line) => {
	          const cmd = line.trim();
	          if (cmd && !cmd.startsWith("#")) out.push({ cmd, block: realBlock });
	        });
	      }
	    });
	    return out;
	  }

	  // 取代码块的语言标签文本
	  function getBlockLang(block) {
	    // 多种代码块格式的语言标签检测
	    // DeepSeek: banner 里的 span（跳过"复制""下载"按钮文字）
	    const banner = block.querySelector("[class*=banner]");
	    if (banner) {
	      const spans = banner.querySelectorAll("span");
	      for (const s of spans) {
	        const t = (s.innerText || "").trim();
	        if (t && !/^(复制|下载|copy|download)$/i.test(t)) return t;
	      }
	    }
	    // 豆包: header-IAeXdE 里的 text-OkYU_0
	    const header = block.querySelector("[class*=header-IAeXdE], [class*=code-block-container]");
	    if (header) {
	      const langEl = header.querySelector("[class*=text-OkYU], [class*=title]");
	      if (langEl) { const t = (langEl.innerText || "").trim(); if (t) return t; }
	    }
	    // 通用: pre code 的 class 里 language-xxx
	    const code = block.querySelector("code");
    if (code) {
      const cls = code.className || "";
      const m = cls.match(/language-(\w+)/) || cls.match(/hljs\s+(\w+)/);
      if (m) return m[1];
      const dl = code.getAttribute("data-language");
      if (dl) return dl;
    }
    return null;
  }

  /**
   * 智能解析：优先 DOM（渲染后精确），回退文本（围栏模式）。
   * content adapter 对每个 AI 消息容器调用此函数。
   */
  function parse(rootOrText) {
    if (typeof rootOrText === "string") {
      return parseText(rootOrText);
    }
    // DOM 节点：先试 DOM 解析（精确），没有再回退到 innerText 的围栏解析
    const domResult = parseDOM(rootOrText);
    if (domResult.length > 0) return domResult;
    return parseText(rootOrText.innerText || "");
  }

  // 判断是否包含 webctl（用于快速过滤）
  // 接受 DOM 节点（精确检测渲染后的代码块）或字符串（回退到文本匹配）
  function hasCalls(nodeOrText) {
    if (!nodeOrText) return false;
    // DOM 节点：检查是否有渲染后的 webctl 代码块
    if (typeof nodeOrText.querySelectorAll === "function") {
      // 先快速 scan：有没有代码块元素
      const blocks = nodeOrText.querySelectorAll("div.md-code-block, div[class*=code-block-element], div[class*=code-block-container], pre code[class*=language-webctl]");
      for (const b of blocks) {
        const lang = getBlockLang(b);
        if (lang && /^webctl$/i.test(lang.trim())) return true;
      }
      // 回退到文本检测（纯文本场景）
      return /```webctl\b/.test(nodeOrText.innerText || "");
    }
    // 纯文本
    return /```webctl\b/.test(String(nodeOrText));
  }

  window.__webctlParse = { parse, parseText, parseDOM, parseInstalls, hasCalls };
  console.log("[webctl] protocol.js 就绪");
})();
