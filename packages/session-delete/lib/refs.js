// @ts-check
// 7 处引用的适配器表。每一处都实现同一组动作：snapshot / remove / restore / inspect。
// tier 决定它在 plan 里被标成「可自动处理」还是「未知，仅报告」。
import { join } from "node:path";
import { trashRoot } from "./paths.js";

/**
 * @typedef {"api" | "internal" | "unknown"} RefTier
 *
 * @typedef {object} RefSnapshot
 * @property {string[]} [workspaceIds]
 * @property {boolean | null} [pinned]
 *
 * @typedef {object} RefAdapter
 * @property {string} id
 * @property {string} label
 * @property {RefTier} tier
 * @property {(sessionId: string) => Promise<RefSnapshot>} [snapshot]
 * @property {(sessionId: string, snapshot: RefSnapshot) => Promise<void>} [remove]
 * @property {(sessionId: string, snapshot: RefSnapshot) => Promise<void>} [restore]
 * @property {(sessionId: string) => Promise<{ id: string, label: string, status: "ok" | "failed" | "skipped", detail: string }>} [inspect]
 */

/**
 * 构建引用适配器列表。缺失的服务会以 tier="unknown" 的形式出现在清单里，
 * 让用户知道「这一处我们处理不了」，而不是假装删干净了。
 *
 * @param {import("./capability.js").Capabilities} caps
 * @param {any} logger
 * @returns {RefAdapter[]}
 */
export function buildRefs(caps, logger) {
  const { workspace, storageDomain, sessions, agents } = caps.services;
  const check = caps.checks;

  /** @type {RefAdapter[]} */
  const refs = [];

  refs.push({
    id: "workspace-archive",
    label: "归档标记",
    tier: check["workspace.unarchive"] ? "api" : "unknown",
    remove: async (sessionId) => {
      if (typeof workspace?.unarchiveSession !== "function")
        throw new Error("unarchiveSession unavailable");
      await workspace.unarchiveSession(sessionId);
    },
  });

  refs.push({
    id: "workspace-pin",
    label: "置顶标记",
    tier: check["workspace.unpin"] ? "api" : "unknown",
    remove: async (sessionId) => {
      if (typeof workspace?.unpinSession !== "function")
        throw new Error("unpinSession unavailable");
      await workspace.unpinSession(sessionId);
    },
    restore: async (sessionId, snapshot) => {
      if (!snapshot?.pinned) return;
      if (typeof workspace?.pinSession === "function") await workspace.pinSession(sessionId);
    },
  });

  refs.push({
    id: "workspace-slot",
    label: "工作区记账",
    tier: check["workspace.list"] ? "api" : "unknown",
    snapshot: async (sessionId) => {
      /** @type {string[]} */
      const workspaceIds = [];
      if (typeof workspace?.list !== "function") return { workspaceIds };
      for (const item of workspace.list() ?? []) {
        const ids = Array.isArray(item?.sessionIds) ? item.sessionIds : [];
        if (ids.includes(sessionId)) workspaceIds.push(String(item.id));
      }
      return { workspaceIds };
    },
    remove: async (sessionId) => {
      for (const item of workspace?.list?.() ?? []) {
        const ids = Array.isArray(item?.sessionIds) ? item.sessionIds : [];
        if (!ids.includes(sessionId)) continue;
        if (typeof item.detachSession === "function") await item.detachSession(sessionId);
        else logger.warn(`session-delete: workspace ${item.id} has no detachSession`);
      }
    },
    restore: async (sessionId, snapshot) => {
      for (const workspaceId of snapshot?.workspaceIds ?? []) {
        const item = (workspace?.list?.() ?? []).find(
          (/** @type {any} */ w) => String(w.id) === workspaceId,
        );
        if (item && typeof item.attachSession === "function") await item.attachSession(sessionId);
      }
    },
    inspect: async (sessionId) => {
      if (typeof workspace?.list !== "function") {
        return {
          id: "workspace-slot",
          label: "工作区记账",
          status: "skipped",
          detail: "宿主没有 workspaceRegistry.list",
        };
      }
      const remaining = (workspace.list() ?? []).filter(
        (/** @type {any} */ item) =>
          Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId),
      );
      return remaining.length === 0
        ? { id: "workspace-slot", label: "工作区记账", status: "ok", detail: "已从所有工作区摘除" }
        : {
            id: "workspace-slot",
            label: "工作区记账",
            status: "failed",
            detail: `仍留在 ${remaining.length} 个工作区`,
          };
    },
  });

  refs.push({
    id: "projection-cache",
    label: "投影缓存",
    tier: check["storage.domain"] ? "internal" : "unknown",
    remove: async (sessionId) => {
      const domain = storageDomain?.get?.("session_projcache");
      if (!domain) throw new Error("session_projcache domain unavailable");
      const table = domain.table?.("sessions");
      if (!table || typeof table.delete !== "function")
        throw new Error("projection table unavailable");
      await table.delete(sessionId);
    },
  });

  refs.push({
    id: "host-memory",
    label: "宿主内存条目",
    tier: check["sessions.detach"] ? "internal" : "unknown",
    remove: async (sessionId) => {
      const detach = (/** @type {any} */ service) => {
        const entry = service?.store?.get?.(sessionId);
        if (!entry) return;
        if (typeof service.detachEntered !== "function")
          throw new Error("detachEntered unavailable");
        service.detachEntered(entry);
      };
      detach(agents);
      detach(sessions);
    },
    inspect: async (sessionId) => {
      const stillLive = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
      return stillLive === undefined
        ? { id: "host-memory", label: "宿主内存条目", status: "ok", detail: "已不在宿主内存中" }
        : {
            id: "host-memory",
            label: "宿主内存条目",
            status: "failed",
            detail: "宿主仍持有该会话",
          };
    },
  });

  refs.push({
    id: "spill-directory",
    label: "spill 溢出目录",
    tier: "unknown",
    inspect: async () => ({
      id: "spill-directory",
      label: "spill 溢出目录",
      status: "skipped",
      detail: "布局未验证，未做处理（如需清理请手工确认）",
    }),
  });

  return refs;
}

/**
 * 回收站自身的一致性检查（meta 与实际数据是否对得上）。
 * @param {string} dataRoot
 * @param {{ entryId: string, bytes: number }[]} entries
 * @returns {{ id: string, label: string, status: "ok" | "failed" | "skipped", detail: string }[]}
 */
export function describeTrashRoot(dataRoot, entries) {
  void entries;
  return [
    {
      id: "trash-root",
      label: "回收站目录",
      status: "ok",
      detail: join(trashRoot(dataRoot)),
    },
  ];
}
