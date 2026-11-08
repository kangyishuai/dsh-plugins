// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRewindToolDefinition,
  describeToolImpact,
  installRewindTool,
  listToolCandidates,
  TOOL_NAME,
} from "../lib/tool.js";

/**
 * @param {number} seq @param {string} text @param {any} [source]
 */
function userEvent(seq, text, source = { kind: "user" }) {
  return {
    seq,
    type: "user/message",
    time: 1000 + seq,
    surfaceOp: "append",
    data: { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source },
  };
}

/** @param {number} seq @param {string} text */
function assistantEvent(seq, text) {
  return {
    seq,
    type: "assistant/message",
    time: 1000 + seq,
    surfaceOp: "append",
    data: { id: `a${seq}`, role: "assistant", content: [{ type: "text", text }] },
  };
}

const log = [
  userEvent(1, "first question"),
  assistantEvent(2, "first answer"),
  userEvent(3, "second question about deploy"),
  assistantEvent(4, "second answer"),
  userEvent(5, "third question"),
];
const nodes = [1, 2, 3, 4, 5];

test("listToolCandidates 返回倒序候选并支持搜索", () => {
  const all = listToolCandidates(log, nodes, {});
  assert.equal(all.items.length, 3);
  assert.equal(all.items[0].seq, 5);
  assert.equal(all.items[2].seq, 1);
  const filtered = listToolCandidates(log, nodes, { query: "deploy" });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].seq, 3);
});

test("listToolCandidates 夹紧 limit", () => {
  assert.equal(listToolCandidates(log, nodes, { limit: 1 }).items.length, 1);
  assert.equal(listToolCandidates(log, nodes, { limit: 9999 }).items.length, 3);
});

test("listToolCandidates 忽略注入上下文的用户消息", () => {
  const withInjection = [
    userEvent(1, "real question"),
    userEvent(2, "runtime context", { kind: "runtime-context" }),
  ];
  const listed = listToolCandidates(withInjection, [1, 2], {});
  assert.deepEqual(
    listed.items.map((item) => item.seq),
    [1],
  );
});

test("describeToolImpact 报告撤回条数与目标文本", () => {
  const impact = describeToolImpact(log, nodes, 3);
  assert.equal(impact.ok, true);
  if (impact.ok !== true) return;
  assert.equal(impact.targetSeq, 3);
  assert.equal(impact.removedCount, 3);
  assert.equal(impact.crossesOpenToolCall, false);
  assert.match(impact.text, /deploy/u);
});

test("describeToolImpact 对不可达目标返回错误码", () => {
  const impact = describeToolImpact(log, nodes, 99);
  assert.equal(impact.ok, false);
});

test("describeToolImpact 识别未完成的工具调用", () => {
  const withOpenCall = [
    userEvent(1, "go"),
    { seq: 2, type: "tool/call", time: 1002, surfaceOp: "append", data: { callId: "c1" } },
  ];
  const impact = describeToolImpact(withOpenCall, [1, 2], 1);
  assert.equal(impact.ok, true);
  if (impact.ok !== true) return;
  assert.equal(impact.crossesOpenToolCall, true);
});

test("工具定义结构符合宿主 registry 要求", () => {
  const definition = createRewindToolDefinition({ call: async () => ({ ok: true, value: {} }) });
  assert.equal(definition.name, TOOL_NAME);
  assert.equal(definition.parameters.type, "object");
  assert.equal(typeof definition.output.render, "function");
  assert.equal(typeof definition.execute, "function");
  assert.equal(definition.output.schema.type, "object");
});

test("render 输出列表与影响面文案", () => {
  const definition = createRewindToolDefinition({ call: async () => ({}) });
  const listText = definition.output.render(
    {},
    {
      kind: "list",
      candidates: [{ seq: 5, preview: "third question" }],
    },
  )[0].text;
  assert.match(listText, /#5/u);
  assert.match(listText, /user action/u);
  const impactText = definition.output.render(
    {},
    {
      kind: "impact",
      impact: { target_seq: 3, removed_messages: 3, crosses_open_tool_call: true, text: "second" },
    },
  )[0].text;
  assert.match(impactText, /withdraw 3 message/u);
  assert.match(impactText, /unfinished tool call/u);
});

test("execute 无会话时返回错误而不抛", async () => {
  const definition = createRewindToolDefinition({ call: async () => ({ ok: true, value: {} }) });
  const value = await definition.execute({}, {});
  assert.equal(value.kind, "error");
});

test("execute 把 host 结果原样返回", async () => {
  /** @type {any[]} */
  const seen = [];
  const definition = createRewindToolDefinition({
    call: async (sessionId, request) => {
      seen.push({ sessionId, request });
      return { ok: true, value: { kind: "list", candidates: [] } };
    },
  });
  const value = await definition.execute(
    { query: "deploy", limit: 5, target_seq: 3 },
    { agent: { session: { id: "s1" } } },
  );
  assert.equal(value.kind, "list");
  assert.deepEqual(seen, [
    { sessionId: "s1", request: { query: "deploy", limit: 5, targetSeq: 3 } },
  ]);
});

test("installRewindTool 在没有 tools 服务时安静跳过", () => {
  /** @type {any[]} */
  const warnings = [];
  const ok = installRewindTool({
    ctx: { get: () => undefined },
    host: { call: async () => ({ ok: true, value: {} }) },
    logger: { warn: (/** @type {string} */ message) => warnings.push(message) },
  });
  assert.equal(ok, false);
  assert.equal(warnings.length, 0);
});

test("installRewindTool 通过 inject 注册并挂到 effect", () => {
  /** @type {any[]} */
  const registered = [];
  /** @type {any[]} */
  const effects = [];
  const ctx = {
    inject: (/** @type {any} */ _deps, /** @type {any} */ cb) => {
      cb({
        tools: {
          register: (/** @type {any} */ definition) => {
            registered.push(definition);
            return () => {};
          },
        },
        effect: (/** @type {any} */ fn) => effects.push(fn),
      });
    },
  };
  const ok = installRewindTool({ ctx, host: { call: async () => ({ ok: true, value: {} }) } });
  assert.equal(ok, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, TOOL_NAME);
  assert.equal(effects.length, 1);
});
