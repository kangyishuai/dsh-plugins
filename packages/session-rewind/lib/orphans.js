// @ts-check
// 孤儿数据清理：会话被删除后，`<DSH_HOME>/session-rewind/` 里可能还留着它的
// entries / trash / rescues。本模块只做「找出并删除这些残留」，不碰仍然存在的会话，
// 也不碰 audit.jsonl（审计是 append-only 的历史记录）。
//
// 安全性（2026-11-28 审计 AUD-REW-01 + 独立复审 B1 后收紧）：
//   - 枚举宿主布局时按目录结构 + 字符集双重判断：workspace 根与 workspace 内都只认
//     `Dirent.isDirectory()`；会话 id 还必须是安全字符集（删除目标也用同一字符集，不可能成为
//     删除目标的 id 不需要进存活集合）。工作区目录名本身是宿主路径编码（`--Users-…--`），
//     不能过滤。于是「扁平布局」「多一层嵌套」这类不认识的形态会得到 0 个存活 id → 视为枚举
//     失败而跳过，而不是把全部数据当孤儿。
//   - 枚举不到任何存活会话（`liveSessionCount === 0`）一律视为「枚举失败」；任一 workspace
//     读失败（EACCES 等）标记 `incomplete`。两种情况都跳过清理并告警，绝不把「不知道」当成
//     「全部都是孤儿」（AGENTS 硬性约定 1）。
//   - 只扫描 `pluginHome` 下的 sessions/ trash/ rescues/ 三个目录，且只删除安全字符集的目录；
//     不认识的插件数据条目进 `unknownIds`，保留并告警。
//   - 删除前先用 `onPlan` 把 dry-run 计划交给调用方写审计（审计先行）；计划审计失败则不删。
//   - 删除失败逐条记录，不中断其余清理。
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** 插件数据目录名（要删除的 id）的安全字符集。未知形态保留不删。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * @typedef {object} OrphanUnknownEntry
 * @property {"sessions" | "trash" | "rescues"} root 插件数据子目录
 * @property {string} id 目录名
 * @property {"unsafe-id" | "not-directory" | "unreadable"} reason 保留原因（只告警，不删除）
 */

/**
 * @typedef {object} OrphanReport
 * @property {string[]} sessionIds 插件 data 里存在、但会话已不存在的 id
 * @property {string[]} trashIds 孤儿 trash 目录对应的 id
 * @property {string[]} rescueIds 孤儿 rescue 目录对应的 id
 * @property {number} bytes 估算占用字节数
 * @property {number} liveSessionCount 枚举到的存活会话数
 * @property {boolean} enumerationFailed 无法安全枚举存活会话（结果为空 / incomplete）；为 true 时不得清理
 * @property {boolean} incomplete 至少一个 workspace 读失败（部分不可读），属枚举失败
 * @property {number} unreadableWorkspaces workspace 读取失败的数量
 * @property {OrphanUnknownEntry[]} unknownIds 插件数据里不认识/读不到的条目（保留并告警）
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
 * 读取目录的 Dirent 列表；目录不存在/不可读返回 null（与「空目录」区分）。
 * @param {string} dir
 * @param {any} fs
 * @returns {Promise<Array<{name: string, isDirectory: () => boolean}> | null>}
 */
async function listDirEntries(dir, fs) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (_error) {
    return null;
  }
}

/**
 * 读取插件数据目录下的可删除子目录名：只接受安全字符集的目录；其余进 `unknown`（保留 + 告警）。
 * 目录不存在/整体不可读时返回空结果（没有可清理的数据）。
 * @param {string} dir
 * @param {"sessions" | "trash" | "rescues"} rootName
 * @param {any} fs
 * @returns {Promise<{ids: string[], unknown: OrphanUnknownEntry[]}>}
 */
async function listRemovableIds(dir, rootName, fs) {
  const entries = await listDirEntries(dir, fs);
  if (entries === null) return { ids: [], unknown: [] };
  /** @type {string[]} */
  const ids = [];
  /** @type {OrphanUnknownEntry[]} */
  const unknown = [];
  for (const entry of entries) {
    if (!SAFE_ID.test(entry.name)) {
      unknown.push({ root: rootName, id: entry.name, reason: "unsafe-id" });
      continue;
    }
    if (!entry.isDirectory()) {
      unknown.push({ root: rootName, id: entry.name, reason: "not-directory" });
      continue;
    }
    let info;
    try {
      info = await fs.lstat(join(dir, entry.name));
    } catch (_error) {
      unknown.push({ root: rootName, id: entry.name, reason: "unreadable" });
      continue;
    }
    if (!info.isDirectory()) {
      unknown.push({ root: rootName, id: entry.name, reason: "not-directory" });
      continue;
    }
    ids.push(entry.name);
  }
  return { ids: ids.sort(), unknown };
}

/**
 * 枚举宿主 `<dataRoot>/sessions/` 下所有存活会话 id。
 *
 * 布局假设与护栏（复审 B1）：
 * - workspace 根与 workspace 内都只认目录（`Dirent.isDirectory()`）；文件条目不算会话。
 * - 会话 id 必须匹配安全字符集：删除目标用的是同一字符集，不可能成为删除目标的 id 不需要进
 *   存活集合；「扁平布局」（sessions/<id>/session.v4…）与「多一层嵌套 --project--」都会得到
 *   0 个候选 → 视为枚举失败，而不是把全部数据判成孤儿。
 * - 任一 workspace 读失败（EACCES 等）→ `incomplete`，同样跳过清理（保守优先）。
 * @param {string} dataRoot
 * @param {any} fs
 * @returns {Promise<{ids: Set<string>, failed: boolean, incomplete: boolean, unreadableWorkspaces: number, workspaceCount: number}>}
 */
async function enumerateLiveSessionIds(dataRoot, fs) {
  const root = join(dataRoot, "sessions");
  const workspaces = await listDirEntries(root, fs);
  if (workspaces === null) {
    return {
      ids: new Set(),
      failed: true,
      incomplete: true,
      unreadableWorkspaces: 1,
      workspaceCount: 0,
    };
  }
  /** @type {Set<string>} */
  const ids = new Set();
  let unreadableWorkspaces = 0;
  let workspaceCount = 0;
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    workspaceCount += 1;
    const children = await listDirEntries(join(root, workspace.name), fs);
    if (children === null) {
      unreadableWorkspaces += 1;
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (!SAFE_ID.test(child.name)) continue;
      ids.add(child.name);
    }
  }
  const incomplete = unreadableWorkspaces > 0;
  return {
    ids,
    failed: incomplete || ids.size === 0,
    incomplete,
    unreadableWorkspaces,
    workspaceCount,
  };
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
    incomplete: live.incomplete,
    unreadableWorkspaces: live.unreadableWorkspaces,
    unknownIds: [],
  };
  /** @type {Array<{root: string, rootName: "sessions" | "trash" | "rescues", sink: string[]}>} */
  const roots = [
    { root: join(pluginHome, "sessions"), rootName: "sessions", sink: report.sessionIds },
    { root: join(pluginHome, "trash"), rootName: "trash", sink: report.trashIds },
    { root: join(pluginHome, "rescues"), rootName: "rescues", sink: report.rescueIds },
  ];
  for (const { root, rootName, sink } of roots) {
    const { ids, unknown } = await listRemovableIds(root, rootName, fs);
    report.unknownIds.push(...unknown);
    // 枚举失败时只收集 unknown（用于告警），不猜测任何孤儿。
    if (live.failed) continue;
    for (const id of ids) {
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
 * 枚举失败（一个存活会话都没枚举到 / 部分 workspace 不可读 / 未知宿主布局）或计划审计失败时
 * **不删除**，在 `reason` 里说明。
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
