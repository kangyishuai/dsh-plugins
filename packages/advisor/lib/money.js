// @ts-check
// 币种与金额换算。
//
// 账本、预算池、guard 的内部单位始终是 **USD**；`currency`/`usdToCny` 只决定
// 「设置里的金额按什么币种填写/展示」以及「显示时怎么把 USD 折算回去」。
// 汇率是手动配置的，插件不联网取价。

/** 支持设置的币种。 */
export const CURRENCIES = Object.freeze(/** @type {const} */ (["USD", "CNY"]));

/** 默认汇率：1 USD = 7.2 CNY（只是初始值，请按实际汇率修改）。 */
export const DEFAULT_USD_TO_CNY = 7.2;

/**
 * 规整币种：未知值按 USD。
 * @param {unknown} value
 * @returns {"USD"|"CNY"}
 */
export function normalizeCurrency(value) {
  return value === "CNY" ? "CNY" : "USD";
}

/**
 * 规整汇率：非有限/非正数回落到默认，夹在 0.1–100。
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USD_TO_CNY;
  return Math.min(100, Math.max(0.1, n));
}

/**
 * 设置币种金额 → USD。`rate` 是 1 USD 等于多少 CNY。
 * @param {unknown} amount
 * @param {unknown} currency
 * @param {unknown} rate
 * @returns {number}
 */
export function toUsd(amount, currency, rate) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  if (normalizeCurrency(currency) === "USD") return n;
  return n / normalizeRate(rate);
}

/**
 * USD → 设置币种金额。
 * @param {unknown} amountUsd
 * @param {unknown} currency
 * @param {unknown} rate
 * @returns {number}
 */
export function fromUsd(amountUsd, currency, rate) {
  const n = Number(amountUsd);
  if (!Number.isFinite(n)) return 0;
  if (normalizeCurrency(currency) === "USD") return n;
  return n * normalizeRate(rate);
}

/**
 * 金额显示：USD 用 $，CNY 用 ¥。
 * @param {unknown} amount
 * @param {unknown} currency
 * @param {number} [digits]
 * @returns {string}
 */
export function formatMoney(amount, currency, digits = 4) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  const places = Number.isFinite(digits) ? Math.max(0, Math.min(8, Math.round(digits))) : 4;
  return `${normalizeCurrency(currency) === "CNY" ? "¥" : "$"}${value.toFixed(places)}`;
}
