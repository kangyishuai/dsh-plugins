// @ts-check
// 纯函数守卫：预算、去重、免疫窗口、配对。不 import 宿主包，单测可直接跑。
// 设计原则：所有判断都可以用「整数 + 时间戳」表达，不依赖会话对象的形状。

import { toUsd } from "./money.js";

/** 去重指纹的默认窗口：24 小时。 */
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 去重表上限（有界 FIFO）。 */
export const DEDUPE_MAX = 4096;

/**
 * 稳定指纹：小写 + 折叠空白 + 去掉标点后取 djb2 的 16 进制串。
 * 同一句建议换个标点不该再投递一次。
 * @param {string} text
 * @returns {string}
 */
export function fingerprint(text) {
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/[.,;:!?'"`()[\]{}<>、。，；：！？「」『』（）【】—–-]/gu, " ")
    .replace(/[\s\u3000]+/gu, " ")
    .trim();
  let hash = 5381;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) | 0;
  }
  return `f${(hash >>> 0).toString(16)}`;
}

/**
 * 去重表：`Map<指纹, 首次命中时间>`，超过上限时丢最旧的。
 * @param {Map<string, number>} table
 * @param {string} id
 * @param {number} now
 * @param {number} [windowMs]
 * @returns {{ duplicate: boolean, table: Map<string, number> }}
 */
export function rememberFingerprint(table, id, now, windowMs = DEDUPE_WINDOW_MS) {
  const next = new Map(table);
  for (const [key, at] of next) {
    if (now - at > windowMs) next.delete(key);
  }
  const seenAt = next.get(id);
  if (seenAt !== undefined) return { duplicate: true, table: next };
  next.set(id, now);
  while (next.size > DEDUPE_MAX) {
    const oldest = next.keys().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return { duplicate: false, table: next };
}

/**
 * 免疫窗口：上次投递之后的 `immuneTurns` 个回合内不再投递打断性建议。
 * @param {{ lastDeliveryTurn: number|null, currentTurn: number, immuneTurns: number }} input
 * @returns {boolean}
 */
export function immuneActive(input) {
  const { lastDeliveryTurn, currentTurn, immuneTurns } = input;
  if (lastDeliveryTurn === null || lastDeliveryTurn === undefined) return false;
  if (!Number.isFinite(currentTurn) || !Number.isFinite(lastDeliveryTurn)) return false;
  if (immuneTurns <= 0) return false;
  return currentTurn - lastDeliveryTurn < immuneTurns;
}

/**
 * @typedef {object} BudgetCounters
 * @property {number} turnCalls 本回合已徵询次数
 * @property {number} sessionCalls 本会话已徵询次数
 * @property {number[]} hourStamps 最近一小时内的徵询时间戳（毫秒）
 * @property {number} dayCostUsd 今日已花（美元，估算值）
 */

/**
 * @typedef {object} BudgetInput
 * @property {typeof import("./settings.js").DEFAULT_SETTINGS} settings
 * @property {BudgetCounters} counters
 * @property {number} now
 * @property {number} [estimatedCostUsd] 本次预计花费，用于「日预算」预判
 */

/**
 * 四级预算检查。返回**第一个**不满足的条件（顺序固定，便于测试与文案稳定）。
 * 每个字段为 0 都表示「不限制」。
 * @param {BudgetInput} input
 * @returns {{ ok: true } | { ok: false, code: "turn_limit"|"session_limit"|"hour_limit"|"day_budget", limit: number, used: number }}
 */
export function checkBudget(input) {
  const { settings, counters, now, estimatedCostUsd = 0 } = input;

  if (settings.maxCallsPerTurn > 0 && counters.turnCalls >= settings.maxCallsPerTurn) {
    return {
      ok: false,
      code: "turn_limit",
      limit: settings.maxCallsPerTurn,
      used: counters.turnCalls,
    };
  }
  if (settings.maxCallsPerSession > 0 && counters.sessionCalls >= settings.maxCallsPerSession) {
    return {
      ok: false,
      code: "session_limit",
      limit: settings.maxCallsPerSession,
      used: counters.sessionCalls,
    };
  }
  if (settings.maxCallsPerHour > 0) {
    const hourAgo = now - 60 * 60 * 1000;
    const used = counters.hourStamps.filter((at) => at > hourAgo).length;
    if (used >= settings.maxCallsPerHour) {
      return { ok: false, code: "hour_limit", limit: settings.maxCallsPerHour, used };
    }
  }
  // 设置里的限额按 settings.currency 填写；比较前先换算成 USD。
  const maxCostUsd = toUsd(settings.maxCostPerDay, settings.currency, settings.usdToCny);
  if (maxCostUsd > 0 && counters.dayCostUsd + estimatedCostUsd > maxCostUsd) {
    return {
      ok: false,
      code: "day_budget",
      limit: maxCostUsd,
      used: counters.dayCostUsd,
    };
  }
  return { ok: true };
}

/**
 * 估算一次调用的美元成本。单价为 0 时返回 0（= 不算钱，只记 token）。
 * @param {{ inputTokens: number, outputTokens: number, priceInputPerMTok: number, priceOutputPerMTok: number }} input
 * @returns {number}
 */
export function estimateCostUsd(input) {
  const { inputTokens, outputTokens, priceInputPerMTok, priceOutputPerMTok } = input;
  const inCost = (Math.max(0, inputTokens) / 1_000_000) * Math.max(0, priceInputPerMTok);
  const outCost = (Math.max(0, outputTokens) / 1_000_000) * Math.max(0, priceOutputPerMTok);
  return inCost + outCost;
}

/**
 * 严重度排序（用于「多条发现折叠成一条」时取最高的）。
 * @param {"nit"|"concern"|"blocker"} severity
 * @returns {number}
 */
export function severityRank(severity) {
  if (severity === "blocker") return 3;
  if (severity === "concern") return 2;
  return 1;
}

/**
 * 瞳孔式收窄：输入若为极其空洞的建议（英文/中文的「没问题」「可以了」），返回 true。
 * 只做**精确匹配**，不做包含匹配 —— 包含匹配会误杀真正的 blocker。
 * @param {string} text
 * @returns {boolean}
 */
export function isHollowAdvice(text) {
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, " ")
    .replace(/[.,;:!?'"`。，；：！？]/gu, "")
    .trim();
  /** @type {Set<string>} */
  const hollow = new Set([
    "stop",
    "done",
    "complete",
    "completed",
    "lgtm",
    "looks good",
    "nothing to add",
    "no issues",
    "no problems",
    "all good",
    "ok",
    "okay",
    "没问题",
    "没有问题",
    "可以了",
    "看起来不错",
    "完成",
    "无需建议",
  ]);
  return hollow.has(normalized);
}
