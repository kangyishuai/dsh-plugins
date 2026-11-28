// @ts-check
// 生成预算与空输出恢复策略（host-free，纯函数；service.js 只做接线）。
//
// 2026-11-28 真机实测：默认 500 maxTokens 在推理模型（zhinao/deepseek-v4.1-flash，reasoning Max）
// 上会被推理块吃光——finish=max-tokens、outputTokens=500、textLen=0，解析器只能报
// `json:empty`；重试原样再发一次仍是空。把预算升到 3000 后同一请求 finish=stop、
// outputTokens=735，卡片正常生成。这里的策略就是「空输出 → 一次预算升级重试」。

/** 升级后的预算上限（与设置项上限一致：settings.maxTokens 最大 4000）。 */
export const ESCALATED_TOKENS_CAP = 4000;
/** 升级后的预算下限：低于这个值，推理模型很容易又把预算用在推理上。 */
export const ESCALATED_TOKENS_FLOOR = 3000;

/**
 * 空输出重试时使用的 token 预算：在基础预算上放大 4 倍，落在 [3000, 4000]。
 * @param {unknown} baseMaxTokens 当前设置里的 maxTokens
 * @returns {number}
 */
export function escalatedTokenBudget(baseMaxTokens) {
  const base = Number(baseMaxTokens);
  if (!Number.isFinite(base) || base <= 0) return ESCALATED_TOKENS_FLOOR;
  return Math.min(ESCALATED_TOKENS_CAP, Math.max(Math.round(base) * 4, ESCALATED_TOKENS_FLOOR));
}

/**
 * 解析失败后的恢复策略：
 * - 空输出 → 原请求 + 升级预算重试一次（`escalate`）；
 * - 非空但格式不对 → 带 transcript 的修格式请求（`repair`），预算不变。
 * @param {{ raw?: unknown, baseMaxTokens?: unknown, problem?: unknown }} input
 * @returns {{ plan: "escalate" | "repair", budget: number, escalated: boolean }}
 */
export function recoveryFor(input = {}) {
  const raw = typeof input.raw === "string" ? input.raw.trim() : "";
  const base = Number(input.baseMaxTokens);
  const budget = Number.isFinite(base) && base > 0 ? Math.round(base) : 500;
  if (raw === "")
    return { plan: "escalate", budget: escalatedTokenBudget(budget), escalated: true };
  return { plan: "repair", budget, escalated: false };
}

/**
 * 失败详情之外给日志用的诊断摘要（不进用户可见 detail，避免破坏 report 的分桶）。
 * @param {{ finish?: unknown, usage?: any, budget?: unknown }} input
 * @returns {string}
 */
export function emptyOutputSummary(input = {}) {
  const finish = typeof input.finish === "string" ? input.finish : "unknown";
  const outputTokens = Number(input.usage?.outputTokens);
  const budget = Number(input.budget);
  return [
    `finish=${finish}`,
    Number.isFinite(outputTokens) ? `outputTokens=${outputTokens}` : "outputTokens=?",
    Number.isFinite(budget) ? `maxTokens=${budget}` : "maxTokens=?",
  ].join(" ");
}
