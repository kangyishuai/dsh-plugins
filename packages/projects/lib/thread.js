// @ts-check
// 建「隔离线程」：先建 worktree，再建会话（cwd 建后不可变，顺序不能反），最后落归属记录。
// 依赖通过 deps 注入，所以能用真实 git + 假 sessionController 做集成测试。

import { mkdirSync } from "node:fs";

import { projectWorkspaceDir } from "./paths.js";
import {
  branchName,
  nextThreadIndex,
  planCreate,
  planDeleteBranch,
  planRemove,
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
 *   dir: string,
 *   warning: string,
 * }>}
 */
export async function createIsolatedThread(input) {
  const { store, dataRoot, projectId, deps } = input;
  const project = store.getProject(projectId);
  if (!project) throw new Error(`projects: unknown project ${projectId}`);
  if (project.state === "archived") throw new Error(`projects: project ${projectId} is archived`);

  // F35 多目录：dirs[] 全部生效。线程按顺序找**第一个可用**的 git 仓库建 worktree；
  // 都不是 git 仓库时退回第一个目录（共享目录，界面会如实标「未隔离」）。
  // 不在这里逐个 dir 都建 worktree：一个线程只有一个 cwd（宿主 create 的 cwd 出生即固定）。
  // 无目录项目：绝不能把**插件数据根**当线程 cwd（projects.json/其它项目都在那儿）。
  // 给每条项目一个专用工作区目录，agent 只能在这里折腾。
  let fallbackDir = "";
  if (!Array.isArray(project.dirs) || project.dirs.length === 0) {
    // 单一出口（审计 AUD-PROJ-01）：协调者/定时器/提醒用的是同一个 `projectWorkspaceDir`。
    fallbackDir = projectWorkspaceDir(dataRoot, projectId);
    try {
      mkdirSync(fallbackDir, { recursive: true });
    } catch {
      // 连专用工作区都建不出来时仍然**不能**退回数据根（那里是 projects.json/trash/其它项目）。
      // 保留路径形态：后续 git 探测失败 → 共享目录降级，但 cwd 仍是这个专用目录。
    }
  }
  const candidates =
    Array.isArray(project.dirs) && project.dirs.length > 0
      ? project.dirs.filter((/** @type {unknown} */ dir) => typeof dir === "string" && dir !== "")
      : [fallbackDir];
  // AUD-PROJ-27：序号以前是「当前线程数 + 1」——删掉/脱离一条线程后计数下降，
  // 新线程会复用已存在的分支名/目录，`worktree add -b` 直接失败再静默降级成共享目录。
  // 改成「已用分支/线程序号的最大值 + 1」（后面拿到 repoRoot 后还会再看一眼 git 里的分支）。
  let index = nextThreadIndex(store.listThreads(projectId));

  /** 依次尝试：只有「是 git 仓库 + worktree add 成功」才隔离。 */
  let isolated = false;
  let worktree = null;
  let branch = null;
  let baseSha = null;
  let warning = "";
  let primaryDir = candidates[0] ?? dataRoot;
  let repoRoot = "";

  for (const candidate of candidates) {
    const probe = await safeGit(deps.runGit, ["rev-parse", "--show-toplevel"], candidate);
    if (probe.code === 0) {
      primaryDir = candidate;
      repoRoot = String(probe.stdout ?? "").trim() || candidate;
      break;
    }
  }
  if (repoRoot === "") {
    warning = "not-a-git-repository";
  } else {
    // 记录里没有、但仓库里还在的分支也要避开（线程记录删了、分支还在是常态）。
    const slugPrefix = `${branchName({ projectName: project.name, index: 1, projectId: project.id }).replace(/-1(-[A-Za-z0-9]+)?$/u, "")}-`;
    const listed = await safeGit(deps.runGit, ["branch", "--list", `${slugPrefix}*`], repoRoot);
    if (listed.code === 0) {
      let maxIndex = index - 1;
      for (const line of String(listed.stdout ?? "").split("\n")) {
        const name = line.replace(/^[*+ ]+/u, "").trim();
        if (!name.startsWith(slugPrefix)) continue;
        const tail = name.slice(slugPrefix.length).match(/^(\d+)/u);
        if (tail) maxIndex = Math.max(maxIndex, Number(tail[1]));
      }
      index = maxIndex + 1;
    }
    const head = await safeGit(deps.runGit, ["rev-parse", "HEAD"], repoRoot);
    const candidatePath = worktreePath({ repoRoot, projectId, index });
    const candidateBranch = branchName({ projectName: project.name, index, projectId: project.id });
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

  /** @type {{ sessionId: string }} */
  let createdSession;
  try {
    createdSession = await deps.createSession({
      cwd: isolated && worktree ? worktree : primaryDir,
    });
  } catch (error) {
    // AUD-PROJ-21：worktree/分支已经建好，但宿主建会话失败时以前什么都不回滚——
    // 反复失败会在 `.dsh-worktrees/` 与 `dsh/*` 分支上累积孤儿（启动对账只处理
    // 「记录在、磁盘没」，反向不删）。这里当场回滚，原始错误照旧抛给调用方。
    if (isolated && worktree) {
      try {
        await safeGit(deps.runGit, planRemove({ path: worktree, force: true }), repoRoot);
        if (branch) await safeGit(deps.runGit, planDeleteBranch(branch), repoRoot);
        store.appendAudit?.({
          action: "thread/worktree-rolled-back",
          projectId,
          worktree,
          branch,
          reason: "session-create-failed",
        });
      } catch {
        /* 回滚失败不掩盖原始错误 */
      }
    }
    throw error;
  }
  const sessionId = String(createdSession.sessionId);
  store.attachThread(sessionId, projectId);
  // 记录线程实际落在哪个目录（多目录时 UI 要能说清「这条线程跑在哪个 root」）
  store.setThreadDir(sessionId, primaryDir);
  if (isolated) {
    store.setThreadWorktree(sessionId, { worktree, branch, baseSha, state: "idle" });
  }
  return { sessionId, isolated, worktree, branch, baseSha, dir: primaryDir, warning };
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

  // `--ignored` 必须带上：git 的「干净」不包含 .gitignore 里的文件，而 .env / 模型缓存
  // 恰恰常被 ignore。只查 --porcelain 会把这些文件随 worktree 一起永久删掉（复审实测 P0）。
  const status = await safeGit(deps.runGit, ["status", "--porcelain", "--ignored"], worktree);
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
