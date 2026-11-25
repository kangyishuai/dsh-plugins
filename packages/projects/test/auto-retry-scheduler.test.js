// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutoRetryScheduler } from "../lib/auto-retry.js";

function makeHarness() {
  /** @type {Array<() => void>} */
  const pending = [];
  /** @type {number[]} */
  const cleared = [];
  /** @type {Array<{ id: string, nextAttempts: number }>} */
  const retries = [];
  /** @type {Record<string, any>} */
  const state = {};
  const scheduler = createAutoRetryScheduler({
    delayMs: 1000,
    maxAttempts: 2,
    setTimeoutImpl: (/** @type {any} */ fn) => {
      pending.push(fn);
      return pending.length - 1;
    },
    clearTimeoutImpl: (/** @type {number} */ id) => cleared.push(id),
    readState: (id) => state[id],
    onRetry: (id, nextAttempts) => retries.push({ id, nextAttempts }),
  });
  return {
    scheduler,
    state,
    retries,
    cleared,
    fire(index = 0) {
      const fn = pending[index];
      pending.splice(index, 1);
      fn?.();
    },
    pendingCount: () => pending.length,
  };
}

describe("自动重试调度器（伪定时器）", () => {
  it("单例：同一线程重复 schedule 只挂一个定时器", () => {
    const h = makeHarness();
    assert.equal(h.scheduler.schedule("s1"), true);
    assert.equal(h.scheduler.schedule("s1"), false);
    assert.equal(h.pendingCount(), 1);
  });

  it("到点重查：仍失败且未超上限 → onRetry(count+1)；已恢复 → 不重试", () => {
    const h = makeHarness();
    h.state.s1 = { enabled: true, state: "failed", attempts: 0 };
    h.scheduler.schedule("s1");
    h.fire();
    assert.deepEqual(h.retries, [{ id: "s1", nextAttempts: 1 }]);

    h.state.s2 = { enabled: true, state: "idle", attempts: 0 };
    h.scheduler.schedule("s2");
    h.fire();
    assert.equal(h.retries.length, 1);
  });

  it("超过上限不触发；cancelAll 清空所有定时器", () => {
    const h = makeHarness();
    h.state.s3 = { enabled: true, state: "failed", attempts: 2 };
    h.scheduler.schedule("s3");
    h.fire();
    assert.equal(h.retries.length, 0);

    h.scheduler.schedule("a");
    h.scheduler.schedule("b");
    assert.equal(h.scheduler.size(), 2);
    h.scheduler.cancelAll();
    assert.equal(h.scheduler.size(), 0);
    assert.equal(h.cleared.length, 2);
  });
});
