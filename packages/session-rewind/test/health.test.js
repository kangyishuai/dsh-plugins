// @ts-check
// health.js 的单测（USIM-U3-06 / AUD-REW-16）：诊断计数如实、文案键可本地化。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHealth, HEALTH_AUDIT_READ_LIMIT, sessionHealthFacts } from "../lib/health.js";

/**
 * 假 store：usage + readAudit（按真实行数返回）。
 * @param {{auditRecords?: any[], entries?: number, sessions?: number, blobs?: number}} [options]
 */
function storeOf(options = {}) {
  const auditRecords = options.auditRecords ?? [];
  return {
    usage: async () => ({
      bytes: 1234,
      entries: options.entries ?? 0,
      sessions: options.sessions ?? 0,
      blobs: options.blobs ?? 0,
    }),
    /** @param {{limit?: number}} [request] */
    readAudit: async (request = {}) => {
      const limit = typeof request.limit === "number" ? request.limit : 100;
      return auditRecords.slice(0, limit);
    },
  };
}

/** 空孤儿报告。 */
const noOrphans = async () => ({
  sessionIds: [],
  trashIds: [],
  rescueIds: [],
  bytes: 0,
  unknownIds: [],
  unknownWorkspaces: [],
  unreadableWorkspaces: 0,
  incomplete: false,
  enumerationFailed: false,
});

test("buildHealth: 审计条数按真实行数统计（不再恒为 1，USIM-U3-06）", async () => {
  const auditRecords = [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4" }];
  const health = await buildHealth({
    dataRoot: "/tmp/d",
    trackingEnabled: true,
    store: storeOf({ auditRecords }),
    findOrphans: noOrphans,
    config: {},
    readOnlyToolInstalled: true,
  });
  const audit = health.checks.find((check) => check.nameKey === "health.audit");
  assert.ok(audit, "audit check missing");
  assert.equal(audit.ok, true);
  assert.equal(audit.detailKey, "health.auditRecords");
  assert.equal(audit.detailParams?.count, 4);
  assert.match(audit.detail, /^4 record/u);
});

test("buildHealth: 超过读取上限时如实说「至少 N 条」", async () => {
  const auditRecords = Array.from({ length: HEALTH_AUDIT_READ_LIMIT }, (_, index) => ({
    id: `a-${index}`,
  }));
  const health = await buildHealth({
    dataRoot: "/tmp/d",
    trackingEnabled: false,
    store: storeOf({ auditRecords }),
    findOrphans: noOrphans,
    config: {},
    readOnlyToolInstalled: false,
  });
  const audit = health.checks.find((check) => check.nameKey === "health.audit");
  assert.equal(audit?.detailKey, "health.auditRecordsAtLeast");
  assert.equal(audit?.detailParams?.count, HEALTH_AUDIT_READ_LIMIT);
  const tracking = health.checks.find((check) => check.nameKey === "health.tracking");
  assert.equal(tracking?.detailKey, "health.disabled");
  const tool = health.checks.find((check) => check.nameKey === "health.readOnlyTool");
  assert.equal(tool?.ok, false);
  assert.equal(tool?.detailKey, "health.notRegistered");
});

test("buildHealth: usage 透传（chat-only 回退时 entries/sessions 为 0 是事实）", async () => {
  const health = await buildHealth({
    dataRoot: "/tmp/d",
    trackingEnabled: true,
    store: storeOf({ entries: 0, sessions: 0, blobs: 4 }),
    findOrphans: noOrphans,
    config: {},
    readOnlyToolInstalled: true,
  });
  const storage = health.checks.find((check) => check.nameKey === "health.storage");
  assert.equal(storage?.detailKey, "health.storageLine");
  assert.deepEqual(storage?.detailParams, { bytes: 1234, entries: 0, sessions: 0 });
  assert.deepEqual(health.usage, { bytes: 1234, entries: 0, sessions: 0, blobs: 4 });
});

test("buildHealth: 孤儿枚举失败/成功两种 detailKey 与计数", async () => {
  const failed = await buildHealth({
    dataRoot: "/tmp/d",
    trackingEnabled: true,
    store: storeOf(),
    findOrphans: async () => ({
      ...(await noOrphans()),
      enumerationFailed: true,
      unreadableWorkspaces: 2,
      unknownWorkspaces: ["ws-x"],
      unknownIds: [{ id: "x" }, { id: "y" }],
    }),
    config: {},
    readOnlyToolInstalled: true,
  });
  const orphanFailed = failed.checks.find((check) => check.nameKey === "health.orphans");
  assert.equal(orphanFailed?.ok, false);
  assert.equal(orphanFailed?.detailKey, "health.orphansSkipped");
  assert.deepEqual(orphanFailed?.detailParams, {
    workspaces: 2,
    unknownLayout: 1,
    kept: 2,
  });

  const ok = await buildHealth({
    dataRoot: "/tmp/d",
    trackingEnabled: true,
    store: storeOf(),
    findOrphans: async () => ({ ...(await noOrphans()), bytes: 512 }),
    config: {},
    readOnlyToolInstalled: true,
  });
  const orphanOk = ok.checks.find((check) => check.nameKey === "health.orphans");
  assert.equal(orphanOk?.detailKey, "health.orphansNone");
  assert.equal(orphanOk?.detailParams?.count, 0);
});

test("buildHealth: 会话检查由 service 注入（marker 形状 + cwd）", async () => {
  const health = await buildHealth({
    dataRoot: "/tmp/d",
    trackingEnabled: true,
    store: storeOf(),
    findOrphans: noOrphans,
    config: {},
    readOnlyToolInstalled: true,
    sessionId: "s1",
    sessionCheck: () =>
      sessionHealthFacts(
        [
          { seq: 1, type: "user/message", data: { source: { kind: "user" } } },
          {
            seq: 2,
            type: "user/message",
            data: { source: { kind: "session-rewind", targetSeq: 1 } },
          },
        ],
        "/tmp/work",
      ),
  });
  const shape = health.checks.find((check) => check.nameKey === "health.markerShape");
  assert.equal(shape?.ok, true);
  assert.deepEqual(shape?.detailParams, { count: 1 });
  const cwd = health.checks.find((check) => check.nameKey === "health.sessionCwd");
  assert.equal(cwd?.ok, true);
  assert.equal(cwd?.detail, "/tmp/work");
});
