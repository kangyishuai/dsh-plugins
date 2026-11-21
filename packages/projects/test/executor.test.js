// @ts-check
// 执行器闸门单测：批准≠可执行；开关关 → 拒绝；越界参数与结构性硬边。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkExecutable,
  checkMergePreflight,
  DANGER_ACTIONS,
  DEFAULT_MERGE_LIMITS,
  parseRepoFromRemote,
  planCommand,
  recoveryEvidence,
  STRUCTURALLY_FORBIDDEN,
  shouldRetryPreflight,
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

  it("merge 必须给正整数 PR 号 + 目标仓库，且不带 --admin/--force", () => {
    // 旧版断言只写 prNumber 就期望成功——正是这个假设让「合并打到错仓库」的缺陷溜过去
    assert.deepEqual(planCommand("merge", { prNumber: 12, repo: "o/r" }), {
      argv: ["gh", "pr", "merge", "12", "--squash", "--repo", "o/r"],
    });
    const planned = planCommand("merge", { prNumber: 12, repo: "o/r" });
    assert.ok("argv" in planned, "应给出 argv");
    const argv = ("argv" in planned ? planned.argv : []).join(" ");
    assert.ok(!argv.includes("--admin"), "不能带 --admin");
    assert.ok(!argv.includes("--force"), "不能带 --force");
    assert.ok(!argv.includes("--delete-branch"), "不能删分支");
    assert.deepEqual(planCommand("merge", { prNumber: "12abc", repo: "o/r" }), {
      error: "pr-required",
    });
    assert.deepEqual(planCommand("merge", { prNumber: 0, repo: "o/r" }), { error: "pr-required" });
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

describe("merge 必须显式指定目标仓库（真机 e2e 抓到的缺陷）", () => {
  it("没有 repo 就拒绝，绝不能落到「当前目录所在仓库」", () => {
    assert.deepEqual(planCommand("merge", { prNumber: 7 }), { error: "repo-required" });
    assert.deepEqual(planCommand("merge", { prNumber: 7, repo: "" }), { error: "repo-required" });
    assert.deepEqual(planCommand("merge", { prNumber: 7, repo: "not a repo" }), {
      error: "repo-required",
    });
  });

  it("给了 repo 时 argv 带 --repo", () => {
    const planned = planCommand("merge", { prNumber: 7, repo: "o/r" });
    assert.deepEqual(planned, {
      argv: ["gh", "pr", "merge", "7", "--squash", "--repo", "o/r"],
    });
  });
});

describe("checkMergePreflight（规格 §7.5 行 3 的硬前提）", () => {
  it("draft PR 不能合并", () => {
    assert.deepEqual(
      checkMergePreflight({ isDraft: true, mergeable: "MERGEABLE", state: "OPEN" }),
      {
        ok: false,
        reason: "merge/pr-is-draft",
      },
    );
  });

  it("冲突 / 状态未知 / 已关闭都拒绝", () => {
    assert.equal(checkMergePreflight({ mergeable: "CONFLICTING" }).reason, "merge/pr-conflicting");
    assert.equal(
      checkMergePreflight({ mergeable: "UNKNOWN" }).reason,
      "merge/pr-mergeable-unknown",
    );
    assert.equal(checkMergePreflight({ state: "MERGED" }).reason, "merge/pr-not-open");
    assert.equal(checkMergePreflight(null).reason, "merge/pr-unknown");
  });

  it("可合并且非 draft 才放行", () => {
    assert.deepEqual(
      checkMergePreflight({ isDraft: false, mergeable: "MERGEABLE", state: "OPEN" }),
      {
        ok: true,
      },
    );
  });
});

describe("parseRepoFromRemote", () => {
  it("https / ssh / 无 .git 后缀都能解析", () => {
    assert.equal(parseRepoFromRemote("https://github.com/o/r.git"), "o/r");
    assert.equal(parseRepoFromRemote("https://github.com/o/r"), "o/r");
    assert.equal(parseRepoFromRemote("git@github.com:o/r.git"), "o/r");
    assert.equal(parseRepoFromRemote("ssh://git@github.com/o/r.git"), "o/r");
  });

  it("非 GitHub / 空串返回空", () => {
    assert.equal(parseRepoFromRemote("https://gitlab.com/o/r.git"), "");
    assert.equal(parseRepoFromRemote(""), "");
    assert.equal(parseRepoFromRemote(null), "");
  });
});

describe("shouldRetryPreflight", () => {
  it("只有 mergeable 未知才值得重试", () => {
    assert.equal(shouldRetryPreflight("merge/pr-mergeable-unknown"), true);
    assert.equal(shouldRetryPreflight("merge/pr-is-draft"), false);
    assert.equal(shouldRetryPreflight("merge/pr-conflicting"), false);
    assert.equal(shouldRetryPreflight(""), false);
  });
});

describe("动作 ↔ 开关 ↔ 可申请 的一致性（防漏接线）", () => {
  it("每个危险动作都有显式开关映射，没有落到空串", () => {
    for (const action of DANGER_ACTIONS) {
      assert.notEqual(switchForAction(action), "", `${action} 缺少开关映射`);
    }
  });

  it("开关映射的目标必须是 policy.danger 里真实存在的键", async () => {
    const { DEFAULT_DANGER } = await import("../lib/store.js");
    for (const action of DANGER_ACTIONS) {
      const key = switchForAction(action);
      assert.ok(key in DEFAULT_DANGER, `${action} 映射到不存在的开关 ${key}`);
    }
  });

  it("每个危险动作都能通过 requestAction 的申请白名单", async () => {
    const { REQUESTABLE_ACTIONS } = await import("../lib/tools.js");
    for (const action of DANGER_ACTIONS) {
      assert.ok(REQUESTABLE_ACTIONS.includes(action), `${action} 不在可申请白名单里`);
    }
  });
});
