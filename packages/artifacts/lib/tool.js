// @ts-check
// `artifact` 工具：模型侧只做四件事——publish / append / list / read。
//
// 与 Claude 的 20+ action 单工具相比，这个 spike 刻意只留四个动词：
//   - 模型一次只写一页，不需要 share / comments / watch / db；
//   - schema 越小，常驻上下文越省（Claude 的 Artifact 工具 ~12k tokens，社区 1007↑ 抱怨）；
//   - 原地更新靠"同一 id 追加版本"，不靠改写已渲染的工具行。
//
// 受支持的 JSON Schema 关键字是子集：type/oneOf/properties/required/additionalProperties/items/enum/const。
// 不吃 minimum / maximum（宿主会静默拒绝注册）。

export const TOOL_NAME = "artifact";

export const TOOL_DESCRIPTION = [
  "Publish or update a local artifact: a self-contained HTML page the user can open beside the conversation.",
  "Use it when the result is easier to look at than to read (report, dashboard, walkthrough, comparison).",
  "`publish` creates a new artifact from `html`; `append` adds a new version to the same id (the previous version is kept).",
  "`list` returns known artifacts; `read` returns one version's html.",
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
      description: "Short noun phrase shown in the list and the panel header.",
    }),
    html: Object.freeze({
      type: "string",
      description: "Self-contained page markup (CSS inline, images as data: URIs). Max 2 MiB.",
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
    version: Object.freeze({ type: "integer" }),
    bytes: Object.freeze({ type: "integer" }),
    url: Object.freeze({ type: "string" }),
    error: Object.freeze({ type: "string" }),
    html: Object.freeze({ type: "string" }),
    artifacts: Object.freeze({
      type: "array",
      items: Object.freeze({
        type: "object",
        properties: Object.freeze({
          id: Object.freeze({ type: "string" }),
          title: Object.freeze({ type: "string" }),
          latest: Object.freeze({ type: "integer" }),
          bytes: Object.freeze({ type: "integer" }),
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
 * 模型可读的结果文本。刻意短：正文在页面里，工具结果只放身份与下一步。
 * @param {unknown} _args
 * @param {any} value
 * @returns {Array<{ type: "text", text: string }>}
 */
export function renderToolOutput(_args, value) {
  if (!value || value.ok !== true) {
    return [{ type: "text", text: `artifact failed: ${String(value?.error ?? "unknown error")}` }];
  }
  if (value.action === "list") {
    const rows = Array.isArray(value.artifacts) ? value.artifacts : [];
    if (rows.length === 0) return [{ type: "text", text: "No artifacts yet." }];
    return [
      {
        type: "text",
        text: rows
          .map(
            (/** @type {any} */ row) =>
              `- ${row.id} · ${row.title} · v${row.latest} · ${row.bytes} B`,
          )
          .join("\n"),
      },
    ];
  }
  if (value.action === "read") {
    return [{ type: "text", text: String(value.html ?? "") }];
  }
  const lines = [`artifact ${value.id} · ${value.title} · v${value.version} · ${value.bytes} B`];
  if (typeof value.url === "string" && value.url !== "") lines.push(`url: ${value.url}`);
  lines.push("The preview panel shows the latest version; older rows stay linked to it.");
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * @param {{ store: import("./store.js").ArtifactMeta extends never ? never : any, baseUrl: () => string }} deps
 * @returns {any}
 */
export function createToolDefinition({ store, baseUrl }) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolOutput },
    /** @param {any} args @returns {Promise<any>} */
    execute: async (args) => {
      const action = String(args?.action ?? "");
      const urlOf = (/** @type {string} */ id) =>
        `${baseUrl()}/artifacts/${encodeURIComponent(id)}`;
      try {
        if (action === "publish") {
          const meta = await store.create({ title: args?.title, html: args?.html });
          const version = meta.versions[meta.versions.length - 1];
          return {
            ok: true,
            action,
            id: meta.id,
            title: meta.title,
            version: meta.latest,
            bytes: version?.bytes ?? 0,
            url: urlOf(meta.id),
          };
        }
        if (action === "append") {
          const id = String(args?.id ?? "");
          if (id === "") return { ok: false, action, error: "append needs an id" };
          const meta = await store.append(id, { title: args?.title, html: args?.html });
          const version = meta.versions[meta.versions.length - 1];
          return {
            ok: true,
            action,
            id: meta.id,
            title: meta.title,
            version: meta.latest,
            bytes: version?.bytes ?? 0,
            url: urlOf(meta.id),
          };
        }
        if (action === "list") {
          const rows = await store.list();
          return {
            ok: true,
            action,
            artifacts: rows.map((/** @type {any} */ meta) => ({
              id: meta.id,
              title: meta.title,
              latest: meta.latest,
              bytes: meta.versions[meta.versions.length - 1]?.bytes ?? 0,
            })),
          };
        }
        if (action === "read") {
          const id = String(args?.id ?? "");
          const found = await store.read(id, args?.version);
          if (found === undefined)
            return { ok: false, action, error: `unknown artifact or version: ${id}` };
          return {
            ok: true,
            action,
            id,
            title: found.meta.title,
            version: found.version,
            html: found.html,
          };
        }
        return { ok: false, action, error: `unknown action: ${action}` };
      } catch (error) {
        return { ok: false, action, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
