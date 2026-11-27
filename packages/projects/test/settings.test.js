// @ts-check
// 「改本插件自己的配置」白名单：只放行非安全键，安全面一律拒（规格 §7.5 行 5a/5b）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideRoute, defaultRules, matchRules } from "../lib/routing.js";
import {
  applySettingsPatch,
  EDITABLE_KEYS,
  FORBIDDEN_KEYS,
  normalizeRoutingWhen,
  ROUTE_WHEN_KEYS,
  sanitizeSettingsPatch,
} from "../lib/settings.js";

describe("sanitizeSettingsPatch", () => {
  it("允许 persona / goal / routing", () => {
    assert.deepEqual(sanitizeSettingsPatch({ persona: "你是协调器" }), {
      ok: true,
      patch: { persona: "你是协调器" },
      keys: ["persona"],
    });
    const routing = sanitizeSettingsPatch({
      routing: {
        rules: [
          { id: "r1", when: { isQuestion: true, textMaxChars: 200 }, action: "answer-inline" },
        ],
        fallback: false,
      },
    });
    assert.equal(routing.ok, true);
    assert.equal(routing.ok ? routing.patch.routing.fallback : null, false);
  });

  it("真实规则形状（when 是对象）能写入，且写入后真的能命中（G15/N23 契约统一）", () => {
    // settings.js:52 曾要求 `when` 是字符串，而 routing.js:34 只认对象——
    // 于是「改路由」这条审批写路径永远只能写进死规则。这里锁住两端同形。
    const checked = sanitizeSettingsPatch({
      routing: {
        rules: [
          {
            id: "q",
            when: { textMatches: "^帮我", isQuestion: true, textMaxChars: 200 },
            action: "answer-inline",
            titleTemplate: "{{firstLine}}",
          },
        ],
        fallback: true,
      },
    });
    assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
    if (!checked.ok) return;
    const rules = checked.patch.routing.rules;
    assert.deepEqual(
      rules.map((/** @type {any} */ rule) => rule.when),
      [{ textMatches: "^帮我", isQuestion: true, textMaxChars: 200 }],
      "when 必须原样是对象，不能被转成字符串",
    );
    // 写进去的规则必须能被匹配器命中（形状对上才算数）
    assert.deepEqual(
      matchRules(rules, { text: "帮我修一下这个 bug", isQuestion: true, threadState: "idle" }),
      { ruleId: "q", action: "answer-inline", titleTemplate: "{{firstLine}}" },
    );
    assert.equal(matchRules(rules, { text: "今天天气", isQuestion: false }), null);
  });

  it("字符串 when 被明确拒绝（旧错误契约不能再回来）", () => {
    const result = sanitizeSettingsPatch({
      routing: { rules: [{ id: "r1", when: "问句", action: "answer-inline" }] },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /settings\/routing-when-must-be-object/u);
  });

  it("when 里的未知键 / 类型错误要拒（匹配器不认识的键不能静默放行）", () => {
    const unknown = sanitizeSettingsPatch({
      routing: { rules: [{ id: "r1", when: { textMatch: "x" }, action: "answer-inline" }] },
    });
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok ? "" : unknown.reason, /routing-when-unknown:textMatch/u);
    const badType = sanitizeSettingsPatch({
      routing: { rules: [{ id: "r1", when: { textMaxChars: "200" }, action: "answer-inline" }] },
    });
    assert.equal(badType.ok, false);
    assert.match(badType.ok ? "" : badType.reason, /routing-when-bad-type:textMaxChars/u);
    assert.equal(normalizeRoutingWhen(null).ok, false);
    assert.equal(normalizeRoutingWhen(["x"]).ok, false);
    assert.equal(normalizeRoutingWhen({}).ok, true, "空条件 = 命中一切，是合法规则");
  });

  it("默认规则（defaultRules）也满足这份契约（内置数据不能自己越界）", () => {
    for (const rule of defaultRules()) {
      const checked = normalizeRoutingWhen(rule.when);
      assert.equal(checked.ok, true, `${rule.id} 的 when 被自己的契约拒了`);
      for (const key of Object.keys(rule.when)) {
        assert.ok(ROUTE_WHEN_KEYS.includes(key), `${rule.id} 用了未登记的 when 键 ${key}`);
      }
    }
    const decision = decideRoute({
      text: "解释一下这个函数",
      rules: [{ id: "q", when: { isQuestion: false, textMaxChars: 200 }, action: "new-thread" }],
      autonomy: "L2",
      isQuestion: false,
    });
    assert.equal(decision.by, "rule");
    assert.equal(decision.action, "new-thread");
  });

  it("明确禁止的键要给出可读理由（自我提权防线）", () => {
    for (const key of FORBIDDEN_KEYS) {
      const result = sanitizeSettingsPatch({ [key]: true });
      assert.equal(result.ok, false, `${key} 应被拒`);
      assert.match(result.ok ? "" : result.reason, new RegExp(`settings/forbidden:${key}`, "u"));
    }
  });

  it("不在白名单里的未知键也拒", () => {
    const result = sanitizeSettingsPatch({ somethingElse: 1 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /settings\/not-editable/u);
  });

  it("空补丁 / 非对象 / 数组都拒", () => {
    assert.equal(sanitizeSettingsPatch({}).ok, false);
    assert.equal(sanitizeSettingsPatch(null).ok, false);
    assert.equal(sanitizeSettingsPatch([]).ok, false);
    assert.equal(sanitizeSettingsPatch("x").ok, false);
  });

  it("类型不合法要拒（避免把 routing 写成字符串）", () => {
    assert.equal(sanitizeSettingsPatch({ persona: 1 }).ok, false);
    assert.equal(sanitizeSettingsPatch({ goal: {} }).ok, false);
    assert.equal(sanitizeSettingsPatch({ routing: "x" }).ok, false);
    assert.equal(sanitizeSettingsPatch({ routing: { rules: [{ id: 1 }] } }).ok, false);
    assert.equal(
      sanitizeSettingsPatch({ routing: { rules: [{ id: "r1", action: "answer-inline" }] } }).ok,
      false,
      "缺 when 的规则不能放行（匹配器会当成永不命中，写进去等于假配置）",
    );
  });

  it("白名单与禁止清单不重叠", () => {
    for (const key of EDITABLE_KEYS) {
      assert.ok(!FORBIDDEN_KEYS.includes(key), `${key} 不能同时在两份清单里`);
    }
  });
});

describe("applySettingsPatch", () => {
  it("只覆盖补丁里的键，其它策略原样保留", () => {
    const policy = {
      autonomy: "L1",
      persona: "旧",
      danger: { autoMerge: false },
      routing: { rules: [], fallback: true },
    };
    const next = applySettingsPatch(policy, { persona: "新" });
    assert.equal(next.persona, "新");
    assert.equal(next.autonomy, "L1");
    assert.deepEqual(next.danger, { autoMerge: false });
    assert.deepEqual(policy.danger, { autoMerge: false }, "不能改动入参");
  });
});
