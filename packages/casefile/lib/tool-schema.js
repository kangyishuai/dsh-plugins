// @ts-check
// tool-schema.js：工具输出的公共 schema 与渲染器。
// 与 tools.js 分开：schema 是纯数据，可被测试和文档复用。

/** 所有 casefile 工具共用的输出 schema。 */
export const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean", description: "是否成功" },
    data: { type: "object", description: "成功时的结构化结果" },
    error: {
      type: "object",
      description: "失败时的稳定错误码与说明",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        hint: { type: "string" },
      },
      required: ["code", "message"],
    },
    summary: { type: "string", description: "给模型看的一句话摘要" },
  },
  required: ["ok"],
};

/**
 * 把工具返回值渲染成对话卡片里的文本块。
 * @param {unknown} _args
 * @param {any} value
 * @returns {{ type: "text", text: string }[]}
 */
export function renderToolResult(_args, value) {
  const payload = value && typeof value === "object" ? value : { ok: true, data: value };
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const body = JSON.stringify(payload, null, 2);
  return [{ type: "text", text: summary === "" ? body : `${summary}\n\n${body}` }];
}
