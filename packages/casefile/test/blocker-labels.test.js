// @ts-check
// 防回归：宿主产出的 blocker 令牌必须都在客户端有文案映射。
//
// 背景（2026-11-17 实测发现）：关闭义务被硬门拒绝时，UI 直接显示内部令牌
// `no-fresh-check`，用户看不懂。修法是客户端把令牌翻成文案；
// 这个测试保证「以后新增 blocker 但不加文案」会先红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

const ACTIONS = readFileSync(join(root, "lib", "actions.js"), "utf8");
const REPORT = readFileSync(join(root, "lib", "core", "report.js"), "utf8");
const RUNS = readFileSync(join(root, "lib", "core", "runs.js"), "utf8");
const CLIENT = readFileSync(join(root, "lib", "client.js"), "utf8");

/**
 * 抽出宿主会产出的 blocker 令牌。
 * 覆盖三种写法：blockers.push("x") / blockers.push(`check-${v}`) / reasons.push("x")
 * 以及 report.js 里的模板串（open-obligations:${n} 这类带计数的）。
 * @param {string} source
 * @returns {Set<string>}
 */
function emitTokens(source) {
  /** @type {Set<string>} */
  const tokens = new Set();
  // 字面量：push("x") / push('x')
  for (const match of source.matchAll(/\.push\(\s*["'`]([a-z][a-z-]*)["'`]\s*\)/gu)) {
    tokens.add(match[1]);
  }
  // 模板串里 `${...}` 前的固定前缀，例如 check-${verdict}
  for (const match of source.matchAll(/\.push\(\s*`([a-z][a-z-]*?)\$\{/gu)) {
    tokens.add(`${match[1]}*`);
  }
  // report.js 的 blockers.push(`open-obligations:${n}`) 形式
  for (const match of source.matchAll(/blockers\.push\(\s*`([a-z][a-z-]*):\$\{/gu)) {
    tokens.add(match[1]);
  }
  return tokens;
}

/**
 * 客户端 BLOCKER_KEYS 里登记的令牌。
 * @param {string} source
 * @returns {Set<string>}
 */
function mappedTokens(source) {
  /** @type {Set<string>} */
  const tokens = new Set();
  const block = source.match(/var BLOCKER_KEYS = \{([\s\S]*?)\n {4}\};/u);
  assert.ok(block, "client.js 里找不到 BLOCKER_KEYS");
  for (const match of block[1].matchAll(/"([a-z][a-z-]*)":/gu)) {
    tokens.add(match[1]);
  }
  return tokens;
}

test("宿主的每个 blocker 令牌都在客户端有文案", () => {
  const emitted = emitTokens([ACTIONS, REPORT, RUNS].join("\n"));
  assert.ok(emitted.size >= 8, `只抽到 ${emitted.size} 个令牌，正则可能失配`);

  const mapped = mappedTokens(CLIENT);
  const missing = [...emitted]
    .filter((token) => !token.endsWith("*")) // 动态 check-${verdict} 由 check-fail/check-unknown 覆盖
    .filter((token) => !mapped.has(token))
    .sort();
  assert.deepEqual(missing, [], `以下 blocker 缺少客户端文案：${missing.join("、")}`);
});

test("动态 check-<verdict> 的两种取值都有映射", () => {
  const mapped = mappedTokens(CLIENT);
  assert.ok(mapped.has("check-fail"), "缺少 check-fail 文案");
  assert.ok(mapped.has("check-unknown"), "缺少 check-unknown 文案");
});

test("每个 blocker 文案 key 在 zh/en 两个字典里都存在", () => {
  const keys = [...mappedTokens(CLIENT)].map((token) => {
    const match = CLIENT.match(new RegExp(`"${token}":\\s*"([^"]+)"`, "u"));
    assert.ok(match, `${token} 缺少到文案 key 的映射`);
    return match[1];
  });
  const zh = CLIENT.match(/\n {6}\};\n\n {6}\/\/ ----------[\s\S]*?/) ? null : null;
  void zh;
  // 直接按「中文块在前、英文块在后」的既有结构各扫一遍
  const zhBlock = CLIENT.slice(CLIENT.indexOf('"run.title":'), CLIENT.indexOf('"auth.own"'));
  const enBlock = CLIENT.slice(
    CLIENT.lastIndexOf('"run.title":'),
    CLIENT.lastIndexOf('"auth.own"'),
  );
  for (const key of keys) {
    assert.ok(zhBlock.includes(`"${key}"`), `zh 字典缺少 ${key}`);
    assert.ok(enBlock.includes(`"${key}"`), `en 字典缺少 ${key}`);
  }
});
