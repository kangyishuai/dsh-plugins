// @ts-check
// 版本位与出卡档位：一次生成产出「该不该继续」的三档判断，档位决定展示阈值。
//
// 为什么要单开一个文件：
// - 三档判定（must / could / no）是 v0.4 的核心语义，卡片记录、事件、报表、设置页都要用它，
//   散落在各处的字符串常量最容易写错一个字母且无人发现（`shouldShow` 是纯函数，可穷举单测）。
// - `SCHEME` / `PROMPT_VERSION` 是复盘的分组维度：改一次提示词或按钮规则就 +1，
//   报表按它对比改前改后（见 docs/adr/0013）。

/** 采集口径的方案号：报表只统计同一 scheme 的事件，避免跨版本混算。 */
export const SCHEME = "v0.4";

/** 提示词版本位：每次改提示词或按钮文案规则就 +1。 */
export const PROMPT_VERSION = 3;

/**
 * 用户可选的出卡档位（显示阈值），从紧到松。
 * - `must`：只出「明确需要」的卡
 * - `could`：`must` + 「拿不准」也出（默认）
 * - `any`：三档都出（含模型判为 `no` 的，实验档）
 */
export const CARD_TIERS = /** @type {const} */ (["must", "could", "any"]);

/** 三档判定的强弱排序：数值越大越"该出卡"。 */
export const VALUE_RANK = Object.freeze(
  /** @type {Record<string, number>} */ ({ no: 0, could: 1, must: 2 }),
);

/**
 * 是不是合法档位。
 * @param {unknown} value
 * @returns {value is "must" | "could" | "any"}
 */
export function isCardTier(value) {
  return value === "must" || value === "could" || value === "any";
}

/**
 * 是不是合法三档判定。
 * @param {unknown} value
 * @returns {value is "must" | "could" | "no"}
 */
export function isCardValue(value) {
  return value === "must" || value === "could" || value === "no";
}

/**
 * 档位 → 显示阈值（越低越松）。未知档位按默认档位 `could` 处理：
 * 设置文件被手改成非法值时，宁可回到默认行为，也不要静默变成"永不出卡"。
 * @param {unknown} tier
 * @returns {number}
 */
export function tierRank(tier) {
  if (!isCardTier(tier)) return VALUE_RANK.could;
  return tier === "any" ? VALUE_RANK.no : VALUE_RANK[tier];
}

/**
 * 这一档判定在当前档位下要不要显示。
 * 未知判定值一律不显示（防御：卡片内容不可信时宁可不渲染）。
 * @param {unknown} value 三档判定
 * @param {unknown} tier 档位
 * @returns {boolean}
 */
export function shouldShow(value, tier) {
  if (!isCardValue(value)) return false;
  return VALUE_RANK[value] >= tierRank(tier);
}
