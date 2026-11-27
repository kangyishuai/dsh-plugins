// @ts-check
// 宿主半文案的加载测试（审计 USIM-U2-15）。
//
// 宿主没有 locale 服务（docs/runtime/0.2.2-rc.5.md §8.1）：`commands.register()` 的
// `description` / `input.hint` 由宿主逐字透传，client 半的 `ctx.locale` 也翻译不了它。
// 所以 host 半必须自己读 `locale/<lang>.json`，把 `host.*` 段摊平成平面键再用。
// 参考 btw 0.6.1（`packages/btw/lib/messages.js`）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  FALLBACK,
  flattenMessages,
  HOST_KEYS,
  loadMessages,
  loadMessagesSync,
  mapMessages,
  pickLanguage,
} from "../lib/messages.js";

const LOCALE_DIR = join(import.meta.dirname, "..", "locale");

test("locale 文件的 host 段中英都有、非空、且不是对象", async () => {
  for (const language of ["zh", "en"]) {
    const raw = JSON.parse(await readFile(join(LOCALE_DIR, `${language}.json`), "utf8"));
    assert.ok(raw.host && typeof raw.host === "object", `${language}.json 缺少 host 段`);
    for (const path of /** @type {string[]} */ (Object.values(HOST_KEYS))) {
      assert.match(path, /^host\./u, "host 键必须落在 host 段里");
      const flat = flattenMessages(raw);
      const value = flat[path];
      assert.equal(typeof value, "string", `${language}.json 的 ${path} 不是字符串`);
      assert.ok(value.trim() !== "", `${language}.json 的 ${path} 为空`);
    }
  }
});

test("中英命令描述不同、都不含繁体「徵」", async () => {
  const zh = /** @type {Record<string, string>} */ (
    mapMessages(JSON.parse(await readFile(join(LOCALE_DIR, "zh.json"), "utf8")))
  );
  const en = /** @type {Record<string, string>} */ (
    mapMessages(JSON.parse(await readFile(join(LOCALE_DIR, "en.json"), "utf8")))
  );
  assert.match(zh.description, /顾问/u);
  assert.match(zh.description, /征询/u);
  assert.doesNotMatch(zh.description, /徵/u);
  assert.match(en.description, /advisor|Advisor/u);
  assert.notEqual(zh.description, en.description);
  // 斜杠菜单里只显示一行，描述不能太长（宿主的行宽约 40 半角字符）。
  assert.ok(zh.description.length <= 32, `中文描述过长：${zh.description}`);
  assert.ok(en.description.length <= 96, `英文描述过长：${en.description}`);
});

test("flattenMessages 摊平任意嵌套，只保留字符串叶子", () => {
  const flat = flattenMessages({ a: { b: { c: "x" } }, d: "y", e: 1, f: null });
  assert.deepEqual(flat, { "a.b.c": "x", d: "y" });
});

test("mapMessages 兼容已经是平面键的字典", () => {
  const mapped = mapMessages({
    "host.command.description": "征询顾问",
    "host.command.hint": "[status]",
    keep: "ignored",
  });
  assert.deepEqual(mapped, { description: "征询顾问", hint: "[status]" });
});

test("loadMessages / loadMessagesSync 结果一致且能回落到 FALLBACK 缺项", async () => {
  const sync = loadMessagesSync(LOCALE_DIR, "zh");
  const async_ = await loadMessages(LOCALE_DIR, "zh");
  assert.deepEqual(sync, async_);
  assert.equal(sync.description, async_.description);
  // 每个 HOST_KEYS 都在 FALLBACK 里有兜底键，否则缺翻译时注册会拿到 undefined。
  for (const key of /** @type {Array<"description" | "hint">} */ (Object.keys(HOST_KEYS))) {
    assert.equal(typeof FALLBACK[key], "string", `FALLBACK 缺少 ${key}`);
    assert.ok(FALLBACK[key] !== "");
  }
});

test("pickLanguage：显式配置 > 系统语言 > 英文", () => {
  assert.equal(pickLanguage("zh"), "zh");
  assert.equal(pickLanguage("en", { LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(pickLanguage(undefined, { LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(pickLanguage(undefined, { LC_ALL: "zh-Hans" }), "zh");
  assert.equal(pickLanguage(undefined, { LANGUAGE: "en_US" }), "en");
  assert.equal(pickLanguage("fr", { LANG: "zh_CN.UTF-8" }), "zh", "未知配置回落系统语言");
  assert.equal(pickLanguage(undefined, {}), "en");
});
