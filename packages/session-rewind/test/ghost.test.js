// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGhost } from "../lib/ghost.js";

/**
 * @param {number} seq
 * @param {string} type
 * @param {any} data
 * @param {any} [extra]
 */
function event(seq, type, data, extra = {}) {
  return { seq, type, time: 1000 + seq, data, ...extra };
}

/** @param {number} seq @param {number} start @param {number} end */
function marker(seq, start, end) {
  return event(
    seq,
    "user/message",
    {
      id: `m${seq}`,
      role: "user",
      content: [{ type: "text", text: "(empty message)" }],
      source: { kind: "session-rewind", targetSeq: start },
    },
    { surfaceOp: { op: "replace", startSeq: start, endSeq: end }, sourceEventSeqs: [start, end] },
  );
}

/**
 * @param {any} e
 * @returns {{kind: "user" | "assistant" | "tool" | "other", text: string, messageId?: string} | null}
 */
const describe = (e) => {
  if (!e.surfaceOp || e.surfaceOp !== "append") return null;
  if (e.type === "user/message") {
    return {
      kind: "user",
      text: String(e.data.content[0]?.text ?? ""),
      messageId: String(e.data.id),
    };
  }
  if (e.type === "assistant/message") {
    return {
      kind: "assistant",
      text: String(e.data.message.content?.[0]?.text ?? ""),
      messageId: String(e.data.message.id),
    };
  }
  if (e.type === "tool/result") return { kind: "tool", text: "tool-output" };
  return null;
};

function log() {
  return [
    event(0, "session/title", {}),
    event(
      1,
      "user/message",
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "first" }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    event(
      2,
      "assistant/message",
      { message: { id: "a1", role: "assistant", content: [{ type: "text", text: "reply one" }] } },
      { surfaceOp: "append" },
    ),
    event(
      3,
      "user/message",
      {
        id: "u2",
        role: "user",
        content: [{ type: "text", text: "second" }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    event(
      4,
      "assistant/message",
      { message: { id: "a2", role: "assistant", content: [{ type: "text", text: "reply two" }] } },
      { surfaceOp: "append" },
    ),
    marker(5, 3, 4),
    event(
      6,
      "user/message",
      {
        id: "u3",
        role: "user",
        content: [{ type: "text", text: "third" }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    event(
      7,
      "assistant/message",
      {
        message: { id: "a3", role: "assistant", content: [{ type: "text", text: "reply three" }] },
      },
      { surfaceOp: "append" },
    ),
    marker(8, 6, 7),
  ];
}

test("按 marker 分组列出被撤回的消息（最新在前）", () => {
  const { cuts } = collectGhost(log(), describe);
  assert.equal(cuts.length, 2);
  assert.equal(cuts[0].markerSeq, 8);
  assert.equal(cuts[0].targetSeq, 6);
  assert.deepEqual(
    cuts[0].items.map((/** @type {any} */ item) => item.text),
    ["third", "reply three"],
  );
  assert.equal(cuts[1].markerSeq, 5);
  assert.deepEqual(
    cuts[1].items.map((/** @type {any} */ item) => item.text),
    ["second", "reply two"],
  );
});

test("搜索命中文本，未命中的组不出现", () => {
  const { cuts } = collectGhost(log(), describe, { q: "reply two" });
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].markerSeq, 5);
  assert.deepEqual(
    cuts[0].items.map((/** @type {any} */ item) => item.text),
    ["reply two"],
  );
});

test("分页：cursor 指向更早的回溯组", () => {
  const first = collectGhost(log(), describe, { limit: 1 });
  assert.equal(first.cuts.length, 1);
  assert.equal(first.cuts[0].markerSeq, 8);
  assert.equal(first.nextCursor, 8);
  const second = collectGhost(log(), describe, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.cuts.length, 1);
  assert.equal(second.cuts[0].markerSeq, 5);
  assert.equal(second.nextCursor, null);
});

test("modeByMarker 注入审计里的模式", () => {
  const { cuts } = collectGhost(log(), describe, { modeByMarker: new Map([[8, "both"]]) });
  assert.equal(cuts[0].mode, "both");
  assert.equal(cuts[1].mode, null);
});

test("长文本截断到 GHOST_TEXT_LIMIT", () => {
  const events = [
    event(
      0,
      "user/message",
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "x".repeat(900) }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    marker(1, 0, 0),
  ];
  const { cuts } = collectGhost(events, describe);
  assert.equal(cuts[0].items[0].text.length, 500);
  assert.ok(cuts[0].items[0].text.endsWith("…"));
});
