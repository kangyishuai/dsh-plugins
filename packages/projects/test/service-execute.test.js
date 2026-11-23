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

/** 场景文件：桩 gh 按此返回不同 PR 状态。 */
const setMode = (/** @type {string} */ mode) => writeFileSync(modeFile, mode, "utf8");

/** 假 gh：按 mode 返回不同 PR 状态（不碰网络、不碰 PATH）。 */
const fakeGh = async (/** @type {string[]} */ args) => {
  const line = args.join(" ");
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
const fakeGit = async (/** @type {string[]} */ args) => {
  const line = args.join(" ");
  if (line.includes("remote get-url origin"))
    return { code: 0, stdout: "https://github.com/stub/repo.git", stderr: "" };
  if (line.includes("rev-parse"))
    return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-svc-exec-"));
  modeFile = join(root, "mode");
  writeFileSync(modeFile, "ok", "utf8");
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
