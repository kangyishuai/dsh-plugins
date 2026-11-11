// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAnchorVerdict, buildIndex, extractPaths, verifyAnchors } from "../lib/anchors.js";

const messages = [
  {
    id: "m1",
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "改一下 src/retry.ts" }],
  },
  {
    id: "m2",
    role: "assistant",
    source: { kind: "model" },
    content: [
      { type: "text", text: "先看 src/retry.ts 的实现。" },
      { type: "tool-call", id: "call_1", name: "bash", arguments: '{"command":"rg retry src"}' },
    ],
  },
  {
    id: "m3",
    role: "tool",
    source: { kind: "tool" },
    toolCallId: "call_1",
    content: [{ type: "text", text: "src/retry.ts:1" }],
  },
];

test("buildIndex 收集 call id / message id / 路径", () => {
  const index = buildIndex(messages);
  assert.equal(index.callIds.has("call_1"), true);
  assert.equal(index.messageIds.has("m1"), true);
  assert.equal(index.paths.has("src/retry.ts"), true);
  assert.equal(index.toolNames.has("bash"), true);
});

test("extractPaths 只抽像路径的串", () => {
  assert.deepEqual(extractPaths("见 src/retry.ts 与 ./lib/a.js，不是 retry 也不是 v1.2"), [
    "src/retry.ts",
    "lib/a.js",
  ]);
});

test("verifyAnchors：工具调用 id 与路径能对上", () => {
  const index = buildIndex(messages);
  const result = verifyAnchors(
    [
      { kind: "tool_result", ref: "call_1" },
      { kind: "file", ref: "src/retry.ts" },
    ],
    index,
    "改一下 src/retry.ts",
  );
  assert.equal(result.verified, 2);
  assert.equal(result.unverified, 0);
  assert.deepEqual(
    result.checks.map((c) => c.verified),
    [true, true],
  );
});

test("verifyAnchors：编造的 id 与不存在的路径被判为未验证", () => {
  const index = buildIndex(messages);
  const result = verifyAnchors(
    [
      { kind: "tool_result", ref: "call_999" },
      { kind: "file", ref: "src/nowhere.ts" },
    ],
    index,
    "改一下 src/retry.ts",
  );
  assert.equal(result.verified, 0);
  assert.equal(result.unverified, 2);
  assert.match(result.checks[0].reason, /没有这个工具调用/u);
  assert.match(result.checks[1].reason, /没有这个路径/u);
});

test("verifyAnchors：message kind 校验消息 id，未知 kind 退化为文本包含", () => {
  const index = buildIndex(messages);
  const ok = verifyAnchors(
    [
      { kind: "message", ref: "m2" },
      { kind: "note", ref: "指数退避" },
    ],
    index,
    "改成指数退避",
  );
  assert.equal(ok.verified, 2);

  const bad = verifyAnchors([{ kind: "message", ref: "m404" }], index, "");
  assert.equal(bad.verified, 0);
});

test("applyAnchorVerdict：有锚点但全没对上 → 降一档并追加提示", () => {
  const result = verifyAnchors(
    [{ kind: "tool_result", ref: "call_999" }],
    buildIndex(messages),
    "",
  );
  const verdict = applyAnchorVerdict({ severity: "blocker", advice: "会丢数据" }, result);
  assert.equal(verdict.severity, "concern");
  assert.equal(verdict.downgraded, true);
  assert.match(verdict.advice, /证据锚点未对上/u);
});

test("applyAnchorVerdict：至少一条对上、或完全没给锚点，都不降级", () => {
  const verified = verifyAnchors(
    [{ kind: "tool_result", ref: "call_1" }],
    buildIndex(messages),
    "",
  );
  assert.equal(
    applyAnchorVerdict({ severity: "blocker", advice: "x" }, verified).downgraded,
    false,
  );

  const none = verifyAnchors([], buildIndex(messages), "");
  const verdict = applyAnchorVerdict({ severity: "blocker", advice: "x" }, none);
  assert.equal(verdict.downgraded, false);
  assert.equal(verdict.severity, "blocker");
});
