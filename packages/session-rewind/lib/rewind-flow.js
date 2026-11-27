// @ts-check
// 一次回溯的编排状态机（可注入、可单测，AUD-REW-10）。
//
// service.js 只负责宿主桥接（Remote/Typert、sessions/agents 服务、token 估算）；这里实现
// 「取消运行中回合 → 重新求值目标 → planRestore → createRescue/applyRestore → 部分失败兜底
// → 写审计」的顺序与失败语义。刻意不 import 任何 @deepseek-ai/*：session/agent/store 全部
// 由调用方注入，因此可以在 node --test 里用假对象覆盖全部分支。
import { settleAgent } from "./agent-settle.js";
import {
  appendRewindMarker,
  ERROR_CODES,
  RewindRequestError,
  resolveRewindTarget,
  resolveSession,
} from "./operations.js";
import { countVisibleMessages, targetContent } from "./plan.js";

/**
 * @typedef {object} RewindFlowDeps
 * @property {any} store 文件引擎（planRestore/applyRestore/appendAudit/newAuditId）
 * @property {any} config 插件配置（cancelRunning / cancelTimeoutMs）
 * @property {() => boolean} trackingEnabled 文件追踪开关
 * @property {(session: any) => string | undefined} cwdOf 会话工作目录
 * @property {{warn?: (message: string) => void, info?: (message: string) => void}} [logger]
 * @property {Set<string>} inflight 每会话进行中标记（防并发回溯）
 * @property {() => any} serviceDeps 惰性取 operations.js 的 ServiceDeps（getAgent/getSession/…）
 * @property {(events: any[], seqs: number[]) => number} estimateTokens token 估算
 * @property {(agent: any, options: any) => Promise<any>} [settle] 取消运行中回合（默认 settleAgent）
 */

/**
 * @typedef {object} RewindInput
 * @property {string} [sessionId]
 * @property {number} [targetSeq]
 * @property {"chat" | "both"} mode
 * @property {string} requestedBy
 */

/**
 * 创建编排状态机。返回对象可被解构（全部通过闭包，不依赖 this）。
 * @param {RewindFlowDeps} deps
 */
export function createRewindFlow(deps) {
  const store = deps.store;
  const config = deps.config ?? {};
  const settle = typeof deps.settle === "function" ? deps.settle : settleAgent;

  /**
   * @param {string} message
   * @returns {void}
   */
  function warn(message) {
    try {
      deps.logger?.warn?.(message);
    } catch {
      // 日志失败不影响回溯
    }
  }

  /**
   * 执行一次回溯。
   * @param {RewindInput} input
   * @returns {Promise<any>}
   */
  async function execute(input) {
    const serviceDeps = deps.serviceDeps();
    // 先按「允许运行中」解析，拿到 agent；运行中的回合必须先停下，否则 surface 会在
    // 我们求值与 append 之间继续增长，marker 的 replace 范围就失效了。
    const pre = resolveSession(serviceDeps, input.sessionId, { allowRunning: true });
    const agent = pre.agent;
    /** @type {{cancelledTurn: boolean, droppedSteering: number}} */
    const settleResult = { cancelledTurn: false, droppedSteering: 0 };
    if (agent !== undefined && agent !== null && agent.status !== "idle") {
      if (config.cancelRunning === false) {
        throw new RewindRequestError(
          ERROR_CODES.busy,
          `session "${input.sessionId}" is not idle; stop the running turn before rewinding`,
        );
      }
      const outcome = await settle(agent, {
        ...(typeof config.cancelTimeoutMs === "number"
          ? { timeoutMs: config.cancelTimeoutMs }
          : {}),
      });
      settleResult.cancelledTurn = outcome.cancelled === true;
      settleResult.droppedSteering = Array.isArray(outcome.droppedSteering)
        ? outcome.droppedSteering.length
        : 0;
      if (outcome.idle !== true) {
        throw new RewindRequestError(
          ERROR_CODES.busy,
          `session "${input.sessionId}" did not become idle after cancelling the running turn`,
        );
      }
    }
    // 停稳之后重新求值：取消前的快照可能已经被这一轮追加的事件改变。
    const { session, sessionId, plan, targetEvent } = resolveRewindTarget(serviceDeps, input);
    if (deps.inflight.has(sessionId)) {
      throw new RewindRequestError(
        ERROR_CODES.failed,
        `a rewind is already in progress for session "${sessionId}"`,
      );
    }
    deps.inflight.add(sessionId);
    const auditId =
      typeof store.newAuditId === "function" ? store.newAuditId() : `rw-${Date.now()}`;
    const mode = input.mode === "both" ? "both" : "chat";
    /** @type {any} */
    let files = null;
    /** @type {any} */
    let markerEvent;
    try {
      if (mode === "both") {
        const cwd = deps.cwdOf(session);
        if (!deps.trackingEnabled() || cwd === undefined) {
          throw new RewindRequestError(
            ERROR_CODES.filesUnavailable,
            "file restore is unavailable for this session (tracking disabled or no working directory)",
          );
        }
        const filePlan = await store.planRestore({
          sessionId,
          targetSeq: plan.targetSeq,
          cwd,
        });
        if (
          Array.isArray(filePlan.warnings) &&
          filePlan.warnings.some((/** @type {any} */ item) => item.code === "files-unavailable")
        ) {
          throw new RewindRequestError(
            ERROR_CODES.filesUnavailable,
            "file restore is unavailable for this session",
          );
        }
        if (Array.isArray(filePlan.conflicts) && filePlan.conflicts.length > 0) {
          const error = new RewindRequestError(
            ERROR_CODES.filesConflict,
            `file restore would overwrite externally changed files: ${filePlan.conflicts
              .map((/** @type {any} */ item) => item.path)
              .join(", ")}`,
          );
          /** @type {any} */ (error).details = { conflicts: filePlan.conflicts };
          throw error;
        }
        if (!Array.isArray(filePlan.actions) || filePlan.actions.length === 0) {
          // 没有需要改动的文件：仍然要追加会话 marker（applyRestore 在 actions 为空时
          // 会提前返回，不会调用 beforeApply）。
          markerEvent = appendRewindMarker(session, plan, serviceDeps, { mode: "both", auditId });
          files = {
            restored: [],
            trashed: [],
            skipped: filePlan.skipped ?? [],
            failed: [],
            rescueId: null,
          };
        } else {
          let outcome;
          try {
            outcome = await store.applyRestore({
              sessionId,
              cwd,
              plan: filePlan,
              auditId,
              beforeApply: () => {
                markerEvent = appendRewindMarker(session, plan, serviceDeps, {
                  mode: "both",
                  auditId,
                });
              },
            });
          } catch (error) {
            if (markerEvent === undefined) throw error;
            // marker 已写入：会话已回溯，文件未能写入；返回部分结果而不是丢掉响应。
            outcome = {
              restored: [],
              trashed: [],
              skipped: filePlan.skipped ?? [],
              failed: [
                { path: "*", reason: error instanceof Error ? error.message : String(error) },
              ],
              rescueId: null,
            };
          }
          files = {
            restored: outcome.restored ?? [],
            trashed: outcome.trashed ?? [],
            skipped: outcome.skipped ?? [],
            failed: outcome.failed ?? [],
            rescueId: outcome.rescueId ?? null,
            ...(Array.isArray(outcome.removedDirs) && outcome.removedDirs.length > 0
              ? { removedDirs: outcome.removedDirs }
              : {}),
          };
        }
        // 文件失败不回滚会话；在响应里报告（客户端显示为部分成功）。
      } else {
        markerEvent = appendRewindMarker(session, plan, serviceDeps, { mode: "chat", auditId });
      }
      const events = session.snapshotEvents();
      const tokens = deps.estimateTokens(events, plan.shadowedSeqs);
      const removedMessageCount = countVisibleMessages(events, plan.shadowedSeqs);
      const response = {
        targetSeq: plan.targetSeq,
        markerSeq: markerEvent.seq,
        removedCount: plan.shadowedSeqs.length,
        removedMessageCount,
        tokens,
        auditId,
        target: targetContent(targetEvent),
        files,
        // v2.1：执行时是否为了回溯而停下了运行中的回合。
        cancelledTurn: settleResult.cancelledTurn,
        droppedSteering: settleResult.droppedSteering,
      };
      try {
        await store.appendAudit({
          id: auditId,
          sessionId,
          time: Date.now(),
          targetSeq: plan.targetSeq,
          markerSeq: markerEvent.seq,
          mode,
          removedCount: plan.shadowedSeqs.length,
          removedMessageCount,
          tokens,
          files,
          requestedBy: input.requestedBy,
          cancelledTurn: settleResult.cancelledTurn,
          droppedSteering: settleResult.droppedSteering,
        });
      } catch (error) {
        warn(
          `session-rewind: audit append failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return response;
    } finally {
      deps.inflight.delete(sessionId);
    }
  }

  return { execute };
}
