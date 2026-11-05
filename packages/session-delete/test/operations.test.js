// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOperations } from "../lib/operations.js";
import { encodeSegment, projectKey } from "../lib/paths.js";

/**
 * 造一个「像宿主」的最小替身。
 * @param {{ live?: boolean, createDir?: boolean, children?: { id: string, title: string | null }[] }} [options]
 */
async function fixture(options = {}) {
  const { live = false, createDir = true, children = [] } = options;
  const dataRoot = await mkdtemp(join(tmpdir(), "dsh-sdel-ops-"));
  const sessionId = "session-abc";
  const cwd = "/w";
  const sessionDir = join(dataRoot, "sessions", projectKey(cwd), encodeSegment(sessionId));
  if (createDir) {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "x".repeat(4096));
  }

  const state = {
    archived: false,
    pinned: false,
    sessionIds: new Set([sessionId]),
    flushed: 0,
    stopped: 0,
    detached: 0,
  };

  const workspace = {
    list: () => [
      {
        id: "ws1",
        sessionIds: [...state.sessionIds],
        detachSession: async (/** @type {string} */ id) => {
          state.sessionIds.delete(id);
          state.detached += 1;
        },
        attachSession: async (/** @type {string} */ id) => {
          state.sessionIds.add(id);
        },
      },
    ],
    archiveSession: async () => {
      state.archived = true;
    },
    unarchiveSession: async () => {
      state.archived = false;
    },
    pinSession: async () => {
      state.pinned = true;
    },
    unpinSession: async () => {
      state.pinned = false;
    },
  };

  const persistence = {
    stat: async (/** @type {string} */ id) => {
      if (id === sessionId) {
        return { header: { id: sessionId, title: "hello", cwd }, sizeBytes: 4096 };
      }
      const child = children.find((/** @type {any} */ item) => item.id === id);
      if (child) {
        return {
          header: { id, title: child.title, cwd, parentSession: sessionId },
          sizeBytes: 128,
        };
      }
      return undefined;
    },
    list: async () => [
      { id: sessionId, header: { id: sessionId, title: "hello", cwd } },
      ...children.map((/** @type {any} */ child) => ({
        id: child.id,
        header: { id: child.id, title: child.title, cwd, parentSession: sessionId },
      })),
    ],
  };
  const liveEntry = live ? { header: { id: sessionId, cwd } } : undefined;
  const sessions = {
    get: (/** @type {string} */ id) => (id === sessionId ? liveEntry : undefined),
    flush: async () => {
      state.flushed += 1;
    },
  };

  /** @type {Record<string, any>} */
  const services = { sessionPersistence: persistence, sessions, workspaceRegistry: workspace };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (/** @type {string} */ name) => services[name],
    parallel: async () => {
      state.stopped += 1;
    },
    waterfall: async () => [{ kind: "subagent", items: [{ id: "child-1", label: "子代理一" }] }],
  };

  const childDirs = [];
  for (const child of children) {
    const dir = join(dataRoot, "sessions", projectKey(cwd), encodeSegment(child.id));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.v4.jsonl.zstd"), "y".repeat(64));
    childDirs.push(dir);
  }

  const ops = createOperations({ ctx, dataRoot, logger: ctx.logger });
  return { dataRoot, sessionId, sessionDir, childDirs, state, ops, ctx };
}

test("plan 汇总体积、活动、子会话与引用清单", async () => {
  const { ops, sessionId, dataRoot } = await fixture();
  const plan = await ops.plan(sessionId);
  assert.equal(plan.sessionId, sessionId);
  assert.equal(plan.sizeBytes, 4096);
  assert.equal(plan.children.length, 1);
  assert.equal(plan.children[0].id, "child-1");
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.activity.length, 1);
  assert.ok(plan.removes.length >= 4);
  assert.ok(plan.location);
  await rm(dataRoot, { recursive: true, force: true });
});

test("plan 对不存在的会话报 not-found", async () => {
  const { ops, dataRoot } = await fixture();
  await assert.rejects(ops.plan("session-missing"), /no session named/);
  await rm(dataRoot, { recursive: true, force: true });
});

test("trash：归档 → 停止 → 落盘 → 移动 → 摘引用，并留下审计与回执", async () => {
  const { ops, sessionId, sessionDir, state, dataRoot } = await fixture();
  const plan = await ops.plan(sessionId);
  const result = await ops.trash(sessionId, { digest: plan.digest });
  assert.equal(result.ok, true);
  assert.ok(result.entryId);
  assert.ok(result.receiptId);
  assert.equal(result.sessionId, sessionId);
  // 归档只是闸门：摘引用阶段会把归档标记再清掉，所以最终 archived 为 false
  assert.equal(state.archived, false);
  assert.equal(state.detached, 1);
  assert.equal(state.stopped, 1);
  // 冷会话没有 live 句柄，不应触发 flush
  assert.equal(state.flushed, 0);
  assert.equal(state.sessionIds.size, 0);
  await assert.rejects(stat(sessionDir));

  const listed = await ops.list();
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].sessionId, sessionId);

  const audit = await ops.auditLog(10);
  assert.ok(audit.entries.some((e) => e.action === "trash" && e.result === "ok"));

  const checks = await ops.reconcile(sessionId);
  assert.ok(checks.every((c) => c.status !== "failed"));

  const receipts = await ops.receipts(10);
  assert.ok(
    receipts.entries.some((entry) => entry.action === "trash" && entry.entryId === result.entryId),
  );
  await rm(dataRoot, { recursive: true, force: true });
});

test("trash：digest 漂移时拒绝执行", async () => {
  const { ops, sessionId, dataRoot } = await fixture();
  await assert.rejects(
    ops.trash(sessionId, { digest: "deadbeef" }),
    (error) => /** @type {any} */ (error).code === "session-delete/stale-plan",
  );
  await rm(dataRoot, { recursive: true, force: true });
});

test("trash：找不到目录时按 blocked 拒绝，且不改动任何状态", async () => {
  const { ops, sessionId, state, dataRoot } = await fixture({ createDir: false });
  const plan = await ops.plan(sessionId);
  assert.ok(plan.blockers.some((b) => b.code === "session-delete/location-unknown"));
  await assert.rejects(
    ops.trash(sessionId, { digest: plan.digest }),
    (error) => /** @type {any} */ (error).code === "session-delete/blocked",
  );
  assert.equal(state.archived, false);
  await rm(dataRoot, { recursive: true, force: true });
});

test("restore 把会话放回原处并恢复工作区记账", async () => {
  const { ops, sessionId, sessionDir, state, dataRoot } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredTo, sessionDir);
  assert.ok((await stat(join(sessionDir, "session.v4.jsonl.zstd"))).isFile());
  assert.equal(state.sessionIds.has(sessionId), true);
  const listed = await ops.list();
  assert.equal(listed.entries.length, 0);
  await rm(dataRoot, { recursive: true, force: true });
});

test("purge 只清回收站条目", async () => {
  const { ops, sessionId, dataRoot } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const result = await ops.purge(trashed.entryId);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, sessionId);
  const listed = await ops.list();
  assert.equal(listed.entries.length, 0);
  await rm(dataRoot, { recursive: true, force: true });
});

test("health 报告能力档位与数据根", async () => {
  const { ops, dataRoot } = await fixture();
  const health = await ops.health();
  assert.equal(health.plugin, "@kangyishuai/dsh-session-delete");
  assert.equal(health.dataRoot, dataRoot);
  assert.equal(health.readOnly, false);
  assert.equal(health.capabilities.tier, "internal");
  await rm(dataRoot, { recursive: true, force: true });
});

test("并发 trash 同一会话时第二个被拒绝", async () => {
  const { ops, sessionId, dataRoot } = await fixture();
  const plan = await ops.plan(sessionId);
  const first = ops.trash(sessionId, { digest: plan.digest });
  await assert.rejects(
    ops.trash(sessionId, { digest: plan.digest }),
    (error) => /** @type {any} */ (error).code === "session-delete/busy",
  );
  await first;
  await rm(dataRoot, { recursive: true, force: true });
});

test("plan 通过 parentSession 血缘发现子会话（任意深度）", async () => {
  const { ops, sessionId, dataRoot } = await fixture({
    children: [{ id: "child-1", title: "子会话一" }],
  });
  const plan = await ops.plan(sessionId);
  const ids = plan.children.map((/** @type {any} */ child) => child.id);
  assert.ok(ids.includes("child-1"));
  assert.ok(plan.children.find((/** @type {any} */ c) => c.id === "child-1")?.title);
  await rm(dataRoot, { recursive: true, force: true });
});

test("cascade 先删子会话再删自己，回执记录级联结果", async () => {
  const { ops, sessionId, sessionDir, childDirs, dataRoot } = await fixture({
    children: [{ id: "child-1", title: "子会话一" }],
  });
  const plan = await ops.plan(sessionId);
  const result = await ops.trash(sessionId, { digest: plan.digest, cascade: true });
  assert.equal(result.ok, true);
  assert.equal(result.cascaded.length, 1);
  assert.equal(result.cascaded[0].ok, true, JSON.stringify(result.cascaded));
  await assert.rejects(stat(sessionDir));
  await assert.rejects(stat(childDirs[0]));
  const listed = await ops.list();
  assert.equal(listed.entries.length, 2);
  const receipts = await ops.receipts(5);
  assert.ok(receipts.entries[0].cascaded.length === 1);
  await rm(dataRoot, { recursive: true, force: true });
});

test("默认不级联：子会话留在原处", async () => {
  const { ops, sessionId, childDirs, dataRoot } = await fixture({
    children: [{ id: "child-1", title: "子会话一" }],
  });
  const plan = await ops.plan(sessionId);
  const result = await ops.trash(sessionId, { digest: plan.digest });
  assert.equal(result.cascaded.length, 0);
  assert.ok((await stat(childDirs[0])).isDirectory());
  await rm(dataRoot, { recursive: true, force: true });
});

test("listSessions 返回 id/标题/live，trashMany 逐条删除并写回执", async () => {
  const { ops, sessionId, dataRoot } = await fixture({
    children: [{ id: "child-1", title: "子会话一" }],
  });
  const listed = await ops.listSessions();
  const ids = listed.sessions.map((/** @type {any} */ item) => item.id);
  assert.ok(ids.includes(sessionId));
  assert.ok(ids.includes("child-1"));

  const result = await ops.trashMany({ sessionIds: [sessionId, "child-1"] });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 2);
  const receipts = await ops.receipts(5);
  assert.ok(receipts.entries.some((entry) => entry.action === "trash-many"));
  await rm(dataRoot, { recursive: true, force: true });
});

test("trashMany 会跳过不存在/失败项并如实返回", async () => {
  const { ops, sessionId, dataRoot } = await fixture();
  const result = await ops.trashMany({ sessionIds: [sessionId, "missing-session"] });
  assert.equal(result.ok, false);
  assert.equal(result.succeeded, 1);
  assert.equal(
    result.results.find((/** @type {any} */ item) => item.id === "missing-session")?.ok,
    false,
  );
  await rm(dataRoot, { recursive: true, force: true });
});
