// @ts-check
// 便宜闸的单测：这些条件决定「这一轮到底要不要花一次模型调用」。
import assert from "node:assert/strict";
import { test } from "node:test";

import { cheapSkipReason, MIN_ANSWER_CHARS } from "../lib/gates.js";

/** 一个「所有闸都放行」的基线输入。 */
function base() {
  return {
    enabled: true,
    cardEnabled: true,
    pauseUntil: 0,
    now: 1_000_000,
    queued: 0,
    cardsForTurn: false,
    shownCardsInSession: 0,
    maxCards: 30,
    endKind: "completed",
    answerChars: 1200,
  };
}

test("基线：全部条件满足时不跳过", () => {
  assert.equal(cheapSkipReason(base()), null);
});

test("开关关掉就跳过，且不区分 enabled/card（都算 disabled）", () => {
  assert.equal(cheapSkipReason({ ...base(), enabled: false })?.reason, "disabled");
  assert.equal(cheapSkipReason({ ...base(), cardEnabled: false })?.reason, "disabled");
});

test("暂停中跳过", () => {
  const input = base();
  assert.equal(cheapSkipReason({ ...input, pauseUntil: input.now + 1 })?.reason, "paused");
});

test("用户已经排了 ≥2 条消息就跳过（他马上要说的话比任何建议都准）", () => {
  assert.equal(cheapSkipReason({ ...base(), queued: 2 })?.reason, "queued");
  // 只排 1 条不算：仍然可能想知道「然后呢」
  assert.equal(cheapSkipReason({ ...base(), queued: 1 }), null);
});

test("这一轮已经有卡 → duplicate；达到会话上限 → budget", () => {
  assert.equal(cheapSkipReason({ ...base(), cardsForTurn: true })?.reason, "duplicate");
  assert.equal(
    cheapSkipReason({ ...base(), shownCardsInSession: 30, maxCards: 30 })?.reason,
    "budget",
  );
});

test("上一轮不是 completed（报错/中断/阻塞）就跳过", () => {
  for (const endKind of ["aborted", "blocked", "error"]) {
    const skip = cheapSkipReason({ ...base(), endKind });
    assert.equal(skip?.reason, "turn-error");
    assert.match(String(skip?.detail), new RegExp(endKind, "u"));
  }
  assert.equal(cheapSkipReason({ ...base(), endKind: "completed" }), null);
});

test("回答短且没有工具调用才跳过（工具密集型回合的收尾回答常常只有一句）", () => {
  assert.equal(
    cheapSkipReason({ ...base(), answerChars: MIN_ANSWER_CHARS - 1 })?.reason,
    "short-answer",
  );
  // 边界：恰好达到字数就不拦
  assert.equal(cheapSkipReason({ ...base(), answerChars: MIN_ANSWER_CHARS }), null);
  // 回答很短但有工具调用：上下文充分，放行（v0.4 的新口径）
  assert.equal(
    cheapSkipReason({ ...base(), answerChars: 12, toolCalls: 7 }),
    null,
    "有工具调用的短答案不应被拦",
  );
  // 没有工具调用、字数为 0：仍然拦
  assert.equal(
    cheapSkipReason({ ...base(), answerChars: 0, toolCalls: 0 })?.reason,
    "short-answer",
  );
});

test("预算闸只统计出过的卡：被档位抑制的候选不占预算", () => {
  // 会话里生成过很多候选，但只出过 2 张卡 → 不触发预算
  assert.equal(
    cheapSkipReason({ ...base(), shownCardsInSession: 2, maxCards: 30 }),
    null,
    "抑制的候选不应消耗预算",
  );
  assert.equal(
    cheapSkipReason({ ...base(), shownCardsInSession: 30, maxCards: 30 })?.reason,
    "budget",
  );
});

test("多个条件同时不满足时，按便宜闸的顺序先报更靠前的", () => {
  // 关闭 + 有报错：先报 disabled（连模型都不想跑）
  assert.equal(
    cheapSkipReason({ ...base(), enabled: false, endKind: "aborted" })?.reason,
    "disabled",
  );
  // 暂停 + 回答短：先报 paused
  assert.equal(
    cheapSkipReason({ ...base(), pauseUntil: 2_000_000, answerChars: 1 })?.reason,
    "paused",
  );
});
