// @ts-check
// worktree 隔离的纯逻辑：命名、命令计划、判据。**不做 I/O**——
// 真正的 exec/spawn 由调用方注入，所以这里每条规则都能单测。
// 设计依据见 notes/projects/m2-design.md §1。

/** worktree 的工作目录名（放在仓库同级，不污染仓库、也不进 .git）。 */
export const WORKTREE_DIR = ".dsh-worktrees";

/** 分支前缀：一眼能看出是插件建的。 */
export const BRANCH_PREFIX = "dsh";

/**
 * 把项目名压成 git 分支/目录能用的 slug。
 * 中文等项目名会退化成一串连字符，所以调用方还要拼 index 保证唯一。
 * @param {string} name
 * @returns {string}
 */
export function slug(name) {
  const normalized = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized === "" ? "project" : normalized.slice(0, 40);
}

/**
 * 分支名：`dsh/<project>-<n>[-<项目短 id>]`。
 *
 * 为什么带项目短 id：只按项目名 + 序号命名时，同名项目/重建项目会撞上远端已有分支，
 * `git push` 直接被拒（非快进），createPr 只能报 push-failed（真机复现）。
 * @param {{ projectName: string, index: number, projectId?: string }} input
 * @returns {string}
 */
export function branchName(input) {
  const index = Number.isFinite(input?.index) ? Math.max(1, Math.trunc(Number(input.index))) : 1;
  const projectId = String(input?.projectId ?? "")
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(-6);
  const suffix = projectId === "" ? "" : `-${projectId}`;
  return `${BRANCH_PREFIX}/${slug(input?.projectName)}-${index}${suffix}`;
}

/**
 * worktree 路径：`<repoParent>/.dsh-worktrees/<repoName>/<projectId>-<n>`。
 * @param {{ repoRoot: string, projectId: string, index: number }} input
 * @returns {string}
 */
export function worktreePath(input) {
  const repoRoot = String(input?.repoRoot ?? "").replace(/\/+$/u, "");
  if (repoRoot === "") throw new Error("projects: worktreePath requires repoRoot");
  const parts = repoRoot.split("/");
  const repoName = parts[parts.length - 1] || "repo";
  const parent = parts.slice(0, -1).join("/") || "/";
  const index = Number.isFinite(input?.index) ? Math.max(1, Math.trunc(Number(input.index))) : 1;
  const projectId = String(input?.projectId ?? "project").replace(/[^A-Za-z0-9_-]/gu, "");
  return `${parent}/${WORKTREE_DIR}/${repoName}/${projectId}-${index}`;
}

/**
 * 下一条线程该用的序号（AUD-PROJ-27）。
 *
 * 以前是 `store.listThreads(projectId).length + 1`：删掉/脱离一条线程后计数下降，新线程
 * 会复用**已存在**的分支名与 worktree 目录 → `git worktree add -b` 失败，然后静默降级成
 * 「共享目录」或继续往旧分支提交。改成扫已有记录的序号取最大值 + 1。
 *
 * 只读记录，不做 I/O；仓库里还留着的历史分支由 `createIsolatedThread` 再查一次。
 * @param {Array<{ branch?: string|null, worktree?: string|null }>} threads
 * @returns {number}
 */
export function nextThreadIndex(threads) {
  let max = 0;
  for (const thread of Array.isArray(threads) ? threads : []) {
    const worktree = String(thread?.worktree ?? "");
    const fromWorktree = worktree.match(/-(\d+)$/u);
    if (fromWorktree) max = Math.max(max, Number(fromWorktree[1]));
    const branch = String(thread?.branch ?? "");
    // 分支形如 dsh/<slug>-<n>[-<短 id>]
    const fromBranch = branch.match(/-(\d+)(?:-[A-Za-z0-9]+)?$/u);
    if (fromBranch) max = Math.max(max, Number(fromBranch[1]));
  }
  return Number.isFinite(max) && max > 0 ? max + 1 : 1;
}

/**
 * 生成建 worktree 的参数（不含可执行文件本身）。
 * @param {{ path: string, branch: string, base?: string }} input
 * @returns {string[]}
 */
export function planCreate(input) {
  const args = ["worktree", "add", "-b", input.branch];
  if (typeof input.base === "string" && input.base !== "") args.push(input.base);
  args.push(input.path);
  return args;
}

/**
 * 生成删 worktree 的参数。
 * @param {{ path: string, force?: boolean }} input
 * @returns {string[]}
 */
export function planRemove(input) {
  return input?.force === true
    ? ["worktree", "remove", "--force", input.path]
    : ["worktree", "remove", input.path];
}

/**
 * 解析 `git worktree list --porcelain`。
 * @param {string} text
 * @returns {{ path: string, head: string, branch: string }[]}
 */
export function parseWorktreeList(text) {
  /** @type {{ path: string, head: string, branch: string }[]} */
  const out = [];
  /** @type {{ path: string, head: string, branch: string }} */
  let current = { path: "", head: "", branch: "" };
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      if (current.path !== "") out.push(current);
      current = { path: "", head: "", branch: "" };
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length);
  }
  if (current.path !== "") out.push(current);
  return out;
}

/**
 * `git status --porcelain` 是否干净（空输出即干净）。
 * @param {string} statusText
 * @returns {boolean}
 */
export function isCleanStatus(statusText) {
  return String(statusText ?? "").trim() === "";
}

/**
 * 是否允许回收一个 worktree：三重判据，任一不满足就保留。
 * 宁可留垃圾，也不删用户的东西（ADR 0002）。
 * @param {{ statusText: string, unpushedCommits: number, isCurrentSession?: boolean, merged?: boolean }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function shouldReclaim(input) {
  if (input?.isCurrentSession === true) return { ok: false, reason: "current-session" };
  if (!isCleanStatus(input?.statusText ?? "")) return { ok: false, reason: "dirty" };
  // 已经合并进远端主干的：内容安全落在主干里，分支被删也算"已推送"，可以回收。
  // 否则 squash 合并 + 删分支之后，提交不再挂在任何 remote ref 上，worktree 永远回收不掉。
  if (input?.merged === true) return { ok: true, reason: "" };
  const unpushed = Number(input?.unpushedCommits ?? 0);
  if (!Number.isFinite(unpushed) || unpushed > 0) return { ok: false, reason: "unpushed-commits" };
  return { ok: true, reason: "" };
}

/**
 * 解析 `git branch --merged <base>` 的输出（每行一个分支，可能带 `*` 前缀）。
 *
 * @deprecated 只服务于已被 `shouldDeleteBranchV2` 取代的 V1 判据（AUD-PROJ-22）。
 * `git branch --merged` 在「未提交的新分支」与「squash 合并的分支」两个方向都会误判，
 * **禁止**在任何新的删除路径里使用；保留导出只为让 worktree.test.js 记着这段历史原因。
 * @param {string} text
 * @returns {string[]}
 */
export function parseMergedBranches(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\*\s*/u, "").trim())
    .filter((line) => line !== "");
}

/**
 * 是否允许删除一个本地分支（**V1 判据，已废弃**）。
 *
 * @deprecated AUD-PROJ-22：V2（`shouldDeleteBranchV2`）已替代它，service 里零调用。
 * 它依赖的 `git branch --merged` 两向都误判，谁下轮接错线就会复活已知错误判据——
 * **禁止**在新代码里使用，只在 worktree.test.js 里作为对照保留。
 * @param {{ branch: string, mergedBranches: string[], currentBranch: string, unpushedCommits?: number }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function shouldDeleteBranch(input) {
  const branch = String(input?.branch ?? "").trim();
  if (branch === "") return { ok: false, reason: "no-branch" };
  if (!branch.startsWith(`${BRANCH_PREFIX}/`)) return { ok: false, reason: "branch-not-ours" };
  if (String(input?.currentBranch ?? "") === branch) return { ok: false, reason: "current-branch" };
  const unpushed = Number(input?.unpushedCommits ?? 0);
  if (!Number.isFinite(unpushed) || unpushed > 0) return { ok: false, reason: "unpushed-commits" };
  const merged = Array.isArray(input?.mergedBranches) ? input.mergedBranches : [];
  if (!merged.includes(branch)) return { ok: false, reason: "not-merged" };
  return { ok: true, reason: "" };
}

/**
 * 生成删分支的参数（默认 `-d`，**不用 `-D`**：宁可失败也不强删未合并内容）。
 * @param {string} branch
 * @returns {string[]}
 */
export function planDeleteBranch(branch) {
  return ["branch", "-d", String(branch)];
}

/**
 * 删分支判据 v2（规格 §7.7.5）。
 *
 * 为什么不用 `git branch --merged`：它在两个方向都会误判（未提交的新分支被当"已合并"、
 * squash 合并的分支被当"未合并"，见 docs/runtime §11.15）。改成三条互相独立的判据：
 *  ① 分支是插件建的（`dsh/` 前缀且与线程记录一致）
 *  ② 该线程**确实有合并结果**（记录里有 mergedAt，或 GitHub 上 PR 为 MERGED）
 *  ③ 本地没有未推送提交：`git rev-list --count <branch> --not --remotes` 为 0
 *
 * @param {{ branch?: string|null, threadBranch?: string|null, merged?: boolean, unpushedCommits?: number }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function shouldDeleteBranchV2(input) {
  const branch = String(input?.branch ?? "").trim();
  const threadBranch = String(input?.threadBranch ?? "").trim();
  if (branch === "") return { ok: false, reason: "no-branch" };
  if (!branch.startsWith(`${BRANCH_PREFIX}/`)) return { ok: false, reason: "branch-not-ours" };
  if (threadBranch !== branch) return { ok: false, reason: "branch-not-recorded" };
  if (input?.merged !== true) return { ok: false, reason: "not-merged" };
  const unpushed = Number(input?.unpushedCommits ?? 0);
  if (!Number.isFinite(unpushed) || unpushed > 0) return { ok: false, reason: "unpushed-commits" };
  return { ok: true, reason: "" };
}
