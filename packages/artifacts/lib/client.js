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

    /** @type {{ updates: number, frameLoads: number, renders: number, mounts: number, unmounts: number, lastVersion: number, errors: string[] }} */
    const probe = {
      updates: 0,
      frameLoads: 0,
      renders: 0,
      mounts: 0,
      unmounts: 0,
      lastVersion: 0,
      errors: [],
    };

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
     * @param {any} args
     * @returns {any}
     */
    function PanelHeader(args) {
      const { state, id } = args;
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
      const id = typeof params.id === "string" ? params.id : "";
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
        probe.renders += 1;
      });

      // 挂载/卸载计数：用来证明连续更新时 iframe 没有重建（同一个元素、同一个 React 实例）。
      React.useEffect(() => {
        probe.mounts += 1;
        return () => {
          probe.unmounts += 1;
        };
      }, []);

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
          probe.updates += 1;
          probe.lastVersion = result.version;
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
        return h(
          "div",
          { style: { padding: "12px", fontSize: "12px", opacity: 0.7 } },
          "没有选中 artifact。",
        );
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
        h(PanelHeader, { state, id }),
        h("iframe", {
          ref: frameRef,
          "data-dsh-artifact-frame": id,
          title: state.title || id,
          sandbox: "allow-scripts",
          srcDoc: state.html,
          onLoad: () => {
            probe.frameLoads += 1;
          },
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
        } catch (error) {
          probe.errors.push(String(error));
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
          try {
            ctx.sidebarRight?.openTab?.(TAB_KIND, { params: { id: target } });
          } catch (error) {
            probe.errors.push(String(error));
            window.open(`/artifacts/${encodeURIComponent(target)}`, "_blank", "noopener");
          }
        })();
      }

      // spike 探针：供 CDP/冒烟脚本驱动与断言；正式版删除。
      /** @type {any} */ (window).__dshArtifacts = {
        rpc,
        open,
        probe,
        appendDev: (/** @type {string} */ id, /** @type {string} */ html) =>
          rpc("appendDev", { id, html }),
        list: () => rpc("list"),
      };

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
            title: () => "Artifact",
          }),
        "artifacts: sidebar tab type",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register(
              { name: "sidebar.right.pane.tab", key: PLUGIN_ID, inject: () => ({ rpc }) },
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
