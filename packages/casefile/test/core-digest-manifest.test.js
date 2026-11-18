// @ts-check
// 单元测试：core/digest.js 与 core/manifest.js。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { hashTree, listFiles, sameDigest, sha256Text, shortDigest } from "../lib/core/digest.js";
import {
  bareReaToolNames,
  diffCapabilities,
  gradeCapabilities,
  isReaTool,
  REA_TOOL_PREFIX,
  REQUIRED_REA_TOOLS,
} from "../lib/core/manifest.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("hashTree 对同样内容稳定、对内容变化敏感", () => {
  const root = mkdtempSync(join(tmpdir(), "casefile-digest-"));
  dirs.push(root);
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a", "x.txt"), "hello");
  writeFileSync(join(root, "b.txt"), "world");
  const first = hashTree(root);
  const second = hashTree(root);
  assert.equal(first.digest, second.digest);
  assert.equal(first.files, 2);
  writeFileSync(join(root, "a", "x.txt"), "hello!");
  assert.notEqual(hashTree(root).digest, first.digest);
});

test("hashTree 忽略 node_modules / .git 等目录", () => {
  const root = mkdtempSync(join(tmpdir(), "casefile-digest-ignore-"));
  dirs.push(root);
  writeFileSync(join(root, "keep.txt"), "1");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "x.js"), "2");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "3");
  const files = listFiles(root);
  assert.deepEqual(files, ["keep.txt"]);
});

test("sameDigest / shortDigest", () => {
  assert.equal(sameDigest("abc", "abc"), true);
  assert.equal(sameDigest("abc", "abd"), false);
  assert.equal(sameDigest(null, null), false);
  assert.equal(shortDigest("0123456789abcdef"), "0123456789ab");
  assert.equal(shortDigest(null), "—");
  assert.match(sha256Text("x"), /^[0-9a-f]{64}$/);
});

test("REA 工具名前缀与裸名", () => {
  assert.equal(REA_TOOL_PREFIX, "mcp__rea__");
  assert.equal(isReaTool("mcp__rea__open_binary"), true);
  assert.equal(isReaTool("mcp__craft__open"), false);
  assert.deepEqual(bareReaToolNames(["mcp__rea__b", "x", "mcp__rea__a"]), ["a", "b"]);
});

test("diffCapabilities 区分必备/可选缺失", () => {
  const all = [...REQUIRED_REA_TOOLS].map((name) => `mcp__rea__${name}`);
  const diff = diffCapabilities(all);
  assert.equal(diff.missingRequired.length, 0);
  assert.ok(diff.missingOptional.length > 0);
  assert.equal(diff.availableReaTools, all.length);
  assert.match(diff.capabilityHash, /^[0-9a-f]{32}$/);
  assert.equal(gradeCapabilities(diff).level, "degraded");
  assert.equal(gradeCapabilities(diff).ok, true);
});

test("gradeCapabilities：完全没有 REA 时 ok=false", () => {
  const diff = diffCapabilities([]);
  const grade = gradeCapabilities(diff);
  assert.equal(grade.ok, false);
  assert.equal(grade.level, "missing");
  assert.match(grade.message, /mcp__rea__/);
});
