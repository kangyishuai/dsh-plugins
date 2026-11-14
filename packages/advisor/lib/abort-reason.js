// @ts-check
// 「顾问调用被中止」的细分：**超时**与**用户/回合取消**是两件事。
//
// 为什么单独一个模块：`call.js` 会 import `@deepseek-ai/dsh-llm`（`BlockAssembler`），
// 而测试环境里没有宿主包，单独 import 它就跑不起来。把判据抽成不依赖宿主的纯函数，
// 才能在 `node --test` 里覆盖——这条分类直接影响用户看到的错误码（README 里
// `timeout` 与 `aborted` 是两个不同的失败码，别再把超时混进 `aborted`）。

/** 超时文案里用的时长：整分钟写「N 分钟」，其余写「N 秒」。 @param {number} ms */
export function formatTimeout(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "未知时长";
  // 不足 1 秒按 1 秒算：否则 120ms 的超时会说出「0 秒」这种废话。
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/**
 * @param {{ cancelled?: boolean, timedOut?: boolean, timeoutMs?: number }} [input]
 * @returns {{ code: "aborted" | "timeout", message: string }}
 */
export function classifyAbort(input = {}) {
  const { cancelled = false, timedOut = false, timeoutMs = 0 } = input;
  // 用户主动取消优先：`/advisor cancel` 触发的 abort 不该被说成「超时」。
  if (cancelled) return { code: "aborted", message: "顾问调用被中止" };
  if (timedOut) return { code: "timeout", message: `顾问调用超时（${formatTimeout(timeoutMs)}）` };
  // 既没超时也没被取消：保留原来的兜底说法（例如宿主自己中止了流）。
  return { code: "aborted", message: "顾问调用被中止" };
}
