// @ts-check
// next-step 单测共用的**受控假时钟**（不引入依赖，只替换本进程的全局定时器）。
//
// 为什么需要（2026-11-28）：client 半用 `setTimeout` + `Date.now()` 表达「已保存」复位窗口、
// 补生成 grace、`generateState` 轮询与客户端超时。真实定时器在**并行压测**下会被调度抖动吃掉
// （16 路并发跑全包测试时，一次 `node --test` 本身还会按 CPU 数并发起子进程）：
// - `settings-save-status.test.js`：`sleep(4)` 实际可能睡几百毫秒，越过 client 内 300ms 的
//   「已保存」复位窗口，断言时状态已回落成 `clean`（实测 16 路 ×6 轮 96 次里红 4 次）；
// - `client-retry-feedback.test.js`：40ms 客户端超时窗口里两次 10ms 轮询跑不完就判成
//   `error.timeout`（期望 `error.schema`），`sleep(4)` 也会把「loading」断言拖成「error」。
//
// 假时钟把这些时序变成**确定**的：接管 `setTimeout` / `clearTimeout` / `Date.now`，测试用
// `advance()` 推进假时间、用 `waitFor()` 等目标相位，不再有「睡多久才够」的经验值。
// 两个测试文件必须共用这一份实现，不要各自再抄一份、更不要退回真实 `sleep(ms)`。
//
// 注意：`node --test` 会把 `test/` 下的文件都当成测试文件收进来，所以本 helper 会以「空测试文件」
// 的身份计一次 pass（与 `packages/advisor/test/temp.js` 同一情况，属预期）。

/**
 * 受控假时钟：接管本进程的 `setTimeout` / `clearTimeout` / `Date.now`，由测试手动推进。
 *
 * 只替换全局函数，`restore()` 原样还回去（每个用例的 finally 里调用）。
 * @returns {{ advance: (ms: number, flush: () => void) => Promise<void>, restore: () => void }}
 */
export function installClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;
  let now = 1_000_000;
  let nextId = 1;
  let sequence = 0;
  /** @type {Map<number, { id: number, at: number, sequence: number, run: Function, args: any[] }>} */
  const timers = new Map();

  /**
   * @param {Function} fn
   * @param {number} [ms]
   * @param {...any} args
   * @returns {number}
   */
  function fakeSetTimeout(fn, ms = 0, ...args) {
    const id = nextId++;
    timers.set(id, {
      id,
      at: now + Math.max(0, Number(ms) || 0),
      sequence: sequence++,
      run: fn,
      args,
    });
    return id;
  }

  /** @param {any} id */
  function fakeClearTimeout(id) {
    timers.delete(Number(id));
  }

  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: fakeSetTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: fakeClearTimeout,
  });
  Object.defineProperty(Date, "now", {
    configurable: true,
    writable: true,
    value: () => now,
  });

  /** 跑完微任务队列：一次 await 就会清空当前队列，多来几轮兜住链式 then。 */
  async function drain() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  /** drain 微任务 + 重渲染（重渲染才会跑 effect、注册下一次定时器）。 @param {() => void} flush */
  async function settle(flush) {
    await drain();
    flush();
    await drain();
  }

  /**
   * 触发所有到期时间 ≤ target 的定时器（按 at、注册顺序），每次触发后 drain + flush，
   * 让「轮询 → promise → setState → 重渲染 → 下一次 setTimeout」的链条一步步接上。
   * @param {number} target @param {() => void} flush
   */
  async function fireDue(target, flush) {
    for (;;) {
      await settle(flush);
      /** @type {any} */
      let next = null;
      for (const timer of timers.values()) {
        if (timer.at > target) continue;
        if (
          next === null ||
          timer.at < next.at ||
          (timer.at === next.at && timer.sequence < next.sequence)
        ) {
          next = timer;
        }
      }
      if (next === null) return;
      now = Math.max(now, next.at);
      timers.delete(next.id);
      next.run(...next.args);
    }
  }

  return {
    /**
     * 把假时间往前推 ms 毫秒，并跑完期间到期的所有定时器。
     * @param {number} ms @param {() => void} flush
     */
    async advance(ms, flush) {
      const target = now + ms;
      await fireDue(target, flush);
      now = target;
      // flush 里可能又排了 0ms 定时器：再收一遍（client 里没有 0ms，防御性处理）。
      await fireDue(target, flush);
    },
    restore() {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        writable: true,
        value: realSetTimeout,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        writable: true,
        value: realClearTimeout,
      });
      Object.defineProperty(Date, "now", {
        configurable: true,
        writable: true,
        value: realDateNow,
      });
      timers.clear();
    },
  };
}

/**
 * 确定性地等到条件成立：每次推进 step 假毫秒（默认 1ms）并 flush，直到 predicate 为真。
 * 超过 maxMs 假毫秒仍不成立时返回 false，交给调用方的断言报错（不会无限等）。
 * @param {ReturnType<typeof installClock>} clock
 * @param {{ flush: () => void }} hooks
 * @param {() => boolean} predicate
 * @param {{ step?: number, maxMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitFor(clock, hooks, predicate, options = {}) {
  const step = options.step ?? 1;
  const maxMs = options.maxMs ?? 200;
  for (let elapsed = 0; ; elapsed += step) {
    if (predicate()) return true;
    if (elapsed >= maxMs) return false;
    await clock.advance(step, hooks.flush);
  }
}
