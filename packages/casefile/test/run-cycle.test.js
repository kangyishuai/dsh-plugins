// @ts-check
// 端到端一轮（runCycle）：builder（可选）→ 构建 → 检查 → 关闭，用假会话与假 runner。
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
 * @param {{ sessions?: any }} [options]
 */
function makeActions(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "casefile-cycle-"));
  dirs.push(root);
  const impl = join(root, "impl");
  mkdirSync(impl, { recursive: true });
  writeFileSync(join(impl, "app.mjs"), "console.log('Usage: app');\n", "utf8");
  const actions = createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    sessions: options.sessions,
    runner: async (command) =>
      command.startsWith("node -e 0")
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "Usage: app", stderr: "" },
  });
  return { actions, impl };
}

/** 假会话服务。 */
function fakeSessions() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    create: async (/** @type {any} */ input) => {
      calls.push(["create", input]);
      return { sessionId: "sess-cycle" };
    },
    prompt: async (/** @type {any} */ input) => {
      calls.push(["prompt", input]);
    },
    wait: async (/** @type {any} */ input) => {
      calls.push(["wait", input]);
      return { reason: "idle", output: null };
    },
  };
}

test("runCycle：不带 builder 时直接跑 loop 并关闭义务", async () => {
  const { actions, impl } = makeActions();
  const project = await actions.openProject({ title: "Cycle" });
  const app = join(impl, "app.mjs");
  await actions.addObligation(project.id, {
    statement: "输出含 Usage",
    check: { checker: "cli", command: `node ${app}`, expect: { stdoutIncludes: ["Usage"] } },
  });
  const result = await actions.runCycle(project.id, {
    command: "node -e 0",
    cwd: impl,
    maxRounds: 2,
  });
  assert.equal(result.builder, null);
  assert.equal(result.loop.closed, 1);
  assert.equal(result.loop.open, 0);
  assert.ok(result.summary.length > 0);
});

test("runCycle：带 builder 时先起会话、等它停，再跑 loop", async () => {
  const sessions = fakeSessions();
  const { actions, impl } = makeActions({ sessions });
  const project = await actions.openProject({ title: "Cycle With Builder" });
  const app = join(impl, "app.mjs");
  const claim = await actions.addClaim(project.id, { text: "输出含 Usage" });
  await actions.selectClaims(project.id, [claim.id], true);
  await actions.addObligation(project.id, {
    statement: "输出含 Usage",
    check: { checker: "cli", command: `node ${app}`, expect: { stdoutIncludes: ["Usage"] } },
  });
  const result = await actions.runCycle(project.id, {
    builder: { cwd: impl, timeoutMs: 5000 },
    command: "node -e 0",
    cwd: impl,
  });
  assert.equal(result.builder?.sessionId, "sess-cycle");
  assert.equal(result.builder?.reason, "idle");
  assert.deepEqual(
    sessions.calls.map(([name]) => name),
    ["create", "prompt", "wait"],
  );
  assert.equal(result.loop.closed, 1);
});

test("runCycle：缺 command 时报 invalid-input", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "No Command" });
  await assert.rejects(
    () => actions.runCycle(project.id, {}),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("runCycle：builder 会话被取消（input-required）也继续跑 loop", async () => {
  const sessions = fakeSessions();
  sessions.wait = async () => ({ reason: "input-required", output: null });
  const { actions, impl } = makeActions({ sessions });
  const project = await actions.openProject({ title: "Needs Input" });
  const claim = await actions.addClaim(project.id, { text: "x" });
  await actions.selectClaims(project.id, [claim.id], true);
  const result = await actions.runCycle(project.id, {
    builder: { cwd: impl },
    command: "node -e 0",
    cwd: impl,
  });
  assert.equal(result.builder?.reason, "input-required");
  assert.ok(result.loop.rounds.length >= 1);
});
