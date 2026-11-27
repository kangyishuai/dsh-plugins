// @ts-check
// 「追问待处理队列」：浮层想发起追问，但只能借 composer 提交一条命令
// （client 没有 commands 服务，真实 Agent 只能从命令上下文取 —— 见 ADR 0016）。
//
// 直接写 `/btw --thread t_xxx <问题>` 会把内部参数暴露在用户输入框里（实测被抱怨）。
// 改成：client 先把 {threadId, question, scope} 交给 host 暂存，再提交**裸 `/btw`**；
// host 处理命令时先查队列，取到就当追问处理，取不到才走「重开上一条」的老语义。
//
// 纯逻辑、不 import 宿主包，便于单测。
import { LIMITS } from "./limits.js";

/**
 * @typedef {{ threadId: string, question: string, scope: string, at: number }} PendingFollowUp
 */

/**
 * 建一个按 sessionId 分槽的待处理队列。
 *
 * 单槽而非数组：同一个会话在任意时刻只会有一次「即将提交的追问」，
 * 覆盖旧值比排队更符合实际（用户连点两次时后一次生效）。
 * 槽位有上限（LIMITS.followUpSlots）：client 异常、用户没提交就关面板时槽会留下，
 * 不能让它按会话数只增不删（AUD-BTW-08）。
 * @param {{ ttlMs?: number, maxSlots?: number, now?: () => number }} [options]
 */
export function createFollowUpQueue(options = {}) {
  const ttlMs = Number(options.ttlMs) || 60_000;
  const maxSlots = Math.max(1, Math.trunc(Number(options.maxSlots) || LIMITS.followUpSlots));
  const now = options.now ?? Date.now;
  /** @type {Map<string, PendingFollowUp>} */
  const slots = new Map();
  return {
    /**
     * 登记一次待处理的追问。
     * @param {string} sessionId
     * @param {{ threadId: string, question: string, scope?: string }} input
     * @returns {void}
     */
    push(sessionId, input) {
      const threadId = String(input?.threadId ?? "");
      const question = String(input?.question ?? "");
      if (sessionId === "" || threadId === "" || question === "") return;
      // 先删再插：Map 插入序即最近使用序，热会话不会被当成最旧淘汰。
      slots.delete(sessionId);
      slots.set(sessionId, {
        threadId,
        question,
        scope: String(input?.scope ?? ""),
        at: now(),
      });
      while (slots.size > maxSlots) {
        const oldest = slots.keys().next().value;
        if (oldest === undefined) break;
        slots.delete(oldest);
      }
    },

    /**
     * 取出并清空（一次性）。过期的视为不存在。
     * @param {string} sessionId
     * @returns {PendingFollowUp | undefined}
     */
    take(sessionId) {
      const item = slots.get(sessionId);
      if (item === undefined) return undefined;
      slots.delete(sessionId);
      if (now() - item.at > ttlMs) return undefined;
      return item;
    },

    /** 诊断用。 */
    size() {
      return slots.size;
    },
  };
}
