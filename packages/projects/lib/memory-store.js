// @ts-check
// F37/F3：记忆碎片的磁盘读写（**根目录可注入**，service 与测试共用同一套实现）。
//
// 为什么从 service 抽出来：service 的方法要 ctx、要 store，单测只能靠桩；
// 而「碎片落盘 / 索引改写 / 忘掉」是纯文件系统行为，抽成这里就能用临时目录真跑。
// 布局与 project-files.js 一致：<dataRoot>/<projectId>/memory/{MEMORY.md,fragments/*.md}。

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  appendEntry,
  fragmentIndexLine,
  MEMORY_FRAGMENT_MAX_CHARS,
  MEMORY_FRAGMENT_MAX_COUNT,
  normalizeFragmentText,
  normalizeFragmentTitle,
  parseMemoryBlocks,
  previewText,
  removeMemoryBlock,
  uniqueFragmentSlug,
} from "./memory.js";

/** 碎片目录名（相对项目目录）。 */
export const FRAGMENT_DIR = "fragments";

/** 索引文件名。 */
export const MEMORY_INDEX_FILE = "MEMORY.md";

/** 允许的 forget kind（未知值一律拒绝，不静默当成 entry）。 */
export const FORGET_KINDS = Object.freeze(["fragment", "entry"]);

/** 稳定块 id 的形状（memory.js 的 stableBlockId 是 8 位十六进制）。 */
const BLOCK_ID_PATTERN = /^[0-9a-f]{8}$/u;

/**
 * 合法的碎片 slug：字母/数字/中文/`._-`，且不能是 `..`。
 * @param {unknown} slug
 * @returns {string} 合法返回原值（trim 后），非法返回空串
 */
export function normalizeFragmentSlug(slug) {
  const value = String(slug ?? "").trim();
  if (value === "" || value === "." || value === "..") return "";
  if (value.includes("..") || value.includes("/") || value.includes("\\")) return "";
  if (!/^[\p{Letter}\p{Number}._-]+$/u.test(value)) return "";
  return value;
}

/** @param {string} dataRoot @param {string} projectId */
export function fragmentDir(dataRoot, projectId) {
  return join(dataRoot, String(projectId ?? ""), "memory", FRAGMENT_DIR);
}

/** @param {string} dataRoot @param {string} projectId */
export function memoryIndexPath(dataRoot, projectId) {
  return join(dataRoot, String(projectId ?? ""), "memory", MEMORY_INDEX_FILE);
}

/** 目录里合法的碎片文件名（只认 .md、忽略隐藏文件），按名字排序。 @param {string} dir @returns {string[]} */
export function listFragmentFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => typeof name === "string" && name.endsWith(".md") && !name.startsWith("."))
    .sort();
}

/** @param {string} file @returns {string} */
function statMtime(file) {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return "";
  }
}

/**
 * 列出碎片（标题从索引行取，读不到标题就用 slug）。缺目录/缺索引返回空列表。
 * @param {string} dataRoot @param {string} projectId
 * @returns {{ fragments: { slug: string, title: string, chars: number, preview: string, truncated: boolean, updatedAt: string }[], totalChars: number, limit: number, maxChars: number }}
 */
export function listFragments(dataRoot, projectId) {
  const dir = fragmentDir(dataRoot, projectId);
  const indexFile = memoryIndexPath(dataRoot, projectId);
  const indexText = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  /** @type {Map<string, string>} */
  const titles = new Map();
  for (const block of parseMemoryBlocks(indexText)) {
    if (block.fragment) titles.set(block.fragment.slug, block.fragment.title);
  }
  const fragments = listFragmentFiles(dir).map((name) => {
    const slug = name.replace(/\.md$/u, "");
    const full = join(dir, name);
    const text = existsSync(full) ? readFileSync(full, "utf8") : "";
    const info = previewText(text);
    return {
      slug,
      title: titles.get(slug) ?? slug,
      chars: info.chars,
      preview: info.preview,
      truncated: info.truncated,
      updatedAt: statMtime(full),
    };
  });
  return {
    fragments,
    totalChars: fragments.reduce((sum, item) => sum + item.chars, 0),
    limit: MEMORY_FRAGMENT_MAX_COUNT,
    maxChars: MEMORY_FRAGMENT_MAX_CHARS,
  };
}

/**
 * 读一个碎片全文。
 * @param {string} dataRoot @param {string} projectId @param {unknown} slug
 * @returns {{ ok: true, slug: string, title: string, text: string, preview: string, truncated: boolean, chars: number } | { ok: false, reason: string }}
 */
export function readFragment(dataRoot, projectId, slug) {
  const safeSlug = normalizeFragmentSlug(slug);
  if (safeSlug === "") return { ok: false, reason: "fragment/invalid-slug" };
  const file = join(fragmentDir(dataRoot, projectId), `${safeSlug}.md`);
  if (!existsSync(file)) return { ok: false, reason: "fragment/not-found" };
  const text = readFileSync(file, "utf8");
  const info = listFragments(dataRoot, projectId).fragments.find((item) => item.slug === safeSlug);
  return {
    ok: true,
    slug: safeSlug,
    title: info ? info.title : safeSlug,
    text,
    ...previewText(text, 1200),
  };
}

/**
 * 新增一条碎片：正文落 `fragments/<slug>.md`，索引里追加一行指针。
 * 返回 `{ok:false, reason}` 表示被拒绝（原因可审计），不抛错。
 * @param {string} dataRoot @param {string} projectId @param {unknown} title @param {unknown} text
 * @returns {{ ok: true, slug: string, title: string, chars: number } | { ok: false, reason: string, limit?: number }}
 */
export function addFragment(dataRoot, projectId, title, text) {
  const body = normalizeFragmentText(text);
  if (body.ok !== true) return { ok: false, reason: body.reason };
  const dir = fragmentDir(dataRoot, projectId);
  mkdirSync(dir, { recursive: true });
  const existing = listFragmentFiles(dir);
  if (existing.length >= MEMORY_FRAGMENT_MAX_COUNT) {
    return { ok: false, reason: "fragment-too-many", limit: MEMORY_FRAGMENT_MAX_COUNT };
  }
  const normalizedTitle = normalizeFragmentTitle(title);
  const finalTitle = normalizedTitle === "" ? `记忆 ${existing.length + 1}` : normalizedTitle;
  const slug = uniqueFragmentSlug(
    finalTitle,
    existing.map((name) => name.replace(/\.md$/u, "")),
  );
  const file = join(dir, `${slug}.md`);
  writeFileSync(file, `${body.text}\n`, { mode: 0o600, flag: "wx" });
  const indexFile = memoryIndexPath(dataRoot, projectId);
  const current = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  const line = fragmentIndexLine({ title: finalTitle, slug, text: body.text });
  const appended = appendEntry(current, line, { at: new Date().toISOString() });
  if (appended.ok !== true) {
    rmSync(file, { force: true });
    return { ok: false, reason: appended.reason };
  }
  writeFileSync(indexFile, appended.text, { mode: 0o600 });
  return { ok: true, slug, title: finalTitle, chars: body.text.length };
}

/**
 * 忘掉一条记忆：kind=fragment 删碎片文件 + 索引行；kind=entry 只删索引里的一个块。
 * **路径守卫**：kind 必须已知；fragment 的 id 必须是合法 slug（`../`、`..%2F`、绝对路径、
 * 反斜杠一律拒绝），entry 的 id 必须是 8 位十六进制块 id；最终路径必须仍在碎片目录下。
 * @param {string} dataRoot @param {string} projectId @param {unknown} kind @param {unknown} id
 * @returns {{ ok: true, kind: "fragment"|"entry", id: string, removed: string } | { ok: false, reason: string }}
 */
export function forgetMemoryItem(dataRoot, projectId, kind, id) {
  const safeKind = String(kind ?? "").trim();
  if (safeKind !== "fragment" && safeKind !== "entry") {
    return { ok: false, reason: "forget/unknown-kind" };
  }
  const rawId = String(id ?? "").trim();
  if (rawId === "") return { ok: false, reason: "forget/id-required" };
  let safeId = rawId;
  if (safeKind === "fragment") {
    safeId = normalizeFragmentSlug(rawId);
    if (safeId === "") return { ok: false, reason: "fragment/invalid-slug" };
    const dir = resolve(fragmentDir(dataRoot, projectId));
    const target = resolve(join(dir, `${safeId}.md`));
    const rel = relative(dir, target);
    if (rel === "" || rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) {
      return { ok: false, reason: "fragment/invalid-slug" };
    }
  } else if (!BLOCK_ID_PATTERN.test(rawId)) {
    return { ok: false, reason: "forget/invalid-id" };
  }
  const indexFile = memoryIndexPath(dataRoot, projectId);
  const current = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  const blocks = parseMemoryBlocks(current);
  const target =
    safeKind === "fragment"
      ? blocks.find((block) => block.fragment?.slug === safeId)
      : blocks.find((block) => block.id === safeId);
  if (!target) return { ok: false, reason: "forget/not-found" };
  const removed = removeMemoryBlock(current, target.id);
  if (removed.ok !== true) return { ok: false, reason: "forget/failed" };
  if (removed.text === "") rmSync(indexFile, { force: true });
  else writeFileSync(indexFile, removed.text, { mode: 0o600 });
  if (safeKind === "fragment") {
    const file = join(fragmentDir(dataRoot, projectId), `${safeId}.md`);
    if (existsSync(file)) rmSync(file, { force: true });
  }
  return { ok: true, kind: safeKind, id: safeId, removed: removed.removed.slice(0, 200) };
}
