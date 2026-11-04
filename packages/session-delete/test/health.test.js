// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOperations } from "../lib/operations.js";

/**
 * @param {{ withList?: boolean }} [options]
 */
async function fixture(options = {}) {
  const withList = options.withList !== false;
  const dataRoot = await mkdtemp(join(tmpdir(), "dsh-health-"));
  await mkdir(join(dataRoot, "storages"), { recursive: true });
  await mkdir(join(dataRoot, "sessions", "--w--"), { recursive: true });
  // 已知会话在磁盘上；孤儿目录不在任何登记里
  await mkdir(join(dataRoot, "sessions", "--w--", "session-known"), { recursive: true });
  await mkdir(join(dataRoot, "sessions", "--w--", "session-orphan"), { recursive: true });
  await writeFile(
    join(dataRoot, "storages", "workspace.json"),
    JSON.stringify({
      unit: { name: "workspace", version: 2 },
      global: {
        workspaceIds: ["ws1"],
        archivedSessionIds: ["ghost-archived", "session-known"],
        pinnedSessionIds: ["ghost-pinned"],
      },
      tables: {
        workspaces: {
          ws1: { path: "/w", title: "w", sessionIds: ["session-known", "ghost-workspace"] },
        },
      },
    }),
  );
  // 回收站：有 meta、没 data
  await mkdir(join(dataRoot, "session-trash", "broken-entry"), { recursive: true });
  await writeFile(
    join(dataRoot, "session-trash", "broken-entry", "meta.json"),
    JSON.stringify({
      schema: 1,
      entryId: "broken-entry",
      sessionId: "session-broken",
      title: null,
      cwd: "/w",
      trashedAt: new Date().toISOString(),
      bytes: 1,
      live: false,
      children: [],
      workspaceIds: [],
      pinned: null,
      originPath: join(dataRoot, "sessions", "--w--", "session-broken"),
      plugin: "@kangyishuai/dsh-session-delete",
    }),
  );

  const state = {
    detached: /** @type {string[]} */ ([]),
    unarchived: /** @type {string[]} */ ([]),
    unpinned: /** @type {string[]} */ ([]),
  };
  const workspace = {
    list: () => [
      {
        id: "ws1",
        sessionIds: ["session-known", "ghost-workspace"],
        detachSession: async (/** @type {string} */ id) => {
          state.detached.push(id);
        },
      },
    ],
    archiveSession: async () => {},
    unarchiveSession: async (/** @type {string} */ id) => {
      state.unarchived.push(id);
    },
    pinSession: async () => {},
    unpinSession: async (/** @type {string} */ id) => {
      state.unpinned.push(id);
    },
  };
  const persistence = {
    stat: async () => undefined,
    locate: () => undefined,
    list: async () => [{ id: "session-known", header: { id: "session-known" } }],
  };
  const sessions = {
    get: () => undefined,
    flush: async () => {},
    store: new Map([["session-live", {}]]),
  };
  /** @type {Record<string, any>} */
  const services = {
    sessionPersistence: withList ? persistence : { stat: persistence.stat },
    sessions,
    workspaceRegistry: workspace,
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (/** @type {string} */ name) => services[name],
    parallel: async () => {},
    waterfall: async () => [],
  };
  const ops = createOperations({ ctx, dataRoot, logger: ctx.logger });
  return { dataRoot, ops, state };
}

test("体检找出归档/置顶/工作区记账/回收站四类失效引用", async () => {
  const { dataRoot, ops } = await fixture();
  const report = await ops.scanHealth();
  assert.equal(report.ok, true);
  const inventory = report.inventory ?? { stored: 0, live: 0 };
  assert.equal(inventory.stored, 1);
  assert.equal(inventory.live, 1);
  const ids = report.findings.map((/** @type {any} */ f) => f.id);
  assert.ok(ids.includes("archived-ghost"));
  assert.ok(ids.includes("pinned-ghost"));
  assert.ok(ids.includes("workspace-ghost"));
  assert.ok(ids.includes("trash-inconsistent"));
  assert.ok(ids.includes("orphan-session-dir"));
  // 已知会话不能被误报
  const archived = report.findings.find((/** @type {any} */ f) => f.id === "archived-ghost");
  assert.deepEqual(archived?.items, ["ghost-archived"]);
  assert.equal(report.cleanable?.total, 3);
  await rm(dataRoot, { recursive: true, force: true });
});

test("清理只动登记表，并写审计", async () => {
  const { dataRoot, ops, state } = await fixture();
  const result = await ops.cleanHealth();
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.deepEqual(state.unarchived, ["ghost-archived"]);
  assert.deepEqual(state.unpinned, ["ghost-pinned"]);
  assert.deepEqual(state.detached, ["ghost-workspace"]);
  const audit = await ops.auditLog(10);
  assert.ok(audit.entries.some((entry) => entry.action === "health"));
  await rm(dataRoot, { recursive: true, force: true });
});

test("宿主没有 list 时体检明确不可用，而不是假装健康", async () => {
  const { dataRoot, ops } = await fixture({ withList: false });
  const report = await ops.scanHealth();
  assert.equal(report.ok, false);
  assert.match(String(report.reason), /list/);
  await assert.rejects(ops.cleanHealth(), /无法体检|health-unavailable/);
  await rm(dataRoot, { recursive: true, force: true });
});
