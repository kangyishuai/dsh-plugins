// @ts-check
// 路由单测：规则命中优先级、自治级别闸门、兜底与拒绝、坏正则不炸。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTONOMY_ALLOWED,
  decideRoute,
  defaultRules,
  matchRule,
  matchRules,
  ROUTE_ACTIONS,
} from "../lib/routing.js";

const rules = [
  { id: "docs", when: { textMatches: "README|docs/" }, action: "reuse-thread" },
  {
    id: "tests",
    when: { textMatches: "flaky|CI" },
    action: "new-thread",
    titleTemplate: "fix: {{firstLine}}",
  },
  { id: "quick", when: { isQuestion: true, textMaxChars: 120 }, action: "answer-inline" },
];

describe("matchRule", () => {
  it("正则命中（大小写不敏感）", () => {
    assert.equal(matchRule(rules[0], { text: "update the readme please" }), true);
    assert.equal(matchRule(rules[0], { text: "unrelated" }), false);
  });

  it("textMaxChars 超长不命中", () => {
    assert.equal(matchRule(rules[2], { text: "why?", isQuestion: true }), true);
    assert.equal(matchRule(rules[2], { text: `${"x".repeat(200)}?`, isQuestion: true }), false);
  });

  it("isQuestion 必须一致", () => {
    assert.equal(matchRule(rules[2], { text: "why?", isQuestion: false }), false);
  });

  it("用户写坏的正则不让路由崩掉（当作不命中）", () => {
    assert.equal(matchRule({ when: { textMatches: "([unclosed" } }, { text: "anything" }), false);
  });

  it("没有 when 的规则不算命中", () => {
    assert.equal(matchRule({}, {}), false);
    assert.equal(matchRule({ when: null }, {}), false);
  });

  it("threadState 条件", () => {
    const rule = { when: { threadState: "failed" }, action: "new-thread" };
    assert.equal(matchRule(rule, { threadState: "failed" }), true);
    assert.equal(matchRule(rule, { threadState: "done" }), false);
  });
});

describe("matchRules（顺序即优先级）", () => {
  it("取第一条命中的", () => {
    // 注意：docs 规则的正则是 `README|docs/`，单独一个 "docs" 不命中
    assert.deepEqual(matchRules(rules, { text: "fix CI in docs/" }), {
      ruleId: "docs",
      action: "reuse-thread",
    });
    assert.deepEqual(matchRules(rules, { text: "update README" }), {
      ruleId: "docs",
      action: "reuse-thread",
    });
    assert.deepEqual(matchRules(rules, { text: "flaky test" }), {
      ruleId: "tests",
      action: "new-thread",
      titleTemplate: "fix: {{firstLine}}",
    });
  });

  it("非法 action 的规则被跳过", () => {
    const bad = [
      { id: "x", when: {}, action: "rm -rf /" },
      { id: "ok", when: {}, action: "propose" },
    ];
    assert.deepEqual(matchRules(bad, { text: "" }), { ruleId: "ok", action: "propose" });
  });

  it("空规则集返回 null", () => {
    assert.equal(matchRules([], { text: "x" }), null);
    // @ts-expect-error 故意传 undefined
    assert.equal(matchRules(undefined, { text: "x" }), null);
  });
});

describe("decideRoute", () => {
  it("命中规则 → by=rule，带 ruleId（可审计）", () => {
    const decision = decideRoute({ text: "fix the flaky test", rules, autonomy: "L2" });
    assert.deepEqual(decision, {
      by: "rule",
      action: "new-thread",
      ruleId: "tests",
      titleTemplate: "fix: {{firstLine}}",
    });
  });

  it("L1 下命中「新建线程」的规则 → 被拦，理由是自治级别", () => {
    const decision = decideRoute({ text: "fix the flaky test", rules, autonomy: "L1" });
    assert.equal(decision.by, "blocked");
    assert.equal(decision.action, "new-thread");
    assert.equal(decision.blockedReason, "autonomy/L1");
  });

  it("L0 连 reuse-thread 都不许", () => {
    const decision = decideRoute({ text: "update docs/", rules, autonomy: "L0" });
    assert.equal(decision.by, "blocked");
    assert.equal(decision.blockedReason, "autonomy/L0");
  });

  it("未命中规则时用兜底；无兜底则 blocked", () => {
    const withFallback = decideRoute({
      text: "unmatched",
      rules,
      autonomy: "L2",
      fallback: { action: "new-thread" },
    });
    assert.equal(withFallback.by, "fallback");
    assert.equal(withFallback.action, "new-thread");

    const noFallback = decideRoute({ text: "unmatched", rules, autonomy: "L2" });
    assert.equal(noFallback.by, "blocked");
    assert.equal(noFallback.blockedReason, "no-rule-no-fallback");
  });

  it("兜底给非法 action → blocked，不静默照做", () => {
    const decision = decideRoute({
      text: "x",
      rules: [],
      autonomy: "L3",
      fallback: { action: "merge-pr" },
    });
    assert.equal(decision.by, "blocked");
    assert.equal(decision.blockedReason, "invalid-fallback");
  });

  it("兜底也要过自治级别", () => {
    const decision = decideRoute({
      text: "x",
      rules: [],
      autonomy: "L1",
      fallback: { action: "new-thread" },
    });
    assert.equal(decision.by, "blocked");
    assert.equal(decision.blockedReason, "autonomy/L1");
  });

  it("未知自治级别按最保守的 L1 处理", () => {
    const decision = decideRoute({ text: "fix the flaky test", rules, autonomy: "L9" });
    assert.equal(decision.blockedReason, "autonomy/L9");
    // L9 不在矩阵里 → 用 L1 的允许集，所以 new-thread 仍被拦
    assert.equal(AUTONOMY_ALLOWED.L1.includes("new-thread"), false);
  });
});

describe("约束", () => {
  it("动作白名单固定且自治矩阵只用白名单里的动作", () => {
    assert.deepEqual([...ROUTE_ACTIONS].sort(), [
      "answer-inline",
      "new-thread",
      "propose",
      "reuse-thread",
    ]);
    for (const [level, allowed] of Object.entries(AUTONOMY_ALLOWED)) {
      for (const action of allowed) {
        assert.ok(ROUTE_ACTIONS.includes(action), `${level} 用了未知动作 ${action}`);
      }
    }
  });

  it("L0/L1 不该能启动线程（这是规格 §7.4 的核心约束）", () => {
    assert.equal(AUTONOMY_ALLOWED.L0.includes("new-thread"), false);
    assert.equal(AUTONOMY_ALLOWED.L1.includes("new-thread"), false);
    assert.equal(AUTONOMY_ALLOWED.L0.includes("reuse-thread"), false);
  });

  it("默认规则能裁出问题→内联回答、长任务→新线程", () => {
    const hits = matchRules(defaultRules(), { text: "why is this red?", isQuestion: true });
    assert.equal(hits?.action, "answer-inline");
    const task = matchRules(defaultRules(), {
      text: "implement the payments webhook with retries",
    });
    assert.equal(task?.action, "new-thread");
  });
});
