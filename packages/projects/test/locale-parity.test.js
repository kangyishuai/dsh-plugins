// @ts-check
// B3 复审 P1：runtime 字典（client.js 的 ZH/EN，`ctx.locale.register` 用的那份）与
// `locale/{zh,en}.json`（插件管理器展示 + 人读清单）长期漂移——现场缺 44 个键，
// 且 `settings.realtimeCi*` 还写着「会建临时 webhook」，与 B2 已改的「未实现」矛盾。
//
// 这里锁四件事：
//   1. runtime ZH 键集 == locale zh 键集（双向，缺一个就红）；
//   2. runtime EN 键集 == locale en 键集；
//   3. 两份 locale 键集一致；
//   4. 同名键的值也一致（值漂移同样会让人看到过期文案）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

/**
 * 从 client.js 抽出 `var ZH = {...}` / `var EN = {...}` 对象字面量并求值。
 * 字符串里允许出现 `{count}` 这类花括号模板，所以扫描时要跳过字符串。
 * @param {string} source @param {"ZH"|"EN"} name
 * @returns {Record<string, string>}
 */
function runtimeDictionary(source, name) {
  const marker = `var ${name} = {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `client.js 里找不到 ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let index = open;
  /** @type {string|null} */
  let quote = null;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = source.slice(open, index + 1);
  // 求值对象是本仓库源码里的对象字面量（只含字符串常量），不来自外部输入。
  // biome-ignore lint/security/noGlobalEval: 见上一行说明
  const evaluate = /** @type {(code: string) => Record<string, string>} */ (eval);
  return evaluate(`(${literal})`);
}

/** @param {"zh"|"en"} lang */
async function localeDictionary(lang) {
  const raw = JSON.parse(await readFile(join(ROOT, "locale", `${lang}.json`), "utf8"));
  return raw.projects;
}

async function runtime() {
  const source = await readFile(join(ROOT, "lib", "client.js"), "utf8");
  return { zh: runtimeDictionary(source, "ZH"), en: runtimeDictionary(source, "EN") };
}

test("runtime ZH 字典与 locale/zh.json 键集完全一致（B3 复审：曾缺 44 键）", async () => {
  const { zh } = await runtime();
  const locale = await localeDictionary("zh");
  const missingInLocale = Object.keys(zh).filter((key) => !Object.hasOwn(locale, key));
  const missingInRuntime = Object.keys(locale).filter((key) => !Object.hasOwn(zh, key));
  assert.deepEqual(missingInLocale, [], `locale/zh.json 缺少这些键：${missingInLocale.join(", ")}`);
  assert.deepEqual(missingInRuntime, [], `runtime ZH 缺少这些键：${missingInRuntime.join(", ")}`);
});

test("runtime EN 字典与 locale/en.json 键集完全一致", async () => {
  const { en } = await runtime();
  const locale = await localeDictionary("en");
  const missingInLocale = Object.keys(en).filter((key) => !Object.hasOwn(locale, key));
  const missingInRuntime = Object.keys(locale).filter((key) => !Object.hasOwn(en, key));
  assert.deepEqual(missingInLocale, [], `locale/en.json 缺少这些键：${missingInLocale.join(", ")}`);
  assert.deepEqual(missingInRuntime, [], `runtime EN 缺少这些键：${missingInRuntime.join(", ")}`);
});

test("两份 locale 的键集一致（zh ↔ en 一一对应）", async () => {
  const zh = Object.keys(await localeDictionary("zh")).sort();
  const en = Object.keys(await localeDictionary("en")).sort();
  assert.deepEqual(zh, en);
});

test("同名键的文案值一致（runtime 是界面真源，locale 不能留旧文案）", async () => {
  const { zh, en } = await runtime();
  const localeZh = await localeDictionary("zh");
  const localeEn = await localeDictionary("en");
  const stale = [];
  for (const [key, value] of Object.entries(zh)) {
    if (localeZh[key] !== value) stale.push(`zh.${key}: ${String(localeZh[key])} != ${value}`);
  }
  for (const [key, value] of Object.entries(en)) {
    if (localeEn[key] !== value) stale.push(`en.${key}: ${String(localeEn[key])} != ${value}`);
  }
  assert.deepEqual(stale, [], `locale 文案与 runtime 不一致：\n${stale.join("\n")}`);
});

test("实时 CI 开关文案如实写「未实现」，不再承诺会建 webhook（B3 复审）", async () => {
  const { zh, en } = await runtime();
  for (const [lang, dict] of /** @type {const} */ ([
    ["zh", zh],
    ["en", en],
  ])) {
    assert.match(dict["settings.realtimeCiHint"], lang === "zh" ? /未实现/u : /not implemented/iu);
    assert.doesNotMatch(
      dict["settings.realtimeCiHint"],
      lang === "zh" ? /会建临时 ?webhook|创建临时 ?webhook/u : /creates a temporary webhook/iu,
    );
    // 「不会建 webhook」是真话；这里禁的是「已开启 / 已建」这类会让人以为功能生效的文案。
    assert.doesNotMatch(
      dict["settings.realtimeCiOn"],
      lang === "zh" ? /已开启|已建|临时 ?webhook/u : /^enabled|\benabled\b|creates a temporary/iu,
    );
  }
  const localeZh = await localeDictionary("zh");
  assert.doesNotMatch(localeZh["settings.realtimeCiHint"], /会建临时 ?webhook/u);
});
