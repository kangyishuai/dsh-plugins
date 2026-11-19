// @ts-check
// 机器可读证据包：确定性、自校验 integrity、脱敏、可被"只读 json"的消费者使用。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { BUNDLE_SCHEMA, buildBundle, canonicalize, digestOf } from "../lib/core/bundle.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-bundle-"));
  dirs.push(root);
  return {
    actions: createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root }),
    root,
  };
}

test("canonicalize：键排序、数组保序", () => {
  assert.equal(
    JSON.stringify(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] })),
    '{"a":[2,{"c":4,"d":3}],"b":1}',
  );
});

test("同输入两次组装字节一致（确定性）", () => {
  const input = {
    project: {
      id: "p",
      title: "T",
      authTier: "owned",
      scope: "selected",
      state: "closed",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    evidence: [{ id: "e1", observedAt: "2026-01-01T00:00:00.000Z" }],
    claims: [],
    obligations: [],
    checks: [],
    unknowns: [],
  };
  const a = JSON.stringify(buildBundle(input));
  const b = JSON.stringify(buildBundle(input));
  assert.equal(a, b);
});

test("generatedAt 取自数据本身，不随调用时间漂移", () => {
  const bundle = buildBundle({
    project: {
      id: "p",
      title: "T",
      authTier: "owned",
      scope: "all",
      state: "investigating",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    evidence: [{ id: "e1", observedAt: "2026-03-05T00:00:00.000Z" }],
    claims: [],
    obligations: [],
    checks: [],
    unknowns: [],
  });
  assert.equal(bundle.generatedAt, "2026-03-05T00:00:00.000Z");
});

test("integrity 可被接收方独立校验（去掉 integrity 后重算一致）", () => {
  const bundle = buildBundle({
    project: {
      id: "p",
      title: "T",
      authTier: "owned",
      scope: "all",
      state: "closed",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    evidence: [],
    claims: [],
    obligations: [],
    checks: [],
    unknowns: [],
  });
  const { integrity, ...body } = bundle;
  assert.equal(integrity.digest, digestOf(body));
  assert.equal(integrity.algorithm, "sha256");
  assert.equal(bundle.schema, BUNDLE_SCHEMA);
});

test("导出后 integrity 与文件内容一致，且同数据两次导出字节相同", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Bundle P" });
  await actions.addEvidence(project.id, { summary: "e", sourceTool: "t" });
  const first = await actions.exportBundle(project.id, {});
  const firstText = readFileSync(join(first.path, "bundle.json"), "utf8");

  const second = await actions.exportBundle(project.id, {});
  const secondText = readFileSync(join(second.path, "bundle.json"), "utf8");
  assert.equal(firstText, secondText, "同一数据两次导出必须字节一致");

  const parsed = JSON.parse(firstText);
  const { integrity, ...body } = parsed;
  assert.equal(integrity.digest, digestOf(body));
  assert.equal(first.integrity, second.integrity);
});

test("默认脱敏：本机路径被替换；redact:false 时保留", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Paths" });
  await actions.addEvidence(project.id, {
    summary: "看到 /Users/me/secret/file.bin 这个路径",
  });
  const redacted = await actions.exportBundle(project.id, {});
  const redactedText = readFileSync(join(redacted.path, "bundle.json"), "utf8");
  assert.equal(redactedText.includes("/Users/me/secret"), false);

  const raw = await actions.exportBundle(project.id, { redact: false });
  const rawText = readFileSync(join(raw.path, "bundle.json"), "utf8");
  assert.equal(rawText.includes("/Users/me/secret"), true);
});

test("artifact 清单按 sha256 排序且只含产物元信息", () => {
  const bundle = buildBundle({
    project: {
      id: "p",
      title: "T",
      authTier: "owned",
      scope: "all",
      state: "closed",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    evidence: [
      { id: "e1", artifact: { sha256: "bb", file: "artifacts/bb.html", bytes: 2 } },
      {
        id: "e2",
        artifact: { sha256: "aa", file: "artifacts/aa.html", bytes: 1, originalName: "x.html" },
      },
    ],
    claims: [],
    obligations: [],
    checks: [],
    unknowns: [],
  });
  assert.deepEqual(
    bundle.artifacts.map((/** @type {any} */ item) => item.sha256),
    ["aa", "bb"],
  );
  assert.equal(bundle.artifacts[0].originalName, "x.html");
});

test("义务可挂 claimIds，bundle 里能回答「哪条结论还没人验」", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Coverage P", scope: "selected" });
  const evidence = await actions.addEvidence(project.id, { summary: "e", sourceTool: "t" });
  const verified = await actions.addClaim(project.id, {
    text: "已验证的结论",
    evidenceIds: [evidence.id],
    kind: "structure",
    status: "observed",
  });
  const unverified = await actions.addClaim(project.id, {
    text: "还没人验的结论",
    evidenceIds: [evidence.id],
    kind: "structure",
    status: "observed",
  });
  await actions.addObligation(project.id, {
    statement: "验证结论 A",
    kind: "existence",
    claimIds: [verified.id],
  });
  const result = await actions.exportBundle(project.id, {});
  const bundle = JSON.parse(readFileSync(join(result.path, "bundle.json"), "utf8"));
  const covered = new Set(
    (bundle.obligations ?? []).flatMap((/** @type {any} */ item) => item.claimIds ?? []),
  );
  assert.equal(covered.has(verified.id), true);
  assert.equal(covered.has(unverified.id), false);
});
