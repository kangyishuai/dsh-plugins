// @ts-check
// queuedMessageLimit 闸的单测：纯函数，不依赖宿主包。
import assert from "node:assert/strict";
import { test } from "node:test";
import { QUEUED_MESSAGE_LIMIT, shouldSkipForQueue } from "../lib/queue-gate.js";

test("默认闸值是 2（与官方 action-cards 一致）", () => {
  assert.equal(QUEUED_MESSAGE_LIMIT, 2);
});

test("排队 0/1 条不跳过，2 条起跳过", () => {
  assert.equal(shouldSkipForQueue(0), false);
  assert.equal(shouldSkipForQueue(1), false);
  assert.equal(shouldSkipForQueue(2), true);
  assert.equal(shouldSkipForQueue(5), true);
});

test("limit=0 或负数表示关闭该闸", () => {
  assert.equal(shouldSkipForQueue(9, 0), false);
  assert.equal(shouldSkipForQueue(9, -1), false);
});

test("自定义 limit 生效（含 1）", () => {
  assert.equal(shouldSkipForQueue(1, 1), true);
  assert.equal(shouldSkipForQueue(1, 3), false);
  assert.equal(shouldSkipForQueue(3, 3), true);
});

test("非法输入一律不跳过（宁可不拦，也不误杀）", () => {
  assert.equal(shouldSkipForQueue(Number.NaN), false);
  assert.equal(shouldSkipForQueue(-3), false);
  assert.equal(shouldSkipForQueue(2, Number.NaN), false);
});
