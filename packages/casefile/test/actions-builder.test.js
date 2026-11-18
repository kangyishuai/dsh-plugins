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
  await actions.openProject({ title: "P", authTier: "authorized" });
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
  await actions.openProject({ title: "P", authTier: "authorized" });
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
  await actions.openProject({ title: "P", authTier: "authorized" });
  await actions.addClaim("p", { text: "未选中" });
  await assert.rejects(
    () => actions.startBuilder("p", { cwd: "/tmp/impl" }),
    (error) => /** @type {any} */ (error).code === "nothing-selected",
  );
});

test("startBuilder：cwd 为空被拒", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P", authTier: "authorized" });
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
  await actions.openProject({ title: "P", authTier: "authorized" });
  const result = await actions.awaitBuilder("p", { sessionId: "sess-1", timeoutMs: 1000 });
  assert.equal(result.reason, "idle");
  assert.equal(result.stopped, true);
  assert.equal(sessions.calls.at(-1)?.[1].timeoutMs, 1000);
});

test("awaitBuilder：空 sessionId 被拒", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P", authTier: "authorized" });
  await assert.rejects(
    () => actions.awaitBuilder("p", { sessionId: "" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("startBuilder：按 featureIds 过滤规格", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "P", authTier: "authorized" });
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

test("research 档默认禁止起 builder（auth-tier-blocked）", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "R", authTier: "research" });
  const claim = await actions.addClaim("r", { text: "x" });
  await actions.selectClaims("r", [claim.id], true);
  await assert.rejects(
    () => actions.startBuilder("r", { cwd: "/tmp/impl" }),
    (error) => /** @type {any} */ (error).code === "auth-tier-blocked",
  );
  assert.equal(sessions.calls.length, 0, "被拒时不应该建会话");
});

test("research 档显式覆盖后可以起 builder，并写审计", async () => {
  const sessions = fakeSessions();
  const { actions } = makeActions({ sessions });
  await actions.openProject({ title: "R2", authTier: "research" });
  const claim = await actions.addClaim("r2", { text: "x" });
  await actions.selectClaims("r2", [claim.id], true);
  const started = await actions.startBuilder("r2", {
    cwd: "/tmp/impl",
    allowResearchTier: true,
    reason: "有书面授权",
  });
  assert.equal(started.builder.sessionId, "sess-1");
  const audit = await actions.readAudit("r2");
  assert.ok(
    audit.some((item) => item.action === "auth/research-override"),
    "覆盖必须留下审计",
  );
});

test("authorized / owned 档不需要覆盖", async () => {
  for (const tier of ["authorized", "owned"]) {
    const sessions = fakeSessions();
    const { actions } = makeActions({ sessions });
    const project = await actions.openProject({ title: `T-${tier}`, authTier: tier });
    const claim = await actions.addClaim(project.id, { text: "x" });
    await actions.selectClaims(project.id, [claim.id], true);
    const started = await actions.startBuilder(project.id, { cwd: "/tmp/impl" });
    assert.equal(started.builder.sessionId, "sess-1");
  }
});
