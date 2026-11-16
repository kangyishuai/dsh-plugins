// @ts-check
// 项目内容文件（人可读、可 git 管理）的读取。
// 布局：<dataRoot>/<projectId>/instructions.md 与 memory/MEMORY.md。
// 只读，不创建；缺文件返回空串（不当作错误）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 单个文件最多读这么多字符：防手滑把大文件塞进每一步的提示词。 */
export const MAX_FILE_CHARS = 64 * 1024;

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
 * 读一个项目的常设规则与记忆索引。
 * @param {string} dataRoot
 * @param {string} projectId
 * @returns {{instructions: string, memoryIndex: string, dir: string}}
 */
export function readProjectFiles(dataRoot, projectId) {
  const dir = join(dataRoot, projectId);
  return {
    dir,
    instructions: readCapped(join(dir, "instructions.md")).trim(),
    memoryIndex: readCapped(join(dir, "memory", "MEMORY.md")).trim(),
  };
}
