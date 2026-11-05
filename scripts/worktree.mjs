#!/usr/bin/env node
// @ts-check
// 用法：
//   pnpm wt <branch> [--base <ref>] [--no-install]   新建分支 + worktree（已有分支则直接检出）
//   pnpm wt list                                       列出所有 worktree
//   pnpm wt rm <branch> [--delete-branch]              删除 worktree（有未提交改动时 git 会拒绝）
//
// worktree 统一放在主仓库旁边：<主仓库>.worktrees/<branch，斜杠换成 -->
// 新 worktree 会自动：链接主仓库的私有 notes/（如果有）、pnpm install。
// git hooks 存在主仓库的 .git/hooks 里，所有 worktree 共用，不需要重装。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { isMain, REPO_ROOT } from "./lib/repo.mjs";

/** 与 commitlint 的 type 保持一致 */
export const BRANCH_RE =
  /^(feat|fix|docs|refactor|perf|test|chore|ci|build|style|revert)\/[a-z0-9][a-z0-9-]*$/;

/** @param {string} branch */
export function validateBranch(branch) {
  if (!BRANCH_RE.test(branch)) {
    throw new Error(
      `分支名不符合约定：${branch}\n应为 <type>/<plugin>-<主题>，例如 feat/session-delete-batch、chore/repo-worktree`,
    );
  }
}

/**
 * @param {string} mainRoot 主 worktree 的路径
 * @param {string} branch
 */
export function worktreePath(mainRoot, branch) {
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`, branch.replaceAll("/", "--"));
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 主 worktree = `git worktree list` 的第一项（在任何 worktree 里运行都能找到它） @param {string} cwd */
export function mainWorktree(cwd) {
  const first = git(["worktree", "list", "--porcelain"], cwd).split("\n")[0];
  return first.replace(/^worktree /, "");
}

/** @param {string} cwd @param {string} ref */
function refExists(cwd, ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", ref], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ cwd?: string, branch: string, base?: string, install?: boolean, fetch?: boolean }} options
 * @returns {string} 新 worktree 的路径
 */
export function createWorktree({ cwd = REPO_ROOT, branch, base, install = true, fetch = true }) {
  validateBranch(branch);
  const main = mainWorktree(cwd);
  const target = worktreePath(main, branch);
  if (existsSync(target)) throw new Error(`worktree 已存在：${target}`);

  if (refExists(main, `refs/heads/${branch}`)) {
    git(["worktree", "add", target, branch], main);
  } else {
    if (fetch) {
      try {
        git(["fetch", "--quiet", "origin", "main"], main);
      } catch {
        console.warn("warn: git fetch origin main 失败，用本地的 main 作为基线");
      }
    }
    const from = base ?? (refExists(main, "refs/remotes/origin/main") ? "origin/main" : "main");
    git(["worktree", "add", "--no-track", "-b", branch, target, from], main);
  }

  // 私有笔记不在 git 里，新 worktree 看不到；链接过去，免得在两处各写一份
  const notes = join(main, "notes");
  const linked = join(target, "notes");
  if (existsSync(notes) && !lstatExists(linked)) symlinkSync(notes, linked, "dir");

  if (install) {
    const result = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: target,
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error("pnpm install 失败，worktree 已创建，可进去手动重试");
  }
  return target;
}

/** @param {string} path */
function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ cwd?: string, branch: string, deleteBranch?: boolean }} options
 * @returns {string} 被删除的 worktree 路径
 */
export function removeWorktree({ cwd = REPO_ROOT, branch, deleteBranch = false }) {
  const main = mainWorktree(cwd);
  const target = worktreePath(main, branch);
  // 不加 --force：有未提交或未跟踪的改动时让 git 拒绝，避免误删工作成果
  git(["worktree", "remove", target], main);
  if (deleteBranch) {
    try {
      git(["branch", "-d", branch], main);
    } catch {
      console.warn(
        `warn: 分支 ${branch} 没有合并进当前分支，未删除。squash 合并的分支 git 认不出来；\n` +
          `      确认 PR 已合并后，手动执行 git branch -D ${branch}`,
      );
    }
  }
  return target;
}

if (isMain(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      "no-install": { type: "boolean", default: false },
      "delete-branch": { type: "boolean", default: false },
    },
  });
  const [first, second] = positionals;
  try {
    if (!first) {
      console.log("用法：pnpm wt <branch> | pnpm wt list | pnpm wt rm <branch> [--delete-branch]");
      process.exit(1);
    } else if (first === "list") {
      console.log(git(["worktree", "list"], REPO_ROOT));
    } else if (first === "rm") {
      if (!second) throw new Error("用法：pnpm wt rm <branch> [--delete-branch]");
      console.log(
        `已删除 ${removeWorktree({ branch: second, deleteBranch: values["delete-branch"] })}`,
      );
    } else {
      const target = createWorktree({
        branch: first,
        base: values.base,
        install: !values["no-install"],
      });
      console.log(`\n已创建 worktree：${target}`);
      console.log(`进入：cd "${target}"`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
