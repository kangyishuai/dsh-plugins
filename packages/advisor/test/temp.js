// @ts-check
// 临时目录统一回收：advisor 的单测早期直接 mkdtemp 不清理，每跑一次就往系统临时目录里
// 留下几十个 `advisor-*` 目录（实测累积 6000+ 个、约 74 MB）。
//
// 用法：
//   import { cleanupTempDirs, tempDir } from "./temp.js";
//   after(cleanupTempDirs);            // 每个测试文件注册一次
//   const home = await tempDir("advisor-wiring");   // prefix 保留，便于人工辨认
//
// 为什么在**每个文件**里 `after(cleanupTempDirs)` 而不是在 helper 顶层注册：
// 顶层钩子挂在「导入它的那个模块」的上下文里，行为依赖被导入时机；显式在每个文件注册最稳。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @type {Set<string>} */
const TEMP_DIRS = new Set();

/**
 * 建临时目录并登记回收。
 * @param {string} [prefix] 目录前缀（会在后面自动加随机后缀）
 * @returns {Promise<string>}
 */
export async function tempDir(prefix = "advisor-test") {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  TEMP_DIRS.add(dir);
  return dir;
}

/**
 * 回收本进程建过的全部临时目录。失败不抛（清理不该让测试变红）。
 * @returns {Promise<void>}
 */
export async function cleanupTempDirs() {
  for (const dir of TEMP_DIRS) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  TEMP_DIRS.clear();
}
