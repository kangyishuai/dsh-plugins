// @ts-check
// client 半：两个挂点
//   1) `tool.call.toolview` 的 keyed 行（按 wire 名 `artifact`）：一行摘要 + 「打开预览」；
//   2) 右栏页签类型 `artifact`：库视图（可按 projectId 过滤）+ 预览视图，轮询宿主 `artifacts/latest`。
//
// 关键机制：
//   - 时间线只放摘要行，不试图改写已渲染的工具行；
//   - 预览在右栏面板里原地刷新（html 用同一个 iframe 换 srcDoc；文本用 <pre>；图片用 <img>）；
//   - 旧行与最新行都指向**同一个 artifact 的最新版本**（面板永远读 latest）；
//   - 0.2 起库视图是"列表 + 缩略图"，并接受 `{ projectId }` 参数：项目页可以打开"本项目产物"，
//     不再只有全局封面网格。搜索/类型过滤走宿主过滤（不是前端假过滤）。
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
    const KINDS = ["html", "markdown", "json", "csv", "image"];

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
     * 从工具行的内容里认领 artifact id：结果文本第一行是 `artifact <id> · <title> · vN · B · kind`。
     * 认不出就返回 undefined，由调用方回退到"最近一个 artifact"。
     * @param {any} props
     * @returns {string | undefined}
     */
    function pickId(props) {
      const text = collectStrings(props?.block).join("\n");
      const match = /artifact ([a-z0-9][a-z0-9-]*) ·/u.exec(text);
      return match === null ? undefined : match[1];
    }

    /** @param {string} id @returns {string} */
    const previewUrlOf = (id) => `/artifacts/${encodeURIComponent(id)}`;

    /**
     * 字节数 → 人能读的单位（库汇总用）。
     * @param {number} bytes
     * @returns {string}
     */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return "0 B";
      if (value < 1024) return `${Math.round(value)} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    }

    /**
     * @param {number} at
     * @returns {string}
     */
    function formatTime(at) {
      if (!Number.isFinite(at) || at <= 0) return "";
      try {
        return new Date(at).toLocaleString();
      } catch {
        return "";
      }
    }

    const BUTTON = {
      font: "inherit",
      padding: "1px 8px",
      borderRadius: "6px",
      border: "1px solid rgba(128,128,128,0.35)",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
    };

    /**
     * 工件库：列表视图。`projectId` 非空时只显示该项目的产物（项目级 Library 的入口形态）；
     * 顶部给条数与体积汇总（宿主 `artifacts/list` 的 summary），搜索/类型过滤走宿主过滤。
     * @param {any} props
     */
    function ArtifactLibrary(props) {
      const projectId = typeof props.projectId === "string" ? props.projectId : "";
      const [rows, setRows] = React.useState(/** @type {any[]} */ ([]));
      const [summary, setSummary] = React.useState({ count: 0, bytes: 0 });
      const [query, setQuery] = React.useState("");
      const [kind, setKind] = React.useState("");
      const [error, setError] = React.useState("");
      const rpc = props.rpc;

      const load = React.useCallback(
        /** @returns {Promise<void>} */
        async () => {
          /** @type {any} */
          const request = {};
          if (projectId !== "") request.projectId = projectId;
          if (query.trim() !== "") request.title = query.trim();
          if (kind !== "") request.kind = kind;
          const result = await rpc("list", request);
          if (result?.ok !== true) {
            setError("读不到工件列表");
            return;
          }
          const listed = Array.isArray(result.artifacts) ? result.artifacts : [];
          setRows(listed);
          setSummary({
            count: Number(result.summary?.count ?? listed.length) || 0,
            bytes: Number(result.summary?.bytes ?? 0) || 0,
          });
          setError("");
        },
        [projectId, query, kind, rpc],
      );

      React.useEffect(() => {
        // 输入框用 200ms 去抖：搜索是宿主过滤，每敲一个字就 RPC 一次没必要。
        const timer = setTimeout(() => void load(), query.trim() === "" ? 0 : 200);
        return () => clearTimeout(timer);
      }, [load, query]);

      return h(
        "div",
        {
          "data-dsh-artifact-library": "1",
          "data-dsh-artifact-library-scope": projectId === "" ? "all" : projectId,
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
              minWidth: 0,
            },
          },
          h(
            "strong",
            { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
            projectId === "" ? "全部工件" : `项目产物 · ${projectId}`,
          ),
          h(
            "span",
            { "data-dsh-artifact-summary": String(summary.count), style: { opacity: 0.65 } },
            `${summary.count} 条 · ${formatBytes(summary.bytes)}`,
          ),
          h("span", { style: { flex: 1 } }),
          h(
            "button",
            {
              type: "button",
              "data-dsh-artifact-refresh": "1",
              onClick: () => void load(),
              style: BUTTON,
            },
            "刷新",
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderBottom: "1px solid rgba(128,128,128,0.18)",
              fontSize: "12px",
              minWidth: 0,
            },
          },
          h("input", {
            "data-dsh-artifact-search": "1",
            "aria-label": "按标题搜索工件",
            type: "search",
            value: query,
            placeholder: "按标题搜索",
            onChange: (/** @type {any} */ event) => setQuery(event.target.value),
            style: {
              font: "inherit",
              flex: 1,
              minWidth: 0,
              padding: "2px 6px",
              borderRadius: "6px",
              border: "1px solid rgba(128,128,128,0.35)",
              background: "transparent",
              color: "inherit",
            },
          }),
          h(
            "button",
            {
              type: "button",
              "data-dsh-artifact-kind-filter": "all",
              "aria-pressed": kind === "" ? "true" : "false",
              "aria-label": "显示全部类型",
              onClick: () => setKind(""),
              style: { ...BUTTON, opacity: kind === "" ? 1 : 0.6 },
            },
            "全部",
          ),
          ...KINDS.map((value) =>
            h(
              "button",
              {
                key: value,
                type: "button",
                "data-dsh-artifact-kind-filter": value,
                "aria-pressed": kind === value ? "true" : "false",
                "aria-label": `只看 ${value} 类型`,
                onClick: () => setKind(kind === value ? "" : value),
                style: { ...BUTTON, opacity: kind === value ? 1 : 0.6 },
              },
              value,
            ),
          ),
        ),
        error === ""
          ? null
          : h(
              "div",
              {
                "data-dsh-artifact-list-error": "1",
                style: { padding: "8px 12px", fontSize: "12px", opacity: 0.7 },
              },
              error,
            ),
        rows.length === 0
          ? h(
              "div",
              {
                "data-dsh-artifact-empty": "1",
                style: { padding: "16px 12px", fontSize: "12px", opacity: 0.65 },
              },
              error === "" ? (projectId === "" ? "还没有工件。" : "这个项目还没有产物。") : "",
            )
          : h(
              "div",
              {
                "data-dsh-artifact-list": "1",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  padding: "6px",
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
                    "data-dsh-artifact-card-kind": row.kind ?? "html",
                    onClick: () => props.open(row.id, projectId === "" ? undefined : projectId),
                    title: row.title,
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "6px",
                      border: "1px solid rgba(128,128,128,0.25)",
                      borderRadius: "8px",
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
                    style: {
                      display: "block",
                      width: "64px",
                      height: "40px",
                      objectFit: "cover",
                      borderRadius: "4px",
                      flex: "none",
                    },
                  }),
                  h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 } },
                    h(
                      "div",
                      {
                        style: {
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontSize: "12px",
                        },
                      },
                      row.title,
                    ),
                    h(
                      "div",
                      {
                        style: {
                          opacity: 0.6,
                          marginTop: "2px",
                          fontSize: "11px",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        },
                      },
                      [
                        row.kind ?? "html",
                        `v${row.latest}`,
                        formatBytes(row.bytes),
                        row.projectId ? row.projectId : null,
                        formatTime(row.updatedAt),
                      ]
                        .filter((part) => part !== null && part !== "")
                        .join(" · "),
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
      const { state, id, open, projectId } = args;
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
            onClick: () => open("", projectId === "" ? undefined : projectId),
            title: "返回工件库",
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
          { "data-dsh-artifact-kind": state.kind ?? "html", style: { opacity: 0.8 } },
          state.kind ?? "html",
        ),
        h(
          "code",
          { "data-dsh-artifact-version": String(state.version), style: { opacity: 0.75 } },
          `v${state.version}`,
        ),
        h("span", { style: { opacity: 0.6 } }, formatBytes(state.bytes ?? 0)),
        h("span", { style: { flex: 1 } }),
        state.previewUrl
          ? h(
              "a",
              {
                "data-dsh-artifact-download": id ?? "",
                href: `${state.previewUrl}?download=1`,
                rel: "noreferrer",
                style: { color: "inherit", textDecoration: "underline", whiteSpace: "nowrap" },
              },
              "下载",
            )
          : null,
        h(
          "a",
          {
            "data-dsh-artifact-external": id ?? "",
            href: state.previewUrl ?? (id ? previewUrlOf(id) : "#"),
            target: "_blank",
            rel: "noreferrer",
            style: { color: "inherit", textDecoration: "underline", whiteSpace: "nowrap" },
          },
          "浏览器打开",
        ),
      );
    }

    /**
     * 右栏页签本体：轮询宿主，版本变了只换内容。
     * html → 同一个 iframe 换 srcDoc；文本类型 → <pre>；图片 → <img>（走只读路由，不把二进制搬进 RPC）。
     * @param {any} props
     */
    function ArtifactPanel(props) {
      const info =
        typeof props.useTabInfo === "function" ? props.useTabInfo() : (props.tab ?? undefined);
      const params = info?.tab?.navigation?.params ?? {};
      const paramId = typeof params.id === "string" ? params.id : "";
      const projectId = typeof params.projectId === "string" ? params.projectId : "";
      // `{ projectId }` 不带 id 时也进库视图（项目页就这么开：只看本项目产物）。
      const wantsLibrary = params.view === "library" || (paramId === "" && projectId !== "");
      // 恢复的页签没有 params：回退到"上次打开的工件"，仍没有才显示库视图（不出现空白错误态）。
      const [restoredId] = React.useState(() =>
        paramId === "" && !wantsLibrary ? (readLast() ?? "") : "",
      );
      const id = paramId !== "" ? paramId : wantsLibrary ? "" : restoredId;
      const visible = info?.tab?.visible !== false;

      const [state, setState] = React.useState({
        title: "",
        kind: "html",
        mime: "",
        version: 0,
        bytes: 0,
        html: "",
        text: "",
        previewUrl: "",
        error: "",
      });
      const versionRef = React.useRef(0);
      const frameRef = React.useRef(/** @type {any} */ (null));

      // 切换到另一个工件时清空版本游标与内容：否则两个工件都在 v1 时 `since` 会命中"没变"，
      // 面板还显示上一个工件的正文。
      React.useEffect(() => {
        versionRef.current = 0;
        setState({
          title: "",
          kind: "html",
          mime: "",
          version: 0,
          bytes: 0,
          html: "",
          text: "",
          previewUrl: "",
          error: "",
        });
      }, [id]);

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
          const kind = String(result.kind ?? "html");
          const text = String(result.text ?? result.html ?? "");
          if (result.changed !== true) {
            // 版本没变：只补一次类型/URL（恢复的页签首帧拿到的可能是 changed:false）。
            setState((/** @type {any} */ prev) =>
              prev.version === result.version && prev.kind === kind
                ? prev
                : {
                    ...prev,
                    title: String(result.title ?? prev.title),
                    kind,
                    mime: String(result.mime ?? ""),
                    version: result.version,
                    bytes: result.bytes ?? prev.bytes,
                    previewUrl: String(result.previewUrl ?? prev.previewUrl),
                  },
            );
            return;
          }
          versionRef.current = result.version;
          rememberLast(id);
          setState({
            title: String(result.title ?? ""),
            kind,
            mime: String(result.mime ?? ""),
            version: result.version,
            bytes: result.bytes ?? 0,
            html: kind === "html" ? text : "",
            text: kind === "html" ? "" : text,
            previewUrl: String(result.previewUrl ?? previewUrlOf(id)),
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
        return h(ArtifactLibrary, {
          rpc: props.rpc,
          open: props.open,
          projectId,
        });
      }
      if (state.error !== "" && state.html === "" && state.text === "") {
        return h(
          "div",
          {
            "data-dsh-artifact-error": state.error,
            style: { padding: "12px", fontSize: "12px", color: "inherit" },
          },
          `读不到这个 artifact：${state.error}`,
        );
      }
      /** @type {any} */
      let body = null;
      if (state.kind === "html") {
        body = h("iframe", {
          ref: frameRef,
          "data-dsh-artifact-frame": id,
          title: state.title || id,
          sandbox: "allow-scripts",
          srcDoc: state.html,
          style: { flex: 1, width: "100%", border: "0", background: "#fff", minHeight: 0 },
        });
      } else if (state.kind === "image") {
        body =
          state.previewUrl === ""
            ? null
            : h("img", {
                "data-dsh-artifact-image": id,
                src: state.previewUrl,
                alt: state.title || id,
                style: {
                  display: "block",
                  maxWidth: "100%",
                  objectFit: "contain",
                  alignSelf: "center",
                },
              });
      } else {
        body = h(
          "pre",
          {
            "data-dsh-artifact-text": state.kind,
            style: {
              flex: 1,
              margin: 0,
              padding: "10px 12px",
              overflow: "auto",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
              minHeight: 0,
              color: "inherit",
            },
          },
          state.text,
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
        h(PanelHeader, { state, id, open: props.open, projectId }),
        body,
      );
    }

    /**
     * 时间线摘要行：一行文字 + 一个按钮；按钮永远打开该 artifact 的最新版本。
     * @param {any} props
     */
    function ArtifactRow(props) {
      const id = pickId(props);
      const [latest, setLatest] = React.useState(0);
      const [kind, setKind] = React.useState("html");
      const open = props.open;

      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          const result = await props.rpc("list");
          if (!alive || !result || result.ok !== true) return;
          const rows = Array.isArray(result.artifacts) ? result.artifacts : [];
          const target =
            id === undefined ? rows[0] : rows.find((/** @type {any} */ row) => row.id === id);
          if (target) {
            setLatest(Number(target.latest) || 0);
            setKind(String(target.kind ?? "html"));
          }
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
        h("span", { "data-dsh-artifact-row-kind": kind, style: { opacity: 0.6 } }, kind),
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

    /**
     * 调试钩子开关：只有显式打开时才把 `window.__dshArtifactsOpenTab` 挂出去，
     * 发布包里默认**没有**任何 window 全局（与仓库其它插件一致）。
     * 打开方式二选一：`localStorage["dsh-artifacts:debug"] = "1"`，或页面 URL 带 `?debug=1`。
     * @returns {boolean}
     */
    function debugHookEnabled() {
      try {
        if (window.localStorage.getItem("dsh-artifacts:debug") === "1") return true;
      } catch {
        // 隐私模式/localStorage 不可读：看 URL。
      }
      try {
        return /[?&]debug=1(?:&|$)/u.test(String(window.location?.search ?? ""));
      } catch {
        return false;
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
       * 打开（或聚焦）页签。`id` 为空 = 库视图；`projectId` 让库视图只显示该项目的产物。
       * 其它插件的 client 也能用同一形态：`ctx.sidebarRight.openTab("artifact", { params: { projectId } })`。
       * @param {string | undefined} id
       * @param {string} [projectId]
       */
      function open(id, projectId) {
        (async () => {
          /** @type {Record<string, string>} */
          const params = {};
          if (typeof projectId === "string" && projectId !== "") params.projectId = projectId;
          if (id !== undefined && id !== "") {
            params.id = id;
            rememberLast(id);
          } else {
            params.view = "library";
          }
          try {
            ctx.sidebarRight?.openTab?.(TAB_KIND, { params });
          } catch {
            if (typeof params.id === "string")
              window.open(previewUrlOf(params.id), "_blank", "noopener");
          }
        })();
      }

      /**
       * E2E 调试钩子：把「用参数打开页签」挂到 window（只暴露导航，不暴露数据/服务）。
       * 冒烟要断言"按 projectId 过滤的库视图"与多类型预览，而页面上下文没有别的入口能带 params
       * 打开页签。**默认不挂**，需 `debugHookEnabled()`：`dsh-artifacts:debug=1` 或 `?debug=1`。
       * 用法见 docs/testing/artifacts.md §1.3。
       */
      if (debugHookEnabled()) {
        try {
          /** @type {any} */ (window).__dshArtifactsOpenTab = (/** @type {any} */ params) =>
            open(params?.id, params?.projectId);
        } catch {
          // 只读/受限沙箱里挂不上：忽略（只有冒烟会用到）。
        }
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
                description: () => "本地工件库：模型发布的页面与产物都在这里",
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
