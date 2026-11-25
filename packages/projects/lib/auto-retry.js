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
