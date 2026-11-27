// @ts-check
// 启动对账（AUD-SD-01）：journal 里的 intent 只说明「打算做什么」，真相在磁盘上。
// 这里按**落盘事实**把每条未完成记录判定成三种结论之一，并且可以重复执行：
//   completed   已发生（会话在回收站 / 已搬回原处）→ 把收尾补完；
//   rolled-back 没发生（目录还在原处 / 数据还在回收站）→ 清掉记录、回滚归档闸门；
//   unresolved  两边都在或两边都不在，解释不了 → **什么都不动**，保留记录供人工核对。
// 数据安全优先：任何分支都不删唯一副本；补做失败也不会把现场改坏。
import { stat } from "node:fs/promises";
import { finishOperation, listPending } from "./journal.js";
import { directorySize, locateSession } from "./locate.js";
import { requireSessionId } from "./paths.js";
import { writeReceipt } from "./receipts.js";
import { removeAllRefs, restoreAllRefs } from "./refs.js";
import { describeRestoreSummary, restoreSummary, verifyRestored } from "./restore.js";
import {
  entryDataDir,
  entryDir,
  finalizeRestoreEntry,
  listEntries,
  moveIntoTrash,
  readEntry,
  requireEntryId,
} from "./trash.js";

/** @typedef {"completed" | "rolled-back" | "unresolved" | "failed"} RecoveryOutcome */

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} path @returns {Promise<boolean>} */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {import("./refs.js").RefAdapter[]} options.refs
 * @param {any} options.logger
 * @param {{ append: (entry: any) => Promise<{ ok: boolean, error?: string }> }} options.audit
 * @param {(sessionId: string, options?: { skipDirCheck?: boolean }) => Promise<any[]>} options.reconcile
 */
export function createRecovery({ dataRoot, refs, logger, audit, reconcile }) {
  /**
   * 审计失败也要留痕到 logger，不静默吞掉。
   * @param {any} entry
   */
  async function note(entry) {
    const result = await audit.append(entry);
    if (!result.ok) logger.warn(`session-delete: audit append failed: ${result.error}`);
    return result;
  }

  /**
   * 用与删除相同的定位逻辑找会话目录（读不到就当不存在，不猜路径）。
   * @param {string} sessionId
   */
  async function sessionDirOf(sessionId) {
    try {
      const located = await locateSession({
        dataRoot,
        sessionId,
        header: null,
        persistence: null,
      });
      return located.location?.path ?? null;
    } catch {
      return null;
    }
  }

  /** @param {string} sessionId */
  async function unarchiveBestEffort(sessionId) {
    const adapter = refs.find((ref) => ref.id === "workspace-archive");
    if (typeof adapter?.restore !== "function") return "skipped";
    try {
      await adapter.restore(sessionId, {});
      return "ok";
    } catch (error) {
      logger.warn(`session-delete: recovery unarchive failed: ${messageOf(error)}`);
      return "failed";
    }
  }

  /**
   * 找这次操作对应的回收站条目。
   * exact = journal 里记的 entryId（AUD-SD-03 之后会写）；没有就按 sessionId 找最新的那条。
   * @param {any} record
   * @param {string} sessionId
   * @returns {Promise<{ kind: "ok", entry: import("./trash.js").TrashMeta } | { kind: "none" } | { kind: "corrupt", detail: string }>}
   */
  async function lookupEntry(record, sessionId) {
    const exact = typeof record?.entryId === "string" ? record.entryId : null;
    if (exact) {
      const meta = await readEntry(dataRoot, exact).catch(() => null);
      if (meta) return { kind: "ok", entry: meta };
      const dirExists = await isDirectory(entryDir(dataRoot, exact));
      return dirExists
        ? { kind: "corrupt", detail: `回收站条目 ${exact} 存在，但 meta.json 不可读` }
        : { kind: "none" };
    }
    const listed = await listEntries(dataRoot);
    const matches = listed.entries.filter((entry) => entry.sessionId === sessionId);
    if (matches.length === 0) return { kind: "none" };
    matches.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
    return { kind: "ok", entry: matches[0] };
  }

  /**
   * trash 的现场判定。
   * @param {any} record
   * @returns {Promise<{ outcome: RecoveryOutcome, sessionId?: string, entryId?: string, detail: string }>}
   */
  async function reconcileTrash(record) {
    const sessionId = requireSessionId(record.sessionId);
    const origin = await sessionDirOf(sessionId);
    const found = await lookupEntry(record, sessionId);
    if (found.kind === "corrupt") {
      return { outcome: "unresolved", sessionId, detail: found.detail };
    }
    if (found.kind === "ok" && origin) {
      return {
        outcome: "unresolved",
        sessionId,
        entryId: found.entry.entryId,
        detail: "回收站条目与原会话目录同时存在（可能是迟到的写入），未改动任何一边",
      };
    }
    if (found.kind === "none" && !origin) {
      return {
        outcome: "unresolved",
        sessionId,
        detail: "既找不到回收站条目，也找不到原会话目录，数据位置未知",
      };
    }
    if (found.kind === "none") {
      const unarchive = await unarchiveBestEffort(sessionId);
      return {
        outcome: "rolled-back",
        sessionId,
        detail: `trash 未发生（会话目录仍在原处），已回滚归档闸门（${unarchive}）`,
      };
    }
    // 条目在、原目录不在 = 移动已完成，只是收尾被打断。补做引用清理与对账。
    const entry = found.entry;
    const removed = await removeAllRefs(refs, sessionId, {});
    const checks = await reconcile(sessionId, { skipDirCheck: true });
    const failedRefs = removed.filter((item) => item.status === "failed");
    const failedChecks = checks.filter((item) => item.status === "failed");
    await writeReceipt(dataRoot, {
      action: "trash",
      at: new Date().toISOString(),
      sessionId,
      entryId: entry.entryId,
      title: entry.title,
      sizeBytes: entry.bytes,
      recovered: true,
      removed,
      checks,
    });
    const clean = failedRefs.length === 0 && failedChecks.length === 0;
    return {
      outcome: clean ? "completed" : "unresolved",
      sessionId,
      entryId: entry.entryId,
      detail: clean
        ? `已补完 trash 收尾（引用清理 ${removed.filter((item) => item.status === "ok").length}/${removed.length}，对账通过）`
        : `已补写回执，但仍有 ${failedRefs.length} 处引用 / ${failedChecks.length} 项对账失败，需人工核对`,
    };
  }

  /**
   * restore 的现场判定。
   * @param {any} record
   * @returns {Promise<{ outcome: RecoveryOutcome, sessionId?: string, entryId?: string, detail: string }>}
   */
  async function reconcileRestore(record) {
    const entryId = requireEntryId(record.entryId);
    const dirExists = await isDirectory(entryDir(dataRoot, entryId));
    const dataExists = await isDirectory(entryDataDir(dataRoot, entryId));
    const meta = await readEntry(dataRoot, entryId).catch(() => null);

    if (!meta) {
      const sessionId =
        typeof record.sessionId === "string" && record.sessionId.length > 0
          ? record.sessionId
          : null;
      const origin = sessionId ? await sessionDirOf(sessionId) : null;
      if (!dirExists && origin) {
        return {
          outcome: "completed",
          sessionId: sessionId ?? undefined,
          entryId,
          detail: "恢复此前已完成（回收站条目已清理、会话目录已回来）",
        };
      }
      return {
        outcome: "unresolved",
        sessionId: sessionId ?? undefined,
        entryId,
        detail: "回收站条目不存在，也找不到恢复后的会话目录",
      };
    }

    const sessionId = meta.sessionId;
    const origin = await sessionDirOf(sessionId);
    if (dataExists && !origin) {
      return {
        outcome: "rolled-back",
        sessionId,
        entryId,
        detail: "restore 未发生（数据仍在回收站），已清掉记录",
      };
    }
    if (dataExists && origin) {
      return {
        outcome: "unresolved",
        sessionId,
        entryId,
        detail: "回收站数据与原会话目录同时存在，未改动任何一边",
      };
    }
    if (!dataExists && !origin) {
      return {
        outcome: "unresolved",
        sessionId,
        entryId,
        detail: "回收站数据与恢复目标都不存在，数据位置未知",
      };
    }
    // 数据已搬回、条目目录还在 = 移动完成，只差引用恢复与条目清理。
    const snapshot = {
      workspaceIds: Array.isArray(meta.workspaceIds) ? meta.workspaceIds : [],
      pinned: typeof meta.pinned === "boolean" ? meta.pinned : null,
    };
    const restoredRefs = await restoreAllRefs(refs, sessionId, snapshot);
    const checks = await verifyRestored({
      refs,
      sessionId,
      restoredTo: meta.originPath,
      meta,
    });
    await finalizeRestoreEntry({ dataRoot, entryId, meta, restoredTo: meta.originPath });
    const summary = restoreSummary(restoredRefs, checks);
    await writeReceipt(dataRoot, {
      action: "restore",
      at: new Date().toISOString(),
      sessionId,
      entryId,
      title: meta.title,
      restoredTo: meta.originPath,
      recovered: true,
      refs: restoredRefs,
      checks,
      partial: summary.partial,
      // 重检（recheckRestore）要用回执里这份快照；条目已随恢复清理。
      expected: snapshot,
      failures: summary.failures,
    });
    return {
      outcome: summary.partial ? "unresolved" : "completed",
      sessionId,
      entryId,
      detail: summary.partial
        ? `会话已搬回，但 ${describeRestoreSummary(summary)}，需人工核对`
        : "已补完 restore 收尾（引用已还原、回收站条目已清理）",
    };
  }

  /**
   * purge 的现场判定：只有一种动作（删条目目录），按目录是否还在判定。
   * @param {any} record
   */
  async function reconcilePurge(record) {
    const entryId = requireEntryId(record.entryId);
    const dirExists = await isDirectory(entryDir(dataRoot, entryId));
    if (!dirExists) {
      return {
        outcome: /** @type {RecoveryOutcome} */ ("completed"),
        entryId,
        detail: "彻底删除已完成（回收站条目已不存在）",
      };
    }
    const meta = await readEntry(dataRoot, entryId).catch(() => null);
    const dataExists = await isDirectory(entryDataDir(dataRoot, entryId));
    if (!meta || !dataExists) {
      // rm 递归删到一半会留下「有 meta 没数据」的残缺条目：这种现场不能当作
      // 「彻底删除未发生」直接销账，要留给人工确认。
      return {
        outcome: /** @type {RecoveryOutcome} */ ("unresolved"),
        entryId,
        detail: "回收站条目残缺（meta 或数据已缺失），需人工确认",
      };
    }
    return {
      outcome: /** @type {RecoveryOutcome} */ ("rolled-back"),
      sessionId: meta.sessionId,
      entryId,
      detail: "彻底删除未发生（条目完整），已清掉记录",
    };
  }

  /**
   * 扫一遍 journal，按落盘事实补做/回滚。可重复执行：第二次运行 examined=0。
   * @param {{ operator?: string }} [options]
   * @returns {Promise<{ examined: number, completed: number, rolledBack: number, unresolved: number,
   *   failed: number, results: any[], at: string }>}
   */
  async function recoverPending(options = {}) {
    const operator = options.operator ?? "system";
    const records = await listPending(dataRoot);
    /** @type {any[]} */
    const results = [];
    for (const record of records) {
      /** @type {{ outcome: RecoveryOutcome, sessionId?: string, entryId?: string, detail: string }} */
      let result;
      try {
        if (record.action === "trash") result = await reconcileTrash(record);
        else if (record.action === "restore") result = await reconcileRestore(record);
        else if (record.action === "purge") result = await reconcilePurge(record);
        else
          result = {
            outcome: "unresolved",
            detail: `无法识别的操作类型 ${String(record.action)}`,
          };
      } catch (error) {
        result = { outcome: "failed", detail: messageOf(error) };
      }

      const settled = result.outcome === "completed" || result.outcome === "rolled-back";
      try {
        if (settled) await finishOperation({ dataRoot, id: record.id, state: "done" });
        else
          await finishOperation({
            dataRoot,
            id: record.id,
            state: "failed",
            detail: result.detail,
          });
      } catch (error) {
        // 记录本身坏了也不该让整轮对账中断；保留现场并继续下一条。
        logger.warn(
          `session-delete: recovery could not settle journal ${record.id}: ${messageOf(error)}`,
        );
      }
      await note({
        action: "recover",
        result:
          result.outcome === "failed"
            ? "failed"
            : result.outcome === "unresolved"
              ? "refused"
              : "ok",
        sessionId:
          result.sessionId ?? (typeof record.sessionId === "string" ? record.sessionId : undefined),
        entryId:
          result.entryId ?? (typeof record.entryId === "string" ? record.entryId : undefined),
        operator,
        detail: `${String(record.action)}: ${result.detail}`,
      });
      results.push({
        id: record.id,
        action: record.action,
        outcome: result.outcome,
        sessionId: result.sessionId ?? record.sessionId,
        entryId: result.entryId ?? record.entryId,
        detail: result.detail,
      });
    }
    /** @param {RecoveryOutcome} outcome */
    const count = (outcome) => results.filter((item) => item.outcome === outcome).length;
    return {
      examined: records.length,
      completed: count("completed"),
      rolledBack: count("rolled-back"),
      unresolved: count("unresolved"),
      failed: count("failed"),
      results,
      at: new Date().toISOString(),
    };
  }

  /**
   * 复活守卫（AUD-SD-07）：目录被迟到的写入重建后，**真的**再移一次。
   * 只跑一次（由调用方在删除后 1.5s 触发），不会和活句柄形成循环。
   *
   * B2：删除后 1.5s 内用户可能已经 restore / purge 掉这条条目——此时原目录存在是
   * **用户操作的结果**，守卫不许再移一次（否则会把用户的恢复静默撤回）。所以先看条目：
   * 条目不存在（restore/purge 过）或条目的 data 已经被搬回原处，都直接放手。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.originalPath
   * @param {string} [options.entryId] 本次 trash 生成的条目。
   * @param {{ title?: string | null, cwd?: string | null }} [options.meta]
   * @returns {Promise<{ revived: boolean, entryId: string | null, skipped?: boolean,
   *   removed?: any[], error?: string }>}
   */
  async function reviveGuard({ sessionId, originalPath, entryId, meta }) {
    requireSessionId(sessionId);
    if (typeof entryId === "string" && entryId.length > 0) {
      const entry = await readEntry(dataRoot, entryId).catch(() => null);
      if (!entry) {
        logger.info(
          `session-delete: revive guard skipped for ${sessionId}: entry ${entryId} was restored or purged`,
        );
        return { revived: false, entryId: null, skipped: true };
      }
      // 跨进程 restore 的窗口：条目还在、data 已经搬回原处。也不许再移。
      if (!(await isDirectory(entryDataDir(dataRoot, entryId)))) {
        logger.info(
          `session-delete: revive guard skipped for ${sessionId}: entry ${entryId} no longer holds data`,
        );
        return { revived: false, entryId: null, skipped: true };
      }
    }
    if (!(await isDirectory(originalPath))) return { revived: false, entryId: null };
    const bytes = await directorySize(originalPath).catch(() => 0);
    let moved;
    try {
      moved = await moveIntoTrash({
        dataRoot,
        sessionId,
        sourceDir: originalPath,
        meta: {
          title: meta?.title ?? null,
          cwd: meta?.cwd ?? null,
          bytes,
          live: false,
          children: [],
          workspaceIds: [],
          pinned: null,
        },
      });
    } catch (error) {
      await note({
        action: "trash",
        result: "failed",
        sessionId,
        operator: "system",
        detail: `复活守卫：再次移入回收站失败（${messageOf(error)}）`,
      });
      logger.warn(
        `session-delete: revive guard could not re-trash ${sessionId}: ${messageOf(error)}`,
      );
      return { revived: false, entryId: null, error: messageOf(error) };
    }
    // 迟到的写入可能把工作区/置顶登记也带回来：引用再摘一遍（幂等）。
    const removed = await removeAllRefs(refs, sessionId, {});
    await writeReceipt(dataRoot, {
      action: "trash",
      at: new Date().toISOString(),
      sessionId,
      entryId: moved.entryId,
      title: meta?.title ?? null,
      sizeBytes: bytes,
      guard: "revive",
      removed,
    });
    await note({
      action: "trash",
      result: "ok",
      sessionId,
      entryId: moved.entryId,
      operator: "system",
      detail: "复活守卫：会话目录在移走后被迟到的写入重建，已再次移入回收站",
    });
    return { revived: true, entryId: moved.entryId, removed };
  }

  return { recoverPending, reviveGuard };
}
