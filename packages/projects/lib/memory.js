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
  // AUD-PROJ-12：以前用 `base.includes(normalized)` 判重——**子串**匹配会把短条目误吞：
  // 已有「always run tests before commit」时，新记忆「run tests」被判成 duplicate、
  // 界面显示「已经知道」但内容没写进去。改成按记忆块的**完全相等**判重
  // （行的切分口径与 parseMemoryBlocks 一致，trailing 时间注释不影响比较）。
  const wanted = normalized.trim();
  const existingBlocks = parseMemoryBlocks(base).map((block) => String(block.text ?? "").trim());
  if (existingBlocks.includes(wanted)) {
    return { ok: true, text: base, reason: "duplicate", added: false };
  }

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

// —— F37：记忆碎片（MEMORY.md 索引 + 独立 .md 文件）——
// 索引只放一行指针，正文在 fragments/<slug>.md 里。这样 MEMORY.md 始终短，
// 模型要细节时用文件工具读对应文件（与 context.js 的「索引不是仓库」一致）。

/** 单个碎片正文上限（字符）：碎片的目的是「够用就好」，不是第二套文档系统。 */
export const MEMORY_FRAGMENT_MAX_CHARS = 8_000;

/** 一个项目最多保留的碎片数（防止把索引撑爆）。 */
export const MEMORY_FRAGMENT_MAX_COUNT = 100;

/** 碎片预览长度（UI 列表里显示前 N 个字符）。 */
export const MEMORY_FRAGMENT_PREVIEW_CHARS = 320;

/** 碎片标题上限。 */
export const MEMORY_FRAGMENT_TITLE_MAX_CHARS = 120;

/** 碎片目录（相对项目目录）。 */
export const FRAGMENT_DIR = "fragments";

/**
 * 把标题压成文件名安全、可读的 slug。中文保留（文件系统允许），其余替换成 `-`。
 * @param {unknown} title
 * @returns {string}
 */
export function fragmentSlug(title) {
  const base = String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return base === "" ? "fragment" : base;
}

/**
 * 生成不冲突的 slug：`foo`、`foo-2`、`foo-3`…
 * @param {string} title @param {readonly string[]} taken
 * @returns {string}
 */
export function uniqueFragmentSlug(title, taken = []) {
  const base = fragmentSlug(title);
  const used = new Set((taken ?? []).map((item) => String(item)));
  if (!used.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 索引行：`- [标题](fragments/slug.md) — 摘要`（摘要取正文首行，压到 80 字符）。
 * @param {{ title?: string, slug: string, text?: string }} input
 * @returns {string}
 */
export function fragmentIndexLine(input) {
  const title = String(input?.title ?? "").trim() || "记忆";
  const slug = String(input?.slug ?? "").trim() || fragmentSlug(title);
  const firstLine =
    String(input?.text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const summary = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  return summary === ""
    ? `- [${title}](${FRAGMENT_DIR}/${slug}.md)`
    : `- [${title}](${FRAGMENT_DIR}/${slug}.md) — ${summary}`;
}

/**
 * 解析碎片索引行。
 * @param {string} line
 * @returns {{ slug: string, title: string, summary: string } | null}
 */
export function parseFragmentLine(line) {
  const text = String(line ?? "").trim();
  const match = text.match(
    /^-\s+\[(?<title>[^\]]+)\]\((?<slug>[^)]+)\)(?:\s+—\s+(?<summary>.*))?$/u,
  );
  if (!match?.groups) return null;
  const raw = String(match.groups.slug ?? "");
  const prefix = `${FRAGMENT_DIR}/`;
  if (!raw.startsWith(prefix) || !raw.endsWith(".md")) return null;
  return {
    slug: raw.slice(prefix.length, -3),
    title: String(match.groups.title ?? "").trim(),
    summary: String(match.groups.summary ?? "").trim(),
  };
}

/**
 * 把 MEMORY.md 拆成「块」：空行分隔；块的 id 用块内容哈希（稳定，不依赖行号）。
 * @param {string} text
 * @returns {{ id: string, text: string, at: string, fragment: { slug: string, title: string } | null }[]}
 */
export function parseMemoryBlocks(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n/gu, "\n")
    .trim();
  if (normalized === "") return [];
  const blocks = normalized.split(/\n{2,}/u);
  return blocks.map((block) => {
    const trimmed = block.trim();
    const atMatch = trimmed.match(/\n?<!--\s*(?<at>[^>]*?)\s*-->\s*$/u);
    const at = atMatch?.groups?.at ? String(atMatch.groups.at).trim() : "";
    const body = atMatch ? trimmed.slice(0, atMatch.index).trim() : trimmed;
    const fragment = parseFragmentLine(body);
    return {
      id: stableBlockId(body),
      text: body,
      at,
      fragment: fragment ? { slug: fragment.slug, title: fragment.title } : null,
    };
  });
}

/**
 * 块的稳定 id（FNV-1a 32 位十六进制）：同一段文字永远得到同一个 id，
 * 这样「forget 第 2 条」在两次读取之间不会因为插入新条目而漂移。
 * @param {string} text
 * @returns {string}
 */
export function stableBlockId(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 从索引文本里删掉一个块（按稳定 id）。
 * @param {string} text @param {string} id
 * @returns {{ ok: boolean, text: string, removed: string }}
 */
export function removeMemoryBlock(text, id) {
  const blocks = parseMemoryBlocks(text);
  const target = blocks.find((block) => block.id === String(id));
  if (!target) return { ok: false, text: String(text ?? "").trimEnd(), removed: "" };
  const kept = blocks.filter((block) => block.id !== target.id);
  const next = kept
    .map((block) => (block.at === "" ? block.text : `${block.text}\n<!-- ${block.at} -->`))
    .join("\n\n");
  return { ok: true, text: next === "" ? "" : `${next}\n`, removed: target.text };
}

/**
 * 碎片正文预览：截断到 N 字符并说明还有多少。
 * @param {string} text @param {number} [maxChars]
 * @returns {{ preview: string, truncated: boolean, chars: number }}
 */
export function previewText(text, maxChars = MEMORY_FRAGMENT_PREVIEW_CHARS) {
  const value = String(text ?? "");
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Number(maxChars))
    : MEMORY_FRAGMENT_PREVIEW_CHARS;
  if (value.length <= limit) return { preview: value, truncated: false, chars: value.length };
  return { preview: value.slice(0, limit), truncated: true, chars: value.length };
}

/**
 * 规范化碎片正文：去首尾空白、压多余空行；超上限返回 null（拒绝，不偷偷截断）。
 * @param {unknown} text
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function normalizeFragmentText(text) {
  const value = String(text ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (value === "") return { ok: false, reason: "empty-fragment" };
  if (value.length > MEMORY_FRAGMENT_MAX_CHARS) return { ok: false, reason: "fragment-too-long" };
  return { ok: true, text: value };
}

/** @param {unknown} title @returns {string} */
export function normalizeFragmentTitle(title) {
  return String(title ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MEMORY_FRAGMENT_TITLE_MAX_CHARS);
}
