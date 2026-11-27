// @ts-check
// 7 处引用的适配器表。每一处都实现同一组动作：snapshot / remove / restore / inspect。
// tier 决定它在 plan 里被标成「可自动处理」还是「未知，仅报告」。
import { join } from "node:path";
import { trashRoot } from "./paths.js";
import { readPinnedFlag } from "./workspace-state.js";

/**
 * @typedef {"api" | "internal" | "unknown"} RefTier
 *
 * @typedef {object} RefSnapshot
 * @property {string[]} [workspaceIds]
 * @property {boolean | null} [pinned]
 *
 * restore 的返回值让适配器能区分「本来就不用恢复」和「恢复失败」；
 * 返回 undefined 视作成功（向后兼容）。
 * @typedef {object} RefRestoreResult
 * @property {"ok" | "skipped" | "failed"} [status]
 * @property {string} [detail]
 *
 * @typedef {object} RefAdapter
 * @property {string} id
 * @property {string} label
 * @property {RefTier} tier
 * @property {(sessionId: string) => Promise<RefSnapshot>} [snapshot]
 * @property {(sessionId: string, snapshot: RefSnapshot) => Promise<void>} [remove]
 * @property {(sessionId: string, snapshot: RefSnapshot) => Promise<void | RefRestoreResult>} [restore]
 * @property {(sessionId: string) => Promise<{ id: string, label: string, status: "ok" | "failed" | "skipped", detail: string }>} [inspect]
 */

/**
 * 构建引用适配器列表。缺失的服务会以 tier="unknown" 的形式出现在清单里，
 * 让用户知道「这一处我们处理不了」，而不是假装删干净了。
 *
 * @param {import("./capability.js").Capabilities} caps
 * @param {any} logger
 * @param {{ dataRoot?: string }} [options] dataRoot 用于读取置顶集合（没有公开读接口）。
 * @returns {RefAdapter[]}
 */
export function buildRefs(caps, logger, options = {}) {
  const { workspace, storageDomain, sessions, agents } = caps.services;
  const check = caps.checks;
  const dataRoot = options.dataRoot ?? null;

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
    // 删除的第 1 步会 archive 会话（当作 agent/pre-step 闸门），恢复时把它解开。
    // 归档标记本身不会被还原（ADR：恢复的期望是「会话回到列表」，见 AUD-SD-11 的取舍）。
    //
    // USIM-U3-02 修：宿主不提供该接口时**不能抛异常**。删除阶段同样是 unknown 档、
    // 根本没归档过，恢复阶段再报「失败」只会让用户看到一条假的「1 处引用未通过」。
    // 返回 skipped 才是事实：这一处没动过，也没有需要撤的。

    // USIM-U3-02 / N6：解除归档失败意味着「会话回来了但仍可能被归档集合挡住」
    // ——它同时是删除时的 agent/pre-step 闸门，所以必须给出下一步而不是原始英文。
    restore: async (sessionId) => {
      if (typeof workspace?.unarchiveSession !== "function") {
        return { status: "skipped", detail: "当前宿主不提供 unarchiveSession，未做处理" };
      }
      try {
        await workspace.unarchiveSession(sessionId);
      } catch (error) {
        return {
          status: "failed",
          detail:
            `归档标记未能解除（${error instanceof Error ? error.message : error}）；` +
            "会话可能仍在归档状态，可在侧栏的归档列表里手动取消归档",
        };
      }
      return { status: "ok" };
    },
  });

  refs.push({
    id: "workspace-pin",
    label: "置顶标记",
    tier: check["workspace.unpin"] ? "api" : "unknown",
    // 置顶集合没有公开读接口：读 storages/workspace.json（只读兜底）。
    // 读不到时返回 null = 状态未知，绝不能当成「未置顶」。
    snapshot: async (sessionId) => {
      if (typeof dataRoot !== "string") return { pinned: null };
      const pinned = await readPinnedFlag(dataRoot, sessionId).catch(() => null);
      return { pinned };
    },
    remove: async (sessionId) => {
      if (typeof workspace?.unpinSession !== "function")
        throw new Error("unpinSession unavailable");
      await workspace.unpinSession(sessionId);
    },
    restore: async (sessionId, snapshot) => {
      if (snapshot?.pinned !== true) return { status: "skipped", detail: "原本未置顶" };
      if (typeof workspace?.pinSession !== "function") {
        return { status: "skipped", detail: "当前宿主不提供 pinSession，未做处理" };
      }
      try {
        await workspace.pinSession(sessionId);
      } catch (error) {
        return {
          status: "failed",
          detail:
            `置顶没有恢复（${error instanceof Error ? error.message : error}）；` +
            "可在会话右键菜单里手动置顶",
        };
      }
      return { status: "ok" };
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
      /** @type {string[]} */
      const missing = [];
      /** @type {string[]} */
      const failed = [];
      const workspaceIds = snapshot?.workspaceIds ?? [];
      if (workspaceIds.length === 0) {
        return { status: "ok", detail: "原本不在任何工作区" };
      }
      for (const workspaceId of workspaceIds) {
        const item = (workspace?.list?.() ?? []).find(
          (/** @type {any} */ w) => String(w.id) === workspaceId,
        );
        if (!item) {
          missing.push(workspaceId);
          continue;
        }
        if (typeof item.attachSession !== "function") {
          failed.push(`${workspaceId}（宿主没有 attachSession）`);
          continue;
        }
        try {
          await item.attachSession(sessionId);
        } catch (error) {
          failed.push(`${workspaceId}（${error instanceof Error ? error.message : error}）`);
        }
      }
      // 逐项说出是哪一处，并给下一步动作；不再 throw（throw 只会把整个引用列表
      // 压成一句「挂回工作区失败」，用户仍然不知道点哪里修）。
      if (failed.length > 0) {
        return {
          status: "failed",
          detail: `未挂回工作区：${failed.join("、")}；可在会话右键菜单「归属到项目…」里手动挂回`,
        };
      }
      if (missing.length > 0) {
        return {
          status: "skipped",
          detail: `原工作区已不存在：${missing.join("、")}；可在会话右键菜单「归属到项目…」里挂到别的工作区`,
        };
      }
      return { status: "ok", detail: `已挂回 ${workspaceIds.length} 个工作区` };
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
 * 记录所有引用的删除前状态（供恢复时还原）。失败的适配器只告警并跳过——
 * 恢复阶段会把「缺快照」如实记成 skipped，而不是假装还原成功。
 * @param {RefAdapter[]} refs
 * @param {string} sessionId
 * @param {any} logger
 * @returns {Promise<Record<string, RefSnapshot>>}
 */
export async function snapshotAllRefs(refs, sessionId, logger) {
  /** @type {Record<string, RefSnapshot>} */
  const snapshots = {};
  for (const ref of refs) {
    if (typeof ref.snapshot !== "function") continue;
    try {
      snapshots[ref.id] = await ref.snapshot(sessionId);
    } catch (error) {
      logger.warn(
        `session-delete: snapshot ${ref.id} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return snapshots;
}

/**
 * 摘掉所有还指向该会话的引用。幂等：恢复/补做会重复调用它。
 * @param {RefAdapter[]} refs
 * @param {string} sessionId
 * @param {Record<string, RefSnapshot>} snapshots
 * @returns {Promise<{ id: string, label: string, status: "ok" | "failed" | "skipped", detail?: string }[]>}
 */
export async function removeAllRefs(refs, sessionId, snapshots = {}) {
  /** @type {{ id: string, label: string, status: "ok" | "failed" | "skipped", detail?: string }[]} */
  const removed = [];
  for (const ref of refs) {
    if (typeof ref.remove !== "function" || ref.tier === "unknown") {
      removed.push({
        id: ref.id,
        label: ref.label,
        status: "skipped",
        detail: "当前宿主不提供该接口",
      });
      continue;
    }
    try {
      await ref.remove(sessionId, snapshots[ref.id] ?? {});
      removed.push({ id: ref.id, label: ref.label, status: "ok" });
    } catch (error) {
      removed.push({
        id: ref.id,
        label: ref.label,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}

/**
 * 把引用恢复到删除前的状态；逐项记录结果，失败不中断其余项（会话文件已经回来了，
 * 不能因为一个引用失败把恢复整体判死）。
 *
 * 三道闸门（USIM-U3-02）：
 * 1. `tier === "unknown"` 的引用**跳过**，不报失败 —— 删除阶段同样没动它（removeAllRefs
 *    的同一判据），恢复阶段再报失败就是假警报；
 * 2. 适配器自己在接口缺失时返回 `skipped`（见 refs.js 各 restore），不再抛异常；
 * 3. 失败项的 detail 必须带「是哪一处 + 下一步动作」，直接进回执、审计和界面。
 *
 * @param {RefAdapter[]} refs
 * @param {string} sessionId
 * @param {RefSnapshot} snapshot
 * @param {{ onlyIds?: string[], retried?: boolean }} [options] onlyIds 只重试这些引用（自动重试一次用）
 * @returns {Promise<{ id: string, label: string, status: "ok" | "failed" | "skipped", detail?: string, retried?: boolean }[]>}
 */
export async function restoreAllRefs(refs, sessionId, snapshot, options = {}) {
  const onlyIds = Array.isArray(options.onlyIds) ? new Set(options.onlyIds) : null;
  /** @type {{ id: string, label: string, status: "ok" | "failed" | "skipped", detail?: string, retried?: boolean }[]} */
  const results = [];
  for (const ref of refs) {
    if (onlyIds !== null && !onlyIds.has(ref.id)) continue;
    if (typeof ref.restore !== "function") {
      results.push({
        id: ref.id,
        label: ref.label,
        status: "skipped",
        detail: "该引用没有恢复动作",
        ...(options.retried === true ? { retried: true } : {}),
      });
      continue;
    }
    if (ref.tier === "unknown" && onlyIds === null) {
      results.push({
        id: ref.id,
        label: ref.label,
        status: "skipped",
        detail: "当前宿主不提供该接口，未做处理",
      });
      continue;
    }
    try {
      const outcome = await ref.restore(sessionId, snapshot);
      results.push({
        id: ref.id,
        label: ref.label,
        status: outcome?.status ?? "ok",
        detail: outcome?.detail,
        ...(options.retried === true ? { retried: true } : {}),
      });
    } catch (error) {
      results.push({
        id: ref.id,
        label: ref.label,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        ...(options.retried === true ? { retried: true } : {}),
      });
    }
  }
  return results;
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
