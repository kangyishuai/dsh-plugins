// @ts-check
// worktree 纯逻辑单测：命名、命令计划、porcelain 解析、回收判据。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRANCH_PREFIX,
  branchName,
  isCleanStatus,
  parseMergedBranches,
  parseWorktreeList,
  planCreate,
  planDeleteBranch,
  planRemove,
  shouldDeleteBranch,
  shouldReclaim,
  slug,
  WORKTREE_DIR,
  worktreePath,
} from "../lib/worktree.js";

describe("slug", () => {
  it("小写化并压掉非字母数字", () => {
    assert.equal(slug("Payments API"), "payments-api");
    assert.equal(slug("  spaced  "), "spaced");
    assert.equal(slug("a_b.c"), "a-b-c");
  });

  it("空/纯中文退化为 project（保证路径可用）", () => {
    assert.equal(slug(""), "project");
    assert.equal(slug("支付服务"), "project");
    // @ts-expect-error 故意传 undefined
    assert.equal(slug(undefined), "project");
  });

  it("长度受控（<= 40）", () => {
    assert.ok(slug("x".repeat(200)).length <= 40);
  });
});

describe("命名", () => {
  it("分支名带前缀与序号", () => {
    assert.equal(
      branchName({ projectName: "Payments API", index: 2 }),
      `${BRANCH_PREFIX}/payments-api-2`,
    );
  });

  it("序号非法时回到 1", () => {
    assert.equal(branchName({ projectName: "p", index: 0 }), "dsh/p-1");
    assert.equal(branchName({ projectName: "p", index: Number.NaN }), "dsh/p-1");
  });

  it("worktree 路径放在仓库同级隐藏目录（不进 .git、不进工作树）", () => {
    const path = worktreePath({ repoRoot: "/work/payments", projectId: "prj_abc", index: 1 });
    assert.equal(path, `/work/${WORKTREE_DIR}/payments/prj_abc-1`);
    assert.ok(!path.includes("/.git/"), "不能放进 .git");
    assert.ok(path.startsWith("/work/"), "应在仓库同级");
  });

  it("repoRoot 带尾斜杠也稳定", () => {
    assert.equal(
      worktreePath({ repoRoot: "/work/payments/", projectId: "prj_abc", index: 1 }),
      `/work/${WORKTREE_DIR}/payments/prj_abc-1`,
    );
  });

  it("projectId 里的路径分隔符被清掉（防目录穿越）", () => {
    const path = worktreePath({ repoRoot: "/work/repo", projectId: "../../etc/passwd", index: 1 });
    assert.ok(!path.includes(".."), path);
    assert.ok(path.startsWith("/work/"), path);
  });

  it("缺 repoRoot 直接报错", () => {
    assert.throws(
      () => worktreePath({ repoRoot: "", projectId: "p", index: 1 }),
      /requires repoRoot/u,
    );
  });
});

describe("命令计划", () => {
  it("planCreate 生成 git worktree add 参数", () => {
    assert.deepEqual(planCreate({ path: "/w/wt", branch: "dsh/p-1" }), [
      "worktree",
      "add",
      "-b",
      "dsh/p-1",
      "/w/wt",
    ]);
  });

  it("planCreate 带 base 时插在路径前", () => {
    assert.deepEqual(planCreate({ path: "/w/wt", branch: "dsh/p-1", base: "origin/main" }), [
      "worktree",
      "add",
      "-b",
      "dsh/p-1",
      "origin/main",
      "/w/wt",
    ]);
  });

  it("planRemove 默认不加 --force（宁可失败也不强删）", () => {
    assert.deepEqual(planRemove({ path: "/w/wt" }), ["worktree", "remove", "/w/wt"]);
    assert.deepEqual(planRemove({ path: "/w/wt", force: true }), [
      "worktree",
      "remove",
      "--force",
      "/w/wt",
    ]);
  });
});

describe("parseWorktreeList", () => {
  it("解析多块 porcelain 输出", () => {
    const text = [
      "worktree /work/repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /work/.dsh-worktrees/repo/prj_a-1",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/dsh/p-1",
      "",
    ].join("\n");
    const list = parseWorktreeList(text);
    assert.equal(list.length, 2);
    assert.equal(list[0].path, "/work/repo");
    assert.equal(list[0].branch, "refs/heads/main");
    assert.equal(list[1].path, "/work/.dsh-worktrees/repo/prj_a-1");
    assert.equal(list[1].head, "2".repeat(40));
  });

  it("空输入安全", () => {
    assert.deepEqual(parseWorktreeList(""), []);
    // @ts-expect-error 故意传 undefined
    assert.deepEqual(parseWorktreeList(undefined), []);
  });
});

describe("回收判据（ADR 0002：宁可留垃圾也不删用户东西）", () => {
  it("干净 + 无未推送 + 非当前会话 → 可回收", () => {
    assert.deepEqual(
      shouldReclaim({ statusText: "", unpushedCommits: 0, isCurrentSession: false }),
      {
        ok: true,
        reason: "",
      },
    );
  });

  it("有未提交改动 → 拒绝", () => {
    const result = shouldReclaim({
      statusText: " M src/a.ts",
      unpushedCommits: 0,
      isCurrentSession: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "dirty");
  });

  it("有未推送提交 → 拒绝", () => {
    const result = shouldReclaim({ statusText: "", unpushedCommits: 2, isCurrentSession: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unpushed-commits");
  });

  it("是当前会话的 cwd → 拒绝", () => {
    const result = shouldReclaim({ statusText: "", unpushedCommits: 0, isCurrentSession: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "current-session");
  });

  it("unpushedCommits 非数字按未知处理（保守拒绝）", () => {
    const result = shouldReclaim({
      statusText: "",
      unpushedCommits: Number.NaN,
      isCurrentSession: false,
    });
    assert.equal(result.ok, false);
  });

  it("isCleanStatus 只认空输出", () => {
    assert.equal(isCleanStatus(""), true);
    assert.equal(isCleanStatus("   \n"), true);
    assert.equal(isCleanStatus("?? newfile"), false);
  });
});

describe("分支清理（M4 §5）", () => {
  const merged = ["main", "dsh/payments-1", "dsh/payments-2"];

  it("已合并 + 是我们建的 + 非当前分支 + 无未推送 → 允许删", () => {
    assert.deepEqual(
      shouldDeleteBranch({
        branch: "dsh/payments-1",
        mergedBranches: merged,
        currentBranch: "main",
      }),
      { ok: true, reason: "" },
    );
  });

  it("未合并 → 保留（宁可留垃圾也不丢提交）", () => {
    assert.equal(
      shouldDeleteBranch({
        branch: "dsh/payments-9",
        mergedBranches: merged,
        currentBranch: "main",
      }).reason,
      "not-merged",
    );
  });

  it("不是我们的分支 → 永不删", () => {
    for (const branch of ["main", "feature/x", ""]) {
      const result = shouldDeleteBranch({ branch, mergedBranches: merged, currentBranch: "main" });
      assert.equal(result.ok, false);
      assert.ok(
        ["branch-not-ours", "no-branch"].includes(result.reason),
        `${branch} → ${result.reason}`,
      );
    }
  });

  it("当前分支 / 有未推送提交 → 保留", () => {
    assert.equal(
      shouldDeleteBranch({
        branch: "dsh/payments-1",
        mergedBranches: merged,
        currentBranch: "dsh/payments-1",
      }).reason,
      "current-branch",
    );
    assert.equal(
      shouldDeleteBranch({
        branch: "dsh/payments-1",
        mergedBranches: merged,
        currentBranch: "main",
        unpushedCommits: 2,
      }).reason,
      "unpushed-commits",
    );
  });

  it("parseMergedBranches 去掉 * 前缀与空行", () => {
    assert.deepEqual(parseMergedBranches("* main\n  dsh/p-1\n\n"), ["main", "dsh/p-1"]);
    assert.deepEqual(parseMergedBranches(""), []);
  });

  it("删分支用 -d 而不是 -D（不强删）", () => {
    assert.deepEqual(planDeleteBranch("dsh/p-1"), ["branch", "-d", "dsh/p-1"]);
    assert.ok(!planDeleteBranch("dsh/p-1").includes("-D"));
  });
});
