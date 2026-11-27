// @ts-check
// 项目内容文件（人可读、可 git 管理）的读取。
// 布局：<dataRoot>/<projectId>/instructions.md 与 memory/MEMORY.md。
// 只读，不创建；缺文件返回空串（不当作错误）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 单个文件最多读这么多字符：防手滑把大文件塞进每一步的提示词。 */
export const MAX_FILE_CHARS = 64 * 1024;

/** 项目指令的软上限（Claude 的 instructions 计数是 16,000 字符）。 */
export const INSTRUCTION_CHAR_LIMIT = 16_000;

/**
 * @param {string} file
 * @returns {string}
 */
function readCapped(file) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  return text.length <= MAX_FILE_CHARS
    ? text
    : `${text.slice(0, MAX_FILE_CHARS)}\n…（文件过大，已截断）`;
}

/**
 * 文件的大小/更新时间；缺文件返回 null——**没有**和「空文件」是两件事。
 * @param {string} file
 * @returns {{bytes: number, updatedAt: string} | null}
 */
export function statSafe(file) {
  try {
    if (!existsSync(file)) return null;
    const stat = statSync(file);
    return { bytes: Number(stat.size) || 0, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * 读一个项目的常设规则与记忆索引，并附带两份文件的 stat（UI 的计数与「更新于」用）。
 * @param {string} dataRoot
 * @param {string} projectId
 * @returns {{ instructions: string, memoryIndex: string, dir: string, instructionsStat: {bytes: number, updatedAt: string} | null, memoryStat: {bytes: number, updatedAt: string} | null }}
 */
export function readProjectFiles(dataRoot, projectId) {
  const dir = join(dataRoot, projectId);
  const instructionsFile = join(dir, "instructions.md");
  const memoryFile = join(dir, "memory", "MEMORY.md");
  return {
    dir,
    instructions: readCapped(instructionsFile).trim(),
    memoryIndex: readCapped(memoryFile).trim(),
    instructionsStat: statSafe(instructionsFile),
    memoryStat: statSafe(memoryFile),
  };
}

/**
 * 列 memory 目录里的文件（Claude 的 Memory files 列表：名字 + 更新于）。
 * @param {string} dataRoot @param {string} projectId
 * @returns {Array<{ name: string, bytes: number, updatedAt: string }>}
 */
export function listMemoryFiles(dataRoot, projectId) {
  const dir = join(dataRoot, projectId, "memory");
  /** @type {import("node:fs").Dirent[]} */
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.isFile() !== true) continue;
    const file = join(dir, entry.name);
    const stat = statSafe(file);
    if (stat === null) continue;
    out.push({ name: String(entry.name), bytes: stat.bytes, updatedAt: stat.updatedAt });
  }
  // 用码点序（localeCompare 会把小写排在大写前，跨环境不稳定）
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
