// @ts-check
// 每会话「在途生成」的登记簿：纯逻辑，不 import 宿主包，`node --test` 直接覆盖。
//
// 为什么单独一个模块（AUD-NS-01 + AUD-NS-06）：
// 生成延迟 p50 5.6s / p90 12.1s，而用户在 5–12s 内发下一条消息时，`turn/start` 原来会**立刻**
// abort 在途生成（`service.js` 的 `abortInflight`）。14 天 1086 次生成尝试里 450 次失败，
// 其中 322 次是这种「被下一轮取消」——已经花掉的 token 全丢，而且诊断里看不到。
//
// 现在的语义分三种，互相不能混：
// - **supersede**：新的一轮开始了。只打标记，**不 abort**——生成照常跑完，结算时写成
//   `shown:false` 的候选（不进对话流；**这不是省 token**：跑完会比中止多付输出 token，
//   换来的是接近完成的调用不被丢弃 + `superseded` 可观测；这类候选不可揭示——补生成只对
//   最近一个正常结束的回合生效）。
// - **cancel**：同一会话又要起一次新生成，或者用户已经点了胶囊。这时候旧的这次已经没有价值，
//   abort 掉。
// - **finish**：结算完毕，注销自己那一笔（只注销自己的 controller，避免误删后起的生成）。
//
// 这套状态机原本困在 `service.js`（不能 import 宿主包就没法单测），竞态只能靠真机碰运气；
// 抽出来之后「标记不 abort」「只注销自己」这些不变量都有单测钉住。

/**
 * @typedef {{ controller: AbortController, turn: number, superseded: boolean }} InflightEntry
 * @typedef {{
 *   size: number,
 *   has: (sessionId: string) => boolean,
 *   get: (sessionId: string) => InflightEntry | undefined,
 *   begin: (sessionId: string, turn: number, controller: AbortController) => InflightEntry | undefined,
 *   supersede: (sessionId: string) => InflightEntry | undefined,
 *   isCurrent: (sessionId: string, controller: AbortController) => boolean,
 *   isSuperseded: (sessionId: string, controller: AbortController) => boolean,
 *   finish: (sessionId: string, controller: AbortController) => boolean,
 *   cancel: (sessionId: string, reason?: unknown) => InflightEntry | undefined,
 * }} InflightRegistry
 */

/**
 * 手动补生成（`generateNow`）遇到在途生成时的判断（F-2）。
 *
 * 0.4.3 之前 `turn/start` 会 abort 在途生成，所以点「补生成」时 `inflight` 必为空；现在被取代的
 * 旧回合会继续跑到 20s，按钮出现后用户点它会撞上 `inflight` 守卫，变成「正在生成，请稍候」却
 * 什么都不发生。处置规则：**只有「本次要的回合、且没被取代」才值得等**；其余一律取消后继续——
 * 别的回合不是用户要的那张卡；已被取代的那笔注定写成 `shown:false`，留着只会挡住补生成。
 * @param {{ turn: number, superseded: boolean } | undefined} entry 在途登记项
 * @param {number} turn 本次补生成要的回合
 * @returns {boolean} true = 继续报 `inflight`（等它跑完）
 */
export function inflightBlocksGenerateNow(entry, turn) {
  if (entry === undefined || entry === null) return false;
  return entry.turn === turn && entry.superseded !== true;
}

/**
 * 建一个空登记簿。
 * @returns {InflightRegistry}
 */
export function createInflightRegistry() {
  /** @type {Map<string, InflightEntry>} */
  const entries = new Map();

  return {
    get size() {
      return entries.size;
    },
    has(sessionId) {
      return entries.has(sessionId);
    },
    get(sessionId) {
      return entries.get(sessionId);
    },
    /**
     * 登记本次生成。返回被顶掉的上一笔（调用方负责 abort，本函数不替它做决定）。
     * @param {string} sessionId
     * @param {number} turn
     * @param {AbortController} controller
     * @returns {InflightEntry | undefined}
     */
    begin(sessionId, turn, controller) {
      const previous = entries.get(sessionId);
      entries.set(sessionId, { controller, turn, superseded: false });
      return previous;
    },
    /**
     * 新一轮开始了：只标记，不 abort。生成会跑完并以 `shown:false` 结算。
     * @param {string} sessionId
     * @returns {InflightEntry | undefined}
     */
    supersede(sessionId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return undefined;
      entry.superseded = true;
      return entry;
    },
    /**
     * 这笔 controller 还是本会话的当前生成吗（结算时判「有没有被后来者取代」）。
     * @param {string} sessionId
     * @param {AbortController} controller
     * @returns {boolean}
     */
    isCurrent(sessionId, controller) {
      return entries.get(sessionId)?.controller === controller;
    },
    /**
     * 这笔 controller 已被更新的回合取代、但仍允许跑完（→ 写 `shown:false` 候选）。
     * @param {string} sessionId
     * @param {AbortController} controller
     * @returns {boolean}
     */
    isSuperseded(sessionId, controller) {
      const entry = entries.get(sessionId);
      return entry !== undefined && entry.controller === controller && entry.superseded === true;
    },
    /**
     * 结算后注销。只注销自己那一笔：晚到的旧生成不能把新生成从表里删掉。
     * @param {string} sessionId
     * @param {AbortController} controller
     * @returns {boolean} 真的删掉了才返回 true
     */
    finish(sessionId, controller) {
      if (entries.get(sessionId)?.controller !== controller) return false;
      entries.delete(sessionId);
      return true;
    },
    /**
     * 取消并注销（用户已做选择 / 同一会话要起新生成）。
     * @param {string} sessionId
     * @param {unknown} [reason] 传给 `AbortController.abort()` 的原因
     * @returns {InflightEntry | undefined}
     */
    cancel(sessionId, reason) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return undefined;
      entries.delete(sessionId);
      try {
        entry.controller.abort(reason ?? new Error("superseded"));
      } catch (_error) {
        /* 已经 abort 过：忽略即可 */
      }
      return entry;
    },
  };
}
