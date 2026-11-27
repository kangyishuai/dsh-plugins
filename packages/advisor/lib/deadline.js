// @ts-check
// 硬超时：`timeoutMs` 必须由**插件侧**主动中止请求，而不是依赖宿主流稍后自己收尾。
//
// 为什么单独一个模块（审计 AUD-ADV-03）：
//   - 原来的实现把 `AbortSignal.timeout()` 传给宿主，但只在流**自己**收尾成 aborted 时才判超时。
//     真实数据里有 6 次调用超过配置的 90s 仍以 `reviewed` 计费（94.6–155.1s），说明「信号发了、
//     流没停」时旧逻辑毫无作用。这里把「到点」变成一个可等待的事件：到点就中止请求并提前返回，
//     插件侧不再把这次调用记为成功（账本记 costUsd 0），残余风险写进 README。
//   - `call.js` 会 import `@deepseek-ai/dsh-llm`（测试环境没有宿主包），所以时间语义放在这里，
//     用真实计时器单测；call.js 只做接线。

/**
 * @typedef {object} Deadline
 * @property {AbortSignal} signal 传给宿主请求/流的合并信号（超时与外部取消都会触发）
 * @property {() => boolean} timedOut 是否是「配置的超时」触发
 * @property {() => boolean} cancelled 是否是「外部取消」触发（用户 / 回合取消）
 * @property {() => void} dispose 清理定时器与监听（幂等）
 */

/**
 * 建一个硬超时。外部 signal 会被转发进内部 controller，宿主只需要看一个信号。
 * @param {{ timeoutMs: number, external?: AbortSignal }} input
 * @returns {Deadline}
 */
export function createDeadline(input) {
  const timeoutMs = Number(input?.timeoutMs);
  const external = input?.external;
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0,
  );
  // 不让一个「只等超时」的定时器把进程/测试拖住。
  timer.unref?.();

  /** @type {() => void} */
  const onExternalAbort = () => {
    controller.abort();
  };
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => external?.aborted === true && !timedOut,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * 干活与超时赛跑：超时/取消先到就提前返回，不等一个可能永远不结束的流。
 * @template T
 * @param {Promise<T>} work
 * @param {Deadline} deadline
 * @returns {Promise<{ kind: "settled", value: T } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error", error: unknown }>}
 */
export function raceWithDeadline(work, deadline) {
  return new Promise((resolve) => {
    let settled = false;
    /** @param {{ kind: "settled", value: T } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error", error: unknown }} outcome */
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener("abort", onAbort);
      // 一次 race 只对应一次调用：结算后到点也不再有意义，顺手清掉定时器。
      deadline.dispose();
      resolve(outcome);
    };
    const onAbort = () => finish(deadline.timedOut() ? { kind: "timeout" } : { kind: "aborted" });
    if (deadline.signal.aborted) {
      onAbort();
      return;
    }
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    // 两个分支都挂上处理函数：超时胜出后迟到的 rejection 也不会变成 unhandled rejection。
    Promise.resolve(work).then(
      (value) => finish({ kind: "settled", value }),
      (error) => finish({ kind: "error", error }),
    );
  });
}
