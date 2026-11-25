// @ts-check
/**
 * 「失败自动重试」的判定（纯函数）。语义**不是** Claude 的"用量恢复续跑"：
 * 只在**线程以失败结束**时，按项目开关自动再发一句「继续」，最多 2 次。
 * @param {{ enabled?: boolean, state?: string, previousState?: string, attempts?: number, maxAttempts?: number }} input
 * @returns {{ retry: boolean, reason: string }}
 */
export function shouldAutoRetry(input) {
  const max = Number.isFinite(input?.maxAttempts) ? Number(input?.maxAttempts) : 2;
  if (input?.enabled !== true) return { retry: false, reason: "disabled" };
  if (String(input?.state ?? "") !== "failed") {
    return { retry: false, reason: input?.previousState === "failed" ? "recovered" : "not-failed" };
  }
  if (String(input?.previousState ?? "") === "failed")
    return { retry: false, reason: "already-failed" };
  const attempts = Number.isFinite(input?.attempts) ? Number(input?.attempts) : 0;
  if (attempts >= max) return { retry: false, reason: "limit" };
  return { retry: true, reason: "first-failure" };
}

/**
 * 可测试的自动重试调度器：单例（同一线程只挂一个定时器）、到点**重查**状态、
 * 达到上限不再触发、可整体取消（dispose 用）。
 * 定时器与读取状态都注入，单测可以用假定时器驱动。
 * @param {{ delayMs?: number, maxAttempts?: number, setTimeoutImpl?: any, clearTimeoutImpl?: any, readState: (id: string) => any, onRetry: (id: string, nextAttempts: number) => void }} input
 */
export function createAutoRetryScheduler(input) {
  const delayMs = Number(input?.delayMs) > 0 ? Number(input.delayMs) : 60_000;
  const maxAttempts = Number.isFinite(input?.maxAttempts) ? Number(input.maxAttempts) : 2;
  const setTimer = input?.setTimeoutImpl ?? setTimeout;
  const clearTimer = input?.clearTimeoutImpl ?? clearTimeout;
  const readState = input?.readState;
  const onRetry = input?.onRetry;
  /** @type {Map<string, any>} */
  const timers = new Map();
  return {
    /** @param {string} id */
    has(id) {
      return timers.has(id);
    },
    /** @param {string} id @returns {boolean} 是否新挂了一个定时器 */
    schedule(id) {
      if (timers.has(id)) return false;
      const timer = setTimer(() => {
        timers.delete(id);
        const snapshot = (typeof readState === "function" ? readState(id) : null) || {};
        const decision = shouldAutoRetry({
          enabled: snapshot.enabled === true,
          state: snapshot.state,
          // 以「刚变成失败」的方式再判一次：调度后可能已恢复成功
          previousState: "working",
          attempts: snapshot.attempts,
          maxAttempts,
        });
        if (!decision.retry) return;
        if (typeof onRetry === "function") onRetry(id, Number(snapshot.attempts || 0) + 1);
      }, delayMs);
      timers.set(id, timer);
      return true;
    },
    /** @param {string} id */
    cancel(id) {
      const timer = timers.get(id);
      if (timer === undefined) return false;
      clearTimer(timer);
      timers.delete(id);
      return true;
    },
    cancelAll() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
    size() {
      return timers.size;
    },
  };
}
