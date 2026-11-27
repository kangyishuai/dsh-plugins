// @ts-check
// 工作区存储的只读快照。归档/置顶集合**没有公开的读接口**，只能读 storages/workspace.json：
// 这是文件级兜底，不是宿主契约（见 docs/runtime 里 workspaceRegistry 一节）。
// 只读、绝不手改；读不到就如实返回 ok:false，调用方据此降级为「状态未知」。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @typedef {object} WorkspaceState
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {string[]} archivedIds
 * @property {string[]} pinnedIds
 * @property {{ id: string, sessionIds: string[] }[]} workspaces
 */

/**
 * @param {string} dataRoot
 * @returns {Promise<WorkspaceState>}
 */
export async function readWorkspaceState(dataRoot) {
  const file = join(dataRoot, "storages", "workspace.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `无法读取 ${file}：${error instanceof Error ? error.message : String(error)}`,
      archivedIds: [],
      pinnedIds: [],
      workspaces: [],
    };
  }
  const global = parsed?.global ?? {};
  const tables = parsed?.tables ?? {};
  const workspaces = Object.entries(tables.workspaces ?? {}).map(([id, value]) => ({
    id,
    sessionIds: Array.isArray(/** @type {any} */ (value)?.sessionIds)
      ? /** @type {any} */ (value).sessionIds.map(String)
      : [],
  }));
  return {
    ok: true,
    archivedIds: Array.isArray(global.archivedSessionIds)
      ? global.archivedSessionIds.map(String)
      : [],
    pinnedIds: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds.map(String) : [],
    workspaces,
  };
}

/**
 * 会话是否在置顶集合里。读不到存储时返回 null（未知 ≠ 未置顶）。
 * @param {string} dataRoot
 * @param {string} sessionId
 * @returns {Promise<boolean | null>}
 */
export async function readPinnedFlag(dataRoot, sessionId) {
  const state = await readWorkspaceState(dataRoot);
  if (!state.ok) return null;
  return state.pinnedIds.includes(sessionId);
}
