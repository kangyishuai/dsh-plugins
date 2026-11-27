// @ts-check
// 单元测试：actions.js 的完整业务闭环（项目 → 证据 → 结论 → 功能 → 未知项 → 规格包）。
// 全部在 mkdtemp 临时目录里跑；不 import service.js（它依赖宿主包）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CasefileActionError, createActions } from "../lib/actions.js";
import { diffCapabilities } from "../lib/core/manifest.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {{ actions: ReturnType<typeof createActions>, store: CaseStore, root: string }} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-actions-"));
  dirs.push(root);
  const store = new CaseStore({ dataRoot: root });
  return { actions: createActions({ store, dataRoot: root }), store, root };
}

/** @param {string} id */
const session = (id) => ({ agent: { id } });

test("完整闭环：建项目 → 记证据 → 写结论 → 勾选 → 导出规格包", async () => {
  const { actions, root } = makeActions();
  const project = await actions.openProject(
    { title: "Todo App", target: { kind: "web", ref: "https://example.test" } },
    session("s1"),
  );
  assert.equal(project.id, "todo-app");
  assert.equal(actions.recall(session("s1")), "todo-app");

  const evidence = await actions.addEvidence(
    "todo-app",
    {
      kind: "har",
      sourceTool: "inspect_web_network_capture",
      summary: "POST /api/todos 返回 201",
      confidence: "observed",
      authority: "live-observation",
      limitations: ["只覆盖登录后的请求"],
    },
    session("s1"),
  );
  assert.equal(evidence.sessionId, "s1");

  const claim = await actions.addClaim("todo-app", {
    text: "新增待办走 POST /api/todos",
    kind: "har",
    evidenceIds: [evidence.id],
  });
  assert.equal(claim.selected, false);

  const [selected] = await actions.selectClaims("todo-app", [claim.id], true);
  assert.equal(selected.selected, true);

  const unknown = await actions.addUnknown("todo-app", { text: "并发上限未知", severity: "high" });
  assert.equal(unknown.status, "open");

  const exported = await actions.exportSpecPack("todo-app", { redact: true });
  const dir = exported.data.path;
  assert.equal(existsSync(join(dir, "spec.json")), true);
  assert.equal(existsSync(join(dir, "brief.md")), true);
  const pack = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
  assert.equal(pack.claims.length, 1);
  assert.equal(pack.unknowns.length, 1);
  assert.equal(pack.coverage.selectedClaims, 1);
  assert.ok(dir.startsWith(root));
});

test("没选结论时导出报 nothing-selected", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  await assert.rejects(
    () => actions.exportSpecPack("p"),
    (error) => error instanceof CasefileActionError && error.code === "nothing-selected",
  );
});

test("项目不存在时报 project-not-found", async () => {
  const { actions } = makeActions();
  await assert.rejects(
    () => actions.listEvidence("nope"),
    (error) => /** @type {any} */ (error).code === "project-not-found",
  );
});

test("证据/结论可按字段过滤与关键词搜索", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  await actions.addEvidence("p", { summary: "a", kind: "string", confidence: "observed" });
  await actions.addEvidence("p", { summary: "b", kind: "har", confidence: "derived" });
  assert.equal((await actions.listEvidence("p", { kind: "har" })).length, 1);
  assert.equal((await actions.listEvidence("p", { confidence: "observed" })).length, 1);

  await actions.addClaim("p", { text: "登录令牌放在 Header" });
  await actions.addClaim("p", { text: "退出清空本地缓存" });
  assert.equal((await actions.searchClaims("p", "令牌")).length, 1);
  assert.equal((await actions.searchClaims("p", "")).length, 0);
});

test("未解决未知项不计入 resolved，且导出只带 open 的", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const claim = await actions.addClaim("p", { text: "x" });
  await actions.selectClaims("p", [claim.id], true);
  const unknown = await actions.addUnknown("p", { text: "待查" });
  const exported = await actions.exportSpecPack("p");
  const pack = JSON.parse(readFileSync(join(exported.data.path, "spec.json"), "utf8"));
  assert.equal(pack.unknowns.length, 1);
  await actions.resolveUnknown("p", unknown.id, "已确认");
  const again = await actions.exportSpecPack("p");
  const pack2 = JSON.parse(readFileSync(join(again.data.path, "spec.json"), "utf8"));
  assert.equal(pack2.unknowns.length, 0);
});

test("status 带能力等级（无 REA 时 ok=false）", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const status = await actions.status("p", diffCapabilities([]));
  assert.equal(status.capabilities.ok, false);
  assert.equal(status.capabilities.level, "missing");
  assert.equal(status.stats.id, "p");
});

test("diagnose 报告数据根、项目数与 REA 缺失", async () => {
  const { actions, root } = makeActions();
  await actions.openProject({ title: "P" });
  const diagnosis = await actions.diagnose(diffCapabilities([]));
  assert.equal(diagnosis.dataRoot, root);
  assert.equal(diagnosis.projects, 1);
  assert.equal(diagnosis.rea.availableTools, 0);
  assert.equal(diagnosis.grade.ok, false);
});

test("更新项目：授权档与范围", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const updated = await actions.updateProject("p", { authTier: "authorized", scope: "selected" });
  assert.equal(updated.authTier, "authorized");
  assert.equal(updated.scope, "selected");
  await assert.rejects(
    () => actions.updateProject("p", { authTier: "commercial" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("archiveProject：状态转 archived、文件保留、写审计", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Mis Created" });
  const archived = await actions.archiveProject(project.id, { reason: "误建" });
  assert.equal(archived.project.state, "archived");
  assert.equal(archived.project.archiveReason, "误建");
  assert.match(String(archived.project.archivedAt), /^\d{4}-/u);
  const audit = await actions.readAudit(project.id);
  assert.ok(audit.some((entry) => entry.action === "project/archive"));
  const detail = await actions.detail(project.id);
  assert.equal(detail.project.state, "archived");
});

test("dropProject：没传 confirm 被拒（confirm-required）", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  await assert.rejects(
    () => actions.dropProject(project.id, {}),
    (error) => /** @type {any} */ (error).code === "confirm-required",
  );
  const still = await actions.listProjects();
  assert.ok(
    still.some((item) => item.id === project.id),
    "被拒时项目不该消失",
  );
});

test("dropProject：confirm 后移入 trash，列表里不再出现", async () => {
  const { actions, root } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  assert.match(dropped.trashedTo, /trash/u);
  assert.equal(existsSync(dropped.trashedTo), true, "trash 目录应存在");
  assert.equal(existsSync(join(root, "projects", project.id)), false, "原目录应已移走");
  const list = await actions.listProjects();
  assert.equal(
    list.some((item) => item.id === project.id),
    false,
  );
});

test("危险操作审计区分来源：agent 带会话 id、user 显式标记、未传记 unknown（复审 A2）", async () => {
  const { actions, store } = makeActions();
  const drop = (/** @type {string} */ id, /** @type {Record<string, any>} */ options) =>
    actions.dropProject(id, { confirm: true, ...options });
  const lastAudit = (/** @type {string} */ action) => {
    const rows = store.readAuditRoot().filter((row) => row.action === action);
    assert.ok(rows.length > 0, `缺少审计 ${action}`);
    return rows.at(-1);
  };

  // 工具路径：模型发起（actor=agent）+ 会话 id。
  const agentProject = await actions.openProject({ title: "Agent Drop" });
  await drop(agentProject.id, { actor: "agent", sessionId: "s1" });
  const agentRow = lastAudit("project/drop");
  assert.equal(agentRow.actor, "agent", "工具发起的 drop 不能再记成 user");
  assert.equal(agentRow.sessionId, "s1");

  // UI 路径：Remote 层显式传 user。
  const userProject = await actions.openProject({ title: "User Drop" });
  await drop(userProject.id, { actor: "user" });
  assert.equal(lastAudit("project/drop").actor, "user");
  assert.equal(lastAudit("project/drop").sessionId, null);

  // 直接调用的脚本/测试没传来源：如实记 unknown，不冒充 user。
  const unknownProject = await actions.openProject({ title: "Unknown Drop" });
  await drop(unknownProject.id, {});
  assert.equal(lastAudit("project/drop").actor, "unknown", "无法区分时不能猜成 user");

  // restore / purge / restore-failed 也走同一口径。
  const trashed = store.scanTrash().entries[0];
  assert.ok(trashed, "回收站里应有刚 drop 的条目");
  await actions.restoreTrash(trashed.name, { actor: "user" });
  assert.equal(lastAudit("project/restore").actor, "user");
  await assert.rejects(() =>
    actions.restoreTrash("missing-entry", { actor: "agent", sessionId: "s2" }),
  );
  const failedRow = lastAudit("project/restore-failed");
  assert.equal(failedRow.actor, "agent");
  assert.equal(failedRow.sessionId, "s2");

  const purgeTarget = await actions.openProject({ title: "Purge Target" });
  await drop(purgeTarget.id, { actor: "agent", sessionId: "s3" });
  await actions.purgeTrash({ confirm: true, actor: "agent", sessionId: "s3" });
  const purgeRow = lastAudit("trash/purge");
  assert.equal(purgeRow.actor, "agent");
  assert.equal(purgeRow.sessionId, "s3");
});

test("awaitLogin 会通过 onWaitChange 上报等待态，并在结束时清空", async () => {
  /** @type {any[]} */
  const states = [];
  const root = mkdtempSync(join(tmpdir(), "casefile-wait-"));
  dirs.push(root);
  const actions = createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    onWaitChange: (state) => states.push(state),
  });
  const project = await actions.openProject({ title: "Wait" });
  // 指向一个必然不可达的端点：短时间内超时，但上报/清空必须发生
  const result = await actions.awaitLogin(project.id, {
    endpoint: "http://127.0.0.1:9",
    pollMs: 10,
    timeoutMs: 60,
  });
  assert.equal(result.status, "timeout");
  assert.equal(states.length, 2, "应有一次上报 + 一次清空");
  assert.equal(states[0]?.active, true);
  assert.equal(states[0]?.projectId, project.id);
  assert.equal(states[1], null);
});
