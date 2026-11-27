// @ts-check
// service 层「执行闭环」测试：直接驱动真实 executeApproval 分支，命令用 PATH 桩替换。
//
// 为什么需要这一层：执行分支的 bug（例如漏写 return 掉进 deferred、占位没释放）
// 单测纯函数抓不到，真机才暴露。这里用「真实 store + 假 git/gh」把关键分支钉住。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { executeApprovalCore } from "../lib/execute.js";
import { ProjectStore } from "../lib/store.js";

/** @type {string} */
let root;
/** @type {string} */
let modeFile;
/** 桩 gh 收到的命令（断言「合并打到哪个仓库」） */
/** @type {string[]} */
let ghCalls = [];
/** cwd → 远端仓库名（多目录测试用） */
/** @type {Map<string, string>} */
let remoteByCwd = new Map();

/** 场景文件：桩 gh 按此返回不同 PR 状态。 */
const setMode = (/** @type {string} */ mode) => writeFileSync(modeFile, mode, "utf8");

/** 假 gh：按 mode 返回不同 PR 状态（不碰网络、不碰 PATH）。 */
const fakeGh = async (/** @type {string[]} */ args) => {
  const line = args.join(" ");
  ghCalls.push(line);
  const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok";
  const prState = (() => {
    if (line.includes("pr view")) {
      if (mode === "ci-empty")
        return {
          isDraft: false,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [],
          reviews: [{ state: "APPROVED", author: { login: "a" } }],
        };
      if (mode === "ci-fail")
        return {
          isDraft: false,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ conclusion: "FAILURE" }],
          reviews: [{ state: "APPROVED", author: { login: "a" } }],
        };
      if (mode === "no-approve")
        return {
          isDraft: false,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          reviews: [],
        };
      if (mode === "big-diff")
        return {
          isDraft: false,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          reviews: [{ state: "APPROVED", author: { login: "a" } }],
          additions: 5000,
          deletions: 5000,
          changedFiles: 300,
        };
      if (mode === "draft")
        return {
          isDraft: true,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          reviews: [{ state: "APPROVED", author: { login: "a" } }],
        };
      return {
        isDraft: false,
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        reviews: [{ state: "APPROVED", author: { login: "a" } }],
      };
    }
    return null;
  })();
  if (prState) return { code: 0, stdout: JSON.stringify(prState), stderr: "" };
  if (line.includes("api repos/"))
    return {
      code: 0,
      stdout: JSON.stringify({ allowed_merge_methods: ["merge", "squash"] }),
      stderr: "",
    };
  return { code: 0, stdout: "", stderr: "" };
};

/** 假 git：remote 解析固定为 stub/repo，其余成功。 */
const fakeGit = async (/** @type {string[]} */ args, /** @type {string} */ cwd = "") => {
  const line = args.join(" ");
  if (line.includes("remote get-url origin")) {
    const repo = remoteByCwd.get(String(cwd ?? "")) ?? "repo";
    return { code: 0, stdout: `https://github.com/stub/${repo}.git`, stderr: "" };
  }
  if (line.includes("rev-parse"))
    return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-svc-exec-"));
  modeFile = join(root, "mode");
  writeFileSync(modeFile, "ok", "utf8");
  ghCalls = [];
  remoteByCwd = new Map();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 建一套执行依赖：真实 store + 假命令执行器 + 几个内部方法的桩。
 * @param {{ danger?: Record<string, boolean>, preapprove?: string[], merge?: any, purge?: any, reclaim?: any }} [policy]
 */
const makeDeps = (policy) => {
  const store = new ProjectStore({ root }).load();
  const project = store.createProject("svc-demo", { dirs: [root] });
  const base = store.getProject(project.id);
  store.updateProject(project.id, {
    policy: {
      ...base.policy,
      ...(policy?.preapprove ? { preapprove: policy.preapprove } : {}),
      ...(policy?.merge ? { merge: { ...base.policy.merge, ...policy.merge } } : {}),
      danger: { ...base.policy.danger, ...(policy?.danger ?? {}) },
    },
  });
  store.save();
  const deps = {
    store,
    dataRoot: root,
    runGit: fakeGit,
    runGh: fakeGh,
    purgeTrash:
      policy?.purge ?? (async () => ({ ok: true, purged: [], kept: 0, manifestPath: null })),
    reclaimThread: policy?.reclaim ?? (async () => ({ reclaimed: true, reason: "" })),
    deleteProject: async () => ({ deleted: true, trashDir: root, summary: "" }),
  };
  return { deps, store, project };
};

/** 造一张已批准的申请。 */
const approvedRequest = (
  /** @type {any} */ store,
  /** @type {string} */ projectId,
  /** @type {string} */ action,
  /** @type {any} */ args,
) => {
  const created = store.appendApproval({ projectId, action, args, reason: "test" });
  store.resolveApproval(created.requestId, "approved");
  store.save();
  return created.requestId;
};

const approvalOf = (/** @type {any} */ store, /** @type {string} */ id) =>
  store.listApprovals().find((/** @type {any} */ item) => item.requestId === id);

describe("executeApproval：合并的三道硬前提（B1）", () => {
  const runMerge = async (/** @type {string} */ mode) => {
    setMode(mode);
    const { deps, store, project } = makeDeps({ danger: { autoMerge: true } });
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    const result = await executeApprovalCore(deps, requestId);
    return { result, store, requestId };
  };

  it("CI 为空 → 拒绝，且占位被释放（可重试）", async () => {
    const { result, store, requestId } = await runMerge("ci-empty");
    assert.equal(result.executed, false);
    assert.equal(result.reason, "merge/ci-unknown");
    const record = approvalOf(store, requestId);
    assert.equal(record.claimedAt, null, "被拒后必须释放占位");
    assert.ok(!record.executedAt, "被拒不能标记已执行");
  });

  it("CI 失败 → 拒绝", async () => {
    const { result } = await runMerge("ci-fail");
    assert.equal(result.reason, "merge/ci-not-green");
  });

  it("没有人工批准 → 拒绝", async () => {
    const { result } = await runMerge("no-approve");
    assert.equal(result.reason, "merge/not-approved");
  });

  it("draft → 先报 draft（比 CI 更根本）", async () => {
    const { result } = await runMerge("draft");
    assert.equal(result.reason, "merge/pr-is-draft");
  });

  it("全绿 + 已批 → 真的执行，并落 executedAt（不能掉进 deferred）", async () => {
    const { result, store, requestId } = await runMerge("ok");
    assert.equal(result.executed, true, `不应 deferred：${JSON.stringify(result)}`);
    assert.notEqual(result.reason, "remote-action-not-implemented");
    const record = approvalOf(store, requestId);
    assert.ok(record.executedAt, "成功后必须落 executedAt");
  });

  it("同一张申请执行两次 → 第二次 already-executed", async () => {
    setMode("ok");
    const { deps, store, project } = makeDeps({ danger: { autoMerge: true } });
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    await executeApprovalCore(deps, requestId);
    const again = await executeApprovalCore(deps, requestId);
    assert.equal(again.executed, false);
    assert.equal(again.reason, "already-executed");
  });
});

describe("F55 文件夹授权三键真的影响执行（不再是死记录）", () => {
  /** 造一个带 folderAuth 的项目（dirs[0] 就是 root）。 */
  const withFolder = (/** @type {string} */ mode) => {
    const made = makeDeps({ danger: { autoMerge: true } });
    const base = made.store.getProject(made.project.id);
    made.store.updateProject(made.project.id, {
      policy: {
        ...base.policy,
        folderAuth: { [root]: { mode, at: new Date().toISOString(), used: false } },
      },
    });
    made.store.save();
    return made;
  };

  it("deny → 拒绝执行，命令不会发出，申请占位也没占上", async () => {
    setMode("ok");
    const { deps, store, project } = withFolder("deny");
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "folder/denied");
    assert.equal(approvalOf(store, requestId).claimedAt ?? null, null);
  });

  it("once → 首次放行并消费（used=true），同目录下一次被拒", async () => {
    setMode("ok");
    const { deps, store, project } = withFolder("once");
    const first = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    const firstResult = await executeApprovalCore(deps, first);
    assert.equal(firstResult.executed, true, JSON.stringify(firstResult));
    assert.equal(store.getProject(project.id).policy.folderAuth[root].used, true);
    const second = approvedRequest(store, project.id, "merge", { prNumber: 2 });
    const secondResult = await executeApprovalCore(deps, second);
    assert.equal(secondResult.executed, false);
    assert.equal(secondResult.reason, "folder/once-already-used");
  });

  it("default → 长期放行：连续两次都执行，且不消费", async () => {
    setMode("ok");
    const { deps, store, project } = withFolder("default");
    const first = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    const second = approvedRequest(store, project.id, "merge", { prNumber: 2 });
    assert.equal((await executeApprovalCore(deps, first)).executed, true);
    assert.equal((await executeApprovalCore(deps, second)).executed, true);
    assert.equal(store.getProject(project.id).policy.folderAuth[root].used, false);
  });

  it("未授权（unset）保持旧行为：不拦", async () => {
    setMode("ok");
    const { deps, store, project } = makeDeps({ danger: { autoMerge: true } });
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    assert.equal((await executeApprovalCore(deps, requestId)).executed, true);
  });
});

describe("executeApproval：其余分支不会掉进 deferred", () => {
  it("change-settings 允许的键 → 真的执行", async () => {
    const { deps, store, project } = makeDeps({ danger: { editProfile: true } });
    const requestId = approvedRequest(store, project.id, "change-settings", {
      patch: { persona: "新人格" },
    });
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, true);
    assert.equal(store.getProject(project.id).policy.persona, "新人格");
  });

  it("change-settings 碰安全面 → 拒绝", async () => {
    const { deps, store, project } = makeDeps({ danger: { editProfile: true } });
    const requestId = approvedRequest(store, project.id, "change-settings", {
      patch: { danger: { autoMerge: true } },
    });
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, false);
    assert.match(String(result.reason), /settings\/forbidden/u);
  });

  it("delete-thread 缺 sessionId → 明确拒绝（不是 deferred）", async () => {
    const { deps, store, project } = makeDeps({ danger: { trashAuto: true } });
    const requestId = approvedRequest(store, project.id, "delete-thread", {});
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "session-required");
  });

  it("purge-trash 开关关 → switch-off；开关开 → 执行并写清单", async () => {
    const off = makeDeps({});
    const idOff = approvedRequest(off.store, off.project.id, "purge-trash", {});
    const refused = await executeApprovalCore(off.deps, idOff);
    assert.equal(refused.reason, "switch-off");

    const on = makeDeps({ danger: { purgeAfterRetention: true } });
    const idOn = approvedRequest(on.store, on.project.id, "purge-trash", {});
    const ok = await executeApprovalCore(on.deps, idOn);
    assert.equal(ok.executed, true);
  });
});

// —— B3 复审 P2：once 凭据必须在所有闸通过、占位成功之后才消费 ——
describe("F55 once 凭据的消费时序（复审 P2）", () => {
  /** 把某目录的一次性授权写进 policy（模拟授权卡点了 Allow once）。 */
  const grantOnce = (
    /** @type {any} */ store,
    /** @type {any} */ project,
    /** @type {string} */ dir,
  ) => {
    const current = store.getProject(project.id);
    store.updateProject(project.id, {
      policy: {
        ...current.policy,
        folderAuth: {
          ...(current.policy.folderAuth ?? {}),
          [dir]: { mode: "once", at: "now", used: false },
        },
      },
    });
    store.save();
  };
  const grantOf = (
    /** @type {any} */ store,
    /** @type {any} */ project,
    /** @type {string} */ dir,
  ) => store.getProject(project.id).policy.folderAuth[dir];

  it("动作被拒（switch-off）时 once 不被烧掉：凭据还在，重试仍可用；放行后才标 used", async () => {
    const { deps, store, project } = makeDeps();
    grantOnce(store, project, root);
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    const refused = await executeApprovalCore(deps, requestId);
    assert.equal(refused.executed, false);
    assert.equal(refused.reason, "switch-off");
    assert.equal(grantOf(store, project, root).used, false, "被拒时 once 不能被消费");
    const auditOf = (/** @type {string} */ action) =>
      store.state.audit.filter(
        (/** @type {any} */ item) => item.action === action && item.projectId === project.id,
      );
    const consumedAudits = () => auditOf("folder/once-consumed");
    assert.deepEqual(consumedAudits(), [], "被拒时不能留下消费审计");
    assert.ok(!approvalOf(store, requestId).claimedAt, "被拒后不能留占位");

    // 打开开关后同一张申请重试：一次通过，凭据这时才消费。
    const current = store.getProject(project.id);
    store.updateProject(project.id, {
      policy: { ...current.policy, danger: { ...current.policy.danger, autoMerge: true } },
    });
    store.save();
    const retried = await executeApprovalCore(deps, requestId);
    assert.equal(retried.executed, true);
    assert.equal(grantOf(store, project, root).used, true, "放行后 once 必须标 used");
    assert.equal(consumedAudits().length, 1);
    assert.equal(consumedAudits()[0].afterClaim, true);
  });

  it("占位后才发现没有 worktree：once 消费后回滚，凭据仍可用于重试", async () => {
    const { deps, store, project } = makeDeps({ danger: { forcePushOwnBranch: true } });
    grantOnce(store, project, root);
    const requestId = approvedRequest(store, project.id, "push-branch", { branch: "dsh/demo-1" });
    const refused = await executeApprovalCore(deps, requestId);
    assert.equal(refused.executed, false);
    assert.equal(refused.reason, "no-worktree");
    assert.equal(grantOf(store, project, root).used, false, "没落地就不能算用掉");
    const audit = store.state.audit.filter(
      (/** @type {any} */ item) => item.projectId === project.id,
    );
    assert.equal(
      audit.filter((/** @type {any} */ item) => item.action === "folder/once-consumed").length,
      1,
    );
    assert.equal(
      audit.filter((/** @type {any} */ item) => item.action === "folder/once-rolled-back").length,
      1,
      "回滚要留审计，方便解释「为什么还能再试一次」",
    );
    assert.ok(!approvalOf(store, requestId).claimedAt);
  });

  it("动作被拒（merge/repo-unknown）时同样不消费 once", async () => {
    const { deps, store, project } = makeDeps({ danger: { autoMerge: true } });
    grantOnce(store, project, root);
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 1 });
    // 让 remote 解析失败：fakeGit 只有在 remote get-url origin 时返回仓库，这里换成空目录
    const broken = { ...deps, runGit: async () => ({ code: 1, stdout: "", stderr: "" }) };
    const refused = await executeApprovalCore(broken, requestId);
    assert.equal(refused.executed, false);
    assert.equal(refused.reason, "merge/repo-unknown");
    assert.equal(grantOf(store, project, root).used, false, "repo 解析失败不能烧掉 once");
    // repo 解析发生在消费之前：这条路径上凭据连碰都没碰（更强）。
    assert.equal(
      store.state.audit.filter(
        (/** @type {any} */ item) =>
          item.projectId === project.id && item.action === "folder/once-consumed",
      ).length,
      0,
    );
  });
});

// —— B3 复审 P2：文件夹闸按「实际 cwd 所属目录」求 mode，不再一律 dirs[0] ——
describe("F55 闸门目录语义（复审 P2）", () => {
  it("push-branch 的 worktree 继承它所属的项目目录（第二个目录的授权也生效）", async () => {
    const { actionDirectory, folderGate } = await import("../lib/execute.js");
    const project = {
      id: "p1",
      dirs: ["/w/one", "/w/two"],
      policy: { folderAuth: { "/w/two": { mode: "deny", used: false } } },
    };
    const target = actionDirectory(project, "push-branch", {
      worktree: "/w/.dsh-worktrees/two/p1-1",
    });
    assert.equal(target.dir, "/w/two");
    assert.equal(target.cwd, "/w/.dsh-worktrees/two/p1-1");
    assert.equal(target.inherited, true);
    const gate = folderGate(project, "push-branch", { worktree: "/w/.dsh-worktrees/two/p1-1" });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "folder/denied");
    assert.equal(gate.dir, "/w/two");
    // merge 仍按 dirs[0]
    assert.equal(actionDirectory(project, "merge").dir, "/w/one");
    // 反查不到时退回 dirs[0]，并如实标 inherited=false（不假装知道）
    const unknown = actionDirectory(project, "push-branch", { worktree: "/elsewhere/wt" });
    assert.equal(unknown.dir, "/w/one");
    assert.equal(unknown.inherited, false);
  });
});

describe("复审 P0/P1：审批合并的仓库解析与改动量门槛", () => {
  it("多目录项目：合并用线程 worktree 所在仓库，不用 dirs[0]", async () => {
    const { deps, store, project } = makeDeps({ danger: { autoMerge: true } });
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    store.updateProject(project.id, { dirs: [repoA, repoB] });
    store.attachThread("session-multi", project.id);
    store.setThreadWorktree("session-multi", {
      worktree: repoB,
      branch: "dsh/multi-1",
      prNumber: 7,
    });
    store.save();
    remoteByCwd.set(repoA, "repoA");
    remoteByCwd.set(repoB, "repoB");
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 7 });
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, true, JSON.stringify(result));
    const mergeCall = ghCalls.find((line) => line.includes("pr merge"));
    assert.ok(mergeCall, "必须执行 gh pr merge");
    assert.match(mergeCall, /--repo stub\/repoB/u, "必须合并 worktree 所在仓库");
    assert.doesNotMatch(mergeCall, /repoA/u);
  });

  it("改动量超阈值：审批路径也拒绝（以前只查 CI/批准数）", async () => {
    setMode("big-diff");
    const { deps, store, project } = makeDeps({
      danger: { autoMerge: true },
      merge: { maxDiffFiles: 1, maxDiffLines: 100 },
    });
    const requestId = approvedRequest(store, project.id, "merge", { prNumber: 3 });
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "merge/diff-files", JSON.stringify(result));
    assert.equal(
      ghCalls.some((line) => line.includes("pr merge")),
      false,
      "不能真的 merge",
    );
    assert.ok(!approvalOf(store, requestId).executedAt, "被拒不能标记已执行");
  });

  it("delete-project 审批：失败要如实报 executed=false（漏 await 回归）", async () => {
    const { deps, store, project } = makeDeps({ danger: { trashAuto: true } });
    deps.deleteProject = async () => {
      throw new Error(
        "projects: project has 1 running/waiting thread(s); stop them before deleting",
      );
    };
    const requestId = approvedRequest(store, project.id, "delete-project", {
      projectId: project.id,
    });
    const result = await executeApprovalCore(deps, requestId);
    assert.equal(result.executed, false, JSON.stringify(result));
    assert.match(String(result.reason), /running\/waiting/u);
    assert.ok(!approvalOf(store, requestId).executedAt);
  });
});
