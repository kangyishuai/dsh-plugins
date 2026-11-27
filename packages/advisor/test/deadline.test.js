// @ts-check
// 硬超时（审计 AUD-ADV-03）：配置的 timeoutMs 必须由**插件侧**主动中止，而不是等宿主流
// 自己收尾成 aborted —— 真实数据里有 6 次调用超过 90s 仍以 reviewed 计费。
//
// `lib/call.js` 会 import `@deepseek-ai/dsh-llm`（测试环境没有宿主包），所以把可判定的
// 时间语义抽成这个纯模块，用真实计时器测；call.js 只做接线。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDeadline, raceWithDeadline } from "../lib/deadline.js";

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createDeadline", () => {
  it("到点后触发 signal，并把 timedOut 标成 true", async () => {
    const deadline = createDeadline({ timeoutMs: 10 });
    assert.equal(deadline.signal.aborted, false);
    await sleep(30);
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.timedOut(), true);
    assert.equal(deadline.cancelled(), false);
    deadline.dispose();
  });

  it("外部取消先到：signal 中止，但不算超时", async () => {
    const external = new AbortController();
    const deadline = createDeadline({ timeoutMs: 60_000, external: external.signal });
    external.abort();
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.timedOut(), false);
    assert.equal(deadline.cancelled(), true);
    deadline.dispose();
  });

  it("外部 signal 已经中止时立即生效", () => {
    const external = new AbortController();
    external.abort();
    const deadline = createDeadline({ timeoutMs: 60_000, external: external.signal });
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.cancelled(), true);
    deadline.dispose();
  });

  it("dispose 之后定时器不再触发", async () => {
    const deadline = createDeadline({ timeoutMs: 10 });
    deadline.dispose();
    await sleep(30);
    assert.equal(deadline.signal.aborted, false);
    assert.equal(deadline.timedOut(), false);
  });
});

describe("raceWithDeadline", () => {
  it("工作先完成：返回 settled 值，且之后不会再判超时", async () => {
    const deadline = createDeadline({ timeoutMs: 20 });
    const outcome = await raceWithDeadline(Promise.resolve("advice"), deadline);
    assert.deepEqual(outcome, { kind: "settled", value: "advice" });
    await sleep(40);
    assert.equal(deadline.timedOut(), false, "已结算的调用不该再被超时标记");
    deadline.dispose();
  });

  it("超时先到：返回 timeout，不等工作完成", async () => {
    const deadline = createDeadline({ timeoutMs: 10 });
    const started = Date.now();
    const outcome = await raceWithDeadline(
      sleep(200).then(() => "late"),
      deadline,
    );
    assert.deepEqual(outcome, { kind: "timeout" });
    assert.ok(Date.now() - started < 150, "必须提前返回，而不是等流自己收尾");
    deadline.dispose();
  });

  it("外部取消：返回 aborted 而不是 timeout", async () => {
    const external = new AbortController();
    const deadline = createDeadline({ timeoutMs: 60_000, external: external.signal });
    const pending = raceWithDeadline(sleep(200), deadline);
    setTimeout(() => external.abort(), 5);
    assert.deepEqual(await pending, { kind: "aborted" });
    deadline.dispose();
  });

  it("工作抛错：把错误交回调用方（由 call.js 归类，不在这里吞掉）", async () => {
    const deadline = createDeadline({ timeoutMs: 60_000 });
    const outcome = await raceWithDeadline(Promise.reject(new Error("boom")), deadline);
    assert.equal(outcome.kind, "error");
    assert.match(String(/** @type {any} */ (outcome).error?.message), /boom/u);
    deadline.dispose();
  });

  it("超时后迟到的 rejection 不会变成 unhandled rejection", async () => {
    const deadline = createDeadline({ timeoutMs: 5 });
    const outcome = await raceWithDeadline(
      sleep(30).then(() => {
        throw new Error("late failure");
      }),
      deadline,
    );
    assert.deepEqual(outcome, { kind: "timeout" });
    await sleep(80);
    deadline.dispose();
  });
});
