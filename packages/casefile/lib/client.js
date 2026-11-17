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
      "panel.new": "新建项目",
      "panel.createTitle": "项目标题",
      "panel.createTarget": "目标（路径 / URL）",
      "panel.createKind": "目标类型",
      "panel.createAuth": "授权档",
      "panel.create": "创建",
      "panel.creating": "创建中…",
      "panel.cancel": "取消",
      "panel.refresh": "刷新",
      "panel.loading": "加载中…",
      "panel.error": "加载失败：{reason}",
      "panel.projects": "{count} 个项目",
      "panel.back": "返回列表",
      "tab.evidence": "证据",
      "tab.obligation": "义务",
      "tab.run": "运行",
      "tab.evidence.count": "证据 {evidence} · 结论 {claims} · 选中 {selected}",
      "tab.obligation.count": "开 {open} · 已关 {passed} · 未知 {unknowns}",
      "claims.title": "结论（每条带出处与局限）",
      "claims.empty": "还没有结论。用 case_claim 记录一条。",
      "claims.selected": "已选中",
      "claims.evidence": "证据 {count}",
      "claims.limits": "局限：{text}",
      "evidence.title": "证据",
      "evidence.empty": "还没有证据。用 case_evidence 记录一条。",
      "evidence.confidence": "{confidence} / {authority}",
      "obligation.title": "义务（关闭必须有新鲜 PASS 检查）",
      "obligation.empty": "还没有义务。用 case_obligation 加一条可验收的断言。",
      "obligation.open": "待关闭",
      "obligation.pass": "已关闭",
      "obligation.fail": "失败",
      "obligation.blocked": "阻塞",
      "obligation.unknown": "未知项",
      "obligation.unknownEmpty": "没有未解决的未知项。",
      "obligation.close": "关闭",
      "obligation.closing": "关闭中…",
      "obligation.blockedReason": "还不能关闭：缺新鲜 PASS 检查（checker 在 M2 落地）",
      "run.title": "构建与验收",
      "run.empty": "M2 才有 build / check 运行记录。现在只有证据与义务的静态账本。",
      "settings.section": "案卷",
      "settings.summary": "{count} 个项目",
      "settings.dataRoot": "数据根目录",
      "settings.rea": "REA 能力",
      "settings.reaMissing": "未检测到 mcp__rea__*（先接好 REA）",
      "settings.reaOk": "已连接（{count} 个工具）",
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
      "panel.new": "New project",
      "panel.createTitle": "Project title",
      "panel.createTarget": "Target (path / URL)",
      "panel.createKind": "Target kind",
      "panel.createAuth": "Authorization",
      "panel.create": "Create",
      "panel.creating": "Creating…",
      "panel.cancel": "Cancel",
      "panel.refresh": "Refresh",
      "panel.loading": "Loading…",
      "panel.error": "Failed to load: {reason}",
      "panel.projects": "{count} projects",
      "panel.back": "Back to list",
      "tab.evidence": "Evidence",
      "tab.obligation": "Obligations",
      "tab.run": "Runs",
      "tab.evidence.count": "{evidence} evidence · {claims} claims · {selected} selected",
      "tab.obligation.count": "{open} open · {passed} closed · {unknowns} unknowns",
      "claims.title": "Claims (each with provenance and limits)",
      "claims.empty": "No claims yet. Record one with case_claim.",
      "claims.selected": "selected",
      "claims.evidence": "evidence {count}",
      "claims.limits": "limits: {text}",
      "evidence.title": "Evidence",
      "evidence.empty": "No evidence yet. Record one with case_evidence.",
      "evidence.confidence": "{confidence} / {authority}",
      "obligation.title": "Obligations (closing needs a fresh PASS check)",
      "obligation.empty": "No obligations yet. Add a verifiable statement with case_obligation.",
      "obligation.open": "open",
      "obligation.pass": "closed",
      "obligation.fail": "failed",
      "obligation.blocked": "blocked",
      "obligation.unknown": "Unknowns",
      "obligation.unknownEmpty": "No open unknowns.",
      "obligation.close": "Close",
      "obligation.closing": "Closing…",
      "obligation.blockedReason": "Cannot close yet: no fresh PASS check (checkers land in M2)",
      "run.title": "Build & verification",
      "run.empty":
        "Run records arrive in M2. For now this is the static evidence/obligation ledger.",
      "settings.section": "Casefile",
      "settings.summary": "{count} projects",
      "settings.dataRoot": "Data root",
      "settings.rea": "REA capability",
      "settings.reaMissing": "No mcp__rea__* detected (connect REA first)",
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
            project.target ? `${project.target.kind} · ${project.target.ref}` : project.id,
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
            claim.status,
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
            `${item.confidence} / ${item.authority}`,
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
          h(Tag, { t: props.t }, obligation.authorityRequired),
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

      var create = () => {
        if (busy) return;
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
            return loadList().then(() => openProject(project.id));
          })
          .catch((/** @type {any} */ err) => {
            setError(err?.message ? err.message : String(err));
          })
          .finally(() => {
            setBusy(false);
          });
      };

      var closeObligation = useCallback(
        (/** @type {string} */ id) => {
          if (!detail) return Promise.resolve();
          return call(ctx, "closeObligation", { projectId: detail.project.id, obligationId: id })
            .then(() => openProject(detail.project.id))
            .catch((/** @type {any} */ err) => {
              setError(
                (err?.message ? err.message : String(err)) + (err?.hint ? ` — ${err.hint}` : ""),
              );
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
      var tabs;
      if (detail) {
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
              ? h(
                  "div",
                  { className: "cf-empty", "data-casefile-empty": "claims" },
                  text(t, "claims.empty"),
                )
              : claims.map((/** @type {any} */ claim) =>
                  h(ClaimCard, { key: claim.id, t: t, claim: claim }),
                ),
            h("h3", { style: { fontSize: 13, margin: "16px 0 8px" } }, text(t, "evidence.title")),
            evidence.length === 0
              ? h(
                  "div",
                  { className: "cf-empty", "data-casefile-empty": "evidence" },
                  text(t, "evidence.empty"),
                )
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
              ? h(
                  "div",
                  { className: "cf-empty", "data-casefile-empty": "obligations" },
                  text(t, "obligation.empty"),
                )
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
          content = h(
            "div",
            { className: "cf-empty", "data-casefile-empty": "runs" },
            text(t, "run.empty"),
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
              h(Tag, { t: t }, detail.project.target ? detail.project.target.kind : "other"),
              h(Tag, { t: t, tone: "warn" }, text(t, `auth.${detail.project.authTier}`)),
              h(Tag, { t: t }, detail.project.scope === "selected" ? "selected" : "all"),
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
              ? h(
                  "div",
                  { className: "cf-empty", "data-casefile-empty": "projects" },
                  text(t, "panel.empty"),
                )
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
              h("input", {
                className: "cf-input",
                placeholder: text(t, "panel.createTitle"),
                value: title,
                onInput: (/** @type {any} */ event) => {
                  setTitle(event.target.value);
                },
              }),
              h("input", {
                className: "cf-input",
                placeholder: text(t, "panel.createTarget"),
                value: target,
                onInput: (/** @type {any} */ event) => {
                  setTarget(event.target.value);
                },
              }),
              h(
                "select",
                {
                  className: "cf-select",
                  value: kind,
                  onChange: (/** @type {any} */ event) => {
                    setKind(event.target.value);
                  },
                },
                ["binary", "web", "app", "game", "artifact", "other"].map((item) =>
                  h("option", { key: item, value: item }, item),
                ),
              ),
              h(
                "select",
                {
                  className: "cf-select",
                  value: auth,
                  onChange: (/** @type {any} */ event) => {
                    setAuth(event.target.value);
                  },
                },
                ["owned", "authorized", "research"].map((item) =>
                  h("option", { key: item, value: item }, text(t, `auth.${item}`)),
                ),
              ),
              h(
                "button",
                {
                  className: "cf-btn cf-btn-primary",
                  "data-casefile-submit": "1",
                  disabled: busy || title.trim() === "",
                  onClick: create,
                },
                busy ? text(t, "panel.creating") : text(t, "panel.create"),
              ),
              h(
                "button",
                {
                  className: "cf-btn",
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
          h("span", null, diagnose.dataRoot || "—"),
        ),
        h(
          "div",
          { className: "cf-kv" },
          h("b", null, text(t, "settings.rea")),
          h(
            "span",
            { "data-casefile-rea": grade.level || "unknown" },
            grade.ok
              ? text(t, "settings.reaOk", { count: rea.availableTools || 0 })
              : text(t, "settings.reaMissing"),
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
                order: 94,
                label: () => text(t, "settings.section"),
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              CasefileSettings,
            ),
          ),
        "casefile: settings section",
      );
    };

    return module.exports;
  },
});
