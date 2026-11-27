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
  it("优先 worktree，其次线程 dir，其次项目目录，都没有返回空串", async () => {
    const { pickRepoRoot } = await import("../lib/autopr.js");
    assert.equal(pickRepoRoot({ worktree: "/w/t-1", dirs: ["/a", "/b"] }), "/w/t-1");
    // worktree 被回收后，线程创建时的 dir 才是它真正所属的仓库（复审 P1：之前回落 dirs[0]）
    assert.equal(pickRepoRoot({ worktree: null, dir: "/b", dirs: ["/a", "/b"] }), "/b");
    assert.equal(pickRepoRoot({ worktree: null, dirs: ["/a", "/b"] }), "/a");
    assert.equal(pickRepoRoot({ worktree: "", dir: "/b", dirs: ["/a"] }), "/b");
    assert.equal(pickRepoRoot({ worktree: "", dirs: [] }), "");
    assert.equal(pickRepoRoot({}), "");
  });
});

describe("pickPollRoot（项目级 PR 轮询目录）", () => {
  it("优先任一线程 worktree，其次项目目录", async () => {
    const { pickPollRoot } = await import("../lib/autopr.js");
    assert.equal(
      pickPollRoot({ threads: [{ worktree: null }, { worktree: "/w/t-2" }], dirs: ["/a"] }),
      "/w/t-2",
    );
    assert.equal(pickPollRoot({ threads: [{ worktree: null }], dirs: ["/a"] }), "/a");
    assert.equal(pickPollRoot({ threads: [], dirs: [] }), "");
  });
});
