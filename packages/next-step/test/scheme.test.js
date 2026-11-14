// @ts-check
// 三档判定 × 档位 → 是否显示：9 格真值表 + 边界。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CARD_TIERS,
  isCardTier,
  isCardValue,
  PROMPT_VERSION,
  SCHEME,
  shouldShow,
  tierRank,
  VALUE_RANK,
} from "../lib/scheme.js";

test("档位与判定值的守卫", () => {
  assert.equal(isCardTier("must"), true);
  assert.equal(isCardTier("could"), true);
  assert.equal(isCardTier("any"), true);
  assert.equal(isCardTier("nope"), false);
  assert.equal(isCardTier(undefined), false);
  assert.equal(isCardValue("no"), true);
  assert.equal(isCardValue("needed"), false);
});

test("tierRank：档位越紧，阈值越高；any 的阈值等于 no", () => {
  assert.equal(tierRank("must"), VALUE_RANK.must);
  assert.equal(tierRank("could"), VALUE_RANK.could);
  assert.equal(tierRank("any"), VALUE_RANK.no);
  // 非法档位回落默认档位 could，而不是"永不出卡"
  assert.equal(tierRank("whatever"), VALUE_RANK.could);
  assert.equal(tierRank(undefined), VALUE_RANK.could);
});

test("shouldShow：3 档判定 × 3 档位的真值表", () => {
  /** @type {Record<string, Record<string, boolean>>} */
  const expected = {
    // 严格：只有 must 出
    must: { must: true, could: false, no: false },
    // 平衡（默认）：must + could 出（v0.4 放宽的主体）
    could: { must: true, could: true, no: false },
    // 积极：三档都出（实验档）
    any: { must: true, could: true, no: true },
  };
  for (const tier of CARD_TIERS) {
    for (const value of /** @type {const} */ (["must", "could", "no"])) {
      assert.equal(
        shouldShow(value, tier),
        expected[tier][value],
        `shouldShow(${value}, ${tier}) 应为 ${expected[tier][value]}`,
      );
    }
  }
});

test("shouldShow：未知判定值一律不显示；未知档位按平衡处理", () => {
  assert.equal(shouldShow("maybe", "any"), false);
  assert.equal(shouldShow(undefined, "any"), false);
  assert.equal(shouldShow("", "could"), false);
  // 手改设置成非法档位：表现为默认档位（平衡），不是全不出也不是全出
  assert.equal(shouldShow("could", "bogus"), true);
  assert.equal(shouldShow("no", "bogus"), false);
});

test("版本位是常量且自洽", () => {
  assert.match(SCHEME, /^v\d+\.\d+$/u);
  assert.equal(Number.isSafeInteger(PROMPT_VERSION), true);
  assert.ok(PROMPT_VERSION >= 3);
});
