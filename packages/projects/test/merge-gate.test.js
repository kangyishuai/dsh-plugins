// @ts-check
// UI 合并按钮（RPC mergePr）与审批执行器共用同一套合并判据（assessMergePr）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessMergePr } from "../lib/executor.js";

const healthyPr = {
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
  reviews: [{ state: "APPROVED", author: { login: "a" } }],
  additions: 10,
  deletions: 5,
  changedFiles: 3,
};
const base = {
  allowedMethods: ["squash"],
  minApprovals: 1,
  maxDiffFiles: 20,
  maxDiffLines: 600,
};

describe("assessMergePr：UI 合并的完整门禁", () => {
  it("CI 绿 + 1 个批准 + 改动量在阈值内 → 放行", () => {
    const verdict = assessMergePr({ ...base, pr: healthyPr });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.approvals, 1);
  });

  it("CI 失败 → merge/ci-not-green（以前 UI 路径根本不看 CI）", () => {
    const verdict = assessMergePr({
      ...base,
      pr: { ...healthyPr, statusCheckRollup: [{ conclusion: "FAILURE" }] },
    });
    assert.deepEqual(verdict, { ok: false, reason: "merge/ci-not-green" });
  });

  it("批准数不足 → merge/not-approved", () => {
    const verdict = assessMergePr({ ...base, pr: { ...healthyPr, reviews: [] } });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "merge/not-approved");
  });

  it("draft / 冲突 / mergeable 未知 → 拒绝", () => {
    assert.equal(
      assessMergePr({ ...base, pr: { ...healthyPr, isDraft: true } }).reason,
      "merge/pr-is-draft",
    );
    assert.equal(
      assessMergePr({ ...base, pr: { ...healthyPr, mergeable: "CONFLICTING" } }).reason,
      "merge/pr-conflicting",
    );
    assert.equal(
      assessMergePr({ ...base, pr: { ...healthyPr, mergeable: "UNKNOWN" } }).reason,
      "merge/pr-mergeable-unknown",
    );
  });

  it("改动量超阈值 → merge/diff-files / merge/diff-lines（设置页承诺的同一套阈值）", () => {
    const files = assessMergePr({ ...base, pr: { ...healthyPr, changedFiles: 21 } });
    assert.equal(files.ok, false);
    assert.equal(files.reason, "merge/diff-files");
    const lines = assessMergePr({ ...base, pr: { ...healthyPr, additions: 500, deletions: 101 } });
    assert.equal(lines.ok, false);
    assert.equal(lines.reason, "merge/diff-lines");
  });

  it("仓库未允许 squash（拿不到方法）→ merge/method-unknown，不猜", () => {
    assert.equal(
      assessMergePr({ ...base, allowedMethods: null, pr: healthyPr }).reason,
      "merge/method-unknown",
    );
    assert.equal(
      assessMergePr({ ...base, allowedMethods: ["merge"], pr: healthyPr }).reason,
      "merge/method-not-allowed",
    );
  });
});
