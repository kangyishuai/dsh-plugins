// @ts-check
// 定位一个会话在磁盘上的目录。优先用后端的 locate()（官方给出的路径），
// 拿不到时按「扫描 + 匹配已知布局」回退；两种来源都失败就报告，不猜路径。
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encodeSegment, projectKey, requireSessionId, sessionsRoot } from "./paths.js";

/**
 * @typedef {object} Location
 * @property {string} path 会话目录的绝对路径。
 * @property {"locate" | "scan"} tier 来源：官方 locate() 还是回退扫描。
 */

/** @param {string} path @returns {Promise<boolean>} */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 由 header 直接算出候选路径（cwd 与 id 都是确定性的）。
 * @param {string} dataRoot
 * @param {string} sessionId
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
export function candidateFromHeader(dataRoot, sessionId, cwd) {
  const root = sessionsRoot(dataRoot);
  const segment = encodeSegment(sessionId);
  if (typeof cwd === "string" && cwd.length > 0) return join(root, projectKey(cwd), segment);
  return join(root, "_no-cwd", segment);
}

/**
 * 在 sessions 根下逐个项目目录查找该会话目录。
 * @param {string} dataRoot
 * @param {string} sessionId
 * @returns {Promise<string[]>} 命中路径（通常 0 或 1 个）。
 */
export async function scanForSessionDir(dataRoot, sessionId) {
  const root = sessionsRoot(dataRoot);
  const segment = encodeSegment(sessionId);
  /** @type {string[]} */
  const hits = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, segment);
    if (await isDirectory(candidate)) hits.push(candidate);
  }
  return hits;
}

/**
 * 定位会话目录：locate() → header 推导 → 全项目扫描。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.sessionId
 * @param {{ cwd?: string | null, id?: string } | null | undefined} options.header
 * @param {any} [options.persistence]
 * @returns {Promise<{ location: Location | null, ambiguous: string[] }>}
 */
export async function locateSession({ dataRoot, sessionId, header, persistence }) {
  requireSessionId(sessionId);

  if (header && typeof persistence?.locate === "function") {
    try {
      const located = persistence.locate(header);
      const path = located?.path;
      if (typeof path === "string" && path.length > 0) {
        const dir = dirname(path);
        if (await isDirectory(dir))
          return { location: { path: dir, tier: "locate" }, ambiguous: [] };
      }
    } catch {
      // 后端没有 locate 或它拒绝了这次查询 —— 回退到扫描。
    }
  }

  const fromHeader = candidateFromHeader(dataRoot, sessionId, header?.cwd ?? null);
  if (await isDirectory(fromHeader))
    return { location: { path: fromHeader, tier: "scan" }, ambiguous: [] };

  const hits = await scanForSessionDir(dataRoot, sessionId);
  if (hits.length === 1) return { location: { path: hits[0], tier: "scan" }, ambiguous: [] };
  if (hits.length > 1) return { location: null, ambiguous: hits };
  return { location: null, ambiguous: [] };
}

/**
 * 目录体积（递归，不跟随符号链接）。用于 plan 里展示「将释放多少」。
 * @param {string} path
 * @returns {Promise<number>} 字节数。
 */
export async function directorySize(path) {
  let total = 0;
  /** @type {{ path: string, name: string }[]} */
  const stack = [{ path, name: path }];
  while (stack.length > 0) {
    const next = /** @type {{ path: string, name: string }} */ (stack.pop());
    let entries;
    try {
      entries = await readdir(next.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(next.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push({ path: child, name: child });
      else {
        try {
          total += (await stat(child)).size;
        } catch {
          // 读不到的条目忽略，不影响主流程。
        }
      }
    }
  }
  return total;
}
