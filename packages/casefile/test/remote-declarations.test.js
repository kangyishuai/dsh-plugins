// @ts-check
// 防回归：service.js 的每个 public Remote 方法都必须有对应的 declareRemote 调用。
//
// 背景（2026-11-17，真实踩坑）：重构 service.js 时漏掉了
// `declareRemote(CasefileService, "listProjects")`，宿主日志无报错、插件看起来也激活了，
// 但 `/api/casefile/listProjects` 一直 404 —— 排查了 1 小时。
// 这个测试把「方法与声明一一对应」变成机器可查的事实。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SERVICE = join(import.meta.dirname, "..", "lib", "service.js");
const source = readFileSync(SERVICE, "utf8");

/** 类体内声明的 async 方法（排除构造函数与私有）。 */
const methodNames = [...source.matchAll(/^ {2}async ([A-Za-z][A-Za-z0-9]*)\(/gm)].map(
  (match) => match[1],
);

/** declareRemote(CasefileService, "name") 的名单。 */
const declaredNames = [
  ...source.matchAll(/declareRemote\(CasefileService, "([A-Za-z0-9]+)"\)/g),
].map((match) => match[1]);

test("service.js 里至少有一个 async 方法和一条声明（防止正则失配导致空跑）", () => {
  assert.ok(methodNames.length >= 5, `只匹配到 ${methodNames.length} 个方法`);
  assert.ok(declaredNames.length >= 5, `只匹配到 ${declaredNames.length} 条声明`);
});

test("每个 async 方法都有 declareRemote，且没有多余声明", () => {
  const methods = new Set(methodNames);
  const declared = new Set(declaredNames);
  const missing = [...methods].filter((name) => !declared.has(name));
  const extra = [...declared].filter((name) => !methods.has(name));
  assert.deepEqual(missing, [], `缺少 declareRemote：${missing.join("、")}`);
  assert.deepEqual(extra, [], `声明了不存在的方法：${extra.join("、")}`);
});

test("没有重复的 declareRemote（重复会让端点注册两次）", () => {
  const seen = new Set();
  const duplicates = [];
  for (const name of declaredNames) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  assert.deepEqual(duplicates, [], `重复声明：${duplicates.join("、")}`);
});
