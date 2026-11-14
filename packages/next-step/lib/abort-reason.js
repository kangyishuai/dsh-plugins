// @ts-check
// 「卡片生成被中止」的原因细分：**超时**（插件自己的 timeout 定时器）与**取消**
// （用户取消 / 同一会话又起了新的生成）是两件事。
//
// 为什么单独一个纯函数模块：中止既不写会话日志、也不计数时，诊断面板里完全看不到
// 痕迹——2026-11-14 排查那次「卡片没出来」就卡在这里。把判据抽出来才能单测，
// 让 `writeCardFor` 与诊断行共用同一套结论。

/** 超时定时器塞进 `AbortController.abort()` 的 Error message。 */
export const TIMEOUT_MESSAGE = "next-step timeout";

/**
 * 从 `AbortController.signal.reason` 判出中止原因。
 * @param {unknown} reason
 * @returns {"timeout" | "cancelled"}
 */
export function abortReasonOf(reason) {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : typeof (/** @type {any} */ (reason)?.message) === "string"
          ? String(/** @type {any} */ (reason).message)
          : "";
  return /timeout|timed\s*out/iu.test(message) ? "timeout" : "cancelled";
}

/**
 * 诊断行里「最近一次没出卡」的 kind。用户能看懂，也便于冒烟断言。
 * @param {"timeout" | "cancelled"} kind
 */
export function abortSkipKind(kind) {
  return kind === "timeout" ? "timeout" : "cancelled";
}

/**
 * 给诊断用的英文原因 token（与其它 lastSkip.reason 风格一致：机器可读、不翻译）。
 * @param {"timeout" | "cancelled"} kind
 * @param {number} [timeoutMs]
 */
export function abortReasonText(kind, timeoutMs) {
  if (kind !== "timeout") return "cancelled";
  const seconds =
    Number.isFinite(timeoutMs) && Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs) / 1000) : 0;
  return seconds > 0 ? `generation timeout after ${seconds}s` : "generation timeout";
}
