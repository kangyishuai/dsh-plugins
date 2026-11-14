// @ts-check
// 卡片/决策/揭示记录的校验、归一化与可见性判定（纯函数，不 import 宿主包）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isCardData,
  isCardDataV2,
  isDecisionData,
  isOption,
  isRevealData,
  readCard,
  resolveVisibility,
} from "../lib/card-data.js";

/**
 * 一张 v2 合法卡。
 * @param {any} [overrides]
 * @returns {any}
 */
function card(overrides = {}) {
  return {
    turn: 3,
    seq: 12,
    summary: "改了 importer/csv.ts 的流式读取，内存峰值 1.8 GB → 90 MB。",
    question: "现在跑一遍冒烟确认吗？",
    options: [
      { stance: "verify", label: "跑 next-step 冒烟" },
      { stance: "proceed", label: "先合并 PR #114" },
    ],
    value: "could",
    shown: true,
    tier: "could",
    promptVersion: 3,
    model: "zhinao/deepseek/deepseek-v4.1-flash",
    createdAt: 1794168000000,
    ...overrides,
  };
}

test("isCardData：v2 合法卡通过；旧记录（无新字段）也通过", () => {
  assert.equal(isCardData(card()), true);
  /** @type {any} */
  const legacy = { ...card() };
  delete legacy.value;
  delete legacy.shown;
  delete legacy.tier;
  delete legacy.promptVersion;
  assert.equal(isCardData(legacy), true, "旧记录必须继续可读");
});

test("isCardData：结构不合法一律拒绝", () => {
  const cases = [
    card({ turn: 1.5 }),
    card({ summary: "   " }),
    card({ question: "" }),
    card({ options: [] }),
    card({
      options: [
        { stance: "a", label: "跑冒烟" },
        { stance: "b", label: "合并 PR" },
        { stance: "c", label: "补文档" },
      ],
    }),
    card({ options: [{ stance: "", label: "跑冒烟" }] }),
    card({ options: [{ stance: "a", label: "" }] }),
    card({
      options: [
        { stance: "same", label: "跑冒烟" },
        { stance: "same", label: "合并 PR" },
      ],
    }),
    card({ nextPrompt: 42 }),
    card({ value: "needed" }),
    card({ shown: "yes" }),
    card({ tier: "balanced" }),
  ];
  for (const bad of cases) {
    assert.equal(isCardData(bad), false, `期望拒绝：${JSON.stringify(bad).slice(0, 120)}`);
  }
});

test("isCardDataV2：写入前的严格校验要求带齐新字段", () => {
  assert.equal(isCardDataV2(card()), true);
  /** @type {any} */
  const legacy = { ...card() };
  delete legacy.value;
  assert.equal(isCardDataV2(legacy), false, "旧记录不满足写入严格校验");
  assert.equal(isCardDataV2(card({ shown: undefined })), false);
  assert.equal(isCardDataV2(card({ promptVersion: undefined })), false);
});

test("readCard：旧记录补默认值（value=must / shown=true / tier=could / promptVersion=0）", () => {
  /** @type {any} */
  const legacy = { ...card(), turn: 9 };
  delete legacy.value;
  delete legacy.shown;
  delete legacy.tier;
  delete legacy.promptVersion;
  const read = readCard(legacy);
  assert.equal(read.value, "must", "旧卡都是「模型判定需要」才写的");
  assert.equal(read.shown, true);
  assert.equal(read.tier, "could");
  assert.equal(read.promptVersion, 0);
  assert.equal(read.turn, 9);
});

test("readCard：不泄露多余字段（只保留渲染与统计用到的键）", () => {
  const read = readCard({ ...card(), text: "旧版隐藏指令", extra: 1 });
  assert.deepEqual(Object.keys(read).sort(), [
    "createdAt",
    "model",
    "options",
    "promptVersion",
    "question",
    "seq",
    "shown",
    "summary",
    "tier",
    "turn",
    "value",
  ]);
  assert.equal(read.options.length, 2);
});

test("readCard：缺 nextPrompt 时不生成该键", () => {
  const read = readCard(card());
  assert.equal("nextPrompt" in read, false);
});

test("isRevealData / isDecisionData", () => {
  assert.equal(isRevealData({ turn: 3 }), true);
  assert.equal(isRevealData({ turn: 3, via: "button" }), true);
  assert.equal(isRevealData({ turn: 3, via: "nope" }), false);
  assert.equal(isRevealData({ turn: "3" }), false);
  assert.equal(isDecisionData({ turn: 3, phase: "sent", index: 0 }), true);
  assert.equal(isDecisionData({ turn: 3, phase: "dismissed" }), true);
  assert.equal(isDecisionData({ turn: 3, phase: "sent" }), false);
  assert.equal(isDecisionData({ turn: 3, phase: "revealed" }), false);
});

test("isOption：只有 stance + label 都非空才算", () => {
  assert.equal(isOption({ stance: "a", label: "跑冒烟" }), true);
  assert.equal(isOption({ stance: " ", label: "跑冒烟" }), false);
  assert.equal(isOption({ stance: "a" }), false);
  assert.equal(isOption(null), false);
});

test("resolveVisibility：显示 × 揭示 × 决策 × 是否最新轮的全组合", () => {
  /** @type {Array<[any, boolean, any, boolean, string]>} */
  const rows = [
    // card, revealed, decision, isLastTurn, expected
    [undefined, false, undefined, true, "hidden"],
    [undefined, true, undefined, true, "hidden"],
    [card({ shown: false }), false, undefined, true, "hidden"],
    [card({ shown: false }), true, undefined, true, "interactive-eligible"],
    [card({ shown: false }), true, undefined, false, "readonly-shown"],
    [card({ shown: true }), false, undefined, true, "interactive-eligible"],
    [card({ shown: true }), false, undefined, false, "readonly-shown"],
    [card({ shown: true }), false, { phase: "sent", index: 0 }, true, "resolved"],
    [card({ shown: true }), true, { phase: "dismissed" }, true, "resolved"],
  ];
  for (const [input, revealed, decision, isLastTurn, expected] of rows) {
    const actual = resolveVisibility({
      card: input,
      revealed,
      decision,
      isLastTurn,
    });
    assert.equal(
      actual,
      expected,
      `card.shown=${input?.shown} revealed=${revealed} decision=${decision?.phase} last=${isLastTurn} 期望=${expected} 实际=${actual}`,
    );
  }
});

test("resolveVisibility：isLastTurn 缺省视为最新轮（host 守卫不传这个参数）", () => {
  assert.equal(resolveVisibility({ card: card() }), "interactive-eligible");
  assert.equal(resolveVisibility({ card: card({ shown: false }) }), "hidden");
});
