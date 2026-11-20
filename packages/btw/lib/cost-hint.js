// @ts-check
// 旁问成本的**纯逻辑**：不 import 宿主包，便于 node --test 直接引用。
//
// 依据 2026-11-20 探针（notes/btw/fork-cost.md §5，临时 DSH_HOME 实测）：
// - host 的 `tokenMeter.contextPressure(session).pressureTokens` 是父会话最后一次请求的 prompt 大小；
// - fork 子代理的真实 prompt 与它的比值在 **0.75–1.2×**（空会话固定开销 ~114K 不包含在内）；
// - 所以这里只给「量级/区间」，不假装是精确账单。
import { formatTokens } from "./format.js";
import { LIMITS } from "./limits.js";
import { format } from "./messages.js";

/** fork prompt 相对父会话 contextPressure 的历史比值下界。 */
export const COST_RATIO_LOW = 0.75;
/** 上界。 */
export const COST_RATIO_HIGH = 1.2;

/**
 * @typedef {{
 *   level: "unknown" | "ok" | "warn",
 *   pressureTokens?: number,
 *   contextWindow?: number,
 *   threshold: number,
 *   estimatedLow?: number,
 *   estimatedHigh?: number,
 *   lastActualPromptTokens: number | null,
 * }} CostHint
 */

/**
 * 构造成本提示。pressureTokens 缺失（空会话没有请求 header）时返回 unknown——**不要**
 * 伪造 0，否则会把「没测到」说成「很便宜」。
 * @param {{ pressureTokens?: number, contextWindow?: number, lastActualPromptTokens?: number | null, threshold?: number }} [input]
 * @returns {CostHint}
 */
export function buildCostHint(input = {}) {
  const threshold = Math.max(1, Math.trunc(Number(input.threshold) || LIMITS.pressureWarnTokens));
  const pressure = Number(input.pressureTokens);
  const last = Number(input.lastActualPromptTokens);
  /** @type {CostHint} */
  const hint = {
    level: "unknown",
    threshold,
    lastActualPromptTokens: Number.isFinite(last) && last > 0 ? Math.round(last) : null,
  };
  if (Number.isFinite(pressure) && pressure > 0) {
    hint.pressureTokens = Math.round(pressure);
    hint.level = hint.pressureTokens >= threshold ? "warn" : "ok";
    hint.estimatedLow = Math.round(hint.pressureTokens * COST_RATIO_LOW);
    hint.estimatedHigh = Math.round(hint.pressureTokens * COST_RATIO_HIGH);
  }
  const window = Number(input.contextWindow);
  if (Number.isFinite(window) && window > 0) hint.contextWindow = Math.round(window);
  return hint;
}

/**
 * 一条 btw 记录的真实 prompt 总量（新增 input + 命中缓存）。缓存命中也要算进 prompt——
 * 缓存过期后它们就是实打实的新 tokens。
 * @param {any} cost
 * @returns {number | null}
 */
export function promptTokensOfCost(cost) {
  if (cost === null || typeof cost !== "object") return null;
  const fresh = Number(cost.inputTokens);
  const cached = Number(cost.cacheReadTokens);
  if (!Number.isFinite(fresh) || fresh < 0) return null;
  const withCache = fresh + (Number.isFinite(cached) && cached > 0 ? cached : 0);
  return withCache > 0 ? Math.round(withCache) : null;
}

/**
 * 最近一次有成本记录的 prompt 总量（按时间正序的记录列表）。
 * @param {any[]} records
 * @returns {number | null}
 */
export function lastPromptTokens(records) {
  const list = Array.isArray(records) ? records : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value = promptTokensOfCost(list[index]?.cost);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 把提示渲染成一行（host 半 `/btw` 结果用；client 半有自己的文案）。
 * 空字符串表示不提示。只给区间 + 上一次真实值，不伪造精确账单。
 * @param {CostHint | null | undefined} hint
 * @param {Record<string, string>} messages 扁平文案表（FALLBACK 已 merge）
 * @returns {string}
 */
export function formatCostHintLine(hint, messages) {
  if (hint === null || hint === undefined || hint.level !== "warn") return "";
  const warn = format(messages.costWarn ?? "", {
    pressure: formatTokens(hint.pressureTokens),
    low: formatTokens(hint.estimatedLow),
    high: formatTokens(hint.estimatedHigh),
  });
  const last =
    hint.lastActualPromptTokens === null || hint.lastActualPromptTokens === undefined
      ? ""
      : ` ${format(messages.costLast ?? "", { tokens: formatTokens(hint.lastActualPromptTokens) })}`;
  return `⚠ ${warn}${last}`;
}
