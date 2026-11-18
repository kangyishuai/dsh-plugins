// @ts-check
// 单元测试：core/model.js 的规范化与校验。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CasefileInputError,
  ID_RE,
  normalizeClaim,
  normalizeEvidence,
  normalizeFeature,
  normalizeProjectInput,
  normalizeUnknown,
  projectStats,
  slugify,
} from "../lib/core/model.js";

test("slugify 生成 kebab-case", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  A/B Test  "), "a-b-test");
  assert.equal(slugify("中文标题"), `project-${""}`.slice(0, 8) + slugify("中文标题").slice(8));
  assert.match(slugify("中文"), ID_RE);
});

test("normalizeProjectInput 缺省值", () => {
  const project = normalizeProjectInput({ title: "Payments API" });
  assert.equal(project.id, "payments-api");
  assert.equal(project.authTier, "research");
  assert.equal(project.scope, "all");
  assert.equal(project.target.kind, "other");
});

test("normalizeProjectInput 拒绝非法授权档", () => {
  assert.throws(
    () => normalizeProjectInput({ title: "x", authTier: "commercial" }),
    (error) => error instanceof CasefileInputError && error.code === "invalid-input",
  );
});

test("normalizeEvidence 保留 REA 的 confidence/authority", () => {
  const evidence = normalizeEvidence({
    summary: "main() 调用 puts",
    confidence: "derived",
    authority: "live-observation",
    limitations: ["间接调用未解析"],
  });
  assert.equal(evidence.confidence, "derived");
  assert.equal(evidence.authority, "live-observation");
  assert.deepEqual(evidence.limitations, ["间接调用未解析"]);
  assert.match(evidence.id, ID_RE);
});

test("normalizeEvidence 拒绝未知 confidence", () => {
  assert.throws(() => normalizeEvidence({ summary: "x", confidence: "maybe" }), CasefileInputError);
});

test("normalizeClaim 默认未选中，可引用证据", () => {
  const evidence = normalizeEvidence({ summary: "x" });
  const claim = normalizeClaim({ text: "登录走 /auth/token", evidenceIds: [evidence.id] });
  assert.equal(claim.selected, false);
  assert.deepEqual(claim.evidenceIds, [evidence.id]);
});

test("normalizeClaim 拒绝非法 evidence id", () => {
  assert.throws(
    () => normalizeClaim({ text: "x", evidenceIds: ["../etc/passwd"] }),
    CasefileInputError,
  );
});

test("normalizeFeature / normalizeUnknown 基本字段", () => {
  const feature = normalizeFeature({ name: "登录", boundaries: ["只做密码登录"] });
  assert.equal(feature.status, "draft");
  assert.deepEqual(feature.boundaries, ["只做密码登录"]);
  const unknown = normalizeUnknown({ text: "刷新令牌有效期未知", severity: "high" });
  assert.equal(unknown.status, "open");
  assert.equal(unknown.severity, "high");
});

test("projectStats 统计选中结论与未解决未知项", () => {
  const project = {
    id: "p",
    title: "P",
    state: "investigating",
    authTier: "research",
    scope: "all",
    updatedAt: "t",
  };
  const stats = projectStats(project, {
    evidence: [{ id: "e1" }, { id: "e2" }],
    claims: [
      { id: "c1", selected: true },
      { id: "c2", selected: false },
    ],
    features: [{ id: "f1" }],
    unknowns: [
      { id: "u1", status: "open" },
      { id: "u2", status: "resolved" },
    ],
  });
  assert.equal(stats.evidence, 2);
  assert.equal(stats.selectedClaims, 1);
  assert.equal(stats.openUnknowns, 1);
});
