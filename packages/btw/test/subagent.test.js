// @ts-check
// fork 执行体（runSideQuestion）与 settle 分类的单测。
//
// 这一层过去没有测试：service.js 依赖宿主 RPC 协议不能直接 import，但 subagent.js
// 只依赖 limits/prompts（纯模块），用 fake ctx 就能覆盖超时/取消分类、guard 挂载与释放、
// 子会话归档失败、只读 guard 的作用域（AUD-BTW-02/06）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../lib/limits.js";
import {
  classifySettle,
  classifySettleError,
  observeUsage,
  resolveGuardTools,
  runSideQuestion,
} from "../lib/subagent.js";

/** 收集 llm/stream waterfall 监听器并跑一次假流。 */
function fakeUsageCtx() {
  /** @type {((options: any, next: any) => any)[]} */
  const listeners = [];
  return {
    listeners,
    ctx: {
      on: (/** @type {string} */ name, /** @type {any} */ fn) => {
        assert.equal(name, "llm/stream");
        listeners.push(fn);
      },
    },
  };
}

/** 用一次假 usage chunk 驱动 observeUsage 的观察器。 */
async function feedUsage(
  /** @type {{ listeners: any[] }} */ env,
  /** @type {string} */ sessionId,
  /** @type {any} */ usage,
) {
  const listener = env.listeners[0];
  assert.ok(listener, "observeUsage 必须注册 llm/stream 观察器");
  async function* inner() {
    yield { type: "text-delta", text: "x" };
    yield { type: "usage", usage };
  }
  for await (const _chunk of listener({ sessionId }, () => inner())) {
    // 只消费，不改写
  }
}

/**
 * 构造一个只含 runSideQuestion 所需成员的假 ctx。
 * @param {{ child?: any, archiveFails?: boolean, result?: (spec: any) => Promise<any>, startFails?: boolean }} [options]
 */
function fakeRunEnv(options = {}) {
  /** @type {{ pluginGuard: number, childGuards: Function[], released: Function[], archived: string[], usage: Map<string, any>, signals: AbortSignal[], warnings: string[] }} */
  const records = {
    pluginGuard: 0,
    childGuards: [],
    released: [],
    archived: [],
    usage: new Map(),
    signals: [],
    warnings: [],
  };
  const child =
    options.child === undefined
      ? undefined
      : {
          ctx: {
            tools: {
              guard: (/** @type {Function} */ fn) => {
                records.childGuards.push(fn);
                return () => records.released.push(fn);
              },
            },
          },
        };
  const ctx = {
    logger: {
      warn: (/** @type {string} */ message) => records.warnings.push(message),
    },
    subagents: {
      startActivation: async (/** @type {any} */ spec) => {
        records.signals.push(spec.signal);
        if (options.startFails === true || spec.signal?.aborted === true) {
          throw new Error("activation aborted");
        }
        return {
          childId: "child-1",
          result: options.result
            ? options.result(spec)
            : Promise.resolve({ stopReason: "done", output: [{ type: "text", text: "answer" }] }),
        };
      },
    },
    agents: {
      get: (/** @type {string} */ id) => (id === "child-1" ? child : undefined),
    },
    tools: {
      // 插件自己的 ctx：**绝不允许**被当成 guard 的兜底挂载点（会落到全局层）。
      guard: (/** @type {Function} */ _fn) => {
        records.pluginGuard += 1;
        return () => {};
      },
    },
  };
  const workspaceRegistry = {
    archiveSession: async (/** @type {string} */ childId) => {
      if (options.archiveFails === true) throw new Error("archive failed");
      records.archived.push(childId);
    },
  };
  return { ctx, records, workspaceRegistry };
}

const AGENT = { id: "session-parent", session: { snapshotEvents: () => [] } };

test("subagent: classifySettle 覆盖 done/truncated/空答案/超时/取消", () => {
  assert.deepEqual(classifySettle({ stopReason: "done", text: "a" }), {
    ok: true,
    status: "done",
  });
  assert.deepEqual(classifySettle({ stopReason: "done", text: "a", truncated: true }), {
    ok: true,
    status: "truncated",
  });
  assert.deepEqual(classifySettle({ stopReason: "done", text: "" }), {
    ok: false,
    status: "failed",
    code: "empty_answer",
  });
  assert.deepEqual(classifySettle({ stopReason: "aborted", outerAborted: false }), {
    ok: false,
    status: "timeout",
  });
  assert.deepEqual(classifySettle({ stopReason: "aborted", outerAborted: true }), {
    ok: false,
    status: "cancelled",
  });
});

test("subagent: classifySettleError 区分 fork 失败与超时/取消", () => {
  assert.deepEqual(classifySettleError({ aborted: false }), {
    ok: false,
    status: "failed",
    code: "fork_failed",
  });
  assert.deepEqual(classifySettleError({ aborted: true, outerAborted: false }), {
    ok: false,
    status: "timeout",
  });
  assert.deepEqual(classifySettleError({ aborted: true, outerAborted: true }), {
    ok: false,
    status: "cancelled",
  });
});

test("subagent: guard 只用子代理自己的 ctx，插件 ctx 永不做兜底（全局拒绝风险）", () => {
  const guardTools = () => ({ guard: () => () => {} });
  assert.equal(resolveGuardTools({ ctx: { tools: guardTools() } })?.guard !== undefined, true);
  assert.equal(resolveGuardTools(undefined), undefined);
  assert.equal(resolveGuardTools({}), undefined);
  assert.equal(resolveGuardTools({ ctx: {} }), undefined);
  assert.equal(resolveGuardTools({ ctx: { tools: {} } }), undefined, "没有 guard 方法就不是挂载点");
});

test("subagent: 正常路径在子代理上挂 guard，结束后释放、归档并清掉用量表", async () => {
  const env = fakeRunEnv({ child: {} });
  env.records.usage.set("child-1", { inputTokens: 3 });
  const outcome = await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.text, "answer");
  assert.equal(outcome.childId, "child-1");
  assert.equal(outcome.guardScope, "child", "guard 必须挂在子代理作用域");
  assert.equal(env.records.pluginGuard, 0, "插件 ctx 的 guard 一次都不能调用（会落到全局层）");
  assert.equal(env.records.childGuards.length, 1, "子代理 ctx 上挂一次");
  assert.equal(env.records.released.length, 1, "finally 里必须释放 guard");
  assert.deepEqual(env.records.warnings, [], "正常路径不应出现降级告警");
  assert.deepEqual(env.records.archived, ["child-1"], "子会话要归档");
  assert.deepEqual(outcome.usage, { inputTokens: 3 });
  assert.equal(
    env.records.usage.has("child-1"),
    false,
    "旁问结束后用量表要删掉子会话（不无限增长）",
  );
});

test("subagent: 取不到子代理 ctx 时不挂任何 guard，旁问照常进行", async () => {
  const env = fakeRunEnv({ child: undefined });
  const outcome = await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.guardScope, "none");
  assert.equal(env.records.pluginGuard, 0, "不能退回插件 ctx：那会把 guard 挂到全局层拒绝所有会话");
  assert.equal(env.records.childGuards.length, 0);
  assert.equal(env.records.warnings.length, 1, "降级不能静默：要留一条 warn 日志");
  assert.match(env.records.warnings[0], /read-only guard not armed/u);
});

test("subagent: guard 挂载抛错时降级但不静默，旁问照常返回", async () => {
  const env = fakeRunEnv({ child: {} });
  const childCtx = {
    tools: {
      guard: () => {
        throw new Error("boom");
      },
    },
  };
  env.ctx.agents.get = () => ({ ctx: childCtx });
  const outcome = await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.guardScope, "none");
  assert.equal(env.records.warnings.length, 1);
  assert.match(env.records.warnings[0], /boom/u);
  assert.equal(env.records.pluginGuard, 0);
});

test("subagent: 只读 guard 仍然拒绝白名单之外与 send_message", async () => {
  const env = fakeRunEnv({ child: {} });
  await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    allowedTools: new Set(),
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
  });
  const guard = env.records.childGuards[0];
  assert.equal(guard({ toolName: "read" }), "Side questions are read-only: they cannot use tools.");
  assert.equal(guard({ toolName: "send_message" }), "Side questions never message other agents.");
});

test("subagent: 子代理返回 aborted 且是内部超时 → timeout，保留已产出的部分文本", async () => {
  const env = fakeRunEnv({
    child: {},
    result: () =>
      Promise.resolve({
        stopReason: "aborted",
        output: [{ type: "text", text: "partial" }],
      }),
  });
  const outcome = await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.text, "partial");
  assert.equal(env.records.released.length, 1, "超时路径也要释放 guard");
});

test("subagent: 调用方 signal 已取消时不启动即返回 cancelled", async () => {
  const env = fakeRunEnv({ child: {} });
  const controller = new AbortController();
  controller.abort();
  const outcome = await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
    signal: controller.signal,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "cancelled");
  assert.equal(
    env.records.signals[0]?.aborted,
    true,
    "外层已取消时传给宿主的 signal 必须已 aborted",
  );
});

test("subagent: 运行中被调用方取消 → cancelled（不是 fork_failed）", async () => {
  const env = fakeRunEnv({
    child: {},
    result: (/** @type {any} */ spec) =>
      new Promise((_resolve, reject) => {
        // 只在 Controller 被中止时 reject：模拟宿主对已取消 activation 的拒绝。
        spec.signal.addEventListener("abort", () => reject(new Error("activation aborted")));
      }),
  });
  const controller = new AbortController();
  const pending = runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.ok, false);
  assert.equal(env.records.released.length, 1, "取消路径也要释放 guard");
});

test("subagent: 启动失败 → fork_failed；归档失败不影响结果", async () => {
  const env = fakeRunEnv({ child: {}, archiveFails: true });
  const outcome = await runSideQuestion({
    ctx: env.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: env.records.usage,
    workspaceRegistry: env.workspaceRegistry,
  });
  assert.equal(outcome.ok, true, "归档失败不改变旁问结果");

  const failed = fakeRunEnv({ startFails: true });
  const broken = await runSideQuestion({
    ctx: failed.ctx,
    agent: AGENT,
    question: "q",
    usageBySession: failed.records.usage,
    workspaceRegistry: failed.workspaceRegistry,
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.status, "failed");
  assert.equal(broken.code, "fork_failed");
});

test("subagent: 没有 subagents 服务 → subagents_unavailable（不抛）", async () => {
  const outcome = await runSideQuestion({
    ctx: {},
    agent: AGENT,
    question: "q",
    usageBySession: new Map(),
  });
  assert.deepEqual(
    { ok: outcome.ok, status: outcome.status, code: outcome.code },
    { ok: false, status: "failed", code: "subagents_unavailable" },
  );
});

test("subagent: observeUsage 只保留最近 N 个会话（内存卫生）", async () => {
  const env = fakeUsageCtx();
  const bySession = observeUsage(env.ctx);
  const total = LIMITS.usageSessions + 5;
  for (let i = 0; i < total; i += 1) {
    await feedUsage(env, `s${i}`, { inputTokens: i, cacheReadTokens: 0, outputTokens: 0 });
  }
  assert.equal(bySession.size, LIMITS.usageSessions);
  assert.equal(bySession.has("s0"), false, "最旧的会话被淘汰");
  assert.equal(bySession.has(`s${total - 1}`), true, "最新的会话保留");
  // 命中已有会话时刷新插入序：热会话不应被当成最旧淘汰
  await feedUsage(env, `s${total - 5}`, { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 });
  await feedUsage(env, "s-new", { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 });
  assert.equal(bySession.has(`s${total - 5}`), true, "刚用过的会话保留");
});
