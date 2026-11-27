// @ts-check
// 孤儿数据清理：会话被删除后，`<DSH_HOME>/session-rewind/` 里可能还留着它的
// entries / trash / rescues。本模块只做「找出并删除这些残留」，不碰仍然存在的会话，
// 也不碰 audit.jsonl（审计是 append-only 的历史记录）。
//
// 安全性（2026-11-28 审计 AUD-REW-01 后收紧）：
//   - 枚举存活会话时**不**用「安全字符集」过滤工作区目录名：宿主把工作区目录编码成
//     `--Users-someone-Workspace-project--`（首字符是 `-`），任何安全字符集都会把它判成
//     「不存在」，从而把全部真实数据误判成孤儿。会话 id 也不做字符集过滤：只用于集合匹配，
//     不参与路径拼接。
//   - 枚举不到任何存活会话（`liveSessionCount === 0`）一律视为「枚举失败」，跳过清理并告警；
//     绝不把「一个都没枚举到」当成「全部都是孤儿」（AGENTS 硬性约定 1）。
//   - 只扫描 `pluginHome` 下的 sessions/ trash/ rescues/ 三个目录，且只删除名字匹配安全字符集的
//     条目；不认识的条目保留并告警。
//   - 删除前先用 `onPlan` 把 dry-run 计划交给调用方写审计（审计先行）；计划审计失败则不删。
//   - 删除失败逐条记录，不中断其余清理。
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** 插件数据目录名（要删除的 id）的安全字符集。未知形态保留不删。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * @typedef {object} OrphanReport
 * @property {string[]} sessionIds 插件 data 里存在、但会话已不存在的 id
 * @property {string[]} trashIds 孤儿 trash 目录对应的 id
 * @property {string[]} rescueIds 孤儿 rescue 目录对应的 id
 * @property {number} bytes 估算占用字节数
 * @property {number} liveSessionCount 枚举到的存活会话数
 * @property {boolean} enumerationFailed 无法枚举存活会话（枚举结果为空也视为失败）；为 true 时不得清理
 */

/**
 * @typedef {object} OrphanPruneResult
 * @property {OrphanReport} report dry-run 计划
 * @property {{sessions: string[], trash: string[], rescues: string[]}} removed 已删除的 id
 * @property {Array<{target: string, error: string}>} failed 删除失败条目（逐条记录）
 * @property {boolean} executed 是否真正执行了删除
 * @property {string | null} reason 未执行/提前结束的原因：`enumeration-failed` / `plan-audit-failed`
 */

/**
 * 读取目录下的直接子目录名；不存在的目录返回空数组。**不做字符集过滤**（用于枚举宿主布局）。
 * @param {string} dir
 * @param {any} fs
 * @returns {Promise<string[] | null>} 读取失败返回 null（与「空目录」区分）
 */
async function listDirNames(dir, fs) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_error) {
    return null;
  }
  return entries.map((/** @type {any} */ entry) => entry.name);
}

/**
 * 读取插件数据目录下的可删除子目录名：只接受安全字符集，未知形态保留不删。
 * 目录不存在/不可读时返回空数组（没有可清理的数据）。
 * @param {string} dir
 * @param {any} fs
 * @returns {Promise<string[]>}
 */
async function listRemovableIds(dir, fs) {
  const names = await listDirNames(dir, fs);
  if (names === null) return [];
  /** @type {string[]} */
  const out = [];
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    let info;
    try {
      info = await fs.lstat(join(dir, name));
    } catch (_error) {
      continue;
    }
    if (!info.isDirectory()) continue;
    out.push(name);
  }
  return out.sort();
}

/**
 * 枚举宿主 `<dataRoot>/sessions/` 下所有存活会话 id。
 *
 * 工作区目录名由宿主按路径编码（`--Users-…--`），不能用安全字符集过滤；这里对所有子项都尝试
 * 读取一层，读不出来就跳过（保留，而不是判成不存在）。一个 id 都枚举不到时标记为枚举失败。
 * @param {string} dataRoot
 * @param {any} fs
 * @returns {Promise<{ids: Set<string>, failed: boolean, workspaceCount: number}>}
 */
async function enumerateLiveSessionIds(dataRoot, fs) {
  const root = join(dataRoot, "sessions");
  const workspaces = await listDirNames(root, fs);
  if (workspaces === null) return { ids: new Set(), failed: true, workspaceCount: 0 };
  /** @type {Set<string>} */
  const ids = new Set();
  for (const workspace of workspaces) {
    const children = await listDirNames(join(root, workspace), fs);
    if (children === null) continue;
    for (const child of children) ids.add(child);
  }
  return { ids, failed: ids.size === 0, workspaceCount: workspaces.length };
}

/**
 * 递归计算目录字节数（估算）。
 * @param {string} target
 * @param {any} fs
 * @returns {Promise<number>}
 */
async function dirBytes(target, fs) {
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
  for (const entry of entries) total += await dirBytes(join(target, entry), fs);
  return total;
}

/**
 * 找出插件数据里已经没有对应会话的 id。
 *
 * `enumerationFailed === true` 时 `sessionIds/trashIds/rescueIds` 一律为空（不猜测孤儿），
 * 调用方必须跳过清理。
 * @param {{dataRoot: string, pluginHome?: string, fs?: any}} input
 * @returns {Promise<OrphanReport>}
 */
export async function findOrphans(input) {
  /** @type {any} */
  const fs = input.fs ?? { lstat, readdir, rm, stat };
  const pluginHome = input.pluginHome ?? join(input.dataRoot, "session-rewind");
  const live = await enumerateLiveSessionIds(input.dataRoot, fs);
  /** @type {OrphanReport} */
  const report = {
    sessionIds: [],
    trashIds: [],
    rescueIds: [],
    bytes: 0,
    liveSessionCount: live.ids.size,
    enumerationFailed: live.failed,
  };
  if (live.failed) return report;
  /** @type {Array<{root: string, sink: string[]}>} */
  const roots = [
    { root: join(pluginHome, "sessions"), sink: report.sessionIds },
    { root: join(pluginHome, "trash"), sink: report.trashIds },
    { root: join(pluginHome, "rescues"), sink: report.rescueIds },
  ];
  for (const { root, sink } of roots) {
    for (const id of await listRemovableIds(root, fs)) {
      if (live.ids.has(id)) continue;
      sink.push(id);
      report.bytes += await dirBytes(join(root, id), fs);
    }
  }
  return report;
}

/**
 * 删除孤儿数据。
 *
 * 流程：找孤儿（dry-run 计划）→ 交给 `onPlan` 写审计 → 删除 → 逐条记录失败。
 * `dryRun: true` 只返回报告，不调用 `onPlan`、不做任何删除。
 * 枚举失败（一个存活会话都没枚举到）或计划审计失败时**不删除**，在 `reason` 里说明。
 * @param {{
 *   dataRoot: string,
 *   pluginHome?: string,
 *   dryRun?: boolean,
 *   fs?: any,
 *   onPlan?: (report: OrphanReport) => void | Promise<void>,
 * }} input
 * @returns {Promise<OrphanPruneResult>}
 */
export async function pruneOrphans(input) {
  /** @type {any} */
  const fs = input.fs ?? { lstat, readdir, rm, stat };
  const pluginHome = input.pluginHome ?? join(input.dataRoot, "session-rewind");
  const report = await findOrphans({ ...input, pluginHome });
  /** @type {OrphanPruneResult} */
  const result = {
    report,
    removed: { sessions: [], trash: [], rescues: [] },
    failed: [],
    executed: false,
    reason: null,
  };
  if (input.dryRun === true) return result;

  const planTotal = report.sessionIds.length + report.trashIds.length + report.rescueIds.length;
  // 审计先行：真正有清理计划（或枚举失败要留证）时，先把 dry-run 计划交给调用方持久化；
  // 审计失败则不删（启动期清理没有紧迫性）。没有孤儿时不写空计划，避免每次启动堆审计行。
  if ((report.enumerationFailed || planTotal > 0) && typeof input.onPlan === "function") {
    try {
      await input.onPlan(report);
    } catch (error) {
      result.failed.push({
        target: "plan",
        error: error instanceof Error ? error.message : String(error),
      });
      result.reason = "plan-audit-failed";
      return result;
    }
  }

  if (report.enumerationFailed) {
    result.reason = "enumeration-failed";
    return result;
  }

  result.executed = true;
  if (planTotal === 0) return result;
  /** @type {Array<[string, string[], string[]]>} */
  const plan = [
    [join(pluginHome, "sessions"), report.sessionIds, result.removed.sessions],
    [join(pluginHome, "trash"), report.trashIds, result.removed.trash],
    [join(pluginHome, "rescues"), report.rescueIds, result.removed.rescues],
  ];
  for (const [root, ids, sink] of plan) {
    for (const id of ids) {
      const target = join(root, id);
      try {
        await fs.rm(target, { recursive: true, force: true });
        sink.push(id);
      } catch (error) {
        result.failed.push({
          target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}
