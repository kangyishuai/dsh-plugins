// @ts-check
// 单元测试：actions 的构建与验收闭环（注入假 runner，不跑真命令）。
// 覆盖：BuildRun/CheckResult 落盘、实现 digest 绑定、stale 传播、循环停止条件。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {Record<string, any>} table
 * @returns {{ actions: ReturnType<typeof createActions>, root: string, tree: string }}
 */
function makeActions(table) {
  const root = mkdtempSync(join(tmpdir(), "casefile-runs-"));
  dirs.push(root);
  const tree = join(root, "impl");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "index.js"), "console.log('v1');\n");
  const actions = createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    runner: async (command) => table[command] ?? { exitCode: 127, stdout: "", stderr: "not found" },
  });
  return { actions, root, tree };
}

/**
 * 造一个已开启的义务。
 * @param {any} actions
 * @param {string} projectId
 */
async function seed(actions, projectId) {
  await actions.openProject({ title: projectId === "p" ? "P" : projectId });
  return actions.addObligation("p", { statement: "CLI 输出包含 Usage", kind: "behavior" });
}

test("startBuild：成功构建落 BuildRun 并算实现 digest", async () => {
  const { actions, tree } = makeActions({
    "npm run build": { exitCode: 0, stdout: "ok", stderr: "" },
  });
  await seed(actions, "p");
  const result = await actions.startBuild("p", { command: "npm run build", cwd: tree });
  assert.equal(result.build.status, "pass");
  assert.equal(result.build.round, 1);
  assert.match(String(result.build.implementationDigest), /^[0-9a-f]{64}$/);
  assert.equal(result.builds, 1);
  const detail = await actions.detail("p");
  assert.equal(detail.builds.length, 1);
});

test("startBuild：失败构建 status=fail，轮次自动递增", async () => {
  const { actions, tree } = makeActions({ bad: { exitCode: 2, stdout: "", stderr: "boom" } });
  await seed(actions, "p");
  const first = await actions.startBuild("p", { command: "bad", cwd: tree });
  assert.equal(first.build.status, "fail");
  const second = await actions.startBuild("p", { command: "bad", cwd: tree });
  assert.equal(second.build.round, 2);
});

test("runCheck：绑定当前实现 digest，PASS 后可以关闭义务", async () => {
  const { actions, tree } = makeActions({
    build: { exitCode: 0, stdout: "", stderr: "" },
    "run --help": { exitCode: 0, stdout: "Usage: run", stderr: "" },
  });
  const obligation = await seed(actions, "p");
  await actions.startBuild("p", { command: "build", cwd: tree });
  const checked = await actions.runCheck("p", {
    obligationId: obligation.id,
    checker: "cli",
    command: "run --help",
    expect: { stdoutIncludes: ["Usage"] },
  });
  assert.equal(checked.check.verdict, "pass");
  assert.match(String(checked.check.implementationDigest), /^[0-9a-f]{64}$/);
  const closed = await actions.closeObligation("p", obligation.id);
  assert.equal(closed.status, "pass");
});

test("runCheck：没有构建记录时拒绝（无法绑定实现 digest）", async () => {
  const { actions } = makeActions({});
  const obligation = await seed(actions, "p");
  await assert.rejects(
    () => actions.runCheck("p", { obligationId: obligation.id, checker: "cli", command: "x" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("runCheck：未知 checker 被拒", async () => {
  const { actions, tree } = makeActions({ build: { exitCode: 0, stdout: "", stderr: "" } });
  const obligation = await seed(actions, "p");
  await actions.startBuild("p", { command: "build", cwd: tree });
  await assert.rejects(
    () => actions.runCheck("p", { obligationId: obligation.id, checker: "magic", command: "x" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("实现变化 → 已关闭义务自动重开（stale 传播）", async () => {
  const { actions, tree } = makeActions({
    build: { exitCode: 0, stdout: "", stderr: "" },
    "run --help": { exitCode: 0, stdout: "Usage", stderr: "" },
  });
  const obligation = await seed(actions, "p");
  await actions.startBuild("p", { command: "build", cwd: tree });
  await actions.runCheck("p", {
    obligationId: obligation.id,
    checker: "cli",
    command: "run --help",
    expect: { stdoutIncludes: ["Usage"] },
  });
  await actions.closeObligation("p", obligation.id);
  assert.equal((await actions.listObligations("p"))[0].status, "pass");

  // 改实现，再构建一轮
  writeFileSync(join(tree, "index.js"), "console.log('v2');\n");
  const second = await actions.startBuild("p", { command: "build", cwd: tree });
  assert.equal(second.stale.length, 1);
  assert.deepEqual(second.stale[0].reasons, ["implementation-changed"]);
  const after = await actions.listObligations("p");
  assert.equal(after[0].status, "open");
  assert.match(String(after[0].note), /stale: implementation-changed/u);
});

test("loopStatus：按轮次/失败数给出停止条件", async () => {
  const { actions, tree } = makeActions({ bad: { exitCode: 1, stdout: "", stderr: "e" } });
  await seed(actions, "p");
  await actions.startBuild("p", { command: "bad", cwd: tree });
  await actions.startBuild("p", { command: "bad", cwd: tree });
  const third = await actions.startBuild("p", { command: "bad", cwd: tree });
  const status = await actions.loopStatus("p");
  assert.equal(status.builds, 3);
  assert.equal(status.stop.stop, true);
  assert.equal(status.stop.reason, "max-failures");
  assert.ok(third.stale !== undefined);
});

test("loopStatus：轮次上限", async () => {
  const { actions, tree } = makeActions({ build: { exitCode: 0, stdout: "", stderr: "" } });
  await seed(actions, "p");
  for (let i = 0; i < 5; i += 1) {
    await actions.startBuild("p", { command: "build", cwd: tree });
  }
  const status = await actions.loopStatus("p");
  assert.equal(status.stop.reason, "max-rounds");
});
