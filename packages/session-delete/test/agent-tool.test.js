// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentToolController,
  normalizeToolError,
  summarizePlanForModel,
} from "../lib/agent-tool.js";

/** @param {{ digest?: string, blockers?: any[], children?: any[] }} [overrides] */
function fakeOps(overrides = {}) {
  const calls = { trash: /** @type {any[]} */ ([]) };
  const plan = {
    sessionId: "session-abc",
    title: "hello",
    sizeBytes: 1024,
    live: false,
    children: [],
    blockers: [],
    digest: "digest-1",
    ...overrides,
  };
  return {
    calls,
    plan: async () => ({ ...plan, ...overrides }),
    trash: async (/** @type {string} */ sessionId, /** @type {any} */ request) => {
      calls.trash.push({ sessionId, request });
      return { entryId: "entry-1", receiptId: "receipt-1", cascaded: [], removed: [] };
    },
  };
}

test("plan 返回一次性 token 与摘要", async () => {
  const ops = fakeOps();
  const controller = createAgentToolController({ ops });
  const result = await controller.plan({ sessionId: "session-abc", cascade: true });
  assert.equal(result.ok, true);
  assert.equal(result.digest, "digest-1");
  assert.equal(result.cascade, true);
  assert.equal(typeof result.token, "string");
  assert.match(summarizePlanForModel(result), /Delete preview for hello/);
  assert.equal(controller.size(), 1);
});

test("blocked 的 plan 不发 token", async () => {
  const ops = fakeOps({
    blockers: [{ code: "session-delete/location-unknown", message: "no dir" }],
  });
  const controller = createAgentToolController({ ops });
  const result = await controller.plan({ sessionId: "session-abc" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "blocked");
  assert.equal(controller.size(), 0);
});

test("delete 必须带 token，且 token 只能用一次", async () => {
  const ops = fakeOps();
  const controller = createAgentToolController({ ops });
  const preview = await controller.plan({ sessionId: "session-abc" });
  const first = await controller.remove({ sessionId: "session-abc", token: preview.token });
  assert.equal(first.ok, true);
  assert.equal(ops.calls.trash.length, 1);
  assert.equal(ops.calls.trash[0].request.operator, "agent");
  const second = await controller.remove({ sessionId: "session-abc", token: preview.token });
  assert.equal(second.ok, false);
  assert.equal(second.code, "invalid-token");
});

test("拒绝删除调用者自己的会话", async () => {
  const ops = fakeOps();
  const controller = createAgentToolController({ ops });
  const preview = await controller.plan({ sessionId: "session-abc" });
  const result = await controller.remove({
    sessionId: "session-abc",
    token: preview.token,
    callerSessionId: "session-abc",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "caller-session");
  assert.equal(ops.calls.trash.length, 0);
});

test("token 过期 / 会话变化都拒绝", async () => {
  let clock = 1_000;
  const ops = fakeOps();
  const controller = createAgentToolController({ ops, now: () => clock, ttlMs: 1000 });
  const preview = await controller.plan({ sessionId: "session-abc" });
  clock += 2000;
  const expired = await controller.remove({ sessionId: "session-abc", token: preview.token });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "token-expired");

  const staleOps = fakeOps();
  const staleController = createAgentToolController({ ops: staleOps });
  const stalePreview = await staleController.plan({ sessionId: "session-abc" });
  staleOps.plan = async () => ({
    sessionId: "session-abc",
    title: "hello",
    sizeBytes: 4096,
    live: false,
    children: [],
    blockers: [],
    digest: "digest-2",
  });
  const stale = await staleController.remove({
    sessionId: "session-abc",
    token: stalePreview.token,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale-plan");
  assert.equal(staleOps.calls.trash.length, 0);
});

test("cascade 从预览继承到执行", async () => {
  const ops = fakeOps();
  const controller = createAgentToolController({ ops });
  const preview = await controller.plan({ sessionId: "session-abc", cascade: true });
  await controller.remove({ sessionId: "session-abc", token: preview.token });
  assert.equal(ops.calls.trash[0].request.cascade, true);
});

test("内部错误归一成模型友好的 code", () => {
  const notFound = Object.assign(new Error("no session named x"), { code: "session/not-found" });
  assert.deepEqual(normalizeToolError(notFound), {
    ok: false,
    code: "not-found",
    message: "no session named x",
  });
  assert.equal(normalizeToolError(new Error("boom")).code, "error");
});
