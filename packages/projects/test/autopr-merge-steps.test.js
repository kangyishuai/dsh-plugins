// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planMergeSteps } from "../lib/autopr.js";

describe("合并步骤计划（草稿要先 ready）", () => {
  it("非草稿：直接 squash + delete-branch", () => {
    assert.deepEqual(planMergeSteps({ prNumber: 7 }), {
      steps: [["pr", "merge", "7", "--squash", "--delete-branch"]],
    });
  });

  it("草稿：先 pr ready 再 merge；无 PR 号报错", () => {
    assert.deepEqual(planMergeSteps({ prNumber: 7, isDraft: true }), {
      steps: [
        ["pr", "ready", "7"],
        ["pr", "merge", "7", "--squash", "--delete-branch"],
      ],
    });
    assert.deepEqual(planMergeSteps({ prNumber: 0 }), { error: "no-pr" });
  });
});
