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
// 宿主没有兜底 CSP：隔离由两层自己焊——iframe `sandbox=""`（不含 `allow-scripts` /
// `allow-same-origin` 的不透明源，脚本不执行）+ 渲染前注入的文档级 CSP（自动请求/导航被拦；
// 用户点 `<a href>` 只会在预览 iframe 内自导航，碰不到宿主页面）。

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
     * 从工具结果文本里认领 artifact id：结果文本第一行是
     * `artifact <id> · <title> · vN · B · kind`（`lib/tool.js` 的 renderToolOutput）。
     *
     * id 由 `slugify` 生成、**刻意保留中文**（`q3-报告-2026`），所以不能用 ASCII 正则
     * （AUD-ARTIFACTS-01：历史 14/14 个真实产物都解析失败）。这里按「行首 `artifact ` 到
     * ` · `」切片，再做一次 id 边界校验：生成侧保证 id 不含空白与路径分隔符、不以点开头。
     * @param {string} text
     * @returns {string | undefined}
     */
    function pickIdFromText(text) {
      for (const rawLine of String(text ?? "").split("\n")) {
        const line = rawLine.trim();
        // `(.+?)` 惰性匹配到第一个 ` · `：id 里若出现 `·`（无空格）也不会截错。
        const match = /^artifact (.+?) · /u.exec(line);
        if (match === null) continue;
        const id = match[1];
        // 与 store.js 的 id 生成/校验同源的保守边界：非空、无空白、无路径分隔符、不以点开头。
        if (id === "" || id.startsWith(".") || /[\s/\\]/u.test(id)) return undefined;
        return id;
      }
      return undefined;
    }

    /**
     * 从工具行的内容里认领 artifact id；认不出返回 undefined，由调用方回退到"最近一个 artifact"。
     * 优先只扫 result 的 content（argsRaw 里嵌着正文，正文里写 `artifact xx ·` 不应劫持本行）。
     * @param {any} props
     * @returns {string | undefined}
     */
    function pickId(props) {
      const block = props?.block;
      /** @type {any[] | undefined} */
      const content = Array.isArray(block?.content) ? block.content : undefined;
      const text =
        content === undefined
          ? collectStrings(block).join("\n")
          : content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n");
      return pickIdFromText(text);
    }

    /**
     * 这次工具调用的 action（publish/append/list/read）。
     * 宿主在 start 阶段只给 `argsRaw`，result 阶段给 `call.argsRaw`（回填的 tool/call）。
     * 用轻量正则只取 `action` 字段：publish/append 的 argsRaw 可达 ~2 MiB（正文就在里面），
     * 行渲染阶段没必要整体 JSON.parse；解析失败也不抛。
     * @param {any} props
     * @returns {string | undefined}
     */
    function actionOf(props) {
      const block = props?.block;
      const raw =
        typeof block?.call?.argsRaw === "string"
          ? block.call.argsRaw
          : typeof block?.argsRaw === "string"
            ? block.argsRaw
            : "";
      const match = /"action"\s*:\s*"([a-z]+)"/u.exec(raw);
      return match === null ? undefined : match[1];
    }

    /**
     * list/read 的完整参数（只在要展示 id/version 时解析；这两类的 args 很小）。
     * @param {any} props
     * @returns {any}
     */
    function argsOf(props) {
      const block = props?.block;
      const raw =
        typeof block?.call?.argsRaw === "string"
          ? block.call.argsRaw
          : typeof block?.argsRaw === "string"
            ? block.argsRaw
            : "";
      if (raw === "") return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }

    /**
     * list/read 不是"写"：它们没有"打开这个产物"的语义，但**必须仍然渲染一行**。
     * 宿主 `tool.call.toolview` 是 keyed replacement point——组件返回 null 会让整张卡消失
     * （宿主 fallback 只在这个 key **没有**注册 entry 时生效），这两类调用（含失败信封）
     * 就会在时间线里完全不可见（复审 B2）。
     * @param {string | undefined} action
     * @returns {boolean}
     */
    function isInfoAction(action) {
      return action === "list" || action === "read";
    }

    /**
     * list/read 的中性行内容：`Artifact 列表 · 3 项` / `Artifact 读取 · <id> [vN]` /
     * `Artifact 列表失败 · <message>`。不拉 RPC、不给预览按钮（复审 B2）。
     * @param {any} props
     * @param {"list" | "read"} action
     * @returns {{ label: string, detail: string, error: string }}
     */
    function infoRowOf(props, action) {
      const block = props?.block;
      /** @type {any[]} */
      const content = Array.isArray(block?.content) ? block.content : [];
      const text = content
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("\n")
        .trim();
      // 工具失败走 `{ok:false}` 正常结果（不一定置 isError），正文首行是 `artifact failed: …`。
      const failure = /^artifact failed:\s*(.+)$/u.exec(text);
      const isError = block?.isError === true || failure !== null;
      const label = action === "list" ? "列表" : "读取";
      if (isError) {
        const message = failure === null ? "" : String(failure[1]).trim().split("\n")[0];
        return {
          label,
          detail: "",
          error: message === "" ? "失败" : `失败 · ${message.slice(0, 120)}`,
        };
      }
      /** @type {string} */
      let detail = "";
      if (action === "read") {
        const args = argsOf(props);
        const id = typeof args?.id === "string" ? args.id : "";
        const version = typeof args?.version === "number" ? args.version : undefined;
        if (id !== "") detail = version === undefined ? id : `${id} v${version}`;
      } else {
        const count = /^(\d+) artifact\(s\)/u.exec(text);
        if (count !== null) detail = `${count[1]} 项`;
        else if (/^No artifacts yet\./u.test(text)) detail = "0 项";
      }
      return { label, detail, error: "" };
    }

    /**
     * 面板 iframe 的文档级 CSP（AUD-ARTIFACTS-03）。srcDoc 不继承宿主文档 CSP；脚本另有
     * **sandbox（无 allow-scripts）** 兜底，这里是第二道闸，不是唯一防线。
     * 与只读路由同口径（路由的 `frame-ancestors` 在 meta 里无效，面板本身就在 sandbox iframe 里）：
     *   - `default-src 'none'` + 显式 `script-src 'none'`：禁止脚本与外连；
     *   - `style-src 'unsafe-inline'` / `img-src data: blob:` / `font-src data:`：保留自包含页面的样式与图片；
     *   - `base-uri 'none'`：禁止 `<base href>` 改写相对链接/导航（default-src **不**覆盖 base-uri）；
     *   - `form-action 'none'`：表单提交同样掐掉（sandbox 也挡，双保险）。
     */
    const PANEL_CSP = [
      "default-src 'none'",
      "script-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      "font-src data:",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
    const PANEL_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`;

    /**
     * 把 CSP meta 放到**任何不可信字节之前**（复审 B1）：DOCTYPE 之后（有的话），否则文档开头
     * （只跳过 BOM/前导空白）。不要"找 `<head>` 再插"——产物只要在注释/属性值/脚本字符串里
     * 更早写一个 `<head`，meta 就会落进无效位置、策略完全不生效。
     *
     * **始终注入**：多份 CSP 是"同时强制"（取交集），作者自己写宽松 CSP 也绕不过。
     * @param {string} html
     * @returns {string}
     */
    function withPanelCsp(html) {
      const source = typeof html === "string" ? html : "";
      const doctype = /^(?:\uFEFF)?\s*<!doctype[^>]*>/iu.exec(source);
      const at = doctype === null ? (source.startsWith("\uFEFF") ? 1 : 0) : doctype[0].length;
      return `${source.slice(0, at)}${PANEL_CSP_META}${source.slice(at)}`;
    }

    /**
     * html 预览 iframe 的属性（抽出来是为了单测能直接断言 srcDoc/CSP/sandbox）。
     * `sandbox: ""` = 完全沙箱（不含 `allow-scripts` / `allow-same-origin`）：不透明源、
     * 脚本不执行，样式与图片不受影响。这是 AUD-ARTIFACTS-03 的硬保证，CSP meta 只是第二道闸。
     * @param {string} id
     * @param {string} title
     * @param {string} html
     * @returns {Record<string, any>}
     */
    function htmlFrameProps(id, title, html) {
      return {
        "data-dsh-artifact-frame": id,
        title: title || id,
        sandbox: "",
        srcDoc: withPanelCsp(html),
        style: { flex: 1, width: "100%", border: "0", background: "#fff", minHeight: 0 },
      };
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

    /** 时间线行容器（写摘要行与 list/read 中性行共用）。 */
    const ROW_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "4px 0",
      fontSize: "12px",
      minWidth: 0,
    };

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
              // 窄窗口/窄右栏下类型筛选会溢出视口（USIM-U3-12）：允许换行，不把按钮推出屏幕。
              flexWrap: "wrap",
              rowGap: "6px",
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
        body = h("iframe", { ref: frameRef, ...htmlFrameProps(id, state.title || id, state.html) });
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
      const action = actionOf(props);
      // list/read 不认领 artifact id（正文是列表/整份内容，不是摘要行），也不拉 RPC。
      const id = isInfoAction(action) ? undefined : pickId(props);
      const [latest, setLatest] = React.useState(0);
      const [kind, setKind] = React.useState("html");
      const open = props.open;

      React.useEffect(() => {
        // list/read 的中性行不需要列表 RPC（复审 B2：保留可见性，但不放大 I/O）。
        if (isInfoAction(actionOf(props))) return undefined;
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

      // hooks 必须无条件调用（宿主可能在 start→result 阶段重渲染同一行），所以先跑完 hooks 再分支。
      if (isInfoAction(action)) {
        const info = infoRowOf(props, /** @type {"list" | "read"} */ (action));
        return h(
          "div",
          {
            "data-dsh-artifact-row-info": action,
            "data-dsh-artifact-row-info-state": info.error === "" ? "ok" : "error",
            style: ROW_STYLE,
          },
          h("span", { style: { opacity: 0.7, whiteSpace: "nowrap" } }, "Artifact"),
          h(
            "span",
            { "data-dsh-artifact-row-info-label": action, style: { opacity: 0.6 } },
            info.label,
          ),
          info.detail === ""
            ? null
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
                info.detail,
              ),
          info.error === ""
            ? null
            : h(
                "span",
                {
                  "data-dsh-artifact-row-info-error": action,
                  style: { opacity: 0.6, whiteSpace: "nowrap" },
                },
                info.error,
              ),
        );
      }

      return h(
        "div",
        {
          "data-dsh-artifact-row": id ?? "",
          "data-dsh-artifact-row-version": String(latest),
          style: ROW_STYLE,
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
    // 单测入口（test/client.test.js 用 node:vm 执行真实源码）：只暴露纯函数与行组件。
    // 仅测试用、生产无副作用：不挂 window 全局、不暴露服务/数据，宿主只消费 inject/apply；
    // 若将来要求发布包零测试面，可改为 debug 开关挂载（复审 F13，目前接受这点体积/暴露面）。
    exports.__test = {
      collectStrings,
      pickId,
      pickIdFromText,
      actionOf,
      argsOf,
      isInfoAction,
      infoRowOf,
      withPanelCsp,
      htmlFrameProps,
      ArtifactRow,
    };
    return module.exports;
  },
});
