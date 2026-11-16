// @ts-check
// 单元测试：core/brief.js（规格包 + 脱敏）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildSpecPack,
  redactPack,
  redactText,
  renderSpecMarkdown,
  writeSpecPack,
} from "../lib/core/brief.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const project = {
  id: "p",
  title: "Todo App",
  target: { kind: "web", ref: "https://example.test" },
  authTier: "research",
  scope: "selected",
  reaVersion: "6.9.0",
  capabilityHash: "abc",
};

const evidence = [
  {
    id: "ev1",
    kind: "har",
    sourceTool: "inspect_web_network_capture",
    observedAt: "2026-11-17T00:00:00.000Z",
    confidence: "observed",
    authority: "live-observation",
    limitations: ["只覆盖登录后的 3 个请求"],
    summary: "POST /api/todos 返回 201",
  },
  {
    id: "ev2",
    kind: "string",
    sourceTool: "x",
    confidence: "observed",
    authority: "external",
    summary: "无关证据",
  },
];

const claims = [
  {
    id: "c1",
    text: "新增待办走 POST /api/todos",
    kind: "har",
    status: "observed",
    limitations: [],
    evidenceIds: ["ev1"],
    featureIds: ["f1"],
    selected: true,
  },
  {
    id: "c2",
    text: "未选中的结论",
    kind: "other",
    status: "inferred",
    limitations: [],
    evidenceIds: ["ev2"],
    featureIds: [],
    selected: false,
  },
];

const features = [
  {
    id: "f1",
    name: "新增待办",
    summary: "只做新增",
    boundaries: ["不做删除"],
    nonGoals: ["不做批量"],
    status: "draft",
  },
];

const unknowns = [
  { id: "u1", text: "并发上限未知", severity: "high", status: "open" },
  { id: "u2", text: "已解决", severity: "low", status: "resolved" },
];

test("buildSpecPack 只包含选中的结论及其证据/功能/未知项", () => {
  const pack = buildSpecPack({ project, evidence, claims, features, unknowns });
  assert.equal(pack.claims.length, 1);
  assert.equal(pack.claims[0].id, "c1");
  assert.deepEqual(
    pack.evidence.map((/** @type {any} */ item) => item.id),
    ["ev1"],
  );
  assert.deepEqual(
    pack.features.map((/** @type {any} */ item) => item.id),
    ["f1"],
  );
  assert.deepEqual(
    pack.unknowns.map((/** @type {any} */ item) => item.id),
    ["u1"],
  );
  assert.equal(pack.coverage.selectedClaims, 1);
  assert.equal(pack.coverage.totalClaims, 2);
  assert.match(pack.integrity, /^[0-9a-f]{64}$/);
});

test("buildSpecPack 的 integrity 随内容变化", () => {
  const a = buildSpecPack({ project, evidence, claims, features, unknowns });
  const b = buildSpecPack({
    project: { ...project, title: "Other" },
    evidence,
    claims,
    features,
    unknowns,
  });
  assert.notEqual(a.integrity, b.integrity);
});

test("renderSpecMarkdown 带出处、局限与未知项", () => {
  const pack = buildSpecPack({ project, evidence, claims, features, unknowns });
  const md = renderSpecMarkdown(pack);
  assert.match(md, /# 规格包：Todo App/);
  assert.match(md, /新增待办走 POST \/api\/todos/);
  assert.match(md, /可信度：observed/);
  assert.match(md, /局限：只覆盖登录后的 3 个请求/);
  assert.match(md, /并发上限未知/);
  assert.match(md, /## 验收清单/);
});

test("redactText 去掉 home、绝对路径与 token", () => {
  const text =
    "读到 /Users/me/secret/app.bin 与 sk-abcdefghijklmnop1234 和 ghp_abcdefghijklmnopqrstu";
  const out = redactText(text, { home: "/Users/me" });
  assert.equal(out.includes("/Users/me"), false);
  assert.equal(out.includes("sk-abcdefghijklmnop1234"), false);
  assert.equal(out.includes("ghp_abcdefghijklmnopqrstu"), false);
  assert.match(out, /<path>/);
  assert.match(out, /\[redacted\]/);
});

test("redactPack 深拷贝且不改原对象", () => {
  const pack = buildSpecPack({ project, evidence, claims, features, unknowns });
  pack.evidence[0].refs = ["/Users/me/x.bin"];
  const redacted = redactPack(pack, { home: "/Users/me" });
  assert.equal(redacted.evidence[0].refs[0], "<path>");
  assert.equal(pack.evidence[0].refs[0], "/Users/me/x.bin");
});

test("writeSpecPack 落盘 spec.json 与 brief.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "casefile-brief-"));
  dirs.push(dir);
  const pack = buildSpecPack({ project, evidence, claims, features, unknowns });
  const written = writeSpecPack({ projectDir: dir, pack, redact: false });
  assert.equal(written.files.length, 2);
  const spec = JSON.parse(readFileSync(join(written.dir, "spec.json"), "utf8"));
  assert.equal(spec.claims.length, 1);
  assert.match(readFileSync(join(written.dir, "brief.md"), "utf8"), /# 规格包/);
});
