// @ts-check
// 项目记忆的写入逻辑：纯函数、零 I/O，方便单测；真正的写盘在 service 里。
// 布局与 project-files.js 一致：<dataRoot>/<projectId>/memory/MEMORY.md。
// 设计取向：记忆是**索引**不是仓库——单文件有上限、条目去重、只追加不改写。

/** 记忆文件上限（字符）：超过就拒绝写入，让人自己整理，而不是悄悄截断内容。 */
export const MEMORY_MAX_CHARS = 32 * 1024;

/** 单条记忆上限（字符）。 */
export const MEMORY_ENTRY_MAX_CHARS = 2_000;

/**
 * 把一条新记忆规范化成单段落文本：去首尾空白、压掉多余空行、截断单条上限。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeEntry(text) {
  const value = String(text ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (value === "") return "";
  return value.length > MEMORY_ENTRY_MAX_CHARS
    ? `${value.slice(0, MEMORY_ENTRY_MAX_CHARS)}\n…（已截断）`
    : value;
}

/**
 * 把一条记忆追加到索引文本。
 * 规则：完全相同的内容不重复追加（幂等）；超上限则拒绝并给出原因。
 * @param {string} existing
 * @param {unknown} entry
 * @param {{ at?: string, maxChars?: number }} [options]
 * @returns {{ ok: boolean, text: string, reason: string, added: boolean }}
 */
export function appendEntry(existing, entry, options) {
  const base = String(existing ?? "")
    .replace(/\r\n/gu, "\n")
    .trimEnd();
  const normalized = normalizeEntry(entry);
  if (normalized === "") return { ok: false, text: base, reason: "empty-entry", added: false };
  if (base.includes(normalized)) return { ok: true, text: base, reason: "duplicate", added: false };

  const requestedMax = options?.maxChars;
  const maxChars = Number.isFinite(requestedMax) ? Number(requestedMax) : MEMORY_MAX_CHARS;
  const at = typeof options?.at === "string" && options.at !== "" ? options.at : "";
  const block = at === "" ? normalized : `${normalized}\n<!-- ${at} -->`;
  const candidate = base === "" ? block : `${base}\n\n${block}`;
  if (candidate.length > maxChars) {
    return { ok: false, text: base, reason: "memory-full", added: false };
  }
  return { ok: true, text: `${candidate}\n`, reason: "", added: true };
}
