// @ts-check
// 关键回归：near-miss 注入。
//
// 目的：证明「绿灯是真的」——同一个义务，实现正确时关闭，故意改坏后必须失败并回到 open。
// 这里用**真实子进程**（node 脚本）走默认 runner，不注入假 runner，尽量接近真机。
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

const GOOD = "console.log('Usage: app');\n";
const NEAR_MISS = "console.log('Usgae: app');\n"; // 拼错一个字母

/**
 * 建一个项目并返回上下文。
 * @param {string} title
 */
async function setup(title) {
  const root = mkdtempSync(join(tmpdir(), "casefile-nearmiss-"));
  dirs.push(root);
  const impl = join(root, "impl");
  mkdirSync(impl, { recursive: true });
  const app = join(impl, "app.mjs");
  writeFileSync(app, GOOD, "utf8");
  const actions = createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root });
  const project = await actions.openProject({ title });
  return { actions, impl, app, id: project.id };
}

/** 一个永远成功的构建命令（与被测的 CLI 分开，避免把检查命令当构建命令）。 */
const BUILD_OK = 'node -e "0"';

test("near-miss：正确实现通过并关闭；改坏后同一义务必须失败并回到 open", async () => {
  const { actions, impl, app, id } = await setup("CLI App");
  const obligation = await actions.addObligation(id, {
    statement: "`app` 打印 `Usage: app`",
    kind: "behavior",
    check: {
      checker: "cli",
      command: `node ${app}`,
      expect: { exitCode: 0, stdoutIncludes: ["Usage: app"] },
    },
  });

  const first = await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl });
  assert.equal(first.rounds.length, 1);
  assert.equal(first.rounds[0].checked[0]?.verdict, "pass");
  assert.equal(first.closed, 1);
  assert.equal(first.open, 0);
  assert.equal((await actions.listObligations(id))[0]?.status, "pass");

  // 注入 near-miss
  writeFileSync(app, NEAR_MISS, "utf8");
  const second = await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl });
  assert.deepEqual(
    second.rounds[0].checked.map((/** @type {any} */ item) => item.verdict),
    ["fail"],
    "near-miss 必须让检查失败",
  );
  assert.equal(second.closed, 0);
  assert.equal(second.open, 1);
  const after1 = (await actions.listObligations(id)).find((item) => item.id === obligation.id);
  assert.equal(after1?.status, "open");
  assert.match(String(after1?.note), /stale/u);
});

test("near-miss：只差一个字符也会被抓到（不做模糊匹配）", async () => {
  const { actions, impl, app, id } = await setup("One Char");
  await actions.addObligation(id, {
    statement: "输出含 Usage: app",
    kind: "behavior",
    check: { checker: "cli", command: `node ${app}`, expect: { stdoutIncludes: ["Usage: app"] } },
  });
  assert.equal((await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl })).closed, 1);

  writeFileSync(app, "console.log('Usage:app');\n", "utf8");
  assert.equal(
    (await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl })).open,
    1,
    "少一个空格也必须失败",
  );
});

test("near-miss：退出码变化同样被抓到", async () => {
  const { actions, impl, app, id } = await setup("Exit Code");
  await actions.addObligation(id, {
    statement: "退出码为 0",
    kind: "behavior",
    check: { checker: "cli", command: `node ${app}`, expect: { exitCode: 0 } },
  });
  assert.equal((await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl })).closed, 1);

  writeFileSync(app, "console.log('Usage: app'); process.exit(3);\n", "utf8");
  const failed = await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl });
  assert.equal(failed.open, 1);
  const checks = await actions.listChecks(id);
  assert.ok(
    checks.some((item) => item.verdict === "fail"),
    "应留下 fail 检查记录",
  );
});

test("near-miss：构建失败时不做检查、也不能关义务", async () => {
  const { actions, impl, app, id } = await setup("Build Fail");
  await actions.addObligation(id, {
    statement: "输出含 Usage",
    kind: "behavior",
    check: { checker: "cli", command: `node ${app}`, expect: { stdoutIncludes: ["Usage: app"] } },
  });
  const result = await actions.advanceLoop(id, {
    command: `node ${join(impl, "does-not-exist.mjs")}`,
    cwd: impl,
  });
  assert.equal(result.rounds[0]?.buildStatus, "fail");
  assert.deepEqual(result.rounds[0]?.checked, [], "构建失败时跳过检查");
  assert.equal(result.closed, 0);
  assert.equal(result.open, 1);
});

test("没有 check recipe 的义务不会被猜通过，而是列入 needsRecipe", async () => {
  const { actions, impl, id } = await setup("No Recipe");
  const bare = await actions.addObligation(id, { statement: "没有检查配方" });
  const result = await actions.advanceLoop(id, { command: BUILD_OK, cwd: impl });
  assert.deepEqual(result.rounds[0]?.needsRecipe, [bare.id]);
  assert.equal(result.closed, 0);
  assert.equal(result.open, 1);
  assert.equal((await actions.listObligations(id))[0]?.status, "open");
});
