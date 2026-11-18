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
  // 无法拉丁化的标题会回落到 project-<时间戳>，因此**不能**比较两次调用的结果（跨毫秒会不等）
  const fallback = slugify("中文标题");
  assert.ok(fallback.startsWith("project-"), fallback);
  assert.match(fallback, ID_RE);
  const again = slugify("中文");
  assert.ok(again.startsWith("project-"), again);
  assert.match(again, ID_RE);
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

test("producer：记录外部生产者，且只接受已知 mode", () => {
  const ok = normalizeEvidence({
    summary: "外部工具抓的页面快照",
    producer: {
      tool: "scrapling/StealthyFetcher",
      version: "0.3.0",
      mode: "headful",
      outputKind: "html",
      accessConfirmedByUser: true,
      confirmationNote: "本人确认该站点允许我访问",
    },
  });
  assert.equal(ok.producer?.tool, "scrapling/StealthyFetcher");
  assert.equal(ok.producer?.mode, "headful");
  assert.equal(ok.producer?.accessConfirmedByUser, true);
  assert.match(String(ok.producer?.confirmationNote), /确认/u);

  assert.throws(
    () => normalizeEvidence({ summary: "x", producer: { mode: "telepathy" } }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
  assert.throws(
    () => normalizeEvidence({ summary: "x", producer: "scrapling" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
  assert.equal(normalizeEvidence({ summary: "x" }).producer, null);
});

test("producer：未声明用户确认时不会凭空补 true", () => {
  const evidence = normalizeEvidence({
    summary: "x",
    producer: { tool: "manual", mode: "manual", accessConfirmedByUser: false },
  });
  assert.equal(evidence.producer?.accessConfirmedByUser, undefined);
});
