// @ts-check
// plan.js 的纯函数单测：候选排序/过滤、回溯区间、全部错误码、marker 区间还原。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cutsOf,
  DEFAULT_CANDIDATE_LIMIT,
  isHumanUserMessageEvent,
  isMarkerEvent,
  isUserMessageEvent,
  listCandidates,
  MARKER_SOURCE_KIND,
  MARKER_TEXT,
  messagePreview,
  messageText,
  PREVIEW_MAX_CHARS,
  planRewind,
  previewOf,
  textOf,
} from "../lib/plan.js";

/**
 * @typedef {object} TestEvent
 * @property {number} seq
 * @property {number} time
 * @property {string} type
 * @property {any} data
 */

/**
 * 断言 planRewind 返回了成功结果，并把它收窄成 RewindPlan。
 * @param {any} result
 * @returns {import("../lib/plan.js").RewindPlan}
 */
function expectPlan(result) {
  if (result?.error !== undefined) assert.fail(result.error.message);
  return result;
}

/**
 * @param {string} text
 * @param {Record<string, any>} [source]
 * @returns {any}
 */
function userMessage(text, source = { kind: "user" }) {
  return { id: `user-${text}`, role: "user", content: [{ type: "text", text }], source };
}

/**
 * @param {number} seq
 * @param {any} data
 * @param {string} [type]
 * @returns {TestEvent}
 */
function event(seq, data, type = "user/message") {
  return { seq, time: 1_700_000_000_000 + seq, type, data };
}

/**
 * @param {number} seq
 * @param {number} targetSeq
 * @returns {TestEvent}
 */
function markerEvent(seq, targetSeq) {
  return event(
    seq,
    userMessage(MARKER_TEXT, { kind: MARKER_SOURCE_KIND, targetSeq }),
    "user/message",
  );
}

/**
 * @param {number} seq
 * @returns {TestEvent}
 */
function systemEvent(seq) {
  return event(
    seq,
    { role: "system", content: [], source: { kind: "system-prompt" } },
    "system/message",
  );
}

/**
 * 一份典型日志：0 系统提示、1 第一条用户消息、2 助手、3 第二条用户消息、
 * 4 注入的 context（不是真人）、5 第三条用户消息、6 一个 marker。
 * surface 上 4 已被 compaction 遮蔽。
 * @returns {TestEvent[]}
 */
function sampleLog() {
  return [
    systemEvent(0),
    event(1, userMessage("first")),
    event(
      2,
      {
        message: {
          role: "assistant",
          content: [],
          source: { kind: "model", provider: "p", model: "m" },
        },
      },
      "assistant/message",
    ),
    event(3, userMessage("second")),
    event(4, userMessage("injected", { kind: "runtime-context" })),
    event(5, userMessage("third")),
    markerEvent(6, 3),
  ];
}

test("常量与设计约定一致", () => {
  assert.equal(MARKER_SOURCE_KIND, "session-rewind");
  assert.equal(MARKER_TEXT, "(empty message)");
  assert.equal(PREVIEW_MAX_CHARS, 80);
  assert.ok(DEFAULT_CANDIDATE_LIMIT > 0);
});

test("messageText 拼接文本块、忽略非文本块", () => {
  const message = {
    content: [
      { type: "text", text: "hello " },
      { type: "image", data: "..." },
      { type: "text", text: "world" },
    ],
  };
  assert.equal(messageText(message), "hello world");
  assert.equal(messageText({ content: [] }), "");
  assert.equal(messageText({}), "");
  assert.equal(messageText(undefined), "");
});

test("messagePreview 折叠空白并按字符数截断", () => {
  assert.equal(messagePreview(userMessage("  a\n\n b  ")), "a b");
  const long = "x".repeat(PREVIEW_MAX_CHARS + 20);
  const preview = messagePreview(userMessage(long));
  assert.equal(preview.length, PREVIEW_MAX_CHARS);
  assert.ok(preview.endsWith("…"));
  // 自定义上限
  assert.equal(messagePreview(userMessage("abcdef"), 4), "abc…");
  assert.equal(messagePreview(userMessage("abc"), 4), "abc");
  // 非法上限回退到默认值
  assert.equal(messagePreview(userMessage("abc"), 0), "abc");
});

test("textOf / previewOf 是设计文档里的别名", () => {
  assert.equal(textOf, messageText);
  assert.equal(previewOf, messagePreview);
});

test("isUserMessageEvent / isHumanUserMessageEvent / isMarkerEvent 的边界", () => {
  const human = event(1, userMessage("hi"));
  const injected = event(2, userMessage("ctx", { kind: "runtime-context" }));
  const marker = markerEvent(3, 1);
  const assistant = event(4, { message: { role: "assistant" } }, "assistant/message");

  assert.equal(isUserMessageEvent(human), true);
  assert.equal(isUserMessageEvent(assistant), false);
  assert.equal(isUserMessageEvent(null), false);

  assert.equal(isHumanUserMessageEvent(human), true);
  assert.equal(isHumanUserMessageEvent(injected), false);
  assert.equal(isHumanUserMessageEvent(marker), false);
  assert.equal(isHumanUserMessageEvent(assistant), false);
  assert.equal(isHumanUserMessageEvent({ type: "user/message" }), false);

  assert.equal(isMarkerEvent(marker), true);
  assert.equal(isMarkerEvent(human), false);
  assert.equal(isMarkerEvent(injected), false);
  assert.equal(isMarkerEvent(assistant), false);
});

test("listCandidates 只收 surface 上的真人消息，最新在前并带 1 基 index", () => {
  const log = sampleLog();
  const surface = [0, 1, 2, 3, 5, 6];
  const candidates = listCandidates(log, surface);

  assert.deepEqual(
    candidates.map((candidate) => candidate.seq),
    [5, 3, 1],
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.index),
    [1, 2, 3],
  );
  assert.equal(candidates[0].text, "third");
  assert.equal(candidates[0].preview, "third");
  assert.equal(candidates[0].time, 1_700_000_000_000 + 5);
  // marker 与注入的 context 都不是候选
  assert.ok(!candidates.some((candidate) => candidate.seq === 4 || candidate.seq === 6));
});

test("listCandidates 的 limit 生效，非法 limit 回退默认值", () => {
  const log = sampleLog();
  const surface = [0, 1, 2, 3, 5, 6];
  assert.deepEqual(
    listCandidates(log, surface, 2).map((candidate) => candidate.seq),
    [5, 3],
  );
  assert.deepEqual(listCandidates(log, surface, 0), []);
  assert.deepEqual(
    listCandidates(log, surface, /** @type {any} */ (-1)).map((candidate) => candidate.seq),
    [5, 3, 1],
  );
  assert.deepEqual(
    listCandidates(log, surface, /** @type {any} */ (1.5)).map((candidate) => candidate.seq),
    [5, 3, 1],
  );
});

test("listCandidates 排除被 compaction 遮蔽的用户消息", () => {
  const log = sampleLog();
  // 只剩系统提示和最后一条用户消息在 surface 上
  const candidates = listCandidates(log, [0, 5]);
  assert.deepEqual(
    candidates.map((candidate) => candidate.seq),
    [5],
  );
});

test("listCandidates 对空/异常输入返回空数组", () => {
  assert.deepEqual(listCandidates(undefined, undefined), []);
  assert.deepEqual(listCandidates([], []), []);
  assert.deepEqual(listCandidates(sampleLog(), undefined), []);
});

test("planRewind 从目标消息遮蔽到最后一个 surface 节点", () => {
  const log = sampleLog();
  const surface = [0, 1, 2, 3, 5, 6];
  const plan = expectPlan(planRewind(log, surface, 3));

  assert.equal(plan.targetSeq, 3);
  assert.equal(plan.targetIndex, 3);
  assert.deepEqual(plan.shadowedSeqs, [3, 5, 6]);
  assert.equal(plan.surfaceStart, 3);
  assert.equal(plan.surfaceEnd, 6);
  assert.equal(plan.text, "second");
});

test("planRewind 目标是最后一个节点时只遮蔽它自己", () => {
  const log = [systemEvent(0), event(1, userMessage("only"))];
  const plan = expectPlan(planRewind(log, [0, 1], 1));
  assert.deepEqual(plan.shadowedSeqs, [1]);
  assert.equal(plan.surfaceStart, 1);
  assert.equal(plan.surfaceEnd, 1);
});

test("planRewind 的错误码：bad-target", () => {
  const log = sampleLog();
  const surface = [0, 1, 2, 3, 5, 6];
  /** @type {Array<[string, any]>} */
  const cases = [
    ["不存在的 seq", 99],
    ["系统消息", 0],
    ["助手消息", 2],
    ["注入的 context", 4],
    ["marker 自身", 6],
    ["负数", -1],
    ["小数", 1.5],
    ["字符串", "3"],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [label, targetSeq] of cases) {
    const result = planRewind(log, surface, targetSeq);
    assert.ok("error" in result, `${label} 应返回错误`);
    if (!("error" in result)) continue;
    assert.equal(result.error.code, "bad-target", `${label} 的 code`);
    assert.equal(typeof result.error.message, "string");
    assert.ok(result.error.message.length > 0);
  }
});

test("planRewind 的错误码：not-on-surface", () => {
  const log = sampleLog();
  // seq 3 已不在 surface 上（被 compaction 遮蔽）
  const result = planRewind(log, [0, 5, 6], 3);
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error.code, "not-on-surface");
  assert.match(result.error.message, /model context/);
});

test("planRewind 对空/异常 surface 输入不抛异常", () => {
  const result = planRewind(sampleLog(), undefined, 1);
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error.code, "not-on-surface");

  const noEvents = planRewind(undefined, [0, 1], 1);
  assert.ok("error" in noEvents);
  if (!("error" in noEvents)) return;
  assert.equal(noEvents.error.code, "bad-target");
});

test("cutsOf 从多个 marker 还原区间，保持日志顺序", () => {
  const log = [
    event(0, userMessage("first")),
    markerEvent(1, 0),
    event(2, userMessage("second")),
    markerEvent(3, 2),
    // 非 marker 的普通用户消息/助手消息不影响结果
    event(4, userMessage("third")),
    event(5, { message: { role: "assistant" } }, "assistant/message"),
  ];
  assert.deepEqual(cutsOf(log), [
    { targetSeq: 0, markerSeq: 1 },
    { targetSeq: 2, markerSeq: 3 },
  ]);
});

test("cutsOf 跳过形状不完整的 marker", () => {
  const log = [
    event(0, userMessage("first")),
    markerEvent(1, 0),
    // targetSeq 非法
    event(2, userMessage(MARKER_TEXT, { kind: MARKER_SOURCE_KIND })),
    event(3, userMessage(MARKER_TEXT, { kind: MARKER_SOURCE_KIND, targetSeq: -1 })),
    event(4, userMessage(MARKER_TEXT, { kind: MARKER_SOURCE_KIND, targetSeq: 1.5 })),
    event(5, userMessage(MARKER_TEXT, { kind: MARKER_SOURCE_KIND, targetSeq: "1" })),
    // targetSeq 指向 marker 自己之后
    event(6, userMessage(MARKER_TEXT, { kind: MARKER_SOURCE_KIND, targetSeq: 6 })),
    // 其他 kind 的 user/message 不是 marker
    event(7, userMessage(MARKER_TEXT, { kind: "compact-checkpoint" })),
  ];
  assert.deepEqual(cutsOf(log), [{ targetSeq: 0, markerSeq: 1 }]);
});

test("cutsOf 对空/异常输入返回空数组", () => {
  assert.deepEqual(cutsOf(undefined), []);
  assert.deepEqual(cutsOf([]), []);
});

test("listCandidatesPage：分页 / 搜索 / 全局 index", async () => {
  const { listCandidatesPage } = await import("../lib/plan.js");
  /** @param {number} seq @param {string} text */
  const user = (seq, text) => ({
    seq,
    type: "user/message",
    time: seq,
    data: { role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
  });
  const events = [user(1, "alpha one"), user(3, "beta two"), user(5, "alpha three")];
  const surface = [1, 3, 5];
  const page1 = listCandidatesPage(events, surface, { limit: 2 });
  assert.deepEqual(
    page1.candidates.map((/** @type {any} */ item) => item.seq),
    [5, 3],
  );
  assert.equal(page1.candidates[0].index, 1);
  assert.equal(page1.candidates[1].index, 2);
  assert.equal(page1.nextCursor, 3);
  const page2 = listCandidatesPage(events, surface, { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(
    page2.candidates.map((/** @type {any} */ item) => item.seq),
    [1],
  );
  assert.equal(page2.nextCursor, null);
  const searched = listCandidatesPage(events, surface, { q: "ALPHA" });
  assert.deepEqual(
    searched.candidates.map((/** @type {any} */ item) => item.seq),
    [5, 1],
  );
});

test("hasOpenToolCalls 只统计目标之后未闭合的调用", async () => {
  const { hasOpenToolCalls } = await import("../lib/plan.js");
  const events = [
    { seq: 0, type: "tool/call", time: 0, data: { callId: "c1" } },
    { seq: 1, type: "tool/result", time: 0, data: { message: { role: "tool", toolCallId: "c1" } } },
    { seq: 2, type: "tool/call", time: 0, data: { callId: "c2" } },
  ];
  assert.equal(hasOpenToolCalls(events, 0), true);
  assert.equal(hasOpenToolCalls(events, 2), true);
  assert.equal(hasOpenToolCalls(events, 3), false);
});

test("messageImages / targetContent 提取图片引用", async () => {
  const { messageImages, targetContent } = await import("../lib/plan.js");
  const message = {
    role: "user",
    content: [
      { type: "text", text: "look" },
      {
        type: "image",
        attachment: {
          attachmentId: "a1",
          mediaType: "image/png",
          bytes: 12,
          width: 1,
          height: 2,
          name: "x.png",
        },
      },
      { type: "image", attachment: { attachmentId: "bad" } },
    ],
  };
  assert.deepEqual(messageImages(message), [
    { attachmentId: "a1", mediaType: "image/png", bytes: 12, width: 1, height: 2, name: "x.png" },
  ]);
  assert.deepEqual(targetContent({ data: message }), {
    text: "look",
    images: [
      { attachmentId: "a1", mediaType: "image/png", bytes: 12, width: 1, height: 2, name: "x.png" },
    ],
  });
});
