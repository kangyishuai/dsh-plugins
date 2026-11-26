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

describe("pickRepoRoot（PR 命令的工作目录）", () => {
  it("优先线程 worktree，其次项目目录，都没有返回空串", async () => {
    const { pickRepoRoot } = await import("../lib/autopr.js");
    assert.equal(pickRepoRoot({ worktree: "/w/t-1", dirs: ["/a", "/b"] }), "/w/t-1");
    assert.equal(pickRepoRoot({ worktree: null, dirs: ["/a", "/b"] }), "/a");
    assert.equal(pickRepoRoot({ worktree: "", dirs: [] }), "");
    assert.equal(pickRepoRoot({}), "");
  });
});
