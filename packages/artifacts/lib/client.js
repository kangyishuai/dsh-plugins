// @ts-check
// client 半：两个挂点
//   1) `tool.call.toolview` 的 keyed 行（按 wire 名 `artifact`）：一行摘要 + 「打开预览」；
//   2) 右栏页签类型 `artifact`：轮询宿主 `artifacts/latest`，同一个 iframe 原地换 srcDoc。
//
// 关键机制（本轮 spike 要验证的三件事）：
//   - 时间线只放摘要行，不试图改写已渲染的工具行；
//   - 预览在右栏面板里原地刷新（iframe 不重建、行数不增长）；
//   - 旧行与最新行都指向**同一个 artifact 的最新版本**（面板永远读 latest）。
//
// 宿主没有兜底 CSP，隔离由 sandbox="allow-scripts"（不透明源）自己焊。

window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-artifacts",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const PLUGIN_ID = "@kangyishuai/dsh-artifacts";
    const TAB_KIND = "artifact";
    const POLL_MS = 1000;

    /** 会话内最近打开的 artifact id：刷新/重启后恢复的页签没有 params，靠它回退（localStorage）。 */
    const RECENT_KEY = "dsh-artifacts:last-id:v1";

    /**
     * @param {any} value
     * @param {number} [depth]
     * @returns {string[]}
     */
    function collectStrings(value, depth = 0) {
      if (depth > 6 || value === null || value === undefined) return [];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
      if (typeof value === "object") {
        const out = [];
        for (const item of Object.values(value)) out.push(...collectStrings(item, depth + 1));
        return out;
      }
      return [];
    }

    /**
     * 从工具行的内容里认领 artifact id：结果文本第一行是 `artifact <id> · <title> · vN · B`。
     * 认不出就返回 undefined，由调用方回退到"最近一个 artifact"。
     * @param {any} props
     * @returns {string | undefined}
     */
    function pickId(props) {
      const text = collectStrings(props?.block).join("\n");
      const match = /artifact ([a-z0-9][a-z0-9-]*) ·/u.exec(text);
      return match === null ? undefined : match[1];
    }

    /**
     * 工件库：空 id 时的页签内容——封面网格。封面来自 /artifacts/<id>/cover.svg，
     * 由宿主用元数据合成 SVG，不依赖 headless 渲染器。
     * @param {any} props
     */
    function ArtifactLibrary(props) {
      const [rows, setRows] = React.useState(/** @type {any[]} */ ([]));
      const [error, setError] = React.useState("");
      const reload = React.useCallback(async () => {
        const result = await props.rpc("list");
        if (result?.ok !== true) {
          setError("读不到工件列表");
          return;
        }
        setRows(Array.isArray(result.artifacts) ? result.artifacts : []);
        setError("");
      }, [props]);
      React.useEffect(() => {
        void reload();
      }, [reload]);
      const buttonStyle = {
        font: "inherit",
        padding: "1px 8px",
        borderRadius: "6px",
        border: "1px solid rgba(128,128,128,0.35)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
      };
      return h(
        "div",
        {
          "data-dsh-artifact-library": "1",
          style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 12px",
              borderBottom: "1px solid rgba(128,128,128,0.28)",
              fontSize: "12px",
            },
          },
          h("strong", null, "全部工件"),
          h("span", { style: { opacity: 0.6 } }, String(rows.length)),
          h("span", { style: { flex: 1 } }),
          h(
            "button",
            {
              type: "button",
              "data-dsh-artifact-refresh": "1",
              onClick: () => void reload(),
              style: buttonStyle,
            },
            "刷新",
          ),
        ),
        error === ""
          ? null
          : h("div", { style: { padding: "8px 12px", fontSize: "12px", opacity: 0.7 } }, error),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(138px, 1fr))",
              gap: "10px",
              padding: "12px",
              overflow: "auto",
              minHeight: 0,
            },
          },
          rows.map((/** @type {any} */ row) =>
            h(
              "button",
              {
                key: row.id,
                type: "button",
                "data-dsh-artifact-card": row.id,
                onClick: () => props.open(row.id),
                title: row.title,
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: 0,
                  border: "1px solid rgba(128,128,128,0.3)",
                  borderRadius: "10px",
                  overflow: "hidden",
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  textAlign: "left",
                  minWidth: 0,
                },
              },
              h("img", {
                "data-dsh-artifact-cover": row.id,
                src: row.coverUrl,
                alt: "",
                width: 320,
                height: 200,
                style: { display: "block", width: "100%", height: "auto", aspectRatio: "16 / 10" },
              }),
              h(
                "div",
                { style: { padding: "6px 8px 8px", fontSize: "12px", minWidth: 0 } },
                h(
                  "div",
                  { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                  row.title,
                ),
                h(
                  "div",
                  { style: { opacity: 0.6, marginTop: "2px" } },
                  `v${row.latest} · ${row.bytes} B`,
                ),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * @param {any} args
     * @returns {any}
     */
    function PanelHeader(args) {
      const { state, id, open } = args;
      return h(
        "div",
        {
          "data-dsh-artifact-header": id ?? "",
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 12px",
            borderBottom: "1px solid rgba(128,128,128,0.28)",
            fontSize: "12px",
            minWidth: 0,
          },
        },
        h(
          "button",
          {
            "data-dsh-artifact-back": "1",
            type: "button",
            onClick: () => open(""),
            title: "全部工件",
            style: {
              font: "inherit",
              padding: "0 6px",
              borderRadius: "6px",
              border: "1px solid rgba(128,128,128,0.35)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            },
          },
          "‹",
        ),
        h(
          "strong",
          { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
          state.title || "Artifact",
        ),
        h(
          "code",
          { "data-dsh-artifact-version": String(state.version), style: { opacity: 0.75 } },
          `v${state.version}`,
        ),
        h("span", { style: { opacity: 0.6 } }, `${state.bytes ?? 0} B`),
        h("span", { style: { flex: 1 } }),
        h(
          "a",
          {
            "data-dsh-artifact-external": id ?? "",
            href: id ? `/artifacts/${encodeURIComponent(id)}` : "#",
            target: "_blank",
            rel: "noreferrer",
            style: { color: "inherit", textDecoration: "underline", whiteSpace: "nowrap" },
          },
          "浏览器打开",
        ),
      );
    }

    /**
     * 右栏页签本体：轮询宿主，版本变了只换 srcDoc，不换 iframe。
     * @param {any} props
     */
    function ArtifactPanel(props) {
      const info =
        typeof props.useTabInfo === "function" ? props.useTabInfo() : (props.tab ?? undefined);
      const params = info?.tab?.navigation?.params ?? {};
      const paramId = typeof params.id === "string" ? params.id : "";
      const wantsLibrary = params.view === "library";
      // 恢复的页签没有 params：回退到"上次打开的工件"，仍没有才显示库视图（不出现空白错误态）。
      const [restoredId] = React.useState(() =>
        paramId === "" && !wantsLibrary ? (readLast() ?? "") : "",
      );
      const id = paramId !== "" ? paramId : wantsLibrary ? "" : restoredId;
      const visible = info?.tab?.visible !== false;

      const [state, setState] = React.useState({
        title: "",
        version: 0,
        bytes: 0,
        html: "",
        error: "",
      });
      const versionRef = React.useRef(0);
      const frameRef = React.useRef(/** @type {any} */ (null));

      React.useEffect(() => {
        if (id === "") return undefined;
        let alive = true;
        /** @type {any} */
        let timer = null;
        const tick = async () => {
          const result = await props.rpc("latest", { id, since: versionRef.current });
          if (!alive || !result) return;
          if (result.ok !== true) {
            setState((/** @type {any} */ prev) => ({
              ...prev,
              error: String(result.message ?? "not found"),
            }));
            return;
          }
          if (result.changed !== true) return;
          versionRef.current = result.version;
          rememberLast(id);
          setState({
            title: String(result.title ?? ""),
            version: result.version,
            bytes: result.bytes ?? 0,
            html: String(result.html ?? ""),
            error: "",
          });
        };
        void tick();
        if (visible) timer = setInterval(() => void tick(), POLL_MS);
        return () => {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, [id, visible, props]);

      if (id === "") {
        return h(ArtifactLibrary, { rpc: props.rpc, open: props.open });
      }
      if (state.error !== "" && state.html === "") {
        return h(
          "div",
          {
            "data-dsh-artifact-error": state.error,
            style: { padding: "12px", fontSize: "12px", color: "inherit" },
          },
          `读不到这个 artifact：${state.error}`,
        );
      }
      return h(
        "div",
        {
          "data-dsh-artifact-panel": id,
          style: {
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
            minWidth: 0,
          },
        },
        h(PanelHeader, { state, id, open: props.open }),
        h("iframe", {
          ref: frameRef,
          "data-dsh-artifact-frame": id,
          title: state.title || id,
          sandbox: "allow-scripts",
          srcDoc: state.html,
          style: { flex: 1, width: "100%", border: "0", background: "#fff", minHeight: 0 },
        }),
      );
    }

    /**
     * 时间线摘要行：一行文字 + 一个按钮；按钮永远打开该 artifact 的最新版本。
     * @param {any} props
     */
    function ArtifactRow(props) {
      const id = pickId(props);
      const [latest, setLatest] = React.useState(0);
      const open = props.open;

      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          const result = await props.rpc("list");
          if (!alive || !result || result.ok !== true) return;
          const rows = Array.isArray(result.artifacts) ? result.artifacts : [];
          const target =
            id === undefined ? rows[0] : rows.find((/** @type {any} */ row) => row.id === id);
          if (target) setLatest(Number(target.latest) || 0);
        };
        void load();
        return () => {
          alive = false;
        };
      }, [id, props]);

      return h(
        "div",
        {
          "data-dsh-artifact-row": id ?? "",
          "data-dsh-artifact-row-version": String(latest),
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "4px 0",
            fontSize: "12px",
            minWidth: 0,
          },
        },
        h("span", { style: { opacity: 0.7, whiteSpace: "nowrap" } }, "Artifact"),
        id === undefined
          ? h("span", { style: { opacity: 0.6 } }, "（未识别 id）")
          : h(
              "code",
              {
                style: {
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                },
              },
              id,
            ),
        latest > 0
          ? h(
              "span",
              { "data-dsh-artifact-row-latest": String(latest), style: { opacity: 0.6 } },
              `最新 v${latest}`,
            )
          : null,
        h(
          "button",
          {
            "data-dsh-artifact-open": id ?? "",
            type: "button",
            onClick: () => open(id),
            style: {
              marginLeft: "auto",
              font: "inherit",
              padding: "1px 8px",
              borderRadius: "6px",
              border: "1px solid rgba(128,128,128,0.4)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            },
          },
          "打开预览",
        ),
      );
    }

    /** 记住本会话最近打开的 artifact id（刷新/重启后恢复的页签没有 params）。 @param {string} id */
    function rememberLast(id) {
      try {
        if (typeof id === "string" && id !== "") window.localStorage.setItem(RECENT_KEY, id);
      } catch {
        // 隐私模式/沙箱里不可写：忽略，面板退化为库视图。
      }
    }

    /** @returns {string | undefined} */
    function readLast() {
      try {
        const value = window.localStorage.getItem(RECENT_KEY);
        return typeof value === "string" && value !== "" ? value : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * @param {any} ctx
     */
    function apply(ctx) {
      /**
       * 统一解 `{ ok, value }` 信封；失败返回 undefined（调用方降级）。
       * @param {string} method
       * @param {any} [request]
       * @returns {Promise<any>}
       */
      async function rpc(method, request) {
        try {
          const channel = ctx.connection?.rpc;
          if (!channel || typeof channel.call !== "function") return undefined;
          const payload = request === undefined ? { args: {} } : { args: { request } };
          const result = await channel.call("/api", `artifacts/${method}`, payload);
          if (result && typeof result === "object" && Object.hasOwn(result, "value"))
            return result.value;
          return result;
        } catch {
          return undefined;
        }
      }

      /**
       * 打开（或聚焦）某个 artifact 的面板。
       * @param {string | undefined} id
       */
      function open(id) {
        (async () => {
          let target = id;
          if (target === undefined) {
            const listed = await rpc("list");
            target = listed?.artifacts?.[0]?.id;
          }
          if (target === undefined) return;
          if (target !== "") rememberLast(target);
          try {
            ctx.sidebarRight?.openTab?.(TAB_KIND, { params: target === "" ? {} : { id: target } });
          } catch {
            window.open(`/artifacts/${encodeURIComponent(target)}`, "_blank", "noopener");
          }
        })();
      }

      ctx.effect(
        () =>
          ctx.slots.inject("tool.call.toolview", () =>
            ctx.slots.register(
              { name: "tool.call.toolview", key: "artifact", inject: () => ({ rpc, open }) },
              ArtifactRow,
            ),
          ),
        "artifacts: tool row",
      );

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: TAB_KIND,
            title: (/** @type {any} */ address) => (address ? "Artifact" : "Artifacts"),
            guide: [
              {
                id: "artifact",
                order: 40,
                title: () => "Artifacts",
                description: () => "本地工件库：模型发布的页面都在这里",
              },
            ],
          }),
        "artifacts: sidebar tab type",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register(
              { name: "sidebar.right.pane.tab", key: PLUGIN_ID, inject: () => ({ rpc, open }) },
              ArtifactPanel,
            ),
          ),
        "artifacts: sidebar panel",
      );
    }

    exports.inject = ["slots", "locale", "connection", "sidebarRightTabs", "sidebarRight"];
    exports.apply = apply;
    return module.exports;
  },
});
