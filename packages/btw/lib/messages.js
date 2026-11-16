// @ts-check
// 文案的唯一来源是 locale/*.json；这里只负责加载与选语言，避免「同一键在两处定义」。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 读取某个语言的文案表（命名空间由文件本身决定）。
 * @param {string} localeDir
 * @param {'en' | 'zh'} language
 * @returns {Promise<Record<string, string>>}
 */
export async function loadMessages(localeDir, language) {
  const raw = await readFile(join(localeDir, `${language}.json`), "utf8");
  const parsed = JSON.parse(raw);
  const table = parsed?.btw ?? parsed;
  return /** @type {Record<string, string>} */ (table);
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
