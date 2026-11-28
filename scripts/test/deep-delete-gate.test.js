// @ts-check
// N1：删除文件段的判定边界。这里锁住的关键一条是「调了 apply_patch 但文件没删掉 = FAIL」，
// 不能被 merg 成「宿主没有 apply_patch」的环境分支 SKIP —— 那会把插件/宿主真 bug 藏起来。
import assert from "node:assert/strict";
import test from "node:test";

import { deepDeleteVerdict } from "../lib/deep-delete-gate.mjs";

test("deepDeleteVerdict：调了 apply_patch 且文件消失 → run（继续跑重建断言）", () => {
  assert.equal(deepDeleteVerdict({ usedApplyPatch: true, deleted: true }), "run");
});

test("deepDeleteVerdict：调了 apply_patch 但文件还在 → fail（不是环境分支 SKIP）", () => {
  assert.equal(deepDeleteVerdict({ usedApplyPatch: true, deleted: false }), "fail");
});

test("deepDeleteVerdict：没调 apply_patch → skip（宿主未注册该工具的环境分支）", () => {
  assert.equal(deepDeleteVerdict({ usedApplyPatch: false, deleted: false }), "skip");
});

test("deepDeleteVerdict：没调 apply_patch 但文件被非追踪工具删掉 → 仍 skip（不是可验证的重建路径）", () => {
  assert.equal(deepDeleteVerdict({ usedApplyPatch: false, deleted: true }), "skip");
});
