// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTranscript, clip, isInjectedContext } from "../lib/transcript.js";

/**
 * @param {string} role
 * @param {any[]} content
 * @param {Record<string, unknown>} [extra]
 * @returns {any}
 */
function message(role, content, extra = {}) {
  return { role, content, source: { kind: "user" }, ...extra };
}

const sample = [
  message("system", [{ type: "text", text: "你是一个 AI agent。" }]),
  message("user", [{ type: "text", text: "把 retry 改成指数退避" }]),
  message("assistant", [
    { type: "text", text: "我先看现有实现。" },
    { type: "tool-call", id: "call_1", name: "bash", arguments: '{"command":"rg retry src"}' },
  ]),
  message("tool", [{ type: "text", text: "src/retry.ts:12: const delay = 100" }], {
    toolCallId: "call_1",
    isError: false,
  }),
  message("assistant", [
    { type: "text", text: "改成 2 的幂。" },
    { type: "tool-call", id: "call_2", name: "advisor", arguments: "{}" },
  ]),
  message("tool", [{ type: "text", text: "顾问说：先补测试。" }], { toolCallId: "call_2" }),
];

test("包含工具调用与工具结果，并排除我们自己的工具调用", () => {
  const { text, stats } = buildTranscript(sample, { scope: "summary" });
  assert.equal(text.includes("[工具调用] bash"), true);
  assert.equal(text.includes("[工具结果]"), true);
  assert.equal(text.includes("src/retry.ts"), true);
  assert.equal(text.includes("advisor("), false, "顾问自己的调用不能回喂给顾问");
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.toolResults, 1);
});

test("scope=off 时不发工具往来", () => {
  const { text } = buildTranscript(sample, { scope: "off" });
  assert.equal(text.includes("[工具调用]"), false);
  assert.equal(text.includes("[工具结果]"), false);
  assert.equal(text.includes("把 retry 改成指数退避"), true);
});

test("system / developer 消息不进 transcript", () => {
  const { text } = buildTranscript(sample, { scope: "summary" });
  assert.equal(text.includes("你是一个 AI agent"), false);
});

test("超长工具结果被截断并留痕", () => {
  const long = "x".repeat(5000);
  const messages = [
    message("user", [{ type: "text", text: "go" }]),
    message("tool", [{ type: "text", text: long }], { toolCallId: "c" }),
  ];
  const { text, stats } = buildTranscript(messages, { scope: "summary" });
  assert.equal(text.includes("已截断，原长 5000 字符"), true);
  assert.equal(stats.truncated > 0, true);
});

test("脱敏在截断之前生效", () => {
  const messages = [
    message("user", [{ type: "text", text: `token: sk-abcdefghijklmnopqrstuvwxyz` }]),
  ];
  const { text, stats } = buildTranscript(messages, { scope: "summary", redactSecrets: true });
  assert.equal(text.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(stats.redactions.includes("sk-token"), true);

  const raw = buildTranscript(messages, { scope: "summary", redactSecrets: false });
  assert.equal(raw.text.includes("sk-abcdefghijklmnopqrstuvwxyz"), true);
});

test("总预算超限时保留首尾并插入省略标记", () => {
  const messages = [];
  for (let index = 0; index < 40; index += 1) {
    messages.push(message("user", [{ type: "text", text: `第 ${index} 条：${"y".repeat(200)}` }]));
  }
  const { text } = buildTranscript(messages, { scope: "summary", maxChars: 1000 });
  assert.equal(text.length <= 1200, true);
  assert.equal(text.includes("中间省略"), true);
  assert.equal(text.includes("第 0 条"), true, "开头要保留（任务与约束）");
});

test("clip：0 表示整段丢弃", () => {
  assert.equal(clip("abc", 0), "");
  assert.equal(clip("abc", 10), "abc");
  assert.equal(clip("abcdef", 3), "abc…（已截断，原长 6 字符）");
});

test("宿主注入的上下文默认只留长度标记（技能目录/AGENTS.md 不该整段发给顾问）", () => {
  const context = message("user", [{ type: "text", text: "x".repeat(5000) }], {
    source: { kind: "runtime-context" },
  });
  const result = buildTranscript(
    [message("user", [{ type: "text", text: "改一下 retry" }]), context],
    {
      scope: "summary",
    },
  );
  assert.equal(result.text.includes("x".repeat(1000)), false, "正文不应整段出现");
  assert.equal(result.text.includes("[上下文(runtime-context)]"), true);
  assert.equal(result.stats.contextOmitted > 0, true, "应记录被省略的字符数");
  assert.equal(result.text.includes("改一下 retry"), true, "真人输入必须保留");
});

test("scope=off 时宿主上下文完全不发；scope=full 放宽到 2000 字符", () => {
  const context = message("user", [{ type: "text", text: "y".repeat(3000) }], {
    source: { kind: "runtime-context" },
  });
  const off = buildTranscript([context], { scope: "off" });
  assert.equal(off.text.includes("y".repeat(100)), false);
  assert.equal(off.text.includes("已省略 3000 字符"), true);

  const full = buildTranscript([context], { scope: "full" });
  assert.equal(full.text.includes("y".repeat(1900)), true);
  assert.equal(full.text.includes("y".repeat(2100)), false);
});

test("isInjectedContext 只认 user 角色且 source.kind 非 user", () => {
  assert.equal(isInjectedContext({ role: "user", source: { kind: "user" } }), false);
  assert.equal(isInjectedContext({ role: "user", source: { kind: "user-rpc" } }), false);
  assert.equal(isInjectedContext({ role: "user", source: { kind: "runtime-context" } }), true);
  assert.equal(isInjectedContext({ role: "assistant", source: { kind: "model" } }), false);
  assert.equal(isInjectedContext({ role: "user" }), false);
});
