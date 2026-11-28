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
    /** 抽屉列出的线程条数上限（host 还会按设置里的 historyLimit 再夹一次）。 */
    const LIMITS_CLIENT_THREADS = 20;
    /** 提交后轮询历史，等新记录出现；按实测 /btw 耗时（20–40s）给足 120s 窗口。 */
    const REFRESH_MAX_MS = 120_000;
    const REFRESH_INTERVAL_MS = 1200;
    /** 流式轮询间隔：有 run 时密一点，空闲时慢一点（只读一个内存快照，很便宜）。 */
    const LIVE_ACTIVE_MS = 350;
    const LIVE_IDLE_MS = 1000;
    /** 空闲时每 N 次 live 轮询才刷一次线程列表（约 4s）。 */
    const LIVE_IDLE_REFRESH_EVERY = 4;
    /**
     * `/btw` 可见回执的轮询间隔（USIM-U2-06）：host 在执行命令时就写一条内存通知
     * （begin/done/fail），client 轮询 `btw/notice` 画 toast；空白会话里命令卡片不渲染，
     * 这是唯一的即时反馈通道。1.5s 是「立刻看得见」和「别把 RPC 打满」的折中。
     */
    const NOTICE_POLL_MS = 1500;
    /** 面板刚挂载时的第一次回执轮询延迟（别和首屏渲染抢资源）。 */
    const NOTICE_FIRST_DELAY_MS = 300;
    /** 自动开面板后等多久检查 tab 是否真的渲染出来（宿主右栏在空白会话里可能拒绝 per-session tab）。 */
    const REVEAL_FALLBACK_MS = 700;
    /**
     * 设置分节「已保存」短暂态保留时长（ms）。生产 2500；单测通过 `__test.settingsSaveTiming`
     * 改短（[plugin-conventions §7.2.6]：保存结果必须在界面上看得见）。
     */
    const SETTINGS_SAVE_TIMING = { resetMs: 2500 };

    const zh = {
      button: "旁问",
      title: "旁问",
      subtitle: "最近的旁问",
      placeholder: "提一个只读旁问…",
      send: "提问",
      empty:
        "本会话还没有旁问。旁问是只读的：不打断主任务，也不写进主对话历史；在下面提一个，或直接用 /btw <问题>。",
      close: "关闭",
      collapse: "收起为侧边条",
      collapseShort: "收起",
      expand: "展开旁问",
      cost: "新增 {newTokens} · 命中缓存 {cachedTokens} · {ms}",
      costHint:
        "本会话上下文约 {pressure} tokens；旁问会 fork 整个会话，历史实测约为其 0.75–1.2 倍（约 {low}–{high} tokens）。缓存过期时可能按这个量级计费。",
      costLast: "上次实际 {tokens} tokens。",
      costHintTitle: "旁问会 fork 整个会话；这是按父会话上下文做的量级估算，不是精确账单。",
      failed: "读取旁问历史失败",
      sent: "已提交；答案会出现在本面板（主对话回显开启时也会同步）",
      followUp: "追问",
      followPlaceholder: "在这个线程里追问…",
      followUpLabel: "追问",
      followSend: "发送",
      followCancel: "取消追问",
      followInputLabel: "追问该线程",
      thinking: "思考中",
      threadCount: "{count} 个线程",
      resizeHint: "拖动右侧栏分隔条可调宽度；⌥⌘B 收起侧栏",
      panelOnlyToggle: "只在旁问面板显示答案",
      echoFailed: "保存失败，请重试",
      inputHint: "Enter 发送 · Shift+Enter 换行",
      "notice.running": "旁问已提交 · 正在等待答案…（通常 20–40 秒）",
      "notice.done": "旁问完成（{ms}），可在右侧栏查看",
      "notice.doneWithPreview": "旁问完成（{ms}）：{preview}",
      "notice.error": "旁问失败：{reason}",
      "notice.open": "打开旁问面板（点击这条提示也可以）",
      turns: "轮",
      promote: "转正",
      promoted: "已插入输入框草稿（未发送）",
      promotedShort: "已插入摘要草稿（未发送）；完整内容见右侧「旁问」面板",
      promoteHint: "插入摘要草稿；完整内容留在旁问面板",
      promoteFooter: "完整内容见右侧「旁问」面板。",
      promoteBlocked: "输入框已有内容，先清空再转正",
      promoteFailed: "生成转正草稿失败",
      sending: "正在等待答案…",
      streaming: "正在生成回答",
      waitHint: "通常 20–40 秒",
      sentPending: "命令已提交，答案稍后出现在本面板",
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
      "settings.limitHint":
        "1–200，默认 50。改小后旧记录不再展示，并在下一次旁问时从历史文件里裁掉。",
      "settings.more": "更多设置",
      "settings.save": "保存",
      "settings.saved": "已保存",
      "settings.saving": "保存中…",
      "settings.unsaved": "有未保存更改",
      "settings.failed": "保存失败",
      "settings.failedReason": "保存失败：宿主没有返回结果，可重试",
      "settings.mode": "模式",
      "settings.readOnly": "只读",
      "settings.echo": "主对话显示完整答案",
      "settings.bounded": "大会话用精简上下文（bounded）",
      "settings.boundedHint":
        "仅当会话上下文超过 400K tokens 时启用：只把最近 12 条消息交给 spawn 子代理。成本封顶，但可能答不全；默认关。",
      "settings.echoHint": "关闭后只在旁问面板展示，/btw 命令只回一行提示。",
    };
    const en = {
      button: "btw",
      title: "Side questions",
      subtitle: "Recent side questions",
      placeholder: "Ask a read-only side question…",
      send: "Ask",
      empty:
        "No side questions in this session yet. A side question is read-only: it does not interrupt the main task and is not added to the conversation history. Ask one below, or use /btw <question>.",
      close: "Close",
      collapse: "Collapse to side rail",
      collapseShort: "Collapse",
      expand: "Expand side questions",
      cost: "new {newTokens} · cached {cachedTokens} · {ms}",
      costHint:
        "This session's context is ~{pressure} tokens; a side question forks the whole session, and earlier runs actually used 0.75–1.2× that (~{low}–{high} tokens). If the cache expired, expect that order of magnitude.",
      costLast: "Last actual: {tokens} tokens.",
      costHintTitle:
        "A side question forks the whole session; this is an order-of-magnitude estimate from the parent context, not an exact bill.",
      failed: "Could not read side-question history",
      sent: "Submitted; the answer appears in this panel (and in the conversation when echo is on)",
      followUp: "Follow up",
      followPlaceholder: "Ask a follow-up in this thread…",
      followUpLabel: "Follow-up",
      followSend: "Send",
      followCancel: "Cancel follow-up",
      followInputLabel: "Follow up in this thread",
      thinking: "Thinking",
      threadCount: "{count} threads",
      resizeHint: "Drag the sidebar divider to resize; ⌥⌘B collapses the sidebar",
      panelOnlyToggle: "Answer only in this panel",
      echoFailed: "Save failed; try again",
      inputHint: "Enter sends · Shift+Enter for a new line",
      "notice.running": "Side question submitted · waiting for the answer… (usually 20–40s)",
      "notice.done": "Side answer ready ({ms}) — open the panel to read it",
      "notice.doneWithPreview": "Side answer ready ({ms}): {preview}",
      "notice.error": "Side question failed: {reason}",
      "notice.open": "Open the side-question panel (clicking this notice works too)",
      turns: "turns",
      promote: "Promote",
      promoted: "Inserted into the composer as a draft (not sent)",
      promotedShort:
        "Inserted a summary draft (not sent); the full answer is in the side-question panel",
      promoteHint: "Insert a summary draft; the full answer stays in the panel",
      promoteFooter: "Full answer is in the side-question panel.",
      promoteBlocked: "Composer already has content; clear it before promoting",
      promoteFailed: "Could not create the promotion draft",
      sending: "Waiting for the answer…",
      streaming: "Generating the answer",
      waitHint: "usually 20–40s",
      sentPending: "Command submitted; the answer will appear in this panel",
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
      "settings.bounded": "Use a trimmed context for very large sessions (bounded)",
      "settings.boundedHint":
        "Only when the session context exceeds 400K tokens: hand only the last 12 messages to a spawn child agent. Cost is capped, but older context may be missed; off by default.",
      "settings.limit": "Records kept per session",
      "settings.limitHint":
        "1–200, default 50. Lowering it hides older records and trims them from the history file on the next side question.",
      "settings.more": "More settings",
      "settings.save": "Save",
      "settings.saved": "Saved",
      "settings.saving": "Saving…",
      "settings.unsaved": "Unsaved changes",
      "settings.failed": "Save failed",
      "settings.failedReason": "Save failed: the host returned nothing — retry",
      "settings.mode": "Mode",
      "settings.readOnly": "read-only",
      "settings.echo": "Show full answer in the conversation",
      "settings.echoHint":
        "When off, the answer is only in the side-question panel; /btw returns one line.",
    };

    const CSS = [
      // ---- 通用按钮 --------------------------------------------------------
      ".dsh-btw-btn{height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;cursor:pointer;white-space:nowrap;}",
      ".dsh-btw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-btw-btn:disabled{opacity:.5;cursor:default;}",
      ".dsh-btw-btn.is-primary{background:var(--dsw-alias-button-primary-fill,#4f7cff);border-color:transparent;color:var(--dsw-alias-label-on-color,#fff);}",
      ".dsh-btw-btn.is-primary:hover{background:var(--dsw-alias-button-primary-hover,#4f7cff);color:var(--dsw-alias-label-on-color,#fff);}",
      // ---- 右侧抽屉 --------------------------------------------------------
      // 贴右边、避开顶部会话头和底部 composer。注意：DSH 的对话区是整宽的，
      // 抽屉仍会盖住主对话右侧约 400px（比居中弹窗好，但不是「完全不遮挡」）；
      // 完全不遮挡需要 DSH 原生右侧边栏（打开时主对话变窄）。
      ".dsh-btw-panel{position:fixed;right:12px;top:72px;bottom:140px;width:min(400px,calc(100vw - 24px));display:flex;flex-direction:column;min-height:0;z-index:2147482000;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.55;box-shadow:0 18px 48px rgba(0,0,0,.38);}",
      "@media (max-width:760px){.dsh-btw-panel{top:56px;bottom:150px;width:calc(100vw - 24px);}}",
      // 原生右侧栏 tab：填满 pane，不再 fixed / 不再自带卡片外壳（由右侧栏提供）。
      ".dsh-btw-panel.is-tab{position:static;inset:auto;width:100%;max-width:820px;margin:0 auto;height:100%;min-height:0;max-height:none;border:none;border-radius:0;box-shadow:none;padding:12px 14px;background:transparent;}",
      ".dsh-btw-rail{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147482000;display:flex;flex-direction:row;align-items:center;gap:6px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-right:none;border-radius:10px 0 0 10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;cursor:pointer;box-shadow:-2px 0 10px rgba(0,0,0,.22);}",
      ".dsh-btw-rail:hover{color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));}",
      ".dsh-btw-rail-count{font-size:10px;opacity:.75;font-variant-numeric:tabular-nums;}",
      // ---- 头部 / 状态 ------------------------------------------------------
      ".dsh-btw-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:600;flex:none;}",
      ".dsh-btw-head-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".dsh-btw-grow{flex:1 1 auto;}",
      ".dsh-btw-footer{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;}",
      ".dsh-btw-echo{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,GrayText);cursor:pointer;}",
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
      ".dsh-btw-cost-hint{margin:0 0 8px;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-state-warn-primary,#b8860b);font-size:11.5px;line-height:1.5;}",
      // ---- 执行回执 toast（USIM-U2-06）-------------------------------------
      // 顶部居中、不盖 composer / 右侧栏按钮；tray 常驻（aria-live）便于屏幕阅读器，
      // 只有真的通知时才有子节点。宿主没有 toast 服务（runtime rc.5 §16），自绘并挂
      // 在 shell.overlay —— 与 advisor 的做法一致。
      ".dsh-btw-toast-tray{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147482001;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:min(560px,calc(100vw - 32px));pointer-events:none;}",
      ".dsh-btw-toast{display:flex;align-items:flex-start;gap:8px;max-width:100%;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-toast-label,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));box-shadow:0 10px 30px rgba(0,0,0,.28);font-size:12.5px;line-height:1.5;pointer-events:auto;cursor:pointer;}",
      ".dsh-btw-toast:hover{filter:brightness(1.06);}",
      // B7（复审）：toast 是 keyboard-reachable 的按钮，键盘聚焦要有可见环。
      ".dsh-btw-toast:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#2f6fed);outline-offset:2px;}",
      ".dsh-btw-toast-mark{flex:none;font-weight:600;line-height:1.4;}",
      ".dsh-btw-toast-text{flex:1 1 auto;min-width:0;word-break:break-word;white-space:pre-wrap;}",
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
      // 设置保存状态（§7.2.6）：clean/dirty/saving/saved/error 五态都有可见文案与颜色。
      ".dsh-btw-save-status{font-size:11.5px;color:var(--dsw-alias-label-tertiary,GrayText);}",
      '.dsh-btw-save-status[data-state="saved"]{color:var(--dsw-alias-state-success-primary,#2f9e63);}',
      '.dsh-btw-save-status[data-state="dirty"]{color:var(--dsw-alias-state-warn-primary,#b8860b);}',
      '.dsh-btw-save-status[data-state="error"]{color:var(--dsw-alias-state-error-primary,#d9534f);}',
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

    // ---- 输入 / 回执的纯逻辑（单测用 node:vm 直接跑真实 client.js，不复制一份）----

    /**
     * 旁问输入框的 Enter 语义（USIM-U2-13）。
     *
     * Enter 发送、Shift+Enter 换行、⌘/Ctrl+Enter 也发送；**输入法组字中**按 Enter 是
     * 「确认候选」，绝不能当成发送（中文用户必踩）。
     *
     * React 合成事件在部分浏览器/IME 上不暴露 `isComposing`（复审 B2），所以判据与
     * projects 的 `isImeConfirmKey` 对齐：合成事件 → `nativeEvent` → keyCode/which 229
     * （旧 IME）→ `key === "Process"` → composition 期间的 ref 标记。
     * @param {any} event
     * @param {{active?: boolean}|null|undefined} [ime] 组字期间的 ref 快照
     * @returns {boolean}
     */
    function shouldSubmitOnKey(event, ime) {
      if (event === null || typeof event !== "object") return false;
      if (event.isComposing === true) return false;
      if (event.nativeEvent && event.nativeEvent.isComposing === true) return false;
      if (Number(event.keyCode) === 229 || Number(event.which) === 229) return false;
      if (event.key === "Process") return false;
      if (ime && ime.active === true) return false;
      if (event.key !== "Enter") return false;
      if (event.shiftKey === true) return false;
      return true;
    }

    /**
     * 会话是否停在**空白/首启**态：宿主的命令卡片在这个阶段一个都不渲染
     * （docs/runtime 0.2.2-rc.5 §5.2），只有这时才值得替它把旁问面板自动打开。
     * @param {{ phase?: string, chatRows?: number } | null | undefined} snapshot
     * @returns {boolean}
     */
    function isBlankConversation(snapshot) {
      const rows = Math.max(0, Math.trunc(Number(snapshot?.chatRows) || 0));
      if (rows > 0) return false;
      const phase = String(snapshot?.phase ?? "");
      return phase === "" || phase === "hero" || phase === "blank";
    }

    /**
     * 回退抽屉是否该渲染（复审 B1 的核心判定）。
     *
     * 抽屉是「宿主没有右侧栏服务」时的兜底形态；但右侧栏服务在、`openTab` 抛错或打开后
     * 仍没有面板时，也必须降级到抽屉（`drawerFallback`），否则用户只看到一条 toast、
     * 面板永远不会出现。抽成纯函数是为了让单测钉得住这条（而不是只读源码字符串）。
     * @param {{ open?: boolean, drawerFallback?: boolean } | null | undefined} shared
     * @param {boolean} tabReady
     * @returns {boolean}
     */
    function shouldRenderDrawer(shared, tabReady) {
      if (shared === null || typeof shared !== "object") return false;
      if (shared.open !== true) return false;
      return tabReady !== true || shared.drawerFallback === true;
    }

    /**
     * 通知去重 + 动作规划：`seq` 全局单调递增，轮询会重复读到同一条。
     *
     * 首帧（`prevSeq` 为空）只建基线：**历史通知不回放**（别在重开页面时补弹旧的完成 toast），
     * 但「正在进行中」的那条仍要提示 —— 它不是回放，是当前状态。
     * @param {number | undefined | null} prevSeq
     * @param {any} notice
     * @returns {{ seq: number | undefined, show: boolean }}
     */
    function planNotice(prevSeq, notice) {
      const seq = Number(notice?.seq);
      if (!Number.isFinite(seq) || seq <= 0) return { seq: prevSeq ?? undefined, show: false };
      const state = String(notice?.state ?? "");
      const known = prevSeq === undefined || prevSeq === null;
      if (known) return { seq, show: state === "running" };
      if (seq <= prevSeq) return { seq: prevSeq, show: false };
      if (state !== "running" && state !== "done" && state !== "error") {
        return { seq, show: false };
      }
      return { seq, show: true };
    }

    /**
     * 通知 → toast：进行中常驻（等待期间不能自己消失），完成带耗时 + 答案预览，
     * 失败带宿主给的原因。
     * @param {any} notice
     * @param {(key: string) => string} tLocale
     * @returns {{ tone: string, text: string, autoHideMs: number } | null}
     */
    function composeNoticeToast(notice, tLocale) {
      const state = String(notice?.state ?? "");
      if (state === "running") {
        return { tone: "info", text: String(tLocale("notice.running")), autoHideMs: 0 };
      }
      if (state === "done") {
        const ms = formatDuration(notice?.ms);
        const preview = String(notice?.preview ?? "").trim();
        return {
          tone: "ok",
          text:
            preview === ""
              ? fmt(tLocale("notice.done"), { ms })
              : fmt(tLocale("notice.doneWithPreview"), { ms, preview }),
          autoHideMs: 8000,
        };
      }
      if (state === "error") {
        const reason = String(notice?.text ?? "").trim();
        const template = tLocale("notice.error");
        return {
          tone: "error",
          text: reason === "" ? template : fmt(template, { reason }),
          autoHideMs: 12000,
        };
      }
      return null;
    }

    /**
     * 终态回执的动作：`show` = 弹/换 toast、`dismiss` = 撤掉屏幕上的提示、`none` = 不动。
     *
     * 关键一条：**面板已经把答案显示出来时必须撤掉「正在等待」的常驻 toast**，
     * 否则用户会看到一条永远停在「已提交 · 正在等待答案…」的提示（面板里答案其实早到了）。
     * @param {any} notice
     * @param {boolean} show planNotice 的结论（这条回执是不是新的）
     * @param {boolean} panelVisible 面板是否已经在显示这次旁问
     * @returns {"show" | "dismiss" | "none"}
     */
    function noticeAction(notice, show, panelVisible) {
      if (!show) return "none";
      const state = String(notice?.state ?? "");
      if (state === "error") return "show";
      if (state === "done") return panelVisible ? "dismiss" : "show";
      if (state === "running") return panelVisible ? "dismiss" : "show";
      return "none";
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
      const { blocks, streaming, clamped, answerId } = props;
      return h(
        "div",
        {
          className: `dsh-btw-a${clamped ? " is-clamped" : ""}`,
          "data-btw-answer": "true",
          "data-btw-md": "true",
          ...(typeof answerId === "string" && answerId !== ""
            ? { "data-btw-answer-id": answerId }
            : {}),
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
        /**
         * `drawerFallback`：右栏服务在、但 `openTab` 抛错 / 打开后 700ms 仍没有面板时，显式
         * 退回浮层抽屉。以前只 patch `open:true`，而抽屉要求 `!tabReady`，于是「回退」这条
         * 分支永远渲染不出东西（复审 B1）——降级标记必须跟着状态一起走。
         * @type {{ open: boolean, collapsed: boolean, sessionId: string, drawerFallback: boolean }}
         */
        let state = { open: false, collapsed: false, sessionId: "", drawerFallback: false };
        /** @type {Set<() => void>} */
        const listeners = new Set();
        return {
          get: () => state,
          patch(
            /**
             * @type {Partial<{ open: boolean, collapsed: boolean, sessionId: string,
             * drawerFallback: boolean }>}
             */
            next,
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

      /**
       * 原生右侧栏是否可用：注册成功后才走 tab 形态，否则回退到浮层抽屉。
       * 这样同一份 client 能同时兼容「右侧栏服务在」与「只有 shell.overlay」的宿主。
       */
      let tabReady = false;

      /** 订阅 store 的极简 hook。 */
      const useStore = () => {
        const [, force] = React.useState(0);
        React.useEffect(() => store.subscribe(() => force((/** @type {number} */ n) => n + 1)), []);
        return store.get();
      };

      /**
       * 打开「旁问」面板的唯一实现：输入框旁的按钮、toast 点击、回执自动打开共用。
       * 首选 DSH 原生右侧栏 tab（不遮挡主对话）；宿主没有右栏服务时退到浮层抽屉。
       * @returns {boolean} 是否走了右栏
       */
      const openSidebarTab = () => {
        if (!tabReady) return false;
        const sidebarRight = serviceOf(ctx, "sidebarRight");
        if (!sidebarRight || typeof sidebarRight.openTab !== "function") return false;
        try {
          // 侧栏已被收起时，openTab 只会 focus 已存在的 tab、不会展开栏，
          // 所以先显式展开（track=true、非 fullscreen），再打开/聚焦 tab。
          const layout = serviceOf(ctx, "layout");
          if (layout && typeof layout.openRightbar === "function") {
            try {
              layout.openRightbar(true, false);
            } catch {
              /* 展开失败不阻塞打开 */
            }
          }
          sidebarRight.openTab("btw");
          // 若之前用过回退抽屉，打开 tab 时把它清掉并收起来，避免两套面板同时在场。
          store.patch({ open: false, collapsed: false, drawerFallback: false });
          return true;
        } catch {
          return false;
        }
      };

      /** 面板是否真的挂在 DOM 上（BtwBody 维护的挂载计数，避免到处查 DOM）。 */
      let panelVisibleCount = 0;

      /**
       * 让面板可见：先试原生右侧栏；宿主右栏在空白会话里可能不渲染 per-session tab，
       * `openTab` 也可能直接抛错，稍等后仍没有面板就退回浮层抽屉 —— 两条降级都显式打
       * `drawerFallback`，否则 `tabReady` 为 true 时抽屉会静默不渲染（复审 B1）。
       */
      const revealPanel = () => {
        if (!openSidebarTab()) {
          store.patch({ open: true, collapsed: false, drawerFallback: true });
          return;
        }
        setTimeout(() => {
          let hasPanel = true;
          try {
            hasPanel = document.querySelector("[data-btw-panel]") !== null;
          } catch {
            hasPanel = true;
          }
          if (!hasPanel) store.patch({ open: true, collapsed: false, drawerFallback: true });
        }, REVEAL_FALLBACK_MS);
      };

      /**
       * toast 状态（自绘 toast 栈，挂 `shell.overlay`；宿主没有 toast/notify 服务，
       * 见 docs/runtime 0.2.2-rc.5 §16）。单条、可自动消失；autoHideMs=0 = 常驻。
       */
      const toastStore = (() => {
        /** @type {{ id: number, tone: string, text: string } | null} */
        let state = null;
        /** @type {Set<() => void>} */
        const listeners = new Set();
        let seq = 0;
        /** @type {any} */
        let timer;
        const emit = () => {
          for (const listener of listeners) listener();
        };
        const dismiss = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (state === null) return;
          state = null;
          emit();
        };
        /** @param {string} tone @param {string} text @param {number} autoHideMs */
        const show = (tone, text, autoHideMs) => {
          const message = String(text ?? "").trim();
          if (message === "") return;
          seq += 1;
          const id = seq;
          state = { id, tone, text: message };
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (autoHideMs > 0) {
            timer = setTimeout(() => {
              if (state !== null && state.id === id) dismiss();
            }, autoHideMs);
          }
          emit();
        };
        return {
          get: () => state,
          subscribe(/** @type {() => void} */ listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          show,
          dismiss,
        };
      })();

      /** 已处理过 seq 的会话（去重轮询重复读到的同一条通知）。 */
      const noticeSeen = new Map();
      /** 已自动开过面板的 `sessionId:threadId`（用户手动关掉后不再抢焦点）。 */
      const noticeRevealed = new Set();

      /** 当前会话的对话状态快照（空白判定用）。 */
      const conversationSnapshot = () => {
        try {
          const phaseEl = document.querySelector("[data-phase]");
          return {
            phase: phaseEl === null ? "" : String(phaseEl.getAttribute("data-phase") ?? ""),
            chatRows: document.querySelectorAll("[data-chat-flow-kind]").length,
          };
        } catch {
          return { phase: "", chatRows: 0 };
        }
      };

      /**
       * 空白会话里自动打开面板（**只开一次**：用户手动关掉后不再抢焦点）。
       * 非空白会话不抢布局 —— 那里命令卡片自己会渲染结果。
       * @param {string} sessionId
       * @param {any} notice
       */
      const maybeRevealPanel = (sessionId, notice) => {
        const threadId = String(notice?.threadId ?? "");
        const key = `${sessionId}:${threadId}`;
        if (noticeRevealed.has(key)) return;
        if (!isBlankConversation(conversationSnapshot())) return;
        if (noticeRevealed.size > 200) noticeRevealed.clear();
        noticeRevealed.add(key);
        revealPanel();
      };

      /**
       * 收到一条回执：去重 → 弹 toast → 空白会话的第一次「进行中」顺带打开面板。
       * 面板开着时进行中/完成已有就地反馈（live 卡片 / 线程更新），不叠 toast；
       * 失败始终弹（面板里没有错误展示位）。
       * @param {string} sessionId
       * @param {any} notice
       */
      const applyNotice = (sessionId, notice) => {
        if (notice === null || typeof notice !== "object") {
          // 第一轮就没有通知：建立基线 0，之后任何新回执都算新事件。
          // （否则「开始 → 立刻失败」比首轮轮询还快时，失败会被当成基线静默掉 ——
          //  正是 U2-06 要消灭的「什么都没发生」。）
          if (!noticeSeen.has(sessionId)) noticeSeen.set(sessionId, 0);
          return;
        }
        if (noticeSeen.size > 200) noticeSeen.clear();
        const planned = planNotice(noticeSeen.get(sessionId), notice);
        if (planned.seq !== undefined) noticeSeen.set(sessionId, planned.seq);
        const panelVisible = panelVisibleCount > 0;
        const action = noticeAction(notice, planned.show, panelVisible);
        if (action === "none") return;
        // 面板已经把答案显示出来 → 撤掉可能还停在屏幕上的「正在等待」常驻提示。
        if (action === "dismiss") {
          toastStore.dismiss();
          return;
        }
        const toast = composeNoticeToast(notice, t);
        if (toast !== null) toastStore.show(toast.tone, toast.text, toast.autoHideMs);
        if (String(notice?.state ?? "") === "running") maybeRevealPanel(sessionId, notice);
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

      // ---- 转正草稿的行数预算（纯函数，client 半不能 import，单测用源码抽取守卫）--------
      // host 只返回完整 Markdown 草稿（最多 1200 字）；会不会撑爆 composer 取决于当前
      // 输入框宽度（右侧栏展开约 20 字/行，收起约 40 字/行），所以「收进 6 行」必须在
      // client 半按实测宽度做。超出部分不静默丢：末尾保留一行「完整内容见面板」。
      // 单测用 test/index.test.js 的 @testable 抽取直接跑这段源码（避免复制一份逻辑）。
      // @testable:begin
      /** 转正草稿在输入框里的行数上限（目标：不超过视口约 1/3，或最多约 6 行）。 */
      const PROMOTE_MAX_LINES = 6;

      /**
       * 估算文本在输入框里占几行：按每行字数粗算，换行符各占一行，宁可多算一行。
       * @param {string} value
       * @param {number} charsPerLine
       * @returns {number}
       */
      function estimateDraftLines(value, charsPerLine) {
        const width = Math.max(1, Math.trunc(Number(charsPerLine) || 1));
        const text = String(value ?? "");
        if (text === "") return 0;
        let total = 0;
        for (const line of text.split("\n")) {
          total += Math.max(1, Math.ceil([...line].length / width));
        }
        return total;
      }

      /**
       * 把完整草稿压成「摘要」：去掉 Markdown 标题行与多余空行，保留正文（首问 + 结论）。
       *
       * 为什么长草稿要先去标题：四节标题 + 空行在 6 行预算里要吃掉 4 行，标题下面
       * 几乎剩不下结论。代码围栏内的 `#` 与空行原样保留，不能把代码内容改坏。
       * @param {string} value
       * @returns {string}
       */
      function compactDraftForComposer(value) {
        /** @type {string[]} */
        const out = [];
        let fenced = "";
        for (const line of String(value ?? "").split("\n")) {
          const fence = /^\s*(`{3,}|~{3,})/u.exec(line);
          if (fence !== null) {
            fenced = fenced === "" ? fence[1][0] : "";
            out.push(line);
            continue;
          }
          if (fenced === "") {
            if (/^#{1,6}\s+/u.test(line)) continue;
            // 摘要里空行只占预算不提供信息；代码围栏内的空行另行保留。
            if (line.trim() === "") continue;
          }
          out.push(line);
        }
        return out.join("\n").trim();
      }

      /**
       * 把完整草稿收进 6 行预算：放得下就原样返回（保留四节 Markdown）；放不下就压成
       * 摘要并保留开头 + 省略号 +「完整内容见面板」。截断点用二分找最长前缀，
       * 按字符数组切，不劈开多字节字符。
       * @param {string} value
       * @param {{ maxLines?: number, charsPerLine?: number, footer?: string, ellipsis?: string }} [options]
       * @returns {{ text: string, truncated: boolean }}
       */
      function fitDraftToLines(value, options = {}) {
        const text = String(value ?? "");
        const maxLines = Math.max(2, Math.trunc(Number(options.maxLines) || PROMOTE_MAX_LINES));
        const charsPerLine = Math.max(4, Math.trunc(Number(options.charsPerLine) || 24));
        const ellipsis = String(options.ellipsis ?? "…");
        const footer = String(options.footer ?? "");
        if (text === "") return { text, truncated: false };
        if (estimateDraftLines(text, charsPerLine) <= maxLines) {
          return { text, truncated: false };
        }
        const compact = compactDraftForComposer(text);
        const base = compact === "" ? text : compact;
        const tail = footer === "" ? "" : `\n${footer}`;
        if (estimateDraftLines(`${base}${tail}`, charsPerLine) <= maxLines) {
          return { text: `${base}${tail}`, truncated: true };
        }
        const suffix = footer === "" ? ellipsis : `${ellipsis}\n${footer}`;
        const chars = [...base];
        let low = 0;
        let high = chars.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const candidate = `${chars.slice(0, mid).join("").replace(/\s+$/u, "")}${suffix}`;
          if (estimateDraftLines(candidate, charsPerLine) <= maxLines) low = mid;
          else high = mid - 1;
        }
        const prefix = chars.slice(0, low).join("").replace(/\s+$/u, "");
        return { text: `${prefix}${suffix}`, truncated: true };
      }
      // @testable:end

      /**
       * 量当前 composer 的每行字数。CJK 字形宽度约等于字号，再乘 1.2 的余量
       * （标点、粗体、英文混排），宁可少算一行。
       * @returns {number}
       */
      const promoteCharsPerLine = () => {
        try {
          const el = document.querySelector("[data-composer-input]");
          if (!el) return 24;
          const style = getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize) || 14;
          const padding =
            (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
          // 面板刚打开/刚切会话时 clientWidth 可能还是 0，矩形宽度兜底。
          const width = Math.max(
            Number(el.clientWidth || 0),
            Number(el.getBoundingClientRect().width || 0),
          );
          const usable = Math.max(160, width - padding);
          return Math.max(8, Math.floor(usable / (fontSize * 1.2)));
        } catch {
          return 24;
        }
      };

      /**
       * 当前 composer 草稿渲染成几行；量不到时返回 undefined（不阻断转正）。
       * @returns {number | undefined}
       */
      const composerDraftLines = () => {
        try {
          const el = document.querySelector("[data-composer-input]");
          if (!el) return undefined;
          const style = getComputedStyle(el);
          const lineHeight = parseFloat(style.lineHeight) || 24;
          return Math.round(el.getBoundingClientRect().height / lineHeight);
        } catch {
          return undefined;
        }
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
       * 首选打开 DSH 原生右侧栏的「旁问」tab（不遮挡主对话）；宿主没有右侧栏
       * 服务时回退到 `shell.overlay` 浮层抽屉。回退形态拿不到 session props，
       * 所以按钮同时负责把 sessionId 写进 store。
       */
      function BtwTrigger(/** @type {any} */ props) {
        const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
        const shared = useStore();
        React.useEffect(() => {
          if (shared.sessionId !== sessionId) store.patch({ sessionId });
        }, [sessionId, shared.sessionId]);
        // 组件卸载（离开会话视图）时清掉 store 里的会话：回执轮询据此停掉，
        // 不至于在别的页面上替一个看不见的会话弹面板。
        const sessionRef = React.useRef(sessionId);
        sessionRef.current = sessionId;
        React.useEffect(
          () => () => {
            if (store.get().sessionId === sessionRef.current) store.patch({ sessionId: "" });
          },
          [],
        );
        const toggle = () => {
          if (openSidebarTab()) return;
          const current = store.get();
          // 右栏在但 openTab 失败时同样要落抽屉（tabReady 仍为 true，抽屉需要显式标记）。
          if (!current.open) store.patch({ open: true, collapsed: false, drawerFallback: true });
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

      /**
       * 面板主体：原生右侧栏 tab 与回退抽屉共用。
       * @param {any} props `{ sessionId, mode: 'tab'|'drawer', onCollapse, onClose }`
       */
      function BtwBody(/** @type {any} */ props) {
        const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
        const mode = props?.mode === "tab" ? "tab" : "drawer";
        const onCollapse = typeof props?.onCollapse === "function" ? props.onCollapse : () => {};
        const onClose = typeof props?.onClose === "function" ? props.onClose : onCollapse;
        const visible = props?.visible !== false;
        const [threads, setThreads] = React.useState(/** @type {any[] | null} */ (null));
        const [liveRuns, setLiveRuns] = React.useState(/** @type {any[]} */ ([]));
        const [failed, setFailed] = React.useState(false);
        const [activeId, setActiveId] = React.useState("");
        const [question, setQuestion] = React.useState("");
        const [followQuestion, setFollowQuestion] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const [costHint, setCostHint] = React.useState(/** @type {any} */ (null));
        const [badge, setBadge] = React.useState("");
        const [echoAnswer, setEchoAnswer] = React.useState(true);
        const [echoSaving, setEchoSaving] = React.useState(false);
        const [scope, setScope] = React.useState("");
        const [expandedAnswers, setExpandedAnswers] = React.useState(
          /** @type {Record<string, boolean>} */ ({}),
        );
        const aliveRef = React.useRef(true);
        const liveRef = React.useRef(/** @type {any[]} */ ([]));
        const scrollRef = React.useRef(/** @type {any} */ (null));
        const pinnedRef = React.useRef(true);
        const questionRef = React.useRef(/** @type {any} */ (null));
        // 组字期间的标记（复审 B2）：合成事件的 isComposing 不一定有值，靠 composition
        // 事件维护一份 ref，两个输入框共用（同一时刻只有一个在组字）。
        const compositionRef = React.useRef({ active: false });

        React.useEffect(
          () => () => {
            aliveRef.current = false;
          },
          [],
        );

        // 面板真实挂载计数：回执侧据此判断「用户已经在看面板」，不重复弹 toast。
        React.useEffect(() => {
          if (!visible) return undefined;
          panelVisibleCount += 1;
          return () => {
            panelVisibleCount = Math.max(0, panelVisibleCount - 1);
          };
        }, [visible]);

        // 面板底部直接暴露「只在面板显示答案」开关：不用进设置页，减少主对话重复答案。
        React.useEffect(() => {
          callRemote("settings", undefined)
            .then((/** @type {any} */ value) => {
              if (aliveRef.current && value) setEchoAnswer(value.echoAnswer !== false);
            })
            .catch(() => {});
        }, []);

        const toggleEcho = async (/** @type {boolean} */ checked) => {
          if (echoSaving) return;
          setEchoSaving(true);
          setNotice("");
          try {
            const saved = await callRemote("updateSettings", { echoAnswer: !checked });
            if (!aliveRef.current) return;
            setEchoAnswer(saved?.echoAnswer !== false);
          } catch {
            if (aliveRef.current) setNotice(t("echoFailed"));
          } finally {
            if (aliveRef.current) setEchoSaving(false);
          }
        };

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

        // 面板可见且没开追问输入时，自动聚焦「新旁问」输入框，省一次点击。
        React.useEffect(() => {
          if (!visible || sessionId === "" || activeId !== "") return undefined;
          const timer = setTimeout(() => {
            try {
              questionRef.current?.focus();
            } catch {
              /* 忽略焦点失败 */
            }
          }, 0);
          return () => clearTimeout(timer);
        }, [visible, sessionId, activeId]);

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

        /** 成本粗估（Phase 1：只提示不阻断；超大压力会话才显示）。 */
        const loadCostHint = React.useCallback(
          () =>
            callRemote("costHint", { sessionId }).then((/** @type {any} */ value) => {
              if (aliveRef.current && value !== null && typeof value === "object") {
                setCostHint(value);
              }
              return value;
            }),
          [sessionId],
        );

        /** 重新拉徽章（记录数/范围）。提交完成、live 结束、切范围时都要刷新，避免计数落后。 */
        const refreshBadge = React.useCallback(() => {
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
          return callRemote("stats", { sessionId, scope: scopeLabel, lang: langOf() }).then(
            (/** @type {any} */ value) => {
              if (!aliveRef.current) return;
              if (value && typeof value.badge === "string") setBadge(value.badge);
            },
          );
        }, [sessionId, scope, t]);

        React.useEffect(() => {
          void refreshBadge();
        }, [refreshBadge]);

        // 面板挂载（tab 打开 / 抽屉展开）时先读一次历史。
        React.useEffect(() => {
          void loadThreads();
        }, [loadThreads]);

        // 成本提示随会话变化刷新；切换会话先清空，避免拿上一个会话的压力吓人。
        React.useEffect(() => {
          setCostHint(null);
          if (sessionId !== "") void loadCostHint();
        }, [sessionId, loadCostHint]);

        // 流式与后台刷新：面板打开期间常驻。有 run 时 350ms 一次、空闲 1s 一次；
        // 空闲时每 4 次才刷一次线程列表，避免无谓 RPC。
        React.useEffect(() => {
          if (sessionId === "" || !visible) return undefined;
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
            if (hadLive && !hasLive) {
              void loadThreads(true);
              void refreshBadge();
            } else if (!hasLive && ticks % LIVE_IDLE_REFRESH_EVERY === 0) void loadThreads(true);
            ticks += 1;
            if (!cancelled)
              timer = setTimeout(tick, runs.length > 0 ? LIVE_ACTIVE_MS : LIVE_IDLE_MS);
          };
          timer = setTimeout(tick, 200);
          return () => {
            cancelled = true;
            clearTimeout(timer);
          };
        }, [sessionId, visible, loadThreads, refreshBadge]);

        // Esc 关闭面板（tab 与回退抽屉同一手感）。用捕获阶段先于宿主/菜单处理，
        // 否则宿主会把 Esc preventDefault 掉，面板永远收不到。
        React.useEffect(() => {
          const onKey = (/** @type {any} */ event) => {
            if (event?.key !== "Escape") return;
            // 焦点在面板或主输入框时都关闭；设置对话框拥有焦点时不抢它的 Esc。
            const active = document.activeElement;
            const inSettings =
              active !== null &&
              typeof active.closest === "function" &&
              active.closest('[role="dialog"]') !== null &&
              active.closest("[data-btw-panel]") === null;
            if (inSettings) return;
            onClose();
          };
          document.addEventListener("keydown", onKey, true);
          return () => document.removeEventListener("keydown", onKey, true);
        }, [onClose]);

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
        }, [threads, liveRuns]);

        const metaTextOf = (
          /** @type {any} */ cost,
          /** @type {number} */ ms,
          /** @type {string} */ mode,
        ) => {
          const bounded = mode === "bounded" ? " · bounded" : "";
          if (cost && typeof cost === "object") {
            return `${fmt(t("cost"), {
              newTokens: formatTokens(cost.inputTokens),
              cachedTokens: formatTokens(cost.cacheReadTokens),
              ms: formatDuration(ms),
            })}${bounded}`;
          }
          const duration = ms > 0 ? formatDuration(ms) : "";
          return duration === "" ? "" : `${duration}${bounded}`;
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
          // 用「最近一条记录的时间」判断完成，而不是线程数：
          // 线程数受 20 条上限约束，满额时新问题不会让数量增加，旧逻辑会白等到 120s。
          const beforeAt = beforeThreads.reduce(
            (latest, /** @type {any} */ entry) => Math.max(latest, Number(entry?.at ?? 0)),
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
              if (next.some((/** @type {any} */ entry) => Number(entry?.at ?? 0) > beforeAt)) {
                refreshed = true;
                break;
              }
            }
            void refreshBadge();
            void loadCostHint();
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
            // 线程级转正：host 用首问 + 最后一轮答案组四节草稿。
            threadId: String(thread?.threadId ?? ""),
            lang: langOf(),
          });
          if (result?.ok !== true || typeof result?.text !== "string") {
            setBusy(false);
            setNotice(t("promoteFailed"));
            return;
          }
          const full = result.text;
          const charsPerLine = promoteCharsPerLine();
          const fitted = fitDraftToLines(full, {
            maxLines: PROMOTE_MAX_LINES,
            charsPerLine,
            footer: t("promoteFooter"),
          });
          let shortened = fitted.truncated;
          try {
            actions.setDraft(fitted.text);
          } catch {
            setBusy(false);
            setNotice(t("promoteFailed"));
            return;
          }
          // 估算可能偏乐观（粗体/英文混排字形更宽）：量一次实际行数，超了就按比例
          // 把每行字数收窄再切一次（只重试一次，避免草稿抖动）。
          await waitDraftSettled(() => shellDraftOf(shell), fitted.text);
          const lines = composerDraftLines();
          if (lines !== undefined && lines > PROMOTE_MAX_LINES) {
            const tighter = Math.max(
              4,
              Math.floor(charsPerLine * (PROMOTE_MAX_LINES / lines) * 0.9),
            );
            const second = fitDraftToLines(full, {
              maxLines: PROMOTE_MAX_LINES,
              charsPerLine: tighter,
              footer: t("promoteFooter"),
            });
            if (second.text.length < fitted.text.length) {
              shortened = true;
              try {
                actions.setDraft(second.text);
              } catch {
                /* 保留已经插入的那一版，提示语仍按摘要处理 */
              }
              await waitDraftSettled(() => shellDraftOf(shell), second.text);
            }
          }
          setBusy(false);
          setNotice(shortened ? t("promotedShort") : t("promoted"));
        };

        // 折叠按钮：展开/收起单条长答案。展开后保持被点答案的视口位置，避免列表跳回顶部。
        const answerAnchorRef = React.useRef(/** @type {any} */ (null));
        const toggleAnswer = (/** @type {string} */ key) => {
          const list = scrollRef.current;
          /** @type {any} */
          const el =
            list === null || list === undefined
              ? null
              : list.querySelector(`[data-btw-answer-id="${key}"]`);
          answerAnchorRef.current = {
            key,
            top: el === null || el === undefined ? null : el.getBoundingClientRect().top,
          };
          setExpandedAnswers((/** @type {any} */ previous) => ({
            ...previous,
            [key]: !previous[key],
          }));
        };
        React.useLayoutEffect(() => {
          const pending = answerAnchorRef.current;
          if (pending === null || pending === undefined) return;
          answerAnchorRef.current = null;
          const list = scrollRef.current;
          if (list === null || list === undefined || pending.top === null) return;
          const el = list.querySelector(`[data-btw-answer-id="${pending.key}"]`);
          if (el === null || el === undefined) return;
          list.scrollTop += el.getBoundingClientRect().top - pending.top;
        }, [expandedAnswers]);

        /** 范围档位选择器：底部「新旁问」和线程内追问共用同一个 scope 状态。 */
        const renderScopeSelect = (/** @type {string} */ key) =>
          h(
            "select",
            {
              key,
              className: "dsh-btw-select",
              "data-btw-scope": "true",
              value: scope,
              onChange: (/** @type {any} */ event) => setScope(String(event?.target?.value ?? "")),
            },
            h("option", { value: "" }, t("scopeAny")),
            h("option", { value: "session" }, t("scopeSession")),
            h("option", { value: "recent" }, t("scopeRecent")),
            h("option", { value: "selection" }, t("scopeSelection")),
          );

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
              const longAnswer = Number(item?.chars ?? 0) > 400;
              const isExpanded = expandedAnswers[itemKey] === true;
              const clamped = !isExpanded && longAnswer;
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
                h(MarkdownBody, {
                  blocks: item?.blocks,
                  streaming: false,
                  clamped,
                  answerId: itemKey,
                }),
                longAnswer || isExpanded
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-btw-btn",
                        "data-btw-expand": "true",
                        ...(isExpanded ? { "data-btw-collapse": "true" } : {}),
                        onClick: () => toggleAnswer(itemKey),
                      },
                      isExpanded ? t("collapseAnswer") : t("expandAnswer"),
                    )
                  : null,
                (() => {
                  const meta = metaTextOf(
                    item?.cost,
                    Number(item?.ms ?? 0),
                    String(item?.mode ?? ""),
                  );
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
                        expanded ? t("followCancel") : t("followUp"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "dsh-btw-btn",
                          "data-btw-promote": "true",
                          title: t("promoteHint"),
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
                      { className: "dsh-btw-composer", "data-btw-thread-input": "true" },
                      h("span", { className: "dsh-btw-composer-label" }, t("followInputLabel")),
                      h("textarea", {
                        className: "dsh-btw-input",
                        "data-btw-input": "true",
                        "data-btw-follow-input": "true",
                        placeholder: t("followPlaceholder"),
                        value: followQuestion,
                        rows: 2,
                        onChange: (/** @type {any} */ event) =>
                          setFollowQuestion(String(event?.target?.value ?? "")),
                        onCompositionStart: () => {
                          compositionRef.current = { active: true };
                        },
                        onCompositionEnd: () => {
                          compositionRef.current = { active: false };
                        },
                        // Enter 发送、Shift+Enter 换行（USIM-U2-13）；输入法组字中不发送。
                        onKeyDown: (/** @type {any} */ event) => {
                          if (!shouldSubmitOnKey(event, compositionRef.current)) return;
                          event.preventDefault();
                          if (busy || followQuestion.trim() === "") return;
                          void submit(threadId);
                        },
                      }),
                      h(
                        "div",
                        { className: "dsh-btw-meta", "data-btw-input-hint": "true" },
                        t("inputHint"),
                      ),
                      h(
                        "div",
                        { className: "dsh-btw-row" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "dsh-btw-btn",
                            "data-btw-send": "true",
                            disabled: busy || followQuestion.trim() === "",
                            onClick: () => void submit(threadId),
                          },
                          t("followSend"),
                        ),
                        renderScopeSelect("follow-scope"),
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
              `${
                Array.isArray(run?.blocks) && run.blocks.length > 0 ? t("streaming") : t("thinking")
              } · ${formatDuration(run?.ms)}`,
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

        // 成本提示（Phase 1）：只有压力超过阈值才出现；给区间不给精确账单。
        const costHintLast =
          costHint?.level === "warn" && Number(costHint.lastActualPromptTokens) > 0
            ? fmt(t("costLast"), { tokens: formatTokens(costHint.lastActualPromptTokens) })
            : "";
        const costHintText =
          costHint?.level === "warn"
            ? [
                fmt(t("costHint"), {
                  pressure: formatTokens(costHint.pressureTokens),
                  low: formatTokens(costHint.estimatedLow),
                  high: formatTokens(costHint.estimatedHigh),
                }),
                costHintLast,
              ]
                .filter((part) => part !== "")
                .join(" ")
            : "";

        // 有 live 卡片时不显示状态条：卡片里已经有「正在生成回答 · 12s」，不需要重复。
        const statusBusy = busy;
        const statusText = busy ? `${t("sending")}（${t("waitHint")}）` : notice;
        // 有 live 卡片时不必重复「正在等待」，但**失败/提示**必须仍然可见
        // （否则面板里提交失败时会静默，USIM-U2-13）。
        const statusVisible = notice !== "" || (statusBusy && liveRuns.length === 0);

        return h(
          "div",
          {
            className: `dsh-btw-panel${mode === "tab" ? " is-tab" : ""}`,
            "data-btw-panel": "true",
            ...(mode === "tab"
              ? { "data-btw-tab": "true" }
              : { "data-btw-overlay": "true", "data-btw-drawer": "true" }),
            role: mode === "tab" ? "region" : "dialog",
            "aria-label": t("title"),
          },
          h(
            "div",
            { className: "dsh-btw-head" },
            h("span", { className: "dsh-btw-head-title" }, t("subtitle")),
            threads !== null && threads.length > 0
              ? h(
                  "span",
                  { className: "dsh-btw-dim", "data-btw-count": "true" },
                  fmt(t("threadCount"), { count: threads.length }),
                )
              : null,
            mode === "tab"
              ? null
              : h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-btw-btn",
                    "data-btw-collapse": "true",
                    title: t("collapse"),
                    onClick: () => onCollapse(),
                  },
                  t("collapseShort"),
                ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-btw-btn",
                "data-btw-close": "true",
                onClick: () => onClose(),
              },
              t("close"),
            ),
          ),
          costHintText === ""
            ? null
            : h(
                "div",
                {
                  className: "dsh-btw-cost-hint",
                  "data-btw-cost-hint": "warn",
                  title: t("costHintTitle"),
                },
                costHintText,
              ),
          statusVisible
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
          activeId === ""
            ? h(
                "div",
                { className: "dsh-btw-composer" },
                h("span", { className: "dsh-btw-composer-label" }, t("newQuestionLabel")),
                h("textarea", {
                  className: "dsh-btw-input",
                  "data-btw-input": "true",
                  placeholder: t("placeholder"),
                  value: question,
                  rows: 2,
                  ref: questionRef,
                  onChange: (/** @type {any} */ event) =>
                    setQuestion(String(event?.target?.value ?? "")),
                  onCompositionStart: () => {
                    compositionRef.current = { active: true };
                  },
                  onCompositionEnd: () => {
                    compositionRef.current = { active: false };
                  },
                  onKeyDown: (/** @type {any} */ event) => {
                    // 与线程内追问同一套 Enter 语义：Enter 发送、Shift+Enter 换行。
                    if (!shouldSubmitOnKey(event, compositionRef.current)) return;
                    event.preventDefault();
                    if (busy || question.trim() === "") return;
                    void submit("");
                  },
                }),
                h(
                  "div",
                  { className: "dsh-btw-meta", "data-btw-input-hint": "true" },
                  t("inputHint"),
                ),
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
                  renderScopeSelect("new-scope"),
                ),
              )
            : null,
          h(
            "div",
            { className: "dsh-btw-footer", "data-btw-hint": "true" },
            h(
              "label",
              { className: "dsh-btw-echo", "data-btw-echo-toggle": "true" },
              h("input", {
                type: "checkbox",
                checked: !echoAnswer,
                disabled: echoSaving,
                onChange: (/** @type {any} */ event) =>
                  void toggleEcho(event?.target?.checked === true),
              }),
              t("panelOnlyToggle"),
            ),
            mode === "tab"
              ? h(
                  "span",
                  { className: "dsh-btw-meta", "data-btw-resize-hint": "true" },
                  t("resizeHint"),
                )
              : null,
          ),
          badge === ""
            ? null
            : h("div", { className: "dsh-btw-meta", "data-btw-badge": "true" }, badge),
        );
      }

      /**
       * 自绘 toast（`shell.overlay`）：`/btw` 的执行回执。
       * - 进行中常驻（等待期间不能自己消失）；完成/失败自动消失；
       * - 点击 = 打开旁问面板并收起提示（标题栏也有同样的提示）；
       * - 顶部居中，不盖 composer 与右侧栏按钮。
       */
      function BtwToast() {
        const toast = React.useSyncExternalStore(toastStore.subscribe, toastStore.get);
        if (!toast) return null;
        const tone = toast.tone === "error" ? "error" : toast.tone === "ok" ? "ok" : "info";
        const color =
          tone === "error"
            ? "var(--dsw-alias-state-error-primary,#d9534f)"
            : tone === "ok"
              ? "var(--dsw-alias-state-success-primary,#2f9e63)"
              : "var(--dsw-alias-label-secondary,GrayText)";
        const activate = () => {
          toastStore.dismiss();
          revealPanel();
        };
        return h(
          "div",
          {
            className: "dsh-btw-toast",
            "data-btw-toast": tone,
            // B7（复审）：原来是 div + onClick，键盘完全不可达。改成按钮语义：
            // role=button + tabIndex=0 + Enter/Space 触发；点击开面板的既有行为不变。
            role: "button",
            tabIndex: 0,
            title: t("notice.open"),
            onClick: activate,
            onKeyDown: (/** @type {any} */ event) => {
              const key = String(event?.key ?? "");
              if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
              if (typeof event.preventDefault === "function") event.preventDefault();
              activate();
            },
          },
          tone === "info"
            ? h(
                "span",
                { className: "dsh-btw-toast-mark" },
                h("span", { className: "dsh-btw-spinner" }, "⟳"),
              )
            : h(
                "span",
                { className: "dsh-btw-toast-mark", style: { color } },
                tone === "error" ? "!" : "✓",
              ),
          h("span", { className: "dsh-btw-toast-text" }, toast.text),
        );
      }

      /**
       * 回执轮询（`shell.overlay` 常驻）：`/btw` 在 host 半执行，client 拿不到命令生命周期，
       * 所以轮询内存快照 `btw/notice`。空白会话里宿主的命令卡片不渲染（runtime rc.5 §5.2），
       * 这条通道是用户唯一能立刻看到的反馈（USIM-U2-06）。
       */
      function BtwNotifier() {
        const shared = useStore();
        const sessionId = shared.sessionId;
        React.useEffect(() => {
          if (sessionId === "") return undefined;
          let cancelled = false;
          /** @type {any} */
          let timer;
          const tick = () => {
            if (cancelled) return;
            callRemote("notice", { sessionId }).then(
              (/** @type {any} */ notice) => {
                if (cancelled) return;
                // null = 该会话还没有旁问（也会建基线，见 applyNotice）；畸形值同理。
                applyNotice(sessionId, notice);
                timer = setTimeout(tick, NOTICE_POLL_MS);
              },
              () => {
                if (!cancelled) timer = setTimeout(tick, NOTICE_POLL_MS);
              },
            );
          };
          timer = setTimeout(tick, NOTICE_FIRST_DELAY_MS);
          return () => {
            cancelled = true;
            clearTimeout(timer);
          };
        }, [sessionId]);
        return h(
          "div",
          {
            className: "dsh-btw-toast-tray",
            "data-btw-toast-tray": "true",
            "aria-live": "polite",
            "aria-atomic": "true",
          },
          h(BtwToast, null),
        );
      }

      /** `shell.overlay` 的根：回执 tray + 回退抽屉（两者互不遮挡）。 */
      function BtwOverlay() {
        return h(React.Fragment, null, h(BtwNotifier, null), h(BtwDrawer, null));
      }

      /** 回退形态：`shell.overlay` 里的右侧抽屉（宿主没有右侧栏服务时）。 */
      function BtwDrawer(/** @type {any} */ props) {
        void props;
        const shared = useStore();
        // 宿主提供了右侧栏时面板默认只走 tab 形态；只有「右栏服务缺失」或「这次打开明确
        // 降级成抽屉」（drawerFallback）才渲染抽屉，避免 tab 渲染慢一帧时两套面板同时在场。
        if (!shouldRenderDrawer(shared, tabReady)) return null;
        if (shared.collapsed) {
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
          );
        }
        return h(BtwBody, {
          sessionId: shared.sessionId,
          mode: "drawer",
          onCollapse: () => store.patch({ collapsed: true }),
          onClose: () => store.patch({ open: false }),
        });
      }

      /**
       * 首选形态：DSH 原生右侧栏里的「旁问」tab。
       * 收起 = 关闭 tab（再点输入框旁的「旁问」按钮打开）。
       */
      function BtwTab(/** @type {any} */ props) {
        const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
        const useTabInfo =
          typeof props?.useTabInfo === "function" ? props.useTabInfo : () => undefined;
        const info = useTabInfo();
        const closeTab = () => {
          try {
            const actions = info?.tab?.actions;
            if (typeof actions?.close === "function") {
              actions.close();
              return;
            }
          } catch {
            /* 退到 closeIn */
          }
          try {
            const sidebarRight = serviceOf(ctx, "sidebarRight");
            const tabId = info?.tab?.id;
            if (
              sidebarRight !== undefined &&
              typeof sidebarRight.closeIn === "function" &&
              tabId !== undefined
            ) {
              sidebarRight.closeIn(sessionId, tabId);
            }
          } catch {
            /* 关不上也保持可见 */
          }
        };
        // 收起整栏交给宿主右上角的收起按钮/快捷键；这里只负责关闭 tab。
        return h(BtwBody, {
          sessionId,
          mode: "tab",
          onCollapse: closeTab,
          onClose: closeTab,
          visible: info?.tab?.visible !== false,
        });
      }

      /** 设置分节（约定 §7.2：首屏 ≤3 行、可直改、无改动时禁用保存）。 */
      function BtwSettings(/** @type {any} */ props) {
        const api = props?.api;
        const [loaded, setLoaded] = React.useState(/** @type {any} */ (null));
        const [tools, setTools] = React.useState("");
        const [limit, setLimit] = React.useState("");
        const [echo, setEcho] = React.useState(true);
        const [bounded, setBounded] = React.useState(false);
        const [saving, setSaving] = React.useState(false);
        // 保存状态（[plugin-conventions §7.2.6]）：clean / dirty / saving / saved / error
        // 五态都必须在界面上看得见。saved 是短暂态，2.5s 后回落 clean；error 一直留到下次保存成功。
        const [saveState, setSaveState] = React.useState("clean");
        const [saveError, setSaveError] = React.useState("");
        const saveTimer = React.useRef(/** @type {any} */ (null));
        const [expanded, setExpanded] = React.useState(false);

        const hydrate = React.useCallback((/** @type {any} */ value) => {
          if (!value || typeof value !== "object") return;
          setLoaded(value);
          setTools(Array.isArray(value.allowedTools) ? value.allowedTools.join(", ") : "");
          setLimit(String(value.historyLimit ?? ""));
          setEcho(value.echoAnswer !== false);
          setBounded(value.boundedContext === true);
        }, []);

        React.useEffect(() => {
          const call = api && typeof api.settings === "function" ? api.settings : undefined;
          if (!call) return;
          Promise.resolve(call()).then((value) => hydrate(value));
        }, [api, hydrate]);

        React.useEffect(() => {
          return () => {
            if (saveTimer.current !== null) clearTimeout(saveTimer.current);
          };
        }, []);

        const dirty =
          loaded !== null &&
          (tools !== (loaded.allowedTools ?? []).join(", ") ||
            limit !== String(loaded.historyLimit ?? "") ||
            echo !== (loaded.echoAnswer !== false) ||
            bounded !== (loaded.boundedContext === true));

        /** saved 的短暂态由定时器回落；其余态由派生值决定。 */
        const statusState =
          saving || saveState === "saving"
            ? "saving"
            : saveState === "error"
              ? "error"
              : dirty
                ? "dirty"
                : saveState === "saved"
                  ? "saved"
                  : "clean";

        const save = async () => {
          const call =
            api && typeof api.updateSettings === "function" ? api.updateSettings : undefined;
          if (!call || saving) return;
          setSaving(true);
          setSaveState("saving");
          setSaveError("");
          const next = await Promise.resolve(
            call({
              allowedTools: tools,
              historyLimit: Number(limit),
              echoAnswer: echo,
              boundedContext: bounded,
            }),
          ).catch(() => undefined);
          setSaving(false);
          if (next && typeof next === "object") {
            hydrate(next);
            setSaveState("saved");
            if (saveTimer.current !== null) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null;
              setSaveState("clean");
            }, SETTINGS_SAVE_TIMING.resetMs);
          } else {
            setSaveState("error");
            setSaveError(t("settings.failedReason"));
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

        const statusText =
          statusState === "saving"
            ? t("settings.saving")
            : statusState === "error"
              ? saveError || t("settings.failed")
              : statusState === "dirty"
                ? t("settings.unsaved")
                : statusState === "saved"
                  ? t("settings.saved")
                  : `· ${t("settings.saved")}`;

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
            h("span", { className: "dsh-btw-grow" }),
            h("input", {
              type: "checkbox",
              "data-btw-setting-echo": "true",
              "aria-label": t("settings.echo"),
              title: t("settings.echoHint"),
              checked: echo,
              onChange: (/** @type {any} */ event) => setEcho(event?.target?.checked === true),
            }),
            h("span", { className: "dsh-btw-setlabel" }, t("settings.echo")),
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
          ),
          expanded
            ? h(
                "div",
                { "data-btw-settings-extra": "true" },
                h(
                  "div",
                  { className: "dsh-btw-setrow" },
                  h("span", { className: "dsh-btw-setlabel" }, t("settings.bounded")),
                  h("input", {
                    type: "checkbox",
                    "data-btw-setting-bounded": "true",
                    "aria-label": t("settings.bounded"),
                    title: t("settings.boundedHint"),
                    checked: bounded,
                    onChange: (/** @type {any} */ event) =>
                      setBounded(event?.target?.checked === true),
                  }),
                ),
                h("div", { className: "dsh-btw-meta" }, t("settings.boundedHint")),
                row(
                  t("settings.limit"),
                  h("input", {
                    className: "dsh-btw-input",
                    "data-btw-setting-limit": "true",
                    type: "number",
                    min: "1",
                    max: "200",
                    step: "1",
                    value: limit,
                    onChange: (/** @type {any} */ event) =>
                      setLimit(String(event?.target?.value ?? "")),
                  }),
                  "",
                ),
                h(
                  "div",
                  { className: "dsh-btw-meta", "data-btw-setting-limit-hint": "true" },
                  t("settings.limitHint"),
                ),
                h("div", { className: "dsh-btw-meta" }, t("settings.toolsHint")),
              )
            : null,
          // 保存动作条固定在本分节底部（§7.2.5）：无改动时禁用，右侧永远有一行保存状态（§7.2.6）。
          h(
            "div",
            { className: "dsh-btw-setrow", "data-btw-settings-savebar": "true" },
            h(
              "button",
              {
                type: "button",
                className: "dsh-btw-btn",
                "data-btw-settings-save": "true",
                disabled: dirty !== true || saving,
                onClick: () => void save(),
              },
              t("settings.save"),
            ),
            h(
              "span",
              {
                className: "dsh-btw-save-status",
                "data-btw-settings-status": statusState,
                "data-state": statusState,
                role: "status",
                "aria-live": "polite",
              },
              statusText,
            ),
          ),
        );
      }

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          // order 与 casefile（96）/projects（94）错开：同 order 时分节顺序取决于注册时序。
          {
            name: "settings.section",
            id: "btw",
            order: 95,
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

      // 首选：DSH 原生右侧栏 tab（打开时主对话变窄但不被遮挡）。
      if (typeof ctx.inject === "function") {
        ctx.inject(["sidebarRightTabs"], (/** @type {any} */ scope) => {
          const tabs = scope?.sidebarRightTabs;
          ctx.effect(() => {
            if (!tabs || typeof tabs.register !== "function") return undefined;
            try {
              const dispose = tabs.register({
                id: PLUGIN_ID,
                kind: "btw",
                title: () => t("title"),
                priority: "extension",
              });
              tabReady = true;
              return () => {
                tabReady = false;
                dispose();
              };
            } catch {
              // 注册失败就保持 tabReady=false，按钮自动回退到浮层抽屉。
              return undefined;
            }
          }, "btw: sidebar tab type");
        });
      }
      ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register(
          { name: "sidebar.right.pane.tab", key: PLUGIN_ID, locale: NS },
          (/** @type {any} */ slotProps) => h(BtwTab, slotProps),
        ),
      );

      // 回退：右侧浮层抽屉，挂在 shell.overlay（frame-wide，不受 composer 裁剪）。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "btw-panel", order: 60, locale: NS }, () =>
          h(BtwOverlay, null),
        ),
      );

      // 单测钩子：回退抽屉的「打开失败 / 700ms 没渲染出面板」两条降级路径只有驱动真实
      // `apply()` 才能验证（复审 B1），生产里 `exports.__test` 一直存在但没人读 hooks。
      if (exports.__test) {
        exports.__test.hooks = {
          store,
          revealPanel,
          // B7：toast 的键盘语义只能靠渲染真实组件验证，导出运行时句柄给 vm 单测。
          toastStore,
          BtwToast,
          /** @param {boolean} ready */
          setTabReady: (ready) => {
            tabReady = ready === true;
          },
        };
      }
    };

    /**
     * 单测入口：client 半是 classic script（不能 import），用 node:vm 加载本文件后
     * 直接跑这里的真实函数（见 test/client.test.js）。
     */
    exports.__test = {
      messages: { zh, en },
      shouldSubmitOnKey,
      isBlankConversation,
      shouldRenderDrawer,
      planNotice,
      noticeAction,
      composeNoticeToast,
      // 单测把「已保存」短暂态改短，避免真等 2.5s（生产值不变）。
      settingsSaveTiming: SETTINGS_SAVE_TIMING,
    };

    return module.exports;
  },
});
