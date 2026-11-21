// @ts-check
// client 半：classic script，以 __ModuleLoader__.load 注册 factory，不能使用 import。
// 注册面：侧栏全局面板入口（sidebar.panellist）+ 主面板（main keyed）+ 设置分节（settings.section）。
// 宿主调用走 ctx.connection.rpc.call("/api", "<service>/<method>", { args: {...} }) —— 无构建插件
// 没有 typert 生成的客户端产物，因此不能用 ctx.reflect.get("remote.xxx")
// （见 docs/runtime/0.2.1-rc.5.md §6.10）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-projects",
  factory(require) {
    var module = { exports: /** @type {any} */ ({}) };
    var exports = module.exports;

    /** @type {any} */
    var React = require("react");
    var h = React.createElement;
    var useEffect = React.useEffect;
    var useState = React.useState;
    var useCallback = React.useCallback;

    var NS = "projects";
    // 运行时字典：无构建插件没有 typert 产物，必须在代码里注册（locale/*.json 只供插件管理器显示）。
    var ZH = {
      title: "项目",
      "panel.title": "项目",
      "panel.summary": "{projects} 个项目 · {active} 个活跃 · {attached} 个会话已接入",
      "panel.empty": "还没有项目。建一个，把会话丢进去，下次就不用重复交代背景。",
      "panel.createPlaceholder": "项目名，例如 payments-api",
      "panel.create": "新建项目",
      "panel.creating": "正在新建…",
      "panel.refresh": "刷新",
      "panel.threads": "{count} 个线程",
      "panel.goalEmpty": "未设置目标",
      "panel.unavailable": "项目数据不可用：{reason}",
      "panel.errorCreate": "新建失败：{reason}",
      "panel.state.active": "活跃",
      "panel.state.archived": "已归档",
      "settings.section": "项目",
      "settings.dataRoot": "数据根目录",
      "settings.summary": "{count} 个项目",
      "settings.diag": "诊断",
      "settings.unavailable": "不可用",
      "settings.hint": "项目元数据与内容文件都在本机；不会写任何远端仓库。",
      "menu.attach": "归属到项目…",
      "menu.loading": "加载中…",
      "menu.empty": "还没有项目，先在项目面板里建一个",
      "detail.back": "返回",
      "detail.loading": "加载中…",
      "detail.tab.threads": "线程 ({count})",
      "detail.tab.memory": "记忆",
      "detail.tab.audit": "审计",
      "detail.threadsEmpty":
        "还没有线程。在上面输入一个任务就能新建线程；也可以回到会话行，用「…」菜单把已有会话归属到本项目。",
      "detail.threadState": "状态：{state}",
      "detail.instructions": "常设规则（instructions.md）",
      "detail.memoryIndex": "记忆索引（MEMORY.md）",
      "detail.emptyFile": "（空）",
      "detail.auditEmpty": "还没有审计记录。",
      "detail.state.waiting-user": "待你处理",
      "detail.state.failed": "失败",
      "detail.state.working": "进行中",
      "detail.state.done": "已完成",
      "detail.state.idle": "空闲",
      "detail.threadPlaceholder": "给这个线程一个任务，回车即建",
      "detail.threadCreate": "新建线程",
      "detail.threadCreating": "正在建…",
      "detail.dirLabel": "项目目录",
      "detail.dirPlaceholder": "绝对路径；线程会在这里建 worktree",
      "detail.dirSave": "绑定",
      "detail.pause": "暂停项目",
      "detail.resume": "恢复项目",
      "detail.budget": "今日 {today} 个线程 · 进行中 {running}",
      "detail.delete": "删除项目",
      "detail.deleting": "正在删除…",
      "detail.deleteConfirm": "确认删除",
      "detail.deleteCancel": "取消",
      "detail.deleteDetails": "详情（路径与恢复位置）",
      "detail.deleteImpact": "{summary}",
      "notify.failed": "{count} 个线程失败",
      "notify.waiting": "{count} 个线程在等你",
      "detail.routePlaceholder": "按规则派活：输入一句话，由规则决定怎么做",
      "detail.routeDispatch": "按规则派活",
      "detail.routeBusy": "处理中…",
      "detail.routeDecision": "按 {by} → {action}",
      "detail.routeExecuted": "已执行",
      "detail.routeRejected": "被拦",
      "detail.routeAction.answer-inline": "直接回答",
      "detail.routeAction.propose": "给出方案",
      "detail.routeAction.new-thread": "新建线程",
      "detail.routeAction.reuse-thread": "复用现有线程",
      "detail.routeBy.rule": "按规则「{rule}」",
      "detail.routeBy.fallback": "按默认策略",
      "detail.routeOk": "{how}：{action}",
      "detail.routeBlocked":
        "{how}建议「{action}」，但当前自治等级（{level}）不允许自动执行，已拦下",
      "detail.routeBlockedHint": "可在设置里提高自治等级，或手动执行",
      "detail.approvalsTitle": "待你批准的动作",
      "detail.approve": "批准",
      "detail.reject": "拒绝",
      "settings.policyTitle": "项目策略（自治级别 / 人格 / 兜底）",
      "settings.noProjects": "还没有项目",
      "settings.autonomy": "自治级别",
      "settings.level.L0": "只观察",
      "settings.level.L1": "只提议（默认）",
      "settings.level.L2": "可代办",
      "settings.level.L3": "全权",
      "settings.persona": "人格（留空用默认）",
      "settings.fallback": "规则都不命中时允许模型兜底提议",
      "settings.dangerTitle": "危险动作开关（默认全关）",
      "settings.dangerHint": "打开任何一个开关都需要你明确同意；插件不会自行打开。",
      "settings.danger.forcePushOwnBranch.label": "允许强推自己的 dsh/ 分支",
      "settings.danger.forcePushOwnBranch.risk":
        "用 --force-with-lease 绑定期望 SHA；远端被他人动过、分支受保护、旧 SHA 未知时一律拒绝，并记旧 SHA 供恢复。",
      "settings.danger.pushProtectedBranch.label": "允许直推默认/保护分支",
      "settings.danger.pushProtectedBranch.risk":
        "需要先在项目策略里对该仓库 per-repo 授予；推前查 protection/rulesets，服务端要求 PR 时直接拒；每次审计，检测到多人协作会额外警告。",
      "settings.danger.autoMerge.label": "允许自动合并 PR",
      "settings.danger.autoMerge.risk":
        "合并不可逆（只能用 revert 回退）；仍受 diff 阈值与人工批准约束",
      "settings.danger.trashAuto.label": "允许自动归档/删除到回收站",
      "settings.danger.trashAuto.risk": "会把内容移入 trash/；可从 manifest 恢复，但不是零成本",
      "settings.danger.purgeAfterRetention.label": "允许保留期后清理回收站",
      "settings.danger.purgeAfterRetention.risk":
        "只处理已在回收站且超过保留期的条目；执行前生成清理清单；默认 dry-run，真删需显式确认。",
      "settings.danger.editProfile.label": "允许修改项目策略本身",
      "settings.danger.editProfile.risk": "协调器可能借此放宽自己的限制；风险最高",
      "detail.archive": "归档项目",
      "detail.unarchive": "取消归档",
      "detail.execute": "执行",
      "detail.executed": "已执行（结果见审计）",
      "detail.refused": "未执行：{reason}",
      "detail.configTitle": "高级设置（仓库授权 / 回收站）",
      "detail.grantsTitle": "仓库授权（直推保护分支用）",
      "detail.grantsEmpty": "尚未授权任何仓库；直推保护分支前必须在这里加 owner/repo",
      "detail.grantAdd": "添加",
      "detail.purgeTitle": "回收站清理",
      "detail.purgeHint":
        "只清理本项目回收站里**超过保留期**的条目；先预览，再确认。需要打开 purgeAfterRetention 开关。",
      "detail.purgePreview": "预览可清理项",
      "detail.trashTitle": "回收站（可恢复）",
      "detail.trashEmpty": "回收站是空的。删除项目会先放进这里，可以随时恢复。",
      "detail.trashRestore": "恢复",
      "detail.trashRestored": "已恢复「{name}」（{count} 个线程）",
      "detail.trashFailed": "恢复失败：{reason}",
      "detail.purgeConfirm": "确认清理 {count} 项",
      "detail.purgeNothing": "没有超过保留期的条目",
      "detail.purged": "已清理 {count} 项，清单已写入 trash/",
    };
    var EN = {
      title: "Projects",
      "panel.title": "Projects",
      "panel.summary": "{projects} projects · {active} active · {attached} sessions attached",
      "panel.empty":
        "No projects yet. Create one, drop sessions into it, and stop restating the background.",
      "panel.createPlaceholder": "Project name, e.g. payments-api",
      "panel.create": "New project",
      "panel.creating": "Creating…",
      "panel.refresh": "Refresh",
      "panel.threads": "{count} threads",
      "panel.goalEmpty": "No goal set",
      "panel.unavailable": "Project data unavailable: {reason}",
      "panel.errorCreate": "Create failed: {reason}",
      "panel.state.active": "active",
      "panel.state.archived": "archived",
      "settings.section": "Projects",
      "settings.dataRoot": "Data root",
      "settings.summary": "{count} projects",
      "settings.diag": "Diagnostics",
      "settings.unavailable": "Unavailable",
      "settings.hint":
        "Project metadata and content files stay local; no remote repository is written.",
      "menu.attach": "Add to project…",
      "menu.loading": "Loading…",
      "menu.empty": "No projects yet — create one in the Projects panel first",
      "detail.back": "Back",
      "detail.loading": "Loading…",
      "detail.tab.threads": "Threads ({count})",
      "detail.tab.memory": "Memory",
      "detail.tab.audit": "Audit",
      "detail.threadsEmpty":
        "No sessions belong to this project yet. Use “Add to project…” in a session's … menu.",
      "detail.threadState": "state: {state}",
      "detail.instructions": "Standing rules (instructions.md)",
      "detail.memoryIndex": "Memory index (MEMORY.md)",
      "detail.emptyFile": "(empty)",
      "detail.auditEmpty": "No audit entries yet.",
      "detail.state.waiting-user": "Waiting on you",
      "detail.state.failed": "Failed",
      "detail.state.working": "Working",
      "detail.state.done": "Done",
      "detail.state.idle": "Idle",
      "detail.threadPlaceholder": "Describe a task for a new thread (Enter to create)",
      "detail.threadCreate": "New thread",
      "detail.threadCreating": "Creating…",
      "detail.dirLabel": "Project dir",
      "detail.dirPlaceholder": "Absolute path; threads create worktrees here",
      "detail.dirSave": "Bind",
      "detail.pause": "Pause project",
      "detail.resume": "Resume project",
      "detail.budget": "{today} threads today · {running} running",
      "detail.delete": "Delete project",
      "detail.deleting": "Deleting…",
      "detail.deleteConfirm": "Delete",
      "detail.deleteCancel": "Cancel",
      "detail.deleteDetails": "Details (path and restore location)",
      "detail.deleteImpact": "{summary}",
      "notify.failed": "{count} threads failed",
      "notify.waiting": "{count} threads waiting on you",
      "detail.routePlaceholder": "Dispatch by rule: describe the task and let rules decide",
      "detail.routeDispatch": "Dispatch by rule",
      "detail.routeBusy": "Working…",
      "detail.routeDecision": "by {by} → {action}",
      "detail.routeExecuted": "executed",
      "detail.routeRejected": "blocked",
      "detail.routeAction.answer-inline": "answer inline",
      "detail.routeAction.propose": "propose a plan",
      "detail.routeAction.new-thread": "start a new thread",
      "detail.routeAction.reuse-thread": "reuse an existing thread",
      "detail.routeBy.rule": "rule “{rule}”",
      "detail.routeBy.fallback": "the default policy",
      "detail.routeOk": "{how}: {action}",
      "detail.routeBlocked":
        "{how} suggests “{action}”, but autonomy level {level} does not allow it to run automatically — stopped",
      "detail.routeBlockedHint": "raise the autonomy level in settings, or run it yourself",
      "detail.approvalsTitle": "Actions waiting for your approval",
      "detail.approve": "Approve",
      "detail.reject": "Reject",
      "settings.policyTitle": "Project policy (autonomy / persona / fallback)",
      "settings.noProjects": "No projects yet",
      "settings.autonomy": "Autonomy",
      "settings.level.L0": "observe only",
      "settings.level.L1": "propose only (default)",
      "settings.level.L2": "may act",
      "settings.level.L3": "full",
      "settings.persona": "Persona (empty = built-in default)",
      "settings.fallback": "Allow the model to propose when no rule matches",
      "settings.dangerTitle": "Danger switches (all off by default)",
      "settings.dangerHint":
        "Every switch needs your explicit consent; the plugin never turns one on by itself.",
      "settings.danger.forcePushOwnBranch.label": "Allow force-pushing your own dsh/ branches",
      "settings.danger.forcePushOwnBranch.risk":
        "Uses --force-with-lease bound to the expected SHA; refuses when the remote moved, the branch is protected, or the old SHA is unknown, and records the old SHA for recovery.",
      "settings.danger.pushProtectedBranch.label":
        "Allow pushing directly to default/protected branches",
      "settings.danger.pushProtectedBranch.risk":
        "Requires a per-repo grant in the project policy; checks protection/rulesets first and refuses when the server requires a PR; every push is audited and multi-collaborator repos raise a warning.",
      "settings.danger.autoMerge.label": "auto-merge PRs",
      "settings.danger.autoMerge.risk":
        "merging is irreversible (revert only); still gated by diff limits and human approval",
      "settings.danger.trashAuto.label": "auto archive/delete into trash",
      "settings.danger.trashAuto.risk":
        "moves content into trash/; restorable from manifest, but not free",
      "settings.danger.purgeAfterRetention.label":
        "Allow purging the trash after the retention period",
      "settings.danger.purgeAfterRetention.risk":
        "Only touches entries already in the trash that exceed the retention period; writes a purge manifest first; dry-run by default, real deletion needs explicit confirmation.",
      "settings.danger.editProfile.label": "edit project policy itself",
      "settings.danger.editProfile.risk":
        "the coordinator could loosen its own limits; highest risk",
      "detail.archive": "Archive project",
      "detail.unarchive": "Unarchive project",
      "detail.execute": "Execute",
      "detail.executed": "Executed (see audit)",
      "detail.refused": "Not executed: {reason}",
      "detail.grantsTitle": "Repository grants (for pushing protected branches)",
      "detail.grantsEmpty":
        "No repository granted yet; add owner/repo before pushing a protected branch",
      "detail.grantAdd": "Add",
      "detail.purgeTitle": "Trash purge",
      "detail.purgeHint":
        "Only purges entries in this project's trash that are **past the retention period**; preview first, then confirm. Requires the purgeAfterRetention switch.",
      "detail.purgePreview": "Preview purgeable",
      "detail.trashTitle": "Trash (restorable)",
      "detail.trashEmpty": "Trash is empty. Deleted projects land here first and can be restored.",
      "detail.trashRestore": "Restore",
      "detail.trashRestored": "Restored “{name}” ({count} threads)",
      "detail.trashFailed": "Restore failed: {reason}",
      "detail.purgeConfirm": "Purge {count} entries",
      "detail.purgeNothing": "Nothing past the retention period",
      "detail.purged": "Purged {count} entries; manifest written under trash/",
    };
    var PANEL_ID = "projects";
    var SERVICE = "projects";

    /** 设计变量：全部取自宿主主题 token，前景/底色成对（plugin-conventions §2）。 */
    var T = {
      bg: "var(--dsw-alias-bg-base, Canvas)",
      text: "var(--dsw-alias-label-primary, CanvasText)",
      dim: "var(--dsw-alias-label-secondary, GrayText)",
      faint: "var(--dsw-alias-label-tertiary, GrayText)",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
      accent: "var(--dsw-alias-interactive-bg-hover-accent, rgba(59,130,246,0.16))",
      accentText: "var(--dsw-alias-label-primary-bluish, LinkText)",
      danger: "var(--dsw-alias-state-error-primary, #d9534f)",
    };

    /**
     * 把宿主的失败回执变成异常（保留 code，便于冒烟断言）。
     * @param {any} result
     * @returns {Error}
     */
    function hostError(result) {
      var error = /** @type {any} */ (
        new Error(result?.error?.message || "host rejected the call")
      );
      error.code = result?.error?.code;
      return error;
    }

    /**
     * 调宿主服务。方法签名是位置参数，走 Typert 网关时用**具名参数**（args 键名 = 形参名）。
     * @param {any} ctx
     * @param {string} method
     * @param {Record<string, unknown>} [args]
     */
    function call(ctx, method, args) {
      var rpc = ctx?.connection?.rpc;
      if (!rpc || typeof rpc.call !== "function") {
        return Promise.reject(new Error("projects: no connection to the host"));
      }
      return Promise.resolve(rpc.call("/api", `${SERVICE}/${method}`, { args: args || {} })).then(
        /** @param {any} result */
        (result) => {
          if (result && typeof result === "object" && result.ok === false) {
            throw hostError(result);
          }
          // 网关的一元回执把业务值放在 value 里（与 session-delete 同款解包）
          return result && typeof result === "object" && "value" in result ? result.value : result;
        },
      );
    }

    /** @param {any} t @param {string} key @param {Record<string, unknown>} [vars] */
    function text(t, key, vars) {
      var value = t(key);
      if (!vars || typeof value !== "string") return value;
      return value.replace(/\{(\w+)\}/gu, (match, name) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : match,
      );
    }

    var styles = {
      root: {
        padding: "16px",
        color: T.text,
        background: T.bg,
        height: "100%",
        overflow: "auto",
        fontSize: "13px",
      },
      header: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "4px" },
      title: { fontSize: "15px", fontWeight: 600 },
      summary: { color: T.dim, fontSize: "12px" },
      row: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 10px",
        borderTop: `1px solid ${T.border}`,
      },
      rowMain: {
        minWidth: 0,
        flex: "1 1 auto",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      },
      name: { fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      meta: {
        color: T.faint,
        fontSize: "12px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      input: {
        flex: "1 1 auto",
        minWidth: 0,
        padding: "6px 8px",
        borderRadius: "6px",
        border: `1px solid ${T.border}`,
        background: T.bg,
        color: T.text,
        fontSize: "13px",
      },
      button: {
        padding: "6px 12px",
        borderRadius: "6px",
        border: `1px solid ${T.border}`,
        background: T.hover,
        color: T.text,
        fontSize: "13px",
        cursor: "pointer",
      },
      error: { color: T.danger, fontSize: "12px", marginTop: "6px" },
      empty: { color: T.dim, marginTop: "12px", lineHeight: 1.6 },
      bar: { display: "flex", gap: "8px", marginTop: "12px", marginBottom: "12px" },
      list: { borderBottom: `1px solid ${T.border}` },
    };

    /**
     * 主面板：3 行摘要 + 项目列表 + 新建。
     * @param {{api: any, t: any}} props
     */
    function ProjectsPanel(props) {
      var api = props.api;
      var t = props.t;
      var state = useState({ loading: true, error: null, projects: [], describe: null });
      var view = state[0];
      var setView = state[1];
      var draft = useState("");
      var name = draft[0];
      var setName = draft[1];
      var busy = useState(false);
      var creating = busy[0];
      var setCreating = busy[1];

      var refresh = useCallback(() => {
        setView((/** @type {any} */ prev) => ({
          loading: true,
          error: prev.error,
          projects: prev.projects,
          describe: prev.describe,
        }));
        return Promise.all([call(api.ctx, "listProjects"), call(api.ctx, "describe")]).then(
          (values) => {
            setView({
              loading: false,
              error: null,
              projects: values[0] || [],
              describe: values[1] || null,
            });
          },
          (error) => {
            setView({
              loading: false,
              error: String(error?.message ?? error),
              projects: [],
              describe: null,
            });
          },
        );
      }, [api]);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      var create = useCallback(() => {
        var value = name.trim();
        if (value === "" || creating) return;
        setCreating(true);
        call(api.ctx, "createProject", { name: value })
          .then(() => {
            setName("");
            setCreating(false);
            return refresh();
          })
          .catch((error) => {
            setCreating(false);
            setView((/** @type {any} */ prev) => ({
              loading: false,
              error: text(t, "panel.errorCreate", {
                reason: String(error?.message ?? error),
              }),
              projects: prev.projects,
              describe: prev.describe,
            }));
          });
      }, [api, name, creating, refresh, t]);

      var selectedState = useState(null);
      var selectedId = selectedState[0];
      var setSelectedId = selectedState[1];
      var describe = view.describe;
      var projects = view.projects || [];
      var summaryText = describe
        ? text(t, "panel.summary", {
            projects: describe.projectCount,
            active: describe.activeCount,
            attached: describe.attachedSessions,
          })
        : "";

      return h(
        "section",
        {
          style: styles.root,
          "data-projects-panel": "",
          // 冒烟与排障用：把渲染状态挂成属性，断言不必猜 DOM 结构
          "data-projects-status": `${view.loading ? "loading" : "ready"}|${projects.length}|${
            view.error ? "error" : "ok"
          }|${describe ? describe.attachedSessions : "-"}`,
        },
        h(
          "header",
          { style: styles.header },
          h("span", { style: styles.title, "data-projects-title": "" }, text(t, "panel.title")),
          h("span", { style: styles.summary, "data-projects-summary": "" }, summaryText),
        ),
        h(
          "div",
          { style: styles.bar },
          h("input", {
            style: styles.input,
            value: name,
            placeholder: text(t, "panel.createPlaceholder"),
            "data-projects-create-input": "",
            onChange: (/** @type {any} */ event) => {
              setName(/** @type {any} */ (event.target).value);
            },
            onKeyDown: (/** @type {any} */ event) => {
              if (event.key === "Enter") create();
            },
            disabled: creating,
          }),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-create": "",
              onClick: create,
              disabled: creating,
            },
            creating ? text(t, "panel.creating") : text(t, "panel.create"),
          ),
        ),
        view.error
          ? h("div", { style: styles.error, "data-projects-error": "" }, view.error)
          : null,
        selectedId && projects.some((/** @type {any} */ p) => p.id === selectedId)
          ? h(ProjectDetail, {
              api: api,
              t: t,
              project: projects.find((/** @type {any} */ p) => p.id === selectedId),
              onBack: () => setSelectedId(null),
              onDeleted: () => {
                setSelectedId(null);
                refresh();
              },
              // 恢复/其它"改了项目集合"的操作：只刷新列表，不切换选中项
              onChanged: () => refresh(),
            })
          : null,
        selectedId
          ? null
          : projects.length === 0 && !view.loading
            ? h("p", { style: styles.empty, "data-projects-empty": "" }, text(t, "panel.empty"))
            : h(
                "div",
                { style: styles.list, "data-projects-list": "" },
                projects.map((/** @type {any} */ project) =>
                  h(
                    "div",
                    {
                      style: { ...styles.row, cursor: "pointer" },
                      key: project.id,
                      "data-projects-row": project.id,
                      onClick: () => setSelectedId(project.id),
                    },
                    h(
                      "div",
                      { style: styles.rowMain },
                      h(
                        "span",
                        { style: styles.name },
                        // 重名项目不可区分（走查撞到两条同名）：名字后带一小段 id 后缀
                        project.name,
                        h(
                          "span",
                          {
                            style: { ...styles.meta, marginLeft: "6px" },
                            "data-projects-row-id": project.id,
                          },
                          `#${String(project.id).slice(-6)}`,
                        ),
                      ),
                      h(
                        "span",
                        { style: styles.meta },
                        // 目标为空时给一句话，别留空白让人以为坏了
                        (project.goal ? project.goal : text(t, "panel.goalEmpty")) +
                          (project.threadCount > 0
                            ? ` · ${text(t, "panel.threads", { count: project.threadCount })}`
                            : ""),
                      ),
                    ),
                    h(
                      "span",
                      { style: styles.meta, "data-projects-state": project.state },
                      project.state === "archived"
                        ? text(t, "panel.state.archived")
                        : text(t, "panel.state.active"),
                    ),
                  ),
                ),
              ),
      );
    }

    /**
     * 项目详情：线程 / 记忆 / 审计三个页签（conventions §7.3：页签 ≤3）。
     * 只读；写操作留给后续里程碑。
     * @param {{api: any, t: any, project: any, onBack: () => void, onDeleted?: () => void, onChanged?: () => void}} props
     */
    function ProjectDetail(props) {
      const api = props.api;
      const t = props.t;
      const project = props.project;
      const tabState = useState("threads");
      const tab = tabState[0];
      const setTab = tabState[1];
      // 换项目/重进详情时回到「线程」：否则上次停在「审计」会让人误以为项目里没有线程
      useEffect(() => {
        setTab("threads");
      }, [project.id, setTab]);
      const dataState = useState({
        loading: true,
        error: "",
        threads: [],
        content: null,
        audit: [],
      });
      const data = dataState[0];
      const setData = dataState[1];

      const load = useCallback(() => {
        setData((/** @type {any} */ prev) => ({ ...prev, loading: true, error: "" }));
        Promise.all([
          call(api.ctx, "progress", { projectId: project.id }),
          call(api.ctx, "getProjectContent", { projectId: project.id }),
          call(api.ctx, "listAudit", { projectId: project.id }),
          call(api.ctx, "listApprovals", { projectId: project.id }),
        ]).then(
          (values) => {
            setData({
              loading: false,
              error: "",
              threads: Array.isArray(values[0]?.rows) ? values[0].rows : [],
              progress: values[0] || null,
              projectState: values[0]?.projectState ?? project.state,
              content: values[1] || null,
              audit: Array.isArray(values[2]) ? values[2] : [],
              approvals: Array.isArray(values[3]) ? values[3] : [],
            });
          },
          (error) => {
            setData({
              loading: false,
              error: String(error?.message ?? error),
              threads: [],
              content: null,
              audit: [],
            });
          },
        );
      }, [api, project.id]);

      const draftState = useState("");
      const draft = draftState[0];
      const setDraft = draftState[1];
      const busyState = useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];

      const routeState = useState(null);
      const routeResult = routeState[0];
      const setRouteResult = routeState[1];
      const routeInput = useState("");
      const routeText = routeInput[0];
      const setRouteText = routeInput[1];
      const routeBusyState = useState(false);
      const routeBusy = routeBusyState[0];
      const setRouteBusy = routeBusyState[1];
      const dispatchRoute = useCallback(() => {
        const value = String(routeText).trim();
        if (value === "" || routeBusy) return;
        setRouteBusy(true);
        call(api.ctx, "route", { projectId: project.id, text: value }).then(
          (result) => {
            setRouteBusy(false);
            setRouteResult(result);
            load();
          },
          (error) => {
            setRouteBusy(false);
            setRouteResult({
              executed: false,
              reason: String(error?.message ?? error),
              decision: null,
            });
          },
        );
      }, [api, load, project.id, routeBusy, routeText, setRouteBusy, setRouteResult]);

      const deleteState = useState({ confirming: false, busy: false, impact: null });
      const del = deleteState[0];
      const setDel = deleteState[1];
      const resolveApproval = useCallback(
        (/** @type {any} */ requestId, /** @type {any} */ status) => {
          call(api.ctx, "resolveApproval", { requestId, status }).then(
            () => load(),
            (error) => {
              setData((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              }));
            },
          );
        },
        [api, load, setData],
      );

      const execState = useState({ busy: "", ok: null, message: "" });
      const exec = execState[0];
      const setExec = execState[1];
      // 执行一次已批准的申请：这是「批准 ≠ 可执行」里那独立的一步。
      // 服务端还会再过一遍开关/阈值/幂等，所以这里不做乐观判断——把真实结果回显出来。
      const executeApproval = useCallback(
        (/** @type {any} */ requestId) => {
          setExec({ busy: requestId, ok: null, message: "" });
          call(api.ctx, "executeApproval", { requestId }).then(
            (/** @type {any} */ result) => {
              const ok = result?.executed === true;
              setExec({
                busy: "",
                ok,
                message: ok
                  ? text(t, "detail.executed")
                  : text(t, "detail.refused", { reason: String(result?.reason ?? "?") }),
              });
              load();
            },
            (error) => {
              setExec({ busy: "", ok: false, message: String(error?.message ?? error) });
            },
          );
        },
        [api, load, setExec, t],
      );

      const grantsState = useState("");
      const grantsDraft = grantsState[0];
      const setGrantsDraft = grantsState[1];
      const grants = Object.keys(project?.policy?.repoGrants ?? {});
      const setGrants = useCallback(
        (/** @type {string[]} */ next) => {
          /** @type {Record<string, true>} */
          const map = {};
          for (const key of next) map[key] = true;
          const policy = { ...(project?.policy ?? {}), repoGrants: map };
          call(api.ctx, "updateProject", { id: project.id, patch: { policy } }).then(
            () => load(),
            (error) =>
              setData((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              })),
          );
        },
        [api, load, project?.policy, project.id, setData],
      );

      const purgeState = useState({ phase: "idle", eligible: 0, kept: 0, message: "" });
      const purge = purgeState[0];
      const setPurge = purgeState[1];
      /** 体积格式化（回收站行里用；host 侧的同名逻辑不跨进程，这里单独实现） */
      const formatBytes = (/** @type {number} */ bytes) => {
        const n = Number.isFinite(bytes) ? Math.max(0, Number(bytes)) : 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
      };
      const trashState = useState({ entries: [], loaded: false, message: "" });
      const trash = trashState[0];
      const setTrash = trashState[1];
      const loadTrash = useCallback(() => {
        call(api.ctx, "listTrash", {}).then(
          (/** @type {any} */ result) =>
            setTrash((/** @type {any} */ prev) => ({
              ...prev,
              entries: Array.isArray(result?.entries) ? result.entries : [],
              loaded: true,
            })),
          (/** @type {any} */ error) =>
            setTrash((/** @type {any} */ prev) => ({
              ...prev,
              loaded: true,
              message: String(error?.message ?? error),
            })),
        );
      }, [api, setTrash]);
      const restoreEntry = useCallback(
        (/** @type {string} */ entryId) => {
          call(api.ctx, "restoreTrash", { entryId }).then(
            (/** @type {any} */ result) => {
              setTrash({
                entries: [],
                loaded: false,
                message: text(t, "detail.trashRestored", {
                  name: result?.name ?? "",
                  count: result?.threadCount ?? 0,
                }),
              });
              loadTrash();
              // 恢复的是"另一个"项目，必须刷新列表——否则用户看到"点了恢复但项目没回来"
              if (typeof props.onChanged === "function") props.onChanged();
            },
            (/** @type {any} */ error) =>
              setTrash((/** @type {any} */ prev) => ({
                ...prev,
                message: text(t, "detail.trashFailed", { reason: String(error?.message ?? error) }),
              })),
          );
        },
        [api, loadTrash, setTrash, t],
      );
      useEffect(() => {
        if (!trash.loaded) loadTrash();
      }, [trash.loaded, loadTrash]);

      const previewPurge = useCallback(() => {
        setPurge({ phase: "loading", eligible: 0, kept: 0, message: "" });
        call(api.ctx, "purgeTrash", { options: { dryRun: true, projectId: project.id } }).then(
          (/** @type {any} */ result) => {
            const eligible = Array.isArray(result?.eligible) ? result.eligible.length : 0;
            setPurge({
              phase: eligible > 0 ? "confirm" : "idle",
              eligible,
              kept: Number(result?.kept ?? 0),
              message: eligible > 0 ? "" : text(t, "detail.purgeNothing"),
            });
          },
          (error) =>
            setPurge({
              phase: "idle",
              eligible: 0,
              kept: 0,
              message: String(error?.message ?? error),
            }),
        );
      }, [api, project.id, setPurge, t]);
      const runPurge = useCallback(() => {
        setPurge((/** @type {any} */ prev) => ({ ...prev, phase: "loading" }));
        call(api.ctx, "purgeTrash", {
          options: { dryRun: false, confirm: "purge", projectId: project.id },
        }).then(
          (/** @type {any} */ result) => {
            const ok = result?.ok === true;
            setPurge({
              phase: "idle",
              eligible: 0,
              kept: Number(result?.kept ?? 0),
              message: ok
                ? text(t, "detail.purged", { count: (result?.purged ?? []).length })
                : text(t, "detail.refused", { reason: String(result?.reason ?? "?") }),
            });
          },
          (error) =>
            setPurge({
              phase: "idle",
              eligible: 0,
              kept: 0,
              message: String(error?.message ?? error),
            }),
        );
      }, [api, project.id, setPurge, t]);

      const askDelete = useCallback(() => {
        call(api.ctx, "previewDeleteProject", { id: project.id }).then(
          (preview) => setDel({ confirming: true, busy: false, impact: preview }),
          (error) =>
            setDel({
              confirming: true,
              busy: false,
              impact: { impact: { summary: String(error?.message ?? error) } },
            }),
        );
      }, [api, project.id, setDel]);
      const confirmDelete = useCallback(() => {
        setDel((/** @type {any} */ prev) => ({ ...prev, busy: true }));
        call(api.ctx, "deleteProject", { id: project.id }).then(
          () => {
            setDel({ confirming: false, busy: false, impact: null });
            if (typeof props.onDeleted === "function") props.onDeleted();
          },
          (error) => {
            setDel({ confirming: false, busy: false, impact: null });
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, project.id, props, setData, setDel]);

      const dirState = useState(
        project.dirs && project.dirs.length > 0 ? String(project.dirs[0]) : "",
      );
      const dirDraft = dirState[0];
      const setDirDraft = dirState[1];
      const saveDir = useCallback(() => {
        const value = String(dirDraft).trim();
        call(api.ctx, "updateProject", {
          id: project.id,
          patch: { dirs: value === "" ? [] : [value] },
        }).then(
          () => load(),
          (error) => {
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, dirDraft, load, project.id, setData]);

      const createThread = useCallback(() => {
        const task = String(draft).trim();
        if (task === "" || busy) return;
        setBusy(true);
        call(api.ctx, "createThread", { projectId: project.id, task }).then(
          () => {
            setDraft("");
            setBusy(false);
            load();
          },
          (error) => {
            setBusy(false);
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, busy, draft, load, project.id, setBusy, setDraft, setData]);

      useEffect(() => {
        load();
      }, [load]);

      const tabs = [
        {
          id: "threads",
          label: text(t, "detail.tab.threads", {
            count: data.progress?.total ?? data.threads.length,
          }),
        },
        { id: "memory", label: text(t, "detail.tab.memory") },
        { id: "audit", label: text(t, "detail.tab.audit") },
      ];

      const body = (() => {
        if (data.loading) return h("p", { style: styles.empty }, text(t, "detail.loading"));
        if (data.error !== "")
          return h("p", { style: styles.error, "data-projects-detail-error": "" }, data.error);
        if (tab === "threads") {
          const rows = data.progress?.rows ?? [];
          const counts = data.progress?.counts ?? {};
          // 空列表也要给「建线程」入口：否则新项目只能靠会话菜单归属，没法从这里起线程
          const composer = h(
            "div",
            { style: { display: "flex", gap: "8px", margin: "0 0 8px" } },
            h("input", {
              style: styles.input,
              value: draft,
              placeholder: text(t, "detail.threadPlaceholder"),
              "data-projects-thread-input": "",
              onChange: (/** @type {any} */ event) => setDraft(event.target.value),
              onKeyDown: (/** @type {any} */ event) => {
                if (event.key === "Enter") createThread();
              },
              disabled: busy,
            }),
            h(
              "button",
              {
                type: "button",
                style: styles.button,
                "data-projects-thread-create": "",
                onClick: createThread,
                disabled: busy,
              },
              busy ? text(t, "detail.threadCreating") : text(t, "detail.threadCreate"),
            ),
          );
          if (rows.length === 0)
            return h(
              "div",
              { "data-projects-threads": "", "data-projects-attention": "0" },
              composer,
              h(
                "p",
                { style: styles.empty, "data-projects-threads-empty": "" },
                text(t, "detail.threadsEmpty"),
              ),
            );
          return h(
            "div",
            {
              "data-projects-threads": "",
              "data-projects-attention": String(data.progress?.attention ?? 0),
            },
            composer,
            h(
              "div",
              { style: { display: "flex", gap: "8px", margin: "0 0 8px" } },
              h("input", {
                style: styles.input,
                value: routeText,
                placeholder: text(t, "detail.routePlaceholder"),
                "data-projects-route-input": "",
                onChange: (/** @type {any} */ event) => setRouteText(event.target.value),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event.key === "Enter") dispatchRoute();
                },
                disabled: routeBusy,
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-route-dispatch": "",
                  onClick: dispatchRoute,
                  disabled: routeBusy,
                },
                routeBusy ? text(t, "detail.routeBusy") : text(t, "detail.routeDispatch"),
              ),
            ),
            routeResult
              ? h(
                  "div",
                  {
                    style: { ...styles.meta, margin: "0 0 8px" },
                    "data-projects-route-result": "",
                    "data-projects-route-executed": routeResult.executed ? "yes" : "no",
                    title: routeResult.decision
                      ? `by=${String(routeResult.decision.by)} action=${String(routeResult.decision.action)}${routeResult.decision.ruleId ? ` rule=${String(routeResult.decision.ruleId)}` : ""}${routeResult.decision.blockedReason ? ` reason=${String(routeResult.decision.blockedReason)}` : ""}`
                      : "",
                  },
                  (() => {
                    const decision = routeResult.decision;
                    if (!decision) return routeResult.reason ? String(routeResult.reason) : "";
                    const action = String(decision.action);
                    const actionText = text(t, `detail.routeAction.${action}`);
                    const how =
                      decision.ruleId && decision.by !== "fallback"
                        ? text(t, "detail.routeBy.rule", { rule: String(decision.ruleId) })
                        : text(t, "detail.routeBy.fallback");
                    if (routeResult.executed)
                      return text(t, "detail.routeOk", { how, action: actionText });
                    // 被拦下的情况：说清"想做什么、为什么没做、可以怎么办"
                    const level = String(decision.blockedReason ?? "").replace(/^autonomy\//u, "");
                    const head = text(t, "detail.routeBlocked", {
                      how,
                      action: actionText,
                      level: level || "?",
                    });
                    return `${head}（${text(t, "detail.routeBlockedHint")}）`;
                  })(),
                )
              : null,
            h(
              "div",
              { style: { ...styles.meta, margin: "0 0 6px" }, "data-projects-counts": "" },
              ["waiting-user", "failed", "working", "done", "idle"]
                .filter((state) => (counts[state] ?? 0) > 0)
                .map((state) => `${text(t, `detail.state.${state}`)} ${counts[state]}`)
                .join(" · "),
            ),
            rows.map((/** @type {any} */ row) =>
              h(
                "div",
                {
                  key: row.sessionId,
                  style: styles.row,
                  "data-projects-thread-row": row.sessionId,
                  "data-projects-thread-state": row.view.state,
                },
                h(
                  "div",
                  { style: styles.rowMain },
                  h(
                    "span",
                    { style: styles.name },
                    `${String(row.sessionId).slice(0, 20)} · ${text(t, `detail.state.${row.view.state}`)}`,
                  ),
                  h(
                    "span",
                    { style: styles.meta },
                    [
                      row.view.turn > 0 ? `turn ${row.view.turn}` : "",
                      row.branch ? String(row.branch) : "",
                    ]
                      .filter((part) => part !== "")
                      .join(" · ") || "—",
                  ),
                  // 可观测摘要（规格 §7.7.3）：步骤/工具/diff/tokens，缺失显式 n/a
                  row.summary
                    ? h(
                        "span",
                        { style: styles.meta, "data-projects-thread-stats": "" },
                        String(row.summary),
                      )
                    : null,
                ),
              ),
            ),
          );
        }
        if (tab === "memory") {
          const content = data.content || {};
          return h(
            "div",
            { "data-projects-memory": "" },
            h("h3", { style: styles.name }, text(t, "detail.instructions")),
            h(
              "pre",
              {
                style: { ...styles.meta, whiteSpace: "pre-wrap", margin: "4px 0 12px" },
                "data-projects-instructions": "",
              },
              content.instructions || text(t, "detail.emptyFile"),
            ),
            h("h3", { style: styles.name }, text(t, "detail.memoryIndex")),
            h(
              "pre",
              {
                style: { ...styles.meta, whiteSpace: "pre-wrap", margin: "4px 0" },
                "data-projects-memory-index": "",
              },
              content.memoryIndex || text(t, "detail.emptyFile"),
            ),
          );
        }
        if (data.audit.length === 0)
          return h(
            "p",
            { style: styles.empty, "data-projects-audit-empty": "" },
            text(t, "detail.auditEmpty"),
          );
        return h(
          "div",
          { "data-projects-audit": "" },
          data.audit.map((/** @type {any} */ entry, /** @type {any} */ index) =>
            h(
              "div",
              { key: String(index), style: styles.row },
              h(
                "div",
                { style: styles.rowMain },
                h("span", { style: styles.name }, String(entry.action || entry.kind || "?")),
                h("span", { style: styles.meta }, String(entry.at || "")),
              ),
            ),
          ),
        );
      })();

      return h(
        "div",
        {
          "data-projects-detail": project.id,
          style: { display: "flex", flexDirection: "column", gap: "8px" },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-detail-back": "",
              onClick: () => props.onBack(),
            },
            text(t, "detail.back"),
          ),
          h("span", { style: styles.title }, project.name),
          h(
            "span",
            { style: styles.summary, "data-projects-detail-goal": "" },
            project.goal || text(t, "panel.goalEmpty"),
          ),
        ),
        h(
          "div",
          {
            style: { display: "flex", gap: "6px", marginTop: "6px" },
            "data-projects-state-actions": "",
          },
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-toggle-pause": "",
              onClick: () => {
                const next = data.projectState === "paused" ? "resumeProject" : "pauseProject";
                call(api.ctx, next, { id: project.id }).then(
                  () => load(),
                  (error) => {
                    setData((/** @type {any} */ prev) => ({
                      ...prev,
                      error: String(error?.message ?? error),
                    }));
                  },
                );
              },
            },
            data.projectState === "paused" ? text(t, "detail.resume") : text(t, "detail.pause"),
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-toggle-archive": "",
              onClick: () => {
                const next =
                  data.projectState === "archived" ? "unarchiveProject" : "archiveProject";
                call(api.ctx, next, { id: project.id }).then(
                  () => load(),
                  (error) => {
                    setData((/** @type {any} */ prev) => ({
                      ...prev,
                      error: String(error?.message ?? error),
                    }));
                  },
                );
              },
            },
            data.projectState === "archived"
              ? text(t, "detail.unarchive")
              : text(t, "detail.archive"),
          ),
          h(
            "button",
            {
              type: "button",
              style: { ...styles.button, color: T.danger, marginLeft: "auto" },
              "data-projects-delete": "",
              onClick: askDelete,
              disabled: del.busy,
            },
            del.busy ? text(t, "detail.deleting") : text(t, "detail.delete"),
          ),
          h(
            "span",
            { style: styles.meta, "data-projects-budget": "" },
            data.progress?.budget
              ? text(t, "detail.budget", {
                  today: data.progress.budget.used?.today ?? 0,
                  running: data.progress.budget.used?.running ?? 0,
                })
              : "",
          ),
        ),
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "6px" } },
          h("span", { style: { ...styles.meta, flex: "none" } }, text(t, "detail.dirLabel")),
          h("input", {
            style: styles.input,
            value: dirDraft,
            placeholder: text(t, "detail.dirPlaceholder"),
            "data-projects-dir-input": "",
            onChange: (/** @type {any} */ event) => setDirDraft(event.target.value),
            onKeyDown: (/** @type {any} */ event) => {
              if (event.key === "Enter") saveDir();
            },
          }),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-dir-save": "",
              onClick: saveDir,
            },
            text(t, "detail.dirSave"),
          ),
        ),
        (() => {
          const all = Array.isArray(data.approvals) ? data.approvals : [];
          const pending = all.filter((/** @type {any} */ item) => item.status === "pending");
          // 已批准但还没执行：这才是「批准 ≠ 可执行」里那独立的一步，必须有入口
          const runnable = all.filter(
            (/** @type {any} */ item) =>
              item.status === "approved" &&
              !(typeof item.executedAt === "string" && item.executedAt !== ""),
          );
          if (pending.length === 0 && runnable.length === 0) return null;
          const row = (/** @type {any} */ item, /** @type {any} */ actions) =>
            h(
              "div",
              {
                key: item.requestId,
                style: { display: "flex", gap: "8px", alignItems: "center" },
                "data-projects-approval-row": item.requestId,
              },
              h(
                "span",
                { style: { ...styles.meta, flex: 1, minWidth: 0 } },
                `${item.action} · ${item.reason}`,
              ),
              ...actions,
            );
          return h(
            "div",
            {
              "data-projects-approvals": "",
              style: {
                border: `1px solid ${T.border}`,
                borderRadius: "8px",
                padding: "8px 10px",
                marginTop: "8px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              },
            },
            h("div", { style: styles.name }, text(t, "detail.approvalsTitle")),
            pending.map((/** @type {any} */ item) =>
              row(item, [
                h(
                  "button",
                  {
                    key: "approve",
                    type: "button",
                    style: styles.button,
                    "data-projects-approval-approve": item.requestId,
                    onClick: () => resolveApproval(item.requestId, "approved"),
                  },
                  text(t, "detail.approve"),
                ),
                h(
                  "button",
                  {
                    key: "reject",
                    type: "button",
                    style: { ...styles.button, color: T.danger },
                    "data-projects-approval-reject": item.requestId,
                    onClick: () => resolveApproval(item.requestId, "rejected"),
                  },
                  text(t, "detail.reject"),
                ),
              ]),
            ),
            runnable.map((/** @type {any} */ item) =>
              row(item, [
                h(
                  "button",
                  {
                    key: "execute",
                    type: "button",
                    style: styles.button,
                    disabled: exec.busy === item.requestId,
                    "data-projects-approval-execute": item.requestId,
                    onClick: () => executeApproval(item.requestId),
                  },
                  text(t, "detail.execute"),
                ),
              ]),
            ),
            exec.message !== ""
              ? h(
                  "div",
                  {
                    style: { ...styles.meta, color: exec.ok === false ? T.danger : T.text },
                    "data-projects-approval-exec-result": "",
                  },
                  exec.message,
                )
              : null,
          );
        })(),
        // 走查发现这两块配置把主内容（线程）压到折叠线以下：收进折叠区，首屏留给线程
        h(
          "details",
          {
            style: { marginTop: "8px" },
            "data-projects-config": "",
          },
          h(
            "summary",
            { style: { ...styles.meta, cursor: "pointer" } },
            text(t, "detail.configTitle"),
          ),
          // 仓库授权：直推保护分支需要 per-repo 首次授予（规格 §7.5 行 2），没有界面就只能手编 JSON
          h(
            "div",
            {
              "data-projects-grants": "",
              style: {
                border: `1px solid ${T.border}`,
                borderRadius: "8px",
                padding: "8px 10px",
                marginTop: "8px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              },
            },
            h("div", { style: styles.name }, text(t, "detail.grantsTitle")),
            h(
              "div",
              { style: styles.meta },
              grants.length > 0 ? grants.join(" · ") : text(t, "detail.grantsEmpty"),
            ),
            h(
              "div",
              { style: { display: "flex", gap: "8px", alignItems: "center" } },
              h("input", {
                value: grantsDraft,
                placeholder: "owner/repo",
                "data-projects-grant-input": "",
                style: { ...styles.input, flex: 1, minWidth: 0 },
                onInput: (/** @type {any} */ event) => setGrantsDraft(event.target.value),
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-grant-add": "",
                  onClick: () => {
                    const slug = String(grantsDraft).trim();
                    if (!/^[\w.-]+\/[\w.-]+$/u.test(slug)) return;
                    setGrants([...grants, slug]);
                    setGrantsDraft("");
                  },
                },
                text(t, "detail.grantAdd"),
              ),
            ),
            grants.length > 0
              ? h(
                  "div",
                  { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                  ...grants.map((/** @type {string} */ slug) =>
                    h(
                      "button",
                      {
                        key: slug,
                        type: "button",
                        style: { ...styles.button, fontSize: "11px" },
                        "data-projects-grant-remove": slug,
                        onClick: () => setGrants(grants.filter((item) => item !== slug)),
                      },
                      `${slug} ✕`,
                    ),
                  ),
                )
              : null,
          ),
          // 回收站清理：只处理本项目的、超保留期的条目；先预览再确认（规格 §7.5 行 4c）
          h(
            "div",
            {
              "data-projects-purge": "",
              style: {
                border: `1px solid ${T.border}`,
                borderRadius: "8px",
                padding: "8px 10px",
                marginTop: "8px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              },
            },
            h("div", { style: styles.name }, text(t, "detail.purgeTitle")),
            h("div", { style: styles.meta }, text(t, "detail.purgeHint")),
            h(
              "div",
              { style: { display: "flex", gap: "8px", alignItems: "center" } },
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  disabled: purge.phase === "loading",
                  "data-projects-purge-preview": "",
                  onClick: previewPurge,
                },
                text(t, "detail.purgePreview"),
              ),
              purge.phase === "confirm"
                ? h(
                    "button",
                    {
                      type: "button",
                      style: { ...styles.button, color: T.danger },
                      "data-projects-purge-confirm": "",
                      onClick: runPurge,
                    },
                    text(t, "detail.purgeConfirm", { count: purge.eligible }),
                  )
                : null,
            ),
            purge.message !== ""
              ? h("div", { style: styles.meta, "data-projects-purge-result": "" }, purge.message)
              : null,
          ),
          // 回收站（可恢复）：删除承诺"可恢复"，就必须给得出恢复入口（P0-2）
          h(
            "div",
            {
              "data-projects-trash": "",
              style: {
                border: `1px solid ${T.border}`,
                borderRadius: "8px",
                padding: "8px 10px",
                marginTop: "8px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              },
            },
            h("div", { style: styles.name }, text(t, "detail.trashTitle")),
            trash.entries.length === 0
              ? h(
                  "div",
                  { style: styles.meta, "data-projects-trash-empty": "" },
                  text(t, "detail.trashEmpty"),
                )
              : h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                  trash.entries.slice(0, 8).map((/** @type {any} */ entry) =>
                    h(
                      "div",
                      {
                        key: entry.entryId,
                        "data-projects-trash-row": entry.entryId,
                        style: {
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                          justifyContent: "space-between",
                        },
                      },
                      h(
                        "span",
                        {
                          style: {
                            ...styles.meta,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          },
                        },
                        `${entry.name} · ${entry.threadCount} 个线程 · ${entry.deletedAt > 0 ? new Date(entry.deletedAt).toLocaleString() : "时间未知"} · ${formatBytes(entry.sizeBytes)}`,
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          style: styles.button,
                          "data-projects-trash-restore": entry.entryId,
                          onClick: () => restoreEntry(entry.entryId),
                          disabled: entry.restorable !== true,
                        },
                        text(t, "detail.trashRestore"),
                      ),
                    ),
                  ),
                ),
            trash.message !== ""
              ? h("div", { style: styles.meta, "data-projects-trash-result": "" }, trash.message)
              : null,
          ),
        ),
        del.confirming
          ? h(
              "div",
              {
                role: "alertdialog",
                "aria-label": text(t, "detail.delete"),
                style: {
                  border: `1px solid ${T.danger}`,
                  borderRadius: "8px",
                  padding: "10px",
                  marginTop: "8px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                },
                "data-projects-delete-confirm-panel": "",
              },
              h(
                "div",
                { style: { color: T.text }, "data-projects-delete-impact": "" },
                del.impact?.impact?.summary ?? "",
              ),
              h(
                "details",
                { style: { ...styles.meta } },
                h("summary", null, text(t, "detail.deleteDetails")),
                h(
                  "code",
                  { style: { ...styles.meta, whiteSpace: "pre-wrap" } },
                  String(del.impact?.contentDir ?? ""),
                ),
              ),
              h(
                "div",
                { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.button,
                    "data-projects-delete-cancel": "",
                    onClick: () => setDel({ confirming: false, busy: false, impact: null }),
                  },
                  text(t, "detail.deleteCancel"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.button, borderColor: T.danger, color: T.danger },
                    "data-projects-delete-confirm": "",
                    "data-modal-autofocus": "",
                    onClick: confirmDelete,
                    disabled: del.busy,
                  },
                  del.busy ? text(t, "detail.deleting") : text(t, "detail.deleteConfirm"),
                ),
              ),
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "6px" }, role: "tablist" },
          tabs.map((/** @type {any} */ item) =>
            h(
              "button",
              {
                type: "button",
                key: item.id,
                role: "tab",
                "aria-selected": tab === item.id ? "true" : "false",
                "data-projects-tab": item.id,
                style: {
                  ...styles.button,
                  borderColor: tab === item.id ? T.accentText : T.border,
                  color: tab === item.id ? T.accentText : T.text,
                },
                onClick: () => setTab(item.id),
              },
              item.label,
            ),
          ),
        ),
        body,
      );
    }

    /**
     * 渲染护栏：把渲染期异常变成可见文本，而不是让整个应用白屏。
     * 直接以函数调用子组件，让 hooks 归属本组件、异常可被 try/catch 捕获。
     * @param {any} props
     */
    function ProjectsPanelSafe(props) {
      try {
        return ProjectsPanel(props);
      } catch (error) {
        return h(
          "pre",
          {
            "data-projects-crash": "",
            style: { color: T.danger, whiteSpace: "pre-wrap", fontSize: "12px" },
          },
          String(/** @type {any} */ (error)?.stack || error),
        );
      }
    }

    /**
     * 会话行「…」菜单里的一项：把该会话归属到某个项目。
     * slot 契约：renderSlot(slot, target.value, { hookContext })，target.value 里带会话标识。
     * 刻意用内联展开而不是弹窗：菜单里再弹 modal 会叠两层焦点陷阱。
     * @param {any} props
     */
    function AttachToProjectMenu(props) {
      const expanded = useState(false);
      const open = expanded[0];
      const setOpen = expanded[1];
      const state = useState({ loading: false, error: "", projects: [] });
      const view = state[0];
      const setView = state[1];
      const t = props.api.t;
      const api = props.api;

      const sessionId =
        props.sessionId ||
        props.session?.id ||
        props.target?.sessionId ||
        props.value?.sessionId ||
        props.id ||
        "";

      const load = useCallback(() => {
        setView((/** @type {any} */ prev) => ({
          loading: true,
          error: prev.error,
          projects: prev.projects,
        }));
        call(api.ctx, "listProjects").then(
          (projects) => {
            setView({
              loading: false,
              error: "",
              projects: Array.isArray(projects) ? projects : [],
            });
          },
          (error) => {
            setView({ loading: false, error: String(error?.message ?? error), projects: [] });
          },
        );
      }, [api]);

      const attach = useCallback(
        (/** @type {any} */ projectId) => {
          if (String(sessionId) === "") return;
          call(api.ctx, "attachThread", { sessionId: String(sessionId), projectId }).then(
            () => {
              const hook = props.hookContext;
              if (Array.isArray(hook) && typeof hook[1] === "function") hook[1](false);
            },
            (error) => {
              setView((/** @type {any} */ prev) => ({
                loading: false,
                error: String(error?.message ?? error),
                projects: prev.projects,
              }));
            },
          );
        },
        [api, props, sessionId],
      );

      if (String(sessionId) === "") return null;

      return h(
        "div",
        { "data-projects-attach": sessionId },
        h(
          "button",
          {
            type: "button",
            style: { ...styles.button, width: "100%", textAlign: "left", marginTop: "4px" },
            "data-projects-attach-open": "",
            onClick: () => {
              setOpen(!open);
              if (!open) load();
            },
          },
          text(t, "menu.attach"),
        ),
        open
          ? h(
              "div",
              {
                style: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" },
                "data-projects-attach-list": "",
              },
              view.loading ? h("span", { style: styles.meta }, text(t, "menu.loading")) : null,
              view.error ? h("span", { style: styles.error }, view.error) : null,
              view.projects.length === 0 && !view.loading
                ? h(
                    "span",
                    { style: styles.meta, "data-projects-attach-empty": "" },
                    text(t, "menu.empty"),
                  )
                : view.projects.map((/** @type {any} */ project) =>
                    h(
                      "button",
                      {
                        type: "button",
                        key: project.id,
                        style: { ...styles.button, textAlign: "left" },
                        "data-projects-attach-option": project.id,
                        onClick: () => attach(project.id),
                      },
                      project.threadCount > 0
                        ? `${project.name} · ${text(t, "panel.threads", { count: project.threadCount })}`
                        : project.name,
                    ),
                  ),
            )
          : null,
      );
    }

    /**
     * 全局通知：轮询各活跃项目的线程状态，新出现「失败 / 等你」时弹一条应用内 toast。
     * 不依赖浏览器 Notification（那条需要用户手势授权，默认不开）。
     * @param {{api: any, t: any, onOpen?: () => void}} props
     */
    function ProjectsNotifier(props) {
      const api = props.api;
      const t = props.t;
      const state = useState(null);
      const notice = state[0];
      const setNotice = state[1];
      const previous = React.useRef({ threads: {}, projects: [] });

      useEffect(() => {
        let cancelled = false;
        const tick = () => {
          // 页面在后台时不轮询：每 5s 一次 listProjects + 每项目 progress，
          // 在用户没看的时候纯属浪费（而且没人能看见 toast）。
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          call(api.ctx, "listProjects").then(
            (projects) => {
              if (cancelled || !Array.isArray(projects)) return;
              const active = projects.filter(
                (/** @type {any} */ project) => project.state === "active",
              );
              Promise.all(
                active.map((/** @type {any} */ project) =>
                  call(api.ctx, "progress", { projectId: project.id }).then(
                    (value) => ({ projectId: project.id, value }),
                    () => null,
                  ),
                ),
              ).then((results) => {
                if (cancelled) return;
                /** @type {Record<string, {state: string, projectId?: string}>} */
                const threads = {};
                for (const result of results) {
                  if (!result?.value) continue;
                  for (const row of result.value.rows ?? []) {
                    threads[row.sessionId] = {
                      state: row.view?.state ?? "idle",
                      projectId: result.projectId,
                    };
                  }
                }
                const next = {
                  threads,
                  projects: active.map((/** @type {any} */ project) => project.id),
                };
                const items = diffAttention(previous.current, next);
                previous.current = next;
                const counts = summarize(items);
                const parts = [];
                if (counts.failed > 0)
                  parts.push(text(t, "notify.failed", { count: counts.failed }));
                if (counts.waiting > 0)
                  parts.push(text(t, "notify.waiting", { count: counts.waiting }));
                const line = parts.join(" · ");
                if (line !== "") setNotice({ text: line, at: Date.now() });
              });
            },
            () => {},
          );
        };
        tick();
        const timer = setInterval(tick, 5000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [api]);

      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 8000);
        return () => clearTimeout(timer);
      }, [notice]);

      return h(
        "div",
        { "data-projects-notifier": "", style: { display: "contents" } },
        notice
          ? h(
              "div",
              {
                role: "status",
                "data-projects-toast": "",
                style: {
                  position: "fixed",
                  right: "16px",
                  bottom: "16px",
                  zIndex: 60,
                  maxWidth: "320px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: `1px solid ${T.border}`,
                  background: T.bg,
                  color: T.text,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
                  fontSize: "13px",
                  cursor: "pointer",
                },
                onClick: () => {
                  setNotice(null);
                  if (typeof props.onOpen === "function") props.onOpen();
                },
              },
              notice.text,
            )
          : null,
      );
    }

    /** 与 lib/notify.js 同源的实现（client 半不能 import，逻辑保持逐行一致）。 */
    /**
     * @param {any} previous @param {any} next
     */
    function diffAttention(previous, next) {
      const before = previous?.threads ?? {};
      const after = next?.threads ?? {};
      const out = [];
      for (const sessionId of Object.keys(after)) {
        const entry = after[sessionId];
        const was = before[sessionId]?.state;
        if (entry.state === "failed" && was !== "failed") {
          out.push({ kind: "failed", projectId: String(entry.projectId || ""), sessionId });
        } else if (entry.state === "waiting-user" && was !== "waiting-user") {
          out.push({ kind: "waiting-user", projectId: String(entry.projectId || ""), sessionId });
        }
      }
      return out;
    }

    /**
     * 只统计条数；文案由调用方用 locale 拼（client 半不应出现硬编码语言文案）。
     * @param {any[]} items
     */
    function summarize(items) {
      const list = Array.isArray(items) ? items : [];
      return {
        failed: list.filter((item) => item.kind === "failed").length,
        waiting: list.filter((item) => item.kind === "waiting-user").length,
      };
    }

    /** 侧栏图标入口：宿主会传 {size, active}。 */
    /** @param {any} props */
    function ProjectsPanelIcon(props) {
      var size = props?.size ? props.size : 16;
      return h(
        "span",
        {
          "data-projects-nav-icon": "",
          style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: size,
            height: size,
            fontSize: size - 2,
            lineHeight: 1,
            color: props?.active ? T.accentText : "inherit",
          },
          "aria-hidden": "true",
        },
        "▦",
      );
    }

    /**
     * 设置分节：诊断 + 数据根。
     * @param {{api: any, t: any}} props
     */
    /** 六个危险开关的键（与 lib/store.js 的 DEFAULT_DANGER 一致）。 */
    var DANGER_KEYS = [
      "forcePushOwnBranch",
      "pushProtectedBranch",
      "autoMerge",
      "trashAuto",
      "purgeAfterRetention",
      "editProfile",
    ];

    /**
     * 危险开关：默认全关，每项带一句风险说明。打开需要用户明确勾选。
     * @param {{t: any, policy: any, onChange: (patch: any) => void}} props
     */
    function DangerSwitches(/** @type {any} */ props) {
      const t = props.t;
      const danger = props.policy?.danger ?? {};
      return h(
        "details",
        { "data-projects-policy-danger": "" },
        h(
          "summary",
          { style: { cursor: "pointer", color: T.dim } },
          text(t, "settings.dangerTitle"),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" } },
          h("div", { style: { color: T.faint, fontSize: "12px" } }, text(t, "settings.dangerHint")),
          DANGER_KEYS.map((key) =>
            h(
              "label",
              {
                key: key,
                style: { display: "flex", gap: "6px", alignItems: "flex-start", color: T.dim },
              },
              h("input", {
                type: "checkbox",
                checked: danger[key] === true,
                "data-projects-danger-switch": key,
                onChange: (/** @type {any} */ event) =>
                  props.onChange({ danger: { ...danger, [key]: event.target.checked } }),
              }),
              h(
                "span",
                null,
                text(t, `settings.danger.${key}.label`) +
                  " — " +
                  text(t, `settings.danger.${key}.risk`),
              ),
            ),
          ),
        ),
      );
    }

    function ProjectsSettings(/** @type {any} */ props) {
      var api = props.api;
      var t = props.t;
      var state = useState({
        loading: true,
        describe: null,
        error: null,
        projects: [],
        selectedId: "",
      });
      var view = state[0];
      var setView = state[1];

      var reload = useCallback(() => {
        Promise.all([call(api.ctx, "describe"), call(api.ctx, "listProjects")]).then(
          (values) => {
            var projects = Array.isArray(values[1]) ? values[1] : [];
            setView((/** @type {any} */ prev) => ({
              loading: false,
              describe: values[0] || null,
              error: null,
              projects: projects,
              selectedId: prev.selectedId || (projects[0] ? projects[0].id : ""),
            }));
          },
          (error) => {
            setView((/** @type {any} */ prev) => ({
              ...prev,
              loading: false,
              describe: null,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, setView]);

      useEffect(() => {
        reload();
      }, [reload]);

      var applyPolicy = useCallback(
        (/** @type {any} */ patch) => {
          var selected = view.projects.find(
            (/** @type {any} */ project) => project.id === view.selectedId,
          );
          if (!selected) return;
          var nextPolicy = { ...selected.policy, ...patch };
          call(api.ctx, "updateProject", { id: selected.id, patch: { policy: nextPolicy } }).then(
            () => reload(),
            (error) =>
              setView((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              })),
          );
        },
        [api, reload, setView, view.projects, view.selectedId],
      );

      var describe = view.describe;
      return h(
        "div",
        { style: { color: T.text, fontSize: "13px" }, "data-projects-settings": "" },
        h(
          "div",
          { style: styles.summary, "data-projects-settings-summary": "" },
          describe
            ? text(t, "settings.summary", { count: describe.projectCount })
            : text(t, "settings.unavailable"),
        ),
        view.error ? h("div", { style: styles.error }, view.error) : null,
        describe
          ? h(
              "div",
              { style: { marginTop: "6px", color: T.dim }, "data-projects-settings-root": "" },
              `${text(t, "settings.dataRoot")}: ${describe.dataRoot}`,
            )
          : null,
        h("div", { style: { marginTop: "6px", color: T.faint } }, text(t, "settings.hint")),
        (() => {
          var selectedForDanger = view.projects.find(
            (/** @type {any} */ project) => project.id === view.selectedId,
          );
          if (!selectedForDanger) return null;
          return h(DangerSwitches, {
            t: t,
            policy: selectedForDanger.policy,
            onChange: applyPolicy,
          });
        })(),

        h(
          "details",
          { style: { marginTop: "8px" }, "data-projects-policy": "" },
          h(
            "summary",
            { style: { cursor: "pointer", color: T.dim } },
            text(t, "settings.policyTitle"),
          ),
          view.projects.length === 0
            ? h("div", { style: { color: T.faint } }, text(t, "settings.noProjects"))
            : h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" },
                },
                h(
                  "select",
                  {
                    style: styles.input,
                    value: view.selectedId,
                    "data-projects-policy-project": "",
                    onChange: (/** @type {any} */ event) =>
                      setView((/** @type {any} */ prev) => ({
                        ...prev,
                        selectedId: event.target.value,
                      })),
                  },
                  view.projects.map((/** @type {any} */ project) =>
                    h("option", { key: project.id, value: project.id }, project.name),
                  ),
                ),
                (() => {
                  var selected = view.projects.find(
                    (/** @type {any} */ project) => project.id === view.selectedId,
                  );
                  if (!selected) return null;
                  return h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                    h(
                      "label",
                      { style: { display: "flex", gap: "8px", alignItems: "center" } },
                      h(
                        "span",
                        { style: { color: T.dim, flex: "none" } },
                        text(t, "settings.autonomy"),
                      ),
                      h(
                        "select",
                        {
                          style: styles.input,
                          value: selected.policy?.autonomy ?? "L1",
                          "data-projects-policy-autonomy": "",
                          onChange: (/** @type {any} */ event) =>
                            applyPolicy({ autonomy: event.target.value }),
                        },
                        ["L0", "L1", "L2", "L3"].map((level) =>
                          h(
                            "option",
                            { key: level, value: level },
                            `${level} — ${text(t, `settings.level.${level}`)}`,
                          ),
                        ),
                      ),
                    ),
                    h("input", {
                      style: styles.input,
                      value: selected.policy?.persona ?? "",
                      placeholder: text(t, "settings.persona"),
                      "data-projects-policy-persona": "",
                      // 非受控输入：切换项目时必须重挂载，否则显示的是上一个项目的人格
                      key: `persona-${selected.id}`,
                      // 不逐字提交：每敲一个字符就写一次 projects.json，
                      // 输入长人格时会触发几十次磁盘写。改成失焦/回车时才提交。
                      defaultValue: selected.policy?.persona ?? "",
                      onBlur: (/** @type {any} */ event) => {
                        if (event.target.value !== (selected.policy?.persona ?? "")) {
                          applyPolicy({ persona: event.target.value });
                        }
                      },
                      onKeyDown: (/** @type {any} */ event) => {
                        if (event.key === "Enter") event.target.blur();
                      },
                    }),
                    h(
                      "label",
                      {
                        style: { display: "flex", gap: "6px", alignItems: "center", color: T.dim },
                      },
                      h("input", {
                        type: "checkbox",
                        checked: selected.policy?.routing?.fallback !== false,
                        "data-projects-policy-fallback": "",
                        onChange: (/** @type {any} */ event) =>
                          applyPolicy({
                            routing: {
                              ...(selected.policy?.routing ?? {}),
                              fallback: event.target.checked,
                            },
                          }),
                      }),
                      text(t, "settings.fallback"),
                    ),
                  );
                })(),
              ),
        ),
      );
    }

    exports.inject = ["slots", "locale", "connection"];
    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      var c = /** @type {any} */ (ctx);
      c.effect(() => c.locale.register(NS, { zh: ZH, en: EN }), "projects: dictionaries");
      var t = c.locale.bind(NS);
      /** 给组件用的句柄：组件里拿不到 ctx，统一从这里取。 */
      var api = { ctx: c, t: t };

      c.effect(
        () =>
          c.slots.inject("main", () =>
            c.slots.register(
              {
                name: "main",
                key: PANEL_ID,
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              ProjectsPanelSafe,
            ),
          ),
        "projects: main panel",
      );

      c.effect(
        () =>
          c.slots.inject("sidebar.panellist", () =>
            c.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 10,
                label: () => text(t, "panel.title"),
                locale: NS,
              },
              ProjectsPanelIcon,
            ),
          ),
        "projects: nav entry",
      );

      c.effect(
        () =>
          c.slots.inject("sidebar.workspaces.session.menu.item", () =>
            c.slots.register(
              {
                name: "sidebar.workspaces.session.menu.item",
                id: PANEL_ID,
                order: 430,
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              AttachToProjectMenu,
            ),
          ),
        "projects: session menu",
      );

      c.effect(
        () =>
          c.slots.inject("shell.overlay", () =>
            c.slots.register(
              {
                name: "shell.overlay",
                id: "projects-notifier",
                order: 60,
                locale: NS,
                inject: () => ({ api: api, t: t, onOpen: () => c.selectPanel(PANEL_ID) }),
              },
              ProjectsNotifier,
            ),
          ),
        "projects: notifier",
      );

      c.effect(
        () =>
          c.slots.inject("settings.section", () =>
            c.slots.register(
              {
                name: "settings.section",
                id: PANEL_ID,
                order: 93,
                label: () => text(t, "settings.section"),
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              ProjectsSettings,
            ),
          ),
        "projects: settings card",
      );
    };

    return module.exports;
  },
});
