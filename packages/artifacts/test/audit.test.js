// @ts-check
// 审计日志纯函数单测（ADR 0002 §4 + 2026-11-23 复审 P1：并发不串号）。
// 这里只测"记录内容对不对"；串号本身由 notes/artifacts/audit-concurrency-harness.mjs 用真实
// service 类复现（仓库里解析不到宿主包，单测不能 import service.js）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAudit, formatAudit } from "../lib/audit.js";

test("成功：记录 action / dryRun / count / bytes / 已处理 id", () => {
  const record = describeAudit("remove", {
    ok: true,
    dryRun: false,
    count: 2,
    bytes: 30,
    ids: ["a", "b"],
    removed: ["a", "b"],
  });
  assert.equal(record.level, "info");
  assert.equal(record.action, "remove");
  assert.equal(record.code, null);
  assert.deepEqual(record.fields, {
    dryRun: false,
    count: 2,
    bytes: 30,
    processed: ["a", "b"],
  });
  assert.equal(formatAudit(record), "[artifacts] remove");
});

test("dry-run 成功也记 dryRun:true（审计能区分演练和真删）", () => {
  const record = describeAudit("purge", { ok: true, dryRun: true, count: 0, bytes: 0, ids: [] });
  assert.equal(record.level, "info");
  assert.equal(record.fields.dryRun, true);
});

test("失败：带契约层错误码，restore/purge 的已处理 key 也记进去", () => {
  const record = describeAudit("restore", {
    ok: false,
    code: "artifacts/failed",
    message: "EACCES: permission denied",
    dryRun: false,
    processed: ["k1"],
  });
  assert.equal(record.level, "warn");
  assert.equal(record.code, "artifacts/failed");
  assert.deepEqual(record.fields.processed, ["k1"]);
  assert.match(formatAudit(record), /failed \(artifacts\/failed\)/u);
});

test("契约层抛异常：没有信封也要有错误码与 message（供告警排查）", () => {
  const error = new Error("ENOSPC: no space left on device");
  const record = describeAudit("archive", undefined, error);
  assert.equal(record.level, "warn");
  assert.equal(record.code, "artifacts/failed");
  assert.equal(record.fields.message, "ENOSPC: no space left on device");
  assert.equal(record.fields.count, 0);
  assert.deepEqual(record.fields.processed, []);
});

test("带 code 的异常优先用它的 code（ArtifactError 语义）", () => {
  const error = Object.assign(new Error("unsafe artifact id: ../x"), { code: "artifacts/invalid" });
  const record = describeAudit("remove", undefined, error);
  assert.equal(record.code, "artifacts/invalid");
});

test("两个并发调用的记录互不影响（纯函数，无共享状态）", () => {
  const okRecord = describeAudit("remove", { ok: true, count: 1, bytes: 10, removed: ["fast"] });
  const failRecord = describeAudit("remove", undefined, new Error("EACCES"));
  assert.equal(okRecord.level, "info");
  assert.equal(failRecord.level, "warn");
  assert.deepEqual(okRecord.fields.processed, ["fast"]);
  assert.deepEqual(failRecord.fields.processed, []);
  assert.notEqual(okRecord.code, failRecord.code);
});
