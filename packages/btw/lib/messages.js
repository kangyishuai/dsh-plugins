// @ts-check
// 文案的唯一来源是 locale/*.json；这里只负责加载、摊平与选语言，避免「同一键在两处定义」。
//
// 为什么 host 半要自己摊平（DSH 0.2.2-rc.5 实测，见 docs/runtime/0.2.2-rc.5.md §8）：
// - 宿主**没有** locale 服务：`ctx.locale` 只存在于 client 半，`commands.register()` 的
//   description / input.hint 与命令结果 `{ kind, text }` 全部由宿主**逐字透传**；
// - `locale/*.json` 在官方包里只是插件展示元数据（`{"meta":{"title","description"}}`），
//   宿主不会把它注册成任何命名空间字典，更没有「嵌套→扁平」的归一化。
// 所以 host 半必须自己读 JSON，并把语义分层的键映射到 FALLBACK 的平面键；否则
// `{...FALLBACK, ...loaded}` 里 loaded 的值是对象，平面键一个都覆盖不到，界面永远是英文。
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * locale/*.json 里的语义路径 → host 半 FALLBACK 使用的平面键。
 * 新增 host 文案时两处一起加；`test/index.test.js` 会守住映射结果不是对象/空值。
 * @type {Record<string, string>}
 */
const HOST_KEYS = {
  description: "btw.command.description",
  hint: "btw.usage.hint",
  noHistory: "btw.usage.noHistory",
  tooLong: "btw.error.tooLong",
  forkUnavailable: "btw.error.forkUnavailable",
  forkFailed: "btw.error.forkFailed",
  emptyAnswer: "btw.error.emptyAnswer",
  timeout: "btw.error.timeout",
  cancelled: "btw.error.cancelled",
  threadFull: "threadFull",
  meta: "btw.answer.meta",
  panelOnly: "btw.answer.panelOnly",
  reopen: "btw.answer.reopen",
  truncated: "btw.answer.truncated",
  costWarn: "btw.cost.warn",
  costLast: "btw.cost.last",
};

/**
 * 把嵌套字典摊平成点号键（只保留字符串叶子）。
 * @param {any} table
 * @param {string} [prefix]
 * @returns {Record<string, string>}
 */
export function flattenMessages(table, prefix = "") {
  /** @type {Record<string, string>} */
  const out = {};
  if (table === null || typeof table !== "object") return out;
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out[path] = value;
    else if (value !== null && typeof value === "object") {
      Object.assign(out, flattenMessages(value, path));
    }
  }
  return out;
}

/**
 * 把 locale 文件的原始 JSON 映射成 host 半可用的平面字典。
 *
 * 兼容两种写法：语义分层的嵌套结构（当前文件）与已经是平面键的字典（未来简化时）。
 * @param {any} raw
 * @returns {Record<string, string>}
 */
export function mapMessages(raw) {
  const flat = flattenMessages(raw);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, path] of Object.entries(HOST_KEYS)) {
    const value = flat[path] ?? flat[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/**
 * 读取某个语言的文案表（平面键，与 FALLBACK 一一对应）。
 * @param {string} localeDir
 * @param {'en' | 'zh'} language
 * @returns {Promise<Record<string, string>>}
 */
export async function loadMessages(localeDir, language) {
  const raw = await readFile(join(localeDir, `${language}.json`), "utf8");
  return mapMessages(JSON.parse(raw));
}

/**
 * 同步版本：host 半在注册 `/btw` 命令**之前**就要拿到文案（宿主的命令 description
 * 是注册时的字面量，之后不会再翻译），所以激活期用同步读；locale 文件只有几 KB。
 * @param {string} localeDir
 * @param {'en' | 'zh'} language
 * @returns {Record<string, string>}
 */
export function loadMessagesSync(localeDir, language) {
  const raw = readFileSync(join(localeDir, `${language}.json`), "utf8");
  return mapMessages(JSON.parse(raw));
}

/**
 * 选语言：显式配置优先，否则看系统语言是否中文。
 * @param {unknown} configured
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'en' | 'zh'}
 */
export function pickLanguage(configured, env = process.env) {
  if (configured === "zh" || configured === "en") return configured;
  const hint = `${env?.LANG ?? ""} ${env?.LC_ALL ?? ""} ${env?.LANGUAGE ?? ""}`;
  return /zh|cn/i.test(hint) ? "zh" : "en";
}

/**
 * 简易插值：替换 {name} 占位符。
 * @param {string} template
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function format(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
