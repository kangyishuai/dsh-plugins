// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canMergePr } from "../lib/autopr.js";

describe("PR 合并判定（默认拒绝）", () => {
  it("三个条件都满足才允许", () => {
    assert.deepEqual(canMergePr({ prNumber: 12, confirmed: true, dangerAutoMerge: true }), {
      ok: true,
    });
  });

  it("缺 PR 号 / 未二次确认 / 危险开关关 → 各自给出原因", () => {
    assert.deepEqual(canMergePr({ prNumber: 0, confirmed: true, dangerAutoMerge: true }), {
      ok: false,
      reason: "no-pr",
    });
    assert.deepEqual(canMergePr({ prNumber: 12, confirmed: false, dangerAutoMerge: true }), {
      ok: false,
      reason: "need-confirm",
    });
    assert.deepEqual(canMergePr({ prNumber: 12, confirmed: true, dangerAutoMerge: false }), {
      ok: false,
      reason: "danger-off",
    });
  });
});
