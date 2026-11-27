// @ts-check
// 宿主半文案：从包内 `locale/<lang>.json` 的 `host.*` 段加载，摊平成平面键后使用。
//
// 为什么 host 半要自己读 JSON（docs/runtime/0.2.2-rc.5.md §8.1 实测）：
// - 宿主**没有** locale 服务：`ctx.locale` 只在 client 半，`commands.register()` 的
//   `description` / `input.hint` 由宿主逐字透传，不会翻译；
// - `locale/*.json` 在宿主眼里只是插件展示元数据（只读 `meta.title` / `meta.description`），
//   既不会注册成字典，也没有「嵌套 → 扁平」的归一化。
// 参考实现：btw 0.6.1（`packages/btw/lib/messages.js`，同一宿主结论）。
//
// 文件布局约定（`locale/zh.json` / `locale/en.json`）：
//   { "advisor": { ...client 字典（扁平点号键）... }, "host": { "command.description": ..., "command.hint": ... } }
// 两个段分开：client 的 locale-parity 测试只比对 `advisor` 段的键集，host 段由本模块测。
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 缺翻译时的英文兜底（也是 `test/messages.test.js` 的键集事实来源）。
 * 缺一不可：注册 `commands.register()` 拿到 `undefined` 会被宿主拒收。
 * @type {Record<"description" | "hint", string>}
 */
export const FALLBACK = Object.freeze({
  description: "Consult the advisor: status, choose a model, ask now, or turn it off",
  hint: "[status|on|off|shadow|ask|cancel|report|doctor|confirm|preview|<provider>/<model>]",
});

/**
 * `locale/<lang>.json` 里 host 段 → 平面键（与 {@link FALLBACK} 一一对应）。
 * @type {Record<"description" | "hint", string>}
 */
export const HOST_KEYS = Object.freeze({
  description: "host.command.description",
  hint: "host.command.hint",
});

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
 * 兼容两种写法：带 `host` 段的嵌套结构（当前文件）与已经是平面键的字典。
 * @param {any} raw
 * @returns {Partial<Record<"description" | "hint", string>>}
 */
export function mapMessages(raw) {
  const flat = flattenMessages(raw);
  /** @type {Partial<Record<"description" | "hint", string>>} */
  const out = {};
  for (const key of /** @type {Array<"description" | "hint">} */ (Object.keys(HOST_KEYS))) {
    const value = flat[HOST_KEYS[key]] ?? flat[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

/**
 * 异步读取某语言的 host 文案。
 * @param {string} localeDir
 * @param {"en" | "zh"} language
 * @returns {Promise<Partial<Record<"description" | "hint", string>>>}
 */
export async function loadMessages(localeDir, language) {
  const raw = await readFile(join(localeDir, `${language}.json`), "utf8");
  return mapMessages(JSON.parse(raw));
}

/**
 * 同步版本：host 半在注册 `/advisor` 命令**之前**就要拿到文案（宿主的 description
 * 是注册时的字面量，之后不会再翻译），所以激活期同步读；locale 文件只有几 KB。
 * @param {string} localeDir
 * @param {"en" | "zh"} language
 * @returns {Partial<Record<"description" | "hint", string>>}
 */
export function loadMessagesSync(localeDir, language) {
  const raw = readFileSync(join(localeDir, `${language}.json`), "utf8");
  return mapMessages(JSON.parse(raw));
}

/**
 * 选语言：显式配置（插件 config.language）优先，否则看系统语言是否中文。
 * 与 btw 0.6.1 的判据一致：桌面版在中文环境里实测会走 zh（runtime §8.2）。
 * @param {unknown} configured
 * @param {Record<string, string | undefined>} [env]
 * @returns {"en" | "zh"}
 */
export function pickLanguage(configured, env = process.env) {
  if (configured === "zh" || configured === "en") return configured;
  const hint = `${env?.LANG ?? ""} ${env?.LC_ALL ?? ""} ${env?.LANGUAGE ?? ""}`;
  return /zh|cn/i.test(hint) ? "zh" : "en";
}
