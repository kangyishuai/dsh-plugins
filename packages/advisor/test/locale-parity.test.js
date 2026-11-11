// @ts-check
// client 半的 t() 只认内嵌字典（classic script 不能 import JSON），而 locale/*.json 同时承担
// 「给人看的清单」和宿主侧文案。两处漂移的后果很具体：界面直接显示 `settings.preview.run`
// 这样的原始 key（真机踩过）。这里用文本扫描守住一致性，防止再犯。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

/** @param {"zh"|"en"} lang */
async function localeKeys(lang) {
  const raw = JSON.parse(await readFile(join(ROOT, "locale", `${lang}.json`), "utf8"));
  return new Set(Object.keys(raw.advisor ?? {}));
}

/**
 * 从 client.js 里抽出内嵌字典的键（`"key":` 与未加引号的 `key:` 两种写法都认）。
 * 只扫字典区域，避免把文件里其它对象的字段名当成文案。
 */
async function embeddedKeys() {
  const source = await readFile(join(ROOT, "lib", "client.js"), "utf8");
  /** @type {Set<string>} */
  const keys = new Set();
  for (const marker of ["let zh = {", "let en = {", "const LOCALE_EXTRA = {"]) {
    const start = source.indexOf(marker);
    if (start < 0) continue;
    let depth = 0;
    let end = start;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    const block = source.slice(start, end + 1);
    for (const match of block.matchAll(/(?:"([A-Za-z0-9_.]+)"|([A-Za-z][A-Za-z0-9_.]*))\s*:/gu)) {
      keys.add(match[1] ?? match[2]);
    }
  }
  return keys;
}

test("client 内嵌字典覆盖 locale/zh.json 的全部 key（否则界面显示原始 key）", async () => {
  const expected = await localeKeys("zh");
  const embedded = await embeddedKeys();
  const missing = [...expected].filter((key) => !embedded.has(key));
  assert.deepEqual(missing, [], `client.js 缺少这些文案：${missing.join(", ")}`);
});

test("client 内嵌字典覆盖 locale/en.json 的全部 key", async () => {
  const expected = await localeKeys("en");
  const embedded = await embeddedKeys();
  const missing = [...expected].filter((key) => !embedded.has(key));
  assert.deepEqual(missing, [], `client.js 缺少这些文案：${missing.join(", ")}`);
});

test("两个 locale 文件的 key 集完全一致", async () => {
  const zh = [...(await localeKeys("zh"))].sort();
  const en = [...(await localeKeys("en"))].sort();
  assert.deepEqual(zh, en);
});
