// @ts-check
// 会话「当前项目」指针：显式 projectId 也要记住、open 能打开已有项目、重启后仍可 recall。
//
// 背景（AUD-CASEFILE-01，真实历史）：某个会话先 case_project get(pid)，
// 之后连续 9 次不带 projectId 的 add 全部 project-not-found，直到第 10 次显式传参。
// 原因：remember() 只在 open（=新建）时调用，open 对已有项目直接 project-exists，
// 而指针是进程内 Map，重启即丢。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { CaseStore } from "../lib/core/store.js";
import { buildToolDefinitions, TOOL_NAMES } from "../lib/tools.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {string} */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "casefile-pointer-"));
  dirs.push(dir);
  return dir;
}

/** @param {string} id */
const session = (id) => ({ agent: { id } });

/** @returns {{ actions: ReturnType<typeof createActions>, store: CaseStore, root: string }} */
function makeActions(root = tempRoot()) {
  const store = new CaseStore({ dataRoot: root });
  return { actions: createActions({ store, dataRoot: root }), store, root };
}

test("open 显式 id 命中已有项目时返回该项目，而不是 project-exists", async () => {
  const { actions } = makeActions();
  const created = await actions.openProject({ title: "Demo" }, session("s1"));
  assert.equal(created.id, "demo");
  const reopened = await actions.openProject({ id: "demo", title: "Demo" }, session("s2"));
  assert.equal(reopened.id, "demo");
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.createdAt, created.createdAt, "打开已有项目不应重写项目文件");
  assert.equal(actions.recall(session("s2")), "demo");
});

test("open 显式 id 不存在时仍然新建", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ id: "fresh", title: "Fresh" }, session("s1"));
  assert.equal(project.id, "fresh");
  assert.equal(project.reopened, undefined);
});

test("显式 projectId 的任意工具调用会建立指针（get 之后不带 projectId 也能写证据）", async () => {
  const { actions, store } = makeActions();
  await actions.openProject({ title: "Demo" }, session("s1"));
  const handlers = {
    rememberProject: (/** @type {any} */ exec, /** @type {string} */ id) =>
      actions.remember(exec, id),
    getProject: (/** @type {string} */ id) => actions.detail(id),
    addEvidence: (/** @type {string} */ id, /** @type {any} */ input, /** @type {any} */ exec) =>
      actions.addEvidence(id, input, exec),
    listEvidence: (/** @type {string} */ id, /** @type {any} */ filter) =>
      actions.listEvidence(id, filter),
    lastOpenedProjectId: () => store.lastOpenedProjectId(),
  };
  const definitions = buildToolDefinitions(handlers, (exec) => actions.recall(exec));
  const projectTool = definitions.find((item) => item.name === TOOL_NAMES.project);
  const evidenceTool = definitions.find((item) => item.name === TOOL_NAMES.evidence);
  const other = session("s9");
  const got = await projectTool.execute({ action: "get", projectId: "demo" }, other);
  assert.equal(got.ok, true, JSON.stringify(got.error));
  assert.equal(actions.recall(other), "demo");
  const added = await evidenceTool.execute(
    { action: "add", input: { summary: "来自 get 之后的隐式项目" } },
    other,
  );
  assert.equal(added.ok, true, JSON.stringify(added.error));
});

test("重启（新 actions 实例）后仍能 recall 同一会话的指针", async () => {
  const root = tempRoot();
  const first = makeActions(root);
  await first.actions.openProject({ title: "Demo" }, session("s1"));
  assert.equal(first.actions.recall(session("s1")), "demo");
  const pointerFile = join(root, "session-pointers.json");
  assert.equal(existsSync(pointerFile), true, "指针应落盘到数据根");
  assert.match(readFileSync(pointerFile, "utf8"), /demo/u);

  const restarted = makeActions(root);
  assert.equal(restarted.actions.recall(session("s1")), "demo");
  assert.equal(restarted.actions.recall(session("s2")), undefined);
});

test("指针指向已被 drop 的项目时 recall 返回 undefined（悬空指针自清理）", async () => {
  const root = tempRoot();
  const { actions } = makeActions(root);
  await actions.openProject({ title: "Demo" }, session("s1"));
  await actions.dropProject("demo", { confirm: true });
  const restarted = makeActions(root);
  assert.equal(restarted.actions.recall(session("s1")), undefined);
});

test("UI 选中（projectDetail 同源）会记录 last-opened；缺 projectId 的报错带上候选 id", async () => {
  const { actions, store } = makeActions();
  await actions.openProject({ title: "Demo" }, session("s1"));
  store.markLastOpened("demo");
  const handlers = {
    lastOpenedProjectId: () => store.lastOpenedProjectId(),
  };
  const definitions = buildToolDefinitions(handlers, () => undefined);
  const claimTool = definitions.find((item) => item.name === TOOL_NAMES.claim);
  const missing = await claimTool.execute({ action: "list" }, session("s3"));
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "project-not-found");
  assert.match(String(missing.error.message), /demo/u, "错误提示应带上上次打开的项目 id");
});

test("指针超过 200 上限时按 LRU 淘汰：刚用过的会话不会被挤出（F8）", async () => {
  const root = tempRoot();
  const first = makeActions(root);
  await first.actions.openProject({ title: "Demo" }, session("s-first"));
  for (let index = 0; index < 200; index += 1) {
    first.actions.remember(session(`s-${index}`), "demo");
  }
  // 重新使用最早的会话：它应该排到「最近使用」一端，而不是被当成最旧的淘汰。
  first.actions.remember(session("s-0"), "demo");
  first.actions.remember(session("s-200"), "demo");

  const restarted = makeActions(root);
  assert.equal(restarted.actions.recall(session("s-0")), "demo", "刚用过的会话不能被淘汰");
  assert.equal(restarted.actions.recall(session("s-200")), "demo", "最新会话应在");
  assert.equal(restarted.actions.recall(session("s-1")), undefined, "最久没用的会话应被淘汰");
  assert.equal(restarted.actions.recall(session("s-first")), undefined);
});
