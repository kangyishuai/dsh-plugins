// @ts-check
// 执行器纯逻辑单测：开关映射、阈值、命令形状、恢复证据、合并前置。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkCiGreen,
  checkExecutable,
  checkMergeMethod,
  checkMergePreflight,
  checkMergeReadiness,
  checkPreapproval,
  countApprovedReviews,
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

/** 从 { ok, reason } 形状里取原因，便于断言。 */
const reasonOf = (/** @type {any} */ result) =>
  result?.ok === false ? String(result.reason) : "ok";

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

  it("change-settings 走白名单（不再是「无命令」，但越界仍拒）", () => {
    // 旧断言曾写「change-settings 没有命令」——那正是「有开关没实现」的状态
    const ok = planCommand("change-settings", { patch: { persona: "你是协调器" } });
    assert.ok("argv" in ok);
    assert.deepEqual("argv" in ok ? ok.argv : [], ["update-settings", "persona"]);
    const forbidden = planCommand("change-settings", { patch: { danger: { autoMerge: true } } });
    assert.ok("error" in forbidden);
    assert.match(String(forbidden.error), /settings\/forbidden:danger/u);
  });

  it("真正没有命令的动作仍返回错误而不是空命令", () => {
    const planned = planCommand("totally-unknown", {});
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

describe("checkCiGreen（规格 §7.5 行 3 的 ①）", () => {
  it("全绿放行", () => {
    assert.deepEqual(checkCiGreen([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }]), { ok: true });
  });

  it("空列表 = 未配置检查 → 拒绝，不猜", () => {
    assert.equal(reasonOf(checkCiGreen([])), "merge/ci-unknown");
    assert.equal(reasonOf(checkCiGreen(null)), "merge/ci-unknown");
  });

  it("失败 / 在跑 / 无结论都拒绝，且原因可区分", () => {
    assert.equal(reasonOf(checkCiGreen([{ conclusion: "FAILURE" }])), "merge/ci-not-green");
    assert.equal(reasonOf(checkCiGreen([{ conclusion: "CANCELLED" }])), "merge/ci-not-green");
    assert.equal(reasonOf(checkCiGreen([{ state: "PENDING" }])), "merge/ci-pending");
    assert.equal(reasonOf(checkCiGreen([{}])), "merge/ci-unknown");
  });

  it("SKIPPED / NEUTRAL 算通过", () => {
    assert.deepEqual(checkCiGreen([{ conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }]), {
      ok: true,
    });
  });
});

describe("countApprovedReviews（④ 人工批准数）", () => {
  it("按不同作者去重，只数 APPROVED", () => {
    assert.equal(countApprovedReviews([]), 0);
    assert.equal(countApprovedReviews([{ state: "APPROVED", author: { login: "a" } }]), 1);
    assert.equal(
      countApprovedReviews([
        { state: "APPROVED", author: { login: "a" } },
        { state: "APPROVED", author: { login: "a" } },
        { state: "APPROVED", author: { login: "b" } },
      ]),
      2,
    );
    assert.equal(countApprovedReviews([{ state: "CHANGES_REQUESTED", author: { login: "a" } }]), 0);
  });
});

describe("checkMergeMethod（⑥ 仓库允许的合并方式）", () => {
  it("允许 squash 才放行；不允许就拒绝而不是换方式", () => {
    assert.deepEqual(checkMergeMethod(["merge", "squash"]), { ok: true });
    assert.equal(reasonOf(checkMergeMethod(["merge", "rebase"])), "merge/method-not-allowed");
    assert.equal(reasonOf(checkMergeMethod([])), "merge/method-unknown");
  });
});

describe("checkMergeReadiness（一次判完）", () => {
  const base = {
    isDraft: false,
    mergeable: "MERGEABLE",
    state: "OPEN",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  };
  const approved = [{ state: "APPROVED", author: { login: "a" } }];

  it("全部满足才放行，并报出批准数", () => {
    assert.deepEqual(
      checkMergeReadiness({ pr: base, reviews: approved, allowedMethods: ["squash"] }),
      { ok: true, approvals: 1 },
    );
  });

  it("draft 优先于 CI 判定（先报更根本的问题）", () => {
    assert.equal(
      reasonOf(
        checkMergeReadiness({
          pr: { ...base, isDraft: true },
          reviews: approved,
          allowedMethods: ["squash"],
        }),
      ),
      "merge/pr-is-draft",
    );
  });

  it("CI 未绿时不会去看批准数", () => {
    assert.equal(
      reasonOf(
        checkMergeReadiness({
          pr: { ...base, statusCheckRollup: [] },
          reviews: approved,
          allowedMethods: ["squash"],
        }),
      ),
      "merge/ci-unknown",
    );
  });

  it("批准数不足 → not-approved 并带实际数", () => {
    const result = checkMergeReadiness({ pr: base, reviews: [], allowedMethods: ["squash"] });
    assert.equal(reasonOf(result), "merge/not-approved");
    assert.equal(result.approvals, 0);
  });

  it("minApprovals = 0 时不看批准数，但仍要求 CI 绿", () => {
    assert.deepEqual(
      checkMergeReadiness({ pr: base, reviews: [], allowedMethods: ["squash"], minApprovals: 0 }),
      { ok: true, approvals: 0 },
    );
    assert.equal(
      reasonOf(
        checkMergeReadiness({
          pr: { ...base, statusCheckRollup: [] },
          reviews: [],
          allowedMethods: ["squash"],
          minApprovals: 0,
        }),
      ),
      "merge/ci-unknown",
    );
  });

  it("仓库不允许 squash → 拒绝", () => {
    assert.equal(
      reasonOf(checkMergeReadiness({ pr: base, reviews: approved, allowedMethods: ["merge"] })),
      "merge/method-not-allowed",
    );
  });
});

describe("checkPreapproval（预授权三条门槛，规格 §7.7.2）", () => {
  const danger = {
    forcePushOwnBranch: true,
    autoMerge: true,
    pushProtectedBranch: true,
    purgeAfterRetention: true,
  };

  it("policy-grant 动作 + 已列出 + 开关开 → 放行", () => {
    assert.deepEqual(
      checkPreapproval({ action: "push-branch", preapprove: ["push-branch"], danger }),
      { ok: true },
    );
    assert.deepEqual(
      checkPreapproval({ action: "purge-trash", preapprove: ["purge-trash"], danger }),
      { ok: true },
    );
  });

  it("merge / 直推保护分支永远不能被预授权（授权来源不是 policy-grant）", () => {
    assert.equal(
      reasonOf(checkPreapproval({ action: "merge", preapprove: ["merge"], danger })),
      "preapprove/source-not-policy-grant",
    );
    assert.equal(
      reasonOf(
        checkPreapproval({
          action: "push-protected-branch",
          preapprove: ["push-protected-branch"],
          danger,
        }),
      ),
      "preapprove/source-not-policy-grant",
    );
  });

  it("没列出 / 开关关 → 不放行", () => {
    assert.equal(
      reasonOf(checkPreapproval({ action: "push-branch", preapprove: [], danger })),
      "preapprove/not-listed",
    );
    assert.equal(
      reasonOf(
        checkPreapproval({ action: "push-branch", preapprove: ["push-branch"], danger: {} }),
      ),
      "preapprove/switch-off",
    );
  });

  it("空动作安全", () => {
    assert.equal(
      reasonOf(checkPreapproval({ action: "", preapprove: [""], danger })),
      "preapprove/action-required",
    );
  });
});
