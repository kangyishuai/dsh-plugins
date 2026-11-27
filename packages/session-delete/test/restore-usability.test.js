// @ts-check
// USIM-U3-02 / USIM-U3-05：恢复「即用、可解释、可重试」。
//
// 用户模拟（U3，2026-11-28）在同一次删除→恢复里踩到四件事：
//   ① 恢复提示「1 处引用/校验未通过」，回执与审计只写数量，不说是哪一处；
//   ② 打开恢复后的会话仍显示「会话不可用」；
//   ③ 第二轮恢复后发送被拒（session/agent-busy）；
//   ④ 标题变「未命名」。
// ①②的宿主侧根因是**能力探测过早固化**：桌面组合里 workspaceRegistry / agents
// 比 sessionPersistence 晚挂载，启动对账那一刻探到的 workspace 是 undefined，
// 于是删除跳过归档闸门/停止/工作区记账，恢复再把 unarchiveSession 缺失报成「失败」。
// 这组用例把「晚挂载」「逐项报错」「自动重试一次」「重检」「标题保真」钉住。
import assert from "node:assert";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, seedWorkspaceFile } from "./helpers.js";

/** @param {string} dataRoot */
async function cleanup(dataRoot) {
  await rm(dataRoot, { recursive: true, force: true });
}

test("宿主服务晚挂载：删除仍走归档闸门并摘掉工作区记账（能力探测不再固化）", async () => {
  const { ops, sessionId, state, services, enableHostServices, dataRoot } = await fixture({
    lateWorkspace: true,
  });
  // 建 ops 的那一刻宿主还没有 workspaceRegistry —— 复现用户模拟里的真实时序。
  assert.equal(services.workspaceRegistry, undefined);
  assert.equal((await ops.health()).capabilities.checks["workspace.list"], false);

  enableHostServices();

  // 能力快照必须跟上晚挂载：否则删除会静默跳过归档与停止，恢复时再把
  // 「unarchiveSession unavailable」报成一条假失败。
  assert.equal((await ops.health()).capabilities.checks["workspace.list"], true);

  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  assert.equal(state.archiveCalls, 1, "归档闸门（agent/pre-step 停止）必须真的执行");
  assert.equal(state.detached, 1, "工作区记账必须被摘掉");
  const archive = trashed.removed.find(
    (/** @type {any} */ item) => item.id === "workspace-archive",
  );
  assert.equal(archive?.status, "ok", JSON.stringify(trashed.removed));
  const slot = trashed.removed.find((/** @type {any} */ item) => item.id === "workspace-slot");
  assert.equal(slot?.status, "ok", JSON.stringify(trashed.removed));

  await cleanup(dataRoot);
});

test("宿主不提供接口时，恢复把该引用记成 skipped 而不是失败（不再假报 partial）", async () => {
  const { ops, sessionId, dataRoot } = await fixture({ lateWorkspace: true });
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  const archive = restored.refs.find((/** @type {any} */ item) => item.id === "workspace-archive");
  assert.equal(archive?.status, "skipped", JSON.stringify(restored.refs));
  assert.match(String(archive?.detail), /不提供|未做处理/u);
  assert.equal(restored.partial, false, "没有失败的引用就不该报「未通过」");
  assert.deepEqual(restored.failures, []);
  await cleanup(dataRoot);
});

test("恢复失败必须逐项列出引用名与下一步动作，并同步进审计与回执", async () => {
  const { ops, sessionId, dataRoot } = await fixture({ failAttach: true });
  await seedWorkspaceFile(dataRoot, { workspaces: { ws1: [sessionId] } });
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  assert.equal(restored.partial, true);

  assert.ok(Array.isArray(restored.failures) && restored.failures.length > 0);
  const slot = restored.failures.find((/** @type {any} */ item) => item.id === "workspace-slot");
  assert.ok(slot, JSON.stringify(restored.failures));
  assert.equal(slot.label, "工作区记账");
  assert.match(String(slot.detail), /未挂回|ws1/u, "要说是哪一个工作区没挂回去");
  assert.match(String(slot.detail), /归属到项目/u, "要给出可操作的下一步");

  const audit = await ops.auditLog(20);
  const audited = /** @type {any} */ (
    audit.entries.find((/** @type {any} */ entry) => entry.action === "restore")
  );
  assert.ok(audited, "恢复必须写审计");
  assert.match(String(audited.detail), /工作区记账/u, "审计要写具体引用名，不能只有计数");
  assert.ok(Array.isArray(audited.failures), "审计要带逐项失败清单");
  assert.equal(audited.title, "hello", "审计要带上标题，便于事后核对");

  const receipt = (await ops.receipts(5)).entries.find(
    (/** @type {any} */ entry) => entry.action === "restore",
  );
  assert.ok(Array.isArray(receipt.failures), "回执要带逐项失败清单");
  assert.deepEqual(receipt.expected, { workspaceIds: ["ws1"], pinned: false });
  assert.equal(receipt.title, "hello", "回执必须保留标题（USIM-U3-09 标题保真的证据链）");
  assert.equal(restored.title, "hello", "恢复结果要带回标题，界面才能显示正确的会话名");

  await cleanup(dataRoot);
});

test("恢复时自动重试一次：瞬时失败后一次重试就成功", async () => {
  const { ops, sessionId, state, dataRoot } = await fixture({ failAttachTimes: 1 });
  await seedWorkspaceFile(dataRoot, { workspaces: { ws1: [sessionId] } });
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  assert.equal(restored.partial, false, JSON.stringify(restored.failures));
  const slot = restored.refs.find((/** @type {any} */ item) => item.id === "workspace-slot");
  assert.equal(slot?.status, "ok");
  assert.equal(slot?.retried, true, "重试过的条目要标出来，回执才可解释");
  assert.equal(state.sessionIds.has(sessionId), true, "重试成功后会话要真的挂回工作区");
  await cleanup(dataRoot);
});

test("recheckRestore 用回执里的快照重放引用恢复：从失败恢复成全绿", async () => {
  const { ops, sessionId, state, setAttachRefused, dataRoot } = await fixture({
    failAttach: true,
  });
  await seedWorkspaceFile(dataRoot, { workspaces: { ws1: [sessionId] } });
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const first = await ops.restore(trashed.entryId);
  assert.equal(first.partial, true);
  assert.equal(state.sessionIds.has(sessionId), false);

  // 现场修好之后再重检：回执里的 expected 快照是条目删除后唯一的副本。
  setAttachRefused(false);
  const rechecked = await ops.recheckRestore({ sessionId });
  assert.equal(rechecked.ok, true, JSON.stringify(rechecked.failures));
  assert.equal(rechecked.partial, false);
  assert.equal(state.sessionIds.has(sessionId), true, "重检要真的把工作区记账恢复回来");

  const audit = await ops.auditLog(20);
  assert.ok(
    audit.entries.some((/** @type {any} */ entry) => entry.action === "restore-recheck"),
    "重检本身也要留审计",
  );
  const receipt = (await ops.receipts(5)).entries.find(
    (/** @type {any} */ entry) => entry.action === "restore-recheck",
  );
  assert.ok(receipt, "重检要写回执");
  await cleanup(dataRoot);
});

test("恢复保真：会话文件内容与目录原样回来（标题来自日志，不靠缓存）", async () => {
  const { ops, sessionId, sessionDir, dataRoot } = await fixture();
  const before = await stat(join(sessionDir, "session.v4.jsonl.zstd"));
  const plan = await ops.plan(sessionId);
  const trashed = await ops.trash(sessionId, { digest: plan.digest });
  const restored = await ops.restore(trashed.entryId);
  const after = await stat(join(sessionDir, "session.v4.jsonl.zstd"));
  assert.equal(restored.restoredTo, sessionDir);
  assert.equal(after.size, before.size, "日志必须原样回来（标题/正文都在这份日志里）");
  await cleanup(dataRoot);
});
