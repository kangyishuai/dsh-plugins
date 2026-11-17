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
 * 分支名：`dsh/<project>-<n>`。
 * @param {{ projectName: string, index: number }} input
 * @returns {string}
 */
export function branchName(input) {
  const index = Number.isFinite(input?.index) ? Math.max(1, Math.trunc(Number(input.index))) : 1;
  return `${BRANCH_PREFIX}/${slug(input?.projectName)}-${index}`;
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
 * @param {{ statusText: string, unpushedCommits: number, isCurrentSession: boolean }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function shouldReclaim(input) {
  if (input?.isCurrentSession === true) return { ok: false, reason: "current-session" };
  if (!isCleanStatus(input?.statusText ?? "")) return { ok: false, reason: "dirty" };
  const unpushed = Number(input?.unpushedCommits ?? 0);
  if (!Number.isFinite(unpushed) || unpushed > 0) return { ok: false, reason: "unpushed-commits" };
  return { ok: true, reason: "" };
}

/**
 * 解析 `git branch --merged <base>` 的输出（每行一个分支，可能带 `*` 前缀）。
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
 * 是否允许删除一个本地分支。
 * 四条都要满足：是我们建的、已合并、不是当前分支、没有未推送提交。
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
