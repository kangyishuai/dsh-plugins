// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能使用 import / JSX。
// 功能：
// A. 装饰 `/advisor` 命令：popupSelect 列出「宿主已配置」的顾问候选（当前 / 各路由模型 / off / 去配置），
//    每次打开都重新走 advisor/candidates RPC，绝不跨次缓存路由或模型。
// B. 选中反馈：advisor/setModel 的结果（成功或结构化的失败原因）通过 shell.overlay 里右下角的
//    一行轻量提示显示，4 秒后自动消失；默认不渲染任何东西。
// C. 所有宿主调用都走 ctx.connection.rpc.call("/api", "advisor/<method>", { args: { request } })，
//    client 不直连 llm 服务。任何一路失败（服务缺失、RPC 抛错、返回畸形）都降级成一个引导选项，
//    options 永远 resolve 数组、onSelect 永不抛错。
// 参考：packages/session-rewind/lib/client.js（commandUi.decorate + popupSelect 样本）、
// packages/next-step/lib/client.js（callRemote 信封解包）、packages/session-delete/lib/client.js（toast）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-advisor",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;

    /** @type {any} */
    let React = require("react");
    let h = React.createElement;

    /** locale 命名空间：必须与 locale/*.json 顶层键、slot descriptor 的 locale 一致。 */
    let NS = "advisor";
    /** 插件标识：样式标签的归属，桌面端只读回归靠 style[data-plugin] 判断 client 半已加载。 */
    let PLUGIN_ID = "@kangyishuai/dsh-advisor";
    /** 轻量提示停留时间；到点后把自己清掉。 */
    let TOAST_MS = 4000;
    /**
     * 顾问线缓存：同一个 sessionId 只拉一次（成功结果与 in-flight Promise 都留在这里）。
     * 失败不进缓存（下一次挂载可以重试），页面刷新时整体失效；切会话是新的 key。
     * @type {Map<string, Promise<any[]>>}
     */
    let adviceCache = new Map();

    /** 简体中文字典（键集的事实来源）。 */
    /** @type {Record<string, string>} */
    let zh = {
      title: "让主模型在关键时刻咨询一个更强的顾问模型",
      "notReady.label": "顾问尚未就绪 · 打开 /advisor doctor",
      "notReady.detail": "宿主没有返回候选路由：插件可能未启用，或宿主 RPC 暂不可用",
      "group.current": "当前",
      "group.extras": "开关与配置",
      "current.detail": "本会话正在使用",
      "toast.current": "已经是当前顾问",
      "blocked.detail": "该路由当前不可用",
      "off.label": "不使用顾问（off）",
      "off.detail": "随时可用 /advisor 重新开启",
      "settings.label": "+ 添加或配置 provider…",
      "settings.detail": "打开 设置 → 模型",
      "settings.hint": "已把 /advisor doctor 放进输入框，回车查看下一步",
      "toast.settings": "请打开 设置 → 模型 添加或配置 provider",
      "search.placeholder": "搜索顾问模型…",
      "search.empty": "还没有可选的顾问模型",
      "search.noResults": "没有匹配的模型",
      "effort.auto": "自动",
      "toast.applied": "顾问已设为 {route}（思考档 {effort}），下一次徵询生效",
      "toast.off": "顾问已关闭，随时可用 /advisor 重新开启",
      "toast.stale": "这项选择已过期，请重新打开 /advisor",
      "error.failed": "设置失败，请重试",
      "error.unreachable": "连不上宿主，稍后重试或运行 /advisor doctor",
      "error.malformed": "宿主返回了无法识别的结果，运行 /advisor doctor 查看诊断",
      "settings.title": "顾问",
      "settings.desc": "设置顾问模式、路由、预算与隐私；保存后的改动对下一次徵询生效。",
      "settings.aria": "顾问设置",
      "settings.loading": "正在读取宿主设置…",
      "settings.retry": "重试",
      "settings.reload": "重新加载",
      "settings.save": "保存",
      "settings.saving": "保存中…",
      "settings.saved": "已保存",
      "settings.noChanges": "没有改动",
      "settings.group.basic": "基础",
      "settings.group.budget": "预算",
      "settings.group.privacy": "隐私",
      "settings.group.advanced": "高级与状态",
      "settings.mode": "模式",
      "settings.mode.off": "关闭（off）",
      "settings.mode.offHint": "不发起任何徵询，也不产生费用。",
      "settings.mode.shadow": "影子（shadow）",
      "settings.mode.shadowHint":
        "只记账，不回灌模型：仍会调用顾问并记录结果，但建议不会进入模型上下文。",
      "settings.mode.advisory": "顾问（advisory）",
      "settings.mode.advisoryHint":
        "正常徵询：顾问建议以工具卡回到模型上下文，模型可以采纳或忽略。",
      "settings.provider": "provider",
      "settings.provider.empty": "（未选择）",
      "settings.provider.declared": "自定义",
      "settings.provider.none": "宿主没有返回任何路由（llm 服务不可用？）",
      "settings.provider.stale": "（当前值不在路由清单）",
      "settings.model": "model",
      "settings.model.empty": "（未选择）",
      "settings.model.manual": "手填 model id",
      "settings.model.manualHint": "列表里没有时可直接手填；手填不校验是否在目录中。",
      "settings.model.loading": "正在读取模型…",
      "settings.model.pickProvider": "先选 provider",
      "settings.model.none": "该路由没有列出模型，可手填",
      "settings.model.stale": "（当前值不在模型清单）",
      "settings.effort": "思考档",
      "settings.effort.auto": "自动（模型默认）",
      "settings.effort.none": "该模型未声明思考档",
      "settings.effort.pickModel": "先选 model",
      "settings.effort.count": "模型声明了 {count} 个思考档",
      "settings.effort.stale": "（当前值不在模型声明里）",
      "settings.budget.maxCallsPerTurn": "每回合最多调用",
      "settings.budget.maxCallsPerSession": "每会话最多调用",
      "settings.budget.maxCallsPerHour": "每小时最多调用",
      "settings.budget.maxCostPerDayUsd": "每日预算（USD）",
      "settings.budget.priceInputPerMTok": "输入单价（USD / 百万 token）",
      "settings.budget.priceOutputPerMTok": "输出单价（USD / 百万 token）",
      "settings.budget.range": "默认 {default} · 范围 {min}–{max}",
      "settings.budget.rangeUnlimited": "默认 {default} · 范围 {min}–{max}（0 = 不限）",
      "settings.budget.priceHint": "0 = 不算钱，只统计 token",
      "settings.scope": "发送范围",
      "settings.scope.off": "off",
      "settings.scope.offHint": "不发送任何会话内容。",
      "settings.scope.summary": "summary",
      "settings.scope.summaryHint": "只发 300 字符的宿主注入上下文（不含文件全文）。",
      "settings.scope.full": "full",
      "settings.scope.fullHint": "发送完整上下文，按 maxInputChars 截断。",
      "settings.privacy.redact": "启发式脱敏",
      "settings.privacy.redactHint": "尽力而为的模式替换，不是密钥扫描器，仍可能漏检。",
      "settings.privacy.dedupe": "影子路径去重",
      "settings.privacy.dedupeHint": "只影响 shadow 路径：相同结论不重复记账。",
      "settings.advanced.maxTokens": "输出上限 maxTokens",
      "settings.advanced.temperature": "temperature",
      "settings.advanced.temperatureHint": "留空 = 不传，由 adapter 决定 · 范围 0–2",
      "settings.advanced.temperatureEmpty": "不传",
      "settings.advanced.maxInputChars": "输入上限 maxInputChars（字符）",
      "settings.advanced.sessionCap": "单会话投递上限 sessionCap",
      "settings.status.title": "状态摘要",
      "settings.status.calls": "累计调用 {count} 次",
      "settings.status.tokens": "in {input} / out {output} token",
      "settings.status.cost": "估算金额",
      "settings.status.costUnset": "未配置单价",
      "settings.status.last": "最近一次结果",
      "settings.status.skip": "最近跳过原因",
      "settings.status.ledger": "账本",
      "settings.status.none": "暂无",
      "settings.status.sep": "：",
      "settings.doctor": "诊断",
      "settings.doctor.run": "运行诊断",
      "settings.doctor.running": "诊断中…",
      "settings.doctor.empty": "没有返回检查项",
      "settings.error.unreachable": "宿主未响应，稍后重试",
      "settings.error.malformed": "宿主返回了无法识别的设置",
      "settings.error.models": "读取模型列表失败",
      "settings.error.modelInfo": "读取模型思考档失败",
      "settings.error.doctor": "诊断失败",
      "settings.error.save": "保存失败",
      "settings.error.saveHost": "保存失败：{message}",
      "tail.title": "顾问",
      "tail.severity.nit": "轻微",
      "tail.severity.concern": "关注",
      "tail.severity.blocker": "阻塞",
      "tail.declined": "顾问认为无需建议",
      "tail.empty": "（这条建议没有正文）",
      "tail.anchors": "证据锚点未对上（{checked} 条）",
      "tail.downgraded": "严重度已降级",
      "tail.aria": "顾问建议（点击展开或收起）",
    };

    /** 英文字典（键集必须与 zh 完全一致，locale/*.json 同步）。 */
    /** @type {Record<string, string>} */
    let en = {
      title: "Pair the main model with a stronger advisor model it can consult at key moments",
      "notReady.label": "Advisor is not ready · run /advisor doctor",
      "notReady.detail":
        "The host returned no candidate routes: the plugin may be disabled, or host RPC is unavailable",
      "group.current": "Current",
      "group.extras": "Toggle & configure",
      "current.detail": "In use in this session",
      "toast.current": "This is already the current advisor",
      "blocked.detail": "This route is unavailable right now",
      "off.label": "Turn the advisor off",
      "off.detail": "Reopen with /advisor at any time",
      "settings.label": "+ Add or configure a provider…",
      "settings.detail": "Open Settings → Models",
      "settings.hint": "Put /advisor doctor in the composer — press Enter to see the next step",
      "toast.settings": "Open Settings → Models to add or configure a provider",
      "search.placeholder": "Search advisor models…",
      "search.empty": "No advisor models are available yet",
      "search.noResults": "No matching models",
      "effort.auto": "auto",
      "toast.applied":
        "Advisor set to {route} (reasoning effort {effort}); effective on the next consultation",
      "toast.off": "Advisor turned off — reopen with /advisor at any time",
      "toast.stale": "This choice is stale — reopen /advisor",
      "error.failed": "Could not save the advisor; try again",
      "error.unreachable": "Cannot reach the host — try again later or run /advisor doctor",
      "error.malformed": "The host returned an unrecognized result — run /advisor doctor",
      "settings.title": "Advisor",
      "settings.desc":
        "Set the advisor mode, route, budgets and privacy. Saved changes apply to the next consultation.",
      "settings.aria": "Advisor settings",
      "settings.loading": "Reading host settings…",
      "settings.retry": "Retry",
      "settings.reload": "Reload",
      "settings.save": "Save",
      "settings.saving": "Saving…",
      "settings.saved": "Saved",
      "settings.noChanges": "No changes",
      "settings.group.basic": "Basics",
      "settings.group.budget": "Budgets",
      "settings.group.privacy": "Privacy",
      "settings.group.advanced": "Advanced & status",
      "settings.mode": "Mode",
      "settings.mode.off": "Off",
      "settings.mode.offHint": "Never consult the advisor and never spend.",
      "settings.mode.shadow": "Shadow",
      "settings.mode.shadowHint":
        "Record only, never feed back to the model: the advisor is still called and logged, but its advice never enters the model context.",
      "settings.mode.advisory": "Advisory",
      "settings.mode.advisoryHint":
        "Normal consultation: advice returns to the model context as a tool card the model may follow or ignore.",
      "settings.provider": "Provider",
      "settings.provider.empty": "(none)",
      "settings.provider.declared": "custom",
      "settings.provider.none": "The host returned no routes (llm service unavailable?)",
      "settings.provider.stale": "(current value is not in the route list)",
      "settings.model": "Model",
      "settings.model.empty": "(none)",
      "settings.model.manual": "Type a model id",
      "settings.model.manualHint":
        "Type an id if it is not listed; manual ids are not checked against the catalog.",
      "settings.model.loading": "Loading models…",
      "settings.model.pickProvider": "Pick a provider first",
      "settings.model.none": "This route lists no models — type one manually",
      "settings.model.stale": "(current value is not in the model list)",
      "settings.effort": "Reasoning effort",
      "settings.effort.auto": "Auto (model default)",
      "settings.effort.none": "This model declares no reasoning efforts",
      "settings.effort.pickModel": "Pick a model first",
      "settings.effort.count": "The model declares {count} reasoning efforts",
      "settings.effort.stale": "(current value is not declared by the model)",
      "settings.budget.maxCallsPerTurn": "Max calls per turn",
      "settings.budget.maxCallsPerSession": "Max calls per session",
      "settings.budget.maxCallsPerHour": "Max calls per hour",
      "settings.budget.maxCostPerDayUsd": "Daily budget (USD)",
      "settings.budget.priceInputPerMTok": "Input price (USD / 1M tokens)",
      "settings.budget.priceOutputPerMTok": "Output price (USD / 1M tokens)",
      "settings.budget.range": "default {default} · range {min}–{max}",
      "settings.budget.rangeUnlimited": "default {default} · range {min}–{max} (0 = unlimited)",
      "settings.budget.priceHint": "0 = do not price tokens",
      "settings.scope": "Send scope",
      "settings.scope.off": "off",
      "settings.scope.offHint": "Send no conversation content.",
      "settings.scope.summary": "summary",
      "settings.scope.summaryHint":
        "Send only the host-injected 300-character context (no file bodies).",
      "settings.scope.full": "full",
      "settings.scope.fullHint": "Send the full context, truncated to maxInputChars.",
      "settings.privacy.redact": "Heuristic redaction",
      "settings.privacy.redactHint":
        "Best-effort pattern replacement, not a secret scanner; leaks are still possible.",
      "settings.privacy.dedupe": "Shadow-path dedupe",
      "settings.privacy.dedupeHint":
        "Affects the shadow path only: identical advice is not recorded twice.",
      "settings.advanced.maxTokens": "Output cap maxTokens",
      "settings.advanced.temperature": "temperature",
      "settings.advanced.temperatureHint": "Empty = not sent, decided by the adapter · range 0–2",
      "settings.advanced.temperatureEmpty": "not sent",
      "settings.advanced.maxInputChars": "Input cap maxInputChars (chars)",
      "settings.advanced.sessionCap": "Session delivery cap sessionCap",
      "settings.status.title": "Status",
      "settings.status.calls": "{count} calls so far",
      "settings.status.tokens": "in {input} / out {output} tokens",
      "settings.status.cost": "Estimated cost",
      "settings.status.costUnset": "no prices configured",
      "settings.status.last": "Last result",
      "settings.status.skip": "Last skip reason",
      "settings.status.ledger": "Ledger",
      "settings.status.none": "none",
      "settings.status.sep": ": ",
      "settings.doctor": "Diagnostics",
      "settings.doctor.run": "Run diagnostics",
      "settings.doctor.running": "Running…",
      "settings.doctor.empty": "No checks returned",
      "settings.error.unreachable": "The host did not respond — try again later",
      "settings.error.malformed": "The host returned unrecognized settings",
      "settings.error.models": "Could not load the model list",
      "settings.error.modelInfo": "Could not load the model's reasoning efforts",
      "settings.error.doctor": "Diagnostics failed",
      "settings.error.save": "Could not save",
      "settings.error.saveHost": "Could not save: {message}",
      "tail.title": "Advisor",
      "tail.severity.nit": "nit",
      "tail.severity.concern": "concern",
      "tail.severity.blocker": "blocker",
      "tail.declined": "The advisor found nothing worth flagging",
      "tail.empty": "(this advice has no body)",
      "tail.anchors": "Evidence anchors did not match ({checked} checked)",
      "tail.downgraded": "Severity downgraded",
      "tail.aria": "Advisor advice (click to expand or collapse)",
    };

    /** 提示条样式：只用宿主 CSS 变量，深浅色自动跟随；同时充当「client 半已加载」的标记。 */
    let CSS = [
      ".dsh-advisor-toast{position:fixed;right:24px;bottom:24px;z-index:2147000000;display:flex;align-items:flex-start;gap:10px;max-width:min(440px,86vw);padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));box-shadow:0 10px 30px rgba(0,0,0,.28);font-size:13px;line-height:1.5;cursor:pointer;transition:opacity .18s ease,transform .18s ease;}",
      ".dsh-advisor-toast-mark{font-weight:600;line-height:1.4;}",
      ".dsh-advisor-toast-text{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;}",
      ".dsh-advisor-settings{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-head{display:flex;flex-direction:column;gap:2px;}",
      ".dsh-advisor-title{font-size:14px;font-weight:600;}",
      ".dsh-advisor-desc{font-size:12px;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-group{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:10px;}",
      ".dsh-advisor-group-title{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;}",
      ".dsh-advisor-row--stack{flex-direction:column;align-items:flex-start;gap:4px;}",
      ".dsh-advisor-label{flex:0 0 auto;min-width:120px;color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-controls{display:flex;flex:1 1 220px;flex-wrap:wrap;gap:6px;min-width:0;}",
      ".dsh-advisor-input,.dsh-advisor-select{flex:1 1 140px;min-width:0;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:inherit;font:inherit;}",
      ".dsh-advisor-input[type=number]{flex:0 0 120px;}",
      ".dsh-advisor-input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;}",
      ".dsh-advisor-hint{flex:1 1 100%;font-size:11.5px;color:var(--dsw-alias-label-secondary,GrayText);word-break:break-word;}",
      ".dsh-advisor-choices{display:flex;flex:1 1 100%;flex-direction:column;gap:6px;}",
      ".dsh-advisor-choice{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;cursor:pointer;}",
      ".dsh-advisor-choice-label{font-weight:500;}",
      ".dsh-advisor-choice-hint{flex:1 1 100%;font-size:11.5px;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-note{font-size:12px;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-error{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-state-error-primary,#d9534f);border-radius:8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d9534f);}",
      ".dsh-advisor-error-text{flex:1 1 180px;word-break:break-word;}",
      ".dsh-advisor-saved{font-size:12px;color:var(--dsw-alias-state-success-primary,#2f9e63);}",
      ".dsh-advisor-actions{display:flex;flex-wrap:wrap;gap:8px;}",
      ".dsh-advisor-btn{padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:inherit;font:inherit;cursor:pointer;}",
      ".dsh-advisor-btn:disabled{opacity:.6;cursor:default;}",
      ".dsh-advisor-btn--primary{border-color:var(--dsw-alias-label-primary,CanvasText);font-weight:600;}",
      ".dsh-advisor-divider{height:1px;margin:2px 0;background:var(--dsw-alias-border-l2,rgba(128,128,128,.28));}",
      ".dsh-advisor-subtitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-summary{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary,GrayText);word-break:break-word;}",
      ".dsh-advisor-checklist{display:flex;flex-direction:column;gap:3px;font-size:12px;white-space:pre-wrap;word-break:break-word;}",
      ".dsh-advisor-check[data-status=fail]{color:var(--dsw-alias-state-error-primary,#d9534f);}",
      ".dsh-advisor-readout{font-size:12px;color:var(--dsw-alias-label-secondary,GrayText);word-break:break-word;}",
      ".dsh-advisor-preview{display:flex;flex-direction:column;gap:6px;}",
      ".dsh-advisor-pre{margin:0;padding:8px 10px;max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}",
      ".dsh-advisor-turn{display:flex;flex-direction:column;gap:4px;margin-top:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-turn-head{display:inline-flex;align-items:baseline;gap:6px;max-width:100%;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
      ".dsh-advisor-turn-head:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));}",
      ".dsh-advisor-turn-sev{flex:0 0 auto;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-turn-sum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".dsh-advisor-turn-body{display:flex;flex-direction:column;gap:3px;padding:4px 8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));}",
      ".dsh-advisor-turn-advice{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-turn-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,GrayText);word-break:break-word;}",
      ".dsh-advisor-turn-warn{font-size:11.5px;color:var(--dsw-alias-state-warning-primary,#b7791f);word-break:break-word;}",
    ].join("\n");

    // ------------------------------------------------------------------
    // 纯函数（可被 node:vm 单测直接调用；挂在 __test 上）
    // ------------------------------------------------------------------

    /**
     * @param {any} value
     * @returns {string}
     */
    function asString(value) {
      return typeof value === "string" ? value : "";
    }

    /**
     * 从候选 id 里解析路由：`provider/model[#effort]`。
     * provider 按第一段 `/` 切分，model 允许再包含 `/`；`#effort` 是可选后缀。
     * @param {any} id
     * @returns {{ provider: string, model: string, reasoningEffort: string } | null}
     */
    function parseRouteId(id) {
      let text = asString(id).trim();
      if (text === "") return null;
      let body = text;
      let effort = "";
      let hash = body.lastIndexOf("#");
      if (hash > 0) {
        effort = body.slice(hash + 1).trim();
        body = body.slice(0, hash);
      }
      let slash = body.indexOf("/");
      if (slash <= 0 || slash === body.length - 1) return null;
      let provider = body.slice(0, slash).trim();
      let model = body.slice(slash + 1).trim();
      if (provider === "" || model === "") return null;
      return { provider: provider, model: model, reasoningEffort: effort };
    }

    /**
     * 候选行的路由：宿主直接给 provider/model/reasoningEffort 时优先用它，否则解析 id。
     * @param {any} item
     * @returns {{ provider: string, model: string, reasoningEffort: string } | null}
     */
    function routeOfItem(item) {
      if (!item || typeof item !== "object") return null;
      let provider = asString(item.provider).trim();
      let model = asString(item.model).trim();
      if (provider !== "" && model !== "") {
        let rawEffort = item.reasoningEffort !== undefined ? item.reasoningEffort : item.effort;
        return { provider: provider, model: model, reasoningEffort: asString(rawEffort).trim() };
      }
      return parseRouteId(item.id);
    }

    /**
     * @param {any} item
     * @returns {{ id: string, label: string, detail: string, reason: string, disabled: boolean, route: any } | null}
     */
    function normalizeItem(item) {
      if (!item || typeof item !== "object") return null;
      let id = asString(item.id).trim();
      if (id === "") return null;
      let label = asString(item.label).trim();
      return {
        id: id,
        label: label === "" ? id : label,
        detail: asString(item.detail).trim(),
        reason: asString(item.reason).trim(),
        disabled: item.disabled === true,
        route: routeOfItem(item),
      };
    }

    /**
     * @param {any} extra
     * @returns {{ id: "off" | "settings", label: string, detail: string } | null}
     */
    function normalizeExtra(extra) {
      if (!extra || typeof extra !== "object") return null;
      let id = asString(extra.id).trim();
      if (id !== "off" && id !== "settings") return null;
      return { id: id, label: asString(extra.label).trim(), detail: asString(extra.detail).trim() };
    }

    /**
     * @param {any} current
     * @returns {{ id: string, label: string, detail: string, route: any } | null}
     */
    function normalizeCurrent(current) {
      if (!current || typeof current !== "object") return null;
      let id = asString(current.id).trim();
      let label = asString(current.label).trim();
      if (id === "" && label === "") return null;
      return {
        id: id === "" ? label : id,
        label: label === "" ? id : label,
        detail: asString(current.detail).trim(),
        route: routeOfItem(current),
      };
    }

    /**
     * 把宿主 `advisor/candidates` 的返回整理成结构化数据；畸形返回一律 null（调用方降级）。
     * @param {any} raw
     * @returns {{ groups: { label: string, items: any[] }[], extras: any[], current: any } | null}
     */
    function normalizeCandidates(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok === false && raw.groups === undefined && raw.extras === undefined) return null;
      let groups = [];
      let sourceGroups = Array.isArray(raw.groups) ? raw.groups : [];
      for (let index = 0; index < sourceGroups.length; index += 1) {
        let group = sourceGroups[index];
        if (!group || typeof group !== "object") continue;
        let items = [];
        let sourceItems = Array.isArray(group.items) ? group.items : [];
        for (let j = 0; j < sourceItems.length; j += 1) {
          let normalized = normalizeItem(sourceItems[j]);
          if (normalized !== null) items.push(normalized);
        }
        groups.push({ label: asString(group.label).trim(), items: items });
      }
      let extras = [];
      let sourceExtras = Array.isArray(raw.extras) ? raw.extras : [];
      for (let k = 0; k < sourceExtras.length; k += 1) {
        let extra = normalizeExtra(sourceExtras[k]);
        if (extra !== null) extras.push(extra);
      }
      return { groups: groups, extras: extras, current: normalizeCurrent(raw.current) };
    }

    /**
     * 解 Typert 的 `{ ok, value }` 信封；没有 value 字段时按原样返回（可能是宿主直接给的结果）。
     * @param {any} result
     * @returns {any}
     */
    function unwrapEnvelope(result) {
      if (result === null || typeof result !== "object") return result;
      if (Object.hasOwn(result, "value")) return result.value;
      return result;
    }

    /**
     * 网关失败是 `{ ok:false, error:{ code, message } }`（普通 resolve，不是 reject），
     * 与业务失败（`{ ok:false, code, message }`）要分开处理。
     * @param {any} value
     * @returns {boolean}
     */
    function isRpcFailure(value) {
      return Boolean(
        value &&
          typeof value === "object" &&
          value.ok === false &&
          value.error &&
          typeof value.error === "object",
      );
    }

    /**
     * 把 `advisor/setModel` 的返回翻成人话；永远返回结构化结论。
     * @param {any} result
     * @param {(key: string) => string} translate
     * @returns {{ ok: boolean, message: string, route: any }}
     */
    function interpretSetModel(result, translate) {
      if (result === undefined || result === null) {
        return { ok: false, message: translate("error.unreachable"), route: null };
      }
      if (typeof result !== "object") {
        return { ok: false, message: translate("error.malformed"), route: null };
      }
      if (result.ok === true) {
        return {
          ok: true,
          message: "",
          route: result.route && typeof result.route === "object" ? result.route : null,
        };
      }
      let code = asString(result.code).trim();
      if (code === "" && result.error && typeof result.error === "object") {
        code = asString(result.error.code).trim();
      }
      // 网关层的参数/签名问题对用户是噪音：只留「哪里去看诊断」。
      if (code.startsWith("gateway/") || code === "remote-access/denied") {
        return { ok: false, message: translate("error.malformed"), route: null };
      }
      let message = asString(result.message).trim();
      if (message === "" && result.error && typeof result.error === "object") {
        message = asString(result.error.message).trim();
      }
      if (message === "") message = translate("error.failed");
      return { ok: false, message: message, route: null };
    }

    // ------------------------------------------------------------------
    // 设置页卡片：字段、默认值与夹紧区间
    // 默认值与 lib/settings.js 的 DEFAULT_SETTINGS 一致；前端只用于显示和二次夹紧，
    // 真正的校验仍在宿主（不复制宿主写入逻辑）。
    // ------------------------------------------------------------------

    /** @type {Record<string, number>} */
    let SETTINGS_DEFAULTS = {
      maxTokens: 4096,
      maxCallsPerTurn: 1,
      maxCallsPerSession: 32,
      maxCallsPerHour: 12,
      maxCostPerDayUsd: 0,
      priceInputPerMTok: 0,
      priceOutputPerMTok: 0,
      workspaceMaxCallsPerDay: 200,
      workspaceMaxCostPerDayUsd: 0,
      sessionCap: 24,
      maxInputChars: 60000,
    };

    /** 与 settings.js 的 LIMITS 逐项一致；越界在前端先夹一次。 @type {Record<string, number[]>} */
    let SETTINGS_LIMITS = {
      maxTokens: [256, 32000],
      maxCallsPerTurn: [0, 8],
      maxCallsPerSession: [0, 1000],
      maxCallsPerHour: [0, 500],
      maxCostPerDayUsd: [0, 10000],
      priceInputPerMTok: [0, 1000],
      priceOutputPerMTok: [0, 1000],
      workspaceMaxCallsPerDay: [0, 100000],
      workspaceMaxCostPerDayUsd: [0, 10000],
      sessionCap: [0, 200],
      maxInputChars: [4000, 400000],
    };

    /** 所有整数输入字段（temperature 单独处理：可为空、可小数）。 */
    let SETTINGS_INT_FIELDS = Object.keys(SETTINGS_LIMITS);

    /** 0 表示「不限」的预算字段；只影响提示文案。 */
    let SETTINGS_UNLIMITED_FIELDS = [
      "maxCallsPerTurn",
      "maxCallsPerSession",
      "maxCallsPerHour",
      "maxCostPerDayUsd",
      "workspaceMaxCallsPerDay",
      "workspaceMaxCostPerDayUsd",
    ];

    /** 模式与发送范围的白名单，与 settings.js 一致。 */
    let SETTINGS_MODES = ["off", "shadow", "advisory"];
    let SETTINGS_SCOPES = ["off", "summary", "full"];

    /** 回合结束后的自动徵询方式，与 settings.js 一致。 */
    let SETTINGS_POST_ANSWER = ["off", "card"];

    /** 卡片读写的字段：保存时只 diff 这些键，绝不把整个设置对象发回去。 */
    let SETTINGS_EDITABLE_FIELDS = [
      "mode",
      "provider",
      "model",
      "reasoningEffort",
      "maxTokens",
      "temperature",
      "maxCallsPerTurn",
      "maxCallsPerSession",
      "maxCallsPerHour",
      "maxCostPerDayUsd",
      "priceInputPerMTok",
      "priceOutputPerMTok",
      "workspaceMaxCallsPerDay",
      "workspaceMaxCostPerDayUsd",
      "privacyScope",
      "redact",
      "dedupe",
      "sessionCap",
      "maxInputChars",
      "postAnswer",
      "advisorTools",
      "allowedModels",
    ];

    /**
     * 整数夹紧：与 settings.js 的 clampNumber 同语义（取整、非有限值回落）。
     * @param {any} value
     * @param {number} fallback
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    function clampInt(value, fallback, min, max) {
      let n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    }

    /**
     * 可空小数夹紧（temperature）：空 / 非数字 → null。
     * @param {any} value
     * @param {number|null} fallback
     * @param {number} min
     * @param {number} max
     * @returns {number|null}
     */
    function clampFloat(value, fallback, min, max) {
      if (value === null || value === undefined || value === "") return fallback;
      let n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    /**
     * 规整字符串数组（allowedModels / confirmedHosts）：去空、去重、截断条数。
     * 与 settings.js 的 normalizeStringList 同语义，前端只用它来显示。
     * @param {any} raw
     * @returns {string[]}
     */
    function normalizeStringList(raw) {
      if (!Array.isArray(raw)) return [];
      /** @type {string[]} */
      let out = [];
      for (let index = 0; index < raw.length; index += 1) {
        let value = asString(raw[index]).trim();
        if (value === "" || out.indexOf(value) >= 0) continue;
        out.push(value);
        if (out.length >= 50) break;
      }
      return out;
    }

    /**
     * 只保留卡片关心的字段，并把畸形值夹回默认区间。
     * @param {any} raw
     * @returns {any}
     */
    function normalizeSettingsView(raw) {
      let input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      /** @type {any} */
      let out = {
        mode: SETTINGS_MODES.indexOf(input.mode) >= 0 ? input.mode : "off",
        provider: asString(input.provider).trim(),
        model: asString(input.model).trim(),
        reasoningEffort: asString(input.reasoningEffort).trim(),
        privacyScope:
          SETTINGS_SCOPES.indexOf(input.privacyScope) >= 0 ? input.privacyScope : "summary",
        redact: input.redact !== false,
        dedupe: input.dedupe !== false,
        temperature: null,
        postAnswer: input.postAnswer === "card" ? "card" : "off",
        advisorTools: input.advisorTools === true,
        allowedModels: normalizeStringList(input.allowedModels),
        confirmedHosts: normalizeStringList(input.confirmedHosts),
      };
      for (let index = 0; index < SETTINGS_INT_FIELDS.length; index += 1) {
        let key = SETTINGS_INT_FIELDS[index];
        out[key] = clampInt(
          input[key],
          SETTINGS_DEFAULTS[key],
          SETTINGS_LIMITS[key][0],
          SETTINGS_LIMITS[key][1],
        );
      }
      out.temperature =
        input.temperature === null || input.temperature === undefined || input.temperature === ""
          ? null
          : clampFloat(input.temperature, null, 0, 2);
      return out;
    }

    /**
     * 非负计数（totals / counters），畸形一律当 0。
     * @param {any} value
     * @returns {number}
     */
    function countOf(value) {
      let n = Number(value);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.round(n);
    }

    /**
     * 非负金额，畸形当 0。
     * @param {any} value
     * @returns {number}
     */
    function moneyOf(value) {
      let n = Number(value);
      if (!Number.isFinite(n) || n < 0) return 0;
      return n;
    }

    /**
     * 校验 `advisor/options`：settings 必须可用，其余字段缺失时降级为空。
     * 畸形一律 null（调用方显示内联错误 + 重试）。
     * @param {any} raw
     * @returns {any}
     */
    function normalizeOptions(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok === false && (raw.settings === undefined || raw.settings === null)) return null;
      let settingsRaw = raw.settings;
      if (settingsRaw === null || typeof settingsRaw !== "object" || Array.isArray(settingsRaw)) {
        return null;
      }
      /** @type {any[]} */
      let routes = [];
      /** @type {Set<string>} */
      let seenRoutes = new Set();
      let sourceRoutes = Array.isArray(raw.routes) ? raw.routes : [];
      for (let index = 0; index < sourceRoutes.length; index += 1) {
        let route = sourceRoutes[index];
        if (!route || typeof route !== "object") continue;
        let provider = asString(route.provider).trim();
        if (provider === "" || seenRoutes.has(provider)) continue;
        seenRoutes.add(provider);
        let displayName = asString(route.displayName).trim();
        routes.push({
          provider: provider,
          displayName: displayName === "" ? provider : displayName,
          source: route.source === "declared" ? "declared" : "catalog",
        });
      }
      let totalsRaw = raw.totals !== null && typeof raw.totals === "object" ? raw.totals : {};
      let countersRaw =
        raw.counters !== null && typeof raw.counters === "object" ? raw.counters : {};
      let poolRaw = raw.pool !== null && typeof raw.pool === "object" ? raw.pool : {};
      let priceRaw = raw.price !== null && typeof raw.price === "object" ? raw.price : {};
      let lastRaw = raw.last;
      return {
        settings: normalizeSettingsView(settingsRaw),
        routes: routes,
        totals: {
          calls: countOf(totalsRaw.calls),
          inputTokens: countOf(totalsRaw.inputTokens),
          outputTokens: countOf(totalsRaw.outputTokens),
          costUsd: moneyOf(totalsRaw.costUsd),
        },
        pool: {
          calls: countOf(poolRaw.calls),
          costUsd: moneyOf(poolRaw.costUsd),
        },
        price: {
          source:
            priceRaw.source === "builtin" || priceRaw.source === "settings"
              ? priceRaw.source
              : "none",
          input: moneyOf(priceRaw.input),
          output: moneyOf(priceRaw.output),
        },
        counters: {
          calls: countOf(countersRaw.calls),
          failures: countOf(countersRaw.failures),
          skipped: countOf(countersRaw.skipped),
          shadow: countOf(countersRaw.shadow),
        },
        last:
          lastRaw !== null && typeof lastRaw === "object"
            ? {
                status: asString(lastRaw.status),
                code: asString(lastRaw.code),
                reason: asString(lastRaw.reason),
              }
            : null,
        lastSkip: asString(raw.lastSkip).trim(),
        ledgerPath: asString(raw.ledgerPath).trim(),
      };
    }

    /**
     * 校验 `advisor/models`：返回 `[{ id, name }]`，畸形 null。
     * @param {any} raw
     * @returns {any[] | null}
     */
    function normalizeModels(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok === false && !Array.isArray(raw.models)) return null;
      if (!Array.isArray(raw.models)) return null;
      /** @type {any[]} */
      let out = [];
      /** @type {Set<string>} */
      let seen = new Set();
      for (let index = 0; index < raw.models.length; index += 1) {
        let item = raw.models[index];
        if (!item || typeof item !== "object") continue;
        let id = asString(item.id).trim();
        if (id === "" || seen.has(id)) continue;
        seen.add(id);
        let name = asString(item.name).trim();
        out.push({ id: id, name: name === "" ? id : name });
      }
      return out;
    }

    /**
     * 校验 `advisor/modelInfo`：efforts 缺失时返回空列表（卡片显示「未声明思考档」），畸形 null。
     * @param {any} raw
     * @returns {{ efforts: string[], defaultEffort: string } | null}
     */
    function normalizeModelInfo(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      let info = raw.info !== null && typeof raw.info === "object" ? raw.info : null;
      /** @type {string[]} */
      let efforts = [];
      let sourceEfforts = info !== null && Array.isArray(info.efforts) ? info.efforts : [];
      for (let index = 0; index < sourceEfforts.length; index += 1) {
        let effort = sourceEfforts[index];
        let id = asString(
          effort !== null && typeof effort === "object" ? effort.id : effort,
        ).trim();
        if (id !== "" && efforts.indexOf(id) < 0) efforts.push(id);
      }
      return {
        efforts: efforts,
        defaultEffort: info !== null ? asString(info.defaultEffort).trim() : "",
      };
    }

    /**
     * 校验 `advisor/doctor`：只保留 status + message，畸形 null。
     * @param {any} raw
     * @returns {Array<{ status: string, message: string }> | null}
     */
    function normalizeDoctor(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (!Array.isArray(raw.checks)) return null;
      /** @type {Array<{ status: string, message: string }>} */
      let out = [];
      for (let index = 0; index < raw.checks.length; index += 1) {
        let check = raw.checks[index];
        if (!check || typeof check !== "object") continue;
        let message = asString(check.message).trim();
        if (message === "") continue;
        let status =
          check.status === "pass" || check.status === "warn" || check.status === "fail"
            ? check.status
            : "warn";
        out.push({ status: status, message: message });
      }
      return out;
    }

    /**
     * 校验 `advisor/preview`：只接受带 text 的成功结果，畸形 / `ok:false` 一律 null。
     * @param {any} raw
     * @returns {string | null}
     */
    function normalizePreview(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok === false) return null;
      if (typeof raw.text !== "string") return null;
      return raw.text;
    }

    /**
     * 保存时只发改过的字段（temperature 的 null 与数字分开比较）。
     * @param {any} base
     * @param {any} draft
     * @returns {Record<string, any>}
     */
    function diffSettings(base, draft) {
      /** @type {Record<string, any>} */
      let patch = {};
      if (!base || !draft) return patch;
      for (let index = 0; index < SETTINGS_EDITABLE_FIELDS.length; index += 1) {
        let key = SETTINGS_EDITABLE_FIELDS[index];
        let before = base[key];
        let after = draft[key];
        if (key === "temperature") {
          let same =
            before === null || before === undefined
              ? after === null || after === undefined
              : after !== null && after !== undefined && Number(before) === Number(after);
          if (!same) patch[key] = after === undefined ? null : after;
          continue;
        }
        // 数组字段每次解析都是新实例：按内容比较，避免「没改也发一次」。
        if (key === "allowedModels") {
          let beforeList = normalizeStringList(before);
          let afterList = normalizeStringList(after);
          if (beforeList.join("\u0000") !== afterList.join("\u0000")) patch[key] = afterList;
          continue;
        }
        if (!Object.is(before, after)) patch[key] = after;
      }
      return patch;
    }

    /**
     * 解释 `advisor/updateSettings` 的返回；失败保留宿主 message 给调用方展示。
     * @param {any} raw
     * @returns {{ ok: boolean, settings: any, message: string }}
     */
    function interpretUpdate(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, settings: null, message: "" };
      }
      if (raw.ok === false) {
        let message = asString(raw.message).trim();
        if (message === "" && raw.error !== null && typeof raw.error === "object") {
          message = asString(raw.error.message).trim();
        }
        return { ok: false, settings: null, message: message };
      }
      let settings =
        raw.settings !== null && typeof raw.settings === "object" ? raw.settings : null;
      if (raw.ok === true || settings !== null) {
        return { ok: true, settings: settings, message: "" };
      }
      return { ok: false, settings: null, message: "" };
    }

    // ------------------------------------------------------------------
    // 顾问线（conversation.chat.turnTail）：纯函数
    // ------------------------------------------------------------------

    /** 严重度白名单：宿主给不认识的值时按 nit 处理。 */
    let ADVICE_SEVERITIES = ["nit", "concern", "blocker"];

    /**
     * 回合号：容忍数字字符串，非有限值一律 -1（调用方不渲染）。
     * @param {any} value
     * @returns {number}
     */
    function turnNumberOf(value) {
      let n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return -1;
      return Math.round(n);
    }

    /**
     * 槽的 owner props 是 `{ turn, seq, openFile }`，其中 turn 就是回合号。
     * @param {any} turn
     * @returns {number}
     */
    function slotTurnNumber(turn) {
      if (!turn || typeof turn !== "object") return -1;
      return turnNumberOf(turn.turn);
    }

    /**
     * 槽的渲染门槛：宿主只在 `turn/end` 之后渲染 turn-tail，但 `closing === null`（Stop / 报错 /
     * 无最终文本）时仍然会渲染，插件必须自己放弃（见 runtime §9.14）。
     * @param {any} turn
     * @returns {boolean}
     */
    function isAdviceTurnReady(turn) {
      if (!turn || typeof turn !== "object") return false;
      if (turn.end === undefined || turn.end === null) return false;
      let data = turn.data;
      if (!data || typeof data.get !== "function") return true;
      let tail;
      try {
        tail = data.get("turn-tail");
      } catch (_error) {
        return true;
      }
      if (!tail || typeof tail !== "object") return true;
      return tail.closing !== null && tail.closing !== undefined;
    }

    /**
     * 截断到 max 个字符（按码点切，不劈开代理对）；中间空白折叠成单空格。
     * @param {any} value
     * @param {number} max
     * @returns {string}
     */
    function truncateText(value, max) {
      let text = asString(value).replace(/\s+/gu, " ").trim();
      let chars = Array.from(text);
      if (chars.length <= max) return text;
      return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
    }

    /**
     * 校验 `advisor/advice` 的返回：`{ ok: true, items: [...] }` → 规整后的一行一条。
     * 畸形 / ok:false 返回 null（组件安静不渲染，不弹错）。
     * @param {any} raw
     * @returns {any[] | null}
     */
    function normalizeAdviceItems(raw) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok === false) return null;
      if (!Array.isArray(raw.items)) return null;
      /** @type {any[]} */
      let out = [];
      for (let index = 0; index < raw.items.length; index += 1) {
        let item = raw.items[index];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        let turn = turnNumberOf(item.turn);
        if (turn < 0) continue;
        let severity = ADVICE_SEVERITIES.indexOf(item.severity) >= 0 ? item.severity : "nit";
        let anchorsRaw =
          item.anchors !== null && typeof item.anchors === "object" && !Array.isArray(item.anchors)
            ? item.anchors
            : null;
        out.push({
          turn: turn,
          adviceId: asString(item.adviceId).trim(),
          severity: severity,
          status: item.status === "declined" ? "declined" : "reviewed",
          advice: asString(item.advice),
          summary: asString(item.summary),
          model: asString(item.model).trim(),
          usage: asString(item.usage).trim(),
          anchors:
            anchorsRaw === null
              ? null
              : {
                  checked: countOf(anchorsRaw.checked),
                  verified: countOf(anchorsRaw.verified),
                  unverified: countOf(anchorsRaw.unverified),
                  downgraded: anchorsRaw.downgraded === true,
                },
        });
      }
      // 一个回合最多一条（宿主保证）；真出现重复时保留最后一条，避免同一行抖动。
      /** @type {Map<number, any>} */
      let byTurn = new Map();
      for (let index = 0; index < out.length; index += 1) {
        byTurn.set(out[index].turn, out[index]);
      }
      return Array.from(byTurn.values());
    }

    /**
     * 千分位计数（不依赖运行环境 locale）。
     * @param {any} value
     * @returns {string}
     */
    function formatCount(value) {
      let n = Number(value);
      if (!Number.isFinite(n)) return "0";
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 极简 store：组件用 useSyncExternalStore 订阅，写入方直接 set。
     * @param {any} initial
     * @returns {any}
     */
    function createStore(initial) {
      let value = initial;
      let listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (/** @type {any} */ listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (/** @type {any} */ next) => {
          value = typeof next === "function" ? next(value) : next;
          listeners.forEach((/** @type {any} */ listener) => {
            listener();
          });
        },
      };
    }

    // ------------------------------------------------------------------
    // toast 组件（属于 shell.overlay；没有提示时返回 null）
    // ------------------------------------------------------------------

    /** @param {any} props */
    function AdvisorToast(props) {
      let toast = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
      let entryId = toast ? toast.id : null;
      let shownState = React.useState(false);
      let shown = shownState[0];
      let setShown = shownState[1];

      React.useEffect(() => {
        if (entryId === null) {
          setShown(false);
          return undefined;
        }
        let raise = setTimeout(() => {
          setShown(true);
        }, 10);
        let timer = setTimeout(() => {
          props.store.set(null);
        }, TOAST_MS);
        return () => {
          clearTimeout(raise);
          clearTimeout(timer);
        };
      }, [entryId, props.store]);

      if (!toast) return null;
      let tone = toast.tone === "error" ? "error" : toast.tone === "ok" ? "ok" : "info";
      let color =
        tone === "error"
          ? "var(--dsw-alias-state-error-primary,#d9534f)"
          : tone === "ok"
            ? "var(--dsw-alias-state-success-primary,#2f9e63)"
            : "var(--dsw-alias-label-secondary,GrayText)";
      return h(
        "div",
        {
          className: "dsh-advisor-toast",
          role: "status",
          "data-tone": tone,
          title: asString(toast.message),
          onClick: () => {
            props.store.set(null);
          },
          style: {
            borderLeft: `3px solid ${color}`,
            opacity: shown ? 1 : 0,
            transform: shown ? "translateY(0)" : "translateY(8px)",
          },
        },
        h(
          "span",
          { className: "dsh-advisor-toast-mark", style: { color: color } },
          tone === "error" ? "!" : tone === "ok" ? "✓" : "i",
        ),
        h("span", { className: "dsh-advisor-toast-text" }, asString(toast.message)),
      );
    }

    // ------------------------------------------------------------------
    // 顾问线（conversation.chat.turnTail）
    // ------------------------------------------------------------------

    /**
     * 回合尾部的「顾问线」：一行紧凑摘要，点击展开完整建议。
     *
     * 渲染条件（缺一不可）：槽已就绪（turn/end 之后、closing 非 null）、该回合号有效、
     * 顾问记录已拉到且确实存在 turn 相同的一条。否则一律 return null——绝不渲染空壳。
     *
     * @param {any} props slot props：owner `{ turn, seq, openFile }` + 注入的 sessionId / t / api
     * @returns {any}
     */
    function AdvisorTurnLine(props) {
      let t =
        typeof props.t === "function"
          ? props.t
          : function passthroughKey(/** @type {string} */ key) {
              return key;
            };
      let api = props.api;
      let turn = props.turn;
      let turnNumber = slotTurnNumber(turn);
      let sessionId = "";
      if (typeof props.sessionId === "string") sessionId = props.sessionId;
      else if (
        props.session !== null &&
        props.session !== undefined &&
        typeof props.session.sessionId === "string"
      ) {
        sessionId = props.session.sessionId;
      }

      let recordsState = React.useState(/** @type {any[] | null} */ (null));
      let records = recordsState[0];
      let setRecords = recordsState[1];
      let expandedState = React.useState(false);
      let expanded = expandedState[0];
      let setExpanded = expandedState[1];

      // 一次拉全量并按 sessionId 缓存；props.turn 变化不重拉。失败静默（不 toast、不弹错）。
      React.useEffect(
        function loadAdviceOnce() {
          if (sessionId === "") return undefined;
          if (!api || typeof api.advice !== "function") return undefined;
          let alive = true;
          let pending;
          try {
            pending = Promise.resolve(api.advice(sessionId));
          } catch (_error) {
            return undefined;
          }
          pending.then(
            function onItems(value) {
              if (!alive) return;
              setRecords(Array.isArray(value) ? value : []);
            },
            function onFailure() {
              if (alive) setRecords([]);
            },
          );
          return function cleanup() {
            alive = false;
          };
        },
        [api, sessionId],
      );

      if (!isAdviceTurnReady(turn)) return null;
      if (turnNumber < 0 || records === null) return null;
      /** @type {any} */
      let record = null;
      for (let index = 0; index < records.length; index += 1) {
        let candidate = records[index];
        if (candidate && typeof candidate === "object" && candidate.turn === turnNumber) {
          record = candidate;
          break;
        }
      }
      if (record === null) return null;

      let declined = record.status === "declined";
      let severity = ADVICE_SEVERITIES.indexOf(record.severity) >= 0 ? record.severity : "nit";
      let summaryText = truncateText(
        asString(record.summary) !== "" ? record.summary : record.advice,
        60,
      );
      let severityLabel = t(`tail.severity.${severity}`);

      /** @type {any[]} */
      let headChildren = [];
      if (declined) {
        headChildren.push(
          h("span", { className: "dsh-advisor-turn-sev", key: "declined" }, t("tail.declined")),
        );
      } else {
        headChildren.push(
          h(
            "span",
            { className: "dsh-advisor-turn-sev", key: "sev" },
            `${t("tail.title")} · ${severityLabel}`,
          ),
        );
        if (summaryText !== "") {
          headChildren.push(
            h("span", { className: "dsh-advisor-turn-sum", key: "sum" }, summaryText),
          );
        }
      }

      /** @type {any[]} */
      let bodyChildren = [
        h(
          "div",
          { className: "dsh-advisor-turn-advice", key: "advice" },
          asString(record.advice) === "" ? t("tail.empty") : record.advice,
        ),
      ];
      let metaText = [asString(record.model), asString(record.usage)]
        .filter((part) => part !== "")
        .join(" · ");
      if (metaText !== "") {
        bodyChildren.push(h("div", { className: "dsh-advisor-turn-meta", key: "meta" }, metaText));
      }
      let anchors = record.anchors;
      if (anchors && typeof anchors === "object") {
        if (countOf(anchors.checked) > 0 && countOf(anchors.verified) === 0) {
          bodyChildren.push(
            h(
              "div",
              { className: "dsh-advisor-turn-warn", key: "anchors" },
              t("tail.anchors").replace("{checked}", String(countOf(anchors.checked))),
            ),
          );
        }
        if (anchors.downgraded === true) {
          bodyChildren.push(
            h(
              "div",
              { className: "dsh-advisor-turn-warn", key: "downgraded" },
              t("tail.downgraded"),
            ),
          );
        }
      }

      return h(
        "div",
        {
          className: "dsh-advisor-turn",
          "data-advisor-turn": String(turnNumber),
          "data-advisor-status": declined ? "declined" : "reviewed",
        },
        [
          h(
            "div",
            {
              "aria-expanded": expanded ? "true" : "false",
              "aria-label": t("tail.aria"),
              className: "dsh-advisor-turn-head",
              key: "head",
              role: "button",
              tabIndex: 0,
              title: declined ? t("tail.declined") : summaryText,
              onClick: function toggleExpanded() {
                setExpanded(function flip(/** @type {boolean} */ prev) {
                  return !prev;
                });
              },
              onKeyDown: function onKeyDown(/** @type {any} */ event) {
                if (!event) return;
                if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                if (typeof event.preventDefault === "function") event.preventDefault();
                setExpanded(function flip(/** @type {boolean} */ prev) {
                  return !prev;
                });
              },
            },
            headChildren,
          ),
          expanded
            ? h("div", { className: "dsh-advisor-turn-body", key: "body" }, bodyChildren)
            : null,
        ],
      );
    }

    // ------------------------------------------------------------------
    // 设置页卡片（settings.general.item）
    // ------------------------------------------------------------------

    /**
     * 设置页 → 通用 的「顾问」卡片。`settings.general.item` 是无 owner props 的 list 槽，
     * sessionId 拿不到时传空串（宿主只跳过按会话的字段）；数据全部经 props.api 现取。
     * 任何 RPC 失败/畸形都只落成一行内联错误 + 重试，绝不抛错。
     * @param {any} props
     * @returns {any}
     */
    function AdvisorSettings(props) {
      let api = props.api;
      let t =
        typeof props.t === "function"
          ? props.t
          : function fallbackTranslate(/** @type {string} */ key) {
              return key;
            };
      let sessionId = "";
      if (typeof props.sessionId === "string") sessionId = props.sessionId;
      else if (
        props.session !== null &&
        props.session !== undefined &&
        typeof props.session.sessionId === "string"
      ) {
        sessionId = props.session.sessionId;
      }

      let loadState = React.useState("loading");
      let load = loadState[0];
      let setLoad = loadState[1];
      let snapState = React.useState(/** @type {any} */ (null));
      let snap = snapState[0];
      let setSnap = snapState[1];
      let draftState = React.useState(/** @type {any} */ (null));
      let draft = draftState[0];
      let setDraft = draftState[1];
      let textsState = React.useState(/** @type {Record<string, string>} */ ({}));
      let texts = textsState[0];
      let setTexts = textsState[1];
      let modelsState = React.useState(/** @type {any[] | null} */ (null));
      let models = modelsState[0];
      let setModels = modelsState[1];
      let infoState = React.useState({ state: "idle", efforts: [], defaultEffort: "" });
      let info = infoState[0];
      let setInfo = infoState[1];
      let doctorState = React.useState(/** @type {any[] | null} */ (null));
      let doctor = doctorState[0];
      let setDoctor = doctorState[1];
      let errorState = React.useState(/** @type {any} */ (null));
      let error = errorState[0];
      let setError = errorState[1];
      let noticeState = React.useState("");
      let notice = noticeState[0];
      let setNotice = noticeState[1];
      let busyState = React.useState("");
      let busy = busyState[0];
      let setBusy = busyState[1];
      /** 「预览会发什么」的返回正文；空串表示还没预览。 */
      let previewState = React.useState("");
      let previewText = previewState[0];
      let setPreviewText = previewState[1];
      let previewOpenState = React.useState(false);
      let previewOpen = previewOpenState[0];
      let setPreviewOpen = previewOpenState[1];
      /** provider/model 切换可能并发：只接受最后一次请求的返回。 */
      let modelsSeq = React.useRef(0);
      let infoSeq = React.useRef(0);

      /**
       * 把 api 调用折算成 Promise：同步抛错也走失败分支（失败路径统一 undefined）。
       * @param {any} fn
       * @param {...any} args
       * @returns {Promise<any>}
       */
      function invoke(fn, ...args) {
        try {
          return Promise.resolve(fn.apply(null, args));
        } catch (_error) {
          return Promise.resolve(undefined);
        }
      }

      /**
       * 只清掉与本次成功调用同源的内联错误（别的错误继续显示）。
       * @param {string} source
       */
      function clearErrorFor(source) {
        setError(function clearMatching(/** @type {any} */ prev) {
          if (prev === null || typeof prev !== "object") return prev;
          return prev.retry === source ? null : prev;
        });
      }

      /**
       * 数值字段 → 文本；temperature 的空串表示「不传」。
       * @param {any} settings
       * @returns {Record<string, string>}
       */
      function textsOf(settings) {
        /** @type {Record<string, string>} */
        let out = {};
        for (let index = 0; index < SETTINGS_INT_FIELDS.length; index += 1) {
          let key = SETTINGS_INT_FIELDS[index];
          out[key] = String(settings[key]);
        }
        out.temperature = settings.temperature === null ? "" : String(settings.temperature);
        out.allowedModels = normalizeStringList(settings.allowedModels).join(", ");
        return out;
      }

      /**
       * 「逗号分隔」的白名单文本 → 数组：trim、去重、去空（半角/全角逗号都认）。
       * @param {string} text
       * @param {string[]} fallback 文本不可用时的当前值
       * @returns {string[]}
       */
      function parseAllowedModels(text, fallback) {
        if (typeof text !== "string") return normalizeStringList(fallback);
        let parts = text.split(/[,，]/);
        /** @type {string[]} */
        let out = [];
        for (let index = 0; index < parts.length; index += 1) {
          let value = parts[index].trim();
          if (value === "" || out.indexOf(value) >= 0) continue;
          out.push(value);
          if (out.length >= 50) break;
        }
        return out;
      }

      /**
       * 拉某 provider 的模型清单；失败只显示内联错误（保留手填入口）。
       * @param {string} provider
       */
      function loadModelsFor(provider) {
        modelsSeq.current += 1;
        let seq = modelsSeq.current;
        if (provider === "" || !api || typeof api.models !== "function") {
          setModels([]);
          return;
        }
        setModels(null);
        invoke(api.models, provider).then(
          function onModels(raw) {
            if (seq !== modelsSeq.current) return;
            let list = normalizeModels(raw);
            if (list === null) {
              setModels([]);
              setError({
                text:
                  raw === undefined ? t("settings.error.unreachable") : t("settings.error.models"),
                retry: "models",
              });
              return;
            }
            setModels(list);
            clearErrorFor("models");
          },
          function onModelsFailed() {
            if (seq !== modelsSeq.current) return;
            setModels([]);
            setError({ text: t("settings.error.unreachable"), retry: "models" });
          },
        );
      }

      /**
       * 拉某模型的思考档；拿不到 efforts 时只保留「自动」。
       * @param {string} provider
       * @param {string} model
       */
      function loadInfoFor(provider, model) {
        infoSeq.current += 1;
        let seq = infoSeq.current;
        if (provider === "" || model === "" || !api || typeof api.modelInfo !== "function") {
          setInfo({ state: "idle", efforts: [], defaultEffort: "" });
          return;
        }
        setInfo({ state: "loading", efforts: [], defaultEffort: "" });
        invoke(api.modelInfo, provider, model).then(
          function onModelInfo(raw) {
            if (seq !== infoSeq.current) return;
            let value = normalizeModelInfo(raw);
            if (value === null) {
              setInfo({ state: "error", efforts: [], defaultEffort: "" });
              setError({
                text:
                  raw === undefined
                    ? t("settings.error.unreachable")
                    : t("settings.error.modelInfo"),
                retry: "modelInfo",
              });
              return;
            }
            setInfo({
              state: value.efforts.length > 0 ? "ready" : "empty",
              efforts: value.efforts,
              defaultEffort: value.defaultEffort,
            });
            clearErrorFor("modelInfo");
          },
          function onModelInfoFailed() {
            if (seq !== infoSeq.current) return;
            setInfo({ state: "error", efforts: [], defaultEffort: "" });
            setError({ text: t("settings.error.unreachable"), retry: "modelInfo" });
          },
        );
      }

      let refresh = React.useCallback(
        function refreshFromHost() {
          if (!api || typeof api.options !== "function") {
            setLoad("error");
            setError({ text: t("settings.error.unreachable"), retry: "load" });
            return;
          }
          setLoad("loading");
          setBusy("load");
          setError(null);
          setNotice("");
          invoke(api.options, sessionId).then(
            function onOptions(raw) {
              setBusy("");
              let data = normalizeOptions(raw);
              if (data === null) {
                setLoad("error");
                setError({
                  text:
                    raw === undefined
                      ? t("settings.error.unreachable")
                      : t("settings.error.malformed"),
                  retry: "load",
                });
                return;
              }
              setSnap(data);
              setDraft(data.settings);
              setTexts(textsOf(data.settings));
              setModels(null);
              setInfo({ state: "idle", efforts: [], defaultEffort: "" });
              setDoctor(null);
              setPreviewText("");
              setPreviewOpen(false);
              setLoad("ready");
              if (data.settings.provider !== "") {
                loadModelsFor(data.settings.provider);
                if (data.settings.model !== "") {
                  loadInfoFor(data.settings.provider, data.settings.model);
                }
              }
            },
            function onOptionsFailed() {
              setBusy("");
              setLoad("error");
              setError({ text: t("settings.error.unreachable"), retry: "load" });
            },
          );
        },
        [api, sessionId],
      );

      React.useEffect(
        function loadOnMount() {
          refresh();
        },
        [refresh],
      );

      /**
       * 把数字文本夹回 draft（空值保持原值；temperature 空 = null）。
       * @param {any} source
       * @returns {any}
       */
      function commitNumbers(source) {
        let next = Object.assign({}, source);
        for (let index = 0; index < SETTINGS_INT_FIELDS.length; index += 1) {
          let key = SETTINGS_INT_FIELDS[index];
          let raw = texts[key];
          if (typeof raw !== "string") continue;
          let text = raw.trim();
          if (text === "") continue;
          next[key] = clampInt(text, next[key], SETTINGS_LIMITS[key][0], SETTINGS_LIMITS[key][1]);
        }
        if (typeof texts.temperature === "string") {
          let tempText = texts.temperature.trim();
          next.temperature = tempText === "" ? null : clampFloat(tempText, null, 0, 2);
        }
        return next;
      }

      /**
       * 单个数字输入失焦时夹紧并回写规范文本。
       * @param {string} key
       */
      function commitOne(key) {
        if (!draft) return;
        let raw = texts[key];
        if (typeof raw !== "string") return;
        let text = raw.trim();
        if (key === "temperature") {
          let temperature = text === "" ? null : clampFloat(text, null, 0, 2);
          setDraft(Object.assign({}, draft, { temperature: temperature }));
          setTexts(
            Object.assign({}, texts, {
              temperature: temperature === null ? "" : String(temperature),
            }),
          );
          return;
        }
        if (text === "") {
          setTexts(Object.assign({}, texts, { [key]: String(draft[key]) }));
          return;
        }
        let limit = SETTINGS_LIMITS[key];
        let value = clampInt(text, draft[key], limit[0], limit[1]);
        setDraft(Object.assign({}, draft, { [key]: value }));
        setTexts(Object.assign({}, texts, { [key]: String(value) }));
      }

      /** 保存：只发改过的字段，成功后用返回值刷新本地状态。 */
      function save() {
        if (!draft || !snap) return;
        let committed = commitNumbers(draft);
        committed.allowedModels = parseAllowedModels(texts.allowedModels, committed.allowedModels);
        setDraft(committed);
        setTexts(textsOf(committed));
        let patch = diffSettings(snap.settings, committed);
        if (Object.keys(patch).length === 0) {
          setError(null);
          setNotice(t("settings.noChanges"));
          return;
        }
        if (!api || typeof api.updateSettings !== "function") {
          setError({ text: t("settings.error.unreachable"), retry: "save" });
          return;
        }
        setBusy("save");
        setError(null);
        setNotice("");
        invoke(api.updateSettings, patch).then(
          function onSaved(raw) {
            setBusy("");
            let outcome = interpretUpdate(raw);
            if (!outcome.ok) {
              let message;
              if (outcome.message !== "") {
                message = t("settings.error.saveHost").replace("{message}", outcome.message);
              } else {
                message =
                  raw === undefined ? t("settings.error.unreachable") : t("settings.error.save");
              }
              setError({ text: message, retry: "save" });
              return;
            }
            let settings = normalizeSettingsView(
              outcome.settings === null ? committed : outcome.settings,
            );
            setSnap(Object.assign({}, snap, { settings: settings }));
            setDraft(settings);
            setTexts(textsOf(settings));
            setNotice(t("settings.saved"));
            clearErrorFor("save");
            if (api && typeof api.notify === "function") api.notify(t("settings.saved"), "ok");
          },
          function onSaveFailed() {
            setBusy("");
            setError({ text: t("settings.error.unreachable"), retry: "save" });
          },
        );
      }

      /** 诊断：逐条渲染 ✅/⚠️/❌ + message。 */
      function runDoctor() {
        if (!api || typeof api.doctor !== "function") {
          setError({ text: t("settings.error.unreachable"), retry: "doctor" });
          return;
        }
        setBusy("doctor");
        setError(null);
        invoke(api.doctor, sessionId).then(
          function onDoctor(raw) {
            setBusy("");
            let checks = normalizeDoctor(raw);
            if (checks === null) {
              setDoctor([]);
              setError({
                text:
                  raw === undefined ? t("settings.error.unreachable") : t("settings.error.doctor"),
                retry: "doctor",
              });
              return;
            }
            setDoctor(checks);
            clearErrorFor("doctor");
          },
          function onDoctorFailed() {
            setBusy("");
            setError({ text: t("settings.error.unreachable"), retry: "doctor" });
          },
        );
      }

      /** 预览：把「这一次会发出去什么」拉回来（不发送）；失败只显示内联错误。 */
      function runPreview() {
        if (!api || typeof api.preview !== "function") {
          setError({ text: t("settings.error.unreachable"), retry: "preview" });
          return;
        }
        setBusy("preview");
        setError(null);
        invoke(api.preview, sessionId).then(
          function onPreview(raw) {
            setBusy("");
            let text = normalizePreview(raw);
            if (text === null) {
              setError({
                text:
                  raw === undefined ? t("settings.error.unreachable") : t("settings.error.preview"),
                retry: "preview",
              });
              return;
            }
            setPreviewText(text);
            setPreviewOpen(true);
            clearErrorFor("preview");
          },
          function onPreviewFailed() {
            setBusy("");
            setError({ text: t("settings.error.unreachable"), retry: "preview" });
          },
        );
      }

      /** 折叠 / 展开已拉回来的预览正文。 */
      function togglePreview() {
        setPreviewOpen(function flip(/** @type {boolean} */ prev) {
          return !prev;
        });
      }

      /**
       * 把当前 provider 加进 confirmedHosts（去重后整表写回）。
       * 成功后用返回值刷新本地 settings，既有草稿改动保留。
       */
      function confirmHost() {
        if (!draft || !snap) return;
        let provider = asString(draft.provider).trim();
        if (provider === "") return;
        let next = normalizeStringList(
          normalizeStringList(snap.settings.confirmedHosts).concat([provider]),
        );
        if (!api || typeof api.updateSettings !== "function") {
          setError({ text: t("settings.error.unreachable"), retry: "confirm" });
          return;
        }
        setBusy("confirm");
        setError(null);
        setNotice("");
        invoke(api.updateSettings, { confirmedHosts: next }).then(
          function onConfirmed(raw) {
            setBusy("");
            let outcome = interpretUpdate(raw);
            if (!outcome.ok) {
              let message;
              if (outcome.message !== "") {
                message = t("settings.error.saveHost").replace("{message}", outcome.message);
              } else {
                message =
                  raw === undefined ? t("settings.error.unreachable") : t("settings.error.confirm");
              }
              setError({ text: message, retry: "confirm" });
              return;
            }
            let settings = normalizeSettingsView(
              outcome.settings === null
                ? Object.assign({}, snap.settings, { confirmedHosts: next })
                : outcome.settings,
            );
            setSnap(Object.assign({}, snap, { settings: settings }));
            setDraft(Object.assign({}, draft, { confirmedHosts: settings.confirmedHosts }));
            let done = t("settings.confirm.done").replace("{provider}", provider);
            setNotice(done);
            clearErrorFor("confirm");
            if (api && typeof api.notify === "function") api.notify(done, "ok");
          },
          function onConfirmFailed() {
            setBusy("");
            setError({ text: t("settings.error.unreachable"), retry: "confirm" });
          },
        );
      }

      /** 白名单输入失焦：回写规范化文本（去重、逗号统一成「, 」）。 */
      function commitAllowedModels() {
        if (!draft) return;
        let list = parseAllowedModels(texts.allowedModels, draft.allowedModels);
        setDraft(Object.assign({}, draft, { allowedModels: list }));
        setTexts(function mergeAllowed(/** @type {any} */ prev) {
          return Object.assign({}, prev, { allowedModels: list.join(", ") });
        });
      }

      /** 重新拉 options（含当前设置、路由与账本摘要）。 */
      function reload() {
        setDoctor(null);
        setError(null);
        setNotice("");
        refresh();
      }

      /** 内联错误的「重试」：按错误来源重放对应 RPC。 */
      function retry() {
        let action = error !== null && typeof error.retry === "string" ? error.retry : "load";
        if (action === "models") {
          loadModelsFor(draft ? draft.provider : "");
          return;
        }
        if (action === "modelInfo" && draft) {
          loadInfoFor(draft.provider, draft.model);
          return;
        }
        if (action === "save") {
          save();
          return;
        }
        if (action === "doctor") {
          runDoctor();
          return;
        }
        if (action === "preview") {
          runPreview();
          return;
        }
        if (action === "confirm") {
          confirmHost();
          return;
        }
        refresh();
      }

      /** @param {string} provider */
      function chooseProvider(provider) {
        if (!draft || provider === draft.provider) return;
        setDraft(Object.assign({}, draft, { provider: provider, model: "", reasoningEffort: "" }));
        setModels(null);
        setInfo({ state: "idle", efforts: [], defaultEffort: "" });
        setError(null);
        loadModelsFor(provider);
      }

      /** @param {string} model */
      function chooseModel(model) {
        if (!draft) return;
        setDraft(Object.assign({}, draft, { model: model, reasoningEffort: "" }));
        setError(null);
        if (model !== "" && draft.provider !== "") loadInfoFor(draft.provider, model);
        else setInfo({ state: "idle", efforts: [], defaultEffort: "" });
      }

      /** @param {string} effort */
      function chooseEffort(effort) {
        if (!draft) return;
        setDraft(Object.assign({}, draft, { reasoningEffort: effort }));
      }

      /** @param {string} mode */
      function chooseMode(mode) {
        if (!draft) return;
        setDraft(Object.assign({}, draft, { mode: mode }));
      }

      /** @param {string} scope */
      function chooseScope(scope) {
        if (!draft) return;
        setDraft(Object.assign({}, draft, { privacyScope: scope }));
      }

      /** @param {string} value */
      function choosePostAnswer(value) {
        if (!draft) return;
        setDraft(
          Object.assign({}, draft, {
            postAnswer: SETTINGS_POST_ANSWER.indexOf(value) >= 0 ? value : "off",
          }),
        );
      }

      /**
       * @param {string} key
       * @param {boolean} on
       */
      function toggleFlag(key, on) {
        if (!draft) return;
        setDraft(Object.assign({}, draft, { [key]: on }));
      }

      /** 手填 model id：输入时只更新草稿，失焦时再拉思考档。 @param {string} value */
      function onModelText(value) {
        if (!draft) return;
        setDraft(Object.assign({}, draft, { model: value, reasoningEffort: "" }));
        setInfo({ state: "idle", efforts: [], defaultEffort: "" });
      }

      /** 内联错误 + 重试；没有错误时返回 null。 @returns {any} */
      function errorBanner() {
        if (error === null || typeof error.text !== "string" || error.text === "") return null;
        return h(
          "div",
          { className: "dsh-advisor-error", role: "alert", "data-advisor-error": "" },
          [
            h("span", { className: "dsh-advisor-error-text", key: "text" }, error.text),
            h(
              "button",
              { className: "dsh-advisor-btn", key: "retry", type: "button", onClick: retry },
              t("settings.retry"),
            ),
          ],
        );
      }

      /**
       * @param {string} titleKey
       * @param {any[]} children
       * @param {string} key
       * @returns {any}
       */
      function group(titleKey, children, key) {
        return h(
          "section",
          { className: "dsh-advisor-group", key: key, "data-advisor-group": key },
          [h("div", { className: "dsh-advisor-group-title", key: "title" }, t(titleKey))].concat(
            children,
          ),
        );
      }

      /**
       * 单选项一行：label + 说明（模式、发送范围共用）。
       * @param {string} name
       * @param {string} labelKey
       * @param {string[]} values
       * @param {string} prefix
       * @param {string} current
       * @param {(value: string) => void} onPick
       * @param {string} key
       * @returns {any}
       */
      function radioField(name, labelKey, values, prefix, current, onPick, key) {
        let choices = values.map(function renderChoice(/** @type {string} */ value) {
          return h("label", { className: "dsh-advisor-choice", key: value }, [
            h("input", {
              checked: current === value,
              key: "input",
              name: `advisor-${name}`,
              onChange: function onChoice() {
                onPick(value);
              },
              type: "radio",
              value: value,
            }),
            h("span", { className: "dsh-advisor-choice-label", key: "label" }, t(prefix + value)),
            h(
              "span",
              { className: "dsh-advisor-choice-hint", key: "hint" },
              t(`${prefix}${value}Hint`),
            ),
          ]);
        });
        return h(
          "div",
          {
            className: "dsh-advisor-row dsh-advisor-row--stack",
            key: key,
            "data-advisor-field": name,
          },
          [
            h("span", { className: "dsh-advisor-label", key: "label" }, t(labelKey)),
            h(
              "div",
              {
                "aria-label": t(labelKey),
                className: "dsh-advisor-choices",
                key: "choices",
                role: "radiogroup",
              },
              choices,
            ),
          ],
        );
      }

      /**
       * 数字输入 + 默认值/范围提示。
       * @param {string} key
       * @param {string} labelKey
       * @param {string} extraHint 已翻译的前缀说明，可为空串
       * @returns {any}
       */
      function numberField(key, labelKey, extraHint) {
        let limit = SETTINGS_LIMITS[key];
        let rangeKey =
          SETTINGS_UNLIMITED_FIELDS.indexOf(key) >= 0
            ? "settings.budget.rangeUnlimited"
            : "settings.budget.range";
        let hint = t(rangeKey)
          .replace("{default}", String(SETTINGS_DEFAULTS[key]))
          .replace("{min}", String(limit[0]))
          .replace("{max}", String(limit[1]));
        if (extraHint !== "") hint = `${extraHint} · ${hint}`;
        return h("div", { className: "dsh-advisor-row", key: key, "data-advisor-row": key }, [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: `dsh-advisor-${key}`, key: "label" },
            t(labelKey),
          ),
          h("input", {
            className: "dsh-advisor-input",
            "data-advisor-field": key,
            id: `dsh-advisor-${key}`,
            key: "input",
            max: String(limit[1]),
            min: String(limit[0]),
            onBlur: function onNumberBlur() {
              commitOne(key);
            },
            onChange: function onNumberChange(/** @type {any} */ event) {
              let value = String(event.target.value);
              setTexts(function mergeNumber(/** @type {any} */ prev) {
                return Object.assign({}, prev, { [key]: value });
              });
            },
            step: "1",
            type: "number",
            value: typeof texts[key] === "string" ? texts[key] : "",
          }),
          h("span", { className: "dsh-advisor-hint", key: "hint" }, hint),
        ]);
      }

      /** temperature：留空表示不传，可为小数。 @returns {any} */
      function temperatureField() {
        return h("div", { className: "dsh-advisor-row", key: "temperature" }, [
          h(
            "label",
            {
              className: "dsh-advisor-label",
              htmlFor: "dsh-advisor-temperature",
              key: "label",
            },
            t("settings.advanced.temperature"),
          ),
          h("input", {
            className: "dsh-advisor-input",
            "data-advisor-field": "temperature",
            id: "dsh-advisor-temperature",
            key: "input",
            max: "2",
            min: "0",
            onBlur: function onTemperatureBlur() {
              commitOne("temperature");
            },
            onChange: function onTemperatureChange(/** @type {any} */ event) {
              let value = String(event.target.value);
              setTexts(function mergeTemperature(/** @type {any} */ prev) {
                return Object.assign({}, prev, { temperature: value });
              });
            },
            placeholder: t("settings.advanced.temperatureEmpty"),
            step: "0.1",
            type: "number",
            value: typeof texts.temperature === "string" ? texts.temperature : "",
          }),
          h(
            "span",
            { className: "dsh-advisor-hint", key: "hint" },
            t("settings.advanced.temperatureHint"),
          ),
        ]);
      }

      /**
       * 开关一行。
       * @param {string} key
       * @param {string} labelKey
       * @param {string} hintKey
       * @returns {any}
       */
      function switchField(key, labelKey, hintKey) {
        return h("div", { className: "dsh-advisor-row", key: key }, [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: `dsh-advisor-${key}`, key: "label" },
            t(labelKey),
          ),
          h("input", {
            checked: draft[key] === true,
            "data-advisor-switch": key,
            id: `dsh-advisor-${key}`,
            key: "input",
            onChange: function onSwitch(/** @type {any} */ event) {
              toggleFlag(key, event.target.checked === true);
            },
            type: "checkbox",
          }),
          h("span", { className: "dsh-advisor-hint", key: "hint" }, t(hintKey)),
        ]);
      }

      /**
       * 下拉一行（枚举字段，如 postAnswer）。
       * @param {string} key
       * @param {string} labelKey
       * @param {string[]} values 合法取值；选项文案拼成 `${prefix}${value}`
       * @param {string} prefix
       * @param {string} current
       * @param {(value: string) => void} onPick
       * @param {string} hintKey
       * @returns {any}
       */
      function selectField(key, labelKey, values, prefix, current, onPick, hintKey) {
        let options = values.map(function renderOption(/** @type {string} */ value) {
          return h("option", { key: value, value: value }, t(prefix + value));
        });
        return h("div", { className: "dsh-advisor-row", key: key, "data-advisor-row": key }, [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: `dsh-advisor-${key}`, key: "label" },
            t(labelKey),
          ),
          h(
            "select",
            {
              className: "dsh-advisor-select",
              "data-advisor-select": key,
              id: `dsh-advisor-${key}`,
              key: "select",
              onChange: function onSelectChange(/** @type {any} */ event) {
                onPick(String(event.target.value));
              },
              value: current,
            },
            options,
          ),
          h("span", { className: "dsh-advisor-hint", key: "hint" }, t(hintKey)),
        ]);
      }

      /**
       * 白名单一行：逗号分隔文本；保存时才转成数组。
       * @returns {any}
       */
      function allowedModelsField() {
        return h("div", { className: "dsh-advisor-row", key: "allowedModels" }, [
          h(
            "label",
            {
              className: "dsh-advisor-label",
              htmlFor: "dsh-advisor-allowedModels",
              key: "label",
            },
            t("settings.advanced.allowedModels"),
          ),
          h("input", {
            className: "dsh-advisor-input",
            "data-advisor-field": "allowedModels",
            id: "dsh-advisor-allowedModels",
            key: "input",
            onBlur: commitAllowedModels,
            onChange: function onAllowedModelsChange(/** @type {any} */ event) {
              let value = String(event.target.value);
              setTexts(function mergeAllowed(/** @type {any} */ prev) {
                return Object.assign({}, prev, { allowedModels: value });
              });
            },
            placeholder: t("settings.advanced.allowedModelsPlaceholder"),
            type: "text",
            value: typeof texts.allowedModels === "string" ? texts.allowedModels : "",
          }),
          h(
            "span",
            { className: "dsh-advisor-hint", key: "hint" },
            t("settings.advanced.allowedModelsHint"),
          ),
        ]);
      }

      /** provider 下拉：来自 options.routes，declared 标「自定义」。 @returns {any} */
      function providerField() {
        let routes = snap === null ? [] : snap.routes;
        let options = [h("option", { key: "__empty", value: "" }, t("settings.provider.empty"))];
        let known = false;
        for (let index = 0; index < routes.length; index += 1) {
          let route = routes[index];
          let label =
            route.source === "declared"
              ? `${route.displayName} · ${t("settings.provider.declared")}`
              : route.displayName;
          options.push(h("option", { key: route.provider, value: route.provider }, label));
          if (route.provider === draft.provider) known = true;
        }
        if (draft.provider !== "" && !known) {
          options.push(
            h(
              "option",
              { key: "__stale", value: draft.provider },
              `${draft.provider} ${t("settings.provider.stale")}`,
            ),
          );
        }
        return h("div", { className: "dsh-advisor-row", key: "provider" }, [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: "dsh-advisor-provider", key: "label" },
            t("settings.provider"),
          ),
          h(
            "select",
            {
              className: "dsh-advisor-select",
              "data-advisor-provider": "",
              id: "dsh-advisor-provider",
              key: "select",
              onChange: function onProviderChange(/** @type {any} */ event) {
                chooseProvider(String(event.target.value));
              },
              value: draft.provider,
            },
            options,
          ),
          routes.length === 0
            ? h("span", { className: "dsh-advisor-hint", key: "hint" }, t("settings.provider.none"))
            : null,
        ]);
      }

      /** 模型下拉 + 手填输入。 @returns {any} */
      function modelField() {
        let list = models;
        let options = [h("option", { key: "__empty", value: "" }, t("settings.model.empty"))];
        let known = false;
        if (list !== null) {
          for (let index = 0; index < list.length; index += 1) {
            let model = list[index];
            let label = model.name === model.id ? model.id : `${model.name} (${model.id})`;
            options.push(h("option", { key: model.id, value: model.id }, label));
            if (model.id === draft.model) known = true;
          }
          if (draft.model !== "" && !known) {
            options.push(
              h(
                "option",
                { key: "__stale", value: draft.model },
                `${draft.model} ${t("settings.model.stale")}`,
              ),
            );
          }
        }
        let hint = "";
        if (draft.provider === "") hint = t("settings.model.pickProvider");
        else if (list === null) hint = t("settings.model.loading");
        else if (list.length === 0) hint = t("settings.model.none");
        if (hint !== "") hint = `${hint} · ${t("settings.model.manualHint")}`;
        return h("div", { className: "dsh-advisor-row", key: "model" }, [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: "dsh-advisor-model", key: "label" },
            t("settings.model"),
          ),
          h("div", { className: "dsh-advisor-controls", key: "controls" }, [
            h(
              "select",
              {
                className: "dsh-advisor-select",
                "data-advisor-model": "",
                disabled: list === null,
                id: "dsh-advisor-model",
                key: "select",
                onChange: function onModelChange(/** @type {any} */ event) {
                  chooseModel(String(event.target.value));
                },
                value: draft.model,
              },
              options,
            ),
            h("input", {
              "aria-label": t("settings.model.manual"),
              className: "dsh-advisor-input",
              "data-advisor-model-text": "",
              key: "manual",
              onBlur: function onModelTextBlur() {
                if (draft.model !== "" && draft.provider !== "") {
                  loadInfoFor(draft.provider, draft.model);
                }
              },
              onChange: function onModelTextChange(/** @type {any} */ event) {
                onModelText(String(event.target.value));
              },
              placeholder: t("settings.model.manual"),
              type: "text",
              value: draft.model,
            }),
          ]),
          h(
            "span",
            { className: "dsh-advisor-hint", key: "hint" },
            hint === "" ? t("settings.model.manualHint") : hint,
          ),
        ]);
      }

      /** 思考档下拉：auto + modelInfo.efforts；拿不到只留 auto。 @returns {any} */
      function effortField() {
        let efforts = info.efforts;
        let options = [h("option", { key: "__auto", value: "" }, t("settings.effort.auto"))];
        let known = false;
        for (let index = 0; index < efforts.length; index += 1) {
          let effort = efforts[index];
          options.push(h("option", { key: effort, value: effort }, effort));
          if (effort === draft.reasoningEffort) known = true;
        }
        if (
          draft.reasoningEffort !== "" &&
          !known &&
          info.state !== "idle" &&
          info.state !== "loading"
        ) {
          options.push(
            h(
              "option",
              { key: "__stale", value: draft.reasoningEffort },
              `${draft.reasoningEffort} ${t("settings.effort.stale")}`,
            ),
          );
        }
        let hint;
        if (draft.model === "") hint = t("settings.effort.pickModel");
        else if (info.state === "loading") hint = t("settings.model.loading");
        else if (info.state === "error") hint = t("settings.error.modelInfo");
        else if (info.state === "empty" || efforts.length === 0) hint = t("settings.effort.none");
        else hint = t("settings.effort.count").replace("{count}", String(efforts.length));
        return h("div", { className: "dsh-advisor-row", key: "effort" }, [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: "dsh-advisor-effort", key: "label" },
            t("settings.effort"),
          ),
          h(
            "select",
            {
              className: "dsh-advisor-select",
              "data-advisor-effort": "",
              disabled: draft.model === "" || info.state === "loading",
              id: "dsh-advisor-effort",
              key: "select",
              onChange: function onEffortChange(/** @type {any} */ event) {
                chooseEffort(String(event.target.value));
              },
              value: draft.reasoningEffort,
            },
            options,
          ),
          h("span", { className: "dsh-advisor-hint", key: "hint" }, hint),
        ]);
      }

      // 初次加载 / 重载：还没有可用快照时只渲染标题与加载态，避免半张卡片。
      if (snap === null || draft === null) {
        let body =
          load === "error"
            ? errorBanner()
            : h("div", { className: "dsh-advisor-note", key: "loading" }, t("settings.loading"));
        return h(
          "div",
          {
            "aria-label": t("settings.aria"),
            className: "dsh-advisor-settings",
            "data-advisor-settings": "",
            role: "group",
          },
          [
            h("div", { className: "dsh-advisor-head", key: "head" }, [
              h("div", { className: "dsh-advisor-title", key: "title" }, t("settings.title")),
              h("div", { className: "dsh-advisor-desc", key: "desc" }, t("settings.desc")),
            ]),
            body,
          ],
        );
      }

      let sep = t("settings.status.sep");
      let totals = snap.totals;
      let priced = snap.settings.priceInputPerMTok > 0 || snap.settings.priceOutputPerMTok > 0;
      let lastText =
        snap.last === null
          ? t("settings.status.none")
          : snap.last.status + (snap.last.code === "" ? "" : ` · ${snap.last.code}`);
      let summaryLines = [
        t("settings.status.calls").replace("{count}", formatCount(totals.calls)),
        t("settings.status.tokens")
          .replace("{input}", formatCount(totals.inputTokens))
          .replace("{output}", formatCount(totals.outputTokens)),
        t("settings.status.cost") +
          sep +
          (priced ? `≈ $${Number(totals.costUsd).toFixed(4)}` : t("settings.status.costUnset")),
        t("settings.status.last") + sep + lastText,
        t("settings.status.skip") +
          sep +
          (snap.lastSkip === "" ? t("settings.status.none") : snap.lastSkip),
        t("settings.status.ledger") +
          sep +
          (snap.ledgerPath === "" ? t("settings.status.none") : snap.ledgerPath),
      ];

      let doctorNode = null;
      if (doctor !== null) {
        if (doctor.length === 0) {
          doctorNode = h(
            "div",
            { className: "dsh-advisor-note", key: "doctorEmpty" },
            t("settings.doctor.empty"),
          );
        } else {
          doctorNode = h(
            "div",
            { className: "dsh-advisor-checklist", "data-advisor-doctor": "", key: "doctorList" },
            doctor.map(function renderCheck(/** @type {any} */ check, /** @type {number} */ index) {
              let mark = check.status === "pass" ? "✅" : check.status === "warn" ? "⚠️" : "❌";
              return h(
                "div",
                {
                  className: "dsh-advisor-check",
                  "data-status": check.status,
                  key: `check-${index}`,
                },
                `${mark} ${check.message}`,
              );
            }),
          );
        }
      }

      let priceSourceText = t(`settings.budget.priceSource.${snap.price.source}`);
      let poolLine = t("settings.budget.poolLine")
        .replace("{calls}", formatCount(snap.pool.calls))
        .replace("{cost}", Number(snap.pool.costUsd).toFixed(4));

      let budgetGroup = [
        numberField("maxCallsPerTurn", "settings.budget.maxCallsPerTurn", ""),
        numberField("maxCallsPerSession", "settings.budget.maxCallsPerSession", ""),
        numberField("maxCallsPerHour", "settings.budget.maxCallsPerHour", ""),
        numberField("maxCostPerDayUsd", "settings.budget.maxCostPerDayUsd", ""),
        numberField(
          "workspaceMaxCallsPerDay",
          "settings.budget.workspaceMaxCallsPerDay",
          t("settings.budget.workspaceHint"),
        ),
        numberField(
          "workspaceMaxCostPerDayUsd",
          "settings.budget.workspaceMaxCostPerDayUsd",
          t("settings.budget.workspaceHint"),
        ),
        h(
          "div",
          {
            className: "dsh-advisor-readout",
            "data-advisor-pool": "",
            key: "pool",
          },
          poolLine,
        ),
        numberField(
          "priceInputPerMTok",
          "settings.budget.priceInputPerMTok",
          `${t("settings.budget.priceHint")} · ${priceSourceText}`,
        ),
        numberField(
          "priceOutputPerMTok",
          "settings.budget.priceOutputPerMTok",
          `${t("settings.budget.priceHint")} · ${priceSourceText}`,
        ),
      ];

      // 「预览会发什么」的返回：可折叠 <pre>，空正文时整块不渲染。
      let previewNode = null;
      if (previewText !== "") {
        previewNode = h("div", { className: "dsh-advisor-preview", key: "previewBody" }, [
          h("div", { className: "dsh-advisor-row", key: "toggleRow" }, [
            h(
              "span",
              { className: "dsh-advisor-label", key: "label" },
              t("settings.preview.title"),
            ),
            h(
              "button",
              {
                "aria-expanded": previewOpen ? "true" : "false",
                className: "dsh-advisor-btn",
                "data-advisor-preview-toggle": "",
                key: "toggle",
                onClick: togglePreview,
                type: "button",
              },
              previewOpen ? t("settings.preview.collapse") : t("settings.preview.expand"),
            ),
          ]),
          previewOpen
            ? h(
                "pre",
                { className: "dsh-advisor-pre", "data-advisor-preview": "", key: "pre" },
                previewText,
              )
            : null,
        ]);
      }

      // 跨 provider 确认：没选 provider 就不显示（没有可确认的对象）。
      let confirmRow = null;
      if (draft.provider !== "") {
        confirmRow = h("div", { className: "dsh-advisor-row", key: "confirmRow" }, [
          h("span", { className: "dsh-advisor-label", key: "label" }, t("settings.confirm")),
          h(
            "button",
            {
              className: "dsh-advisor-btn",
              "data-advisor-confirm": "",
              disabled: busy === "confirm",
              key: "run",
              onClick: confirmHost,
              type: "button",
            },
            busy === "confirm" ? t("settings.confirm.running") : t("settings.confirm.run"),
          ),
          h("span", { className: "dsh-advisor-hint", key: "hint" }, t("settings.confirm.hint")),
        ]);
      }

      let advancedGroup = [
        numberField("maxTokens", "settings.advanced.maxTokens", ""),
        temperatureField(),
        numberField("maxInputChars", "settings.advanced.maxInputChars", ""),
        numberField("sessionCap", "settings.advanced.sessionCap", ""),
        allowedModelsField(),
        h("div", { className: "dsh-advisor-row", key: "previewRow" }, [
          h("span", { className: "dsh-advisor-label", key: "label" }, t("settings.preview")),
          h(
            "button",
            {
              className: "dsh-advisor-btn",
              "data-advisor-preview-run": "",
              disabled: busy === "preview",
              key: "run",
              onClick: runPreview,
              type: "button",
            },
            busy === "preview" ? t("settings.preview.running") : t("settings.preview.run"),
          ),
        ]),
        previewNode,
        confirmRow,
        h("div", { className: "dsh-advisor-divider", key: "divider" }),
        h(
          "div",
          { className: "dsh-advisor-subtitle", key: "statusTitle" },
          t("settings.status.title"),
        ),
        h(
          "div",
          { className: "dsh-advisor-summary", "data-advisor-summary": "", key: "summary" },
          summaryLines.map(
            function renderSummaryLine(/** @type {string} */ line, /** @type {number} */ index) {
              return h(
                "div",
                { className: "dsh-advisor-summary-line", key: `line-${index}` },
                line,
              );
            },
          ),
        ),
        h("div", { className: "dsh-advisor-row", key: "doctorRow" }, [
          h("span", { className: "dsh-advisor-label", key: "label" }, t("settings.doctor")),
          h(
            "button",
            {
              className: "dsh-advisor-btn",
              disabled: busy === "doctor",
              key: "run",
              onClick: runDoctor,
              type: "button",
            },
            busy === "doctor" ? t("settings.doctor.running") : t("settings.doctor.run"),
          ),
        ]),
        doctorNode,
      ];

      let noticeNode =
        notice === ""
          ? null
          : h("div", { className: "dsh-advisor-saved", key: "notice", role: "status" }, notice);

      return h(
        "div",
        {
          "aria-label": t("settings.aria"),
          className: "dsh-advisor-settings",
          "data-advisor-settings": "",
          role: "group",
        },
        [
          h("div", { className: "dsh-advisor-head", key: "head" }, [
            h("div", { className: "dsh-advisor-title", key: "title" }, t("settings.title")),
            h("div", { className: "dsh-advisor-desc", key: "desc" }, t("settings.desc")),
          ]),
          errorBanner(),
          group(
            "settings.group.basic",
            [
              radioField(
                "mode",
                "settings.mode",
                SETTINGS_MODES,
                "settings.mode.",
                draft.mode,
                chooseMode,
                "mode",
              ),
              providerField(),
              modelField(),
              effortField(),
              selectField(
                "postAnswer",
                "settings.postAnswer",
                SETTINGS_POST_ANSWER,
                "settings.postAnswer.",
                draft.postAnswer,
                choosePostAnswer,
                "settings.postAnswer.hint",
              ),
              switchField("advisorTools", "settings.advisorTools", "settings.advisorToolsHint"),
            ],
            "basic",
          ),
          group("settings.group.budget", budgetGroup, "budget"),
          group(
            "settings.group.privacy",
            [
              radioField(
                "scope",
                "settings.scope",
                SETTINGS_SCOPES,
                "settings.scope.",
                draft.privacyScope,
                chooseScope,
                "scope",
              ),
              switchField("redact", "settings.privacy.redact", "settings.privacy.redactHint"),
              switchField("dedupe", "settings.privacy.dedupe", "settings.privacy.dedupeHint"),
            ],
            "privacy",
          ),
          group("settings.group.advanced", advancedGroup, "advanced"),
          noticeNode,
          h("div", { className: "dsh-advisor-actions", key: "actions" }, [
            h(
              "button",
              {
                className: "dsh-advisor-btn dsh-advisor-btn--primary",
                "data-advisor-save": "",
                disabled: busy === "save" || busy === "load",
                key: "save",
                onClick: save,
                type: "button",
              },
              busy === "save" ? t("settings.saving") : t("settings.save"),
            ),
            h(
              "button",
              {
                className: "dsh-advisor-btn",
                "data-advisor-reload": "",
                disabled: busy === "load",
                key: "reload",
                onClick: reload,
                type: "button",
              },
              t("settings.reload"),
            ),
          ]),
        ],
      );
    }

    exports.inject = ["slots", "locale", "connection"];

    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "advisor: dictionaries");

      /** @type {any} */
      let t;
      try {
        t = ctx.locale.bind(NS);
      } catch (_error) {
        t = function fallbackT(/** @type {string} */ key) {
          return key;
        };
      }

      // 注入样式；判重让 HMR / 重复挂载不会插第二份。
      ctx.effect(() => {
        if (typeof document === "undefined" || !document.head) return undefined;
        let selector = `style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`;
        if (document.querySelector(selector) !== null) return undefined;
        let tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "advisor: styles");

      let toastStore = createStore(null);
      let toastSeq = 0;

      /**
       * @param {string} message
       * @param {"ok" | "error" | "info"} [tone]
       */
      function showToast(message, tone) {
        let text = asString(message).trim();
        if (text === "") return;
        toastSeq += 1;
        toastStore.set({
          id: toastSeq,
          message: text,
          tone: tone === "error" || tone === "ok" ? tone : "info",
        });
      }

      /**
       * 取宿主服务（可能缺席，绝不抛）。
       * @param {string} name
       * @returns {any}
       */
      function serviceOf(name) {
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
      }

      /**
       * Typert Remote 调用：统一解 `{ ok, value }` 信封，失败返回 undefined（调用方决定降级）。
       * @param {string} method
       * @param {any} [request]
       * @returns {Promise<any>}
       */
      function callRemote(method, request) {
        return new Promise((resolve) => {
          let channel;
          try {
            let connection = serviceOf("connection");
            channel = connection ? connection.rpc : undefined;
          } catch (_error) {
            channel = undefined;
          }
          if (!channel || typeof channel.call !== "function") {
            resolve(undefined);
            return;
          }
          try {
            let payload = request === undefined ? { args: {} } : { args: { request: request } };
            Promise.resolve(channel.call("/api", `advisor/${method}`, payload)).then(
              (result) => {
                resolve(unwrapEnvelope(result));
              },
              () => {
                resolve(undefined);
              },
            );
          } catch (_error) {
            resolve(undefined);
          }
        });
      }

      /** 本次打开选择器的候选行缓存：id → 行（用于 onSelect 拿回 route/reason）。 */
      /** @type {Map<string, any>} */
      let lastRows = new Map();

      /** 「顾问尚未就绪」引导项：RPC 缺失/畸形/空目录时的唯一降级出口。 */
      function notReadyOption() {
        return {
          id: "advisor:not-ready",
          label: t("notReady.label"),
          detail: t("notReady.detail"),
          kind: "not-ready",
          reason: "",
          route: null,
        };
      }

      /**
       * 把 RPC 数据摊平成宿主 popupSelect 需要的行；空 / 畸形时退回引导项。
       * @param {any} raw
       * @returns {any[]}
       */
      function buildOptions(raw) {
        let data = normalizeCandidates(raw);
        /** @type {any[]} */
        let rows = [];
        /** @type {Set<string>} */
        let seen = new Set();
        /** @param {any} row */
        let push = (row) => {
          if (!row || typeof row.id !== "string" || row.id === "" || seen.has(row.id)) return;
          seen.add(row.id);
          rows.push(row);
        };

        if (data !== null && data.current !== null) {
          push({
            id: `current:${data.current.id}`,
            label: data.current.label,
            detail: data.current.detail || t("current.detail"),
            group: { name: "current", label: t("group.current") },
            active: true,
            kind: "current",
            reason: "",
            route: data.current.route,
          });
        }

        if (data !== null) {
          for (let index = 0; index < data.groups.length; index += 1) {
            let group = data.groups[index];
            let groupField =
              group.label === "" ? undefined : { name: `group:${index}`, label: group.label };
            for (let j = 0; j < group.items.length; j += 1) {
              let item = group.items[j];
              let blocked = item.disabled === true;
              push({
                id: `model:${item.id}`,
                label: blocked ? `${item.label} ⚠` : item.label,
                detail: blocked ? item.reason || item.detail || t("blocked.detail") : item.detail,
                group: groupField,
                kind: blocked ? "blocked" : "model",
                reason: item.reason,
                route: item.route,
                disabled: blocked,
              });
            }
          }
          for (let k = 0; k < data.extras.length; k += 1) {
            let extra = data.extras[k];
            if (extra.id === "off") {
              push({
                id: "off",
                label: extra.label || t("off.label"),
                detail: extra.detail || t("off.detail"),
                group: { name: "extras", label: t("group.extras") },
                kind: "off",
                reason: "",
                route: null,
              });
            } else {
              push({
                id: "settings",
                label: extra.label || t("settings.label"),
                detail: extra.detail || t("settings.detail"),
                group: { name: "extras", label: t("group.extras") },
                kind: "settings",
                reason: "",
                route: null,
              });
            }
          }
        }

        let hasChoice = rows.some((row) => row.kind === "model" || row.kind === "current");
        if (!hasChoice) return [notReadyOption()].concat(rows);
        return rows;
      }

      /**
       * 取候选列表。宿主的 SRC 派发按方法参数名做严格校验：宿主方法没有声明参数时
       * 传 `request` 会被判 "unexpected request"；声明了 `request` 时又必须传。
       * 两种形状都兼容：先按无参数调用，失败再带空 request 重试一次。
       * @returns {Promise<any>}
       */
      async function fetchCandidates() {
        let raw = await callRemote("candidates", undefined);
        if (raw === undefined || isRpcFailure(raw)) raw = await callRemote("candidates", {});
        return raw;
      }

      /**
       * 每次打开选择器都重新 RPC（宿主的路由/模型随时可能被用户改），绝不跨次缓存。
       * @returns {Promise<any[]>}
       */
      async function optionsFor() {
        /** @type {any[]} */
        let rows;
        try {
          let raw = await fetchCandidates();
          rows = buildOptions(raw);
        } catch (_error) {
          rows = [notReadyOption()];
        }
        if (!Array.isArray(rows) || rows.length === 0) rows = [notReadyOption()];
        lastRows = new Map();
        for (let index = 0; index < rows.length; index += 1) {
          lastRows.set(rows[index].id, rows[index]);
        }
        return rows;
      }

      /**
       * 尽力把 `/advisor doctor` 写进会话输入框草稿；拿不到输入框就返回 false（绝不报错）。
       * @param {any} sessionId
       * @param {string} text
       * @returns {boolean}
       */
      function writeDraft(sessionId, text) {
        try {
          if (typeof sessionId !== "string" || sessionId === "") return false;
          let conversation = serviceOf("conversation");
          let input = conversation ? conversation.input : undefined;
          if (!input) return false;
          /** @type {any} */
          let facade;
          if (typeof input.shell === "function") {
            try {
              facade = input.shell(sessionId);
            } catch (_error) {
              facade = undefined;
            }
          }
          if (!facade && typeof input.for === "function") {
            let sessions = serviceOf("sessions");
            let scope =
              sessions && typeof sessions.scope === "function"
                ? sessions.scope(sessionId)
                : undefined;
            if (scope !== undefined) facade = input.for(scope);
          }
          if (!facade) return false;
          let actions =
            facade.actions && typeof facade.actions === "object" ? facade.actions : facade;
          if (typeof actions.setDraft !== "function") return false;
          actions.setDraft(text);
          return true;
        } catch (_error) {
          return false;
        }
      }

      /**
       * 「去配置」的降级路径：0.2.2 的设置面板是 slot 壳，宿主没有向业务包暴露「打开设置页」
       * 的客户端导航 API，所以退化成把 /advisor doctor 塞进输入框草稿（拿不到输入框就只提示）。
       * @param {any} sessionId
       */
      function openSettingsBestEffort(sessionId) {
        if (writeDraft(sessionId, "/advisor doctor")) {
          showToast(t("settings.hint"), "info");
          return;
        }
        showToast(t("toast.settings"), "info");
      }

      /**
       * 选中回调：成功/失败都必须有反馈；永不抛错（宿主会把它当命令失败弹错误）。
       * @param {any} option
       * @param {any} session
       */
      async function onSelect(option, session) {
        try {
          let sessionId = session && typeof session.sessionId === "string" ? session.sessionId : "";
          let optionId = option && typeof option.id === "string" ? option.id : "";
          let row = optionId === "" ? null : lastRows.get(optionId);
          if (!row && option && typeof option === "object") row = option;
          if (!row) {
            showToast(t("toast.stale"), "error");
            return;
          }

          if (row.kind === "current") {
            showToast(t("toast.current"), "info");
            return;
          }
          if (row.kind === "blocked") {
            showToast(row.reason || t("blocked.detail"), "error");
            return;
          }
          if (row.kind === "not-ready") {
            openSettingsBestEffort(sessionId);
            return;
          }
          if (row.kind === "settings") {
            openSettingsBestEffort(sessionId);
            return;
          }
          if (row.kind === "off") {
            let result = await callRemote("setModel", {
              provider: "",
              model: "",
              reasoningEffort: "",
            });
            let outcome = interpretSetModel(result, t);
            showToast(outcome.ok ? t("toast.off") : outcome.message, outcome.ok ? "info" : "error");
            return;
          }

          let route = row.route || parseRouteId(row.id);
          if (!route || route.provider === "" || route.model === "") {
            showToast(t("toast.stale"), "error");
            return;
          }
          let request = {
            provider: route.provider,
            model: route.model,
            reasoningEffort: asString(route.reasoningEffort),
          };
          let applied = await callRemote("setModel", request);
          let outcome = interpretSetModel(applied, t);
          if (!outcome.ok) {
            showToast(outcome.message, "error");
            return;
          }
          let appliedRoute = outcome.route || request;
          let provider = asString(appliedRoute.provider) || request.provider;
          let model = asString(appliedRoute.model) || request.model;
          let rawEffort =
            appliedRoute.reasoningEffort !== undefined
              ? appliedRoute.reasoningEffort
              : appliedRoute.effort;
          let effort = asString(rawEffort) || request.reasoningEffort;
          showToast(
            t("toast.applied")
              .replace("{route}", `${provider}/${model}`)
              .replace("{effort}", effort === "" ? t("effort.auto") : effort),
            "ok",
          );
        } catch (_error) {
          showToast(t("error.failed"), "error");
        }
      }

      // ------------------------------------------------------------------
      // 注册：toast（shell.overlay）+ `/advisor` 命令装饰（popupSelect）
      // ------------------------------------------------------------------

      // shell.overlay 是常驻浮层：默认渲染 null，只有 showToast 之后才出现一行提示。
      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              { name: "shell.overlay", id: "advisor", order: 860, locale: NS },
              function AdvisorOverlay(/** @type {any} */ props) {
                return h(AdvisorToast, Object.assign({}, props, { store: toastStore }));
              },
            ),
          ),
        "advisor: overlay toast",
      );

      /**
       * 设置卡片的 api：全部经 callRemote，形状固定为宿主声明的 request 字段。
       * 组件只负责渲染与降级，RPC 顺序由组件触发（options → models → modelInfo → updateSettings / doctor）。
       */
      let settingsApi = {
        options: (/** @type {string} */ sessionId) =>
          callRemote("options", { sessionId: sessionId }),
        models: (/** @type {string} */ provider) => callRemote("models", { provider: provider }),
        modelInfo: (/** @type {string} */ provider, /** @type {string} */ model) =>
          callRemote("modelInfo", { provider: provider, model: model }),
        updateSettings: (/** @type {any} */ patch) =>
          callRemote("updateSettings", { patch: patch }),
        doctor: (/** @type {string} */ sessionId) => callRemote("doctor", { sessionId: sessionId }),
        preview: (/** @type {string} */ sessionId) =>
          callRemote("preview", { sessionId: sessionId }),
        notify: (/** @type {string} */ message, /** @type {string} */ tone) =>
          showToast(message, tone === "error" || tone === "ok" ? tone : "info"),
      };

      // 设置页 → 通用：顾问的模式、路由、预算、隐私与状态摘要。
      ctx.effect(
        () =>
          ctx.slots.inject("settings.general.item", () =>
            ctx.slots.register(
              {
                name: "settings.general.item",
                id: "advisor",
                order: 880,
                locale: NS,
                // 同时注入 apply 里绑定的 t：宿主没给 props.t 时也不会退化成裸 key。
                inject: () => ({ api: settingsApi, t: t }),
              },
              AdvisorSettings,
            ),
          ),
        "advisor: settings card",
      );

      /**
       * 拉某会话的顾问记录：同一 sessionId 只发一次 RPC（in-flight Promise 也进缓存），
       * 失败/畸形一律退化成空数组并清掉缓存（下次挂载可重试），绝不弹错。
       * @param {string} sessionId
       * @returns {Promise<any[]>}
       */
      function loadAdvice(sessionId) {
        if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve([]);
        let cached = adviceCache.get(sessionId);
        if (cached !== undefined) return cached;
        let pending = callRemote("advice", { sessionId: sessionId }).then(
          function onAdvice(raw) {
            let items = normalizeAdviceItems(raw);
            if (items === null) {
              adviceCache.delete(sessionId);
              return [];
            }
            return items;
          },
          function onAdviceFailed() {
            adviceCache.delete(sessionId);
            return [];
          },
        );
        adviceCache.set(sessionId, pending);
        return pending;
      }

      /** 顾问线的 api：只有一个方法，失败已在 loadAdvice 里降级。 */
      let tailApi = {
        advice: (/** @type {string} */ sessionId) => loadAdvice(sessionId),
      };

      // 顾问线：每轮答案尾部一行（与 next-step 的决策卡并存，order 排在其后）。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.chat.turnTail", () =>
            ctx.slots.register(
              {
                name: "conversation.chat.turnTail",
                id: "advisor-turn-line",
                order: 1100,
                locale: NS,
                inject: () => ({ api: tailApi, t: t }),
              },
              AdvisorTurnLine,
            ),
          ),
        "advisor: turn line",
      );

      /**
       * 装饰 `/advisor`：宿主 popupSelect 打开模型选择器。
       * 必须等 commandUi 服务就绪（它不一定在 apply 时已挂载），否则装饰会被静默跳过。
       * @param {any} scope
       * @param {any} commandUi
       */
      function installCommandDecoration(scope, commandUi) {
        scope.effect(
          () =>
            commandUi.decorate({
              name: "advisor",
              // 缺了 available，不同宿主的菜单/回车路径会直接跳过装饰（表现为回车没反应）。
              available: (/** @type {any} */ session) =>
                Boolean(session && typeof session.sessionId === "string"),
              ui: {
                kind: "popupSelect",
                searchMode: "substring",
                searchLabels: () => ({
                  placeholder: t("search.placeholder"),
                  empty: t("search.empty"),
                  noResults: t("search.noResults"),
                }),
                options: () => optionsFor(),
                onSelect: (/** @type {any} */ option, /** @type {any} */ session) =>
                  onSelect(option, session),
              },
            }),
          "advisor: command decoration",
        );
      }

      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["commandUi"], (/** @type {any} */ scope) => {
            let commandUi =
              (scope ? scope.commandUi : undefined) ||
              (scope && typeof scope.get === "function" ? scope.get("commandUi") : undefined) ||
              serviceOf("commandUi");
            if (commandUi && typeof commandUi.decorate === "function") {
              installCommandDecoration(scope || ctx, commandUi);
            }
          });
        } else {
          let commandUi = serviceOf("commandUi");
          if (commandUi && typeof commandUi.decorate === "function") {
            installCommandDecoration(ctx, commandUi);
          }
        }
      } catch (_error) {
        /* commandUi 缺失：不装饰；宿主命令本身仍然可用 */
      }
    };

    // 供 node:vm 单测读取的纯函数出口（非枚举，不影响运行时）。
    Object.defineProperty(exports, "__test", {
      value: Object.freeze({
        parseRouteId: parseRouteId,
        normalizeCandidates: normalizeCandidates,
        interpretSetModel: interpretSetModel,
        clampInt: clampInt,
        clampFloat: clampFloat,
        normalizeOptions: normalizeOptions,
        normalizeModels: normalizeModels,
        normalizeModelInfo: normalizeModelInfo,
        normalizeDoctor: normalizeDoctor,
        normalizePreview: normalizePreview,
        normalizeStringList: normalizeStringList,
        diffSettings: diffSettings,
        interpretUpdate: interpretUpdate,
        normalizeAdviceItems: normalizeAdviceItems,
        truncateText: truncateText,
        turnNumberOf: turnNumberOf,
        slotTurnNumber: slotTurnNumber,
        isAdviceTurnReady: isAdviceTurnReady,
      }),
    });

    return module.exports;
  },
});
