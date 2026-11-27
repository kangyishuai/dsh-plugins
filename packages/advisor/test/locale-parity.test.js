// @ts-check
// client 半的 t() 只认内嵌字典（classic script 不能 import JSON），而 locale/*.json 同时承担
// 「给人看的清单」和宿主侧文案。两处漂移的后果很具体：界面直接显示 `settings.preview.run`
// 这样的原始 key（真机踩过）。这里用文本扫描守住一致性，防止再犯。
//
// 另外守住「内嵌字典」与 `LOCALE_EXTRA` 的**键集不相交**（审计 AUD-ADV-14）：两份字典都定义
// 同一个 key 时，`Object.assign` 让后一份静默覆盖前一份，前一份变成永远不生效的死文本，
// 两处文案一改就漂移（曾经有 30 个 key 这样重复）。新增文案只放 LOCALE_EXTRA。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = join(ROOT, "lib", "client.js");

/** @param {"zh"|"en"} lang */
async function localeKeys(lang) {
  const raw = JSON.parse(await readFile(join(ROOT, "locale", `${lang}.json`), "utf8"));
  return new Set(Object.keys(raw.advisor ?? {}));
}

/**
 * 从源码里截出 `marker` 开头的一段平衡花括号块（跳过字符串里的花括号）。
 * @param {string} source
 * @param {string} marker
 * @returns {string|null}
 */
function sliceBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== "") {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

/**
 * 收集一个对象字面量里出现的 key（`"key":` 与未加引号的 `key:` 两种写法都认）。
 * @param {string} block
 * @returns {Set<string>}
 */
function keysOf(block) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const match of block.matchAll(/(?:"([A-Za-z0-9_.]+)"|([A-Za-z][A-Za-z0-9_.]*))\s*:/gu)) {
    keys.add(match[1] ?? match[2]);
  }
  return keys;
}

/** @param {string} marker @returns {Promise<Set<string>>} */
async function dictKeys(marker) {
  const source = await readFile(CLIENT, "utf8");
  const block = sliceBlock(source, marker);
  assert.ok(block !== null, `client.js 找不到 ${marker}`);
  return keysOf(block);
}

/** `LOCALE_EXTRA` 里某一语言的子字典。 @param {"zh"|"en"} lang */
async function extraKeys(lang) {
  const source = await readFile(CLIENT, "utf8");
  const extra = sliceBlock(source, "const LOCALE_EXTRA = {");
  assert.ok(extra !== null, "client.js 找不到 LOCALE_EXTRA");
  const sub = sliceBlock(extra, `${lang}: {`);
  assert.ok(sub !== null, `LOCALE_EXTRA 缺少 ${lang}`);
  return keysOf(sub);
}

/** @param {Set<string>} superset @param {Set<string>} subset @param {string} label */
function assertCovers(superset, subset, label) {
  const missing = [...subset].filter((key) => !superset.has(key));
  assert.deepEqual(missing, [], `${label} 缺少这些文案：${missing.join(", ")}`);
}

test("client 内嵌字典覆盖 locale/zh.json 的全部 key（否则界面显示原始 key）", async () => {
  const embedded = await dictKeys("let zh = {");
  const extra = await extraKeys("zh");
  const union = new Set([...embedded, ...extra]);
  assertCovers(union, await localeKeys("zh"), "client.js 的 zh 字典");
});

test("client 内嵌字典覆盖 locale/en.json 的全部 key", async () => {
  const embedded = await dictKeys("let en = {");
  const extra = await extraKeys("en");
  const union = new Set([...embedded, ...extra]);
  assertCovers(union, await localeKeys("en"), "client.js 的 en 字典");
});

test("两个 locale 文件的 key 集完全一致", async () => {
  const zh = [...(await localeKeys("zh"))].sort();
  const en = [...(await localeKeys("en"))].sort();
  assert.deepEqual(zh, en);
});

test("内嵌字典与 LOCALE_EXTRA 的键集不相交（AUD-ADV-14：重复定义会静默覆盖）", async () => {
  const embeddedZh = await dictKeys("let zh = {");
  const embeddedEn = await dictKeys("let en = {");
  const extraZh = await extraKeys("zh");
  const extraEn = await extraKeys("en");
  assert.deepEqual(
    [...embeddedZh].filter((key) => extraZh.has(key)),
    [],
    "zh 里这些 key 同时定义在内嵌字典与 LOCALE_EXTRA",
  );
  assert.deepEqual(
    [...embeddedEn].filter((key) => extraEn.has(key)),
    [],
    "en 里这些 key 同时定义在内嵌字典与 LOCALE_EXTRA",
  );
});
