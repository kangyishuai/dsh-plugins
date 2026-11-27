// @ts-check
// `pnpm advisor:review` 的人类可读输出（2026-11-28 补，AUD-ADV-07 的收尾）。
//
// 背景：顾问双 README 声称复盘会「同时给出 outcome 覆盖率」，但人类可读输出只有
// 采纳率——分母只算「已回填结果」的徵询，样本少时「采纳率 0%」会被误读成
// 「建议从没被采纳」。`summarize()` 已经返回 `resolvedOutcomes` / `pendingOutcomes` /
// `outcomeCoverage`，这里把那一行补上并锁住格式（含「旧数据没有字段时显示 -」）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatOutcomeCoverage, pctOf } from "../advisor-review.mjs";

test("formatOutcomeCoverage：有回填数据时给出可追踪/不可追踪与覆盖率", () => {
  assert.equal(
    formatOutcomeCoverage({
      consulted: 10,
      resolvedOutcomes: 7,
      pendingOutcomes: 3,
      outcomeCoverage: 0.7,
    }),
    "结果回填：可追踪 7 · 不可追踪 3 · outcome 覆盖率：70.0%",
  );
});

test("formatOutcomeCoverage：没徵询过时整行显示 -（不编造 0%）", () => {
  const line = formatOutcomeCoverage({
    consulted: 0,
    resolvedOutcomes: 0,
    pendingOutcomes: 0,
    outcomeCoverage: null,
  });
  assert.equal(line, "结果回填：可追踪 - · 不可追踪 - · outcome 覆盖率：-");
});

test("formatOutcomeCoverage：旧实现/旧数据缺字段时显示 -，不假装覆盖完整", () => {
  // 合并顺序保护：advisor 侧字段来自另一个分支；在字段还没到位的分支上，
  // 这一行必须优雅降级而不是抛错或显示 0。
  assert.equal(
    formatOutcomeCoverage({ consulted: 5, accepted: 2 }),
    "结果回填：可追踪 - · 不可追踪 - · outcome 覆盖率：-",
  );
  assert.equal(formatOutcomeCoverage(undefined), formatOutcomeCoverage({}));
});

test("pctOf：null 显示 -，其余保留一位小数", () => {
  assert.equal(pctOf(null), "-");
  assert.equal(pctOf(0), "0.0%");
  assert.equal(pctOf(0.1234), "12.3%");
});
