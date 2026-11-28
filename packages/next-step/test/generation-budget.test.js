// @ts-check
// 空输出恢复策略（2026-11-28：推理模型把 maxTokens 全用在推理块上时，重发原请求仍然为空）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  ESCALATED_TOKENS_CAP,
  ESCALATED_TOKENS_FLOOR,
  emptyOutputSummary,
  escalatedTokenBudget,
  recoveryFor,
} from "../lib/generation-budget.js";

test("escalatedTokenBudget：小预算放大到 3000，大预算封顶 4000", () => {
  assert.equal(escalatedTokenBudget(500), 3000);
  assert.equal(escalatedTokenBudget(128), ESCALATED_TOKENS_FLOOR);
  assert.equal(escalatedTokenBudget(1000), 4000);
  assert.equal(escalatedTokenBudget(4000), ESCALATED_TOKENS_CAP);
  // 脏设置不崩，回落到下限
  for (const bad of [0, -1, Number.NaN, "x", null, undefined]) {
    assert.equal(escalatedTokenBudget(bad), ESCALATED_TOKENS_FLOOR, String(bad));
  }
});

test("recoveryFor：空输出升级预算重试；非空格式错误仍走修格式", () => {
  assert.deepEqual(recoveryFor({ raw: "", baseMaxTokens: 500 }), {
    plan: "escalate",
    budget: 3000,
    escalated: true,
  });
  assert.deepEqual(recoveryFor({ raw: "   \n", baseMaxTokens: 500 }), {
    plan: "escalate",
    budget: 3000,
    escalated: true,
  });
  assert.deepEqual(recoveryFor({ raw: "not json", baseMaxTokens: 500 }), {
    plan: "repair",
    budget: 500,
    escalated: false,
  });
  assert.equal(recoveryFor({ raw: "", baseMaxTokens: undefined }).budget, 3000);
  assert.equal(recoveryFor({ raw: "x", baseMaxTokens: undefined }).budget, 500);
});

test("emptyOutputSummary：给出 finish / outputTokens / 预算，便于日志定位", () => {
  assert.equal(
    emptyOutputSummary({ finish: "max-tokens", usage: { outputTokens: 500 }, budget: 500 }),
    "finish=max-tokens outputTokens=500 maxTokens=500",
  );
  assert.equal(
    emptyOutputSummary({ finish: undefined, usage: null, budget: undefined }),
    "finish=unknown outputTokens=? maxTokens=?",
  );
  assert.equal(
    emptyOutputSummary({ usage: { outputTokens: "735" }, budget: "3000" }),
    "finish=unknown outputTokens=735 maxTokens=3000",
  );
});
