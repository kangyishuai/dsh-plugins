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
     * 顾问线缓存：同一个 sessionId 的 in-flight Promise 与结果（带时间戳）。
     * 失败不进缓存（下一次挂载可以重试），页面刷新时整体失效；切会话是新的 key。
     * **必须带 TTL**：影子/答后建议在回合结束后才落盘，永久缓存会让顾问线永不出现。
     * @type {Map<string, { at: number, promise: Promise<any[]> }>}
     */
    let adviceCache = new Map();
    /** 缓存 TTL（毫秒）。 */
    let ADVICE_CACHE_TTL_MS = 3000;

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
      ".dsh-advisor-group{display:flex;flex-direction:column;gap:8px;}",
      ".dsh-advisor-group + .dsh-advisor-group{margin-top:2px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));}",
      ".dsh-advisor-group-title{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-subgroup{display:flex;flex-direction:column;gap:6px;}",
      ".dsh-advisor-subgroup-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;}",
      ".dsh-advisor-row--stack{flex-direction:column;align-items:flex-start;gap:4px;}",
      ".dsh-advisor-field{display:flex;flex-direction:column;gap:2px;}",
      ".dsh-advisor-label-wrap{display:flex;align-items:center;gap:6px;flex:0 0 auto;}",
      ".dsh-advisor-label{flex:0 0 auto;min-width:120px;color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-help-btn{flex:0 0 auto;width:16px;height:16px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));background:transparent;color:var(--dsw-alias-label-secondary,GrayText);font-size:11px;line-height:14px;text-align:center;cursor:pointer;}",
      ".dsh-advisor-help-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-help-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary,CanvasText);outline-offset:1px;}",
      ".dsh-advisor-help-body{padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-help-body p{margin:0;}",
      ".dsh-advisor-help-body .dsh-advisor-help-meta{margin-top:2px;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-help-body .dsh-advisor-help-tech{margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;opacity:.85;}",
      ".dsh-advisor-controls{display:flex;flex:1 1 220px;flex-wrap:wrap;gap:6px;min-width:0;}",
      ".dsh-advisor-input,.dsh-advisor-select{flex:1 1 140px;min-width:0;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:inherit;font:inherit;}",
      ".dsh-advisor-input[type=number]{flex:0 0 120px;}",
      ".dsh-advisor-input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;}",
      ".dsh-advisor-hint{flex:1 1 100%;font-size:11.5px;color:var(--dsw-alias-label-secondary,GrayText);word-break:break-word;}",
      ".dsh-advisor-unit{flex:0 0 auto;font-size:11.5px;color:var(--dsw-alias-label-secondary,GrayText);white-space:nowrap;}",
      ".dsh-advisor-off{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));}",
      ".dsh-advisor-off-title{font-weight:600;}",
      ".dsh-advisor-dirty{font-size:12px;color:var(--dsw-alias-state-warning-primary,#b7791f);}",
      ".dsh-advisor-disclosure{display:flex;flex-direction:column;gap:4px;}",
      ".dsh-advisor-disclosure-toggle{display:flex;align-items:center;gap:6px;width:100%;padding:4px 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
      ".dsh-advisor-disclosure-toggle:hover{color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-advisor-caret{flex:0 0 auto;width:12px;font-size:11px;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-disclosure-title{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-badge{flex:0 0 auto;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,GrayText);font-size:10.5px;line-height:16px;font-weight:400;}",
      ".dsh-advisor-disclosure-body{display:flex;flex-direction:column;gap:10px;padding:4px 0 2px 16px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));}",
      ".dsh-advisor-paths{display:flex;flex-direction:column;gap:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,GrayText);word-break:break-all;}",
      ".dsh-advisor-more{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-advisor-more p{margin:0;}",
      ".dsh-advisor-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;word-break:break-all;}",
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

    /** 与 host 的 DEFAULT_SETTINGS 对齐；数值字段缺失时用它回落。 @type {Record<string, any>} */
    let SETTINGS_DEFAULTS = {
      mode: "off",
      provider: "",
      model: "",
      reasoningEffort: "",
      maxTokens: 4096,
      temperature: null,
      maxCallsPerTurn: 1,
      maxCallsPerSession: 32,
      maxCallsPerHour: 12,
      maxCostPerDayUsd: 0,
      priceInputPerMTok: 0,
      priceOutputPerMTok: 0,
      privacyScope: "summary",
      redact: true,
      dedupe: true,
      sessionCap: 24,
      allowedModels: [],
      workspaceMaxCallsPerDay: 200,
      workspaceMaxCostPerDayUsd: 0,
      postAnswer: "off",
      advisorTools: false,
      maxInputChars: 60000,
    };

    /** 与 settings.js 的 INT_LIMITS / MONEY_LIMITS 逐项一致；越界在前端先夹一次。 @type {Record<string, number[]>} */
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

    /** 金额字段的小数位；与 settings.js 的 MONEY_LIMITS 一致。 @type {Record<string, number>} */
    let SETTINGS_MONEY_FIELDS = {
      maxCostPerDayUsd: 2,
      workspaceMaxCostPerDayUsd: 2,
      priceInputPerMTok: 4,
      priceOutputPerMTok: 4,
    };

    /** 所有整数输入字段（temperature 单独处理：可为空、可小数）。 */
    let SETTINGS_INT_FIELDS = Object.keys(SETTINGS_LIMITS).filter(function isIntField(key) {
      return Object.hasOwn(SETTINGS_MONEY_FIELDS, key) === false;
    });

    /** 高级区字段：用于「N 项已修改」徽标与「恢复默认」。 */
    let SETTINGS_ADVANCED_FIELDS = [
      "maxCallsPerTurn",
      "maxCallsPerSession",
      "maxCallsPerHour",
      "workspaceMaxCallsPerDay",
      "workspaceMaxCostPerDayUsd",
      "priceInputPerMTok",
      "priceOutputPerMTok",
      "maxTokens",
      "temperature",
      "maxInputChars",
      "sessionCap",
      "allowedModels",
      "postAnswer",
      "advisorTools",
      "dedupe",
    ];

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
     * 整数夹紧：与 settings.js 的 clampInt 同语义（取整、非有限值回落）。
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
     * 金额夹紧：与 settings.js 的 clampMoney 同语义（按固定小数位收口）。
     * @param {any} value
     * @param {number} fallback
     * @param {number} min
     * @param {number} max
     * @param {number} digits
     * @returns {number}
     */
    function clampMoney(value, fallback, min, max, digits) {
      let n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      let bounded = Math.min(max, Math.max(min, n));
      let factor = 10 ** digits;
      return Math.round(bounded * factor) / factor;
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
     * 金额输入框的规范文本：去掉多余的尾零，0 显示成 "0"。
     * @param {any} value
     * @param {number} digits
     * @returns {string}
     */
    function formatMoneyInput(value, digits) {
      let n = Number(value);
      if (!Number.isFinite(n)) return "0";
      let text = n.toFixed(digits);
      if (text.indexOf(".") >= 0) text = text.replace(/0+$/, "").replace(/\.$/, "");
      return text === "" || text === "-0" ? "0" : text;
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
      for (let key of Object.keys(SETTINGS_MONEY_FIELDS)) {
        out[key] = clampMoney(
          input[key],
          SETTINGS_DEFAULTS[key],
          SETTINGS_LIMITS[key][0],
          SETTINGS_LIMITS[key][1],
          SETTINGS_MONEY_FIELDS[key],
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
        settingsPath: asString(raw.settingsPath).trim(),
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
          // 本回合还没有记录时（影子建议稍后才落盘），延迟强制重取两次。
          /** @type {any[]} */
          let timers = [];
          /** @param {number} delay */
          let schedule = function scheduleRetry(delay) {
            timers.push(
              setTimeout(function retry() {
                if (!alive) return;
                let again;
                try {
                  again = Promise.resolve(api.advice(sessionId, true));
                } catch (_error) {
                  return;
                }
                again.then(
                  function onRetry(value) {
                    if (!alive) return;
                    let items = Array.isArray(value) ? value : [];
                    setRecords(items);
                    let hit = items.some(function matches(item) {
                      return item && item.turn === slotTurnNumber(turn);
                    });
                    if (!hit) schedule(4000);
                  },
                  function onRetryFailed() {
                    /* 静默 */
                  },
                );
              }, delay),
            );
          };
          pending.then(
            function onItems(value) {
              if (!alive) return;
              let items = Array.isArray(value) ? value : [];
              setRecords(items);
              let hit = items.some(function matches(item) {
                return item && item.turn === slotTurnNumber(turn);
              });
              if (!hit) schedule(2500);
            },
            function onFailure() {
              if (alive) setRecords([]);
            },
          );
          return function cleanup() {
            alive = false;
            for (let index = 0; index < timers.length; index += 1) clearTimeout(timers[index]);
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
      /** 高级设置默认折叠；状态与诊断再单独一层。 */
      let advancedState = React.useState(false);
      let advancedOpen = advancedState[0];
      let setAdvancedOpen = advancedState[1];
      let statusState = React.useState(false);
      let statusOpen = statusState[0];
      let setStatusOpen = statusState[1];
      /** off 时也可以显式展开配置；默认收起。 */
      let offExpandState = React.useState(false);
      let offExpanded = offExpandState[0];
      let setOffExpanded = offExpandState[1];
      /** 同一时间只展开一个字段的说明。 */
      let helpState = React.useState("");
      let openHelp = helpState[0];
      let setOpenHelp = helpState[1];
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
        for (let key of Object.keys(SETTINGS_MONEY_FIELDS)) {
          out[key] = formatMoneyInput(settings[key], SETTINGS_MONEY_FIELDS[key]);
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
              setAdvancedOpen(false);
              setStatusOpen(false);
              setOffExpanded(false);
              setOpenHelp("");
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
        for (let key of Object.keys(SETTINGS_MONEY_FIELDS)) {
          let raw = texts[key];
          if (typeof raw !== "string") continue;
          let text = raw.trim();
          if (text === "") continue;
          next[key] = clampMoney(
            text,
            next[key],
            SETTINGS_LIMITS[key][0],
            SETTINGS_LIMITS[key][1],
            SETTINGS_MONEY_FIELDS[key],
          );
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
        let limit = SETTINGS_LIMITS[key];
        let digits = SETTINGS_MONEY_FIELDS[key];
        if (text === "") {
          let restored =
            digits === undefined ? String(draft[key]) : formatMoneyInput(draft[key], digits);
          setTexts(Object.assign({}, texts, { [key]: restored }));
          return;
        }
        let value =
          digits === undefined
            ? clampInt(text, draft[key], limit[0], limit[1])
            : clampMoney(text, draft[key], limit[0], limit[1], digits);
        setDraft(Object.assign({}, draft, { [key]: value }));
        setTexts(
          Object.assign({}, texts, {
            [key]: digits === undefined ? String(value) : formatMoneyInput(value, digits),
          }),
        );
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
        // 切回 off 时回到紧凑态；切到其它模式时保持/展开基础设置。
        if (mode === "off") setOffExpanded(false);
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
       * 高级区里的小分组标题。
       * @param {string} titleKey
       * @param {any[]} children
       * @param {string} key
       * @returns {any}
       */
      function subgroup(titleKey, children, key) {
        return h(
          "div",
          { className: "dsh-advisor-subgroup", key: key },
          [h("div", { className: "dsh-advisor-subgroup-title", key: "title" }, t(titleKey))].concat(
            children,
          ),
        );
      }

      /**
       * 字段外壳：label + 可选「?」帮助按钮 + 控件 + 可选内联提示。
       * 帮助说明只在点开时渲染，避免每个字段常驻两三行说明把页面撑长。
       * @param {string} key
       * @param {string} labelKey
       * @param {any[]} controlNodes
       * @param {{ controlId?: string, hint?: string, helpText?: string, metaText?: string }} [options]
       * @returns {any}
       */
      function fieldShell(key, labelKey, controlNodes, options) {
        let opts = options === undefined ? {} : options;
        let controlId = typeof opts.controlId === "string" ? opts.controlId : `dsh-advisor-${key}`;
        let helpText = typeof opts.helpText === "string" ? opts.helpText : "";
        let metaText = typeof opts.metaText === "string" ? opts.metaText : "";
        let hint = typeof opts.hint === "string" ? opts.hint : "";
        let helpId = `dsh-advisor-help-${key}`;
        let isHelpOpen = openHelp === key;
        let labelChildren = [
          h(
            "label",
            { className: "dsh-advisor-label", htmlFor: controlId, key: "label" },
            t(labelKey),
          ),
        ];
        if (helpText !== "") {
          labelChildren.push(
            h(
              "button",
              {
                "aria-controls": isHelpOpen ? helpId : undefined,
                "aria-expanded": isHelpOpen ? "true" : "false",
                "aria-label": t("settings.help.open").replace("{field}", t(labelKey)),
                className: "dsh-advisor-help-btn",
                key: "help",
                onClick: function toggleHelp() {
                  setOpenHelp(isHelpOpen ? "" : key);
                },
                onKeyDown: function closeHelp(/** @type {any} */ event) {
                  if (event && event.key === "Escape") setOpenHelp("");
                },
                title: t("settings.help.open").replace("{field}", t(labelKey)),
                type: "button",
              },
              "?",
            ),
          );
        }
        let rowChildren = [
          h("div", { className: "dsh-advisor-label-wrap", key: "labelWrap" }, labelChildren),
        ].concat(controlNodes);
        if (hint !== "") {
          rowChildren.push(h("span", { className: "dsh-advisor-hint", key: "hint" }, hint));
        }
        let children = [
          h(
            "div",
            { className: "dsh-advisor-row", "data-advisor-row": key, key: "row" },
            rowChildren,
          ),
        ];
        if (helpText !== "" && isHelpOpen) {
          let helpChildren = [h("p", { key: "text" }, helpText)];
          if (metaText !== "") {
            helpChildren.push(
              h("p", { className: "dsh-advisor-help-meta", key: "meta" }, metaText),
            );
          }
          helpChildren.push(
            h(
              "p",
              { className: "dsh-advisor-help-tech", key: "tech" },
              t("settings.help.tech").replace("{key}", key),
            ),
          );
          children.push(
            h(
              "div",
              { className: "dsh-advisor-help-body", id: helpId, key: "helpBody", role: "note" },
              helpChildren,
            ),
          );
        }
        return h(
          "div",
          { className: "dsh-advisor-field", "data-advisor-field": key, key: key },
          children,
        );
      }

      /**
       * 默认值 + 范围提示；数值字段共用。
       * @param {string} key
       * @returns {string}
       */
      function rangeText(key) {
        let limit = SETTINGS_LIMITS[key];
        let rangeKey =
          SETTINGS_UNLIMITED_FIELDS.indexOf(key) >= 0
            ? "settings.budget.rangeUnlimited"
            : "settings.budget.range";
        return t(rangeKey)
          .replace("{default}", String(SETTINGS_DEFAULTS[key]))
          .replace("{min}", String(limit[0]))
          .replace("{max}", String(limit[1]));
      }

      /**
       * 数字输入 + 可选单位 + 可选帮助说明。
       * @param {string} key
       * @param {string} labelKey
       * @param {{ hint?: string, help?: string, unit?: string }} [options]
       * @returns {any}
       */
      function numberField(key, labelKey, options) {
        let opts = options === undefined ? {} : options;
        let limit = SETTINGS_LIMITS[key];
        let digits = SETTINGS_MONEY_FIELDS[key];
        let step = digits === 2 ? "0.01" : digits === 4 ? "0.001" : "1";
        let helpText = typeof opts.help === "string" ? opts.help : "";
        let hint = typeof opts.hint === "string" ? opts.hint : "";
        if (helpText === "" && hint === "") hint = rangeText(key);
        let control = h("input", {
          className: "dsh-advisor-input",
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
          inputMode: digits === undefined ? "numeric" : "decimal",
          step: step,
          type: "number",
          value: typeof texts[key] === "string" ? texts[key] : "",
        });
        let controls = [control];
        if (typeof opts.unit === "string" && opts.unit !== "") {
          controls.push(h("span", { className: "dsh-advisor-unit", key: "unit" }, opts.unit));
        }
        return fieldShell(key, labelKey, controls, {
          controlId: `dsh-advisor-${key}`,
          helpText: helpText,
          hint: hint,
          metaText: helpText === "" ? "" : rangeText(key),
        });
      }

      /** temperature：留空表示不传，可为小数。 @returns {any} */
      function temperatureField() {
        let control = h("input", {
          className: "dsh-advisor-input",
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
        });
        return fieldShell("temperature", "settings.advanced.temperature", [control], {
          controlId: "dsh-advisor-temperature",
          helpText: t("settings.advanced.temperatureHint"),
          metaText: t("settings.help.defaultNotSent"),
        });
      }

      /**
       * 开关一行。
       * @param {string} key
       * @param {string} labelKey
       * @param {{ hint?: string, help?: string, meta?: string }} [options]
       * @returns {any}
       */
      function switchField(key, labelKey, options) {
        let opts = options === undefined ? {} : options;
        let control = h("input", {
          checked: draft[key] === true,
          "data-advisor-switch": key,
          id: `dsh-advisor-${key}`,
          key: "input",
          onChange: function onSwitch(/** @type {any} */ event) {
            toggleFlag(key, event.target.checked === true);
          },
          type: "checkbox",
        });
        return fieldShell(key, labelKey, [control], {
          controlId: `dsh-advisor-${key}`,
          helpText: typeof opts.help === "string" ? opts.help : "",
          hint: typeof opts.hint === "string" ? opts.hint : "",
          metaText: typeof opts.meta === "string" ? opts.meta : "",
        });
      }

      /**
       * 下拉一行（枚举字段，如 mode / scope / postAnswer）。
       * @param {string} key
       * @param {string} labelKey
       * @param {string[]} values 合法取值；选项文案拼成 `${prefix}${value}`
       * @param {string} prefix
       * @param {string} current
       * @param {(value: string) => void} onPick
       * @param {{ hint?: string, help?: string, meta?: string }} [options]
       * @returns {any}
       */
      function selectField(key, labelKey, values, prefix, current, onPick, options) {
        let opts = options === undefined ? {} : options;
        let optionNodes = values.map(function renderOption(/** @type {string} */ value) {
          return h("option", { key: value, value: value }, t(prefix + value));
        });
        let control = h(
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
          optionNodes,
        );
        return fieldShell(key, labelKey, [control], {
          controlId: `dsh-advisor-${key}`,
          helpText: typeof opts.help === "string" ? opts.help : "",
          hint: typeof opts.hint === "string" ? opts.hint : "",
          metaText: typeof opts.meta === "string" ? opts.meta : "",
        });
      }

      /**
       * 白名单一行：逗号分隔文本；保存时才转成数组。
       * @returns {any}
       */
      function allowedModelsField() {
        let control = h("input", {
          className: "dsh-advisor-input",
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
        });
        return fieldShell("allowedModels", "settings.advanced.allowedModels", [control], {
          controlId: "dsh-advisor-allowedModels",
          helpText: t("settings.advanced.allowedModelsHint"),
          metaText: t("settings.help.defaultEmpty"),
        });
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
        let control = h(
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
        );
        return fieldShell("provider", "settings.provider", [control], {
          controlId: "dsh-advisor-provider",
          hint: routes.length === 0 ? t("settings.provider.none") : "",
        });
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
        let controls = h("div", { className: "dsh-advisor-controls", key: "controls" }, [
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
        ]);
        return fieldShell("model", "settings.model", [controls], {
          controlId: "dsh-advisor-model",
          hint: hint === "" ? t("settings.model.manualHint") : hint,
        });
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
        let control = h(
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
        );
        return fieldShell("effort", "settings.effort", [control], {
          controlId: "dsh-advisor-effort",
          hint: hint,
        });
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

      /**
       * 当前草稿是否有未保存改动。
       * @returns {boolean}
       */
      function isDirty() {
        if (snap === null || draft === null) return false;
        return Object.keys(diffSettings(snap.settings, draft)).length > 0;
      }

      /**
       * 数组按内容比较、浮点按 epsilon 比较；其余用严格相等。
       * @param {any} a
       * @param {any} b
       * @returns {boolean}
       */
      function valuesEqual(a, b) {
        if (Array.isArray(a) || Array.isArray(b)) {
          return normalizeStringList(a).join("\u0000") === normalizeStringList(b).join("\u0000");
        }
        if (a === null || a === undefined) return b === null || b === undefined;
        if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
        return a === b;
      }

      /** 高级区里与默认值不同的项数；用于折叠标题徽标。 @returns {number} */
      function advancedChangedCount() {
        if (draft === null) return 0;
        let count = 0;
        for (let index = 0; index < SETTINGS_ADVANCED_FIELDS.length; index += 1) {
          let key = SETTINGS_ADVANCED_FIELDS[index];
          if (valuesEqual(draft[key], SETTINGS_DEFAULTS[key]) === false) count += 1;
        }
        return count;
      }

      /** 恢复高级字段默认值；不动模式、路由、隐私这些基础字段。 */
      function resetAdvanced() {
        if (draft === null) return;
        let next = Object.assign({}, draft);
        for (let index = 0; index < SETTINGS_ADVANCED_FIELDS.length; index += 1) {
          let key = SETTINGS_ADVANCED_FIELDS[index];
          let fallback = SETTINGS_DEFAULTS[key];
          next[key] = Array.isArray(fallback) ? fallback.slice() : fallback;
        }
        setDraft(next);
        setTexts(textsOf(next));
        setError(null);
        setNotice(t("settings.advanced.resetDone"));
      }

      /** 复制设置文件路径；剪贴板不可用时只提示手动复制。 */
      function copySettingsPath() {
        let path = snap !== null && typeof snap.settingsPath === "string" ? snap.settingsPath : "";
        if (path === "") {
          setNotice(t("settings.advanced.pathUnknown"));
          return;
        }
        try {
          if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
          ) {
            navigator.clipboard.writeText(path).then(
              function onCopied() {
                setNotice(t("settings.advanced.copied"));
              },
              function onCopyFailed() {
                setNotice(t("settings.advanced.copyFailed"));
              },
            );
            return;
          }
        } catch (_error) {
          /* 落回手动复制提示 */
        }
        setNotice(t("settings.advanced.copyFailed"));
      }

      /**
       * 一个可折叠区块：高级设置、状态与诊断共用。
       * @param {string} key
       * @param {string} title
       * @param {string} badge
       * @param {any[]} children
       * @param {boolean} isOpen
       * @param {() => void} onToggle
       * @returns {any}
       */
      function disclosure(key, title, badge, children, isOpen, onToggle) {
        return h(
          "section",
          { className: "dsh-advisor-disclosure", "data-advisor-disclosure": key, key: key },
          [
            h(
              "button",
              {
                "aria-expanded": isOpen ? "true" : "false",
                className: "dsh-advisor-disclosure-toggle",
                "data-advisor-disclosure-toggle": key,
                key: "toggle",
                onClick: onToggle,
                type: "button",
              },
              [
                h("span", { className: "dsh-advisor-caret", key: "caret" }, isOpen ? "▾" : "▸"),
                h("span", { className: "dsh-advisor-disclosure-title", key: "title" }, title),
                badge === ""
                  ? null
                  : h("span", { className: "dsh-advisor-badge", key: "badge" }, badge),
              ],
            ),
            isOpen
              ? h("div", { className: "dsh-advisor-disclosure-body", key: "body" }, children)
              : null,
          ],
        );
      }

      /** off 时的紧凑卡片：只解释状态、给配置入口，不铺开任何设置。 @returns {any} */
      function offNotice() {
        let configured = draft.provider !== "" && draft.model !== "";
        let dirty = isDirty();
        return h("div", { className: "dsh-advisor-off", "data-advisor-off": "", key: "off" }, [
          h("div", { className: "dsh-advisor-off-title", key: "title" }, t("settings.off.title")),
          h(
            "div",
            { className: "dsh-advisor-note", key: "state" },
            configured
              ? t("settings.off.configured")
                  .replace("{provider}", draft.provider)
                  .replace("{model}", draft.model)
              : t("settings.off.unconfigured"),
          ),
          dirty
            ? h("div", { className: "dsh-advisor-dirty", key: "dirty" }, t("settings.dirty"))
            : null,
          h("div", { className: "dsh-advisor-actions", key: "actions" }, [
            h(
              "button",
              {
                className: "dsh-advisor-btn",
                "data-advisor-configure": "",
                key: "configure",
                onClick: function toggleOffForm() {
                  setOffExpanded(!offExpanded);
                },
                type: "button",
              },
              offExpanded ? t("settings.off.collapse") : t("settings.off.configure"),
            ),
          ]),
        ]);
      }

      /** 保存 / 重新加载 / 未保存提示。 @param {boolean} dirty @returns {any} */
      function actionBar(dirty) {
        return h("div", { className: "dsh-advisor-actions", key: "actions" }, [
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
          dirty
            ? h(
                "span",
                { className: "dsh-advisor-dirty", "data-advisor-dirty": "", key: "dirty" },
                t("settings.dirty"),
              )
            : null,
        ]);
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
        .replace("{cost}", `$${Number(snap.pool.costUsd).toFixed(4)}`);

      // 基础设置：只放开启前必须做的决定，以及每日预算与发送范围。
      let basicBody = [
        subgroup("settings.group.model", [providerField(), modelField(), effortField()], "model"),
        subgroup(
          "settings.group.spend",
          [
            numberField("maxCostPerDayUsd", "settings.budget.maxCostPerDayUsd", {
              hint: t("settings.basic.budgetHint"),
              unit: t("settings.unit.usd"),
            }),
          ],
          "spend",
        ),
        subgroup(
          "settings.group.privacy",
          [
            selectField(
              "scope",
              "settings.scope",
              SETTINGS_SCOPES,
              "settings.scope.",
              draft.privacyScope,
              chooseScope,
              { hint: t(`settings.scope.${draft.privacyScope}Hint`) },
            ),
            switchField("redact", "settings.privacy.redact", {
              hint: t("settings.privacy.redactHint"),
            }),
          ],
          "privacy",
        ),
      ];

      // 高级设置：调用限额、单价、生成参数、投递行为；默认折叠。
      let advancedBody = [
        h("div", { className: "dsh-advisor-note", key: "intro" }, t("settings.advanced.intro")),
        subgroup(
          "settings.group.limits",
          [
            h(
              "div",
              { className: "dsh-advisor-note", key: "dailyBudgetNote" },
              t("settings.advanced.dailyBudgetNote"),
            ),
            numberField("maxCallsPerTurn", "settings.budget.maxCallsPerTurn", {
              help: t("settings.help.calls"),
              unit: t("settings.unit.calls"),
            }),
            numberField("maxCallsPerSession", "settings.budget.maxCallsPerSession", {
              help: t("settings.help.calls"),
              unit: t("settings.unit.calls"),
            }),
            numberField("maxCallsPerHour", "settings.budget.maxCallsPerHour", {
              help: t("settings.help.calls"),
              unit: t("settings.unit.calls"),
            }),
            numberField("workspaceMaxCallsPerDay", "settings.budget.workspaceMaxCallsPerDay", {
              help: t("settings.budget.workspaceHint"),
              unit: t("settings.unit.calls"),
            }),
            numberField("workspaceMaxCostPerDayUsd", "settings.budget.workspaceMaxCostPerDayUsd", {
              help: t("settings.budget.workspaceHint"),
              unit: t("settings.unit.usd"),
            }),
            h(
              "div",
              { className: "dsh-advisor-readout", "data-advisor-pool": "", key: "pool" },
              poolLine,
            ),
          ],
          "limits",
        ),
        subgroup(
          "settings.group.money",
          [
            numberField("priceInputPerMTok", "settings.budget.priceInputPerMTok", {
              help: t("settings.budget.priceHint"),
              unit: t("settings.unit.usdPerMTok"),
            }),
            numberField("priceOutputPerMTok", "settings.budget.priceOutputPerMTok", {
              help: t("settings.budget.priceHint"),
              unit: t("settings.unit.usdPerMTok"),
            }),
            h("div", { className: "dsh-advisor-readout", key: "priceSource" }, priceSourceText),
          ],
          "money",
        ),
        subgroup(
          "settings.group.generation",
          [
            numberField("maxTokens", "settings.advanced.maxTokens", {
              help: t("settings.advanced.maxTokensHint"),
              unit: t("settings.unit.tokens"),
            }),
            temperatureField(),
            numberField("maxInputChars", "settings.advanced.maxInputChars", {
              help: t("settings.advanced.maxInputCharsHint"),
              unit: t("settings.unit.chars"),
            }),
          ],
          "generation",
        ),
        subgroup(
          "settings.group.delivery",
          [
            numberField("sessionCap", "settings.advanced.sessionCap", {
              help: t("settings.advanced.sessionCapHint"),
              unit: t("settings.unit.items"),
            }),
            allowedModelsField(),
            selectField(
              "postAnswer",
              "settings.postAnswer",
              SETTINGS_POST_ANSWER,
              "settings.postAnswer.",
              draft.postAnswer,
              choosePostAnswer,
              { help: t("settings.postAnswer.hint"), meta: t("settings.help.defaultOffOption") },
            ),
            switchField("advisorTools", "settings.advisorTools", {
              help: t("settings.advisorToolsHint"),
              meta: t("settings.help.defaultOff"),
            }),
            switchField("dedupe", "settings.privacy.dedupe", {
              help: t("settings.privacy.dedupeHint"),
              meta: t("settings.help.defaultOn"),
            }),
          ],
          "delivery",
        ),
        subgroup(
          "settings.group.more",
          [
            h("div", { className: "dsh-advisor-more", key: "more" }, [
              h(
                "p",
                { key: "text" },
                t("settings.advanced.more").replace("{fields}", t("settings.advanced.moreFields")),
              ),
              h(
                "p",
                { className: "dsh-advisor-path", key: "path" },
                snap.settingsPath === ""
                  ? t("settings.advanced.pathUnknown")
                  : t("settings.paths.settings").replace("{path}", snap.settingsPath),
              ),
              snap.settingsPath === ""
                ? null
                : h(
                    "button",
                    {
                      className: "dsh-advisor-btn",
                      "data-advisor-copy-path": "",
                      key: "copy",
                      onClick: copySettingsPath,
                      type: "button",
                    },
                    t("settings.advanced.copyPath"),
                  ),
            ]),
          ],
          "more",
        ),
        h("div", { className: "dsh-advisor-divider", key: "resetDivider" }),
        h("div", { className: "dsh-advisor-actions", key: "resetActions" }, [
          h(
            "button",
            {
              className: "dsh-advisor-btn",
              "data-advisor-reset": "",
              key: "reset",
              onClick: resetAdvanced,
              type: "button",
            },
            t("settings.advanced.reset"),
          ),
        ]),
        h(
          "div",
          { className: "dsh-advisor-note", key: "resetHint" },
          t("settings.advanced.resetHint"),
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

      let statusBody = [
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
        h("div", { className: "dsh-advisor-row", key: "doctorRow" }, [
          h("span", { className: "dsh-advisor-label", key: "label" }, t("settings.doctor")),
          h(
            "button",
            {
              className: "dsh-advisor-btn",
              "data-advisor-doctor-run": "",
              disabled: busy === "doctor",
              key: "run",
              onClick: runDoctor,
              type: "button",
            },
            busy === "doctor" ? t("settings.doctor.running") : t("settings.doctor.run"),
          ),
        ]),
        doctorNode,
        h("div", { className: "dsh-advisor-paths", key: "paths" }, [
          snap.settingsPath === ""
            ? null
            : h(
                "div",
                { key: "settingsPath" },
                t("settings.paths.settings").replace("{path}", snap.settingsPath),
              ),
          snap.ledgerPath === ""
            ? null
            : h(
                "div",
                { key: "ledgerPath" },
                t("settings.paths.ledger").replace("{path}", snap.ledgerPath),
              ),
        ]),
      ];

      let noticeNode =
        notice === ""
          ? null
          : h("div", { className: "dsh-advisor-saved", key: "notice", role: "status" }, notice);

      let advancedChanged = advancedChangedCount();
      let advancedBadge =
        advancedChanged === 0
          ? t("settings.advanced.defaults")
          : t("settings.advanced.changed").replace("{count}", String(advancedChanged));
      let modeRow = selectField(
        "mode",
        "settings.mode",
        SETTINGS_MODES,
        "settings.mode.",
        draft.mode,
        chooseMode,
        { hint: t(`settings.mode.${draft.mode}Hint`) },
      );
      let showForm = draft.mode !== "off" || offExpanded;
      let dirty = isDirty();

      let children = [
        h("div", { className: "dsh-advisor-head", key: "head" }, [
          h("div", { className: "dsh-advisor-title", key: "title" }, t("settings.title")),
          h("div", { className: "dsh-advisor-desc", key: "desc" }, t("settings.desc")),
        ]),
        errorBanner(),
        modeRow,
      ];
      if (!showForm) {
        children.push(offNotice());
      } else {
        if (draft.mode === "off") children.push(offNotice());
        children.push(group("settings.group.basic", basicBody, "basic"));
        children.push(
          disclosure(
            "advanced",
            t("settings.group.advanced"),
            advancedBadge,
            advancedBody,
            advancedOpen,
            function toggleAdvanced() {
              setAdvancedOpen(!advancedOpen);
            },
          ),
        );
        children.push(
          disclosure(
            "status",
            t("settings.group.status"),
            t("settings.status.calls").replace("{count}", formatCount(totals.calls)),
            statusBody,
            statusOpen,
            function toggleStatus() {
              setStatusOpen(!statusOpen);
            },
          ),
        );
      }
      children.push(noticeNode);
      children.push(actionBar(dirty));

      return h(
        "div",
        {
          "aria-label": t("settings.aria"),
          className: "dsh-advisor-settings",
          "data-advisor-settings": "",
          role: "group",
        },
        children,
      );
    }

    exports.inject = ["slots", "locale", "connection"];

    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      // 新增文案集中在这里合并进内嵌字典：locale/*.json 是「给人看的清单 + 宿主侧文案」，
      // 而 slot 的 t() 只认这里注册的字典。两处必须同步（`test/locale-parity.test.js` 会守住）。
      const LOCALE_EXTRA = {
        zh: {
          "settings.postAnswer": "回合结束后自动复查",
          "settings.postAnswer.off": "不跑",
          "settings.postAnswer.card": "只记录一行",
          "settings.postAnswer.hint":
            "每轮回答后自动复查一次；只记录建议，不插回对话。会产生额外调用和费用。",
          "settings.advisorTools": "允许顾问读文件核实",
          "settings.advisorToolsHint":
            "允许顾问读取工作目录里的文件来核实结论（最多 5 个、只读）；会多一次模型调用。",
          "settings.budget.workspaceMaxCallsPerDay": "工作区每日调用上限",
          "settings.budget.workspaceMaxCostPerDayUsd": "工作区每日预算",
          "settings.budget.workspaceHint": "工作区级，跨会话累计、按本地日重置",
          "settings.budget.poolLine": "工作区今日：{calls} 次 · ≈{cost}",
          "settings.budget.priceSource.builtin": "单价来源：内置参考价",
          "settings.budget.priceSource.settings": "单价来源：你设置的",
          "settings.budget.priceSource.none": "单价来源：未配置（只记 token）",
          "settings.advanced.allowedModels": "模型白名单",
          "settings.advanced.allowedModelsHint": "留空=不限制；可写 provider/model 或裸 model id",
          "settings.advanced.allowedModelsPlaceholder": "例如 deepseek/deepseek-chat, gpt-4o",
          "settings.preview": "发送预览",
          "settings.preview.run": "预览会发什么",
          "settings.preview.running": "预览中…",
          "settings.preview.title": "预览内容",
          "settings.preview.expand": "展开",
          "settings.preview.collapse": "收起",
          "settings.confirm": "跨 provider 发送",
          "settings.confirm.run": "确认跨 provider 发送",
          "settings.confirm.running": "确认中…",
          "settings.confirm.hint": "把当前 provider 加进确认名单；跨 provider 徵询不再中断。",
          "settings.confirm.done": "已确认 {provider}",
          "settings.error.preview": "预览失败，稍后重试",
          "settings.error.confirm": "确认失败，稍后重试",
          "settings.desc": "基础设置开箱即用；高级项默认折叠。保存后的改动对下一次徵询生效。",
          "settings.group.basic": "基础设置",
          "settings.group.budget": "预算与限额",
          "settings.group.advanced": "高级设置",
          "settings.mode.off": "关闭",
          "settings.mode.shadow": "影子",
          "settings.mode.advisory": "顾问",
          "settings.mode.shadowHint": "会调用顾问并记账，但不会把建议放进对话；适合先观察。",
          "settings.mode.advisoryHint": "会徵询顾问，并把建议交给模型；模型可以采纳或忽略。",
          "settings.provider": "服务商",
          "settings.model": "模型",
          "settings.budget.maxCallsPerTurn": "每回合调用上限",
          "settings.budget.maxCallsPerSession": "每会话调用上限",
          "settings.budget.maxCallsPerHour": "每小时调用上限",
          "settings.budget.maxCostPerDayUsd": "每日预算",
          "settings.budget.priceInputPerMTok": "输入单价",
          "settings.budget.priceOutputPerMTok": "输出单价",
          "settings.scope.off": "不发送",
          "settings.scope.summary": "摘要",
          "settings.scope.full": "完整",
          "settings.scope.summaryHint": "只发一段约 300 字的会话摘要，不发文件全文。",
          "settings.scope.fullHint": "发送完整上下文，按输入上限截断。",
          "settings.privacy.redact": "发送前脱敏",
          "settings.privacy.redactHint": "自动遮掉常见的密钥格式；不能保证全部遮住。",
          "settings.privacy.dedupe": "影子模式去重",
          "settings.privacy.dedupeHint": "影子模式下，相同的建议只记一次。",
          "settings.advanced.maxTokens": "输出上限",
          "settings.advanced.temperature": "随机性",
          "settings.advanced.temperatureHint": "留空 = 由模型决定；范围 0–2。",
          "settings.advanced.maxInputChars": "输入上限",
          "settings.advanced.sessionCap": "建议条数上限",
          "settings.off.title": "顾问已关闭",
          "settings.off.desc": "不会调用顾问，也不产生费用。",
          "settings.off.unconfigured": "还没有选择顾问模型。点「配置顾问」选择服务商和模型。",
          "settings.off.configured": "已配置：{provider} / {model}。启用后生效。",
          "settings.off.configure": "配置顾问",
          "settings.off.collapse": "收起配置",
          "settings.dirty": "有未保存的改动",
          "settings.advanced.intro": "以下都有合理默认值，通常不用改；改过的项会显示在标题上。",
          "settings.advanced.defaults": "默认值",
          "settings.advanced.changed": "{count} 项已修改",
          "settings.advanced.reset": "恢复默认",
          "settings.advanced.resetHint": "只重置高级字段，不影响模式、服务商、模型和隐私。",
          "settings.advanced.resetDone": "高级设置已恢复默认（尚未保存）。",
          "settings.advanced.more": "还有 {fields} 等冷门项；需要时可直接编辑设置文件。",
          "settings.advanced.moreFields": "tiers、pairingEnforcement、timeoutMs、immuneTurns",
          "settings.advanced.copyPath": "复制路径",
          "settings.advanced.copied": "已复制",
          "settings.advanced.copyFailed": "复制失败，请手动复制。",
          "settings.advanced.pathUnknown": "宿主没有返回设置文件路径。",
          "settings.advanced.dailyBudgetNote":
            "每日预算在基础设置里；这里是调用次数和工作区级限额。",
          "settings.group.model": "顾问模型",
          "settings.group.spend": "预算",
          "settings.group.limits": "调用限额",
          "settings.group.money": "单价",
          "settings.group.generation": "生成参数",
          "settings.group.delivery": "投递与行为",
          "settings.group.more": "更多",
          "settings.group.status": "状态与诊断",
          "settings.basic.budgetHint": "0 = 不限；默认 0，范围 0–10000。更细的限额在高级设置里。",
          "settings.budget.maxCostHint": "每天最多花多少钱；0 = 不限。只有填了单价才会计算金额。",
          "settings.advanced.maxTokensHint": "单次回答最多生成多少 token；越大越贵。",
          "settings.advanced.maxInputCharsHint":
            "一次最多发送多少字符的会话内容；超出会保留首尾、省略中间。",
          "settings.advanced.sessionCapHint": "一个会话最多展示几条建议；到顶后只保留 blocker 级。",
          "settings.help.calls": "超过上限就跳过本次徵询；0 = 不限。",
          "settings.help.tech": "技术名：{key}",
          "settings.help.open": "查看 {field} 的说明",
          "settings.help.defaultOn": "默认：开",
          "settings.help.defaultOff": "默认：关",
          "settings.help.defaultOffOption": "默认：不跑",
          "settings.help.defaultEmpty": "默认：不限制",
          "settings.help.defaultNotSent": "默认：不传（由模型决定）",
          "settings.unit.usd": "USD",
          "settings.unit.usdPerMTok": "USD / 百万 token",
          "settings.unit.tokens": "token",
          "settings.unit.chars": "字符",
          "settings.unit.calls": "次",
          "settings.unit.items": "条",
          "settings.paths.settings": "设置文件：{path}",
          "settings.paths.ledger": "账本：{path}",
        },
        en: {
          "settings.postAnswer": "Auto-review after each turn",
          "settings.postAnswer.off": "Do not run",
          "settings.postAnswer.card": "Record one line",
          "settings.postAnswer.hint":
            "Runs the advisor once after each answer; records advice only, never inserts it into the conversation. Costs an extra call.",
          "settings.advisorTools": "Let the advisor read files",
          "settings.advisorToolsHint":
            "Lets the advisor read files in the working directory to verify conclusions (up to 5 files, read-only); costs one extra model call.",
          "settings.budget.workspaceMaxCallsPerDay": "Workspace calls per day",
          "settings.budget.workspaceMaxCostPerDayUsd": "Workspace daily budget",
          "settings.budget.workspaceHint":
            "Workspace-wide: shared across sessions, resets on the local day",
          "settings.budget.poolLine": "Workspace today: {calls} calls · ≈{cost}",
          "settings.budget.priceSource.builtin": "Price source: built-in reference",
          "settings.budget.priceSource.settings": "Price source: yours",
          "settings.budget.priceSource.none": "Price source: not set (tokens only)",
          "settings.advanced.allowedModels": "Model allowlist",
          "settings.advanced.allowedModelsHint":
            "Empty = no limit; accepts provider/model or a bare model id",
          "settings.advanced.allowedModelsPlaceholder": "e.g. deepseek/deepseek-chat, gpt-4o",
          "settings.preview": "Send preview",
          "settings.preview.run": "Preview what will be sent",
          "settings.preview.running": "Previewing…",
          "settings.preview.title": "Preview",
          "settings.preview.expand": "Expand",
          "settings.preview.collapse": "Collapse",
          "settings.confirm": "Cross-provider send",
          "settings.confirm.run": "Confirm cross-provider send",
          "settings.confirm.running": "Confirming…",
          "settings.confirm.hint":
            "Add the current provider to the confirmed list so cross-provider consultations stop being interrupted.",
          "settings.confirm.done": "Confirmed {provider}",
          "settings.error.preview": "Preview failed — try again later",
          "settings.error.confirm": "Confirmation failed — try again later",
          "settings.desc":
            "The basics work out of the box; advanced knobs stay folded. Saved changes apply to the next consultation.",
          "settings.group.basic": "Basics",
          "settings.group.budget": "Budgets & limits",
          "settings.group.advanced": "Advanced",
          "settings.mode.off": "Off",
          "settings.mode.shadow": "Shadow",
          "settings.mode.advisory": "Advisory",
          "settings.mode.shadowHint":
            "Calls the advisor and records it, but never puts advice into the conversation — useful for observing first.",
          "settings.mode.advisoryHint":
            "Calls the advisor and hands the advice to the model; the model may take it or ignore it.",
          "settings.provider": "Provider",
          "settings.model": "Model",
          "settings.budget.maxCallsPerTurn": "Calls per turn",
          "settings.budget.maxCallsPerSession": "Calls per session",
          "settings.budget.maxCallsPerHour": "Calls per hour",
          "settings.budget.maxCostPerDayUsd": "Daily budget",
          "settings.budget.priceInputPerMTok": "Input price",
          "settings.budget.priceOutputPerMTok": "Output price",
          "settings.scope.off": "None",
          "settings.scope.summary": "Summary",
          "settings.scope.full": "Full",
          "settings.scope.summaryHint":
            "Sends a ~300-character conversation summary; no file contents.",
          "settings.scope.fullHint": "Sends the full context, truncated to the input limit.",
          "settings.privacy.redact": "Redact before sending",
          "settings.privacy.redactHint":
            "Masks common key formats; it cannot guarantee every secret is caught.",
          "settings.privacy.dedupe": "Dedupe in shadow mode",
          "settings.privacy.dedupeHint": "In shadow mode, the same advice is recorded only once.",
          "settings.advanced.maxTokens": "Output limit",
          "settings.advanced.temperature": "Randomness",
          "settings.advanced.temperatureHint": "Empty = let the model decide; range 0–2.",
          "settings.advanced.maxInputChars": "Input limit",
          "settings.advanced.sessionCap": "Advice items per session",
          "settings.off.title": "Advisor is off",
          "settings.off.desc": "It never calls the advisor and never spends.",
          "settings.off.unconfigured":
            "No advisor model selected yet. Choose “Configure advisor” to pick a provider and model.",
          "settings.off.configured": "Configured: {provider} / {model}. Takes effect when enabled.",
          "settings.off.configure": "Configure advisor",
          "settings.off.collapse": "Hide configuration",
          "settings.dirty": "Unsaved changes",
          "settings.advanced.intro":
            "Sensible defaults; you normally do not need to change these. Modified items show on the heading.",
          "settings.advanced.defaults": "Defaults",
          "settings.advanced.changed": "{count} changed",
          "settings.advanced.reset": "Reset to defaults",
          "settings.advanced.resetHint":
            "Only resets advanced fields; mode, provider, model and privacy stay.",
          "settings.advanced.resetDone": "Advanced settings restored to defaults (not saved yet).",
          "settings.advanced.more":
            "Rarely changed keys such as {fields} can be edited directly in the settings file.",
          "settings.advanced.moreFields": "tiers, pairingEnforcement, timeoutMs, immuneTurns",
          "settings.advanced.copyPath": "Copy path",
          "settings.advanced.copied": "Copied",
          "settings.advanced.copyFailed": "Copy failed — copy it manually.",
          "settings.advanced.pathUnknown": "The host did not return the settings file path.",
          "settings.advanced.dailyBudgetNote":
            "The daily budget is under Basics; this section has call and workspace-level limits.",
          "settings.group.model": "Advisor model",
          "settings.group.spend": "Budget",
          "settings.group.limits": "Call limits",
          "settings.group.money": "Prices",
          "settings.group.generation": "Generation",
          "settings.group.delivery": "Delivery & behavior",
          "settings.group.more": "More",
          "settings.group.status": "Status & diagnostics",
          "settings.basic.budgetHint":
            "0 = unlimited; default 0, range 0–10000. Finer limits are under Advanced.",
          "settings.budget.maxCostHint":
            "Maximum spend per day; 0 = unlimited. Only counted when prices are set.",
          "settings.advanced.maxTokensHint": "Maximum output tokens per answer; higher costs more.",
          "settings.advanced.maxInputCharsHint":
            "Maximum characters of conversation sent per call; excess in the middle is elided, head and tail kept.",
          "settings.advanced.sessionCapHint":
            "Maximum advice items shown per session; once reached only blocker items get through.",
          "settings.help.calls": "Above the limit, the consultation is skipped; 0 = unlimited.",
          "settings.help.tech": "Key: {key}",
          "settings.help.open": "Show help for {field}",
          "settings.help.defaultOn": "Default: on",
          "settings.help.defaultOff": "Default: off",
          "settings.help.defaultOffOption": "Default: off",
          "settings.help.defaultEmpty": "Default: no limit",
          "settings.help.defaultNotSent": "Default: not sent (model default)",
          "settings.unit.usd": "USD",
          "settings.unit.usdPerMTok": "USD / 1M tokens",
          "settings.unit.tokens": "tokens",
          "settings.unit.chars": "chars",
          "settings.unit.calls": "calls",
          "settings.unit.items": "items",
          "settings.paths.settings": "Settings file: {path}",
          "settings.paths.ledger": "Ledger: {path}",
        },
      };

      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: Object.assign({}, zh, LOCALE_EXTRA.zh),
            en: Object.assign({}, en, LOCALE_EXTRA.en),
          }),
        "advisor: dictionaries",
      );

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
      /** @param {string} sessionId @param {boolean} [force] */
      function loadAdvice(sessionId, force) {
        if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve([]);
        if (force === true) adviceCache.delete(sessionId);
        let cached = adviceCache.get(sessionId);
        // 缓存带 TTL：影子/答后建议是在回合**结束之后**才落盘的，
        // 永远命中旧 Promise 会让顾问线永远不出现（真机踩过）。
        if (cached !== undefined) {
          if (Date.now() - cached.at < ADVICE_CACHE_TTL_MS) return cached.promise;
          adviceCache.delete(sessionId);
        }
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
        adviceCache.set(sessionId, { at: Date.now(), promise: pending });
        return pending;
      }

      /** 顾问线的 api：只有一个方法，失败已在 loadAdvice 里降级。 */
      let tailApi = {
        advice: (/** @type {string} */ sessionId, /** @type {boolean} [force] */ force) =>
          loadAdvice(sessionId, force === true),
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
        clampMoney: clampMoney,
        formatMoneyInput: formatMoneyInput,
        normalizeSettingsView: normalizeSettingsView,
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
