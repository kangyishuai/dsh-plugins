// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能使用 import / JSX。
// 功能：
// A. 决策卡（conversation.chat.turnTail）：从投影 nextStep 读 {cards, decisions}，只对最后一轮
//    渲染可交互卡（更早的卡只读）；点击胶囊 → nextStep/act → setDraft + 等草稿落定 + submit。
// B. 幽灵提示（conversation.input.overlay，默认关）：settings.ghost 打开后，在输入框空、无附件、
//    无 @ 引用、无斜杠命令、会话空闲时显示最新卡的 nextPrompt；Tab / → 接受，Esc 清除。
// C. i18n：locale 命名空间 nextStep（同一份字典也落在 locale/*.json）。
// 宿主调用走 ctx.connection.rpc.call("/api", ...)——无构建插件没有 typert 客户端产物，
// 不能用 ctx.reflect.get("remote.xxx")（见 docs/runtime/0.2.2-rc.1.md §7）。
// 客户端状态一律来自投影（禁止用内存 Set 记「已点击」）；只有「本轮正在提交」与
// 「幽灵提示抑制（输入后 2s 内不闪回 / Esc 清除）」这两类瞬时 UI 态留在内存。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-next-step",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;

    /** @type {any} */
    let React = require("react");
    let h = React.createElement;

    /** locale 命名空间；必须与 locale/*.json 顶层键、slot descriptor 的 locale 一致。 */
    let NS = "nextStep";
    /** 样式归属：桌面端只读回归靠 style[data-plugin] 判断 client 半已加载。 */
    let PLUGIN_ID = "@kangyishuai/dsh-next-step";
    let CSS_TAG_ID = `${PLUGIN_ID}/client.css`;

    /** setDraft 走 Lexical 异步更新：轮询草稿落定，15 × 20ms 兜底。 */
    let DRAFT_POLL_TRIES = 15;
    let DRAFT_POLL_INTERVAL_MS = 20;
    /** 输入第一个字符后，幽灵提示在这段时间内不闪回。 */
    let GHOST_SUPPRESS_MS = 2000;
    /** 没出卡时，等多久再露出「补生成」按钮（给自动生成留窗口，避免闪一下）。 */
    let RETRY_GRACE_MS = 2500;

    /**
     * 简体中文字典（键集的事实来源）。
     * @type {Record<string, string>}
     */
    let zh = {
      "card.aria": "下一步建议",
      "summary.expand": "展开",
      "summary.collapse": "收起",
      "pill.aria": "发送：{label}",
      "pill.draftBusy": "输入框已有内容，先清空再发送",
      sent: "已发出",
      sentLabel: "已发出：{label}",
      dismiss: "关闭",
      "ghost.aria": "按 Tab 或 → 接受这条建议",
      "error.stale": "这条建议已过期，请用最新的一条",
      "error.missing": "找不到这条建议",
      "error.disabled": "插件已停用",
      "error.failed": "操作失败，请重试",
      "error.aborted": "生成超时或被取消，请重试",
      "error.send": "没能把建议写进输入框",
      "error.budget": "本会话的卡片预算已用完",
      "error.exists": "这一轮已经有卡片了",
      "error.inflight": "正在生成，请稍候",
      "error.noTurn": "没有可生成建议的回合",
      "retry.generate": "生成下一步建议",
      "retry.generating": "正在生成…",
      "settings.title": "下一步建议",
      "settings.nav": "下一步建议",
      "settings.desc":
        "答完后判断是否值得继续；需要时生成一张含摘要、提问与 1–2 条具体建议的决策卡（一次额外模型调用）。",
      "settings.enabled": "启用插件",
      "settings.card": "回答下方的决策卡",
      "settings.ghost": "输入框里的幽灵提示",
      "settings.pauseLabel": "生成节奏",
      "settings.pause": "暂停 1 小时",
      "settings.resume": "恢复生成",
      "settings.budget": "每会话最多",
      "settings.budgetUnit": "张卡",
      "settings.diagnostics": "诊断",
      "settings.refresh": "刷新",
      "settings.tier": "出卡频率",
      "settings.tier.must": "严格",
      "settings.tier.could": "平衡",
      "settings.tier.any": "积极",
      "settings.tier.mustHint": "只在明确需要时出卡",
      "settings.tier.couldHint": "拿不准也出卡（默认）",
      "settings.tier.anyHint": "每轮都出卡，含模型判为不需要的（实验档）",
      "settings.advanced": "更多设置",
      "settings.telemetry": "本地采集与复盘数据",
      "settings.telemetryHint": "只写本机文件，不含你的原文",
      "settings.telemetryStats": "事件 {events} 条 · {size}",
      "settings.review": "回顾",
      "settings.reviewMetrics":
        "出卡率 {shown} · 点击率 {clicked} · 忽略率 {ignored} · 漏判 {missed}",
      "settings.reviewInsufficient": "样本不足（{turns} 回合 / {shown} 张卡），继续积累",
      "settings.report": "生成报告",
      "settings.reporting": "正在生成…",
      "settings.reportDone": "已生成 {file}",
      "settings.reportFailed": "生成失败",
      "settings.promptVersion": "提示词 v{version} · 口径 {scheme}",
      "error.hidden": "这张建议当前没有显示",
      "settings.stats":
        "已生成 {generated}（未显示 {hidden}） · 失败 {failed} · 已中止 {aborted} · 跳过 {skipped} · 在途 {inflight}",
      "settings.lastError": "最近错误：{message}",
      "settings.noError": "无错误",
      "settings.paused": "已暂停，约 {time} 后恢复",
      "settings.offHint": "关闭后不会发起任何请求；已生成的卡片仍留在对话里。",
      "settings.lastSkip": "最近跳过：{kind} · {reason}",
      "settings.generateHint":
        "没有自动出卡时，最新回答下方会出现「生成下一步建议」，点一下即可补一张。",
      "settings.updateFailed": "保存失败",
      "settings.version": "版本 {version} · 构建 {hash}",
    };

    /**
     * English dictionary (same key set as `zh`).
     * @type {Record<string, string>}
     */
    let en = {
      "card.aria": "Next-step suggestion",
      "summary.expand": "Show more",
      "summary.collapse": "Show less",
      "pill.aria": "Send: {label}",
      "pill.draftBusy": "Clear the composer first",
      sent: "Sent",
      sentLabel: "Sent: {label}",
      dismiss: "Dismiss",
      "ghost.aria": "Press Tab or → to accept this suggestion",
      "error.stale": "This suggestion is out of date; use the newest one",
      "error.missing": "That suggestion is no longer available",
      "error.disabled": "The plugin is disabled",
      "error.failed": "Something went wrong. Try again.",
      "error.aborted": "Generation timed out or was cancelled. Try again.",
      "error.send": "Could not fill the composer",
      "error.budget": "This session has used up its card budget",
      "error.exists": "This turn already has a card",
      "error.inflight": "Already generating; try again in a moment",
      "error.noTurn": "No completed turn to generate a card for",
      "retry.generate": "Generate a next-step card",
      "retry.generating": "Generating…",
      "settings.title": "Next-step suggestions",
      "settings.nav": "Next-step suggestions",
      "settings.desc":
        "Judges whether a turn is worth continuing; when it is, adds a status summary, a question and 1–2 concrete next steps (one extra model call).",
      "settings.enabled": "Enable the plugin",
      "settings.card": "Decision card under the answer",
      "settings.ghost": "Ghost hint in the composer",
      "settings.pauseLabel": "Cadence",
      "settings.pause": "Pause for 1 hour",
      "settings.resume": "Resume",
      "settings.budget": "Per session, at most",
      "settings.budgetUnit": "cards",
      "settings.diagnostics": "Diagnostics",
      "settings.refresh": "Refresh",
      "settings.tier": "Card frequency",
      "settings.tier.must": "Strict",
      "settings.tier.could": "Balanced",
      "settings.tier.any": "Eager",
      "settings.tier.mustHint": "Only when it is clearly needed",
      "settings.tier.couldHint": "Also when it is a plausible next step (default)",
      "settings.tier.anyHint": "Every turn, even when judged unnecessary (experimental)",
      "settings.advanced": "More settings",
      "settings.telemetry": "Local usage data",
      "settings.telemetryHint": "Local file only, never your message text",
      "settings.telemetryStats": "{events} events · {size}",
      "settings.review": "Review",
      "settings.reviewMetrics":
        "Cards {shown} · clicked {clicked} · ignored {ignored} · missed {missed}",
      "settings.reviewInsufficient": "Not enough data ({turns} turns / {shown} cards); keep going",
      "settings.report": "Generate report",
      "settings.reporting": "Generating…",
      "settings.reportDone": "Written {file}",
      "settings.reportFailed": "Could not generate",
      "settings.promptVersion": "Prompt v{version} · scheme {scheme}",
      "error.hidden": "This suggestion is not shown right now",
      "settings.stats":
        "Generated {generated} ({hidden} hidden) · failed {failed} · aborted {aborted} · skipped {skipped} · in flight {inflight}",
      "settings.lastError": "Last error: {message}",
      "settings.noError": "No errors",
      "settings.paused": "Paused; resumes in about {time}",
      "settings.offHint": "While off, no request is made; cards already in the conversation stay.",
      "settings.lastSkip": "Last skipped: {kind} · {reason}",
      "settings.generateHint":
        "When no card appears, a “Generate a next-step card” button shows under the latest answer.",
      "settings.updateFailed": "Could not save",
      "settings.version": "Version {version} · build {hash}",
    };

    /**
     * RPC 失败原因到文案 key 的映射（契约 §3 的 reason 枚举）。
     * @type {Record<string, string>}
     */
    let ERROR_KEYS = {
      stale: "error.stale",
      missing: "error.missing",
      disabled: "error.disabled",
      hidden: "error.hidden",
    };

    /** 手动补生成失败原因 → 文案 key。 @type {Record<string, string>} */
    let RETRY_ERROR_KEYS = {
      stale: "error.stale",
      disabled: "error.disabled",
      budget: "error.budget",
      exists: "error.exists",
      inflight: "error.inflight",
      "no-turn": "error.noTurn",
      failed: "error.failed",
      schema: "error.failed",
      aborted: "error.aborted",
      "not-needed": "error.failed",
    };

    // 颜色/尺寸严格照契约 §5 的表：优先用宿主 token，token 缺失时用截图实测值兜底。
    // 只注入这一份样式（data-plugin-css 判重，HMR/重复挂载不会再插一份）。
    let CSS = `
.ns_card{box-sizing:border-box;position:relative;margin:8px 8px 2px;padding:12px 14px 14px;border:1px solid var(--dsw-alias-border-l2,#242424);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#202020);color:var(--dsw-alias-label-primary,#e8e8e8);font-size:13px;line-height:20px;box-shadow:none;}
.ns_body{min-width:0;padding-right:22px;}
.ns_summary{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a4a4a4);white-space:pre-wrap;overflow-wrap:anywhere;}
.ns_card[data-ns-expanded="true"] .ns_summary{display:block;-webkit-line-clamp:unset;line-clamp:unset;overflow:visible;}
.ns_more{align-self:flex-start;margin:4px 0 0;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#a4a4a4);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;}
.ns_more:hover{color:var(--dsw-alias-label-secondary,#a4a4a4);}
.ns_more:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;border-radius:4px;}
.ns_question{margin:16px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e8e8e8);white-space:pre-wrap;overflow-wrap:anywhere;}
.ns_pills{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px;}
.ns_pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:28px;height:auto;padding:4px 12px;border:1px solid transparent;border-radius:16px;font-family:inherit;font-size:13px;line-height:20px;font-weight:400;text-align:left;cursor:pointer;transition:opacity 120ms ease,border-color 120ms ease,color 120ms ease;}
.ns_pillPrimary{background:var(--dsw-alias-label-primary,#efefef);color:var(--dsw-alias-bg-base,#191919);font-weight:500;}
.ns_pillPrimary:hover:not(:disabled){opacity:.9;}
.ns_pillSecondary{background:transparent;border-color:var(--dsw-alias-border-l4,#424242);color:var(--dsw-alias-label-secondary,#d2d2d2);}
.ns_pillSecondary:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary,#a4a4a4);color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;}
.ns_pill:disabled{cursor:not-allowed;opacity:.5;}
.ns_label{min-width:0;overflow-wrap:anywhere;white-space:normal;}
.ns_key{flex:none;padding:0 4px;border-radius:4px;background:var(--dsw-alias-label-secondary,#c5c5c5);color:var(--dsw-alias-bg-base,#191919);font-size:11px;font-weight:400;line-height:16px;}
.ns_spinner{flex:none;width:12px;height:12px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:ns_spin .8s linear infinite;}
.ns_close{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#a4a4a4);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;}
.ns_close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_close:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px;}
.ns_close:disabled{cursor:not-allowed;opacity:.5;}
.ns_sentRow{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:12px 0 0;}
.ns_sentChip{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:28px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l3,#3a3a3a);border-radius:16px;background:transparent;color:var(--dsw-alias-label-secondary,#a4a4a4);font-family:inherit;font-size:13px;line-height:20px;overflow-wrap:anywhere;text-align:left;}
.ns_sentMark{flex:none;color:var(--dsw-alias-state-success-secondary,#4fb477);font-size:12px;line-height:16px;}
.ns_sent{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,#81858c);}
.ns_error{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#f25a5a);}
.ns_retry{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:6px 8px 2px 8px;}
.ns_retryBtn{display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:2px 10px;border:1px dashed var(--dsw-alias-border-l3,#3a3a3a);border-radius:12px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;}
.ns_retryBtn:hover:not(:disabled){color:var(--dsw-alias-label-secondary,#a4a4a4);border-color:var(--dsw-alias-border-l4,#4a4a4a);}
.ns_retryBtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;}
.ns_retryBtn:disabled{cursor:default;opacity:.6;}
.ns_retryError{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,#81858c);}
.ns_ghost{position:absolute;z-index:1;top:12px;left:14px;right:12px;color:var(--dsw-alias-label-caption,#81858c);font-size:inherit;line-height:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;user-select:none;}
@keyframes ns_spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.ns_spinner{animation-duration:2.4s;}}
.ns_settings{display:flex;flex-direction:column;gap:10px;padding:12px 0;font-size:13px;line-height:20px;}
.ns_setTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_setDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a4a4a4);}
.ns_setRow{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.ns_setLabel{color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_setHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}
.ns_switch{appearance:none;border:0;background:transparent;padding:0;cursor:pointer;display:inline-flex;line-height:0;}
.ns_switch:disabled{opacity:.5;cursor:default;}
.ns_track{width:34px;height:20px;border-radius:10px;background:var(--dsw-alias-border-l3,#3a3a3a);position:relative;transition:background-color .12s;display:inline-block;}
.ns_track[data-on="true"]{background:var(--dsw-alias-state-business-primary,#4d7cfe);}
.ns_thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:#fff;transition:transform .12s;}
.ns_track[data-on="true"] .ns_thumb{transform:translateX(14px);}
.ns_setBtn{height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l3,#3a3a3a);background:transparent;color:var(--dsw-alias-label-secondary,#a4a4a4);font-size:12px;cursor:pointer;}
.ns_setBtn:hover{color:var(--dsw-alias-label-primary,#e8e8e8);border-color:var(--dsw-alias-border-l4,#4a4a4a);}
.ns_tiers{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l3,#3a3a3a);border-radius:13px;}
.ns_tier{height:22px;padding:0 10px;border:0;border-radius:11px;background:transparent;color:var(--dsw-alias-label-secondary,#a4a4a4);font-family:inherit;font-size:12px;cursor:pointer;}
.ns_tier[data-on="true"]{background:var(--dsw-alias-bg-layer-3,#2e2e2e);color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_tier:disabled{cursor:default;opacity:.6;}
.ns_tier:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px;}
.ns_advBtn{display:inline-flex;align-items:center;gap:4px;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;}
.ns_advBtn:hover{color:var(--dsw-alias-label-secondary,#a4a4a4);}
.ns_advBtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;border-radius:4px;}
.ns_advBody{display:flex;flex-direction:column;gap:10px;padding:10px 0 0 0;border-top:1px solid var(--dsw-alias-border-l2,#242424);}
.ns_review{display:flex;flex-direction:column;gap:6px;padding-top:2px;}
.ns_reviewStats{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a4a4a4);}
.ns_reviewVerdict{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}
.ns_setBtn:disabled{opacity:.5;cursor:default;}
.ns_setInput{width:64px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,#3a3a3a);background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);font-size:12px;padding:0 8px;}
.ns_diag{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:pre-wrap;overflow-wrap:anywhere;}
.ns_setError{font-size:12px;color:var(--dsw-alias-label-primary,#e8e8e8);}
`;

    // ------------------------------------------------------------------
    // 小工具（全部是纯函数，不碰 DOM / 全局状态）
    // ------------------------------------------------------------------

    /**
     * slot 的 `t` 缺失时的兜底（返回 key 本身）。
     * @param {string} key
     * @param {Record<string, unknown>} [_params]
     * @returns {string}
     */
    function fallbackTranslate(key, _params) {
      return key;
    }

    /** @type {any} 标准 hook 缺失时的占位，保证 hook 调用顺序稳定。 */
    let emptySelectorHook = function emptySelectorHook() {
      return undefined;
    };
    /** @type {any} */
    let emptyKeyedHook = function emptyKeyedHook() {
      return undefined;
    };

    /**
     * 文件体积的可读形式（诊断用）。
     * @param {number} bytes
     * @returns {string}
     */
    function formatBytes(bytes) {
      let value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
      if (value < 1024) return `${String(Math.round(value))} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** 高精度时钟（曝光计时用；performance 缺失时回落 Date.now）。 @returns {number} */
    function now() {
      return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    }

    /**
     * Turn 对象里的轮次数字（渲染 slot 时宿主传的是 Turn 记录，不是数字）。
     * @param {any} turn
     * @returns {number}
     */
    function turnNumberOf(turn) {
      if (!turn || typeof turn !== "object") return -1;
      return typeof turn.turn === "number" && Number.isFinite(turn.turn) ? turn.turn : -1;
    }

    /**
     * 槽位是否已经可以渲染：流式中（没有 turn/end）或 closing === null（Stop / 报错 / 无文本）都不渲染。
     * @param {any} turn
     * @returns {boolean}
     */
    function isTurnTailReady(turn) {
      if (!turn || typeof turn !== "object") return false;
      if (turn.end === undefined || turn.end === null) return false;
      let data = turn.data;
      if (!data || typeof data.get !== "function") return false;
      let tail = data.get("turn-tail");
      if (tail === undefined || tail === null) return false;
      return tail.closing !== null && tail.closing !== undefined;
    }

    /**
     * 从投影视图里取一张卡。
     * @param {any} view
     * @param {number} turn
     * @returns {any}
     */
    function cardOf(view, turn) {
      if (!view || typeof view !== "object") return undefined;
      let cards = view.cards;
      if (!cards || typeof cards !== "object" || turn < 0) return undefined;
      return cards[String(turn)];
    }

    /**
     * 这一轮的候选是否已被用户要求显示（揭示）。
     * @param {any} view
     * @param {number} turn
     * @returns {boolean}
     */
    function revealedOf(view, turn) {
      if (!view || typeof view !== "object") return false;
      let reveals = view.reveals;
      if (!reveals || typeof reveals !== "object" || turn < 0) return false;
      return reveals[String(turn)] === true;
    }

    /**
     * 从投影视图里取一条决策。
     * @param {any} view
     * @param {number} turn
     * @returns {any}
     */
    function decisionOf(view, turn) {
      if (!view || typeof view !== "object") return undefined;
      let decisions = view.decisions;
      if (!decisions || typeof decisions !== "object" || turn < 0) return undefined;
      return decisions[String(turn)];
    }

    /**
     * 最新一张**出过**的卡所在的轮次（-1 = 没有卡）。
     * `shown === false` 的候选是"决定不展示"的，绝不能拿来喂幽灵提示——否则门控白做。
     * @param {any} view
     * @returns {number}
     */
    function latestCardTurnOf(view) {
      if (!view || typeof view !== "object") return -1;
      let cards = view.cards;
      if (!cards || typeof cards !== "object") return -1;
      let latest = -1;
      for (let key of Object.keys(cards)) {
        let value = Number(key);
        let card = cards[key];
        if (!Number.isFinite(value) || value <= latest || !card) continue;
        // 旧记录没有 shown 字段 → 视为出过（向后兼容）
        if (card.shown === false && view.reveals?.[key] !== true) continue;
        latest = value;
      }
      return latest;
    }

    /**
     * 卡片/幽灵的视觉状态：投影优先，其次本轮乐观态。
     * @param {any} decision
     * @param {string} optimistic "" | "sent" | "dismissed"
     * @param {number} pendingIndex >= 0 表示 RPC 在途
     * @param {boolean} isLastTurn
     * @returns {"interactive" | "sending" | "sent" | "dismissed" | "readonly"}
     */
    function phaseOf(decision, optimistic, pendingIndex, isLastTurn) {
      if (decision && typeof decision === "object") {
        if (decision.phase === "sent" || decision.phase === "dismissed") return decision.phase;
        // superseded 或未知 phase：历史卡只读
        return "readonly";
      }
      if (optimistic === "sent" || optimistic === "dismissed") return optimistic;
      if (!isLastTurn) return "readonly";
      return pendingIndex >= 0 ? "sending" : "interactive";
    }

    /**
     * RPC 返回里的可发送文本（`{ ok: true, text }`）。
     * @param {any} result
     * @returns {string}
     */
    function answerTextOf(result) {
      return result && typeof result === "object" && typeof result.text === "string"
        ? result.text
        : "";
    }

    /**
     * RPC 失败原因 → 文案 key。
     * @param {any} result
     * @returns {string}
     */
    function errorKeyOf(result) {
      if (result && typeof result === "object" && typeof result.reason === "string") {
        let mapped = ERROR_KEYS[result.reason];
        if (typeof mapped === "string") return mapped;
      }
      return "error.failed";
    }

    /**
     * 幽灵提示的身份串：同一张卡的同一段 nextPrompt 只清除一次。
     * @param {number} turn
     * @param {string} text
     * @returns {string}
     */
    function ghostKeyOf(turn, text) {
      return `${String(turn)}\u0000${text}`;
    }

    /**
     * 纯修饰键（Shift / Meta / Control / Alt / CapsLock）不算「输入第一个字符」。
     * @param {string} code
     * @returns {boolean}
     */
    function isModifierCode(code) {
      return (
        code === "ShiftLeft" ||
        code === "ShiftRight" ||
        code === "MetaLeft" ||
        code === "MetaRight" ||
        code === "ControlLeft" ||
        code === "ControlRight" ||
        code === "AltLeft" ||
        code === "AltRight" ||
        code === "CapsLock" ||
        code === "Fn" ||
        code === "FnLock"
      );
    }

    /**
     * 键帽文案只是视觉提示（v1 不绑定快捷键）：mac 用 ⌘↵，其它平台 Ctrl+↵。
     * @returns {string}
     */
    function detectKeycap() {
      let apple = false;
      try {
        if (typeof document !== "undefined" && document.documentElement) {
          apple = document.documentElement.dataset.platform === "darwin";
        }
      } catch (_error) {
        apple = false;
      }
      if (!apple) {
        try {
          let platform = typeof navigator === "undefined" ? "" : navigator.platform || "";
          let agent = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
          apple = /Mac|iPod|iPhone|iPad/u.test(platform) || /Macintosh/u.test(agent);
        } catch (_error) {
          apple = false;
        }
      }
      return apple ? "⌘↵" : "Ctrl+↵";
    }

    /**
     * 等 setDraft 落定：readDraft 返回当前草稿，与 text 一致即视为落定。
     * @param {() => (string | undefined)} readDraft
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    function waitDraftSettled(readDraft, text) {
      return new Promise((resolve) => {
        let tries = 0;
        let tick = () => {
          let draft;
          try {
            draft = readDraft();
          } catch (_error) {
            draft = undefined;
          }
          if (draft === text) {
            resolve(true);
            return;
          }
          tries += 1;
          if (tries >= DRAFT_POLL_TRIES) {
            resolve(false);
            return;
          }
          setTimeout(tick, DRAFT_POLL_INTERVAL_MS);
        };
        tick();
      });
    }

    /**
     * 读输入框 façade 的草稿快照（拿不到返回 undefined）。
     * @param {any} shell
     * @returns {string | undefined}
     */
    function shellDraftOf(shell) {
      try {
        let state = shell?.state;
        let snapshot =
          state && typeof state.getSnapshot === "function" ? state.getSnapshot() : undefined;
        if (snapshot && typeof snapshot.draft === "string") return snapshot.draft;
      } catch (_error) {
        return undefined;
      }
      return undefined;
    }

    // ------------------------------------------------------------------
    // 键盘桥：组件登记「当前可交互的卡 / 幽灵」，apply 里的 fixed-input 观察者消费
    // ------------------------------------------------------------------

    /** @type {Map<string, {insert: () => boolean, typed: () => void, clear: () => void}>} */
    let ghostEntries = new Map();
    /** 决策卡的 ⌘/Ctrl+Enter 桥：只有可交互时才登记。 @type {Map<string, {ready: () => boolean, accept: () => void}>} */
    let cardEntries = new Map();

    /**
     * 输入框候选菜单（斜杠命令 / @ 引用）是否开着：开着时 Enter 归菜单，别抢。
     * @param {any} target 键盘事件的焦点元素
     * @returns {boolean}
     */
    function hasComposerMenu(target) {
      try {
        let card =
          target && typeof target.closest === "function"
            ? target.closest("[data-composer-card]")
            : null;
        if (!card || typeof card.querySelector !== "function") return false;
        return card.querySelector('[role="listbox"]') !== null;
      } catch (_error) {
        return false;
      }
    }

    /**
     * 宿主 fixed-input 观察通道（docs/runtime/0.2.2-rc.1.md §9.5）：
     * - 卡片：⌘/Ctrl+Enter 接受 primary（只在输入框干净、空闲、卡片可交互时接管）；
     * - 幽灵：Tab / → 接受，Esc 清除，其它按键 → 2s 内不闪回。
     * 裸 Tab / 方向键在输入框里是编辑动作，注册快捷键会冲突；这条通道连输入法组合都替我们算好了。
     * @param {any} input
     * @returns {void}
     */
    function onFixedInput(input) {
      if (input?.type !== "keydown") return;
      let gesture = input.gesture || {};
      let context = input.context || {};
      if (context.modal !== null && context.modal !== undefined) return;
      if (context.region !== "editable") return;
      let target = context.target;
      let occurrence =
        target && typeof target.closest === "function"
          ? target.closest("[data-conversation-session]")
          : null;
      if (!occurrence || typeof occurrence.getAttribute !== "function") return;
      let sessionId = occurrence.getAttribute("data-conversation-session");
      if (!sessionId) return;

      let code = typeof gesture.code === "string" ? gesture.code : "";
      let primaryModifier = gesture.meta === true || gesture.control === true;
      // 小键盘回车是 `NumpadEnter`，语义与 `Enter` 相同；只认 `Enter` 会让外接键盘上的 ⌘↵ 静默失效。
      let enterLike = code === "Enter" || code === "NumpadEnter";

      // 卡片快捷键：宿主的同一个手势是「Queue/Steer 互补发送」，但空草稿时它是 no-op
      // （dsh-client-ui-conversation 的 empty-draft no-op），所以只在「输入干净 + 空闲 +
      // 本会话有可交互卡」时接管；其余情况完全透传，绝不抢排队/插话的语义。
      if (
        enterLike &&
        primaryModifier &&
        !(gesture.meta === true && gesture.control === true) &&
        !gesture.alt &&
        !gesture.shift
      ) {
        let cardEntry = cardEntries.get(sessionId);
        if (!cardEntry || gesture.repeat || gesture.composing) return;
        if (hasComposerMenu(target)) return;
        if (!cardEntry.ready()) return;
        if (typeof input.consume === "function") {
          try {
            input.consume();
          } catch (_error) {
            /* consume 失败不影响发送 */
          }
        }
        cardEntry.accept();
        return;
      }

      let entry = ghostEntries.get(sessionId);
      if (!entry) return;

      // Esc：只清除本次建议，不 consume（把宿主 / 其它插件的 Esc Esc 让出去）。
      if (code === "Escape" && !gesture.control && !gesture.alt && !gesture.meta) {
        if (!gesture.repeat) entry.clear();
        return;
      }

      // Tab / → 接受：只在本会话的幽灵提示可见时接管。
      if (code === "Tab" || code === "ArrowRight") {
        if (gesture.shift || gesture.control || gesture.alt || gesture.meta) return;
        if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return;
        if (entry.insert() && typeof input.consume === "function") {
          try {
            input.consume();
          } catch (_error) {
            /* consume 失败不影响插入结果 */
          }
        }
        return;
      }

      if (isModifierCode(code)) return;
      if (gesture.defaultPrevented) return;
      // 输入第一个字符：立即消失，且 2s 内不再闪回。
      entry.typed();
    }

    // ------------------------------------------------------------------
    // A. 决策卡
    // ------------------------------------------------------------------

    /**
     * 决策卡组件：只对最后一轮渲染可交互态，更早的卡渲染只读态。
     * @param {any} props slot 注入的 props（turn / seq / openFile / sessionId / t / 标准 hooks / api）
     * @returns {any}
     */
    function NextStepTail(props) {
      let api = props.api;
      let t = typeof props.t === "function" ? props.t : fallbackTranslate;
      let useProjection =
        typeof props.useProjection === "function" ? props.useProjection : emptyKeyedHook;
      let useChat = typeof props.useChat === "function" ? props.useChat : emptySelectorHook;
      let useInput = typeof props.useInput === "function" ? props.useInput : emptySelectorHook;
      let inputActions = props.inputActions;

      let turn = props.turn;
      let turnNumber = turnNumberOf(turn);
      let sessionId = typeof props.sessionId === "string" ? props.sessionId : "";

      let view = useProjection("nextStep");
      let isLastTurn = useChat((/** @type {any} */ snapshot) => {
        let order = snapshot?.timeline?.turnOrder;
        return Array.isArray(order) && order.length > 0
          ? order[order.length - 1] === turnNumber
          : false;
      });
      let useSession =
        typeof props.useSession === "function" ? props.useSession : emptySelectorHook;
      let inputDraft = useInput((/** @type {any} */ input) =>
        input && typeof input.draft === "string" ? input.draft : "",
      );
      let draft = typeof inputDraft === "string" ? inputDraft : "";
      // ⌘/Ctrl+Enter 的门：输入框必须干净（与幽灵提示同一套条件），会话必须空闲。
      let attachmentCount = useInput((/** @type {any} */ input) =>
        input && Array.isArray(input.attachmentIds) ? input.attachmentIds.length : 0,
      );
      let occurrenceCount = useInput((/** @type {any} */ input) =>
        Array.isArray(input?.occurrences) ? input.occurrences.length : 0,
      );
      let inputPhase = useInput((/** @type {any} */ input) =>
        input && typeof input.phase === "string" ? input.phase : "",
      );
      let hasClaim = useInput((/** @type {any} */ input) => Boolean(input?.claim));
      let idle = useSession(
        (/** @type {any} */ session) =>
          Boolean(session) && session.running !== true && !session.removed && !session.subagent,
      );

      // 发送流程要拿「最新」草稿（façade 缺失时的兜底信号），不能读渲染期的旧值。
      let draftRef = React.useRef(draft);
      draftRef.current = draft;

      let pendingState = React.useState(-1);
      let pendingIndex = pendingState[0];
      let setPendingIndex = pendingState[1];
      // 点过之后要回显的那一粒（投影追上之前先记在这里；投影里的 decision.index 优先）。
      let chosenState = React.useState(-1);
      let chosenIndex = chosenState[0];
      let setChosenIndex = chosenState[1];
      let optimisticState = React.useState("");
      let optimistic = optimisticState[0];
      let setOptimistic = optimisticState[1];
      let errorState = React.useState("");
      let errorKey = errorState[0];
      let setErrorKey = errorState[1];
      let expandedState = React.useState(false);
      let expanded = expandedState[0];
      let setExpanded = expandedState[1];
      let moreState = React.useState(false);
      let showMore = moreState[0];
      let setShowMore = moreState[1];
      let summaryRef = React.useRef(/** @type {any} */ (null));
      let cardRef = React.useRef(/** @type {any} */ (null));

      // 「没出卡时」的补生成入口：设置只从宿主 RPC 读（投影里没有 settings）。
      let settingsState = React.useState(/** @type {any} */ (null));
      let settings = settingsState[0];
      let setSettings = settingsState[1];
      let retryState = React.useState("");
      let retryPhase = retryState[0];
      let setRetryPhase = retryState[1];
      let retryErrorState = React.useState("");
      let retryErrorKey = retryErrorState[0];
      let setRetryErrorKey = retryErrorState[1];
      let graceState = React.useState(false);
      let grace = graceState[0];
      let setGrace = graceState[1];

      let card = cardOf(view, turnNumber);
      let decision = decisionOf(view, turnNumber);
      let revealed = revealedOf(view, turnNumber);
      // 被档位抑制、用户还没要求显示的候选：不渲染卡片，只渲染「生成下一步建议」。
      let hiddenCard = card !== undefined && card !== null && card.shown === false && !revealed;

      // 只有「最新一轮且没有卡」才需要读设置（决定要不要画补生成按钮），
      // 历史轮次不读，避免一个长会话里每个 turn-tail 都发一次 RPC。
      React.useEffect(() => {
        if (!api || typeof api.settings !== "function") return undefined;
        if (!isLastTurn) return undefined;
        if (card !== undefined && card !== null && !hiddenCard) return undefined;
        let alive = true;
        Promise.resolve(api.settings())
          .then((value) => {
            if (alive) setSettings(value || null);
          })
          .catch(() => undefined);
        return () => {
          alive = false;
        };
      }, [api, card, hiddenCard, isLastTurn]);

      // 留 2.5s 给自动生成：期间按钮不出现，避免「按钮闪一下又被卡片顶掉」。
      React.useEffect(() => {
        if (!isLastTurn || (card !== undefined && card !== null && !hiddenCard)) {
          setGrace(false);
          return undefined;
        }
        let timer = setTimeout(() => setGrace(true), RETRY_GRACE_MS);
        return () => clearTimeout(timer);
      }, [turnNumber, card, hiddenCard, sessionId, isLastTurn]);

      // 投影一旦追上，乐观态就退场（投影是唯一事实来源）。
      React.useEffect(() => {
        if (decision && optimistic !== "") setOptimistic("");
      }, [decision, optimistic]);

      // 摘要超过 2 行才出「展开 / 收起」；折叠状态才测量，展开状态保留按钮。
      React.useLayoutEffect(() => {
        let element = summaryRef.current;
        if (!element || expanded) return;
        let overflowing = element.scrollHeight > element.clientHeight + 1;
        setShowMore(overflowing);
      });

      let visibleCard = card !== undefined && card !== null && !hiddenCard ? card : null;
      let options = visibleCard && Array.isArray(visibleCard.options) ? visibleCard.options : [];
      let summary =
        visibleCard && typeof visibleCard.summary === "string" ? visibleCard.summary : "";
      let question =
        visibleCard && typeof visibleCard.question === "string" ? visibleCard.question : "";
      let status = phaseOf(decision, optimistic, pendingIndex, isLastTurn);
      let busy = status === "sending";
      let showPills = (status === "interactive" || status === "sending") && options.length > 0;
      let draftBusy = draft !== "";
      let canCall = Boolean(api) && typeof api.act === "function";
      let keycap = api && typeof api.keycap === "string" ? api.keycap : "⌘↵";

      /**
       * 点击胶囊：RPC → 立刻切只读态 → 写草稿、等落定、提交。
       * @param {number} index
       */
      let sendPill = (index) => {
        if (busy || pendingIndex >= 0 || optimistic !== "") return;
        if (draftBusy) return;
        if (!canCall || !api || typeof api.sendText !== "function") {
          setErrorKey("error.failed");
          return;
        }
        setErrorKey("");
        setPendingIndex(index);
        setChosenIndex(index);
        Promise.resolve(api.act(sessionId, turnNumber, index))
          .then((result) => {
            let text = answerTextOf(result);
            setPendingIndex(-1);
            if (text === "") {
              setErrorKey(errorKeyOf(result));
              return undefined;
            }
            // RPC 一返回就切只读态，不等发送完成（发送慢时不至于卡在 sending）。
            setOptimistic("sent");
            return Promise.resolve(
              api.sendText(sessionId, text, inputActions, () => draftRef.current),
            ).then((outcome) => {
              if (outcome !== "ok") setErrorKey("error.send");
            });
          })
          .catch(() => {
            setPendingIndex(-1);
            setErrorKey("error.failed");
          });
      };

      /** ✕：dismiss RPC → 只读态。 */
      let dismissCard = () => {
        if (busy || !api || typeof api.dismiss !== "function") return;
        setErrorKey("");
        Promise.resolve(api.dismiss(sessionId, turnNumber))
          .then((result) => {
            if (result?.ok !== true) {
              setErrorKey(errorKeyOf(result));
              return;
            }
            setOptimistic("dismissed");
          })
          .catch(() => {
            setErrorKey("error.failed");
          });
      };

      // 卡片快捷键桥：只有「这一步真的能点」时才登记，键盘观察者据此决定是否接管 ⌘/Ctrl+Enter。
      // 注意：登记的时机与「卡片是否已经到达」无关——卡片是**投影晚到**的（宿主在回合结束后
      // 才生成），回合尾部先挂载、status 先变成 interactive，卡片数据随后才进来。若登记只在
      // status/sessionId 变化时重跑，晚到的卡片永远登记不上，⌘↵ 会静默失效（点击仍然正常）。
      let sendPillRef = React.useRef(/** @type {(index: number) => void} */ (() => {}));
      sendPillRef.current = sendPill;
      let gateRef = React.useRef({ ready: false });
      gateRef.current = {
        ready:
          sessionId !== "" &&
          draft === "" &&
          attachmentCount === 0 &&
          occurrenceCount === 0 &&
          inputPhase === "plain" &&
          !hasClaim &&
          idle === true &&
          !busy &&
          pendingIndex < 0 &&
          optimistic === "",
      };

      React.useEffect(() => {
        if (sessionId === "" || status !== "interactive" || !visibleCard || options.length === 0) {
          return undefined;
        }
        let entry = {
          ready: () => gateRef.current.ready,
          accept: () => sendPillRef.current(0),
        };
        cardEntries.set(sessionId, entry);
        return () => {
          if (cardEntries.get(sessionId) === entry) cardEntries.delete(sessionId);
        };
        // 可见性（而不是卡片对象本身）必须进依赖：卡片晚到时这个 effect 要再跑一次。
      }, [sessionId, status, visibleCard === null, options.length]);

      // 曝光：卡片**真正进入视口**才上报（挂载 ≠ 被看见）。只在最新一轮的可交互卡上观察，
      // 历史卡滚动回来不上报（它们的曝光在第一眼就该记过一次了）。
      React.useEffect(() => {
        if (!api || typeof api.impress !== "function") return undefined;
        if (isLastTurn !== true || visibleCard === null) return undefined;
        let element = cardRef.current;
        if (!element) return undefined;
        let sent = false;
        let total = 0;
        let started = 0;
        let ratio = 0;
        let send = (/** @type {number} */ visibleMs) => {
          if (sent) return;
          sent = true;
          Promise.resolve(api.impress(sessionId, turnNumber, visibleMs, ratio)).catch(
            () => undefined,
          );
        };
        // 没有 IntersectionObserver 的宿主：给 ratio=-1（报表单列"未知"，不混进曝光率分母）
        if (typeof IntersectionObserver !== "function") {
          ratio = -1;
          send(0);
          return undefined;
        }
        let observer = new IntersectionObserver(
          (entries) => {
            for (let entry of entries) {
              if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                if (started === 0) started = now();
                ratio = entry.intersectionRatio;
              } else if (started !== 0) {
                total += now() - started;
                started = 0;
              }
            }
          },
          { threshold: [0, 0.5, 1] },
        );
        observer.observe(element);
        let ticker = setInterval(() => {
          if (sent) return;
          if (started !== 0 && total + (now() - started) >= 300) send(total + (now() - started));
        }, 250);
        // 5s 内一次都没进视口 → 记一条 visibleMs=0（"挂载了但没看见"，与"看见但没点"要分开）
        let unseen = setTimeout(() => {
          if (!sent && total === 0 && started === 0) send(0);
        }, 5000);
        return () => {
          observer.disconnect();
          clearInterval(ticker);
          clearTimeout(unseen);
        };
      }, [api, isLastTurn, sessionId, turnNumber, visibleCard === null]);

      if (turnNumber < 0 || !isTurnTailReady(turn)) return null;
      if (visibleCard === null) {
        // 只在最新一轮、且卡面开着的时候给「补生成」入口。
        let retryEnabled =
          sessionId !== "" &&
          isLastTurn &&
          grace &&
          settings !== null &&
          settings.enabled === true &&
          settings.card === true &&
          Boolean(api) &&
          typeof api.generate === "function";
        if (!retryEnabled) return null;
        let generating = retryPhase === "loading";
        return h(
          "section",
          {
            className: "ns_retry",
            "data-next-step-retry": "",
            "data-next-step-turn": String(turnNumber),
          },
          h(
            "button",
            {
              type: "button",
              className: "ns_retryBtn",
              "data-next-step-generate": "",
              disabled: generating,
              onClick: () => {
                if (generating || !api || typeof api.generate !== "function") return;
                setRetryPhase("loading");
                setRetryErrorKey("");
                Promise.resolve(api.generate(sessionId, turnNumber))
                  .then((result) => {
                    setRetryPhase("");
                    if (result && typeof result === "object" && result.ok === true) return;
                    let reason =
                      result && typeof result.reason === "string" ? result.reason : "failed";
                    setRetryErrorKey(RETRY_ERROR_KEYS[reason] ?? "error.failed");
                  })
                  .catch(() => {
                    setRetryPhase("");
                    setRetryErrorKey("error.failed");
                  });
              },
            },
            generating ? t("retry.generating") : t("retry.generate"),
          ),
          retryErrorKey === ""
            ? null
            : h(
                "span",
                { className: "ns_retryError", role: "alert", "data-next-step-retry-error": "" },
                t(retryErrorKey),
              ),
        );
      }

      /**
       * 一粒胶囊：第 0 条是 primary（带纯视觉键帽），第 1 条是 secondary。
       * @param {any} option
       * @param {number} index
       * @returns {any}
       */
      let renderPill = (option, index) => {
        let isPrimary = index === 0;
        let label = option && typeof option.label === "string" ? option.label : "";
        let stance = option && typeof option.stance === "string" ? option.stance : "";
        let disabled = busy || draftBusy;
        let title = draftBusy ? t("pill.draftBusy") : undefined;
        let children = [];
        if (busy && pendingIndex === index) {
          children.push(
            h("span", { key: "spinner", className: "ns_spinner", "aria-hidden": "true" }),
          );
        }
        children.push(h("span", { key: "label", className: "ns_label" }, label));
        if (isPrimary) {
          children.push(
            h("span", { key: "key", className: "ns_key", "aria-hidden": "true" }, keycap),
          );
        }
        return h(
          "button",
          {
            key: `pill-${String(index)}`,
            type: "button",
            className: `ns_pill ${isPrimary ? "ns_pillPrimary" : "ns_pillSecondary"}`,
            "data-next-step-pill": "",
            "data-stance": stance,
            "data-index": String(index),
            "data-text": label,
            disabled: disabled,
            title: title,
            "aria-label": t("pill.aria", { label: label }),
            onClick: () => {
              sendPill(index);
            },
          },
          children,
        );
      };

      let body = [];
      if (summary !== "") {
        body.push(
          h(
            "p",
            {
              key: "summary",
              ref: summaryRef,
              className: "ns_summary",
              "data-next-step-summary": "",
            },
            summary,
          ),
        );
        if (showMore) {
          body.push(
            h(
              "button",
              {
                key: "more",
                type: "button",
                className: "ns_more",
                "data-next-step-more": "",
                "aria-expanded": expanded ? "true" : "false",
                onClick: () => {
                  setExpanded(!expanded);
                },
              },
              t(expanded ? "summary.collapse" : "summary.expand"),
            ),
          );
        }
      }
      // 提问段任何状态都保留（只读 / 已发出 / 已关闭）。
      if (question !== "") {
        body.push(
          h(
            "p",
            { key: "question", className: "ns_question", "data-next-step-question": "" },
            question,
          ),
        );
      }
      if (showPills) {
        body.push(
          h(
            "div",
            { key: "pills", className: "ns_pills", "data-next-step-pills": "" },
            options.map(renderPill),
          ),
        );
      }
      if (status === "sent") {
        // 回显被点的那一粒：投影里的 decision.index 优先，投影追上之前用本轮乐观态。
        let sentIndex =
          decision && Number.isSafeInteger(decision.index) ? decision.index : chosenIndex;
        let sentOption = sentIndex >= 0 ? options[sentIndex] : undefined;
        let sentLabel = sentOption && typeof sentOption.label === "string" ? sentOption.label : "";
        body.push(
          h(
            "p",
            {
              key: "sent",
              className: "ns_sentRow",
              role: "status",
              "data-next-step-sent": "",
              "data-next-step-sent-label": sentLabel,
              "aria-label": sentLabel === "" ? t("sent") : t("sentLabel", { label: sentLabel }),
            },
            sentLabel === ""
              ? h("span", { key: "word", className: "ns_sent" }, t("sent"))
              : [
                  h(
                    "span",
                    { key: "chip", className: "ns_sentChip" },
                    h("span", { className: "ns_sentMark", "aria-hidden": "true" }, "✓"),
                    h("span", { className: "ns_label" }, sentLabel),
                  ),
                  h("span", { key: "word", className: "ns_sent" }, t("sent")),
                ],
          ),
        );
      }
      if (errorKey !== "") {
        body.push(h("p", { key: "error", className: "ns_error", role: "alert" }, t(errorKey)));
      }

      let children = [h("div", { key: "body", className: "ns_body" }, body)];
      if (showPills) {
        children.push(
          h(
            "button",
            {
              key: "dismiss",
              type: "button",
              className: "ns_close",
              "data-next-step-dismiss": "",
              "aria-label": t("dismiss"),
              disabled: busy,
              onClick: () => {
                dismissCard();
              },
            },
            "✕",
          ),
        );
      }

      return h(
        "section",
        {
          ref: cardRef,
          className: "ns_card",
          "data-next-step-card": "",
          "data-next-step-turn": String(turnNumber),
          "data-next-step-state": status,
          "data-ns-expanded": expanded ? "true" : "false",
          "aria-label": t("card.aria"),
        },
        children,
      );
    }

    // ------------------------------------------------------------------
    // B. 幽灵提示
    // ------------------------------------------------------------------

    /**
     * 幽灵提示组件：默认关闭（settings.ghost），只在输入框干净且会话空闲时显示最新卡的 nextPrompt。
     * @param {any} props slot 注入的 props
     * @returns {any}
     */
    function NextStepGhost(props) {
      let api = props.api;
      let t = typeof props.t === "function" ? props.t : fallbackTranslate;
      let useProjection =
        typeof props.useProjection === "function" ? props.useProjection : emptyKeyedHook;
      let useInput = typeof props.useInput === "function" ? props.useInput : emptySelectorHook;
      let useSession =
        typeof props.useSession === "function" ? props.useSession : emptySelectorHook;
      let inputActions = props.inputActions;
      let sessionId = typeof props.sessionId === "string" ? props.sessionId : "";

      let view = useProjection("nextStep");
      let draft = useInput((/** @type {any} */ input) =>
        input && typeof input.draft === "string" ? input.draft : "",
      );
      let phase = useInput((/** @type {any} */ input) =>
        input && typeof input.phase === "string" ? input.phase : "",
      );
      let attachmentCount = useInput((/** @type {any} */ input) =>
        input && Array.isArray(input.attachmentIds) ? input.attachmentIds.length : 0,
      );
      let occurrenceCount = useInput((/** @type {any} */ input) =>
        Array.isArray(input?.occurrences) ? input.occurrences.length : 0,
      );
      let hasClaim = useInput((/** @type {any} */ input) => Boolean(input?.claim));
      let idle = useSession(
        (/** @type {any} */ session) =>
          Boolean(session) && session.running !== true && !session.removed && !session.subagent,
      );

      let suppressState = React.useState(0);
      let suppressUntil = suppressState[0];
      let setSuppressUntil = suppressState[1];
      let clearedState = React.useState("");
      let clearedKey = clearedState[0];
      let setClearedKey = clearedState[1];
      let settingsState = React.useState(/** @type {any} */ (null));
      let settings = settingsState[0];
      let setSettings = settingsState[1];
      let ghostRef = React.useRef(/** @type {any} */ (null));

      let latestTurn = latestCardTurnOf(view);
      let card = cardOf(view, latestTurn);
      let decided = decisionOf(view, latestTurn) !== undefined;
      // 原样显示（不截断）：桌面端只读回归会拿 textContent 和投影里的 nextPrompt 对比。
      let rawPrompt = card && typeof card.nextPrompt === "string" ? card.nextPrompt : "";
      let prompt = rawPrompt.trim() === "" ? "" : rawPrompt;
      let promptKey = ghostKeyOf(latestTurn, prompt);
      let suppressed = suppressUntil > Date.now();
      let enabled = Boolean(settings) && settings.ghost === true;
      // `/` 与 `@` 的候选菜单是 composer 卡片里的 role="listbox"（宿主 input-trigger / commands）。
      // 菜单打开时不能画幽灵：它会和候选列表抢同一块位置（phase 只在斜杠命令下变 claimed，
      // `@` 引用菜单打开时 phase 仍是 plain，所以这里补一层 DOM 观察）。
      let menuState = React.useState(false);
      let menuOpen = menuState[0];
      let setMenuOpen = menuState[1];
      React.useEffect(() => {
        if (typeof document === "undefined" || typeof MutationObserver !== "function") {
          return undefined;
        }
        /** @type {any} */
        let observer = null;
        /** @type {any} */
        let timer = null;
        let attach = () => {
          let card = document.querySelector("[data-composer-card]");
          if (!card) {
            timer = setTimeout(attach, 300);
            return;
          }
          let update = () => setMenuOpen(card.querySelector('[role="listbox"]') !== null);
          update();
          observer = new MutationObserver(update);
          observer.observe(card, { childList: true, subtree: true });
        };
        attach();
        return () => {
          if (timer !== null) clearTimeout(timer);
          if (observer !== null) observer.disconnect();
        };
      }, []);

      let visible =
        sessionId !== "" &&
        enabled &&
        prompt !== "" &&
        !decided &&
        clearedKey !== promptKey &&
        !suppressed &&
        draft === "" &&
        phase === "plain" &&
        !hasClaim &&
        !menuOpen &&
        attachmentCount === 0 &&
        occurrenceCount === 0 &&
        idle === true;

      // 设置只从宿主 RPC 读（投影里没有 settings）；失败就静默当关闭。
      React.useEffect(() => {
        if (!api || typeof api.settings !== "function") return undefined;
        let alive = true;
        Promise.resolve(api.settings())
          .then((value) => {
            if (alive) setSettings(value || null);
          })
          .catch(() => undefined);
        return () => {
          alive = false;
        };
      }, [api]);

      // 登记到键盘桥：只有可见时登记，Tab / → 才会被接管。
      React.useEffect(() => {
        if (!visible) return undefined;
        let actions = inputActions;
        let entry = {
          insert: () => {
            if (!actions) return false;
            if (typeof actions.captureInsertion !== "function") return false;
            if (typeof actions.insertText !== "function") return false;
            try {
              let span = actions.captureInsertion();
              return actions.insertText(prompt, span) === true;
            } catch (_error) {
              return false;
            }
          },
          typed: () => {
            setSuppressUntil(Date.now() + GHOST_SUPPRESS_MS);
          },
          clear: () => {
            setClearedKey(promptKey);
          },
        };
        ghostEntries.set(sessionId, entry);
        return () => {
          if (ghostEntries.get(sessionId) === entry) ghostEntries.delete(sessionId);
        };
      }, [visible, prompt, promptKey, sessionId, inputActions]);

      // 抑制到期自动解除（2s 内不闪回）。
      React.useEffect(() => {
        if (suppressUntil === 0) return undefined;
        let remaining = suppressUntil - Date.now();
        if (remaining <= 0) {
          setSuppressUntil(0);
          return undefined;
        }
        let timer = setTimeout(() => setSuppressUntil(0), remaining + 30);
        return () => clearTimeout(timer);
      }, [suppressUntil]);

      // 对齐宿主 placeholder：同基线、同字号（查不到就用 CSS 的兜底值）。
      React.useLayoutEffect(() => {
        let element = ghostRef.current;
        if (!element || typeof element.closest !== "function") return;
        let cardElement = element.closest("[data-composer-card]");
        if (!cardElement || typeof cardElement.querySelector !== "function") return;
        let placeholder = cardElement.querySelector("[data-composer-placeholder]");
        if (!placeholder) return;
        let cardBox = cardElement.getBoundingClientRect();
        let placeholderBox = placeholder.getBoundingClientRect();
        if (!placeholderBox || placeholderBox.width <= 0) return;
        element.style.top = `${placeholderBox.top - cardBox.top}px`;
        element.style.left = `${placeholderBox.left - cardBox.left}px`;
        element.style.maxWidth = `${placeholderBox.width}px`;
        try {
          let computed =
            typeof window === "undefined" ? null : window.getComputedStyle(placeholder);
          if (computed) {
            element.style.fontSize = computed.fontSize;
            element.style.lineHeight = computed.lineHeight;
          }
        } catch (_error) {
          /* 取不到计算样式就沿用 CSS 兜底 */
        }
      });

      if (!visible) {
        // 诊断用：ghost 面已打开但没显示时，留一个隐藏标记说明是哪条门挡住了。
        // 不参与视觉、不影响可访问性，但让「幽灵不出现」可定位（冒烟/桌面/升级排障都用它）。
        if (!enabled) return null;
        let reason = "unknown";
        if (sessionId === "") reason = "no-session";
        else if (prompt === "") reason = "no-prompt";
        else if (decided) reason = "decided";
        else if (clearedKey === promptKey) reason = "cleared";
        else if (suppressed) reason = "suppressed";
        else if (draft !== "") reason = "draft";
        else if (phase !== "plain") reason = `phase:${phase}`;
        else if (hasClaim) reason = "claim";
        else if (menuOpen) reason = "menu";
        else if (attachmentCount !== 0) reason = "attachments";
        else if (occurrenceCount !== 0) reason = "refs";
        else if (idle !== true) reason = "not-idle";
        return h("span", {
          "data-next-step-ghost-off": reason,
          style: { display: "none" },
        });
      }

      return h(
        "span",
        {
          ref: ghostRef,
          className: "ns_ghost",
          "data-next-step-ghost": "",
          "data-next-step-ghost-text": prompt,
          "aria-label": t("ghost.aria"),
          title: t("ghost.aria"),
        },
        prompt,
      );
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------

    /**
     * 设置页 → 通用 里的「下一步建议」行：总开关、两个面、暂停、预算与诊断。
     * `settings.general.item` 是无 owner props 的 list 槽，数据全部由 api 自取。
     * @param {any} props
     * @returns {any}
     */
    /**
     * 设置页 → 「下一步建议」分节。
     *
     * v0.4 按 [plugin-conventions §7.2] 收敛：**首屏 3 行**（启用 / 出卡频率 / 决策卡），
     * 其余（幽灵、暂停、预算、诊断、回顾）收进「更多设置」折叠，默认收起。
     * 总开关关闭时只留总开关 + 一行说明（关闭 = 不发请求，别的项不该看起来还在跑）。
     * @param {any} props
     * @returns {any}
     */
    function NextStepSettings(props) {
      let api = props.api;
      let t = typeof props.t === "function" ? props.t : fallbackTranslate;
      let settingsState = React.useState(/** @type {any} */ (null));
      let settings = settingsState[0];
      let setSettings = settingsState[1];
      let statsState = React.useState(/** @type {any} */ (null));
      let stats = statsState[0];
      let setStats = statsState[1];
      let errorState = React.useState("");
      let errorKey = errorState[0];
      let setErrorKey = errorState[1];
      let busyState = React.useState("");
      let busy = busyState[0];
      let setBusy = busyState[1];
      let budgetState = React.useState("");
      let budgetDraft = budgetState[0];
      let setBudgetDraft = budgetState[1];
      let advancedState = React.useState(false);
      let advanced = advancedState[0];
      let setAdvanced = advancedState[1];
      let reviewState = React.useState(/** @type {any} */ (null));
      let review = reviewState[0];
      let setReview = reviewState[1];
      let reportState = React.useState("");
      let reportState2 = reportState[0];
      let setReportState = reportState[1];
      let reportPathState = React.useState("");
      let reportPath = reportPathState[0];
      let setReportPath = reportPathState[1];

      let refresh = React.useCallback(() => {
        if (!api) return;
        if (typeof api.settings === "function") {
          Promise.resolve(api.settings())
            .then((value) => {
              if (value) setSettings(value);
            })
            .catch(() => undefined);
        }
        if (typeof api.diagnostics === "function") {
          Promise.resolve(api.diagnostics())
            .then((value) => {
              if (value) setStats(value);
            })
            .catch(() => undefined);
        }
        // 回顾块只要指标，不落盘（落盘是「生成报告」按钮的事）
        if (typeof api.report === "function") {
          Promise.resolve(api.report(false))
            .then((value) => {
              if (value) setReview(value);
            })
            .catch(() => undefined);
        }
      }, [api]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      let patch = (/** @type {any} */ value, /** @type {string} */ label) => {
        if (!api || typeof api.updateSettings !== "function") {
          setErrorKey("settings.updateFailed");
          return;
        }
        setBusy(label);
        setErrorKey("");
        Promise.resolve(api.updateSettings(value))
          .then((result) => {
            setBusy("");
            if (result?.ok !== true) {
              setErrorKey("settings.updateFailed");
              return;
            }
            if (result.settings) setSettings(result.settings);
            if (typeof api.diagnostics === "function") {
              Promise.resolve(api.diagnostics())
                .then((value) => {
                  if (value) setStats(value);
                })
                .catch(() => undefined);
            }
          })
          .catch(() => {
            setBusy("");
            setErrorKey("settings.updateFailed");
          });
      };

      if (settings === null) {
        return h(
          "div",
          { className: "ns_settings", "data-next-step-settings": "" },
          h("div", { className: "ns_setTitle" }, t("settings.title")),
          h("div", { className: "ns_setDesc" }, "…"),
        );
      }

      let switchRow = (/** @type {string} */ key, /** @type {string} */ labelKey) => {
        let on = settings[key] === true;
        return h("div", { className: "ns_setRow", key: key }, [
          h("span", { className: "ns_setLabel", key: "label" }, t(labelKey)),
          h(
            "button",
            {
              key: "switch",
              type: "button",
              role: "switch",
              "aria-checked": on ? "true" : "false",
              "data-next-step-switch": key,
              className: "ns_switch",
              disabled: busy === key,
              onClick: () => patch({ [key]: !on }, key),
            },
            h(
              "span",
              { className: "ns_track", "data-on": on ? "true" : "false", "aria-hidden": "true" },
              h("span", { className: "ns_thumb" }),
            ),
          ),
        ]);
      };

      /** 出卡频率：三档分段控件，点了立刻写盘（不藏进折叠里——这是本次最主要的旋钮）。 */
      let tierRow = () => {
        let current = typeof settings.cardThreshold === "string" ? settings.cardThreshold : "could";
        let tiers = ["must", "could", "any"];
        return h("div", { className: "ns_setRow", key: "tier" }, [
          h("span", { className: "ns_setLabel", key: "label" }, t("settings.tier")),
          h(
            "div",
            {
              key: "group",
              className: "ns_tiers",
              role: "radiogroup",
              "aria-label": t("settings.tier"),
            },
            tiers.map((/** @type {string} */ tier) =>
              h(
                "button",
                {
                  key: tier,
                  type: "button",
                  role: "radio",
                  "aria-checked": current === tier ? "true" : "false",
                  "data-next-step-tier": tier,
                  "data-on": current === tier ? "true" : "false",
                  className: "ns_tier",
                  title: t(`settings.tier.${tier}Hint`),
                  disabled: busy === "tier",
                  onClick: () => {
                    if (current === tier) return;
                    patch({ cardThreshold: tier }, "tier");
                  },
                },
                t(`settings.tier.${tier}`),
              ),
            ),
          ),
        ]);
      };

      let paused = typeof settings.pauseUntil === "number" && settings.pauseUntil > Date.now();
      let minutes = paused
        ? Math.max(1, Math.round((settings.pauseUntil - Date.now()) / 60000))
        : 0;

      let diagText = "";
      if (stats !== null) {
        diagText = t("settings.stats", {
          generated: String(stats.generated || 0),
          hidden: String(stats.hidden || 0),
          failed: String(stats.failed || 0),
          aborted: String(stats.aborted || 0),
          skipped: String(stats.skipped || 0),
          inflight: String(stats.inflight || 0),
        });
        let lastError = typeof stats.lastError === "string" ? stats.lastError : "";
        diagText +=
          "\n" +
          (lastError === ""
            ? t("settings.noError")
            : t("settings.lastError", { message: lastError }));
        // 「最近为什么没出卡」：模型判断不需要 / 排队 / 暂停 / 预算，都写在这里。
        let lastSkip = stats.lastSkip;
        if (
          lastSkip &&
          typeof lastSkip === "object" &&
          typeof lastSkip.reason === "string" &&
          lastSkip.reason !== ""
        ) {
          diagText += `\n${t("settings.lastSkip", {
            kind: typeof lastSkip.kind === "string" ? lastSkip.kind : "",
            reason: lastSkip.reason,
          })}`;
        }
        if (typeof stats.version === "string" && stats.version !== "") {
          let buildHash = typeof stats.buildHash === "string" ? stats.buildHash.slice(0, 8) : "";
          diagText += `\n${t("settings.version", { version: stats.version, hash: buildHash })}`;
          if (typeof stats.promptVersion === "number") {
            diagText += `\n${t("settings.promptVersion", {
              version: String(stats.promptVersion),
              scheme: typeof stats.scheme === "string" ? stats.scheme : "—",
            })}`;
          }
        }
        let telemetry = stats.telemetry;
        if (telemetry && typeof telemetry === "object") {
          diagText += `\n${t("settings.telemetryStats", {
            events: String(telemetry.lines || 0),
            size: formatBytes(telemetry.bytes || 0),
          })}`;
          if (typeof telemetry.path === "string" && telemetry.path !== "") {
            diagText += `\n${telemetry.path}`;
          }
        }
      }

      /** 回顾块：4 个数字 + 「生成报告」。样本不足时明写，不让人看一堆 0% 乱猜。 */
      let reviewRows = [];
      if (review !== null && typeof review === "object" && review.metrics) {
        let metrics = review.metrics;
        let rates = metrics.rates || {};
        let fmt = (/** @type {any} */ value) =>
          typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
        reviewRows.push(
          h(
            "div",
            { className: "ns_reviewStats", key: "stats", "data-next-step-review-stats": "" },
            review.insufficient === true
              ? t("settings.reviewInsufficient", {
                  turns: String(metrics.turns || 0),
                  shown: String(metrics.shown || 0),
                })
              : t("settings.reviewMetrics", {
                  shown: fmt(rates.cardRate),
                  clicked: fmt(rates.ctr),
                  ignored: fmt(rates.ignoreRate),
                  missed: String(metrics.misses || 0),
                }),
          ),
        );
        if (
          review.insufficient !== true &&
          Array.isArray(review.verdicts) &&
          review.verdicts.length > 0
        ) {
          reviewRows.push(
            h(
              "div",
              {
                className: "ns_reviewVerdict",
                key: "verdict",
                "data-next-step-review-verdict": "",
              },
              String(review.verdicts[0].text || ""),
            ),
          );
        }
      }
      reviewRows.push(
        h("div", { className: "ns_setRow", key: "report" }, [
          h("span", { className: "ns_setLabel", key: "label" }, t("settings.review")),
          h(
            "button",
            {
              key: "btn",
              type: "button",
              className: "ns_setBtn",
              "data-next-step-report": "",
              disabled: reportState2 === "loading" || !api || typeof api.report !== "function",
              onClick: () => {
                if (!api || typeof api.report !== "function") return;
                setReportState("loading");
                setReportPath("");
                Promise.resolve(api.report(true))
                  .then((result) => {
                    setReportState("");
                    if (!result) {
                      setReportState("failed");
                      return;
                    }
                    let path = typeof result.path === "string" ? result.path : "";
                    setReportPath(path.split("/").pop() || path);
                    if (result.metrics) setReview(result);
                    if (typeof api.diagnostics === "function") {
                      Promise.resolve(api.diagnostics())
                        .then((value) => {
                          if (value) setStats(value);
                        })
                        .catch(() => undefined);
                    }
                  })
                  .catch(() => {
                    setReportState("failed");
                  });
              },
            },
            reportState2 === "loading" ? t("settings.reporting") : t("settings.report"),
          ),
        ]),
      );
      if (reportState2 === "failed") {
        reviewRows.push(
          h(
            "div",
            { className: "ns_setError", key: "reportError", role: "alert" },
            t("settings.reportFailed"),
          ),
        );
      }
      if (reportPath !== "") {
        reviewRows.push(
          h(
            "div",
            {
              className: "ns_setHint",
              key: "reportPath",
              "data-next-step-report-path": "",
              title: reportPath,
            },
            t("settings.reportDone", { file: reportPath }),
          ),
        );
      }

      let enabledOn = settings.enabled === true;
      let rows = [
        h("div", { key: "head" }, [
          h("div", { className: "ns_setTitle", key: "title" }, t("settings.title")),
          h("div", { className: "ns_setDesc", key: "desc" }, t("settings.desc")),
        ]),
        switchRow("enabled", "settings.enabled"),
      ];
      if (!enabledOn) {
        rows.push(
          h(
            "div",
            { key: "off", className: "ns_setHint", "data-next-step-off": "" },
            t("settings.offHint"),
          ),
        );
      } else {
        // 首屏 3 行：启用 / 出卡频率 / 决策卡
        rows.push(tierRow(), switchRow("card", "settings.card"));
        rows.push(
          h(
            "div",
            { className: "ns_setRow", key: "advanced" },
            h(
              "button",
              {
                type: "button",
                className: "ns_advBtn",
                "data-next-step-advanced": "",
                "aria-expanded": advanced ? "true" : "false",
                onClick: () => setAdvanced(!advanced),
              },
              h("span", { key: "chevron", "aria-hidden": "true" }, advanced ? "▾ " : "▸ "),
              h("span", { key: "label" }, t("settings.advanced")),
            ),
          ),
        );
        if (advanced) {
          rows.push(
            h(
              "div",
              { className: "ns_advBody", key: "advBody", "data-next-step-advanced-body": "" },
              [
                switchRow("ghost", "settings.ghost"),
                switchRow("telemetry", "settings.telemetry"),
                h("div", { className: "ns_setRow", key: "pause" }, [
                  h(
                    "span",
                    { className: "ns_setLabel", key: "label" },
                    paused
                      ? t("settings.paused", { time: `${String(minutes)}m` })
                      : t("settings.pauseLabel"),
                  ),
                  h(
                    "button",
                    {
                      key: "btn",
                      type: "button",
                      className: "ns_setBtn",
                      "data-next-step-pause": "",
                      disabled: busy === "pause",
                      onClick: () =>
                        patch({ pauseUntil: paused ? 0 : Date.now() + 3600000 }, "pause"),
                    },
                    paused ? t("settings.resume") : t("settings.pause"),
                  ),
                ]),
                h("div", { className: "ns_setRow", key: "budget" }, [
                  h(
                    "span",
                    { className: "ns_setLabel", key: "label" },
                    `${t("settings.budget")} ${t("settings.budgetUnit")}`,
                  ),
                  h("input", {
                    key: "input",
                    type: "number",
                    min: "0",
                    max: "1000",
                    className: "ns_setInput",
                    "data-next-step-budget": "",
                    "aria-label": `${t("settings.budget")} ${t("settings.budgetUnit")}`,
                    value: budgetDraft === "" ? String(settings.maxCardsPerSession) : budgetDraft,
                    onChange: (/** @type {any} */ event) =>
                      setBudgetDraft(String(event.target.value)),
                    onBlur: () => {
                      if (budgetDraft === "") return;
                      patch({ maxCardsPerSession: Number(budgetDraft) }, "budget");
                      setBudgetDraft("");
                    },
                  }),
                ]),
                h("div", { className: "ns_setRow", key: "diag" }, [
                  h("span", { className: "ns_setLabel", key: "label" }, t("settings.diagnostics")),
                  h(
                    "button",
                    {
                      key: "refresh",
                      type: "button",
                      className: "ns_setBtn",
                      "data-next-step-refresh": "",
                      onClick: () => refresh(),
                    },
                    t("settings.refresh"),
                  ),
                ]),
                diagText === ""
                  ? null
                  : h(
                      "div",
                      { className: "ns_diag", key: "diagText", "data-next-step-diag": "" },
                      diagText,
                    ),
                h(
                  "div",
                  { className: "ns_review", key: "review", "data-next-step-review": "" },
                  reviewRows,
                ),
                h(
                  "div",
                  { className: "ns_setHint", key: "hint", "data-next-step-hint": "" },
                  t("settings.generateHint"),
                ),
              ],
            ),
          );
        }
      }
      if (errorKey !== "") {
        rows.push(h("div", { className: "ns_setError", key: "error", role: "alert" }, t(errorKey)));
      }
      return h("div", { className: "ns_settings", "data-next-step-settings": "" }, rows);
    }

    exports.inject = ["slots", "locale", "connection"];

    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "next-step: dictionaries");
      // settings.section 的 label 是惰性求值的，需要一个绑定到本插件的翻译函数。
      const tr = ctx.locale.bind(NS);

      // 只注入一份样式；判重让 HMR / 重复挂载不会插第二份。
      ctx.effect(() => {
        if (typeof document === "undefined" || !document.head) return undefined;
        let selector = `style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`;
        if (document.querySelector(selector) !== null) return undefined;
        let tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "next-step: styles");

      /**
       * 取宿主服务（服务可能缺席，绝不能抛）。
       * @param {string} name
       * @returns {any}
       */
      let serviceOf = (name) => {
        try {
          if (ctx && typeof ctx.get === "function") {
            let found = ctx.get(name);
            if (found !== undefined && found !== null) return found;
          }
        } catch (_error) {
          /* 服务未挂载 */
        }
        try {
          return ctx ? ctx[name] : undefined;
        } catch (_error) {
          return undefined;
        }
      };

      /**
       * Typert Remote 调用：统一解开 { ok, value } 信封，失败返回 undefined。
       * @param {string} method
       * @param {any} [request]
       * @returns {Promise<any>}
       */
      let callRemote = (method, request) => {
        let connection = serviceOf("connection");
        let channel = connection?.rpc;
        if (!channel || typeof channel.call !== "function") return Promise.resolve(undefined);
        let payload = request === undefined ? { args: {} } : { args: { request } };
        try {
          return Promise.resolve(channel.call("/api", `nextStep/${method}`, payload)).then(
            (result) => {
              if (result && typeof result === "object" && Object.hasOwn(result, "value")) {
                return result.value;
              }
              return result;
            },
            () => undefined,
          );
        } catch (_error) {
          return Promise.resolve(undefined);
        }
      };

      /**
       * 解析某个会话的输入框 façade（契约 §4）。
       * @param {string} sessionId
       * @returns {any}
       */
      let shellOf = (sessionId) => {
        if (!sessionId) return undefined;
        try {
          let conversation = serviceOf("conversation");
          let input = conversation?.input;
          if (!input) return undefined;
          if (typeof input.shell === "function") {
            try {
              let shell = input.shell(sessionId);
              if (shell) return shell;
            } catch (_error) {
              /* 退到 for(scope) */
            }
          }
          if (typeof input.for === "function") {
            let sessions = serviceOf("sessions");
            let scope =
              sessions && typeof sessions.scope === "function"
                ? sessions.scope(sessionId)
                : undefined;
            if (scope !== undefined) return input.for(scope);
          }
        } catch (_error) {
          return undefined;
        }
        return undefined;
      };

      /**
       * 写草稿 → 等落定 → 提交。绝不覆盖用户已有草稿（胶囊在草稿非空时是禁用的，这里再兜一道）。
       * @param {string} sessionId
       * @param {string} text
       * @param {any} fallbackActions slot 注入的 inputActions
       * @param {() => string} readFallbackDraft 渲染期草稿的兜底读法
       * @returns {Promise<"ok" | "empty" | "no-composer" | "not-settled">}
       */
      let sendText = (sessionId, text, fallbackActions, readFallbackDraft) => {
        if (typeof text !== "string" || text === "") return Promise.resolve("empty");
        let shell = shellOf(sessionId);
        let actions = shell?.actions ?? fallbackActions;
        if (!actions || typeof actions.setDraft !== "function") {
          return Promise.resolve("no-composer");
        }
        try {
          actions.setDraft(text);
        } catch (_error) {
          return Promise.resolve("no-composer");
        }
        let readDraft = () => {
          let snapshotDraft = shellDraftOf(shell);
          if (typeof snapshotDraft === "string") return snapshotDraft;
          try {
            return typeof readFallbackDraft === "function" ? readFallbackDraft() : undefined;
          } catch (_error) {
            return undefined;
          }
        };
        return waitDraftSettled(readDraft, text).then((settled) => {
          // 只有确认草稿就是我们要发的那段文本才提交，绝不发用户自己的内容。
          if (!settled && readDraft() !== text) return "not-settled";
          try {
            if (typeof actions.submit === "function") actions.submit();
          } catch (_error) {
            return "not-settled";
          }
          return "ok";
        });
      };

      let api = {
        keycap: detectKeycap(),
        act: (
          /** @type {string} */ sessionId,
          /** @type {number} */ turn,
          /** @type {number} */ index,
        ) => callRemote("act", { sessionId: sessionId, turn: turn, index: index }),
        dismiss: (/** @type {string} */ sessionId, /** @type {number} */ turn) =>
          callRemote("dismiss", { sessionId: sessionId, turn: turn }),
        settings: () =>
          callRemote("settings").then((result) => {
            if (!result || typeof result !== "object") return null;
            if (result.ok === false) return null;
            return result.settings && typeof result.settings === "object"
              ? result.settings
              : result;
          }),
        sendText: sendText,
        generate: (/** @type {string} */ sessionId, /** @type {number} */ turn) =>
          callRemote("generateNow", { sessionId: sessionId, turn: turn }),
        updateSettings: (/** @type {any} */ patch) =>
          callRemote("updateSettings", { patch: patch }).then((result) =>
            result && typeof result === "object" ? result : { ok: false },
          ),
        impress: (
          /** @type {string} */ sessionId,
          /** @type {number} */ turn,
          /** @type {number} */ visibleMs,
          /** @type {number} */ ratio,
        ) =>
          callRemote("impression", {
            sessionId: sessionId,
            turn: turn,
            visibleMs: visibleMs,
            ratio: ratio,
          }),
        report: (/** @type {boolean} */ write) =>
          callRemote("report", { write: write === true }).then((result) =>
            result && typeof result === "object" && result.ok === true ? result : null,
          ),
        diagnostics: () =>
          callRemote("diagnostics").then((result) => {
            if (!result || typeof result !== "object" || result.ok !== true) return null;
            return result.stats && typeof result.stats === "object" ? result.stats : null;
          }),
      };

      // 决策卡：每轮答案尾部一张。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.chat.turnTail", () =>
            ctx.slots.register(
              {
                name: "conversation.chat.turnTail",
                id: "next-step",
                locale: NS,
                inject: () => ({ api: api }),
              },
              NextStepTail,
            ),
          ),
        "next-step: card",
      );

      // 幽灵提示：输入框覆盖层（默认关，settings.ghost 打开才显示）。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.input.overlay", () =>
            ctx.slots.register(
              {
                name: "conversation.input.overlay",
                id: "next-step-ghost",
                order: 10,
                locale: NS,
                inject: () => ({ api: api }),
              },
              NextStepGhost,
            ),
          ),
        "next-step: ghost",
      );

      // 设置 → 下一步建议（独立分节；原来挤在「通用设置」里）。
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "next-step",
                order: 93,
                label: () => tr("settings.nav"),
                locale: NS,
                inject: () => ({ api: api }),
              },
              NextStepSettings,
            ),
          ),
        "next-step: settings",
      );

      // 键盘：宿主的 fixed-input 观察通道（Tab / → 接受，Esc 清除）。
      try {
        ctx.inject(["shortcuts"], (/** @type {any} */ scope) => {
          let shortcuts = scope?.shortcuts;
          if (!shortcuts || typeof shortcuts.observeFixedInput !== "function") return;
          scope.effect(() => shortcuts.observeFixedInput(onFixedInput), "next-step: ghost keys");
        });
      } catch (_error) {
        /* shortcuts 缺失：幽灵提示只显示、不响应键盘 */
      }
    };

    return module.exports;
  },
});
