// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { settleAgent } from "../lib/agent-settle.js";

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("空闲 agent 是 no-op", async () => {
  const result = await settleAgent({ status: "idle" }, { sleep });
  assert.deepEqual(result, { cancelled: false, idle: true, droppedSteering: [] });
});

test("运行中的 agent：取消（keepInbox）→ 等 idle → 丢弃 nextStep", async () => {
  /** @type {any[]} */
  const messages = [{ id: "m1" }, { id: "m2" }];
  /** @type {any} */
  const agent = {
    status: "running",
    calls: [],
    cancel(/** @type {any} */ cause, /** @type {any} */ options) {
      this.calls.push({ cause, options });
      this.status = "idle";
    },
    whenIdle: async () => {},
    inbox: {
      get nextStep() {
        return messages;
      },
      remove(/** @type {any} */ id) {
        const index = messages.findIndex((message) => message.id === id);
        if (index >= 0) messages.splice(index, 1);
      },
    },
  };
  const result = await settleAgent(agent, { sleep, timeoutMs: 1000 });
  assert.equal(result.cancelled, true);
  assert.equal(result.idle, true);
  assert.deepEqual(result.droppedSteering, ["m1", "m2"]);
  assert.deepEqual(agent.calls, [{ cause: { kind: "user" }, options: { keepInbox: true } }]);
  assert.deepEqual(messages, []);
});

test("等不到 idle 时返回 idle=false 且不丢插话", async () => {
  /** @type {any} */
  const agent = {
    status: "running",
    cancel() {},
    whenIdle: () => new Promise(() => {}),
    inbox: { nextStep: [{ id: "m1" }], remove() {} },
  };
  const result = await settleAgent(agent, { sleep, timeoutMs: 30 });
  assert.equal(result.cancelled, true);
  assert.equal(result.idle, false);
  assert.deepEqual(result.droppedSteering, []);
});

test("cancel 抛错不影响等待与结果", async () => {
  /** @type {any} */
  const agent = {
    status: "running",
    cancel() {
      throw new Error("cancel failed");
    },
    whenIdle: async () => {},
  };
  const result = await settleAgent(agent, { sleep, timeoutMs: 100 });
  assert.equal(result.cancelled, true);
  assert.equal(result.idle, true);
});

test("没有 whenIdle 时轮询 status", async () => {
  /** @type {any} */
  let status = "running";
  const agent = {
    get status() {
      return status;
    },
    cancel() {
      status = "idle";
    },
  };
  const result = await settleAgent(agent, {
    sleep: (ms) => sleep(Math.min(ms, 5)),
    timeoutMs: 100,
  });
  assert.equal(result.idle, true);
});
