// @ts-check
// 孤儿数据清理：会话被删除后，`<DSH_HOME>/session-rewind/` 里可能还留着它的
// entries / trash / rescues。本模块只做“找出并删除这些残留”，不碰仍然存在的会话，
// 也不碰 audit.jsonl（审计是 append-only 的历史记录）。
//
// 安全性：
//   - 只扫描 `pluginHome` 下的 sessions/ trash/ rescues/ 三个目录；
//   - 会话 id 必须匹配安全字符集，避免路径穿越；
//   - 只有「在 <dataRoot>/sessions/<workspace>/<sessionId> 里找不到」的 id 才算孤儿；
//   - 删除前可以 dryRun 只统计；删除失败逐条记录，不中断其余清理。
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** 目录名安全字符集。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * @typedef {object} OrphanReport
 * @property {string[]} sessionIds 插件 data 里存在、但会话已不存在的 id
 * @property {string[]} trashIds 孤儿 trash 目录对应的 id
 * @property {string[]} rescueIds 孤儿 rescue 目录对应的 id
 * @property {number} bytes 估算占用字节数
 */

/**
 * 读取目录下的子目录名；不存在时返回空数组。
 * @param {string} dir
 * @param {any} [fs]
 * @returns {Promise<string[]>}
 */
async function listDirs(dir, fs = { readdir }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  return entries
    .filter((/** @type {any} */ entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((/** @type {any} */ entry) => entry.name)
    .sort();
}

/**
 * 递归计算目录字节数（估算）。
 * @param {string} target
 * @param {any} [fs]
 * @returns {Promise<number>}
 */
async function dirBytes(target, fs = { readdir, stat }) {
  let info;
  try {
    info = await fs.stat(target);
  } catch (_error) {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(target);
  } catch (_error) {
    return 0;
  }
  for (const entry of entries)
    total += await dirBytes(join(target, /** @type {string} */ (entry)), fs);
  return total;
}

/**
 * 找出插件数据里已经没有对应会话的 id。
 * @param {{dataRoot: string, pluginHome?: string, fs?: any}} input
 * @returns {Promise<OrphanReport>}
 */
export async function findOrphans(input) {
  /** @type {any} */
  const fs = input.fs ?? { readdir, rm, stat };
  const pluginHome = input.pluginHome ?? join(input.dataRoot, "session-rewind");
  const existing = new Set();
  const workspaceRoot = join(input.dataRoot, "sessions");
  for (const workspace of await listDirs(workspaceRoot, fs)) {
    for (const sessionId of await listDirs(join(workspaceRoot, workspace), fs)) {
      existing.add(sessionId);
    }
  }
  const sessionIds = [];
  const trashIds = [];
  const rescueIds = [];
  let bytes = 0;
  for (const id of await listDirs(join(pluginHome, "sessions"), fs)) {
    if (existing.has(id)) continue;
    sessionIds.push(id);
    bytes += await dirBytes(join(pluginHome, "sessions", id), fs);
  }
  for (const id of await listDirs(join(pluginHome, "trash"), fs)) {
    if (existing.has(id)) continue;
    trashIds.push(id);
    bytes += await dirBytes(join(pluginHome, "trash", id), fs);
  }
  for (const id of await listDirs(join(pluginHome, "rescues"), fs)) {
    if (existing.has(id)) continue;
    rescueIds.push(id);
    bytes += await dirBytes(join(pluginHome, "rescues", id), fs);
  }
  return { sessionIds, trashIds, rescueIds, bytes };
}

/**
 * 删除孤儿数据。`dryRun` 只返回报告、不做任何删除。
 * @param {{dataRoot: string, pluginHome?: string, dryRun?: boolean, fs?: any}} input
 * @returns {Promise<{report: OrphanReport, removed: {sessions: string[], trash: string[], rescues: string[]}, failed: Array<{target: string, error: string}>}>}
 */
export async function pruneOrphans(input) {
  /** @type {any} */
  const fs = input.fs ?? { readdir, rm, stat };
  const pluginHome = input.pluginHome ?? join(input.dataRoot, "session-rewind");
  const report = await findOrphans({ ...input, pluginHome });
  /** @type {{sessions: string[], trash: string[], rescues: string[]}} */
  const removed = { sessions: [], trash: [], rescues: [] };
  /** @type {Array<{target: string, error: string}>} */
  const failed = [];
  if (input.dryRun === true) return { report, removed, failed };
  /** @type {Array<[string, string[], string[]]>} */
  const plan = [
    [join(pluginHome, "sessions"), report.sessionIds, removed.sessions],
    [join(pluginHome, "trash"), report.trashIds, removed.trash],
    [join(pluginHome, "rescues"), report.rescueIds, removed.rescues],
  ];
  for (const [root, ids, sink] of plan) {
    for (const id of ids) {
      const target = join(root, id);
      try {
        await fs.rm(target, { recursive: true, force: true });
        sink.push(id);
      } catch (error) {
        failed.push({ target, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { report, removed, failed };
}
