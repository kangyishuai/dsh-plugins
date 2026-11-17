// @ts-check
// 单元测试：builder 会话（M2.5）。注入假会话服务，不碰真宿主的模型调用。
// 覆盖：只投喂选中的结论、没有会话服务时明确报错、没有选中结论时拒绝、等待结果透传。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
 * @param {{ sessions?: any, runner?: any }} [options]
 */
function makeActions(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "casefile-builder-"));
  dirs.push(root);
  const actions = createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    sessions: options.sessions,
    runner: options.runner,
  });
  return { actions, root };
}

/** 假会话服务：记录调用。 */
function fakeSessions() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    create: async (/** @type {any} */ input) => {
      calls.push(["create", input]);
      return { sessionId: "sess-1" };
    },
    prompt: async (/** @type {any} */ input) => {
      calls.push(["prompt", input]);
    },
    wait: async (/** @type {any} */ input) => {
      calls.push(["wait", input]);
      return { reason: "idle", output: { records: [] } };
    },
  };
}

test("startBuilder：投喂规格包并落 builder 构建记录", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P" });
  const evidence = await actions.addEvidence("p", { summary: "POST /api/todos" });
  const claim = await actions.addClaim("p", {
    text: "新增待办走 POST",
    evidenceIds: [evidence.id],
  });
  await actions.selectClaims("p", [claim.id], true);

  const started = await actions.startBuilder("p", { cwd: "/tmp/impl" });
  assert.equal(started.builder.sessionId, "sess-1");
  assert.equal(started.builder.claims, 1);
  assert.ok(started.promptLength > 100);
  assert.deepEqual(
    sessions.calls.map(([name]) => name),
    ["create", "prompt"],
  );
  const prompt = String(sessions.calls[1][1].text);
  assert.match(prompt, /只允许依据下面的规格包实现/u);
  assert.match(prompt, /新增待办走 POST/u);
  assert.equal(sessions.calls[0][1].cwd, "/tmp/impl");

  const detail = await actions.detail("p");
  assert.equal(detail.builds.length, 1);
  assert.match(String(detail.builds[0].command), /^builder-session:sess-1$/u);
});

test("startBuilder：没有会话服务时报 builder-unavailable", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const claim = await actions.addClaim("p", { text: "x" });
  await actions.selectClaims("p", [claim.id], true);
  await assert.rejects(
    () => actions.startBuilder("p", { cwd: "/tmp/impl" }),
    (error) => /** @type {any} */ (error).code === "builder-unavailable",
  );
});

test("startBuilder：没有选中结论时拒绝（nothing-selected）", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P" });
  await actions.addClaim("p", { text: "未选中" });
  await assert.rejects(
    () => actions.startBuilder("p", { cwd: "/tmp/impl" }),
    (error) => /** @type {any} */ (error).code === "nothing-selected",
  );
});

test("startBuilder：cwd 为空被拒", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P" });
  const claim = await actions.addClaim("p", { text: "x" });
  await actions.selectClaims("p", [claim.id], true);
  await assert.rejects(
    () => actions.startBuilder("p", { cwd: "   " }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("awaitBuilder：透传 wait 的 reason", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P" });
  const result = await actions.awaitBuilder("p", { sessionId: "sess-1", timeoutMs: 1000 });
  assert.equal(result.reason, "idle");
  assert.equal(result.stopped, true);
  assert.equal(sessions.calls.at(-1)?.[1].timeoutMs, 1000);
});

test("awaitBuilder：空 sessionId 被拒", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P" });
  await assert.rejects(
    () => actions.awaitBuilder("p", { sessionId: "" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("startBuilder：按 featureIds 过滤规格", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P" });
  const feature = await actions.addFeature("p", { name: "登录" });
  const evidence = await actions.addEvidence("p", { summary: "登录接口" });
  const inFeature = await actions.addClaim("p", {
    text: "登录走 /auth",
    evidenceIds: [evidence.id],
    featureIds: [feature.id],
  });
  const outside = await actions.addClaim("p", { text: "无关结论" });
  await actions.selectClaims("p", [inFeature.id, outside.id], true);
  const started = await actions.startBuilder("p", { cwd: "/tmp/impl", featureIds: [feature.id] });
  assert.equal(started.builder.claims, 1);
  const prompt = String(sessions.calls[1][1].text);
  assert.match(prompt, /登录走 \/auth/u);
  assert.equal(prompt.includes("无关结论"), false);
});
