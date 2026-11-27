// @ts-check
// 「本地日键」只在这里实现一份。
//
// 审计 AUD-ADV-04：账本原来用 `new Date().toISOString()`（UTC）写入、却拿本地日键比较，
// UTC+8 下每天 0–8 点的花费会被算到前一天 → 重启后当日已花被低估。现在账本行自带 `day`
// 字段（写入时按本地日算），读取时优先用它；旧行没有 `day` 时按 `at` 的**本地日期**折算。

/** 账本行里稳定日键的形状。 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * 本地日键 YYYY-MM-DD。
 * @param {Date} [date]
 * @returns {string}
 */
export function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 把 ISO 时间之类的时间值换算成本地日键；无法解析时返回空串（由调用方决定怎么兜底）。
 * @param {unknown} value
 * @returns {string}
 */
export function dayKeyOf(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : dayKey(value);
  if (typeof value !== "string" || value.trim() === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dayKey(date);
}

/**
 * 一条账本/建议记录属于哪个本地日：`day` 字段优先（新数据），否则从 `at` 折算（旧数据）。
 * @param {{ day?: unknown, at?: unknown }} [entry]
 * @returns {string}
 */
export function dayOfEntry(entry) {
  const stored = entry?.day;
  if (typeof stored === "string" && DAY_PATTERN.test(stored)) return stored;
  return dayKeyOf(entry?.at);
}
