// @ts-check
// client 半：classic script，以 __ModuleLoader__.load 注册 factory，不能使用 import。
// 注册面（M1）：主面板（main keyed）+ 侧栏入口（sidebar.panellist）+ 设置分节（settings.section）。
// 宿主调用走 ctx.connection.rpc.call("/api", "casefile/<method>", { args })——
// 无构建插件没有 typert 生成的客户端产物，不能用 ctx.reflect.get("remote.xxx")。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-casefile",
  factory(require) {
    var module = { exports: /** @type {any} */ ({}) };
    var exports = module.exports;

    /** @type {any} */
    var React = require("react");
    var h = React.createElement;
    var useEffect = React.useEffect;
    var useState = React.useState;
    var useCallback = React.useCallback;

    var NS = "casefile";
    var PANEL_ID = "casefile";

    // 运行时字典：无构建插件没有 typert 产物，必须在代码里注册（locale/*.json 只供插件管理器显示）。
    var ZH = {
      "panel.title": "案卷",
      "panel.subtitle": "证据 · 义务 · 运行",
      "panel.empty": "还没有项目。建一个，把目标、证据和结论收进来。",
      "panel.emptyTitle": "把调查过程留成可复查的案卷",
      "panel.emptyWhat":
        "案卷把一次逆向 / 审计调查里的观察、结论和验收条件记录在本机：每条结论带出处，每个义务要能复算。",
      "panel.emptyWho": "适合做安全研究、软件审计与取证的人；也适合让 AI 一边分析一边留证据。",
      "panel.emptyFirst":
        "第一步：点右上角「新建项目」，填一个目标（文件路径或网址）。之后在对话里让 AI 往里记证据和结论。",
      "panel.emptyTools":
        "在对话里可以直接调用：case_project（项目）、case_evidence（证据）、case_claim（结论）、case_obligation（义务）、case_build（构建）、case_check（检查）。REA 未接入时采集类工具不可用，但手工 / 让 AI 记录仍然可用。",
      "advanced.title": "给开发者 / AI 的说明",
      "panel.new": "新建项目",
      "panel.createTitle": "项目标题",
      "panel.createTitleLabel": "项目标题（必填）",
      "panel.createTarget": "目标（路径 / URL）",
      "panel.createKind": "对象类型",
      "panel.createAuth": "授权范围",
      "panel.titlePlaceholder": "例如：某 App 1.2 的登录流程",
      "panel.targetPlaceholder": "文件路径或网址（可留空，默认用标题）",
      "panel.titleRequired": "请填写项目标题（必填）。",
      "panel.createFailed": "创建失败：{reason}",
      "panel.create": "创建",
      "panel.creating": "创建中…",
      "panel.cancel": "取消",
      "kind.binary": "可执行文件",
      "kind.web": "网页 / URL",
      "kind.app": "应用包",
      "kind.game": "游戏",
      "kind.artifact": "产物文件",
      "kind.other": "其他",
      "scope.all": "全部范围",
      "scope.selected": "选定范围",
      "authOption.owned": "自有：自己的软件",
      "authOption.authorized": "已授权：有书面许可",
      "authOption.research": "研究：只分析，不重建",
      "checkStatus.pass": "通过",
      "checkStatus.fail": "失败",
      "checkStatus.running": "进行中",
      "checkStatus.error": "出错",
      "checkStatus.unknown": "无法判定",
      "confidence.observed": "实测",
      "confidence.derived": "推导",
      "confidence.inferred": "推断",
      "authority.shipped-artifact": "随包产物",
      "authority.controlled-replay": "受控复现",
      "authority.live-observation": "实测观察",
      "authority.external": "外部",
      "panel.refresh": "刷新",
      "panel.loading": "加载中…",
      "panel.error": "加载失败：{reason}",
      "panel.projects": "{count} 个项目",
      "panel.back": "返回列表",
      "trash.toggle": "回收站",
      "trash.title": "回收站（可恢复）",
      "trash.empty": "回收站是空的。",
      "trash.meta": "{id} · {files} 个文件 · {bytes}",
      "trash.restore": "恢复",
      "trash.back": "返回项目列表",
      "trash.purge": "清空回收站",
      "trash.purgePreview":
        "将硬删 {count} 个条目（{bytes}，不可恢复）；{skipped} 个来历不明的条目会保留。",
      "trash.purgeConfirm": "确认清空",
      "trash.cancel": "取消",
      "tab.evidence": "证据",
      "tab.obligation": "义务",
      "tab.run": "运行",
      "tab.evidence.count": "证据 {evidence} · 结论 {claims} · 选中 {selected}",
      "tab.obligation.count": "开 {open} · 已关 {passed} · 未知 {unknowns}",
      "claims.title": "结论（每条带出处与局限）",
      "claims.empty": "还没有结论。结论是这次调查里能引用的一句话，需要有证据支撑。",
      "claims.emptyHint": "在对话里让 AI 调 case_claim add 记录一条；参数见工具说明。",
      "claims.selected": "已选中",
      "claims.evidence": "证据 {count}",
      "claims.limits": "局限：{text}",
      "evidence.title": "证据",
      "evidence.empty":
        "还没有证据。证据是一条带出处的观察，例如「登录请求里带了一个硬编码的 key」。",
      "evidence.emptyHint":
        "在对话里让 AI 调 case_evidence add 记录一条；REA 接通后也可以直接摄入 REA 的产出。",
      "evidence.confidence": "{confidence} / {authority}",
      "obligation.title": "义务（关闭必须有新鲜 PASS 检查）",
      "obligation.empty":
        "还没有义务。义务是一条可验收的断言，例如「登录页有两个输入框」；关闭前必须有一条新的通过检查。",
      "obligation.emptyHint":
        "在对话里让 AI 调 case_obligation add 加一条，再用 case_check run 跑检查。",
      "obligation.open": "待关闭",
      "obligation.pass": "已关闭",
      "obligation.fail": "失败",
      "obligation.blocked": "阻塞",
      "obligation.unknown": "未知项",
      "obligation.unknownEmpty": "没有未解决的未知项。",
      "obligation.close": "关闭",
      "obligation.closing": "关闭中…",
      "obligation.blockedReason": "还不能关闭：缺新鲜 PASS 检查",
      "run.title": "构建与验收",
      "run.empty": "还没有构建记录。构建用于复算实现：跑一条命令，并记下它的摘要。",
      "run.emptyHint": "在对话里让 AI 调 case_build start 起一轮构建。",
      "run.builds": "构建轮次",
      "run.checks": "检查结论",
      "run.round": "第 {round} 轮",
      "run.digest": "实现",
      "run.command": "命令",
      "run.noChecks": "还没有检查记录。",
      "blocker.noFreshCheck": "没有新鲜检查",
      "blocker.staleCheck": "检查已过期",
      "blocker.checkFail": "检查未通过",
      "blocker.checkUnknown": "检查无法判定",
      "blocker.implementationMismatch": "实现已变化",
      "blocker.ownerDigestMismatch": "原件已变化",
      "blocker.missingCheck": "缺少检查记录",
      "blocker.noObligations": "还没有义务",
      "blocker.noChecks": "还没有检查",
      "blocker.openObligations": "还有未关闭义务",
      "blocker.openUnknowns": "还有未解决未知项",
      "blocker.failedObligations": "有失败的义务",
      "blocker.blockedObligations": "有阻塞的义务",
      "blocker.coverageBelow": "覆盖率不足",
      "autonomy.label": "自主性",
      "autonomy.hint": "让 AI 自己反复尝试的权限等级；等级越高越自动，任何一次失败都会停下。",
      "autonomy.scale": "L0–L3：L3 = 无人值守，仅限「选定范围」且义务全带检查配方的项目",
      "danger.title": "危险操作",
      "danger.dropHint": "把整个项目移进本机回收站；可以恢复，不会硬删。",
      "danger.drop": "移入回收站…",
      "danger.dropPreview":
        "将把项目 {id}（{files} 个文件 / {bytes}）移进回收站；可以在「回收站」里恢复。",
      "danger.dropConfirm": "确认移入回收站",
      "danger.dropCancel": "取消",
      "danger.dropBusy": "移动中…",
      "wait.title": "案卷：等待登录",
      "wait.hint": "请在弹出的浏览器窗口里完成登录；就绪后会自动继续。",
      "wait.elapsed": "已等待 {seconds}s",
      "blocker.implementationChanged": "实现已变化",
      "blocker.originalChanged": "原件已变化",
      "blocker.checkStale": "检查已过期",
      "settings.section": "案卷",
      "settings.summary": "{count} 个项目",
      "settings.dataRoot": "数据根目录",
      "settings.rea": "REA 接入",
      "settings.reaMissing": "未接入（可选）",
      "settings.reaMissingHint":
        "不影响建项目和手工记录证据；要自动采集与分析，先注册 REA 的 MCP 服务器（见 README 的 Requirements）。",
      "settings.reaDetailMissing": "检测结果：本会话未发现 mcp__rea__* 工具。",
      "settings.reaDetailOk": "检测结果：找到 {count} 个 mcp__rea__* 工具。",
      "settings.reaOk": "已接入（{count} 个工具）",
      "settings.hint": "项目数据只在本机；规格包默认脱敏，但分享前请自己过一遍。",
      "nav.title": "案卷",
      "auth.owned": "自有",
      "auth.authorized": "已授权",
      "auth.research": "研究",
      "state.investigating": "调查中",
      "state.closed": "已关闭",
      "common.loading": "加载中…",
      "common.none": "—",
      "row.evidence": "证据 {count}",
      "row.claims": "结论 {count}",
      "row.obligations": "义务 {count}",
      "claims.limitsInline": "局限：{text}",
      "obligation.needsCheck": "需新鲜 PASS 检查",
      "obligation.status.pass": "已关闭",
      "obligation.status.open": "待关闭",
    };
    var EN = {
      "panel.title": "Casefile",
      "panel.subtitle": "Evidence · Obligations · Runs",
      "panel.empty": "No projects yet. Create one and collect targets, evidence, and claims.",
      "panel.emptyTitle": "Keep an investigation reviewable as a case file",
      "panel.emptyWhat":
        "A case file records the observations, claims and acceptance criteria of one investigation on this machine: every claim keeps its sources, every obligation must be recomputable.",
      "panel.emptyWho":
        "For people doing security research, software audit or forensics — and for letting the AI leave evidence as it works.",
      "panel.emptyFirst":
        "First step: click “New project” at the top right and enter a target (a file path or a URL). Then ask the AI to record evidence and claims as you go.",
      "panel.emptyTools":
        "In the chat you can call: case_project (projects), case_evidence (evidence), case_claim (claims), case_obligation (obligations), case_build (builds) and case_check (checks). Without REA the acquisition tools are unavailable, but manual / AI-recorded evidence still works.",
      "advanced.title": "For developers / the AI agent",
      "panel.new": "New project",
      "panel.createTitle": "Project title",
      "panel.createTitleLabel": "Project title (required)",
      "panel.createTarget": "Target (path / URL)",
      "panel.createKind": "Target kind",
      "panel.createAuth": "Authorization",
      "panel.titlePlaceholder": "e.g. the sign-in flow of App 1.2",
      "panel.targetPlaceholder": "File path or URL (optional; defaults to the title)",
      "panel.titleRequired": "Please enter a project title (required).",
      "panel.createFailed": "Create failed: {reason}",
      "panel.create": "Create",
      "panel.creating": "Creating…",
      "panel.cancel": "Cancel",
      "kind.binary": "Binary",
      "kind.web": "Web / URL",
      "kind.app": "App bundle",
      "kind.game": "Game",
      "kind.artifact": "Artifact",
      "kind.other": "Other",
      "scope.all": "All scope",
      "scope.selected": "Selected scope",
      "authOption.owned": "Owned: my own software",
      "authOption.authorized": "Authorized: written permission",
      "authOption.research": "Research: analyze only, no rebuild",
      "checkStatus.pass": "pass",
      "checkStatus.fail": "fail",
      "checkStatus.running": "running",
      "checkStatus.error": "error",
      "checkStatus.unknown": "unknown",
      "confidence.observed": "observed",
      "confidence.derived": "derived",
      "confidence.inferred": "inferred",
      "authority.shipped-artifact": "shipped artifact",
      "authority.controlled-replay": "controlled replay",
      "authority.live-observation": "live observation",
      "authority.external": "external",
      "panel.refresh": "Refresh",
      "panel.loading": "Loading…",
      "panel.error": "Failed to load: {reason}",
      "panel.projects": "{count} projects",
      "panel.back": "Back to list",
      "trash.toggle": "Trash",
      "trash.title": "Trash (restorable)",
      "trash.empty": "The trash is empty.",
      "trash.meta": "{id} · {files} files · {bytes}",
      "trash.restore": "Restore",
      "trash.back": "Back to projects",
      "trash.purge": "Empty trash",
      "trash.purgePreview":
        "Permanently deletes {count} entries ({bytes}); {skipped} unknown entries are kept.",
      "trash.purgeConfirm": "Empty it",
      "trash.cancel": "Cancel",
      "tab.evidence": "Evidence",
      "tab.obligation": "Obligations",
      "tab.run": "Runs",
      "tab.evidence.count": "{evidence} evidence · {claims} claims · {selected} selected",
      "tab.obligation.count": "{open} open · {passed} closed · {unknowns} unknowns",
      "claims.title": "Claims (each with provenance and limits)",
      "claims.empty":
        "No claims yet. A claim is one sentence you can cite from this investigation; it needs evidence behind it.",
      "claims.emptyHint":
        "Ask the AI to record one with case_claim add; see the tool description for arguments.",
      "claims.selected": "selected",
      "claims.evidence": "evidence {count}",
      "claims.limits": "limits: {text}",
      "evidence.title": "Evidence",
      "evidence.empty":
        "No evidence yet. Evidence is an observation with a source, e.g. “the sign-in request carries a hard-coded key”.",
      "evidence.emptyHint":
        "Ask the AI to record one with case_evidence add; once REA is connected you can also ingest REA output.",
      "evidence.confidence": "{confidence} / {authority}",
      "obligation.title": "Obligations (closing needs a fresh PASS check)",
      "obligation.empty":
        "No obligations yet. An obligation is a verifiable statement, e.g. “the sign-in page has two inputs”; closing it needs a new passing check.",
      "obligation.emptyHint":
        "Ask the AI to add one with case_obligation add, then run a check with case_check run.",
      "obligation.open": "open",
      "obligation.pass": "closed",
      "obligation.fail": "failed",
      "obligation.blocked": "blocked",
      "obligation.unknown": "Unknowns",
      "obligation.unknownEmpty": "No open unknowns.",
      "obligation.close": "Close",
      "obligation.closing": "Closing…",
      "obligation.blockedReason": "Cannot close yet: needs a fresh PASS check",
      "run.title": "Build & verification",
      "run.empty":
        "No builds yet. A build recomputes the implementation: run one command and record its summary.",
      "run.emptyHint": "Ask the AI to start one with case_build start.",
      "run.builds": "Build rounds",
      "run.checks": "Check verdicts",
      "run.round": "Round {round}",
      "run.digest": "implementation",
      "run.command": "command",
      "run.noChecks": "No checks recorded yet.",
      "blocker.noFreshCheck": "no fresh check",
      "blocker.staleCheck": "check is stale",
      "blocker.checkFail": "check failed",
      "blocker.checkUnknown": "check cannot judge",
      "blocker.implementationMismatch": "implementation changed",
      "blocker.ownerDigestMismatch": "original changed",
      "blocker.missingCheck": "no check recorded",
      "blocker.noObligations": "no obligations yet",
      "blocker.noChecks": "no checks yet",
      "blocker.openObligations": "obligations still open",
      "blocker.openUnknowns": "unresolved unknowns",
      "blocker.failedObligations": "failed obligations",
      "blocker.blockedObligations": "blocked obligations",
      "blocker.coverageBelow": "coverage below target",
      "autonomy.label": "Autonomy",
      "autonomy.hint":
        "How far the AI may retry on its own; higher levels are more automatic and any failure stops the run.",
      "autonomy.scale":
        "L0–L3; L3 = unattended, only for “selected scope” projects whose obligations all carry check recipes",
      "danger.title": "Danger zone",
      "danger.dropHint":
        "Move the whole project into this machine's trash; it stays restorable and is never hard-deleted.",
      "danger.drop": "Move to trash…",
      "danger.dropPreview":
        "This moves project {id} ({files} files / {bytes}) to the trash; you can restore it from “Trash”.",
      "danger.dropConfirm": "Move to trash",
      "danger.dropCancel": "Cancel",
      "danger.dropBusy": "Moving…",
      "wait.title": "Casefile: waiting for sign-in",
      "wait.hint":
        "Finish signing in in the browser window; it continues automatically once ready.",
      "wait.elapsed": "waiting {seconds}s",
      "blocker.implementationChanged": "implementation changed",
      "blocker.originalChanged": "original changed",
      "blocker.checkStale": "check is stale",
      "settings.section": "Casefile",
      "settings.summary": "{count} projects",
      "settings.dataRoot": "Data root",
      "settings.rea": "REA connection",
      "settings.reaMissing": "Not connected (optional)",
      "settings.reaMissingHint":
        "Creating projects and recording evidence by hand still works; for automatic acquisition and analysis, register REA's MCP server first (see Requirements in the README).",
      "settings.reaDetailMissing": "Detection: no mcp__rea__* tools in this session.",
      "settings.reaDetailOk": "Detection: {count} mcp__rea__* tools found.",
      "settings.reaOk": "Connected ({count} tools)",
      "settings.hint":
        "Project data stays local; spec packs are redacted by default but review them before sharing.",
      "nav.title": "Casefile",
      "auth.owned": "owned",
      "auth.authorized": "authorized",
      "auth.research": "research",
      "state.investigating": "investigating",
      "state.closed": "closed",
      "common.loading": "Loading…",
      "common.none": "—",
      "row.evidence": "{count} evidence",
      "row.claims": "{count} claims",
      "row.obligations": "{count} obligations",
      "claims.limitsInline": "limits: {text}",
      "obligation.needsCheck": "needs a fresh PASS check",
      "obligation.status.pass": "closed",
      "obligation.status.open": "open",
    };

    /**
     * 极简插值：{name} → vars[name]。
     * @param {any} t
     * @param {string} key
     * @param {Record<string, any>} [vars]
     * @returns {string}
     */
    function text(t, key, vars) {
      var raw = typeof t === "function" ? t(key) : key;
      if (!vars) return raw;
      return String(raw).replace(/\{(\w+)\}/g, (_, name) =>
        vars[name] === undefined || vars[name] === null ? "—" : String(vars[name]),
      );
    }

    /**
     * 字节数转短文本（回收站条目影响面用）。
     * @param {number} value
     * @returns {string}
     */
    function formatBytes(value) {
      var bytes = Number(value) || 0;
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    // 业务拒绝里的 blocker 令牌 → 文案 key（与 actions 产出的字符串一一对应）。
    var BLOCKER_KEYS = {
      "no-fresh-check": "blocker.noFreshCheck",
      "stale-check": "blocker.staleCheck",
      "check-fail": "blocker.checkFail",
      "check-unknown": "blocker.checkUnknown",
      "implementation-mismatch": "blocker.implementationMismatch",
      "owner-digest-mismatch": "blocker.ownerDigestMismatch",
      "missing-check": "blocker.missingCheck",
      "no-obligations": "blocker.noObligations",
      "no-checks": "blocker.noChecks",
      "stale-checks": "blocker.staleCheck",
      "open-obligations": "blocker.openObligations",
      "open-unknowns": "blocker.openUnknowns",
      "failed-obligations": "blocker.failedObligations",
      "blocked-obligations": "blocker.blockedObligations",
      "coverage-below": "blocker.coverageBelow",
      "implementation-changed": "blocker.implementationChanged",
      "original-changed": "blocker.originalChanged",
      "check-stale": "blocker.checkStale",
    };

    // 中英混排收敛：UI 里出现的枚举值（目标类型 / 范围 / 状态 / 可信度 / 权威性）
    // 按组查文案；未知值原样回退，绝不把新值悄悄吞掉。
    var VOCAB = {
      kind: ["binary", "web", "app", "game", "artifact", "other"],
      scope: ["all", "selected"],
      checkStatus: ["pass", "fail", "running", "error", "unknown"],
      confidence: ["observed", "derived", "inferred"],
      authority: ["shipped-artifact", "controlled-replay", "live-observation", "external"],
    };

    /**
     * @param {any} t
     * @param {string} group
     * @param {any} value
     * @returns {string}
     */
    function vocab(t, group, value) {
      var raw = value === undefined || value === null ? "" : String(value);
      var known = /** @type {Record<string, string[]>} */ (VOCAB)[group] || [];
      if (raw !== "" && known.indexOf(raw) >= 0) return text(t, group + "." + raw);
      return raw;
    }

    /**
     * 把宿主返回的错误变成人能读的一句话：去掉 `[code]` 前缀，
     * 把 `：a、b:2` 里的 blocker 令牌翻成文案。
     * @param {any} err
     * @param {any} t
     * @returns {string}
     */
    function humanizeError(err, t) {
      var message = err?.message ? String(err.message) : String(err);
      message = message.replace(/^\[[a-zA-Z]+\]\s*/, "");
      var colon = message.lastIndexOf("：");
      if (colon < 0) return message;
      var head = message.slice(0, colon);
      var parts = message
        .slice(colon + 1)
        .split("、")
        .map((/** @type {string} */ token) => {
          var bits = token.split(":");
          var key = /** @type {Record<string, string>} */ (BLOCKER_KEYS)[bits[0]];
          if (!key) return token;
          return bits[1] ? `${text(t, key)}（${bits[1]}）` : text(t, key);
        });
      return `${head}：${parts.join("；")}`;
    }

    /**
     * 调 casefile 的 Remote 方法。args 用「命名位置参数」。
     * @param {any} ctx
     * @param {string} method
     * @param {Record<string, any>} [args]
     * @returns {Promise<any>}
     */
    function call(ctx, method, args) {
      var rpc = ctx.connection?.rpc;
      if (!rpc || typeof rpc.call !== "function") {
        return Promise.reject(new Error("casefile: no connection to the host"));
      }
      return Promise.resolve(rpc.call("/api", `casefile/${method}`, { args: args || {} })).then(
        (/** @type {any} */ result) => {
          if (!result || typeof result !== "object") return result;
          var error;
          if (result.ok === false) {
            error = /** @type {any} */ (
              new Error(result.error?.message || "host rejected the call")
            );
            error.code = result.error?.code;
            error.hint = result.error?.hint;
            throw error;
          }
          return "value" in result ? result.value : result;
        },
      );
    }

    // ---------- 样式（只用宿主 token；明暗都跟随） ----------

    var CSS = [
      ".cf-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}",
      ".cf-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".cf-head h2{font-size:15px;margin:0;font-weight:600}",
      ".cf-sub{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".cf-grow{flex:1 1 auto;min-width:0}",
      ".cf-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}",
      ".cf-btn:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".cf-btn[disabled]{opacity:.5;cursor:not-allowed}",
      ".cf-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
      ".cf-body{display:flex;flex:1 1 auto;min-height:0}",
      ".cf-list{width:260px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}",
      ".cf-detail{flex:1 1 auto;min-width:0;overflow:auto;padding:12px 16px}",
      ".cf-row{display:flex;gap:8px;align-items:flex-start;padding:8px;border-radius:6px;cursor:pointer;min-width:0}",
      ".cf-row:hover{background:var(--dsw-alias-bg-layer-1)}",
      ".cf-row[data-active=true]{background:var(--dsw-alias-bg-layer-2)}",
      ".cf-row-text{min-width:0;flex:1 1 auto}",
      ".cf-row-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cf-row-meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px}",
      ".cf-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px}",
      ".cf-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 10px;font-size:12px;cursor:pointer;border-bottom:2px solid transparent}",
      ".cf-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}",
      ".cf-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}",
      ".cf-card-title{font-weight:500;margin-bottom:4px;word-break:break-word}",
      ".cf-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}",
      ".cf-tag{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".cf-tag[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".cf-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
      ".cf-tag[data-tone=err]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".cf-muted{color:var(--dsw-alias-label-secondary)}",
      ".cf-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}",
      ".cf-error{color:var(--dsw-alias-state-error-primary);padding:8px 0;word-break:break-word}",
      ".cf-form{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".cf-input,.cf-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font-size:12px;min-width:0}",
      ".cf-input{flex:1 1 180px}",
      ".cf-settings{padding:4px 0}",
      ".cf-kv{display:flex;gap:8px;padding:2px 0;font-size:12px}",
      ".cf-kv b{font-weight:500;flex:none;min-width:92px;color:var(--dsw-alias-label-secondary)}",
      ".cf-empty-guide{max-width:640px;margin:0 auto;padding:28px 20px;text-align:left;display:flex;flex-direction:column;gap:8px}",
      ".cf-empty-guide h3{font-size:15px;margin:0;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".cf-empty-guide p{margin:0;line-height:1.6;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".cf-empty-guide .cf-empty-step{color:var(--dsw-alias-label-primary)}",
      ".cf-advanced{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:left}",
      ".cf-advanced summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".cf-advanced-body{margin-top:4px;line-height:1.6;word-break:break-word}",
      ".cf-field{display:flex;flex-direction:column;gap:2px;flex:1 1 180px;min-width:0}",
      ".cf-field-label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".cf-field .cf-input,.cf-field .cf-select{width:100%;box-sizing:border-box}",
      ".cf-input[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}",
      ".cf-form-error{flex:1 1 100%;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}",
      ".cf-info{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55}",
      ".cf-info-title{font-weight:500}",
      ".cf-info[data-state=unavailable]{color:var(--dsw-alias-label-secondary)}",
      ".cf-danger{margin-top:20px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:10px}",
      ".cf-danger summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".cf-danger-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}",
    ].join("\n");

    /**
     * 注入样式（随组件挂载/卸载）。
     * @returns {any}
     */
    function StyleOnce() {
      useEffect(() => {
        var el = document.createElement("style");
        el.setAttribute("data-casefile-style", "1");
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => {
          if (el.parentNode) el.parentNode.removeChild(el);
        };
      }, []);
      return null;
    }

    // ---------- 小组件 ----------

    /** @param {{ t: any, children?: any, tone?: string }} props */
    function Tag(props) {
      return h(
        "span",
        { className: "cf-tag", "data-tone": props.tone || "neutral" },
        props.children,
      );
    }

    /**
     * 「高级 / 开发者」折叠：工具名与检测细节都收在这里，普通用户默认看不到。
     * @param {{ t: any, children?: any }} props
     */
    function AdvancedHint(props) {
      return h(
        "details",
        { className: "cf-advanced", "data-casefile-advanced": "1" },
        h("summary", null, text(props.t, "advanced.title")),
        h("div", { className: "cf-advanced-body" }, props.children),
      );
    }

    /**
     * 页签空态：人话在前，工具名收进高级折叠。
     * @param {{ t: any, kind: string, human: string, hint: string }} props
     */
    function EmptyHint(props) {
      return h(
        "div",
        { className: "cf-empty", "data-casefile-empty": props.kind },
        h("div", null, props.human),
        h(AdvancedHint, { t: props.t }, props.hint),
      );
    }

    /**
     * 项目列表空态：这是什么、适合谁、第一步做什么；工具名收进高级折叠。
     * @param {{ t: any }} props
     */
    function ProjectEmptyGuide(props) {
      var t = props.t;
      return h(
        "div",
        { className: "cf-empty", "data-casefile-empty": "projects" },
        h(
          "div",
          { className: "cf-empty-guide" },
          h("h3", null, text(t, "panel.emptyTitle")),
          h("p", null, text(t, "panel.emptyWhat")),
          h("p", null, text(t, "panel.emptyWho")),
          h("p", { className: "cf-empty-step" }, text(t, "panel.emptyFirst")),
          h(AdvancedHint, { t: t }, text(t, "panel.emptyTools")),
        ),
      );
    }

    /** @param {{ t: any, project: any, active: boolean, onClick: () => void }} props */
    function ProjectRow(props) {
      var project = props.project;
      return h(
        "div",
        {
          className: "cf-row",
          "data-casefile-project-row": project.id,
          "data-active": props.active ? "true" : "false",
          onClick: props.onClick,
          role: "button",
          tabIndex: 0,
        },
        h(
          "div",
          { className: "cf-row-text" },
          h("div", { className: "cf-row-title" }, project.title),
          h(
            "div",
            { className: "cf-row-meta" },
            project.target
              ? `${vocab(props.t, "kind", project.target.kind)} · ${project.target.ref}`
              : project.id,
          ),
          h(
            "div",
            { className: "cf-row-meta" },
            text(props.t, "row.evidence", { count: project.evidence }) +
              " · " +
              text(props.t, "row.claims", { count: project.claims }) +
              " · " +
              text(props.t, "row.obligations", { count: project.obligations || 0 }),
          ),
        ),
      );
    }

    /** @param {{ t: any, claim: any }} props */
    function ClaimCard(props) {
      var claim = props.claim;
      return h(
        "div",
        { className: "cf-card", "data-casefile-claim": claim.id },
        h("div", { className: "cf-card-title" }, claim.text),
        h(
          "div",
          { className: "cf-tags" },
          h(Tag, { t: props.t }, claim.kind),
          h(
            Tag,
            {
              t: props.t,
              tone:
                claim.status === "observed"
                  ? "ok"
                  : claim.status === "inferred"
                    ? "warn"
                    : "neutral",
            },
            vocab(props.t, "confidence", claim.status),
          ),
          claim.selected
            ? h(Tag, { t: props.t, tone: "ok" }, text(props.t, "claims.selected"))
            : null,
          h(
            Tag,
            { t: props.t },
            text(props.t, "claims.evidence", { count: (claim.evidenceIds || []).length }),
          ),
        ),
        (claim.limitations || []).length > 0
          ? h(
              "div",
              { className: "cf-muted", style: { marginTop: 6 } },
              text(props.t, "claims.limitsInline", { text: claim.limitations.join("; ") }),
            )
          : null,
      );
    }

    /** @param {{ t: any, item: any }} props */
    function EvidenceCard(props) {
      var item = props.item;
      return h(
        "div",
        { className: "cf-card", "data-casefile-evidence": item.id },
        h("div", { className: "cf-card-title" }, item.summary || item.id),
        h(
          "div",
          { className: "cf-tags" },
          h(Tag, { t: props.t }, item.kind),
          h(
            Tag,
            { t: props.t, tone: item.confidence === "observed" ? "ok" : "warn" },
            `${vocab(props.t, "confidence", item.confidence)} / ${vocab(
              props.t,
              "authority",
              item.authority,
            )}`,
          ),
        ),
        h(
          "div",
          { className: "cf-muted", style: { marginTop: 4, fontSize: 11 } },
          item.sourceTool || "unknown",
        ),
        (item.limitations || []).length > 0
          ? h(
              "div",
              { className: "cf-muted", style: { marginTop: 4 } },
              text(props.t, "claims.limitsInline", { text: item.limitations.join("; ") }),
            )
          : null,
      );
    }

    /** @param {{ t: any, obligation: any, onClose: (id: string) => Promise<any> }} props */
    function ObligationCard(props) {
      var obligation = props.obligation;
      var closing = useState(false);
      var isClosing = closing[0];
      var setClosing = closing[1];
      var canClose = obligation.status === "open";
      return h(
        "div",
        {
          className: "cf-card",
          "data-casefile-obligation": obligation.id,
          "data-status": obligation.status,
        },
        h("div", { className: "cf-card-title" }, obligation.statement),
        h(
          "div",
          { className: "cf-tags" },
          h(Tag, { t: props.t }, obligation.kind),
          h(
            Tag,
            {
              t: props.t,
              tone:
                obligation.status === "pass"
                  ? "ok"
                  : obligation.status === "fail"
                    ? "err"
                    : "neutral",
            },
            text(
              props.t,
              obligation.status === "pass" ? "obligation.status.pass" : "obligation.status.open",
            ),
          ),
          h(
            Tag,
            { t: props.t },
            obligation.authorityRequired
              ? vocab(props.t, "authority", obligation.authorityRequired)
              : "",
          ),
        ),
        h(
          "div",
          { style: { marginTop: 8, display: "flex", gap: 8, alignItems: "center" } },
          h(
            "button",
            {
              className: "cf-btn cf-btn-primary",
              "data-casefile-close": obligation.id,
              disabled: !canClose || isClosing,
              onClick: () => {
                setClosing(true);
                props.onClose(obligation.id).finally(() => {
                  setClosing(false);
                });
              },
            },
            isClosing ? text(props.t, "obligation.closing") : text(props.t, "obligation.close"),
          ),
          canClose
            ? h(
                "span",
                { className: "cf-muted", style: { fontSize: 11 } },
                text(props.t, "obligation.needsCheck"),
              )
            : null,
        ),
      );
    }

    /** @param {{ t: any, unknown: any }} props */
    function UnknownRow(props) {
      return h(
        "div",
        { className: "cf-kv", "data-casefile-unknown": props.unknown.id },
        h(
          Tag,
          { t: props.t, tone: props.unknown.severity === "high" ? "err" : "neutral" },
          props.unknown.severity,
        ),
        h("span", null, props.unknown.text),
      );
    }

    /**
     * 等待登录横幅：轮询 host 的 accessState。
     * 只在"正在等"时出现，不阻塞任何操作——这是提醒，不是模态框。
     */
    /** @param {{ api: any, t: any }} props */
    function LoginWaitOverlay(props) {
      var ctx = props.api.ctx;
      var t = props.t;
      var state = useState(null);
      var wait = state[0];
      var setWait = state[1];
      var tickState = useState(0);
      var setTick = tickState[1];

      useEffect(() => {
        var alive = true;
        var poll = () => {
          call(ctx, "accessState")
            .then((value) => {
              if (alive) setWait(value && value.active === true ? value : null);
            })
            .catch(() => {
              if (alive) setWait(null);
            });
        };
        poll();
        var timer = setInterval(() => {
          poll();
          setTick((/** @type {number} */ n) => n + 1);
        }, 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [ctx]);

      var seconds = 0;
      var started = NaN;
      if (!wait) return null;
      if (typeof wait.startedAt === "string") {
        started = Date.parse(wait.startedAt);
        if (Number.isFinite(started))
          seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
      }
      return h(
        "div",
        {
          className: "cf-loginwait",
          "data-casefile-loginwait": wait.projectId || "1",
          "data-casefile-loginwait-seconds": String(seconds),
          style: {
            position: "fixed",
            right: 20,
            bottom: 20,
            zIndex: 40,
            maxWidth: 380,
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--dsw-alias-toast-bg)",
            color: "var(--dsw-alias-toast-label)",
            fontSize: 12,
            lineHeight: 1.55,
            boxShadow: "0 6px 24px rgba(0,0,0,.28)",
          },
        },
        h("div", { style: { fontWeight: 600, marginBottom: 2 } }, text(t, "wait.title")),
        h("div", null, wait.hint || text(t, "wait.hint")),
        h(
          "div",
          { style: { marginTop: 4, opacity: 0.72 } },
          text(t, "wait.elapsed", { seconds: seconds }),
        ),
      );
    }

    // ---------- 主面板 ----------

    /**
     * @param {{ api: any, t: any }} props
     */
    function CasefilePanel(props) {
      var ctx = props.api.ctx;
      var t = props.t;
      var projectsState = useState([]);
      var projects = projectsState[0];
      var setProjects = projectsState[1];
      var overviewState = useState(null);
      var overview = overviewState[0];
      var setOverview = overviewState[1];
      var detailState = useState(null);
      var detail = detailState[0];
      var setDetail = detailState[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var loadingState = useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var tabState = useState("evidence");
      var tab = tabState[0];
      var setTab = tabState[1];
      var formState = useState(false);
      var showForm = formState[0];
      var setShowForm = formState[1];
      var titleState = useState("");
      var title = titleState[0];
      var setTitle = titleState[1];
      var targetState = useState("");
      var target = targetState[0];
      var setTarget = targetState[1];
      var kindState = useState("binary");
      var kind = kindState[0];
      var setKind = kindState[1];
      var authState = useState("research");
      var auth = authState[0];
      var setAuth = authState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var showTrashState = useState(false);
      var showTrash = showTrashState[0];
      var setShowTrash = showTrashState[1];
      var trashState = useState(null);
      var trash = trashState[0];
      var setTrash = trashState[1];
      var trashBusyState = useState(false);
      var trashBusy = trashBusyState[0];
      var setTrashBusy = trashBusyState[1];
      var purgePreviewState = useState(null);
      var purgePreview = purgePreviewState[0];
      var setPurgePreview = purgePreviewState[1];
      // 新建表单：必填反馈（失焦或提交过才显示）+ 表单内错误（不顶掉全局错误）
      var titleTouchedState = useState(false);
      var titleTouched = titleTouchedState[0];
      var setTitleTouched = titleTouchedState[1];
      var submitAttemptedState = useState(false);
      var submitAttempted = submitAttemptedState[0];
      var setSubmitAttempted = submitAttemptedState[1];
      var formErrorState = useState("");
      var formError = formErrorState[0];
      var setFormError = formErrorState[1];
      // 危险操作：先 dry-run 拿影响面，再显式确认（ADR 0002）
      var dropPreviewState = useState(null);
      var dropPreview = dropPreviewState[0];
      var setDropPreview = dropPreviewState[1];
      var dropBusyState = useState(false);
      var dropBusy = dropBusyState[0];
      var setDropBusy = dropBusyState[1];

      var titleInvalid = (titleTouched || submitAttempted) && title.trim() === "";

      var loadList = useCallback(() => {
        setLoading(true);
        return Promise.all([call(ctx, "listProjects"), call(ctx, "overview").catch(() => null)])
          .then((values) => {
            setProjects(values[0] || []);
            setOverview(values[1] || null);
            setError("");
          })
          .catch((/** @type {any} */ err) => {
            setError(err?.message ? err.message : String(err));
          })
          .finally(() => {
            setLoading(false);
          });
      }, [ctx]);

      var openProject = useCallback(
        (/** @type {string} */ id) => {
          setLoading(true);
          return call(ctx, "projectDetail", { projectId: id })
            .then((value) => {
              setDetail(value);
              setDropPreview(null);
              setError("");
            })
            .catch((/** @type {any} */ err) => {
              setError(err?.message ? err.message : String(err));
            })
            .finally(() => {
              setLoading(false);
            });
        },
        [ctx],
      );

      useEffect(() => {
        loadList();
      }, [loadList]);

      // ---------- 回收站（ADR 0002：能查看 / 恢复 / 清空） ----------

      var loadTrash = useCallback(() => {
        setLoading(true);
        return call(ctx, "listTrash")
          .then((value) => {
            setTrash(value || []);
            setError("");
          })
          .catch((/** @type {any} */ err) => {
            setError(err?.message ? err.message : String(err));
          })
          .finally(() => {
            setLoading(false);
          });
      }, [ctx]);

      var openTrash = () => {
        setShowTrash(true);
        setDetail(null);
        setPurgePreview(null);
        loadTrash();
      };

      var closeTrash = () => {
        setShowTrash(false);
        setPurgePreview(null);
        setTrash(null);
      };

      var restoreEntry = (/** @type {string} */ name) => {
        if (trashBusy) return;
        setTrashBusy(true);
        call(ctx, "restoreTrashEntry", { name: name })
          .then(() => {
            setPurgePreview(null);
            return loadTrash();
          })
          .then(() => loadList())
          .catch((/** @type {any} */ err) => {
            setError(humanizeError(err, t));
          })
          .finally(() => {
            setTrashBusy(false);
          });
      };

      var previewPurge = () => {
        if (trashBusy) return;
        setTrashBusy(true);
        call(ctx, "purgeTrash", { options: { dryRun: true } })
          .then((value) => {
            setPurgePreview(value || null);
            setError("");
          })
          .catch((/** @type {any} */ err) => {
            setError(humanizeError(err, t));
          })
          .finally(() => {
            setTrashBusy(false);
          });
      };

      var confirmPurge = () => {
        if (trashBusy) return;
        setTrashBusy(true);
        call(ctx, "purgeTrash", { options: { confirm: true } })
          .then(() => {
            setPurgePreview(null);
            return loadTrash();
          })
          .catch((/** @type {any} */ err) => {
            setError(humanizeError(err, t));
          })
          .finally(() => {
            setTrashBusy(false);
          });
      };

      var create = () => {
        if (busy) return;
        // 必填校验失败必须有可见反馈（点「创建」不能像没反应）
        if (title.trim() === "") {
          setSubmitAttempted(true);
          return;
        }
        setFormError("");
        setBusy(true);
        call(ctx, "createProject", {
          input: {
            title: title,
            target: { kind: kind, ref: target || title },
            authTier: auth,
          },
        })
          .then((project) => {
            setShowForm(false);
            setTitle("");
            setTarget("");
            setTitleTouched(false);
            setSubmitAttempted(false);
            setFormError("");
            return loadList().then(() => openProject(project.id));
          })
          .catch((/** @type {any} */ err) => {
            setFormError(text(t, "panel.createFailed", { reason: humanizeError(err, t) }));
          })
          .finally(() => {
            setBusy(false);
          });
      };

      var previewDrop = () => {
        if (dropBusy || !detail) return;
        setDropBusy(true);
        call(ctx, "dropProject", { projectId: detail.project.id, options: { dryRun: true } })
          .then((value) => {
            setDropPreview(value || null);
            setError("");
          })
          .catch((/** @type {any} */ err) => {
            setError(humanizeError(err, t));
          })
          .finally(() => {
            setDropBusy(false);
          });
      };

      var confirmDrop = () => {
        if (dropBusy || !detail) return;
        setDropBusy(true);
        call(ctx, "dropProject", { projectId: detail.project.id, options: { confirm: true } })
          .then(() => {
            setDropPreview(null);
            setDetail(null);
            setShowTrash(true);
            setPurgePreview(null);
            return Promise.all([loadList(), loadTrash()]);
          })
          .catch((/** @type {any} */ err) => {
            setError(humanizeError(err, t));
          })
          .finally(() => {
            setDropBusy(false);
          });
      };

      var closeObligation = useCallback(
        (/** @type {string} */ id) => {
          if (!detail) return Promise.resolve();
          return call(ctx, "closeObligation", { projectId: detail.project.id, obligationId: id })
            .then(() => openProject(detail.project.id))
            .catch((/** @type {any} */ err) => {
              setError(humanizeError(err, t));
            });
        },
        [ctx, detail, openProject],
      );

      // 渲染期局部量统一声明在函数根（biome noInnerDeclarations）
      var body;
      var content;
      var stats;
      var claims;
      var evidence;
      var obligations;
      var unknowns;
      var openUnknowns;
      var builds;
      var checks;
      var tabs;
      if (showTrash) {
        body = h(
          "div",
          { className: "cf-body" },
          h(
            "div",
            { className: "cf-detail", "data-casefile-trash-view": "1" },
            h(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "baseline", marginBottom: 8 } },
              h("h3", { style: { fontSize: 14, margin: 0 } }, text(t, "trash.title")),
              h("span", { className: "cf-grow" }),
              h(
                "button",
                { className: "cf-btn", "data-casefile-trash-back": "1", onClick: closeTrash },
                text(t, "trash.back"),
              ),
            ),
            (trash || []).length === 0
              ? h(
                  "div",
                  { className: "cf-empty", "data-casefile-trash-empty": "1" },
                  text(t, "trash.empty"),
                )
              : h(
                  "div",
                  null,
                  (trash || []).map((/** @type {any} */ entry) =>
                    h(
                      "div",
                      {
                        key: entry.name,
                        className: "cf-card",
                        "data-casefile-trash-row": entry.name,
                      },
                      h(
                        "div",
                        { className: "cf-row-text" },
                        h("div", { className: "cf-card-title" }, entry.title || entry.projectId),
                        h(
                          "div",
                          { className: "cf-row-meta" },
                          text(t, "trash.meta", {
                            id: entry.projectId,
                            files: entry.files,
                            bytes: formatBytes(entry.bytes),
                          }),
                        ),
                      ),
                      h(
                        "button",
                        {
                          className: "cf-btn",
                          "data-casefile-trash-restore": entry.name,
                          disabled: trashBusy,
                          onClick: () => {
                            restoreEntry(entry.name);
                          },
                        },
                        text(t, "trash.restore"),
                      ),
                    ),
                  ),
                  purgePreview
                    ? h(
                        "div",
                        { className: "cf-card", "data-casefile-trash-purge-preview": "1" },
                        h(
                          "div",
                          null,
                          text(t, "trash.purgePreview", {
                            count: purgePreview.count ?? 0,
                            bytes: formatBytes(purgePreview.bytes),
                            skipped: purgePreview.skipped ?? 0,
                          }),
                        ),
                        h(
                          "button",
                          {
                            className: "cf-btn cf-btn-primary",
                            "data-casefile-trash-purge-confirm": "1",
                            disabled: trashBusy,
                            onClick: confirmPurge,
                          },
                          text(t, "trash.purgeConfirm"),
                        ),
                        h(
                          "button",
                          {
                            className: "cf-btn",
                            disabled: trashBusy,
                            onClick: () => {
                              setPurgePreview(null);
                            },
                          },
                          text(t, "trash.cancel"),
                        ),
                      )
                    : h(
                        "button",
                        {
                          className: "cf-btn",
                          "data-casefile-trash-purge": "1",
                          disabled: trashBusy,
                          onClick: previewPurge,
                        },
                        text(t, "trash.purge"),
                      ),
                ),
          ),
        );
      } else if (detail) {
        stats = detail.stats || {};
        claims = detail.claims || [];
        evidence = detail.evidence || [];
        obligations = detail.obligations || [];
        unknowns = detail.unknowns || [];
        openUnknowns = unknowns.filter((/** @type {any} */ item) => item.status !== "resolved");
        tabs = [
          ["evidence", text(t, "tab.evidence")],
          ["obligation", text(t, "tab.obligation")],
          ["run", text(t, "tab.run")],
        ];
        if (tab === "evidence") {
          content = h(
            "div",
            null,
            h(
              "div",
              { className: "cf-muted", style: { marginBottom: 8 } },
              text(t, "tab.evidence.count", {
                evidence: evidence.length,
                claims: claims.length,
                selected: stats.selectedClaims || 0,
              }),
            ),
            h("h3", { style: { fontSize: 13, margin: "12px 0 8px" } }, text(t, "claims.title")),
            claims.length === 0
              ? h(EmptyHint, {
                  t: t,
                  kind: "claims",
                  human: text(t, "claims.empty"),
                  hint: text(t, "claims.emptyHint"),
                })
              : claims.map((/** @type {any} */ claim) =>
                  h(ClaimCard, { key: claim.id, t: t, claim: claim }),
                ),
            h("h3", { style: { fontSize: 13, margin: "16px 0 8px" } }, text(t, "evidence.title")),
            evidence.length === 0
              ? h(EmptyHint, {
                  t: t,
                  kind: "evidence",
                  human: text(t, "evidence.empty"),
                  hint: text(t, "evidence.emptyHint"),
                })
              : evidence.map((/** @type {any} */ item) =>
                  h(EvidenceCard, { key: item.id, t: t, item: item }),
                ),
          );
        } else if (tab === "obligation") {
          content = h(
            "div",
            null,
            h(
              "div",
              { className: "cf-muted", style: { marginBottom: 8 } },
              text(t, "tab.obligation.count", {
                open: stats.openObligations || 0,
                passed: stats.passedObligations || 0,
                unknowns: openUnknowns.length,
              }),
            ),
            h("h3", { style: { fontSize: 13, margin: "12px 0 8px" } }, text(t, "obligation.title")),
            obligations.length === 0
              ? h(EmptyHint, {
                  t: t,
                  kind: "obligations",
                  human: text(t, "obligation.empty"),
                  hint: text(t, "obligation.emptyHint"),
                })
              : obligations.map((/** @type {any} */ item) =>
                  h(ObligationCard, {
                    key: item.id,
                    t: t,
                    obligation: item,
                    onClose: closeObligation,
                  }),
                ),
            h(
              "h3",
              { style: { fontSize: 13, margin: "16px 0 8px" } },
              text(t, "obligation.unknown"),
            ),
            openUnknowns.length === 0
              ? h(
                  "div",
                  { className: "cf-muted", "data-casefile-empty": "unknowns" },
                  text(t, "obligation.unknownEmpty"),
                )
              : openUnknowns.map((/** @type {any} */ item) =>
                  h(UnknownRow, { key: item.id, t: t, unknown: item }),
                ),
          );
        } else {
          builds = detail.builds || [];
          checks = detail.checks || [];
          content = h(
            "div",
            null,
            builds.length === 0
              ? null
              : h(
                  "div",
                  { className: "cf-muted", style: { marginBottom: 8 } },
                  `${text(t, "run.builds")} · ${builds.length}`,
                ),
            builds.length === 0
              ? h(EmptyHint, {
                  t: t,
                  kind: "runs",
                  human: text(t, "run.empty"),
                  hint: text(t, "run.emptyHint"),
                })
              : builds
                  .slice()
                  .sort(
                    (/** @type {any} */ a, /** @type {any} */ b) => (b.round || 0) - (a.round || 0),
                  )
                  .map((/** @type {any} */ build) =>
                    h(
                      "div",
                      { key: build.id, className: "cf-card", "data-casefile-build": build.id },
                      h(
                        "div",
                        {
                          style: {
                            display: "flex",
                            gap: 8,
                            alignItems: "baseline",
                            flexWrap: "wrap",
                          },
                        },
                        h(
                          Tag,
                          {
                            t: t,
                            tone:
                              build.status === "pass"
                                ? "ok"
                                : build.status === "fail"
                                  ? "err"
                                  : "warn",
                          },
                          vocab(t, "checkStatus", build.status),
                        ),
                        h("span", null, text(t, "run.round", { round: build.round })),
                        build.implementationDigest
                          ? h(
                              "span",
                              { className: "cf-muted", style: { fontSize: 11 } },
                              text(t, "run.digest") +
                                " " +
                                String(build.implementationDigest).slice(0, 12),
                            )
                          : null,
                      ),
                      h(
                        "div",
                        {
                          className: "cf-muted",
                          style: { fontSize: 11, marginTop: 4, wordBreak: "break-all" },
                        },
                        String(build.command || "").slice(0, 160),
                      ),
                    ),
                  ),
            h("h3", { style: { fontSize: 13, margin: "16px 0 8px" } }, text(t, "run.checks")),
            checks.length === 0
              ? h(
                  "div",
                  { className: "cf-muted", "data-casefile-empty": "checks" },
                  text(t, "run.noChecks"),
                )
              : checks
                  .slice()
                  .reverse()
                  .map((/** @type {any} */ check) =>
                    h(
                      "div",
                      { key: check.id, className: "cf-kv", "data-casefile-check": check.id },
                      h(
                        Tag,
                        {
                          t: t,
                          tone:
                            check.verdict === "pass"
                              ? "ok"
                              : check.verdict === "fail"
                                ? "err"
                                : "warn",
                        },
                        vocab(t, "checkStatus", check.verdict),
                      ),
                      h(
                        "span",
                        null,
                        (check.checker || "?") +
                          " · " +
                          String(check.implementationDigest || "—").slice(0, 12),
                      ),
                    ),
                  ),
          );
        }
        body = h(
          "div",
          { className: "cf-body" },
          h(
            "div",
            { className: "cf-list" },
            h(
              "button",
              {
                className: "cf-btn",
                style: { marginBottom: 8 },
                "data-casefile-back": "1",
                onClick: () => {
                  setDetail(null);
                },
              },
              text(t, "panel.back"),
            ),
            projects.map((/** @type {any} */ project) =>
              h(ProjectRow, {
                key: project.id,
                t: t,
                project: project,
                active: project.id === detail.project.id,
                onClick: () => {
                  openProject(project.id);
                },
              }),
            ),
          ),
          h(
            "div",
            { className: "cf-detail" },
            h(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 } },
              h("h3", { style: { fontSize: 14, margin: 0 } }, detail.project.title),
              h(
                Tag,
                { t: t },
                vocab(t, "kind", detail.project.target ? detail.project.target.kind : "other"),
              ),
              h(Tag, { t: t, tone: "warn" }, text(t, `auth.${detail.project.authTier}`)),
              h(Tag, { t: t }, vocab(t, "scope", detail.project.scope)),
            ),
            h(
              "div",
              {
                className: "cf-muted",
                style: { fontSize: 11, marginBottom: 10, wordBreak: "break-all" },
              },
              detail.project.target ? detail.project.target.ref : "",
            ),
            h(
              "div",
              { className: "cf-tabs" },
              tabs.map((/** @type {any[]} */ pair) =>
                h(
                  "button",
                  {
                    key: pair[0],
                    className: "cf-tab",
                    "data-casefile-tab": pair[0],
                    "data-active": tab === pair[0] ? "true" : "false",
                    onClick: () => {
                      setTab(pair[0]);
                    },
                  },
                  pair[1],
                ),
              ),
            ),
            content,
            h(
              "details",
              { className: "cf-danger", "data-casefile-danger": "1" },
              h("summary", null, text(t, "danger.title")),
              h(
                "p",
                { className: "cf-muted", style: { fontSize: 11, margin: "8px 0 0" } },
                text(t, "danger.dropHint"),
              ),
              dropPreview
                ? h(
                    "div",
                    {
                      className: "cf-card",
                      "data-casefile-drop-preview": "1",
                      style: { marginTop: 8 },
                    },
                    h(
                      "div",
                      null,
                      text(t, "danger.dropPreview", {
                        id: detail.project.id,
                        files: dropPreview.files ?? 0,
                        bytes: formatBytes(dropPreview.bytes),
                      }),
                    ),
                    h(
                      "div",
                      { className: "cf-danger-row" },
                      h(
                        "button",
                        {
                          className: "cf-btn cf-btn-primary",
                          "data-casefile-drop-confirm": "1",
                          disabled: dropBusy,
                          onClick: confirmDrop,
                        },
                        dropBusy ? text(t, "danger.dropBusy") : text(t, "danger.dropConfirm"),
                      ),
                      h(
                        "button",
                        {
                          className: "cf-btn",
                          "data-casefile-drop-cancel": "1",
                          disabled: dropBusy,
                          onClick: () => {
                            setDropPreview(null);
                          },
                        },
                        text(t, "danger.dropCancel"),
                      ),
                    ),
                  )
                : h(
                    "div",
                    { className: "cf-danger-row" },
                    h(
                      "button",
                      {
                        className: "cf-btn",
                        "data-casefile-drop": "1",
                        disabled: dropBusy,
                        onClick: previewDrop,
                      },
                      text(t, "danger.drop"),
                    ),
                  ),
            ),
          ),
        );
      } else {
        body = h(
          "div",
          { className: "cf-body" },
          h(
            "div",
            { className: "cf-detail" },
            overview?.summary
              ? h(
                  "div",
                  {
                    className: "cf-card",
                    "data-casefile-overview": "1",
                    style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" },
                  },
                  h("span", null, overview.summary),
                  Object.entries(overview.byKind || {})
                    .sort((a, b) => b[1] - a[1])
                    .map((entry) =>
                      h(
                        "span",
                        { key: entry[0], className: "cf-tag" },
                        `${entry[0]} × ${entry[1]}`,
                      ),
                    ),
                )
              : null,
            projects.length === 0
              ? h(ProjectEmptyGuide, { t: t })
              : h(
                  "div",
                  null,
                  projects.map((/** @type {any} */ project) =>
                    h(ProjectRow, {
                      key: project.id,
                      t: t,
                      project: project,
                      active: false,
                      onClick: () => {
                        openProject(project.id);
                      },
                    }),
                  ),
                ),
          ),
        );
      }

      return h(
        "div",
        { className: "cf-root", "data-casefile-page": "1" },
        h(StyleOnce, null),
        h(
          "div",
          { className: "cf-head" },
          h("h2", null, text(t, "panel.title")),
          h("span", { className: "cf-sub" }, text(t, "panel.subtitle")),
          h("span", { className: "cf-grow" }),
          h(
            "span",
            {
              className: "cf-muted",
              "data-casefile-autonomy": detail?.autonomy?.level || "L2",
              title: `${text(t, "autonomy.hint")}\n${text(t, "autonomy.scale")}`,
              style: { marginRight: 8 },
            },
            `${text(t, "autonomy.label")} ${detail?.autonomy?.level || "L2"}`,
          ),
          h(
            "button",
            {
              className: "cf-btn",
              "data-casefile-refresh": "1",
              onClick: loadList,
              disabled: loading,
            },
            text(t, "panel.refresh"),
          ),
          h(
            "button",
            {
              className: "cf-btn",
              "data-casefile-trash-toggle": "1",
              "data-active": showTrash ? "true" : "false",
              onClick: showTrash ? closeTrash : openTrash,
            },
            text(t, "trash.toggle"),
          ),
          h(
            "button",
            {
              className: "cf-btn cf-btn-primary",
              "data-casefile-new": "1",
              onClick: () => {
                setShowForm(!showForm);
              },
            },
            text(t, "panel.new"),
          ),
        ),
        showForm
          ? h(
              "div",
              { className: "cf-form", "data-casefile-create": "1" },
              h(
                "label",
                { className: "cf-field", "data-casefile-field": "title" },
                h("span", { className: "cf-field-label" }, text(t, "panel.createTitleLabel")),
                h("input", {
                  className: "cf-input",
                  "data-casefile-field-input": "title",
                  "data-invalid": titleInvalid ? "true" : "false",
                  "aria-label": text(t, "panel.createTitle"),
                  "aria-required": "true",
                  required: true,
                  disabled: busy,
                  placeholder: text(t, "panel.titlePlaceholder"),
                  value: title,
                  onInput: (/** @type {any} */ event) => {
                    setTitle(event.target.value);
                  },
                  onBlur: () => {
                    setTitleTouched(true);
                  },
                }),
              ),
              h(
                "label",
                { className: "cf-field", "data-casefile-field": "target" },
                h("span", { className: "cf-field-label" }, text(t, "panel.createTarget")),
                h("input", {
                  className: "cf-input",
                  "data-casefile-field-input": "target",
                  "aria-label": text(t, "panel.createTarget"),
                  disabled: busy,
                  placeholder: text(t, "panel.targetPlaceholder"),
                  value: target,
                  onInput: (/** @type {any} */ event) => {
                    setTarget(event.target.value);
                  },
                }),
              ),
              h(
                "label",
                { className: "cf-field", "data-casefile-field": "kind" },
                h("span", { className: "cf-field-label" }, text(t, "panel.createKind")),
                h(
                  "select",
                  {
                    className: "cf-select",
                    "data-casefile-field-input": "kind",
                    "aria-label": text(t, "panel.createKind"),
                    disabled: busy,
                    value: kind,
                    onChange: (/** @type {any} */ event) => {
                      setKind(event.target.value);
                    },
                  },
                  ["binary", "web", "app", "game", "artifact", "other"].map((item) =>
                    h("option", { key: item, value: item }, vocab(t, "kind", item)),
                  ),
                ),
              ),
              h(
                "label",
                { className: "cf-field", "data-casefile-field": "auth" },
                h("span", { className: "cf-field-label" }, text(t, "panel.createAuth")),
                h(
                  "select",
                  {
                    className: "cf-select",
                    "data-casefile-field-input": "auth",
                    "aria-label": text(t, "panel.createAuth"),
                    disabled: busy,
                    value: auth,
                    onChange: (/** @type {any} */ event) => {
                      setAuth(event.target.value);
                    },
                  },
                  ["owned", "authorized", "research"].map((item) =>
                    h("option", { key: item, value: item }, text(t, `authOption.${item}`)),
                  ),
                ),
              ),
              formError !== "" || titleInvalid
                ? h(
                    "div",
                    {
                      className: "cf-form-error",
                      role: "alert",
                      "data-casefile-create-error": "1",
                    },
                    formError !== "" ? formError : text(t, "panel.titleRequired"),
                  )
                : null,
              h(
                "button",
                {
                  className: "cf-btn cf-btn-primary",
                  "data-casefile-submit": "1",
                  disabled: busy,
                  onClick: create,
                },
                busy ? text(t, "panel.creating") : text(t, "panel.create"),
              ),
              h(
                "button",
                {
                  className: "cf-btn",
                  "data-casefile-cancel": "1",
                  disabled: busy,
                  onClick: () => {
                    setShowForm(false);
                  },
                },
                text(t, "panel.cancel"),
              ),
            )
          : null,
        error !== ""
          ? h("div", { className: "cf-error", "data-casefile-error": "1" }, error)
          : null,
        body,
      );
    }

    // ---------- 侧栏入口 ----------

    function CasefileIcon() {
      return h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true", role: "img" },
        h("path", {
          d: "M3 2.5h7l3 3v8H3z",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinejoin: "round",
        }),
        h("path", { d: "M10 2.5v3h3", fill: "none", stroke: "currentColor", strokeWidth: 1.2 }),
        h("path", {
          d: "M5 9h6M5 11h4",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
        }),
      );
    }

    // ---------- 设置分节 ----------

    /**
     * @param {{ api: any, t: any }} props
     */
    function CasefileSettings(props) {
      var ctx = props.api.ctx;
      var t = props.t;
      var state = useState(null);
      var info = state[0];
      var setInfo = state[1];
      var errorState = useState("");
      var error = errorState[0];
      var setError = errorState[1];

      useEffect(() => {
        Promise.all([call(ctx, "listProjects"), call(ctx, "diagnose")])
          .then((values) => {
            setInfo({ projects: values[0] || [], diagnose: values[1] || {} });
            setError("");
          })
          .catch((/** @type {any} */ err) => {
            setError(err?.message ? err.message : String(err));
          });
      }, [ctx]);

      if (error !== "") {
        return h(
          "div",
          { className: "cf-settings", "data-casefile-settings": "1" },
          h("div", { className: "cf-error" }, error),
        );
      }
      if (!info) {
        return h(
          "div",
          { className: "cf-settings", "data-casefile-settings": "1" },
          h("div", { className: "cf-muted" }, text(t, "settings.summary", { count: "—" })),
        );
      }
      var diagnose = info.diagnose || {};
      var grade = diagnose.grade || {};
      var rea = diagnose.rea || {};
      return h(
        "div",
        { className: "cf-settings", "data-casefile-settings": "1" },
        h(
          "div",
          { className: "cf-kv" },
          h("b", null, text(t, "settings.summary", { count: info.projects.length })),
        ),
        h(
          "div",
          { className: "cf-kv" },
          h("b", null, text(t, "settings.dataRoot")),
          h(
            "span",
            { style: { minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" } },
            diagnose.dataRoot || "—",
          ),
        ),
        h(
          "div",
          {
            className: "cf-info",
            "data-casefile-rea-notice": "1",
            "data-state": grade.ok ? "connected" : "unavailable",
          },
          h(
            "div",
            { className: "cf-info-title" },
            `${text(t, "settings.rea")} · `,
            h(
              "span",
              {
                "data-casefile-rea": grade.level || "unknown",
                "data-state": grade.ok ? "connected" : "unavailable",
              },
              grade.ok
                ? text(t, "settings.reaOk", { count: rea.availableTools || 0 })
                : text(t, "settings.reaMissing"),
            ),
          ),
          grade.ok
            ? null
            : h("div", { style: { marginTop: 2 } }, text(t, "settings.reaMissingHint")),
          h(
            AdvancedHint,
            { t: t },
            grade.ok
              ? text(t, "settings.reaDetailOk", { count: rea.availableTools || 0 })
              : text(t, "settings.reaDetailMissing"),
          ),
        ),
        h(
          "div",
          { className: "cf-muted", style: { marginTop: 6, fontSize: 11 } },
          text(t, "settings.hint"),
        ),
      );
    }

    exports.inject = ["slots", "locale", "connection"];
    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      var c = /** @type {any} */ (ctx);
      c.effect(() => c.locale.register(NS, { zh: ZH, en: EN }), "casefile: dictionaries");
      var t = c.locale.bind(NS);
      var api = { ctx: c, t: t };

      c.effect(
        () =>
          c.slots.inject("main", () =>
            c.slots.register(
              { name: "main", key: PANEL_ID, locale: NS, inject: () => ({ api: api, t: t }) },
              CasefilePanel,
            ),
          ),
        "casefile: main panel",
      );

      c.effect(
        () =>
          c.slots.inject("sidebar.panellist", () =>
            c.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 12,
                label: () => text(t, "nav.title"),
                locale: NS,
              },
              CasefileIcon,
            ),
          ),
        "casefile: nav entry",
      );

      c.effect(
        () =>
          c.slots.inject("settings.section", () =>
            c.slots.register(
              {
                name: "settings.section",
                id: PANEL_ID,
                order: 96,
                label: () => text(t, "settings.section"),
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              CasefileSettings,
            ),
          ),
        "casefile: settings section",
      );

      c.effect(
        () =>
          c.slots.inject("shell.overlay", () =>
            c.slots.register(
              { name: "shell.overlay", id: "casefile-loginwait", order: 880, locale: NS },
              function CasefileLoginWaitOverlay(/** @type {any} */ props) {
                return h(LoginWaitOverlay, Object.assign({}, props, { api: api, t: t }));
              },
            ),
          ),
        "casefile: login wait overlay",
      );
    };

    return module.exports;
  },
});
