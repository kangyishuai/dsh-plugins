// @ts-check
// 工具定义里**与宿主无关**的部分：名字、参数 schema、输出 schema、渲染函数。
// 单独成文件的理由：`service.js` 要 import 宿主包（`@deepseek-ai/dsh-llm` 等），
// 单测里解析不到；把可测的部分拆出来，schema 的「只支持子集」约束才能被测试守住。
// 受支持的 JSON Schema 关键字是子集：type/oneOf/properties/required/additionalProperties/items/enum/const。
// **`minimum` / `maximum` 不支持**，传了会让 register() 静默失败（docs/runtime/0.2.2-rc.1.md §9.10）。

/** 工具名：与 Claude 的 advisor 工具同名。 */
export const TOOL_NAME = "advisor";

/** 工具参数：零必填参数（对齐原版「input 永远为空」），只留一个可选 focus。 */
export const TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: Object.freeze({
    focus: Object.freeze({
      type: "string",
      description:
        "Optional: the specific doubt you want the advisor to settle, in one short sentence. Omit it to let the advisor read the transcript.",
    }),
  }),
  additionalProperties: false,
});

/** 工具返回值 schema（宿主会用它校验 execute 的返回值）。 */
export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    status: Object.freeze({
      type: "string",
      enum: Object.freeze(["reviewed", "declined", "unavailable", "skipped"]),
    }),
    severity: Object.freeze({ type: "string", enum: Object.freeze(["nit", "concern", "blocker"]) }),
    advice: Object.freeze({ type: "string" }),
    risks: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
    acceptance: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
    evidence: Object.freeze({
      type: "array",
      items: Object.freeze({
        type: "object",
        properties: Object.freeze({
          kind: Object.freeze({ type: "string" }),
          ref: Object.freeze({ type: "string" }),
        }),
        required: Object.freeze(["kind", "ref"]),
      }),
    }),
    adviceId: Object.freeze({ type: "string" }),
    anchors: Object.freeze({
      type: "object",
      properties: Object.freeze({
        checked: Object.freeze({ type: "number" }),
        verified: Object.freeze({ type: "number" }),
        unverified: Object.freeze({ type: "number" }),
        downgraded: Object.freeze({ type: "boolean" }),
      }),
      additionalProperties: true,
    }),
    reason: Object.freeze({ type: "string" }),
    model: Object.freeze({ type: "string" }),
    usage: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze(["status"]),
  additionalProperties: true,
});

/** 受支持的 schema 关键字白名单（测试与自检共用）。 */
export const SUPPORTED_SCHEMA_KEYWORDS = Object.freeze(
  new Set([
    "type",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "description",
    "title",
  ]),
);

/**
 * 递归找出 schema 里不受支持的关键字。
 * @param {unknown} schema
 * @param {string} [path]
 * @returns {string[]}
 */
export function unsupportedSchemaKeywords(schema, path = "$") {
  /** @type {string[]} */
  const out = [];
  if (schema === null || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => {
      out.push(...unsupportedSchemaKeywords(item, `${path}[${index}]`));
    });
    return out;
  }
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (schema))) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key) && !(path === "$" && key === "$schema")) {
      out.push(`${path}.${key}`);
    }
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [name, child] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        out.push(...unsupportedSchemaKeywords(child, `${path}.properties.${name}`));
      }
    } else if (key === "items" || key === "oneOf") {
      out.push(...unsupportedSchemaKeywords(value, `${path}.${key}`));
    }
  }
  return out;
}

/**
 * 工具卡渲染：把结果值转成文本块（**只给界面看**，模型拿到的是 JSON 值本身）。
 * @param {unknown} _args
 * @param {any} value
 * @returns {any[]}
 */
export function renderToolOutput(_args, value) {
  const status = String(value?.status ?? "unavailable");
  const model = String(value?.model ?? "");
  const usage = String(value?.usage ?? "");
  const tail = [model, usage].filter((item) => item !== "").join(" · ");

  if (status === "reviewed") {
    const risks =
      Array.isArray(value?.risks) && value.risks.length > 0
        ? `\n风险：${value.risks.join("；")}`
        : "";
    const acceptance =
      Array.isArray(value?.acceptance) && value.acceptance.length > 0
        ? `\n验收：${value.acceptance.join("；")}`
        : "";
    return [
      {
        type: "text",
        text: `顾问已复核（${String(value?.severity ?? "nit")}）\n${String(value?.advice ?? "")}${risks}${acceptance}\n${tail}`.trim(),
      },
    ];
  }
  if (status === "declined") {
    return [{ type: "text", text: `顾问认为无需建议${tail === "" ? "" : `\n${tail}`}` }];
  }
  if (status === "skipped") {
    return [{ type: "text", text: `顾问未徵询：${String(value?.reason ?? value?.code ?? "")}` }];
  }
  return [
    {
      type: "text",
      text: `顾问不可用（${String(value?.code ?? "error")}）：${String(value?.reason ?? "")}`,
    },
  ];
}
