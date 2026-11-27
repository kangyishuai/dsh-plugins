// @ts-check
// AUD-SD-01 / AUD-SD-07：启动对账与复活守卫。
//
// 这些用例全部构造「崩溃在步骤之间」的现场：用低层 API 把磁盘改成某个中间态，
// 再写一条 journal intent（模拟 beginOperation 之后进程被杀），然后调用 recoverPending()。
// 断言的核心不是「记录被清掉」，而是**磁盘事实**：会话要么安稳待在回收站，要么安稳回到原位，
// 引用要么补完、要么回滚，绝不允许两边都不在。
import assert from "node:assert/strict";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delayMs } from "node:timers/promises";
import { beginOperation, listPending } from "../lib/journal.js";
import { trashRoot } from "../lib/paths.js";
import { entryDataDir, entryDir, moveIntoTrash, readEntry } from "../lib/trash.js";
import { fixture, seedWorkspaceFile } from "./helpers.js";

/**
 * 写一条「trash 已经移动完、但引用还没摘」的崩溃现场。
 * @param {{ dataRoot: string, sessionId: string, sessionDir: string }} context
 */
async function crashAfterTrashMove({ dataRoot, sessionId, sessionDir }) {
  const moved = await moveIntoTrash({
    dataRoot,
    sessionId,
    sourceDir: sessionDir,
    meta: {
      title: "hello",
      cwd: "/w",
      bytes: 4096,
      live: false,
      children: [],
      workspaceIds: ["ws1"],
    },
  });
  const record = await beginOperation({
    dataRoot,
    action: "trash",
    extra: { sessionId, digest: "deadbeef", operator: "ui", entryId: moved.entryId },
  });
  return { record, entryId: moved.entryId };
}

test("启动对账：trash 已移动但引用未摘 → 补完引用、写审计与回执，数据留在回收站", async () => {
  const { ops, dataRoot, sessionId, sessionDir, state } = await fixture();
  state.archived = true; // 归档闸门已经执行过
  const { entryId } = await crashAfterTrashMove({ dataRoot, sessionId, sessionDir });
  assert.equal((await ops.list()).pending.length, 1, "现场应当有一条未完成记录");

  const summary = await ops.recoverPending();
  assert.equal(summary.examined, 1);
  assert.equal(summary.completed, 1, JSON.stringify(summary.results));
  assert.equal(summary.failed, 0);
  assert.equal(summary.unresolved, 0);

  // 引用补完：归档标记、置顶标记、工作区记账都不再指向它。
  assert.equal(state.archived, false);
  assert.equal(state.pinned, false);
  assert.equal(state.sessionIds.has(sessionId), false);
  // 数据安全：会话仍在回收站，没有被「补做」成删除或复活。
  await assert.rejects(stat(sessionDir));
  const listed = await ops.list();
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].entryId, entryId);
  assert.equal(listed.pending.length, 0, "补完后 journal 记录应当被清掉");

  // 取证：审计里有一条 recover，回执里有 recovered 标记。
  const audit = await ops.auditLog(20);
  const recoverEntry = audit.entries.find((entry) => entry.action === "recover");
  assert.ok(recoverEntry, "启动对账必须留痕");
  assert.equal(recoverEntry.result, "ok");
  assert.equal(recoverEntry.operator, "system");
  const receipts = await ops.receipts(10);
  assert.ok(
    receipts.entries.some((entry) => entry.action === "trash" && entry.recovered === true),
    "补做要写一份带 recovered 标记的回执",
  );
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：trash 还没移动 → 回滚归档闸门并清掉记录", async () => {
  const { ops, dataRoot, sessionId, sessionDir, state } = await fixture();
  state.archived = true;
  const record = await beginOperation({
    dataRoot,
    action: "trash",
    extra: { sessionId, digest: "deadbeef", operator: "ui" },
  });
  assert.ok(record.id);

  const summary = await ops.recoverPending();
  assert.equal(summary.rolledBack, 1, JSON.stringify(summary.results));
  assert.equal(state.archived, false, "未移动就应当把归档闸门回滚掉");
  assert.ok((await stat(sessionDir)).isDirectory(), "会话目录必须留在原处");
  assert.equal((await ops.list()).pending.length, 0);
  const audit = await ops.auditLog(20);
  const recoverEntry = audit.entries.find((entry) => entry.action === "recover");
  assert.equal(recoverEntry?.result, "ok");
  assert.match(String(recoverEntry?.detail), /回滚/u);
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：目录与回收站条目同时存在（无法解释）→ 拒绝猜测、保留记录", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  await crashAfterTrashMove({ dataRoot, sessionId, sessionDir });
  // 迟到的活句柄又把目录建了回来：两边都有，对账不许动任何一边。
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "revived");

  const summary = await ops.recoverPending();
  assert.equal(summary.unresolved, 1, JSON.stringify(summary.results));
  assert.equal((await ops.list()).pending.length, 1, "解释不了的现场要留给人工核对");
  assert.ok((await stat(sessionDir)).isDirectory());
  assert.equal((await ops.list()).entries.length, 1);
  const audit = await ops.auditLog(20);
  const recoverEntry = audit.entries.find((entry) => entry.action === "recover");
  assert.equal(recoverEntry?.result, "refused");
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：restore 已搬回但条目未删 → 补完引用恢复（含置顶）并清理条目", async () => {
  const { ops, dataRoot, sessionId, sessionDir, state } = await fixture();
  // 置顶集合没有公开读接口，插件只能读 storages/workspace.json；先造一份。
  await seedWorkspaceFile(dataRoot, { pinned: [sessionId], workspaces: { ws1: [sessionId] } });
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const meta = await readEntry(dataRoot, trashed.entryId);
  assert.equal(meta.pinned, true, "AUD-SD-06：trash 时必须把置顶状态写进 meta");
  assert.equal(state.pinned, false, "trash 后置顶标记应当被摘掉");

  // 崩溃现场：数据已经搬回原目录，但回收站条目目录（含 meta）还在。
  await mkdir(join(sessionDir, ".."), { recursive: true });
  await rename(entryDataDir(dataRoot, trashed.entryId), sessionDir);
  const record = await beginOperation({
    dataRoot,
    action: "restore",
    extra: { sessionId, entryId: trashed.entryId, operator: "ui" },
  });
  assert.ok(record.id);

  const summary = await ops.recoverPending();
  assert.equal(summary.completed, 1, JSON.stringify(summary.results));
  assert.ok((await stat(join(sessionDir, "session.v4.jsonl.zstd"))).isFile());
  await assert.rejects(stat(entryDir(dataRoot, trashed.entryId)), "条目目录应当被收尾清掉");
  assert.equal(state.sessionIds.has(sessionId), true, "工作区归属要恢复");
  assert.equal(state.pinned, true, "AUD-SD-02：恢复要还原置顶");
  assert.deepEqual(await listPending(dataRoot), []);

  const receipts = await ops.receipts(10);
  const restoreReceipt = receipts.entries.find(
    (entry) => entry.action === "restore" && entry.recovered === true,
  );
  assert.ok(restoreReceipt, "补做恢复要写回执");
  assert.ok(Array.isArray(restoreReceipt.refs), "回执要逐项记录引用恢复结果");
  assert.ok(Array.isArray(restoreReceipt.checks), "回执要带恢复后的校验结果");
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：restore 还没搬回 → 清掉记录，数据留在回收站", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const record = await beginOperation({
    dataRoot,
    action: "restore",
    extra: { sessionId, entryId: trashed.entryId, operator: "ui" },
  });
  assert.ok(record.id);

  const summary = await ops.recoverPending();
  assert.equal(summary.rolledBack, 1, JSON.stringify(summary.results));
  assert.ok(
    (await stat(entryDataDir(dataRoot, trashed.entryId))).isDirectory(),
    "数据必须还在回收站",
  );
  await assert.rejects(stat(sessionDir));
  assert.equal((await ops.list()).pending.length, 0);
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账可重复执行：第二次运行不再改动任何东西", async () => {
  const { ops, dataRoot, sessionId, sessionDir, state } = await fixture();
  state.archived = true;
  await crashAfterTrashMove({ dataRoot, sessionId, sessionDir });
  await ops.recoverPending();
  const before = await ops.auditLog(50);
  const second = await ops.recoverPending();
  assert.equal(second.examined, 0, "幂等：没有未完成记录时不应再写审计");
  assert.deepEqual(await ops.auditLog(50), before);
  await rm(dataRoot, { recursive: true, force: true });
});

test("复活守卫：迟到的写入重建目录后，真的再移一次并留痕", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  const guarded = await ops.recovery.reviveGuard({
    sessionId,
    originalPath: sessionDir,
    meta: { title: "hello", cwd: "/w" },
  });
  assert.equal(guarded.revived, true, JSON.stringify(guarded));
  await assert.rejects(stat(sessionDir));
  const listed = await ops.list();
  assert.equal(listed.entries.length, 1);
  assert.ok(
    (await stat(entryDataDir(dataRoot, /** @type {string} */ (guarded.entryId)))).isDirectory(),
  );
  const audit = await ops.auditLog(20);
  const entry = audit.entries.find(
    (row) => row.action === "trash" && row.operator === "system" && row.result === "ok",
  );
  assert.ok(entry, "复活守卫必须写一条 system 审计");
  assert.match(String(entry.detail), /复活守卫/u);
  await rm(dataRoot, { recursive: true, force: true });
});

test("复活守卫：原路径不存在时什么都不做", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  await rm(sessionDir, { recursive: true, force: true });
  const guarded = await ops.recovery.reviveGuard({
    sessionId,
    originalPath: sessionDir,
    meta: { title: null, cwd: null },
  });
  assert.equal(guarded.revived, false);
  const trash = await readdir(trashRoot(dataRoot)).catch(() => []);
  assert.deepEqual(trash, [], "没有复活就不该产生回收站条目");
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：purge 未发生 → 清掉记录、条目保持完整", async () => {
  const { ops, dataRoot, sessionId } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const record = await beginOperation({
    dataRoot,
    action: "purge",
    extra: { entryId: trashed.entryId, sessionId },
  });
  assert.ok(record.id);

  const summary = await ops.recoverPending();
  assert.equal(summary.rolledBack, 1, JSON.stringify(summary.results));
  assert.ok(
    (await stat(entryDataDir(dataRoot, trashed.entryId))).isDirectory(),
    "条目必须完整保留",
  );
  assert.deepEqual(await listPending(dataRoot), []);
  // 恢复一次证明数据真的没坏。
  const restored = await ops.restore(trashed.entryId);
  assert.equal(restored.ok, true);
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：purge 已完成（条目已不存在）→ 补完记录", async () => {
  const { ops, dataRoot, sessionId } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  await ops.purge(trashed.entryId);
  const record = await beginOperation({
    dataRoot,
    action: "purge",
    extra: { entryId: trashed.entryId, sessionId },
  });
  assert.ok(record.id);

  const summary = await ops.recoverPending();
  assert.equal(summary.completed, 1, JSON.stringify(summary.results));
  assert.deepEqual(await listPending(dataRoot), []);
  await rm(dataRoot, { recursive: true, force: true });
});

test("health 暴露上一次启动对账的结论", async () => {
  const { ops, dataRoot, sessionId, sessionDir, state } = await fixture();
  state.archived = true;
  await crashAfterTrashMove({ dataRoot, sessionId, sessionDir });
  assert.equal((await ops.health()).lastRecovery, null);
  const summary = await ops.recoverPending();
  const health = await ops.health();
  assert.equal(health.lastRecovery?.examined, summary.examined);
  assert.equal(health.lastRecovery?.completed, 1);
  assert.equal(health.pending, 0);
  await rm(dataRoot, { recursive: true, force: true });
});

test("启动对账：purge 删到一半（条目残缺）→ 不销账，保留记录待人工确认", async () => {
  const { ops, dataRoot, sessionId } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  // 模拟 rm 递归中途失败：数据删掉了，meta 还在。
  await rm(entryDataDir(dataRoot, trashed.entryId), { recursive: true, force: true });
  const record = await beginOperation({
    dataRoot,
    action: "purge",
    extra: { entryId: trashed.entryId, sessionId },
  });
  assert.ok(record.id);

  const summary = await ops.recoverPending();
  assert.equal(summary.unresolved, 1, JSON.stringify(summary.results));
  assert.equal((await ops.list()).pending.length, 1, "残缺条目要留给人工确认");
  const audit = await ops.auditLog(20);
  assert.equal(audit.entries.find((entry) => entry.action === "recover")?.result, "refused");
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B2（复审阻塞项）：复活守卫不许把「1.5s 内刚恢复的会话」再移入回收站。
// 复审在 /tmp 用真实 trash/restore 路径复现：restore 返回 ok 后 2s 目录消失、
// 回收站多一条、审计写「已再次移入回收站」。下面三条锁住修复。
// ---------------------------------------------------------------------------
test("复活守卫：本次条目已被 restore → 不再移动（B2）", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  assert.equal(restored.ok, true);

  const guarded = await ops.recovery.reviveGuard({
    sessionId,
    originalPath: sessionDir,
    entryId: trashed.entryId,
    meta: { title: "hello", cwd: "/w" },
  });
  assert.equal(guarded.revived, false, "条目已被 restore，守卫必须放手");
  assert.equal(guarded.skipped, true);
  assert.ok((await stat(join(sessionDir, "session.v4.jsonl.zstd"))).isFile());
  assert.equal((await ops.list()).entries.length, 0, "不许为已恢复的会话新增回收站条目");
  const guardAudit = (await ops.auditLog(50)).entries.filter((entry) =>
    /复活守卫/u.test(String(entry.detail)),
  );
  assert.deepEqual(guardAudit, []);
  await rm(dataRoot, { recursive: true, force: true });
});

test("复活守卫：本次条目已被 purge → 不再移动", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  await ops.purge(trashed.entryId);
  // 迟到的活句柄把目录重建回来（purge 之后）。
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "late-write");

  const guarded = await ops.recovery.reviveGuard({
    sessionId,
    originalPath: sessionDir,
    entryId: trashed.entryId,
    meta: { title: "hello", cwd: "/w" },
  });
  assert.equal(guarded.revived, false);
  assert.equal(guarded.skipped, true);
  assert.equal((await ops.list()).entries.length, 0);
  await rm(dataRoot, { recursive: true, force: true });
});

test("端到端：trash → 立即 restore → 等过 1.5s 复活窗口，会话仍在原处（B2）", async () => {
  const { ops, dataRoot, sessionId, sessionDir } = await fixture();
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  assert.equal(restored.ok, true);
  assert.ok((await stat(join(sessionDir, "session.v4.jsonl.zstd"))).isFile());

  // 守卫的定时器在 trash 后 1500ms 触发；restore 已完成，此时它必须确认条目已不在。
  await delayMs(2000);
  assert.ok(
    (await stat(join(sessionDir, "session.v4.jsonl.zstd"))).isFile(),
    "用户的恢复不许被守卫静默撤回",
  );
  assert.equal((await ops.list()).entries.length, 0, "回收站里不该出现同一会话的新条目");
  const guardAudit = (await ops.auditLog(50)).entries.filter((entry) =>
    /复活守卫/u.test(String(entry.detail)),
  );
  assert.deepEqual(guardAudit, [], "守卫既然没移，就不该写「已再次移入」审计");
  await rm(dataRoot, { recursive: true, force: true });
});
