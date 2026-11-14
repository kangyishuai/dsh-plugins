// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAbort, formatTimeout } from "../lib/abort-reason.js";

test("formatTimeout：整分钟、整秒与非法输入", () => {
  assert.equal(formatTimeout(90_000), "90 秒");
  assert.equal(formatTimeout(120_000), "2 分钟");
  assert.equal(formatTimeout(600_000), "10 分钟");
  assert.equal(formatTimeout(45_000), "45 秒");
  assert.equal(formatTimeout(5_000), "5 秒");
  // 不足 1 秒不能说出「0 秒」
  assert.equal(formatTimeout(120), "1 秒");
  assert.equal(formatTimeout(999), "1 秒");
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatTimeout(bad), "未知时长", `formatTimeout(${String(bad)})`);
  }
});

test("classifyAbort：超时与取消是两个不同的 code", () => {
  // 超时 → timeout，文案里带上时长（README 把 timeout 与 aborted 列成两个失败码）。
  assert.deepEqual(classifyAbort({ timedOut: true, timeoutMs: 90_000 }), {
    code: "timeout",
    message: "顾问调用超时（90 秒）",
  });
  // 用户/回合取消 → aborted。
  assert.deepEqual(classifyAbort({ cancelled: true }), {
    code: "aborted",
    message: "顾问调用被中止",
  });
  // 既没超时也没取消（宿主自己中止了流）→ 保留原来的兜底说法。
  assert.deepEqual(classifyAbort({}), { code: "aborted", message: "顾问调用被中止" });
  assert.deepEqual(classifyAbort(), { code: "aborted", message: "顾问调用被中止" });
});

test("classifyAbort：取消优先于超时", () => {
  // 用户先按了取消、随后超时定时器也触发：不能把它说成超时。
  const verdict = classifyAbort({ cancelled: true, timedOut: true, timeoutMs: 90_000 });
  assert.equal(verdict.code, "aborted");
});

test("classifyAbort：超时但没给时长也不抛", () => {
  const verdict = classifyAbort({ timedOut: true });
  assert.equal(verdict.code, "timeout");
  assert.match(verdict.message, /未知时长/u);
});
