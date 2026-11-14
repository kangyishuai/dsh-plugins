// @ts-check
// 卡片/决策/揭示记录的**纯校验与归一化**：不 import 宿主包，可以直接单测。
//
// 为什么从 projection.js 抽出来：投影模块要 import `@deepseek-ai/dsh-session`（运行时由宿主解析），
// 在 `node --test` 里导入不了，于是「旧记录怎么读」「隐藏/显示的判定」这些最容易出错的逻辑
// 一直没有单测。把纯函数搬到这里之后，投影只负责折叠事件。

import { isCardTier, isCardValue } from "./scheme.js";

/** 卡片记录类型（一轮一张，`shown:false` 表示被档位抑制的候选）。 */
export const CARD_RECORD = "plugin:next-step/card";
/** 揭示记录类型（用户要求显示被抑制的候选）。 */
export const REVEAL_RECORD = "plugin:next-step/reveal";
/** 决策记录类型（点了 / 关了）。 */
export const DECISION_RECORD = "plugin:next-step/decision";

/**
 * 一条 option 是否合法（label 既是按钮文案，也是点击后原样发出的用户消息）。
 * @param {any} option
 * @returns {boolean}
 */
export function isOption(option) {
  return (
    option !== null &&
    typeof option === "object" &&
    typeof option.stance === "string" &&
    option.stance.trim() !== "" &&
    typeof option.label === "string" &&
    option.label.trim() !== ""
  );
}

/**
 * 卡片记录的结构校验（**宽容**：旧记录没有 value/shown/tier/promptVersion 也算合法，
 * 由 readCard 补默认值；这里只保证渲染与统计用得到的字段可用）。
 * @param {any} data
 * @returns {boolean}
 */
export function isCardData(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Number.isSafeInteger(data.turn) &&
    typeof data.summary === "string" &&
    data.summary.trim() !== "" &&
    typeof data.question === "string" &&
    data.question.trim() !== "" &&
    Array.isArray(data.options) &&
    // 1–2 条：只给 1 条表示「下一步很明确」，不是残缺；3 条以上徒增选择成本。
    data.options.length >= 1 &&
    data.options.length <= 2 &&
    data.options.every(isOption) &&
    (data.options.length === 1 || data.options[0].stance !== data.options[1].stance) &&
    (data.nextPrompt === undefined || typeof data.nextPrompt === "string") &&
    // 新字段出现时必须合法；不出现是旧记录
    (data.value === undefined || isCardValue(data.value)) &&
    (data.shown === undefined || typeof data.shown === "boolean") &&
    (data.tier === undefined || isCardTier(data.tier))
  );
}

/**
 * 写入前的严格校验：新卡必须带齐 v2 字段（服务端写卡时用，避免把半张卡写进会话）。
 * @param {any} data
 * @returns {boolean}
 */
export function isCardDataV2(data) {
  return (
    isCardData(data) &&
    isCardValue(data.value) &&
    typeof data.shown === "boolean" &&
    isCardTier(data.tier) &&
    Number.isSafeInteger(data.promptVersion)
  );
}

/**
 * 把任意（可能来自旧版本）卡片记录归一化成统一形状。
 * 旧记录缺 `value` → `"must"`（v0.2/v0.3 的卡都是"模型判定需要"才写的）；缺 `shown` → `true`。
 * @param {any} data
 * @returns {{
 *   turn: number, seq: number, summary: string, question: string,
 *   options: { stance: string, label: string }[], nextPrompt?: string,
 *   value: "must" | "could" | "no", shown: boolean,
 *   tier: "must" | "could" | "any", promptVersion: number,
 *   model: string, createdAt: number,
 * }}
 */
export function readCard(data) {
  return {
    turn: data.turn,
    seq: Number.isSafeInteger(data.seq) ? data.seq : 0,
    summary: data.summary,
    question: data.question,
    options: data.options.map((/** @type {any} */ option) => ({
      stance: option.stance,
      label: option.label,
    })),
    ...(typeof data.nextPrompt === "string" ? { nextPrompt: data.nextPrompt } : {}),
    value: isCardValue(data.value) ? data.value : "must",
    shown: typeof data.shown === "boolean" ? data.shown : true,
    tier: isCardTier(data.tier) ? data.tier : "could",
    promptVersion: Number.isSafeInteger(data.promptVersion) ? data.promptVersion : 0,
    model: typeof data.model === "string" ? data.model : "",
    createdAt: Number.isFinite(data.createdAt) ? data.createdAt : 0,
  };
}

/**
 * 揭示记录是否合法。
 * @param {any} data
 * @returns {boolean}
 */
export function isRevealData(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Number.isSafeInteger(data.turn) &&
    (data.via === undefined || data.via === "button" || data.via === "command")
  );
}

/**
 * 决策记录是否合法。
 * @param {any} data
 * @returns {boolean}
 */
export function isDecisionData(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Number.isSafeInteger(data.turn) &&
    (data.phase === "sent" || data.phase === "dismissed") &&
    (data.phase !== "sent" || Number.isSafeInteger(data.index))
  );
}

/**
 * 卡的可见/可交互状态。**host 侧三个守卫（act / dismiss / generateNow）与客户端渲染共用同一套判据**，
 * 所以抽成纯函数并用真值表单测（客户端是 classic script，逻辑镜像一份，测试用同一张表）。
 *
 * - `hidden`：候选被档位抑制、用户还没要求显示 → 不渲染卡片，只渲染补卡按钮
 * - `resolved`：点过或关过 → 只读
 * - `readonly-shown`：显示过但已不是最新回合 → 只读
 * - `interactive-eligible`：最新回合 + 已显示（或已揭示）→ 胶囊可点
 * @param {{ card: any, revealed?: boolean, decision?: any, isLastTurn?: boolean }} input
 * @returns {"hidden" | "resolved" | "readonly-shown" | "interactive-eligible"}
 */
export function resolveVisibility(input) {
  if (input.decision !== undefined && input.decision !== null) return "resolved";
  const card = input.card;
  if (card === undefined || card === null) return "hidden";
  const visible = card.shown === true || input.revealed === true;
  if (!visible) return "hidden";
  if (input.isLastTurn === false) return "readonly-shown";
  return "interactive-eligible";
}
