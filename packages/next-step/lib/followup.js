// @ts-check
// 「这张卡后来被跟进过吗」的状态机：纯逻辑 + 可注入时钟，`node --test` 直接覆盖。
//
// 背景（AUD-NS-04）：`service.js` 里的 `closeFollowup()` 定义了却**没有任何调用点**，于是
// 只有「用户发了下一条」会写 followup（`typed:true`）；「用户看完就走了」永远不落盘——
// 而真实数据里后者占 82%（401 张 shown 卡里 329 张没有任何决策）。忽略率只能靠
// clicked/dismissed 反推，分不清「没看见」「不想点」「看完就走了」。
//
// 现在三条收尾路径共用同一个**幂等**入口 `close()`（删掉即返回，绝不会重复写一条事件）：
// 1. 下一轮正常结束（`turn/end`）时，把更早回合遗留的 pending 结算成 `typed:false`；
// 2. TTL 到期（默认 15 分钟）结算成 `typed:false`；
// 3. 追踪表超过会话级上限（默认 32 个会话）时，挤出最旧的一条并结算成 `typed:false`。
//
// 为什么不在 `turn/start` 收尾：宿主的事件顺序是 `turn/start` → `user/message`
// （冒烟实测，`service.js` 也有注释），在 turn/start 就 flush 会让每次真实续写都变成
// `typed:false`。真实续写必须留给紧随其后的 `user/message` 用 `consume()` 记成 `typed:true`。
//
// 已知限制：会话切走在宿主里没有可听的事件，只能靠 TTL 兜底（README 的「已知限制」里写明）。

import { concreteTokens } from "./prompt.js";

/** 待追踪条目在内存里最多留多久（到期按「没再说话」结算）。 */
export const FOLLOWUP_TTL_MS = 15 * 60 * 1000;
/** 同时追踪的会话上限：超出时先结算最旧的一条，避免长跑进程里无限增长。 */
export const MAX_PENDING_FOLLOWUPS = 32;

/**
 * @typedef {{ turn: number, labels: string[], at: number }} PendingFollowup
 * @typedef {{
 *   sessionId: string, turn: number, typed: boolean,
 *   delayMs: number, textChars: number, overlap: number, at: number,
 * }} FollowupSettlement
 * @typedef {{
 *   size: number,
 *   get: (sessionId: string) => PendingFollowup | undefined,
 *   has: (sessionId: string) => boolean,
 *   remember: (sessionId: string, input: { turn: number, labels: unknown[], at?: number }) =>
 *     { ok: boolean, evicted: FollowupSettlement[] },
 *   consume: (sessionId: string, input: { text?: unknown, at?: number }) =>
 *     FollowupSettlement | undefined,
 *   close: (sessionId: string, input?: { typed?: boolean, at?: number }) =>
 *     FollowupSettlement | undefined,
 *   expire: (at?: number) => FollowupSettlement[],
 * }} FollowupTracker
 */

/**
 * 两条文案共享了几个具体对象（文件/命令/版本号/中文片段）。
 * @param {string[]} labels
 * @param {Set<string>} tokens
 * @returns {number}
 */
function overlapOf(labels, tokens) {
  let overlap = 0;
  for (const label of labels) {
    let shared = 0;
    for (const token of concreteTokens(label)) if (tokens.has(token)) shared += 1;
    if (shared > overlap) overlap = shared;
  }
  return overlap;
}

/**
 * 建一个追踪表。
 * @param {{ ttlMs?: number, maxSessions?: number, now?: () => number }} [options]
 * @returns {FollowupTracker}
 */
export function createFollowupTracker(options = {}) {
  const ttlMs =
    Number.isFinite(options.ttlMs) && /** @type {number} */ (options.ttlMs) > 0
      ? /** @type {number} */ (options.ttlMs)
      : FOLLOWUP_TTL_MS;
  const maxSessions =
    Number.isFinite(options.maxSessions) && /** @type {number} */ (options.maxSessions) >= 1
      ? Math.floor(/** @type {number} */ (options.maxSessions))
      : MAX_PENDING_FOLLOWUPS;
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  /** @type {Map<string, PendingFollowup>} */
  const pendings = new Map();

  /**
   * 取出并删除一条 pending，转成可写事件的数据（调用方再补 `sid` 与 event 外壳）。
   * 幂等：没有 pending 时返回 undefined，绝不会重复写一条事件。
   * @param {string} sessionId
   * @param {{ typed?: boolean, text?: string, at?: number }} [input]
   * @returns {FollowupSettlement | undefined}
   */
  function take(sessionId, input = {}) {
    const pending = pendings.get(sessionId);
    if (pending === undefined) return undefined;
    pendings.delete(sessionId);
    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : clock();
    return settle(sessionId, pending, {
      typed: input.typed === true,
      text: typeof input.text === "string" ? input.text : "",
      at,
    });
  }

  /**
   * 把一个 pending 变成可写事件的数据（调用方再补 `sid` 与 event 外壳）。
   * @param {string} sessionId
   * @param {PendingFollowup} pending
   * @param {{ typed: boolean, text?: string, at: number }} input
   * @returns {FollowupSettlement}
   */
  function settle(sessionId, pending, input) {
    const text = typeof input.text === "string" ? input.text : "";
    const trimmed = text.trim();
    const typed = input.typed === true && trimmed !== "";
    return {
      sessionId,
      turn: pending.turn,
      typed,
      delayMs: Math.max(0, input.at - pending.at),
      textChars: typed ? trimmed.length : 0,
      overlap: typed ? overlapOf(pending.labels, concreteTokens(text)) : 0,
      at: input.at,
    };
  }

  return {
    get size() {
      return pendings.size;
    },
    get(sessionId) {
      return pendings.get(sessionId);
    },
    has(sessionId) {
      return pendings.has(sessionId);
    },
    /**
     * 登记「这张卡在场上」。没有可用 label 的卡不登记（没有可比的文案）。
     * @param {string} sessionId
     * @param {{ turn: number, labels: unknown[], at?: number }} input
     * @returns {{ ok: boolean, evicted: FollowupSettlement[] }}
     */
    remember(sessionId, input) {
      /** @type {string[]} */
      const labels = [];
      for (const label of Array.isArray(input.labels) ? input.labels : []) {
        if (typeof label === "string" && label !== "") labels.push(label);
      }
      if (typeof sessionId !== "string" || sessionId === "" || labels.length === 0) {
        return { ok: false, evicted: [] };
      }
      /** @type {FollowupSettlement[]} */
      const evicted = [];
      // 会话级上限：先挤出最旧的一条（结算成「没再说话」），再登记新的。
      while (!pendings.has(sessionId) && pendings.size >= maxSessions) {
        const oldest = /** @type {string | undefined} */ (pendings.keys().next().value);
        if (oldest === undefined) break;
        const closed = take(oldest, { typed: false });
        if (closed === undefined) break;
        evicted.push(closed);
      }
      const at =
        typeof input.at === "number" && Number.isFinite(input.at) && input.at > 0
          ? input.at
          : clock();
      pendings.set(sessionId, { turn: input.turn, labels, at });
      return { ok: true, evicted };
    },
    /**
     * 用户发了一条消息（含点击胶囊发出的那条）：结算成 `typed:true`。
     * @param {string} sessionId
     * @param {{ text?: unknown, at?: number }} [input]
     * @returns {FollowupSettlement | undefined}
     */
    consume(sessionId, input = {}) {
      return take(sessionId, {
        typed: true,
        text: typeof input?.text === "string" ? input.text : "",
        at: input?.at,
      });
    },
    /**
     * 幂等收尾：没有 pending 时返回 undefined（绝不重复写事件）。
     * @param {string} sessionId
     * @param {{ typed?: boolean, at?: number }} [input]
     * @returns {FollowupSettlement | undefined}
     */
    close(sessionId, input = {}) {
      return take(sessionId, { typed: input?.typed === true, at: input?.at });
    },
    /**
     * TTL 扫描：把到期还没等到用户消息的条目结算成 `typed:false`。
     * @param {number} [at]
     * @returns {FollowupSettlement[]}
     */
    expire(at) {
      const now = typeof at === "number" ? at : clock();
      /** @type {FollowupSettlement[]} */
      const settled = [];
      for (const sessionId of [...pendings.keys()]) {
        const pending = pendings.get(sessionId);
        if (pending === undefined) continue;
        if (now - pending.at < ttlMs) continue;
        const closed = take(sessionId, { typed: false, at: now });
        if (closed !== undefined) settled.push(closed);
      }
      return settled;
    },
  };
}
