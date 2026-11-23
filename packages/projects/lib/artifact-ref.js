// @ts-check
// F33 产物归属：从 artifacts 工具的 `tool/result` 文本里取出可记录的产物引用。
// 纯函数便于单测：service 只负责"找到项目 + 落库"，解析与容错都在这里。

/**
 * @param {unknown} text 工具结果的文本内容（artifacts 工具返回 JSON 字符串）
 * @param {{ sessionId?: string, toolCallId?: string, at?: string }} [meta]
 * @returns {{ id: string, title: string, kind: string, version: number|null, bytes: number|null, at: string, source: { sessionId: string, toolCallId: string } } | null}
 */
export function artifactRefFromToolResult(text, meta) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return null;
  /** @type {any} */
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.ok !== true) return null;
  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  if (id === "") return null;
  const source = {
    sessionId: typeof meta?.sessionId === "string" ? meta.sessionId : "",
    toolCallId: typeof meta?.toolCallId === "string" ? meta.toolCallId : "",
  };
  return {
    id,
    title: typeof parsed.title === "string" ? parsed.title : "",
    kind: typeof parsed.kind === "string" ? parsed.kind : "",
    version: typeof parsed.version === "number" ? parsed.version : null,
    bytes: typeof parsed.bytes === "number" ? parsed.bytes : null,
    at: typeof meta?.at === "string" && meta.at !== "" ? meta.at : new Date().toISOString(),
    source,
  };
}
