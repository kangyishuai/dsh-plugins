// @ts-check
// followup 状态机单测：钉住 AUD-NS-04 的「三条收尾路径 + 幂等 + 会话级上限」。
//
// 背景：`closeFollowup()` 原来没有任何调用点，于是 241 条 followup 事件里 `typed=false`
// 只有 1 条——「用户看完就走了」（真实占比 82%）永远不落盘。现在 turn/end、TTL、上限挤出
// 三条路径共用一个幂等入口，且 **turn/start 绝不能提前收尾**（宿主顺序是
// turn/start → user/message，提前收尾会把每次真实续写都记成 typed:false）。
import assert from "node:assert/strict";
import test from "node:test";

import { createFollowupTracker, FOLLOWUP_TTL_MS, MAX_PENDING_FOLLOWUPS } from "../lib/followup.js";

const LABELS = ["改成 %5", "合并 PR #114"];

test("remember → consume：真实续写记 typed:true，带延迟与具体对象重合数", () => {
  const tracker = createFollowupTracker({ now: () => 10_000 });
  const { ok } = tracker.remember("s1", { turn: 3, labels: LABELS, at: 1_000 });
  assert.equal(ok, true);
  assert.equal(tracker.size, 1);

  // 用户打了跟胶囊相关的一句：「改成 %5 吧」与第一粒共享 "%5"
  const settlement = tracker.consume("s1", { text: "改成 %5 吧", at: 9_000 });
  assert.ok(settlement !== undefined);
  assert.equal(settlement.sessionId, "s1");
  assert.equal(settlement.turn, 3);
  assert.equal(settlement.typed, true);
  assert.equal(settlement.delayMs, 8_000);
  assert.equal(settlement.textChars, "改成 %5 吧".length);
  assert.ok(settlement.overlap >= 1, `与胶囊共享的具体对象数应 ≥1，实际=${settlement.overlap}`);
  assert.equal(tracker.size, 0, "consume 之后必须移除，避免重复写");
});

test("consume：用户发的是空文本时按 typed:false 结算（不算一次续写）", () => {
  const tracker = createFollowupTracker({ now: () => 5_000 });
  tracker.remember("s1", { turn: 2, labels: LABELS, at: 1_000 });
  const settlement = tracker.consume("s1", { text: "   ", at: 4_000 });
  assert.equal(settlement?.typed, false);
  assert.equal(settlement?.textChars, 0);
  assert.equal(settlement?.overlap, 0);
});

test("close 幂等：同一条 pending 只会写一条 typed:false，不会重复", () => {
  const tracker = createFollowupTracker({ now: () => 20_000 });
  tracker.remember("s1", { turn: 4, labels: LABELS, at: 1_000 });

  const first = tracker.close("s1", { typed: false, at: 15_000 });
  assert.equal(first?.typed, false);
  assert.equal(first?.turn, 4);
  assert.equal(first?.delayMs, 14_000);
  assert.equal(tracker.size, 0);
  // 第二次（turn/end 与 TTL 同时触发、或上限挤出同一条）必须是 no-op
  assert.equal(tracker.close("s1", { typed: false, at: 16_000 }), undefined);
});

test("expire：TTL 到期才结算，未到期不动；默认 TTL 是 15 分钟", () => {
  const tracker = createFollowupTracker({ now: () => 0 });
  tracker.remember("s1", { turn: 1, labels: LABELS, at: 1_000 });
  tracker.remember("s2", { turn: 2, labels: LABELS, at: 100_000 });

  assert.deepEqual(tracker.expire(1_000 + FOLLOWUP_TTL_MS - 1), [], "未到期不得结算");
  const settled = tracker.expire(1_000 + FOLLOWUP_TTL_MS);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].sessionId, "s1");
  assert.equal(settled[0].typed, false);
  assert.equal(tracker.has("s1"), false);
  assert.equal(tracker.has("s2"), true, "另一个会话还没到期，不能被顺手删掉");
});

test("会话级上限：超过上限时先挤出最旧的一条并结算成 typed:false", () => {
  const tracker = createFollowupTracker({ now: () => 0, maxSessions: 2 });
  tracker.remember("s1", { turn: 1, labels: LABELS, at: 1_000 });
  tracker.remember("s2", { turn: 2, labels: LABELS, at: 2_000 });
  assert.equal(tracker.size, 2);

  const { evicted } = tracker.remember("s3", { turn: 3, labels: LABELS, at: 3_000 });
  assert.equal(evicted.length, 1, "登记第三个会话时必须挤出一条");
  assert.equal(evicted[0].sessionId, "s1", "挤出的是最旧的那条");
  assert.equal(evicted[0].typed, false);
  assert.equal(tracker.size, 2);

  // 同一会话再次 remember 是覆盖，不该触发挤出
  assert.deepEqual(tracker.remember("s2", { turn: 9, labels: LABELS, at: 4_000 }).evicted, []);
  assert.equal(tracker.get("s2")?.turn, 9);
});

test("没有可用 label 的卡不登记（没有可比的文案）", () => {
  const tracker = createFollowupTracker();
  assert.deepEqual(tracker.remember("s1", { turn: 1, labels: [] }), { ok: false, evicted: [] });
  assert.deepEqual(tracker.remember("s1", { turn: 1, labels: [""] }), { ok: false, evicted: [] });
  assert.deepEqual(tracker.remember("", { turn: 1, labels: LABELS }), { ok: false, evicted: [] });
  assert.equal(tracker.size, 0);
});

test("上限常量与默认值是可解释的：32 个会话 / 15 分钟", () => {
  assert.equal(MAX_PENDING_FOLLOWUPS, 32);
  assert.equal(FOLLOWUP_TTL_MS, 15 * 60 * 1000);
});
