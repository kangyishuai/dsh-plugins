// @ts-check
// 「查看发送内容」的预览：只存本次实际发送文本的首尾片段。
//
// 为什么不存全文：会话记录本身已经包含对话，再复制一份完整 transcript 会放大隐私面和会话体积。
// 首尾各 2,000 字符足以确认「发了什么」，又不会把整个工作区上下文写进记录。
// 预览是在 buildTranscript 之后取的，所以已经是脱敏、按 maxInputChars 截断后的文本。

/** 首尾各保留的字符数。 */
export const TRACE_PREVIEW_EDGE = 2000;

/**
 * 生成待存的首尾预览。
 * - 总长度不超过 `edge * 2`：原样返回（短会话不需要省略）。
 * - 超过：保留前 `edge` 与后 `edge` 字符，中间用 `…` 标记；`chars` 始终是完整长度。
 * @param {unknown} text
 * @param {number} [edge]
 * @returns {{ preview: string, chars: number, truncated: boolean }}
 */
export function buildTracePreview(text, edge = TRACE_PREVIEW_EDGE) {
  const value = String(text ?? "");
  const chars = value.length;
  const limit = Math.max(1, Math.floor(Number.isFinite(edge) ? edge : TRACE_PREVIEW_EDGE));
  if (chars <= limit * 2) {
    return { preview: value, chars, truncated: false };
  }
  return {
    preview: `${value.slice(0, limit)}\n\n…\n\n${value.slice(-limit)}`,
    chars,
    truncated: true,
  };
}
