// @ts-check
// 建「隔离线程」：先建 worktree，再建会话（cwd 建后不可变，顺序不能反），最后落归属记录。
// 依赖通过 deps 注入，所以能用真实 git + 假 sessionController 做集成测试。

import { branchName, planCreate, planRemove, shouldReclaim, worktreePath } from "./worktree.js";

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
  const unpushed = await safeGit(
    deps.runGit,
    ["rev-list", "--count", `${record.baseSha ?? "HEAD"}..HEAD`],
    worktree,
  );
  const verdict = shouldReclaim({
    statusText: status.code === 0 ? String(status.stdout ?? "") : "status-failed",
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
