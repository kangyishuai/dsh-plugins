// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../lib/limits.js";
import { createLiveTracker } from "../lib/live.js";

/**
 * 假 host ctx：只实现 `on`，把 llm/stream waterfall 监听器存起来，测试里手动驱动。
 * @returns {{
 *   ctx: any,
 *   stream: (sessionId: string, chunks: any[]) => Promise<any[]>,
 *   listenerRegistered: () => boolean,
 * }}
 */
function fakeCtx() {
  /** @type {any} */
  let listener;
  return {
    ctx: {
      on(/** @type {string} */ name, /** @type {any} */ callback) {
        if (name === "llm/stream") listener = callback;
      },
    },
    listenerRegistered: () => listener !== undefined,
    /**
     * @param {string} sessionId
     * @param {any[]} chunks
     * @returns {Promise<any[]>}
     */
    async stream(sessionId, chunks) {
      assert.ok(listener !== undefined, "llm/stream listener must be registered");
      const received = listener({ sessionId }, () =>
        (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      );
      /** @type {any[]} */
      const out = [];
      for await (const chunk of received) out.push(chunk);
      return out;
    },
  };
}

test("live: 只记录已 attach 的子会话，其余 stream 原样透传", async () => {
  const host = fakeCtx();
  const tracker = createLiveTracker(host.ctx, { now: () => 1000 });
  assert.equal(host.listenerRegistered(), true);

  const run = tracker.begin("parent-1", { threadId: "t_1", question: "q" });
  tracker.attachChild(run, "child-1");

  const chunks = [
    { type: "text-delta", index: 0, text: "Hel" },
    { type: "reasoning-delta", index: 0, text: "think" },
    { type: "text-delta", index: 0, text: "lo!" },
  ];
  const forwarded = await host.stream("child-1", chunks);
  assert.deepEqual(forwarded, chunks, "waterfall 必须原样 yield，不能改写");

  const runs = tracker.list("parent-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, "Hello!", "只拼 text-delta，不含 reasoning");
  assert.equal(runs[0].childId, "child-1");
  assert.equal(runs[0].ms, 0);

  // 别的会话不进入 buffer，但也必须透传。
  const other = [{ type: "text-delta", index: 0, text: "nope" }];
  assert.deepEqual(await host.stream("other-session", other), other);
  assert.equal(tracker.list("parent-1")[0].text, "Hello!");

  tracker.finish(run);
  assert.deepEqual(tracker.list("parent-1"), []);
  // 结束后再来 delta 不再累积。
  await host.stream("child-1", [{ type: "text-delta", index: 0, text: "late" }]);
  assert.deepEqual(tracker.list("parent-1"), []);
});

test("live: 文本上限生效，多个 run 按开始时间排序", async () => {
  let now = 1000;
  const host = fakeCtx();
  const tracker = createLiveTracker(host.ctx, { now: () => now });

  const first = tracker.begin("parent-2", { threadId: "t_a", question: "a" });
  tracker.attachChild(first, "child-a");
  now = 2000;
  const second = tracker.begin("parent-2", { threadId: "t_b", question: "b" });
  tracker.attachChild(second, "child-b");
  now = 2500;

  await host.stream("child-b", [{ type: "text-delta", index: 0, text: "B" }]);
  const big = "x".repeat(LIMITS.liveTextChars + 100);
  await host.stream("child-a", [{ type: "text-delta", index: 0, text: big }]);

  const runs = tracker.list("parent-2");
  assert.deepEqual(
    runs.map((run) => run.threadId),
    ["t_a", "t_b"],
    "按开始时间正序",
  );
  assert.equal(runs[0].text.length, LIMITS.liveTextChars, "超长文本夹到上限");
  assert.equal(runs[0].ms, 1500);
  assert.equal(runs[1].ms, 500);
  tracker.finish(first);
  tracker.finish(second);
  assert.equal(tracker.size(), 0);
});

test("live: 没有 listener 的 ctx 不抛（降级为空）", () => {
  const tracker = createLiveTracker({}, { now: () => 1 });
  const run = tracker.begin("s", { threadId: "t", question: "q" });
  tracker.attachChild(run, "c");
  assert.deepEqual(tracker.list("s"), [{ ...run, ms: 0 }]);
  tracker.finish(run);
  assert.deepEqual(tracker.list("s"), []);
});

test("live: 重复 begin 同 threadId 覆盖旧 run，finish 幂等", () => {
  const host = fakeCtx();
  const tracker = createLiveTracker(host.ctx, { now: () => 10 });
  const first = tracker.begin("s", { threadId: "t", question: "one" });
  const second = tracker.begin("s", { threadId: "t", question: "two" });
  tracker.finish(first);
  tracker.finish(first);
  assert.equal(tracker.list("s")[0].question, "two");
  tracker.finish(second);
  assert.deepEqual(tracker.list("s"), []);
});
