// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能 import / JSX。
//
// 职责（v0.4）：
//   A. 输入框左侧一个「旁问」按钮，点开**右侧贴边抽屉**（不居中、不遮挡主对话）。
//   B. 抽屉里按聊天顺序（旧→新、最新在底部，自动滚到底）列出本会话的旁问线程，
//      每条线程展开全部轮次，答案按 **Markdown** 渲染。
//   C. 正在跑的旁问**流式**显示（host 在 `llm/stream` 上缓冲子会话文本，`btw/live` 轮询）。
//   D. 直接发问 / 追问：把 `/btw <问题>` 塞进 composer 再提交。
//      **必须借 composer 提交**——真实 Agent 只能在命令调用上下文里拿到
//      （`ctx.agents.get()` 返回 undefined，见公开仓库 docs/adr/0016）。
//   E. 一键转正：host 生成 Markdown 源码草稿，只插进输入框、绝不发送。
//
// 宿主调用走 ctx.connection.rpc.call("/api", "btw/<method>", { args: { request } })——
// 无构建插件没有 typert 客户端产物（见 docs/runtime/0.2.2-rc.1.md §7）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-btw",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;

    /** @type {any} */
    const React = require("react");
    const h = React.createElement;

    const NS = "btw";
    const PLUGIN_ID = "@kangyishuai/dsh-btw";
    /** setDraft 走异步更新：轮询草稿落定（与 next-step 同参数）。 */
    const DRAFT_POLL_TRIES = 15;
    const DRAFT_POLL_INTERVAL_MS = 20;
    /** 抽屉列出的线程条数上限（host 还会按 perSessionRecords 再夹一次）。 */
    const LIMITS_CLIENT_THREADS = 20;
    /** 提交后轮询历史，等新记录出现；按实测 /btw 耗时（20–40s）给足 120s 窗口。 */
    const REFRESH_MAX_MS = 120_000;
    const REFRESH_INTERVAL_MS = 1200;
    /** 流式轮询间隔：有 run 时密一点，空闲时慢一点（只读一个内存快照，很便宜）。 */
    const LIVE_ACTIVE_MS = 350;
    const LIVE_IDLE_MS = 1000;
    /** 空闲时每 N 次 live 轮询才刷一次线程列表（约 4s）。 */
    const LIVE_IDLE_REFRESH_EVERY = 4;

    const zh = {
      button: "旁问",
      title: "旁问",
      placeholder: "提一个只读旁问…",
      send: "提问",
      empty: "本会话还没有旁问。在下面提一个，或直接用 /btw <问题>。",
      close: "关闭",
      collapse: "收起为侧边条",
      collapseShort: "收起",
      expand: "展开旁问",
      cost: "新增 {newTokens} · 命中缓存 {cachedTokens} · {ms}",
      failed: "读取旁问历史失败",
      sent: "已提交，答案会出现在对话里",
      followUp: "追问",
      followPlaceholder: "在这个线程里追问…",
      followUpLabel: "追问",
      turns: "轮",
      promote: "转正",
      promoted: "已插入输入框草稿（未发送）",
      promoteBlocked: "输入框已有内容，先清空再转正",
      promoteFailed: "生成转正草稿失败",
      sending: "正在等待答案…",
      streaming: "正在生成回答",
      waitHint: "通常 20–40 秒",
      sentPending: "命令已提交，答案稍后出现在对话里",
      expandAnswer: "展开全文",
      collapseAnswer: "收起",
      submitHint: "提交时会以 /btw 命令写入对话",
      newQuestionLabel: "新旁问",
      scopeAny: "范围：不限",
      scopeSession: "范围：整个会话",
      scopeRecent: "范围：最近几轮",
      scopeSelection: "范围：仅选中片段",
      sendFailed: "提交失败（输入框不可用）",
      "settings.nav": "旁问",
      "settings.title": "旁问（只读）",
      "settings.tools": "允许旁问使用的工具",
      "settings.toolsHint": "留空 = 完全只读（推荐）。多个工具用逗号分隔；send_message 永不放行。",
      "settings.limit": "每会话保留条数",
      "settings.more": "更多设置",
      "settings.save": "保存",
      "settings.saved": "已保存",
      "settings.failed": "保存失败",
      "settings.mode": "模式",
      "settings.readOnly": "只读",
    };
    const en = {
      button: "btw",
      title: "Side questions",
      placeholder: "Ask a read-only side question…",
      send: "Ask",
      empty: "No side question yet. Ask one below, or use /btw <question>.",
      close: "Close",
      collapse: "Collapse to side rail",
      collapseShort: "Collapse",
      expand: "Expand side questions",
      cost: "new {newTokens} · cached {cachedTokens} · {ms}",
      failed: "Could not read side-question history",
      sent: "Submitted; the answer appears in the conversation",
      followUp: "Follow up",
      followPlaceholder: "Ask a follow-up in this thread…",
      followUpLabel: "Follow-up",
      turns: "turns",
      promote: "Promote",
      promoted: "Inserted into the composer as a draft (not sent)",
      promoteBlocked: "Composer already has content; clear it before promoting",
      promoteFailed: "Could not create the promotion draft",
      sending: "Waiting for the answer…",
      streaming: "Generating the answer",
      waitHint: "usually 20–40s",
      sentPending: "Command submitted; the answer will appear in the conversation",
      expandAnswer: "Show all",
      collapseAnswer: "Collapse",
      submitHint: "Submitting writes a /btw command into the conversation",
      newQuestionLabel: "New side question",
      scopeAny: "Scope: any",
      scopeSession: "Scope: whole session",
      scopeRecent: "Scope: recent turns",
      scopeSelection: "Scope: selection only",
      sendFailed: "Could not submit (composer unavailable)",
      "settings.nav": "Side questions",
      "settings.title": "Side questions (read-only)",
      "settings.tools": "Tools the side question may use",
      "settings.toolsHint":
        "Empty = fully read-only (recommended). Separate names with commas; send_message is never allowed.",
      "settings.limit": "Records kept per session",
      "settings.more": "More settings",
      "settings.save": "Save",
      "settings.saved": "Saved",
      "settings.failed": "Save failed",
      "settings.mode": "Mode",
      "settings.readOnly": "read-only",
    };

    const CSS = [
      // ---- 通用按钮 --------------------------------------------------------
      ".dsh-btw-btn{height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;cursor:pointer;white-space:nowrap;}",
      ".dsh-btw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-btw-btn:disabled{opacity:.5;cursor:default;}",
      ".dsh-btw-btn.is-primary{background:var(--dsw-alias-button-primary-fill,#4f7cff);border-color:transparent;color:var(--dsw-alias-label-on-color,#fff);}",
      ".dsh-btw-btn.is-primary:hover{background:var(--dsw-alias-button-primary-hover,#4f7cff);color:var(--dsw-alias-label-on-color,#fff);}",
      // ---- 右侧抽屉 --------------------------------------------------------
      // 贴右边、避开顶部会话头和底部 composer：宽屏时正好落在主对话右侧空白区，
      // 不改变主对话宽度；窄屏时宽度自适应、仍不占用中心。
      ".dsh-btw-panel{position:fixed;right:12px;top:72px;bottom:112px;width:min(400px,calc(100vw - 24px));display:flex;flex-direction:column;min-height:0;z-index:2147482000;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.55;box-shadow:0 18px 48px rgba(0,0,0,.38);}",
      "@media (max-width:760px){.dsh-btw-panel{top:56px;bottom:96px;width:calc(100vw - 24px);}}",
      ".dsh-btw-rail{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147482000;display:flex;flex-direction:row;align-items:center;gap:6px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-right:none;border-radius:10px 0 0 10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;cursor:pointer;box-shadow:-2px 0 10px rgba(0,0,0,.22);}",
      ".dsh-btw-rail:hover{color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));}",
      ".dsh-btw-rail-count{font-size:10px;opacity:.75;font-variant-numeric:tabular-nums;}",
      // ---- 头部 / 状态 ------------------------------------------------------
      ".dsh-btw-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:600;flex:none;}",
      ".dsh-btw-head-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".dsh-btw-grow{flex:1 1 auto;}",
      ".dsh-btw-status{display:flex;align-items:center;gap:6px;margin:0 0 8px;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-label-secondary,GrayText);font-size:11.5px;box-shadow:0 1px 0 var(--dsw-alias-border-l1,rgba(128,128,128,.2));}",
      ".dsh-btw-status.is-busy{color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-btw-spinner{display:inline-block;animation:dsh-btw-spin 1s linear infinite;}",
      "@keyframes dsh-btw-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
      // ---- 列表 ------------------------------------------------------------
      ".dsh-btw-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:2px;scrollbar-gutter:stable;}",
      ".dsh-btw-thread{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));}",
      ".dsh-btw-thread:first-child{border-top:none;padding-top:2px;}",
      ".dsh-btw-turn{margin-top:6px;}",
      ".dsh-btw-turn:first-child{margin-top:0;}",
      ".dsh-btw-q{display:block;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-label-primary,CanvasText);white-space:pre-wrap;word-break:break-word;font-size:12px;}",
      ".dsh-btw-q-label{display:block;margin-bottom:2px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:10.5px;letter-spacing:.5px;}",
      ".dsh-btw-a{margin-top:4px;word-break:break-word;}",
      ".dsh-btw-meta{margin-top:3px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:11px;font-variant-numeric:tabular-nums;}",
      ".dsh-btw-dim{color:var(--dsw-alias-label-tertiary,GrayText);padding:6px 0;}",
      ".dsh-btw-err{color:var(--dsw-alias-state-error-primary,#d9534f);padding:6px 0;word-break:break-word;}",
      ".dsh-btw-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;}",
      // ---- Markdown --------------------------------------------------------
      ".dsh-btw-md{overflow-wrap:anywhere;}",
      ".dsh-btw-md p{margin:0 0 6px;}",
      ".dsh-btw-md p:last-child{margin-bottom:0;}",
      ".dsh-btw-md h1,.dsh-btw-md h2,.dsh-btw-md h3,.dsh-btw-md h4,.dsh-btw-md h5,.dsh-btw-md h6{margin:10px 0 5px;font-weight:600;line-height:1.35;}",
      ".dsh-btw-md h1{font-size:15px;}",
      ".dsh-btw-md h2{font-size:14px;}",
      ".dsh-btw-md h3{font-size:13px;}",
      ".dsh-btw-md h4,.dsh-btw-md h5,.dsh-btw-md h6{font-size:12.5px;}",
      ".dsh-btw-md ul,.dsh-btw-md ol{margin:4px 0 6px;padding-left:20px;}",
      ".dsh-btw-md li{margin:2px 0;}",
      ".dsh-btw-md blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-btw-md code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-base,Canvas);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;}",
      ".dsh-btw-codeblock{margin:6px 0;}",
      ".dsh-btw-codeblock-lang{color:var(--dsw-alias-label-tertiary,GrayText);font-size:10.5px;margin-bottom:2px;}",
      ".dsh-btw-md pre{margin:0;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-base,Canvas);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.5;white-space:pre;overflow-x:auto;}",
      ".dsh-btw-md pre code{padding:0;border:none;background:transparent;font-size:inherit;white-space:pre;}",
      ".dsh-btw-tablewrap{max-width:100%;overflow-x:auto;margin:6px 0;}",
      ".dsh-btw-md table{border-collapse:collapse;font-size:11.5px;}",
      ".dsh-btw-md th,.dsh-btw-md td{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));padding:4px 7px;text-align:left;vertical-align:top;}",
      ".dsh-btw-md th{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));font-weight:600;}",
      ".dsh-btw-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));margin:8px 0;}",
      ".dsh-btw-md a,.dsh-btw-link{color:var(--dsw-alias-brand-primary,#4f7cff);text-decoration:underline;word-break:break-all;}",
      ".dsh-btw-md strong{font-weight:600;}",
      ".dsh-btw-md del{opacity:.65;}",
      ".dsh-btw-caret{display:inline-block;width:6px;height:1em;margin-left:2px;vertical-align:-2px;background:currentColor;animation:dsh-btw-blink 1s steps(1) infinite;}",
      "@keyframes dsh-btw-blink{50%{opacity:0}}",
      ".dsh-btw-a.is-clamped .dsh-btw-md{position:relative;max-height:320px;overflow:hidden;}",
      '.dsh-btw-a.is-clamped .dsh-btw-md::after{content:"";position:absolute;left:0;right:0;bottom:0;height:56px;background:linear-gradient(transparent,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas)));pointer-events:none;}',
      // ---- composer --------------------------------------------------------
      ".dsh-btw-composer{flex:none;display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));}",
      ".dsh-btw-composer-label{color:var(--dsw-alias-label-tertiary,GrayText);font-size:10.5px;letter-spacing:.5px;}",
      ".dsh-btw-select{flex:1 1 auto;min-width:0;height:28px;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:inherit;font-size:11.5px;}",
      ".dsh-btw-input{flex:1 1 auto;min-width:0;resize:vertical;min-height:48px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:inherit;}",
      ".dsh-btw-setrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0;}",
      ".dsh-btw-setlabel{min-width:0;color:var(--dsw-alias-label-secondary,GrayText);}",
    ].join("");

    /** @param {any} ctx @param {string} name */
    function serviceOf(ctx, name) {
      try {
        if (typeof ctx?.get === "function") return ctx.get(name);
      } catch {
        /* 服务未挂载 */
      }
      try {
        return ctx?.[name];
      } catch {
        return undefined;
      }
    }

    /** @param {string} template @param {Record<string, string|number>} values */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (m, k) =>
        Object.hasOwn(values, k) ? String(values[k]) : m,
      );
    }

    // ---- 自适应格式化（与 lib/format.js 行为等价；client 是 classic script，无法 import）--
    const TOKEN_UNITS = [
      { scale: 1e3, suffix: "K" },
      { scale: 1e6, suffix: "M" },
      { scale: 1e9, suffix: "B" },
      { scale: 1e12, suffix: "T" },
    ];
    /** @param {number} value */
    const oneDecimal = (value) => (Math.round(value * 10) / 10).toFixed(1).replace(/\.0+$/u, "");
    /** @param {number} value */
    const scaledText = (value) => (value < 100 ? oneDecimal(value) : String(Math.round(value)));

    /** @param {unknown} value */
    function formatTokens(value) {
      const number = Math.max(0, Math.round(Number(value) || 0));
      if (number < 1000) return String(number);
      let index = 0;
      for (let i = 0; i < TOKEN_UNITS.length; i += 1) {
        if (number >= TOKEN_UNITS[i].scale) index = i;
      }
      let unit = TOKEN_UNITS[index];
      let scaled = number / unit.scale;
      if (index < TOKEN_UNITS.length - 1 && scaled >= 999.5) {
        index += 1;
        unit = TOKEN_UNITS[index];
        scaled = number / unit.scale;
      }
      return `${scaledText(scaled)}${unit.suffix}`;
    }

    /** @param {unknown} value */
    function formatDuration(value) {
      const ms = Math.max(0, Math.round(Number(value) || 0));
      if (ms < 1000) return `${ms}ms`;
      const seconds = ms / 1000;
      if (seconds < 59.95) return `${scaledText(seconds)}s`;
      const minutes = seconds / 60;
      if (minutes < 59.95) return `${scaledText(minutes)}m`;
      return `${scaledText(minutes / 60)}h`;
    }

    // ---- Markdown：host 已解析成 JSON 树，这里只做元素映射 --------------------
    /** @param {any[]} runs @param {string} prefix @returns {any[]} */
    function renderInlines(runs, prefix) {
      /** @type {any[]} */
      const out = [];
      const list = Array.isArray(runs) ? runs : [];
      for (let index = 0; index < list.length; index += 1) {
        const run = list[index];
        const key = `${prefix}i${index}`;
        if (run?.type === "code") {
          out.push(h("code", { key, className: "dsh-btw-inline-code" }, String(run.text ?? "")));
          continue;
        }
        if (run?.type === "strong" || run?.type === "em" || run?.type === "del") {
          const tag = run.type === "strong" ? "strong" : run.type === "em" ? "em" : "del";
          out.push(h(tag, { key }, ...renderInlines(run.children, key)));
          continue;
        }
        if (run?.type === "link") {
          const href = String(run.href ?? "");
          if (!/^(https?:\/\/|mailto:)/iu.test(href)) {
            out.push(h(React.Fragment, { key }, ...renderInlines(run.children, key)));
          } else {
            out.push(
              h(
                "a",
                {
                  key,
                  className: "dsh-btw-link",
                  href,
                  target: "_blank",
                  rel: "noreferrer noopener",
                  "data-btw-link": "true",
                },
                ...renderInlines(run.children, key),
              ),
            );
          }
          continue;
        }
        // 普通文本：段内换行保留成 <br>（模型答案里常靠单换行分行）。
        const text = String(run?.text ?? "");
        const pieces = text.split("\n");
        for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
          if (pieceIndex > 0) out.push(h("br", { key: `${key}b${pieceIndex}` }));
          if (pieces[pieceIndex] !== "")
            out.push(h(React.Fragment, { key: `${key}t${pieceIndex}` }, pieces[pieceIndex]));
        }
      }
      return out;
    }

    /**
     * @param {any[]} blocks
     * @param {boolean} streaming
     * @param {string} [prefix]
     * @returns {any[]}
     */
    function renderBlocks(blocks, streaming, prefix = "b") {
      /** @type {any[]} */
      const out = [];
      const list = Array.isArray(blocks) ? blocks : [];
      for (let index = 0; index < list.length; index += 1) {
        const block = list[index];
        const key = `${prefix}${index}`;
        switch (block?.type) {
          case "heading": {
            const level = Math.min(6, Math.max(1, Number(block.level) || 2));
            out.push(h(`h${level}`, { key }, ...renderInlines(block.inlines, `${key}i`)));
            break;
          }
          case "paragraph":
            out.push(h("p", { key }, ...renderInlines(block.inlines, `${key}i`)));
            break;
          case "code":
            out.push(
              h(
                "div",
                { key, className: "dsh-btw-codeblock", "data-btw-code": "true" },
                block.lang
                  ? h("div", { className: "dsh-btw-codeblock-lang" }, String(block.lang))
                  : null,
                h("pre", null, h("code", null, String(block.code ?? ""))),
              ),
            );
            break;
          case "list": {
            const items = Array.isArray(block.items) ? block.items : [];
            out.push(
              h(
                block.ordered ? "ol" : "ul",
                { key, start: block.ordered ? Number(block.start) || 1 : undefined },
                ...items.map((/** @type {any} */ item, /** @type {number} */ itemIndex) =>
                  h(
                    "li",
                    { key: `${key}-${itemIndex}` },
                    ...renderInlines(item?.inlines, `${key}-${itemIndex}i`),
                  ),
                ),
              ),
            );
            break;
          }
          case "quote":
            out.push(h("blockquote", { key }, ...renderBlocks(block.blocks, streaming, `${key}q`)));
            break;
          case "table": {
            const align = Array.isArray(block.align) ? block.align : [];
            const header = Array.isArray(block.header) ? block.header : [];
            const rows = Array.isArray(block.rows) ? block.rows : [];
            out.push(
              h(
                "div",
                { key, className: "dsh-btw-tablewrap" },
                h(
                  "table",
                  null,
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      { key: `${key}h` },
                      ...header.map((/** @type {any} */ cell, /** @type {number} */ cellIndex) =>
                        h(
                          "th",
                          { key: `${key}h${cellIndex}`, style: cellStyle(align[cellIndex]) },
                          ...renderInlines(cell, `${key}h${cellIndex}i`),
                        ),
                      ),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...rows.map((/** @type {any} */ row, /** @type {number} */ rowIndex) =>
                      h(
                        "tr",
                        { key: `${key}r${rowIndex}` },
                        ...(Array.isArray(row) ? row : []).map((cell, cellIndex) =>
                          h(
                            "td",
                            {
                              key: `${key}r${rowIndex}c${cellIndex}`,
                              style: cellStyle(align[cellIndex]),
                            },
                            ...renderInlines(cell, `${key}r${rowIndex}c${cellIndex}i`),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            break;
          }
          case "hr":
            out.push(h("hr", { key }));
            break;
          default: {
            const text = String(block?.text ?? "");
            if (text !== "") out.push(h("p", { key }, text));
          }
        }
      }
      if (streaming)
        out.push(h("span", { key: "caret", className: "dsh-btw-caret", "aria-hidden": "true" }));
      return out;
    }

    /** @param {any} align */
    function cellStyle(align) {
      return align === "center"
        ? { textAlign: "center" }
        : align === "right"
          ? { textAlign: "right" }
          : undefined;
    }

    /**
     * 一条答案的 Markdown 容器；超长时折叠，点「展开全文」再放开。
     * @param {any} props
     */
    function MarkdownBody(props) {
      const { blocks, streaming, clamped } = props;
      return h(
        "div",
        {
          className: `dsh-btw-a${clamped ? " is-clamped" : ""}`,
          "data-btw-answer": "true",
          "data-btw-md": "true",
        },
        h("div", { className: "dsh-btw-md" }, ...renderBlocks(blocks, streaming === true)),
      );
    }

    /** 一次 RPC 失败原因（诊断用，渲染进 data-btw-error）。 */
    let lastRpcError = "";

    exports.inject = ["slots", "locale", "connection", "sessions"];
    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "btw: dictionaries");
      /** @type {any} */
      let t;
      try {
        t = ctx.locale.bind(NS);
      } catch {
        t = (/** @type {string} */ key) => key;
      }

      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = PLUGIN_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "btw: styles");

      /**
       * 按钮（composer 工具行）与抽屉（`shell.overlay`）是两个独立组件实例，
       * 共享状态必须提升到 apply 作用域。
       *
       * 为什么抽屉仍挂 `shell.overlay`：`conversation.input.overlay` 在 composer 内部，
       * 会被裁剪；`shell.overlay` 是 frame-wide 浮层，定位从根上可靠，且不改变布局
       * （不会像右侧边栏那样把主对话挤窄）。
       */
      const store = (() => {
        /** @type {{ open: boolean, collapsed: boolean, sessionId: string }} */
        let state = { open: false, collapsed: false, sessionId: "" };
        /** @type {Set<() => void>} */
        const listeners = new Set();
        return {
          get: () => state,
          patch(
            /** @type {Partial<{ open: boolean, collapsed: boolean, sessionId: string }>} */ next,
          ) {
            state = { ...state, ...next };
            for (const listener of listeners) listener();
          },
          subscribe(/** @type {() => void} */ listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
      })();

      /** 订阅 store 的极简 hook。 */
      const useStore = () => {
        const [, force] = React.useState(0);
        React.useEffect(() => store.subscribe(() => force((/** @type {number} */ n) => n + 1)), []);
        return store.get();
      };

      /** 当前界面语言（转正草稿用）。取不到默认 zh。 */
      const langOf = () => {
        try {
          const docLang = String(document?.documentElement?.lang ?? "").toLowerCase();
          if (docLang.startsWith("en")) return "en";
          if (docLang.startsWith("zh")) return "zh";
        } catch {
          /* 忽略 */
        }
        return "zh";
      };

      /** Typert Remote 调用；解 { ok, value } 信封，失败返回 undefined。 */
      const callRemote = (/** @type {string} */ method, /** @type {any} */ request) => {
        const connection = serviceOf(ctx, "connection");
        const channel = connection?.rpc;
        if (!channel || typeof channel.call !== "function") return Promise.resolve(undefined);
        const payload = request === undefined ? { args: {} } : { args: { request } };
        try {
          return Promise.resolve(channel.call("/api", `btw/${method}`, payload)).then(
            (/** @type {any} */ result) => {
              if (result && typeof result === "object" && Object.hasOwn(result, "value")) {
                lastRpcError = "";
                return result.value;
              }
              lastRpcError = `no-value:${JSON.stringify(result).slice(0, 160)}`;
              return result;
            },
            (/** @type {any} */ error) => {
              lastRpcError = `reject:${String(error?.message ?? error).slice(0, 160)}`;
              return undefined;
            },
          );
        } catch (error) {
          lastRpcError = `throw:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`;
          return Promise.resolve(undefined);
        }
      };

      /** 输入框 façade（与 next-step 同形：先 shell(sessionId)，再 for(scope)）。 */
      const shellOf = (/** @type {string} */ sessionId) => {
        if (!sessionId) return undefined;
        try {
          const conversation = serviceOf(ctx, "conversation");
          const input = conversation?.input;
          if (!input) return undefined;
          if (typeof input.shell === "function") {
            try {
              const shell = input.shell(sessionId);
              if (shell) return shell;
            } catch {
              /* 退到 for(scope) */
            }
          }
          if (typeof input.for === "function") {
            const sessions = serviceOf(ctx, "sessions");
            const scope =
              sessions && typeof sessions.scope === "function"
                ? sessions.scope(sessionId)
                : undefined;
            if (scope !== undefined) return input.for(scope);
          }
        } catch {
          return undefined;
        }
        return undefined;
      };

      /** @param {any} shell */
      const shellDraftOf = (shell) => {
        try {
          const state = shell?.state;
          const snapshot =
            state && typeof state.getSnapshot === "function" ? state.getSnapshot() : undefined;
          if (snapshot && typeof snapshot.draft === "string") return snapshot.draft;
        } catch {
          return undefined;
        }
        return undefined;
      };

      /**
       * 等 setDraft 落定。
       * @param {() => (string | undefined)} readDraft
       * @param {string} text
       * @returns {Promise<boolean>}
       */
      const waitDraftSettled = (readDraft, text) =>
        new Promise((resolve) => {
          let tries = 0;
          const tick = () => {
            let draft;
            try {
              draft = readDraft();
            } catch {
              draft = undefined;
            }
            if (draft === text) return resolve(true);
            tries += 1;
            if (tries >= DRAFT_POLL_TRIES) return resolve(false);
            setTimeout(tick, DRAFT_POLL_INTERVAL_MS);
          };
          tick();
        });

      /**
       * 把文本塞进 composer 并提交。绝不提交不是我们写的那段文本。
       * @param {string} sessionId
       * @param {string} text
       * @returns {Promise<'ok' | 'empty' | 'no-composer' | 'not-settled'>}
       */
      const sendText = async (sessionId, text) => {
        if (typeof text !== "string" || text === "") return "empty";
        const shell = shellOf(sessionId);
        const actions = shell?.actions;
        if (!actions || typeof actions.setDraft !== "function") return "no-composer";
        try {
          actions.setDraft(text);
        } catch {
          return "no-composer";
        }
        const settled = await waitDraftSettled(() => shellDraftOf(shell), text);
        if (!settled && shellDraftOf(shell) !== text) return "not-settled";
        try {
          if (typeof actions.submit === "function") actions.submit();
        } catch {
          return "not-settled";
        }
        return "ok";
      };

      /**
       * composer 工具行里的「旁问」按钮。
       *
       * 它同时负责把当前 sessionId 写进 store —— 抽屉注册在 root scope 的
       * `shell.overlay` 上，拿不到 session props，只能由按钮转交。
       */
      function BtwTrigger(/** @type {any} */ props) {
        const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
        const shared = useStore();
        React.useEffect(() => {
          if (shared.sessionId !== sessionId) store.patch({ sessionId });
        }, [sessionId, shared.sessionId]);
        const toggle = () => {
          const current = store.get();
          if (!current.open) store.patch({ open: true, collapsed: false });
          else if (current.collapsed) store.patch({ collapsed: false });
          else store.patch({ open: false });
        };
        return h(
          "button",
          {
            type: "button",
            className: "dsh-btw-btn",
            "data-btw-toggle": "true",
            title: t("button"),
            onClick: toggle,
          },
          t("button"),
        );
      }

      /** 右侧抽屉：聊天式线程列表 + 流式卡片 + 发问/追问/转正。 */
      function BtwPanel(/** @type {any} */ props) {
        void props;
        const shared = useStore();
        const open = shared.open;
        const collapsed = shared.collapsed;
        const sessionId = shared.sessionId;
        const [threads, setThreads] = React.useState(/** @type {any[] | null} */ (null));
        const [liveRuns, setLiveRuns] = React.useState(/** @type {any[]} */ ([]));
        const [failed, setFailed] = React.useState(false);
        const [activeId, setActiveId] = React.useState("");
        const [question, setQuestion] = React.useState("");
        const [followQuestion, setFollowQuestion] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const [badge, setBadge] = React.useState("");
        const [scope, setScope] = React.useState("");
        const [expandedAnswers, setExpandedAnswers] = React.useState(
          /** @type {Record<string, boolean>} */ ({}),
        );
        const aliveRef = React.useRef(true);
        const liveRef = React.useRef(/** @type {any[]} */ ([]));
        const scrollRef = React.useRef(/** @type {any} */ (null));
        const pinnedRef = React.useRef(true);

        React.useEffect(
          () => () => {
            aliveRef.current = false;
          },
          [],
        );

        // 切会话：清空上一会话的列表与流式现场。
        React.useEffect(() => {
          setThreads(null);
          setLiveRuns([]);
          liveRef.current = [];
          setActiveId("");
          setFollowQuestion("");
          setNotice("");
          pinnedRef.current = true;
        }, [sessionId]);

        /**
         * 拉线程列表。quiet = 后台轮询：失败不把界面打红。
         * @param {boolean} [quiet]
         * @returns {Promise<any[] | null>}
         */
        const loadThreads = React.useCallback(
          (quiet = false) =>
            callRemote("threads", { sessionId, limit: LIMITS_CLIENT_THREADS }).then((value) => {
              if (!aliveRef.current) return null;
              if (Array.isArray(/** @type {any} */ (value))) {
                setThreads(value);
                setFailed(false);
                return /** @type {any[]} */ (value);
              }
              if (!quiet) {
                setThreads([]);
                setFailed(true);
              }
              return null;
            }),
          [sessionId],
        );

        React.useEffect(() => {
          if (!open) return undefined;
          const scopeLabel =
            scope === ""
              ? ""
              : t(
                  scope === "session"
                    ? "scopeSession"
                    : scope === "recent"
                      ? "scopeRecent"
                      : "scopeSelection",
                ).replace(/^范围：|^Scope:\s*/i, "");
          callRemote("stats", { sessionId, scope: scopeLabel, lang: langOf() }).then((value) => {
            if (!aliveRef.current) return;
            if (value && typeof value.badge === "string") setBadge(value.badge);
          });
          return undefined;
        }, [open, sessionId, scope]);

        // 打开/切会话时先读一次历史。
        React.useEffect(() => {
          if (!open) return undefined;
          void loadThreads();
          return undefined;
        }, [open, loadThreads]);

        // 流式与后台刷新：面板打开期间常驻。有 run 时 350ms 一次、空闲 1s 一次；
        // 空闲时每 4 次才刷一次线程列表，避免无谓 RPC。
        React.useEffect(() => {
          if (!open) return undefined;
          let cancelled = false;
          /** @type {any} */
          let timer;
          let ticks = 0;
          const tick = async () => {
            if (cancelled) return;
            /** @type {any[]} */
            let runs = [];
            try {
              const value = await callRemote("live", { sessionId });
              if (Array.isArray(value?.runs)) runs = value.runs;
            } catch {
              runs = [];
            }
            if (cancelled) return;
            const hadLive = liveRef.current.length > 0;
            const hasLive = runs.length > 0;
            liveRef.current = runs;
            // 空闲轮询（无 run）不重复 set 空数组，省掉每秒一次无意义的重渲染。
            if (hasLive || hadLive) setLiveRuns(runs);
            // 只在 live 结束后刷一次历史（run 进行中 threads 不会变，少传大 payload）。
            if (hadLive && !hasLive) void loadThreads(true);
            else if (!hasLive && ticks % LIVE_IDLE_REFRESH_EVERY === 0) void loadThreads(true);
            ticks += 1;
            if (!cancelled)
              timer = setTimeout(tick, runs.length > 0 ? LIVE_ACTIVE_MS : LIVE_IDLE_MS);
          };
          timer = setTimeout(tick, 200);
          return () => {
            cancelled = true;
            clearTimeout(timer);
          };
        }, [open, sessionId, loadThreads]);

        // Esc：收起抽屉（保持「点开/收起」的手感，和原来的 Esc 关闭一致）。
        React.useEffect(() => {
          if (!open) return undefined;
          const onKey = (/** @type {any} */ event) => {
            if (event?.key === "Escape") store.patch({ open: false });
          };
          document.addEventListener("keydown", onKey);
          return () => document.removeEventListener("keydown", onKey);
        }, [open]);

        // 自动滚到底：只有用户本来就在底部时才跟随（向上翻历史时不抢滚动条）。
        const onScroll = () => {
          const el = scrollRef.current;
          if (!el) return;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        };
        React.useEffect(() => {
          const el = scrollRef.current;
          if (!el || !pinnedRef.current) return;
          el.scrollTop = el.scrollHeight;
        }, [threads, liveRuns, open, collapsed]);

        // 展开抽屉/首次打开时强制回到底部（聊天式界面最新在下面）。
        React.useEffect(() => {
          if (!open || collapsed) return;
          pinnedRef.current = true;
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }, [open, collapsed]);

        const metaTextOf = (/** @type {any} */ cost, /** @type {number} */ ms) => {
          if (cost && typeof cost === "object") {
            return fmt(t("cost"), {
              newTokens: formatTokens(cost.inputTokens),
              cachedTokens: formatTokens(cost.cacheReadTokens),
              ms: formatDuration(ms),
            });
          }
          return ms > 0 ? formatDuration(ms) : "";
        };

        /**
         * 发问 / 追问：新线程走 `/btw <q>`；追问走 `/btw --thread <id> <q>`，
         * 并在提交前把参数登记到 host（这样 composer 里只出现裸 `/btw`）。
         * @param {string} threadId
         */
        const submit = async (threadId) => {
          const text = (threadId === "" ? question : followQuestion).trim();
          if (text === "" || busy) return;
          setBusy(true);
          setNotice(t("sending"));
          const beforeThreads = Array.isArray(threads) ? threads : [];
          const beforeCount = beforeThreads.length;
          const beforeTurns = Number(
            beforeThreads.find((/** @type {any} */ entry) => entry?.threadId === threadId)?.turns ??
              0,
          );
          const flags = [
            threadId === "" ? "" : `--thread ${threadId}`,
            scope === "" ? "" : `--scope ${scope}`,
          ]
            .filter(Boolean)
            .join(" ");
          let line = flags === "" ? `/btw ${text}` : `/btw ${flags} ${text}`;
          if (threadId !== "") {
            const queued = await callRemote("queueFollowUp", {
              sessionId,
              threadId,
              question: text,
              scope,
            }).catch(() => undefined);
            if (queued?.ok === true) line = "/btw";
          }
          try {
            const result = await sendText(sessionId, line);
            if (result !== "ok") {
              setNotice(t("sendFailed"));
              return;
            }
            if (threadId === "") setQuestion("");
            else {
              setFollowQuestion("");
              setActiveId("");
            }
            setNotice(t("sent"));
            // 轮询到「线程数增加 / 轮数增加」为止，最长 REFRESH_MAX_MS；单次失败不中断。
            const deadline = Date.now() + REFRESH_MAX_MS;
            let refreshed = false;
            while (Date.now() < deadline && aliveRef.current) {
              await new Promise((resolve) => setTimeout(resolve, REFRESH_INTERVAL_MS));
              if (!aliveRef.current) break;
              /** @type {any[] | null} */
              let next = null;
              try {
                next = await loadThreads(true);
              } catch {
                next = null;
              }
              if (next === null) continue;
              if (threadId === "") {
                if (next.length > beforeCount) {
                  refreshed = true;
                  break;
                }
              } else {
                const target = next.find(
                  (/** @type {any} */ entry) => entry?.threadId === threadId,
                );
                if (Number(target?.turns ?? 0) > beforeTurns) {
                  refreshed = true;
                  break;
                }
              }
            }
            setNotice(refreshed ? "" : t("sentPending"));
          } finally {
            if (aliveRef.current) setBusy(false);
          }
        };

        /**
         * 一键转正：取 host 生成的 Markdown 草稿，**只插进 composer，不发送**。
         * 输入框已有内容时拒绝，避免覆盖用户正在写的东西。
         * @param {any} thread
         */
        const promote = async (thread) => {
          if (busy) return;
          setBusy(true);
          setNotice("");
          const shell = shellOf(sessionId);
          const actions = shell?.actions;
          if (!actions || typeof actions.setDraft !== "function") {
            setBusy(false);
            setNotice(t("sendFailed"));
            return;
          }
          const existing = shellDraftOf(shell);
          if (typeof existing === "string" && existing.trim() !== "") {
            setBusy(false);
            setNotice(t("promoteBlocked"));
            return;
          }
          const result = await callRemote("promote", {
            sessionId,
            recordId: String(thread?.lastId ?? ""),
            lang: langOf(),
          });
          if (result?.ok !== true || typeof result?.text !== "string") {
            setBusy(false);
            setNotice(t("promoteFailed"));
            return;
          }
          try {
            actions.setDraft(result.text);
          } catch {
            setBusy(false);
            setNotice(t("promoteFailed"));
            return;
          }
          setBusy(false);
          setNotice(t("promoted"));
        };

        // 折叠按钮：展开/收起单条长答案。
        const toggleAnswer = (/** @type {string} */ key) =>
          setExpandedAnswers((/** @type {any} */ previous) => ({
            ...previous,
            [key]: !previous[key],
          }));

        /** @param {any} thread @param {number} index */
        const renderThread = (thread, index) => {
          const threadId = String(thread?.threadId ?? "");
          const items = Array.isArray(thread?.items) ? thread.items : [];
          const expanded = activeId === threadId;
          return h(
            "div",
            {
              className: "dsh-btw-thread",
              key: threadId === "" ? String(index) : threadId,
              "data-btw-thread": "true",
              "data-btw-thread-id": threadId,
            },
            ...items.map((/** @type {any} */ item, /** @type {number} */ itemIndex) => {
              const itemKey = `${threadId}:${String(item?.id ?? itemIndex)}`;
              const isLast = itemIndex === items.length - 1;
              const clamped = expandedAnswers[itemKey] !== true && Number(item?.chars ?? 0) > 400;
              return h(
                "div",
                { className: "dsh-btw-turn", key: itemKey, "data-btw-turn": "true" },
                String(item?.question ?? "") === ""
                  ? null
                  : h(
                      "div",
                      { className: "dsh-btw-q", "data-btw-question": "true" },
                      itemIndex === 0
                        ? null
                        : h("span", { className: "dsh-btw-q-label" }, t("followUpLabel")),
                      String(item.question),
                    ),
                h(MarkdownBody, { blocks: item?.blocks, streaming: false, clamped }),
                clamped
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-btw-btn",
                        "data-btw-expand": "true",
                        onClick: () => toggleAnswer(itemKey),
                      },
                      t("expandAnswer"),
                    )
                  : null,
                (() => {
                  const meta = metaTextOf(item?.cost, Number(item?.ms ?? 0));
                  return meta === ""
                    ? null
                    : h("div", { className: "dsh-btw-meta", "data-btw-meta": "true" }, meta);
                })(),
                isLast
                  ? h(
                      "div",
                      { className: "dsh-btw-row" },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "dsh-btw-btn",
                          "data-btw-followup": "true",
                          onClick: () => {
                            setActiveId(expanded ? "" : threadId);
                            setFollowQuestion("");
                          },
                        },
                        expanded ? t("collapseAnswer") : t("followUp"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "dsh-btw-btn",
                          "data-btw-promote": "true",
                          disabled: busy,
                          onClick: () => void promote(thread),
                        },
                        t("promote"),
                      ),
                    )
                  : null,
                expanded && isLast
                  ? h(
                      "div",
                      { className: "dsh-btw-row", "data-btw-thread-input": "true" },
                      h("textarea", {
                        className: "dsh-btw-input",
                        "data-btw-input": "true",
                        placeholder: t("followPlaceholder"),
                        value: followQuestion,
                        rows: 2,
                        onChange: (/** @type {any} */ event) =>
                          setFollowQuestion(String(event?.target?.value ?? "")),
                        onKeyDown: (/** @type {any} */ event) => {
                          if (event?.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void submit(threadId);
                          }
                        },
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "dsh-btw-btn",
                          "data-btw-send": "true",
                          disabled: busy || followQuestion.trim() === "",
                          onClick: () => void submit(threadId),
                        },
                        t("send"),
                      ),
                    )
                  : null,
              );
            }),
          );
        };

        /** 流式卡片：固定追加在列表最底部（最新一条），结束后由真实线程替换。 */
        const renderLive = (/** @type {any} */ run) => {
          const questionText = String(run?.question ?? "");
          const isFollowUp = (Array.isArray(threads) ? threads : []).some(
            (/** @type {any} */ thread) => thread?.threadId === run?.threadId,
          );
          return h(
            "div",
            {
              className: "dsh-btw-thread dsh-btw-live",
              key: `live:${String(run?.threadId ?? "")}`,
              "data-btw-live": "true",
              "data-btw-thread-id": String(run?.threadId ?? ""),
            },
            questionText === ""
              ? null
              : h(
                  "div",
                  { className: "dsh-btw-q", "data-btw-question": "true" },
                  isFollowUp
                    ? h("span", { className: "dsh-btw-q-label" }, t("followUpLabel"))
                    : null,
                  questionText,
                ),
            (() => {
              const blocks = Array.isArray(run?.blocks) ? run.blocks : [];
              return blocks.length === 0
                ? h("div", { className: "dsh-btw-dim", "data-btw-stream-text": "true" }, "…")
                : h(
                    "div",
                    {
                      className: "dsh-btw-a",
                      "data-btw-stream-text": "true",
                      "data-btw-md": "true",
                    },
                    h("div", { className: "dsh-btw-md" }, ...renderBlocks(blocks, true)),
                  );
            })(),
            h(
              "div",
              { className: "dsh-btw-meta", "data-btw-elapsed": "true" },
              `${t("streaming")} · ${formatDuration(run?.ms)}`,
            ),
          );
        };

        const known = threads ?? [];
        const list =
          threads === null && liveRuns.length === 0
            ? h("div", { className: "dsh-btw-dim" }, "…")
            : known.length === 0 && liveRuns.length === 0
              ? h("div", { className: "dsh-btw-dim", "data-btw-empty": "true" }, t("empty"))
              : [
                  ...known.map(renderThread),
                  ...liveRuns.map((/** @type {any} */ run) => renderLive(run)),
                ];

        if (!open) return null;

        if (collapsed) {
          return h(
            "button",
            {
              type: "button",
              className: "dsh-btw-rail",
              "data-btw-rail": "true",
              title: t("expand"),
              "aria-label": t("expand"),
              onClick: () => store.patch({ collapsed: false }),
            },
            h("span", null, t("button")),
            threads !== null && threads.length > 0
              ? h("span", { className: "dsh-btw-rail-count" }, String(threads.length))
              : null,
          );
        }

        // 有 live 卡片时不重复状态条：卡片里已经有「正在生成回答 · 12s」。
        const statusBusy = busy && liveRuns.length === 0;
        const statusText = busy ? `${t("sending")}（${t("waitHint")}）` : notice;

        return h(
          "span",
          { "data-btw-root": "true" },
          h(
            "div",
            {
              className: "dsh-btw-panel",
              "data-btw-overlay": "true",
              "data-btw-panel": "true",
              "data-btw-drawer": "true",
              role: "dialog",
              "aria-label": t("title"),
            },
            h(
              "div",
              { className: "dsh-btw-head" },
              h("span", { className: "dsh-btw-head-title" }, t("title")),
              threads !== null && threads.length > 0
                ? h(
                    "span",
                    { className: "dsh-btw-dim", "data-btw-count": "true" },
                    String(threads.length),
                  )
                : null,
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-btw-btn",
                  "data-btw-collapse": "true",
                  title: t("collapse"),
                  onClick: () => store.patch({ collapsed: true }),
                },
                t("collapseShort"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-btw-btn",
                  "data-btw-close": "true",
                  onClick: () => store.patch({ open: false }),
                },
                t("close"),
              ),
            ),
            statusBusy || notice !== ""
              ? h(
                  "div",
                  {
                    className: `dsh-btw-status${statusBusy ? " is-busy" : ""}`,
                    "data-btw-notice": "true",
                  },
                  statusBusy ? h("span", { className: "dsh-btw-spinner" }, "⟳") : null,
                  h("span", null, statusText),
                )
              : null,
            failed
              ? h(
                  "div",
                  { className: "dsh-btw-err", "data-btw-error": "history_unavailable" },
                  `${t("failed")} — ${lastRpcError}`,
                )
              : h(
                  "div",
                  {
                    className: "dsh-btw-scroll",
                    "data-btw-list": "true",
                    ref: scrollRef,
                    onScroll,
                  },
                  ...(Array.isArray(list) ? list : [list]),
                ),
            h(
              "div",
              { className: "dsh-btw-composer" },
              h("span", { className: "dsh-btw-composer-label" }, t("newQuestionLabel")),
              h("textarea", {
                className: "dsh-btw-input",
                "data-btw-input": "true",
                placeholder: t("placeholder"),
                value: question,
                rows: 2,
                onChange: (/** @type {any} */ event) =>
                  setQuestion(String(event?.target?.value ?? "")),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event?.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit("");
                  }
                },
              }),
              h(
                "div",
                { className: "dsh-btw-row" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-btw-btn is-primary",
                    "data-btw-send": "true",
                    disabled: busy || question.trim() === "",
                    onClick: () => void submit(""),
                  },
                  t("send"),
                ),
                h(
                  "select",
                  {
                    className: "dsh-btw-select",
                    "data-btw-scope": "true",
                    value: scope,
                    onChange: (/** @type {any} */ event) =>
                      setScope(String(event?.target?.value ?? "")),
                  },
                  h("option", { value: "" }, t("scopeAny")),
                  h("option", { value: "session" }, t("scopeSession")),
                  h("option", { value: "recent" }, t("scopeRecent")),
                  h("option", { value: "selection" }, t("scopeSelection")),
                ),
              ),
              h("div", { className: "dsh-btw-meta", "data-btw-hint": "true" }, t("submitHint")),
              badge === ""
                ? null
                : h("div", { className: "dsh-btw-meta", "data-btw-badge": "true" }, badge),
            ),
          ),
        );
      }

      /** 设置分节（约定 §7.2：首屏 ≤3 行、可直改、无改动时禁用保存）。 */
      function BtwSettings(/** @type {any} */ props) {
        const api = props?.api;
        const [loaded, setLoaded] = React.useState(/** @type {any} */ (null));
        const [tools, setTools] = React.useState("");
        const [limit, setLimit] = React.useState("");
        const [saving, setSaving] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const [expanded, setExpanded] = React.useState(false);

        const hydrate = React.useCallback((/** @type {any} */ value) => {
          if (!value || typeof value !== "object") return;
          setLoaded(value);
          setTools(Array.isArray(value.allowedTools) ? value.allowedTools.join(", ") : "");
          setLimit(String(value.historyLimit ?? ""));
        }, []);

        React.useEffect(() => {
          const call = api && typeof api.settings === "function" ? api.settings : undefined;
          if (!call) return;
          Promise.resolve(call()).then((value) => hydrate(value));
        }, [api, hydrate]);

        const dirty =
          loaded !== null &&
          (tools !== (loaded.allowedTools ?? []).join(", ") ||
            limit !== String(loaded.historyLimit ?? ""));

        const save = async () => {
          const call =
            api && typeof api.updateSettings === "function" ? api.updateSettings : undefined;
          if (!call || saving) return;
          setSaving(true);
          setNotice("");
          const next = await Promise.resolve(
            call({ allowedTools: tools, historyLimit: Number(limit) }),
          ).catch(() => undefined);
          setSaving(false);
          if (next && typeof next === "object") {
            hydrate(next);
            setNotice(t("settings.saved"));
          } else {
            setNotice(t("settings.failed"));
          }
        };

        const row = (
          /** @type {string} */ label,
          /** @type {any} */ control,
          /** @type {string} */ hint,
        ) =>
          h(
            "div",
            { className: "dsh-btw-setrow" },
            h("span", { className: "dsh-btw-setlabel" }, label),
            control,
            hint === "" ? null : h("div", { className: "dsh-btw-meta" }, hint),
          );

        return h(
          "div",
          { "data-btw-settings": "true" },
          h(
            "div",
            { className: "dsh-btw-setrow" },
            h("span", { className: "dsh-btw-setlabel" }, t("settings.mode")),
            h(
              "span",
              { className: "dsh-btw-a" },
              loaded === null
                ? "…"
                : loaded.readOnly
                  ? t("settings.readOnly")
                  : `${loaded.allowedTools.length}`,
            ),
          ),
          row(
            t("settings.tools"),
            h("input", {
              className: "dsh-btw-input",
              "data-btw-setting-tools": "true",
              value: tools,
              placeholder: "read, grep",
              onChange: (/** @type {any} */ event) => setTools(String(event?.target?.value ?? "")),
            }),
            "",
          ),
          h(
            "div",
            { className: "dsh-btw-setrow" },
            h(
              "button",
              {
                type: "button",
                className: "dsh-btw-btn",
                "data-btw-settings-more": "true",
                onClick: () => setExpanded((/** @type {boolean} */ value) => !value),
              },
              t("settings.more"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-btw-btn",
                "data-btw-settings-save": "true",
                disabled: !dirty || saving,
                onClick: () => void save(),
              },
              t("settings.save"),
            ),
            notice === "" ? null : notice,
          ),
          expanded
            ? h(
                "div",
                { "data-btw-settings-extra": "true" },
                row(
                  t("settings.limit"),
                  h("input", {
                    className: "dsh-btw-input",
                    "data-btw-setting-limit": "true",
                    value: limit,
                    onChange: (/** @type {any} */ event) =>
                      setLimit(String(event?.target?.value ?? "")),
                  }),
                  "",
                ),
                h("div", { className: "dsh-btw-meta" }, t("settings.toolsHint")),
              )
            : null,
        );
      }

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "btw",
            order: 94,
            label: () => t("settings.nav"),
            locale: NS,
            inject: () => ({
              api: {
                settings: () => callRemote("settings", undefined),
                updateSettings: (/** @type {any} */ patch) => callRemote("updateSettings", patch),
              },
            }),
          },
          (/** @type {any} */ slotProps) => h(BtwSettings, slotProps),
        ),
      );

      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          { name: "conversation.input.left", id: "btw-toggle", order: 40, locale: NS },
          (/** @type {any} */ props) => h(BtwTrigger, props),
        ),
      );

      // 抽屉挂在 shell.overlay（frame-wide，所有列之上、滚动容器之外），不受 composer 裁剪。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "btw-panel", order: 60, locale: NS }, () =>
          h(BtwPanel, null),
        ),
      );
    };

    return module.exports;
  },
});
