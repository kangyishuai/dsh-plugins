// @ts-check
// 外部报告摄入：契约校验、下标映射、只记录不背书、产物归档、dryRun。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { describeIngestSchema, INGEST_VERSION, validateIngestPayload } from "../lib/core/ingest.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-ingest-"));
  dirs.push(root);
  return {
    actions: createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root }),
    root,
  };
}

const PAYLOAD = {
  source: {
    tool: "craft/analyzer",
    version: "1.2.0",
    mode: "archive",
    producedAt: "2026-11-19T00:00:00.000Z",
  },
  evidence: [
    { summary: "报告里说主入口在 0x1000", kind: "structure", limitations: ["未在真机验证"] },
    { summary: "报告里列出 3 个网络端点", kind: "string", refs: ["https://example.invalid/"] },
  ],
  claims: [
    { text: "主入口位于二进制前 4KB", kind: "structure", status: "observed", evidenceIds: [0] },
    { text: "存在三条对外端点", kind: "structure", status: "derived", evidenceIds: [1, 1] },
  ],
  unknowns: [{ text: "端点是否仍启用未知", severity: "medium" }],
};

test("validateIngestPayload：默认值与契约版本", () => {
  const result = validateIngestPayload(PAYLOAD);
  assert.equal(result.version, INGEST_VERSION);
  assert.equal(result.source.tool, "craft/analyzer");
  assert.equal(result.evidence[0].authority, "external");
  assert.deepEqual(result.claims[1].evidenceIndexes, [1], "重复下标应去重");
});

test("validateIngestPayload：evidenceIds 越界直接报错（不静默丢引用）", () => {
  const bad = { ...PAYLOAD, claims: [{ text: "x", evidenceIds: [5] }] };
  assert.throws(
    () => validateIngestPayload(bad),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("validateIngestPayload：缺 source.tool 报错", () => {
  assert.throws(
    () => validateIngestPayload({ ...PAYLOAD, source: { mode: "archive" } }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("validateIngestPayload：不支持的版本被拒", () => {
  assert.throws(
    () => validateIngestPayload({ ...PAYLOAD, version: 99 }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("ingestReport：写入证据/结论/未知项，producer 固定外部来源且不背书", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Ingest", authTier: "research" });
  const result = await actions.ingestReport(project.id, PAYLOAD);
  assert.equal(result.evidenceIds.length, 2);
  assert.equal(result.claimIds.length, 2);
  assert.equal(result.unknownIds.length, 1);

  const detail = await actions.detail(project.id);
  assert.equal(detail.evidence.length, 2);
  assert.equal(detail.evidence[0].authority, "external");
  assert.equal(detail.evidence[0].producer.tool, "craft/analyzer");
  assert.equal(detail.evidence[0].producer.mode, "archive");
  assert.match(String(detail.evidence[0].producer.confirmationNote), /不背书/u);
  // 结论引用了对应证据
  const claim = detail.claims.find((/** @type {any} */ item) => item.text.includes("主入口"));
  assert.deepEqual(claim?.evidenceIds, [result.evidenceIds[0]]);
  // 未知项原样保留严重度
  assert.equal(detail.unknowns[0].severity, "medium");

  const audit = await actions.readAudit(project.id);
  assert.ok(audit.some((entry) => entry.action === "ingest/external-report"));
});

test("ingestReport：reportPath 会被归档（可复算）", async () => {
  const { actions, root } = makeActions();
  const project = await actions.openProject({ title: "Ingest Artifact" });
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, JSON.stringify({ any: "content" }), "utf8");
  const result = await actions.ingestReport(project.id, {
    ...PAYLOAD,
    source: { ...PAYLOAD.source, reportPath },
  });
  assert.match(String(result.artifact?.file), /^artifacts\//u);
  assert.match(String(result.artifact?.sha256), /^[a-f0-9]{64}$/u);
  const detail = await actions.detail(project.id);
  assert.equal(detail.evidence[0].artifact.sha256, result.artifact.sha256);
});

test("ingestReport dryRun：只预演不写盘", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Ingest Dry" });
  const result = await actions.ingestReport(project.id, PAYLOAD, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldCreate.evidence, 2);
  const detail = await actions.detail(project.id);
  assert.equal(detail.evidence.length, 0);
  assert.equal(detail.claims.length, 0);
});

test("describeIngestSchema：给出形状与三条规则（供其他 agent 读）", () => {
  const schema = describeIngestSchema();
  assert.equal(schema.version, INGEST_VERSION);
  assert.ok(Array.isArray(schema.rules) && schema.rules.length >= 3);
  assert.ok(schema.shape.claims[0].evidenceIds);
});

// ---------- Craft 适配器（按官方文档字段映射；本机未装 Craft，未用真实样例验证）----------

test("looksLikeCraftReport：只有「证据账本」形状才被识别", async () => {
  const { looksLikeCraftReport } = await import("../lib/core/ingest-craft.js");
  assert.equal(
    looksLikeCraftReport({ evidence: [{ operation: "disasm.functions", subject: { name: "x" } }] }),
    true,
  );
  assert.equal(looksLikeCraftReport({ evidence: [{ summary: "普通证据" }] }), false);
  assert.equal(looksLikeCraftReport(PAYLOAD), false, "已符合契约的 payload 不会被误判");
});

test("mapCraftReport：operation → kind、limitations 保留并注明未复核、locations → refs", async () => {
  const { mapCraftReport } = await import("../lib/core/ingest-craft.js");
  const mapped = mapCraftReport({
    version: "0.4.0",
    generatedAt: "2026-11-19T00:00:00.000Z",
    evidence: [
      {
        operation: "disasm.functions",
        subject: { name: "Bob" },
        result: { count: 70044 },
        limitations: ["未执行目标"],
        locations: [{ path: "/Applications/Bob.app/Contents/MacOS/Bob" }],
      },
      {
        operation: "capture.network",
        subject: { id: "t1" },
        result: "3 requests",
        limitations: [],
        locations: [],
      },
    ],
    unknowns: [{ text: "端点是否启用未确认", severity: "medium" }],
  });
  assert.equal(mapped.evidence.length, 2);
  assert.equal(mapped.evidence[0].kind, "structure");
  assert.equal(mapped.evidence[1].kind, "har", "capture.network 必须映射成模型允许的 har");
  assert.equal(mapped.evidence[0].refs.length, 1);
  assert.match(String(mapped.evidence[0].limitations.at(-1)), /未复核/u);
  assert.equal(mapped.unknowns[0].severity, "medium");
  assert.equal(mapped.source.tool, "craft-anything");
});

test("ingestReport：传 Craft 形状会自动映射后摄入（producer 仍是外部来源）", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Craft Adapter", authTier: "research" });
  const result = await actions.ingestReport(project.id, {
    version: "0.4.0",
    evidence: [
      {
        operation: "triage.first_look",
        subject: { name: "sample.bin" },
        result: { format: "pe" },
        limitations: ["clean-room 模式"],
        locations: [],
      },
    ],
    unknowns: [{ text: "未取深层探针", severity: "low" }],
  });
  assert.equal(result.evidenceIds.length, 1);
  assert.equal(result.source.tool, "craft-anything");
  const detail = await actions.detail(project.id);
  assert.equal(detail.evidence[0].producer.tool, "craft-anything");
  assert.match(String(detail.evidence[0].producer.confirmationNote), /不背书/u);
});

test("适配器产出的 kind 必须被模型接受（真机踩到的枚举错配）", async () => {
  const { mapCraftReport } = await import("../lib/core/ingest-craft.js");
  const { validateIngestPayload } = await import("../lib/core/ingest.js");
  const { normalizeEvidence } = await import("../lib/core/model.js");

  // 覆盖适配器可能产出的所有 operation 家族，逐个过契约校验 + 模型校验。
  const operations = [
    "disasm.functions",
    "analysis.triage",
    "parse.elf",
    "string.scan",
    "js.bundle",
    "capture.network",
    "screenshot.page",
    "plist.read",
    "signature.read",
    "entitlements.read",
    "unknown.op",
  ];
  const mapped = mapCraftReport({
    evidence: operations.map((operation) => ({
      operation,
      subject: { name: "x" },
      result: {},
      limitations: [],
      locations: [],
    })),
  });
  const normalized = validateIngestPayload(mapped);
  for (const item of normalized.evidence) {
    // 这一步会抛错，如果 kind 不在 model 的枚举里
    const record = normalizeEvidence({
      summary: item.summary,
      kind: item.kind,
      authority: item.authority,
      confidence: "observed",
      limitations: item.limitations,
      refs: item.refs,
    });
    assert.equal(typeof record.kind, "string");
  }
});
