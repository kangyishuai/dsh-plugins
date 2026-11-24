// @ts-check
// F33 产物归属：从 artifacts 工具的 `tool/result` 里取出可记录的产物引用。
// 纯函数便于单测：service 只负责"找到项目 + 落库"，解析与容错都在这里。
//
// 两种形态都要认（真机实测：host 给插件的 `tool/result.message.content` 是**渲染后的文本**，
// 不是工具返回的原始 JSON）：
//   1. JSON：`{"ok":true,"id":"…","title":"…","kind":"…","version":1,"bytes":14}`
//   2. 渲染文本：`artifact <id> · <title> · v1 · 14 B · html\nurl: …`
// 只认 `ok:true` / 成功格式；认不出就返回 null（宁可不记录，也不造假引用）。

/**
 * 把 "14 B" / "2.1 KB" / "3 MB" 解析成字节数；认不出返回 null。
 * @param {string} text
 * @returns {number|null}
 */
export function bytesOf(text) {
  const match = String(text ?? "").match(/^\s*([\d.]+)\s*(B|KB|MB|GB)\s*$/iu);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toUpperCase();
  const factor = unit === "KB" ? 1024 : unit === "MB" ? 1024 * 1024 : unit === "GB" ? 1024 ** 3 : 1;
  return Math.round(value * factor);
}

/**
 * 解析 artifacts 工具渲染后的文本：`artifact <id> · <title> · v<n> · <bytes> · <kind>`。
 * @param {string} text
 * @returns {{ id: string, title: string, kind: string, version: number|null, bytes: number|null } | null}
 */
export function parseArtifactRenderText(text) {
  const firstLine = String(text ?? "").split("\n")[0] ?? "";
  // title 里可能含 " · "，所以从两端向中间切：id 在最前，kind 在最后，version/bytes 在中间。
  const match = firstLine.match(
    /^\s*artifact\s+(\S+)\s+·\s+(.*?)\s+·\s+v(\d+)\s+·\s+([\d.]+\s*[KMG]?B)\s+·\s+(\S+)\s*$/iu,
  );
  if (!match) return null;
  const id = match[1].trim();
  if (id === "") return null;
  return {
    id,
    title: match[2].trim(),
    kind: match[5].trim(),
    version: Number(match[3]),
    bytes: bytesOf(match[4]),
  };
}

/**
 * @param {unknown} text 工具结果的文本内容（artifacts 工具返回 JSON 字符串或渲染文本）
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
    parsed = null;
  }
  /** @type {{ id: string, title: string, kind: string, version: number|null, bytes: number|null } | null} */
  let shape = null;
  if (parsed && typeof parsed === "object") {
    if (parsed.ok !== true) return null;
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (id === "") return null;
    shape = {
      id,
      title: typeof parsed.title === "string" ? parsed.title : "",
      kind: typeof parsed.kind === "string" ? parsed.kind : "",
      version: typeof parsed.version === "number" ? parsed.version : null,
      bytes: typeof parsed.bytes === "number" ? parsed.bytes : null,
    };
  } else {
    shape = parseArtifactRenderText(raw);
    if (shape === null) return null;
  }
  const source = {
    sessionId: typeof meta?.sessionId === "string" ? meta.sessionId : "",
    toolCallId: typeof meta?.toolCallId === "string" ? meta.toolCallId : "",
  };
  return {
    ...shape,
    at: typeof meta?.at === "string" && meta.at !== "" ? meta.at : new Date().toISOString(),
    source,
  };
}
