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
      "panel.summary": "{projects} 个项目 · {active} 个活跃 · {attached} 个会话已挂上下文",
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
      var rpc = ctx && ctx.connection && ctx.connection.rpc;
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
        projects.length === 0 && !view.loading
          ? h("p", { style: styles.empty, "data-projects-empty": "" }, text(t, "panel.empty"))
          : h(
              "div",
              { style: styles.list, "data-projects-list": "" },
              projects.map((/** @type {any} */ project) =>
                h(
                  "div",
                  { style: styles.row, key: project.id, "data-projects-row": project.id },
                  h(
                    "div",
                    { style: styles.rowMain },
                    h("span", { style: styles.name }, project.name),
                    h(
                      "span",
                      { style: styles.meta },
                      // 目标为空时给一句话，别留空白让人以为坏了
                      (project.goal ? project.goal : text(t, "panel.goalEmpty")) +
                        (project.threadCount > 0
                          ? " · " + text(t, "panel.threads", { count: project.threadCount })
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
        (props.session && props.session.id) ||
        (props.target && props.target.sessionId) ||
        (props.value && props.value.sessionId) ||
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

    /** 侧栏图标入口：宿主会传 {size, active}。 */
    /** @param {any} props */
    function ProjectsPanelIcon(props) {
      var size = props && props.size ? props.size : 16;
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
            color: props && props.active ? T.accentText : "inherit",
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
    function ProjectsSettings(props) {
      var api = props.api;
      var t = props.t;
      var state = useState({ loading: true, describe: null, error: null });
      var view = state[0];
      var setView = state[1];

      useEffect(() => {
        call(api.ctx, "describe").then(
          (describe) => {
            setView({ loading: false, describe: describe, error: null });
          },
          (error) => {
            setView({
              loading: false,
              describe: null,
              error: String(error?.message ?? error),
            });
          },
        );
      }, [api]);

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
