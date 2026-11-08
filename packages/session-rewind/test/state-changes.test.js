// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectStateChanges,
  STATE_EVENT_LABELS,
  stateChangeSummary,
} from "../lib/state-changes.js";

/** @param {number} seq @param {string} type @param {any} [data] */
function event(seq, type, data = {}) {
  return { seq, type, time: 1000 + seq, data, surfaceOp: "append" };
}

const log = [
  event(1, "user/message", { source: { kind: "user" } }),
  event(2, "plan/mode", { mode: "plan" }),
  event(3, "assistant/message"),
  event(4, "goal/change", { goal: { status: "active" } }),
  event(5, "goal/change", { goal: { status: "complete" } }),
  event(6, "todo/write", { items: [] }),
  event(7, "user/message", { source: { kind: "user" } }),
];

test("collectStateChanges 按出现顺序聚合并计数", () => {
  const changes = collectStateChanges(log, 2, 6);
  assert.deepEqual(
    changes.map((item) => [item.type, item.count, item.firstSeq]),
    [
      ["plan/mode", 1, 2],
      ["goal/change", 2, 4],
      ["todo/write", 1, 6],
    ],
  );
  assert.equal(changes[0].labelKey, "state.planMode");
});

test("collectStateChanges 尊重区间（含边界）", () => {
  assert.deepEqual(
    collectStateChanges(log, 3, 5).map((item) => item.type),
    ["goal/change"],
  );
  assert.deepEqual(collectStateChanges(log, 8, 9), []);
});

test("collectStateChanges 忽略未知事件类型与坏输入", () => {
  const changes = collectStateChanges([event(1, "some/future-event"), { seq: 2 }, null], 0, 10);
  assert.deepEqual(changes, []);
  assert.deepEqual(collectStateChanges(/** @type {any} */ (null), 0, 10), []);
});

test("collectStateChanges 到日志末尾时传 MAX_SAFE_INTEGER", () => {
  const changes = collectStateChanges(log, 0, Number.MAX_SAFE_INTEGER);
  assert.equal(changes.length, 3);
});

test("stateChangeSummary 只返回 type/labelKey/count", () => {
  const summary = stateChangeSummary(log, 2, 6);
  assert.deepEqual(summary[0], { type: "plan/mode", labelKey: "state.planMode", count: 1 });
  assert.equal(Object.hasOwn(summary[0], "firstSeq"), false);
});

test("每个已知状态事件都有文案键", () => {
  for (const [type, labelKey] of Object.entries(STATE_EVENT_LABELS)) {
    assert.match(type, /\//u);
    assert.match(labelKey, /^state\./u);
  }
  assert.equal(STATE_EVENT_LABELS["goal/change"], "state.goal");
});
