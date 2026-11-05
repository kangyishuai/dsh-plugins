// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createWorktree, removeWorktree, validateBranch, worktreePath } from "../worktree.mjs";

// realpath：macOS 的 tmpdir 是 /var → /private/var 的软链，git 返回的是真实路径
const base = realpathSync(mkdtempSync(join(tmpdir(), "wt-test-")));
after(() => rmSync(base, { recursive: true, force: true }));
const repo = join(base, "repo");
const git = (/** @type {string[]} */ ...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();

mkdirSync(repo);
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "a");
// 与本仓库一致：/notes 不带斜杠，才能同时忽略目录和 worktree 里的符号链接
writeFileSync(join(repo, ".gitignore"), "/notes\n");
git("add", ".");
git("commit", "-q", "-m", "init");
mkdirSync(join(repo, "notes"));

test("分支名必须符合 <type>/<主题>", () => {
  assert.doesNotThrow(() => validateBranch("feat/session-delete-batch"));
  assert.throws(() => validateBranch("session-delete"), /不符合约定/);
  assert.throws(() => validateBranch("feat/Foo_Bar"), /不符合约定/);
  assert.equal(worktreePath("/x/dsh-plugins", "feat/a-b"), "/x/dsh-plugins.worktrees/feat--a-b");
});

test("新建 worktree：建分支、链接 notes；被忽略的 notes 链接不挡删除", () => {
  const target = createWorktree({ cwd: repo, branch: "feat/demo", install: false, fetch: false });
  assert.equal(target, join(base, "repo.worktrees", "feat--demo"));
  assert.ok(existsSync(join(target, "a.txt")));
  assert.ok(lstatSync(join(target, "notes")).isSymbolicLink());
  assert.match(git("branch", "--list", "feat/demo"), /feat\/demo/);

  // 已存在的分支：直接检出，不重复建
  assert.throws(
    () => createWorktree({ cwd: repo, branch: "feat/demo", install: false, fetch: false }),
    /已存在/,
  );

  // 有未跟踪文件时 git 拒绝删除
  writeFileSync(join(target, "wip.txt"), "x");
  assert.throws(() => removeWorktree({ cwd: repo, branch: "feat/demo" }));
  rmSync(join(target, "wip.txt"));
  removeWorktree({ cwd: repo, branch: "feat/demo", deleteBranch: true });
  assert.ok(!existsSync(target));
  assert.equal(git("branch", "--list", "feat/demo"), "");
});
