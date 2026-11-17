// @ts-check
// 执行器闸门单测：批准≠可执行；开关关 → 拒绝；越界参数与结构性硬边。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkExecutable,
  DANGER_ACTIONS,
  DEFAULT_MERGE_LIMITS,
  planCommand,
  recoveryEvidence,
  STRUCTURALLY_FORBIDDEN,
  switchForAction,
} from "../lib/executor.js";

// 用**真实开关键**打开全部开关（避免用 action 名当键——那正是真机踩过的坑）
const allOn = Object.fromEntries(DANGER_ACTIONS.map((action) => [switchForAction(action), true]));
const approved = (/** @type {string} */ action) => ({ status: "approved", action });

describe("checkExecutable", () => {
  it("批准 + 开关打开 → 可执行", () => {
    assert.deepEqual(checkExecutable({ approval: approved("push-branch"), danger: allOn }), {
      ok: true,
      reason: "",
    });
  });

  it("未批准 → 拒绝（批准是执行的前提）", () => {
    assert.deepEqual(
      checkExecutable({ approval: { status: "pending", action: "push-branch" }, danger: allOn }),
      {
        ok: false,
        reason: "not-approved",
      },
    );
    assert.equal(
      checkExecutable({ approval: { status: "rejected", action: "merge" }, danger: allOn }).reason,
      "not-approved",
    );
    assert.equal(checkExecutable({ approval: {}, danger: allOn }).reason, "not-approved");
  });

  it("**危险开关默认关** → 即使批准了也不执行", () => {
    assert.deepEqual(checkExecutable({ approval: approved("merge"), danger: {} }), {
      ok: false,
      reason: "switch-off",
    });
    assert.equal(
      checkExecutable({ approval: approved("push-branch"), danger: { merge: true } }).reason,
      "switch-off",
    );
  });

  it("未知动作 → 拒绝", () => {
    assert.match(
      String(
        checkExecutable({ approval: approved("run-shell"), danger: { "run-shell": true } }).reason,
      ),
      /action-not-executable/u,
    );
  });

  it("结构性硬边不在可执行集合里", () => {
    for (const forbidden of STRUCTURALLY_FORBIDDEN) {
      assert.ok(!DANGER_ACTIONS.includes(forbidden), `${forbidden} 不该出现在 DANGER_ACTIONS`);
      const result = checkExecutable({
        approval: approved(forbidden),
        danger: { [forbidden]: true },
      });
      assert.equal(result.ok, false);
    }
  });

  it("merge 影响面超阈值 → 拒绝（文件数/行数分别判定）", () => {
    const base = { approval: approved("merge"), danger: allOn };
    assert.equal(
      checkExecutable({
        ...base,
        impact: { diffFiles: DEFAULT_MERGE_LIMITS.maxDiffFiles + 1, diffLines: 1 },
      }).reason,
      "merge/too-many-files",
    );
    assert.equal(
      checkExecutable({
        ...base,
        impact: { diffFiles: 1, diffLines: DEFAULT_MERGE_LIMITS.maxDiffLines + 1 },
      }).reason,
      "merge/too-many-lines",
    );
    assert.equal(
      checkExecutable({
        ...base,
        impact: {
          diffFiles: DEFAULT_MERGE_LIMITS.maxDiffFiles,
          diffLines: DEFAULT_MERGE_LIMITS.maxDiffLines,
        },
      }).ok,
      true,
      "边界值应放行",
    );
  });

  it("阈值可被项目覆盖", () => {
    const result = checkExecutable({
      approval: approved("merge"),
      danger: allOn,
      limits: { maxDiffFiles: 1 },
      impact: { diffFiles: 2, diffLines: 0 },
    });
    assert.equal(result.reason, "merge/too-many-files");
  });

  it("删除线程时 worktree 不干净 → 拒绝（不许顺手删未提交内容）", () => {
    const result = checkExecutable({
      approval: approved("delete-thread"),
      danger: allOn,
      impact: { worktreeClean: false },
    });
    assert.equal(result.reason, "delete-thread/worktree-dirty");
  });
});

describe("planCommand", () => {
  it("只推我们自己的分支", () => {
    assert.deepEqual(planCommand("push-branch", { branch: "dsh/payments-1" }), {
      argv: ["git", "push", "-u", "origin", "dsh/payments-1"],
    });
    assert.deepEqual(planCommand("push-branch", { branch: "main" }), { error: "branch-not-ours" });
    assert.deepEqual(planCommand("push-branch", { branch: "feature/other" }), {
      error: "branch-not-ours",
    });
    assert.deepEqual(planCommand("push-branch", {}), { error: "branch-required" });
  });

  it("merge 必须给正整数 PR 号，且不带 --admin/--force", () => {
    assert.deepEqual(planCommand("merge", { prNumber: 12 }), {
      argv: ["gh", "pr", "merge", "12", "--squash"],
    });
    assert.deepEqual(planCommand("merge", { prNumber: "12abc" }), { error: "pr-required" });
    assert.deepEqual(planCommand("merge", { prNumber: 0 }), { error: "pr-required" });
  });

  it("删除类动作走内部动作名，不是外部命令", () => {
    assert.deepEqual(planCommand("delete-thread", { sessionId: "session-1" }), {
      argv: ["reclaim-worktree", "session-1"],
    });
    assert.deepEqual(planCommand("delete-project", { projectId: "prj_1" }), {
      argv: ["trash-project", "prj_1"],
    });
  });

  it("没有命令的动作返回错误而不是空命令", () => {
    const planned = planCommand("change-settings", {});
    assert.ok("error" in planned);
    assert.match(String(planned.error), /no-command-for/u);
  });

  it("命令是 argv 数组（不做 shell 插值）", () => {
    const planned = planCommand("push-branch", { branch: "dsh/x; rm -rf /" });
    // 非法字符的分支名根本过不了白名单
    assert.equal("error" in planned, true);
  });
});

describe("recoveryEvidence", () => {
  it("每个动作都给出可回退的线索", () => {
    assert.equal(recoveryEvidence("push-branch", { branch: "dsh/p-1" }).branch, "dsh/p-1");
    assert.equal(recoveryEvidence("merge", { prNumber: 7 }).revertHint, "gh pr revert <n>");
    assert.equal(
      recoveryEvidence("delete-thread", { sessionId: "s1" }).restorable,
      "trash/manifest",
    );
    assert.equal(
      recoveryEvidence("delete-project", { projectId: "p1" }, { trashDir: "/t/x" }).trashDir,
      "/t/x",
    );
    assert.ok(recoveryEvidence("change-settings", {}, { before: "a", after: "b" }).before);
  });

  it("都带 action 与时间戳", () => {
    const evidence = recoveryEvidence("merge", { prNumber: 1 });
    assert.equal(evidence.action, "merge");
    assert.match(String(evidence.at), /^\d{4}-\d{2}-\d{2}T/u);
  });
});
