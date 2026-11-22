// @ts-check
// 建「隔离线程」：先建 worktree，再建会话（cwd 建后不可变，顺序不能反），最后落归属记录。
// 依赖通过 deps 注入，所以能用真实 git + 假 sessionController 做集成测试。

import {
  branchName,
  parseMergedBranches,
  planCreate,
  planDeleteBranch,
  planRemove,
  shouldDeleteBranch,
  shouldReclaim,
  worktreePath,
} from "./worktree.js";

/**
 * @typedef {object} ThreadDeps
 * @property {(args: string[], cwd: string) => Promise<{ code: number, stdout: string, stderr: string }>} runGit
 * @property {(input: { cwd: string }) => Promise<{ sessionId: string }>} createSession
 */

/** 回收只需要 git，不需要建会话。 */
/**
 * @typedef {{ runGit: ThreadDeps["runGit"] }} ReclaimDeps
 */

/**
 * 建一个线程并尽量隔离。
 * 失败一律**降级为共享目录**而不是让用户建不出线程（设计稿 §1.2/§4）。
 * @param {object} input
 * @param {any} input.store
 * @param {string} input.dataRoot
 * @param {string} input.projectId
 * @param {ThreadDeps} input.deps
 * @returns {Promise<{
 *   sessionId: string,
 *   isolated: boolean,
 *   worktree: string|null,
 *   branch: string|null,
 *   baseSha: string|null,
 *   warning: string,
 * }>}
 */
export async function createIsolatedThread(input) {
  const { store, dataRoot, projectId, deps } = input;
  const project = store.getProject(projectId);
  if (!project) throw new Error(`projects: unknown project ${projectId}`);
  if (project.state === "archived") throw new Error(`projects: project ${projectId} is archived`);

  const primaryDir =
    Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : dataRoot;
  const index = store.listThreads(projectId).length + 1;

  /** 依次尝试：只有「是 git 仓库 + worktree add 成功」才隔离。 */
  let isolated = false;
  let worktree = null;
  let branch = null;
  let baseSha = null;
  let warning = "";

  const probe = await safeGit(deps.runGit, ["rev-parse", "--show-toplevel"], primaryDir);
  if (probe.code !== 0) {
    warning = "not-a-git-repository";
  } else {
    const repoRoot = String(probe.stdout ?? "").trim() || primaryDir;
    const head = await safeGit(deps.runGit, ["rev-parse", "HEAD"], repoRoot);
    const candidatePath = worktreePath({ repoRoot, projectId, index });
    const candidateBranch = branchName({ projectName: project.name, index });
    const created = await safeGit(
      deps.runGit,
      planCreate({ path: candidatePath, branch: candidateBranch }),
      repoRoot,
    );
    if (created.code === 0) {
      isolated = true;
      worktree = candidatePath;
      branch = candidateBranch;
      baseSha = head.code === 0 ? String(head.stdout ?? "").trim() : null;
    } else {
      warning = `worktree-failed: ${firstLine(created.stderr) || `exit ${created.code}`}`;
    }
  }

  const createdSession = await deps.createSession({
    cwd: isolated && worktree ? worktree : primaryDir,
  });
  const sessionId = String(createdSession.sessionId);
  store.attachThread(sessionId, projectId);
  if (isolated) {
    store.setThreadWorktree(sessionId, { worktree, branch, baseSha, state: "idle" });
  }
  return { sessionId, isolated, worktree, branch, baseSha, warning };
}

/**
 * 回收一个线程的 worktree：三重判据不满足就拒绝（ADR 0002）。
 * @param {object} input
 * @param {any} input.store
 * @param {string} input.sessionId
 * @param {boolean} [input.isCurrentSession]
 * @param {ReclaimDeps} input.deps
 * @returns {Promise<{ reclaimed: boolean, reason: string }>}
 */
export async function reclaimThreadWorktree(input) {
  const { store, sessionId, deps } = input;
  const record = findThread(store, sessionId);
  if (!record) return { reclaimed: false, reason: "unknown-thread" };
  const worktree = record.worktree;
  if (typeof worktree !== "string" || worktree === "")
    return { reclaimed: false, reason: "no-worktree" };

  const status = await safeGit(deps.runGit, ["status", "--porcelain"], worktree);
  // 「未推送」要按**是否已在某个远端**判断，而不是「相对 base 有没有新提交」：
  // 后者在合并之后仍然 > 0（base 不会因为合并而前移），于是合并过的线程 worktree
  // 永远回收不掉——这是 0.4.0 之前一直存在的缺陷（B5 只能绕开它）。
  // 但没有远端的仓库（本地临时仓库、离线项目）无处可推，`--not --remotes` 会把所有提交
  // 都算成未推送，于是回退到旧判据（相对 base 有无新提交）。
  const remotes = await safeGit(deps.runGit, ["remote"], worktree);
  const hasRemote = remotes.code === 0 && String(remotes.stdout ?? "").trim() !== "";
  const unpushed = await safeGit(
    deps.runGit,
    hasRemote
      ? ["rev-list", "--count", "HEAD", "--not", "--remotes"]
      : ["rev-list", "--count", `${record.baseSha ?? "HEAD"}..HEAD`],
    worktree,
  );
  // 已合并的线程：分支常被删掉（B5 就是这么做的），此时 `HEAD --not --remotes` 会把
  // 这些提交重新算成"未推送"，于是 worktree 永远回收不掉——判据要能识别"内容已在主干里"。
  let mergedIntoTarget = typeof record.mergedAt === "string" && record.mergedAt !== "";
  if (!mergedIntoTarget && hasRemote) {
    const head = await safeGit(
      deps.runGit,
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      worktree,
    );
    const target = String(head.stdout ?? "")
      .trim()
      .replace(/^refs\/remotes\//u, "");
    const candidate = target !== "" ? target : "origin/main";
    const ancestor = await safeGit(
      deps.runGit,
      ["merge-base", "--is-ancestor", "HEAD", candidate],
      worktree,
    );
    mergedIntoTarget = ancestor.code === 0;
  }
  const verdict = shouldReclaim({
    statusText: status.code === 0 ? String(status.stdout ?? "") : "status-failed",
    merged: mergedIntoTarget,
    unpushedCommits:
      unpushed.code === 0 ? Number(String(unpushed.stdout ?? "").trim() || "0") : Number.NaN,
    isCurrentSession: input.isCurrentSession === true,
  });
  if (!verdict.ok) return { reclaimed: false, reason: verdict.reason };

  const removed = await safeGit(deps.runGit, planRemove({ path: worktree }), worktree);
  if (removed.code !== 0)
    return { reclaimed: false, reason: `remove-failed: ${firstLine(removed.stderr)}` };
  store.setThreadWorktree(sessionId, {
    worktree: null,
    branch: record.branch ?? null,
    baseSha: null,
  });
  return { reclaimed: true, reason: "" };
}

/**
 * @param {any} store
 * @param {string} sessionId
 */
function findThread(store, sessionId) {
  const projects = store.listProjects();
  for (const project of projects) {
    const found = store
      .listThreads(project.id)
      .find((/** @type {any} */ thread) => thread.sessionId === sessionId);
    if (found) return found;
  }
  return null;
}

/**
 * @param {ThreadDeps["runGit"]} runGit
 * @param {string[]} args
 * @param {string} cwd
 */
async function safeGit(runGit, args, cwd) {
  try {
    const result = await runGit(args, cwd);
    return {
      code: Number(result?.code ?? 1),
      stdout: String(result?.stdout ?? ""),
      stderr: String(result?.stderr ?? ""),
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String(/** @type {any} */ (error)?.message ?? error) };
  }
}

/** @param {string} text */
function firstLine(text) {
  return String(text ?? "")
    .split("\n")[0]
    .trim()
    .slice(0, 160);
}

/**
 * 启动对账：记录里有 worktree、磁盘上没有 → 清掉记录并报告。
 * **绝不**反向删除磁盘上的未记录目录（硬性约定 1：不认识的条目保留 + 告警）。
 * @param {any} store
 * @param {{ exists: (path: string) => boolean }} deps
 * @returns {{ sessionId: string, worktree: string, reason: string }[]}
 */
export function reconcileWorktrees(store, deps) {
  /** @type {{ sessionId: string, worktree: string, reason: string }[]} */
  const changes = [];
  for (const project of store.listProjects()) {
    for (const thread of store.listThreads(project.id)) {
      const worktree = thread.worktree;
      if (typeof worktree !== "string" || worktree === "") continue;
      if (deps.exists(worktree)) continue;
      store.setThreadWorktree(thread.sessionId, { worktree: null, baseSha: null });
      changes.push({ sessionId: thread.sessionId, worktree, reason: "worktree-missing" });
    }
  }
  return changes;
}

/**
 * 回收后的分支清理：只删**已合并**的 `dsh/*` 分支，未合并的一律保留。
 * @param {object} input
 * @param {any} input.store
 * @param {string} input.sessionId
 * @param {string} input.repoRoot
 * @param {ReclaimDeps} input.deps
 * @returns {Promise<{ deleted: boolean, reason: string }>}
 */
export async function cleanupThreadBranch(input) {
  const { store, sessionId, repoRoot, deps } = input;
  const record = findThread(store, sessionId);
  if (!record) return { deleted: false, reason: "unknown-thread" };
  const branch = typeof record.branch === "string" ? record.branch : "";
  if (branch === "") return { deleted: false, reason: "no-branch" };

  const base = record.baseSha ? "HEAD" : "HEAD";
  const merged = await safeGit(deps.runGit, ["branch", "--merged", base], repoRoot);
  if (merged.code !== 0) return { deleted: false, reason: "merged-check-failed" };
  const current = await safeGit(deps.runGit, ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  // 只有在远端确实有这个分支时才查「未推送」；没有远端时 merged-into-HEAD 已是足够的判据
  const remoteExists = await safeGit(
    deps.runGit,
    ["rev-parse", "--verify", `origin/${branch}`],
    repoRoot,
  );
  const unpushed =
    remoteExists.code === 0
      ? await safeGit(deps.runGit, ["rev-list", "--count", `origin/${branch}..${branch}`], repoRoot)
      : { code: 0, stdout: "0", stderr: "" };

  const verdict = shouldDeleteBranch({
    branch,
    mergedBranches: parseMergedBranches(merged.stdout),
    currentBranch: String(current.stdout ?? "").trim(),
    unpushedCommits:
      unpushed.code === 0 ? Number(String(unpushed.stdout ?? "0").trim()) : Number.NaN,
  });
  if (!verdict.ok) return { deleted: false, reason: verdict.reason };

  const removed = await safeGit(deps.runGit, planDeleteBranch(branch), repoRoot);
  if (removed.code !== 0)
    return { deleted: false, reason: `delete-failed: ${firstLine(removed.stderr)}` };
  store.setThreadWorktree(sessionId, { branch: null });
  return { deleted: true, reason: "" };
}
