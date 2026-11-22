// @ts-check
// 建/回收隔离线程的集成测试：用**真实 git** 在 mkdtemp 里跑，sessionController 用假的。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";

import { ProjectStore } from "../lib/store.js";
import {
  cleanupThreadBranch,
  createIsolatedThread,
  reclaimThreadWorktree,
  reconcileWorktrees,
} from "../lib/thread.js";

const exec = promisify(execFile);

/** @param {string[]} args @param {string} cwd */
async function runGit(args, cwd) {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    return {
      code: Number(anyError?.code ?? 1),
      stdout: String(anyError?.stdout ?? ""),
      stderr: String(anyError?.stderr ?? ""),
    };
  }
}

/** 假会话工厂：记下每次请求的 cwd，返回递增 id。 */
function fakeSessions() {
  /** @type {{ cwd: string }[]} */
  const requests = [];
  let n = 0;
  return {
    requests,
    /** @param {{ cwd: string }} input */
    async createSession(input) {
      requests.push(input);
      n += 1;
      return { sessionId: `session-fake-${n}` };
    },
  };
}

/** @type {string} */
let root;
/** @type {string} */
let repo;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-thread-"));
  repo = join(root, "payments");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(repo, { recursive: true });
  await runGit(["init", "-q"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n", "utf8");
  await runGit(["add", "."], repo);
  await runGit(["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "init"], repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createIsolatedThread", () => {
  it("git 仓库：建出 worktree、会话 cwd 指向它、记录落盘", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const sessions = fakeSessions();

    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps: { runGit, createSession: sessions.createSession },
    });

    assert.equal(thread.isolated, true);
    assert.equal(thread.warning, "");
    assert.match(String(thread.branch), /^dsh\/payments-1$/u);
    assert.equal(sessions.requests.length, 1);
    assert.equal(sessions.requests[0].cwd, thread.worktree);

    const record = store.listThreads(project.id)[0];
    assert.equal(record.sessionId, thread.sessionId);
    assert.equal(record.worktree, thread.worktree);
    assert.equal(record.branch, thread.branch);
    assert.match(String(record.baseSha), /^[0-9a-f]{40}$/u);
  });

  it("非 git 目录：降级共享目录并给 warning，不阻断建线程", async () => {
    const plain = join(root, "plain");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(plain, { recursive: true });
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("plain", { dirs: [plain] });
    const sessions = fakeSessions();

    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps: { runGit, createSession: sessions.createSession },
    });

    assert.equal(thread.isolated, false);
    assert.equal(thread.warning, "not-a-git-repository");
    assert.equal(sessions.requests[0].cwd, plain);
    assert.equal(store.listThreads(project.id)[0].worktree ?? null, null);
  });

  it("worktree 建失败：降级 + 带原因，会话仍然建出来", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const sessions = fakeSessions();
    // 先造一个同名分支，让 worktree add -b 必然失败
    await runGit(["branch", "dsh/payments-1"], repo);

    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps: { runGit, createSession: sessions.createSession },
    });

    assert.equal(thread.isolated, false);
    assert.match(thread.warning, /^worktree-failed: /u);
    assert.equal(sessions.requests[0].cwd, repo);
  });

  it("未知项目 / 已归档项目直接拒绝", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const sessions = fakeSessions();
    await assert.rejects(
      createIsolatedThread({
        store,
        dataRoot: join(root, "data"),
        projectId: "nope",
        deps: { runGit, createSession: sessions.createSession },
      }),
      /unknown project/u,
    );
    const project = store.createProject("archived", { dirs: [repo] });
    store.archiveProject(project.id);
    await assert.rejects(
      createIsolatedThread({
        store,
        dataRoot: join(root, "data"),
        projectId: project.id,
        deps: { runGit, createSession: sessions.createSession },
      }),
      /archived/u,
    );
  });

  it("第二个线程用不同分支与路径", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const sessions = fakeSessions();
    const deps = { runGit, createSession: sessions.createSession };
    const first = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    const second = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    assert.equal(first.branch, "dsh/payments-1");
    assert.equal(second.branch, "dsh/payments-2");
    assert.notEqual(first.worktree, second.worktree);
  });
});

describe("reclaimThreadWorktree", () => {
  it("干净的 worktree 被回收，记录清空", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const sessions = fakeSessions();
    const deps = { runGit, createSession: sessions.createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    assert.ok(thread.worktree);

    const result = await reclaimThreadWorktree({ store, sessionId: thread.sessionId, deps });
    assert.deepEqual(result, { reclaimed: true, reason: "" });
    assert.equal(store.listThreads(project.id)[0].worktree, null);
    const list = await runGit(["worktree", "list", "--porcelain"], repo);
    assert.ok(!String(list.stdout).includes(String(thread.worktree)), "worktree 应已从列表消失");
  });

  it("有未提交改动时拒绝回收", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const sessions = fakeSessions();
    const deps = { runGit, createSession: sessions.createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    await import("node:fs").then(({ writeFileSync: w }) =>
      w(join(String(thread.worktree), "dirty.txt"), "x\n", "utf8"),
    );

    const result = await reclaimThreadWorktree({ store, sessionId: thread.sessionId, deps });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, "dirty");
    assert.ok(readdirSync(String(thread.worktree)).includes("dirty.txt"), "脏文件必须还在");
  });

  it("没有 worktree 的线程回收是 no-op", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("plain", { dirs: [repo] });
    store.attachThread("session-x", project.id);
    const result = await reclaimThreadWorktree({
      store,
      sessionId: "session-x",
      deps: { runGit },
    });
    assert.deepEqual(result, { reclaimed: false, reason: "no-worktree" });
  });
});

describe("reconcileWorktrees（启动对账）", () => {
  it("记录里有、磁盘上没有 → 清掉记录并报告", () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    store.attachThread("session-a", project.id);
    store.setThreadWorktree("session-a", {
      worktree: "/nope/gone",
      branch: "dsh/p-1",
      baseSha: "a".repeat(40),
    });

    const changes = reconcileWorktrees(store, { exists: () => false });
    assert.deepEqual(changes, [
      { sessionId: "session-a", worktree: "/nope/gone", reason: "worktree-missing" },
    ]);
    assert.equal(store.listThreads(project.id)[0].worktree, null);
    assert.equal(store.listThreads(project.id)[0].baseSha, null);
  });

  it("磁盘上还在 → 不动记录", () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    store.attachThread("session-b", project.id);
    store.setThreadWorktree("session-b", { worktree: "/exists/wt", branch: "dsh/p-1" });

    const changes = reconcileWorktrees(store, { exists: () => true });
    assert.deepEqual(changes, []);
    assert.equal(store.listThreads(project.id)[0].worktree, "/exists/wt");
  });

  it("没有 worktree 的线程被忽略（no-op）", () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("plain", { dirs: [repo] });
    store.attachThread("session-c", project.id);
    assert.deepEqual(reconcileWorktrees(store, { exists: () => false }), []);
  });
});

describe("cleanupThreadBranch（M4 §5）", () => {
  it("已合并的 dsh/ 分支被删除", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const deps = { runGit, createSession: fakeSessions().createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    // 顺序贴近真实：先回收 worktree（git 不允许 merge 一个仍被别的 worktree 检出的分支），
    // 再把它合回 main（模拟 PR 已合并），最后清理分支。
    await reclaimThreadWorktree({ store, sessionId: thread.sessionId, deps: { runGit } });
    // 把该分支合并回 main（模拟 PR 已合并）
    await runGit(
      [
        "-c",
        "user.email=t@local",
        "-c",
        "user.name=t",
        "merge",
        "--no-ff",
        "-m",
        "merge",
        String(thread.branch),
      ],
      repo,
    );

    const result = await cleanupThreadBranch({
      store,
      sessionId: thread.sessionId,
      repoRoot: repo,
      deps: { runGit },
    });
    assert.deepEqual(result, { deleted: true, reason: "" });
    const branches = await runGit(["branch", "--list"], repo);
    assert.ok(!String(branches.stdout).includes("dsh/payments-1"), "分支应已删除");
  });

  it("未合并的分支保留（宁可留垃圾也不丢提交）", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const deps = { runGit, createSession: fakeSessions().createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });

    const result = await cleanupThreadBranch({
      store,
      sessionId: thread.sessionId,
      repoRoot: repo,
      deps: { runGit },
    });
    assert.equal(result.deleted, false);
    assert.ok(["not-merged", "unpushed-commits"].includes(result.reason), result.reason);
    const branches = await runGit(["branch", "--list"], repo);
    assert.ok(String(branches.stdout).includes("dsh/payments-1"), "分支必须还在");
  });
});

describe("reclaimThreadWorktree：未推送判据（修 base..HEAD 的缺陷）", () => {
  const commitIn = async (/** @type {string} */ worktree, /** @type {string} */ file) => {
    writeFileSync(join(worktree, file), "x\n", "utf8");
    await runGit(["add", "."], worktree);
    await runGit(
      ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", file],
      worktree,
    );
  };

  it("有远端且提交已推送 → 允许回收（合并后也能回收，这是本次修复的点）", async () => {
    const bare = join(root, "remote.git");
    await runGit(["init", "-q", "--bare", bare], root);
    await runGit(["remote", "add", "origin", bare], repo);
    await runGit(["push", "-q", "-u", "origin", "main"], repo);

    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const deps = { runGit, createSession: fakeSessions().createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    const worktree = String(thread.worktree ?? "");
    await commitIn(worktree, "work.txt");
    // 推上去（模拟 PR 已推送），此时「相对 base 有新提交」依然 >0
    await runGit(["push", "-q", "origin", String(thread.branch ?? "")], worktree);

    const result = await reclaimThreadWorktree({
      store,
      sessionId: thread.sessionId,
      deps: { runGit },
    });
    assert.equal(result.reclaimed, true, `应允许回收：${result.reason}`);
  });

  it("有远端但提交未推送 → 拒绝回收（内容只在本地，不能丢）", async () => {
    const bare = join(root, "remote.git");
    await runGit(["init", "-q", "--bare", bare], root);
    await runGit(["remote", "add", "origin", bare], repo);
    await runGit(["push", "-q", "-u", "origin", "main"], repo);

    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const deps = { runGit, createSession: fakeSessions().createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    await commitIn(String(thread.worktree ?? ""), "local-only.txt");

    const result = await reclaimThreadWorktree({
      store,
      sessionId: thread.sessionId,
      deps: { runGit },
    });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, "unpushed-commits");
  });
});

describe("reclaimThreadWorktree：已合并线程（squash + 删分支）也能回收", () => {
  it("线程被标记 mergedAt 后，即使提交已不在任何 remote ref 上，也允许回收", async () => {
    const bare = join(root, "remote.git");
    await runGit(["init", "-q", "--bare", bare], root);
    await runGit(["remote", "add", "origin", bare], repo);
    await runGit(["push", "-q", "-u", "origin", "main"], repo);

    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const deps = { runGit, createSession: fakeSessions().createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    const worktree = String(thread.worktree ?? "");
    writeFileSync(join(worktree, "work.txt"), "change\n", "utf8");
    await runGit(["add", "."], worktree);
    await runGit(
      ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "work"],
      worktree,
    );
    await runGit(["push", "-q", "-u", "origin", String(thread.branch)], worktree);

    // squash 合并到 main，然后删掉远端分支：此时分支提交不再是 main 的祖先、也不在任何 remote ref 上
    await runGit(["checkout", "-q", "main"], repo);
    await runGit(["merge", "-q", "--squash", String(thread.branch)], repo);
    await runGit(
      ["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-qm", "squash merge"],
      repo,
    );
    await runGit(["push", "-q", "origin", "main"], repo);
    await runGit(["push", "-q", "origin", "--delete", String(thread.branch)], repo);

    // 未标记前：保守拒绝（内容无法证明已合并）
    const before = await reclaimThreadWorktree({
      store,
      sessionId: thread.sessionId,
      deps: { runGit },
    });
    assert.equal(before.reclaimed, false);
    assert.equal(before.reason, "unpushed-commits");

    // 标记 mergedAt（合并成功由插件写入）后：允许回收
    store.setThreadWorktree(thread.sessionId, { mergedAt: new Date().toISOString() });
    const after = await reclaimThreadWorktree({
      store,
      sessionId: thread.sessionId,
      deps: { runGit },
    });
    assert.equal(after.reclaimed, true, `应允许回收：${after.reason}`);
  });
});
