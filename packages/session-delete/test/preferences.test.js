// @ts-check
// 界面偏好的持久化：原子写、坏文件回落、版本兼容、字段白名单。
// 这一层的失败模式必须全是「静默回落默认值」——偏好不能阻断一次删除。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  preferencesPath,
  readPreferences,
  writePreferences,
} from "../lib/preferences.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "dsh-prefs-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("首次使用读到默认值，不创建文件", async () => {
  const { root, dispose } = await workspace();
  const loaded = await readPreferences(root);
  assert.deepEqual(loaded, { version: 1, cascadeChildren: false });
  assert.deepEqual(loaded, { ...DEFAULT_PREFERENCES });
  await assert.rejects(readFile(preferencesPath(root), "utf8"), /ENOENT/);
  await dispose();
});

test("写入后回读保持，写入是原子替换（不残留 .tmp）", async () => {
  const { root, dispose } = await workspace();
  const saved = await writePreferences(root, { cascadeChildren: true });
  assert.equal(saved.cascadeChildren, true);
  assert.equal((await readPreferences(root)).cascadeChildren, true);
  const file = preferencesPath(root);
  assert.ok(file.endsWith(join("session-trash", "preferences.json")));
  const raw = await readFile(file, "utf8");
  assert.match(raw, /"cascadeChildren": true/);
  await assert.rejects(readFile(`${file}.tmp`, "utf8"), /ENOENT/);
  await dispose();
});

test("坏 JSON 与坏字段都静默回落默认值，并告警", async () => {
  const { root, dispose } = await workspace();
  const file = preferencesPath(root);
  await mkdir(join(root, "session-trash"), { recursive: true });
  /** @type {string[]} */
  const warnings = [];
  const logger = { warn: (/** @type {string} */ message) => warnings.push(message) };

  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual(await readPreferences(root, logger), { version: 1, cascadeChildren: false });
  assert.equal(warnings.length, 1);

  await writeFile(file, JSON.stringify({ version: 1, cascadeChildren: "yes" }), "utf8");
  assert.equal((await readPreferences(root, logger)).cascadeChildren, false);

  await writeFile(file, JSON.stringify({ version: 99, cascadeChildren: true }), "utf8");
  assert.equal(
    (await readPreferences(root, logger)).cascadeChildren,
    false,
    "a future version must not be trusted",
  );
  await dispose();
});

test("补丁只接受已知字段，未提供的字段保持原值", async () => {
  const { root, dispose } = await workspace();
  await writePreferences(root, { cascadeChildren: true });
  const after = await writePreferences(root, { unrelated: "ignored" });
  assert.equal(after.cascadeChildren, true);
  const cleared = await writePreferences(root, { cascadeChildren: false });
  assert.equal(cleared.cascadeChildren, false);
  await dispose();
});

test("normalizePreferences 只认显式 true", () => {
  assert.equal(normalizePreferences({ cascadeChildren: true }).cascadeChildren, true);
  for (const value of [null, undefined, {}, { cascadeChildren: 1 }, { cascadeChildren: "true" }]) {
    assert.equal(normalizePreferences(value).cascadeChildren, false);
  }
  assert.equal(normalizePreferences({ version: 2, cascadeChildren: true }).cascadeChildren, false);
});
