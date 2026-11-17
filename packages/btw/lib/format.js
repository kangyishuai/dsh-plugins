// @ts-check
// 可读性格式化：token 数自适应 K/M/B/T，耗时自适应 ms/s/m/h。
//
// 刻意做成纯函数、不 import 宿主包：
//   - host 半用它渲染命令结果里的成本行（`旁问 · 新增 12.3K tokens · …`）；
//   - client 半是 classic script，无法 import 本模块，`lib/client.js` 里有一份
//     **行为等价**的副本；两处都由各自的单测/冒烟兜住（见 README 的「成本徽章」）。

const TOKEN_UNITS = [
  { scale: 1e3, suffix: "K" },
  { scale: 1e6, suffix: "M" },
  { scale: 1e9, suffix: "B" },
  { scale: 1e12, suffix: "T" },
];

/**
 * 保留一位小数并去掉末尾的 `.0`。
 * @param {number} value
 * @returns {string}
 */
function oneDecimal(value) {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0+$/u, "");
}

/**
 * 小于 100 的数值保留一位小数（1.2K / 12.3K），再大就取整（123K / 123M）。
 * @param {number} value
 * @returns {string}
 */
function scaledText(value) {
  return value < 100 ? oneDecimal(value) : String(Math.round(value));
}

/**
 * 自适应 token 数：999 → "999"；1234 → "1.2K"；123456 → "123K"；
 * 1.2e6 → "1.2M"；3.4e9 → "3.4B"；5e12 → "5T"。
 * 负数、NaN、非数字一律返回 "0"（宁可显示 0 也不显示 NaN）。
 * @param {unknown} value
 * @returns {string}
 */
export function formatTokens(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  if (number < 1000) return String(number);
  let index = 0;
  for (let i = 0; i < TOKEN_UNITS.length; i += 1) {
    if (number >= TOKEN_UNITS[i].scale) index = i;
  }
  let unit = TOKEN_UNITS[index];
  let scaled = number / unit.scale;
  // 999_999 / 1e3 = 999.999 → 四舍五入成 1000K 很丑，升一档写成 1M。
  if (index < TOKEN_UNITS.length - 1 && scaled >= 999.5) {
    index += 1;
    unit = TOKEN_UNITS[index];
    scaled = number / unit.scale;
  }
  return `${scaledText(scaled)}${unit.suffix}`;
}

/**
 * 自适应耗时：999 → "999ms"；1234 → "1.2s"；90_000 → "1.5m"；5_400_000 → "1.5h"。
 * 上限单位到小时（旁问最长 120s，面板里不会出现天）。
 * @param {unknown} value
 * @returns {string}
 */
export function formatDuration(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 59.95) return `${scaledText(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 59.95) return `${scaledText(minutes)}m`;
  return `${scaledText(minutes / 60)}h`;
}
