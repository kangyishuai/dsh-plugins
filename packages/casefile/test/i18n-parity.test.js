// @ts-check
// i18n 一致性守卫。
//
// 背景（2026-11-17 实测踩坑）：给 blocker 加文案时只改了英文块，中文块因为脚本断言失败
// 没落盘，结果中文界面显示英文。这类「只加一种语言」的漂移必须由测试拦住。
//
// 三处字典必须键集合一致：
//   1. client.js 内置 ZH
//   2. client.js 内置 EN
//   3. locale/zh.json 与 locale/en.json 的 casefile 命名空间
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(root, "lib", "client.js"), "utf8");

/**
 * 抽出 `var NAME = { ... };` 里的键。
 * @param {string} source
 * @param {string} name
 * @returns {string[]}
 */
function dictKeys(source, name) {
  const start = source.indexOf(`var ${name} = {`);
  assert.ok(start >= 0, `client.js 里找不到 var ${name}`);
  const end = source.indexOf("\n    };", start);
  assert.ok(end > start, `${name} 的结束位置找不到`);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s{6}"([^"]+)":/gmu)].map((match) => match[1]);
}

/** @param {string} lang */
function localeKeys(lang) {
  const raw = readFileSync(join(root, "locale", `${lang}.json`), "utf8");
  const parsed = JSON.parse(raw);
  return Object.keys(parsed.casefile ?? {});
}

test("client 内置 ZH 与 EN 键集合一致", () => {
  const zh = dictKeys(CLIENT, "ZH").sort();
  const en = dictKeys(CLIENT, "EN").sort();
  assert.ok(zh.length > 20, `只抽到 ${zh.length} 个 ZH 键，正则可能失配`);
  const missingInEn = zh.filter((key) => !en.includes(key));
  const missingInZh = en.filter((key) => !zh.includes(key));
  assert.deepEqual(missingInEn, [], `EN 缺少：${missingInEn.join("、")}`);
  assert.deepEqual(missingInZh, [], `ZH 缺少：${missingInZh.join("、")}`);
});

test("locale/zh.json 与 locale/en.json 的 casefile 命名空间键一致", () => {
  const zh = localeKeys("zh").sort();
  const en = localeKeys("en").sort();
  assert.ok(zh.length > 10, `只抽到 ${zh.length} 个 locale 键`);
  assert.deepEqual(
    zh.filter((key) => !en.includes(key)),
    [],
    "locale/en.json 缺少键",
  );
  assert.deepEqual(
    en.filter((key) => !zh.includes(key)),
    [],
    "locale/zh.json 缺少键",
  );
});

test("client 字典与 locale 文件覆盖同一批 UI 文案键", () => {
  const clientZh = new Set(dictKeys(CLIENT, "ZH"));
  const fileZh = new Set(localeKeys("zh"));
  // locale 文件是宿主展示用的元数据（标题/描述）+ UI 文案；client 字典是运行时兜底。
  // 这里只要求：locale 里出现的 UI 文案键（非 title/description）都在 client 字典里。
  const uiKeys = [...fileZh].filter(
    (key) => !key.startsWith("title") && !key.startsWith("description"),
  );
  const missing = uiKeys.filter((key) => !clientZh.has(key));
  assert.deepEqual(missing, [], `client ZH 字典缺少 locale 里的键：${missing.join("、")}`);
});

test("没有中文占位混进英文块（抽查常见中文标点）", () => {
  const start = CLIENT.indexOf("var EN = {");
  const end = CLIENT.indexOf("\n    };", start);
  const enBlock = CLIENT.slice(start, end);
  const offenders = [...enBlock.matchAll(/^\s{6}"([^"]+)":\s*"([^"]*)"/gmu)]
    .filter((match) => /[\u4e00-\u9fff]/u.test(match[2]))
    .map((match) => match[1]);
  assert.deepEqual(offenders, [], `英文块里混入中文：${offenders.join("、")}`);
});
