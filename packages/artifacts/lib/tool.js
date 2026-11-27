// @ts-check
// `artifact` 工具：模型侧做五件事——publish / append / list / read（外加 list 的过滤）。
//
// 与 Claude 的 20+ action 单工具相比，这个插件刻意只留少数动词：
//   - 模型一次只写一页，不需要 share / comments / watch / db；
//   - schema 越小，常驻上下文越省（Claude 的 Artifact 工具 ~12k tokens，社区 1007↑ 抱怨）；
//   - 原地更新靠"同一 id 追加版本"，不靠改写已渲染的工具行。
//
// 0.2 新增（对应 artifacts 0.2 需求）：
//   - `kind` = html / markdown / json / csv / image（默认 html，旧 `html` 参数继续可用）；
//   - 归属：`projectId` / `threadId` 由调用方显式给，`sessionId` / `toolCallId` 从工具上下文推导
//     （`exec.agent.id` 与 `exec.callId`），写进 meta 与每个版本；
//   - `list` 支持按 projectId / kind / title 过滤（与 Remote `artifacts/list` 同一套过滤语义）。
//
// 受支持的 JSON Schema 关键字是子集：type/oneOf/properties/required/additionalProperties/items/enum/const。
// 不吃 minimum / maximum（宿主会静默拒绝注册）。
import {
  ArtifactError,
  latestBytes,
  MAX_BYTES,
  normalizeKind,
  summarizeArtifacts,
} from "./store.js";

export const TOOL_NAME = "artifact";

export const TOOL_DESCRIPTION = [
  "Publish or update a local artifact the user can open beside the conversation: a self-contained HTML page,",
  "or a markdown / json / csv / image deliverable.",
  "Use it when the result is easier to look at than to read (report, dashboard, walkthrough, comparison).",
  "`publish` creates a new artifact from `content` (or `html` for kind=html); `append` adds a new version to the same id (the previous version is kept);",
  "`list` returns known artifacts (filterable by projectId / kind / title); `read` returns one version's content.",
  "Images are passed as a data: URL or bare base64 in `content` with `kind`=image.",
  "The file is stored under the DSH data root, never uploaded anywhere.",
].join(" ");

export const TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: Object.freeze({
    action: Object.freeze({
      type: "string",
      enum: Object.freeze(["publish", "append", "list", "read"]),
      description:
        "publish = new artifact; append = new version of an existing id; list = index; read = latest or one version.",
    }),
    title: Object.freeze({
      type: "string",
      description:
        "Short noun phrase shown in the list and the panel header. For `list` it filters by substring.",
    }),
    kind: Object.freeze({
      type: "string",
      enum: Object.freeze(["html", "markdown", "json", "csv", "image"]),
      description: "Artifact type; defaults to html. For `list` it filters by type.",
    }),
    content: Object.freeze({
      type: "string",
      description:
        "Payload: text for html/markdown/json/csv, or a data: URL / base64 blob for image. Max 2 MiB after decoding.",
    }),
    html: Object.freeze({
      type: "string",
      description: "Legacy alias of `content` for kind=html (kept for compatibility).",
    }),
    mime: Object.freeze({
      type: "string",
      description: "Image MIME type when `content` is bare base64 (image/png, image/jpeg, ...).",
    }),
    projectId: Object.freeze({
      type: "string",
      description:
        "Owning project id, if the caller belongs to one. For `list` it filters by project.",
    }),
    threadId: Object.freeze({
      type: "string",
      description: "Owning thread id, when the caller tracks threads separately from sessions.",
    }),
    id: Object.freeze({ type: "string", description: "Artifact id, for append/read." }),
    version: Object.freeze({
      type: "integer",
      description: "Version to read; omit for the latest.",
    }),
  }),
  required: Object.freeze(["action"]),
  additionalProperties: false,
});

export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    ok: Object.freeze({ type: "boolean" }),
    action: Object.freeze({ type: "string" }),
    id: Object.freeze({ type: "string" }),
    title: Object.freeze({ type: "string" }),
    kind: Object.freeze({ type: "string" }),
    version: Object.freeze({ type: "integer" }),
    bytes: Object.freeze({ type: "integer" }),
    url: Object.freeze({ type: "string" }),
    code: Object.freeze({ type: "string" }),
    error: Object.freeze({ type: "string" }),
    text: Object.freeze({ type: "string" }),
    html: Object.freeze({ type: "string" }),
    projectId: Object.freeze({ type: "string" }),
    count: Object.freeze({ type: "integer" }),
    summary: Object.freeze({
      type: "object",
      properties: Object.freeze({
        count: Object.freeze({ type: "integer" }),
        bytes: Object.freeze({ type: "integer" }),
      }),
      required: Object.freeze(["count", "bytes"]),
      additionalProperties: true,
    }),
    artifacts: Object.freeze({
      type: "array",
      items: Object.freeze({
        type: "object",
        properties: Object.freeze({
          id: Object.freeze({ type: "string" }),
          title: Object.freeze({ type: "string" }),
          kind: Object.freeze({ type: "string" }),
          latest: Object.freeze({ type: "integer" }),
          bytes: Object.freeze({ type: "integer" }),
          projectId: Object.freeze({ type: "string" }),
        }),
        required: Object.freeze(["id", "title", "latest"]),
        additionalProperties: true,
      }),
    }),
  }),
  required: Object.freeze(["ok", "action"]),
  additionalProperties: true,
});

/**
 * 把 `data:image/png;base64,xxxx` 或裸 base64 解成字节。
 * @param {string} content
 * @param {string | undefined} declaredMime
 * @returns {{ data: Buffer, mime: string | undefined }}
 */
export function decodeImageContent(content, declaredMime) {
  const raw = String(content ?? "").trim();
  const dataUrl = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9=.+-]+)*),(.*)$/isu.exec(raw);
  if (dataUrl !== null) {
    const head = dataUrl[2] ?? "";
    const body = dataUrl[3] ?? "";
    const isBase64 = /;\s*base64/iu.test(head);
    return {
      data: isBase64
        ? Buffer.from(body.replace(/\s+/gu, ""), "base64")
        : Buffer.from(decodeURIComponent(body), "utf8"),
      mime: dataUrl[1],
    };
  }
  const compact = raw.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact))
    throw new Error("image content must be a data: URL or base64");
  return { data: Buffer.from(compact, "base64"), mime: declaredMime };
}

/**
 * 模型可读的结果文本。刻意短：正文在页面里，工具结果只放身份与下一步。
 * @param {unknown} _args
 * @param {any} value
 * @returns {Array<{ type: "text", text: string }>}
 */
export function renderToolOutput(_args, value) {
  if (value?.ok !== true) {
    return [{ type: "text", text: `artifact failed: ${String(value?.error ?? "unknown error")}` }];
  }
  if (value.action === "list") {
    const rows = Array.isArray(value.artifacts) ? value.artifacts : [];
    if (rows.length === 0) return [{ type: "text", text: "No artifacts yet." }];
    const summary = value.summary;
    const head =
      summary === undefined
        ? `${rows.length} artifact(s):`
        : `${summary.count} artifact(s), ${summary.bytes} B total:`;
    return [
      {
        type: "text",
        text: [
          head,
          ...rows.map(
            (/** @type {any} */ row) =>
              `- ${row.id} · ${row.title} · ${row.kind ?? "html"} · v${row.latest} · ${row.bytes} B${
                row.projectId ? ` · ${row.projectId}` : ""
              }`,
          ),
        ].join("\n"),
      },
    ];
  }
  if (value.action === "read") {
    return [{ type: "text", text: String(value.text ?? value.html ?? "") }];
  }
  const lines = [
    `artifact ${value.id} · ${value.title} · v${value.version} · ${value.bytes} B · ${value.kind ?? "html"}`,
  ];
  if (typeof value.url === "string" && value.url !== "") lines.push(`url: ${value.url}`);
  lines.push("The preview panel shows the latest version; older rows stay linked to it.");
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * 从 ToolRunContext 里取"这是谁产出的"：会话 id 与本次工具调用 id。
 * 宿主字段：`exec.agent.id`（Agent = { id: SessionId }）与 `exec.callId`。
 * @param {any} exec
 * @returns {import("./store.js").ArtifactSource}
 */
function sourceOf(exec) {
  /** @type {import("./store.js").ArtifactSource} */
  const source = { via: "tool" };
  const sessionId = exec?.agent?.id ?? exec?.sessionId;
  if (typeof sessionId === "string" && sessionId !== "") source.sessionId = sessionId;
  if (typeof exec?.callId === "string" && exec.callId !== "") source.toolCallId = exec.callId;
  return source;
}

/**
 * @param {{ store: any, baseUrl: () => string }} deps
 * @returns {any}
 */
export function createToolDefinition({ store, baseUrl }) {
  /**
   * @param {any} args
   * @returns {{ kind: string | undefined, data: Buffer | undefined, mime: string | undefined, content: string | undefined }}
   */
  function payloadOf(args) {
    const kind = typeof args?.kind === "string" && args.kind !== "" ? args.kind : undefined;
    if (kind !== undefined && normalizeKind(kind) === undefined)
      throw new ArtifactError("artifacts/unsupported-kind", `unsupported artifact kind: ${kind}`);
    if (kind === "image") {
      const decoded = decodeImageContent(args?.content ?? "", args?.mime);
      return { kind, data: decoded.data, mime: decoded.mime ?? args?.mime, content: undefined };
    }
    const content = typeof args?.content === "string" ? args.content : args?.html;
    return { kind, data: undefined, mime: undefined, content };
  }

  /**
   * @param {any} args
   * @param {any} exec
   * @returns {Record<string, unknown>}
   */
  function attributionOf(args, exec) {
    /** @type {Record<string, unknown>} */
    const patch = { source: sourceOf(exec) };
    const sessionId = exec?.agent?.id;
    if (typeof sessionId === "string" && sessionId !== "") patch.sessionId = sessionId;
    if (typeof args?.projectId === "string" && args.projectId.trim() !== "")
      patch.projectId = args.projectId.trim();
    if (typeof args?.threadId === "string" && args.threadId.trim() !== "")
      patch.threadId = args.threadId.trim();
    return patch;
  }

  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolOutput },
    /**
     * @param {any} args
     * @param {any} exec
     * @returns {Promise<any>}
     */
    execute: async (args, exec) => {
      const action = String(args?.action ?? "");
      const urlOf = (/** @type {string} */ id) =>
        `${baseUrl()}/artifacts/${encodeURIComponent(id)}`;
      try {
        if (action === "publish" || action === "append") {
          const payload = payloadOf(args);
          /** @type {any} */
          const input = {
            title: args?.title,
            kind: payload.kind,
            content: payload.content,
            data: payload.data,
            mime: payload.mime,
            ...attributionOf(args, exec),
          };
          if (action === "append") {
            const id = String(args?.id ?? "");
            if (id === "")
              return { ok: false, action, code: "artifacts/invalid", error: "append needs an id" };
            const meta = await store.append(id, input);
            const version = meta.versions[meta.versions.length - 1];
            return {
              ok: true,
              action,
              id: meta.id,
              title: meta.title,
              kind: meta.kind,
              version: meta.latest,
              bytes: version?.bytes ?? 0,
              url: urlOf(meta.id),
              ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
            };
          }
          const meta = await store.create(input);
          const version = meta.versions[meta.versions.length - 1];
          return {
            ok: true,
            action,
            id: meta.id,
            title: meta.title,
            kind: meta.kind,
            version: meta.latest,
            bytes: version?.bytes ?? 0,
            url: urlOf(meta.id),
            ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
          };
        }
        if (action === "list") {
          /** @type {import("./store.js").ListOptions} */
          const options = {};
          if (typeof args?.projectId === "string" && args.projectId.trim() !== "")
            options.projectId = args.projectId.trim();
          if (typeof args?.kind === "string" && args.kind !== "") options.kind = args.kind;
          if (typeof args?.title === "string" && args.title.trim() !== "")
            options.title = args.title.trim();
          const rows = await store.list(options);
          const summary = summarizeArtifacts(rows);
          return {
            ok: true,
            action,
            count: rows.length,
            summary: { count: summary.count, bytes: summary.bytes },
            artifacts: rows.map((/** @type {any} */ meta) => ({
              id: meta.id,
              title: meta.title,
              kind: meta.kind,
              latest: meta.latest,
              bytes: latestBytes(meta),
              ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
            })),
          };
        }
        if (action === "read") {
          const id = String(args?.id ?? "");
          const found = await store.read(id, args?.version);
          if (found === undefined)
            return {
              ok: false,
              action,
              code: "artifacts/not-found",
              error: `unknown artifact or version: ${id}`,
            };
          /** @type {any} */
          const value = {
            ok: true,
            action,
            id,
            title: found.meta.title,
            kind: found.kind,
            version: found.version,
            bytes: found.bytes,
            url: urlOf(id),
          };
          if (found.kind === "html") value.html = found.html;
          value.text = found.text;
          if (found.kind === "image") value.url = `${urlOf(id)}?v=${found.version}`;
          return value;
        }
        return { ok: false, action, code: "artifacts/invalid", error: `unknown action: ${action}` };
      } catch (error) {
        return {
          ok: false,
          action,
          code: /** @type {any} */ (error)?.code ?? "artifacts/failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export { MAX_BYTES };
