// @ts-check
// 建/回收隔离线程的集成测试：用**真实 git** 在 mkdtemp 里跑，sessionController 用假的。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";

import { ProjectStore } from "../lib/store.js";
import { createIsolatedThread, reclaimThreadWorktree, reconcileWorktrees } from "../lib/thread.js";
import { nextThreadIndex, worktreePath } from "../lib/worktree.js";

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
    assert.match(String(thread.branch), /^dsh\/payments-1-[a-z0-9]+$/u);
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
    // 目标目录被占（非空目录）会让 `git worktree add` 必然失败。
    // 注意不能再用「先造同名分支」：AUD-PROJ-27 修好后序号会跳过已存在分支，那种造法不再失败。
    const collidingPath = worktreePath({ repoRoot: repo, projectId: project.id, index: 1 });
    mkdirSync(collidingPath, { recursive: true });
    writeFileSync(join(collidingPath, "occupied.txt"), "x\n", "utf8");

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

  it("无目录项目：线程 cwd 在专用工作区，而不是插件数据根（审查 P1）", async () => {
    const rootDir = join(root, "data-nodir");
    const store = new ProjectStore({ root: rootDir }).load();
    const project = store.createProject("nodir");
    const sessions = fakeSessions();
    const thread = await createIsolatedThread({
      store,
      dataRoot: rootDir,
      projectId: project.id,
      deps: { runGit, createSession: sessions.createSession },
    });
    const cwd = String(sessions.requests[0].cwd);
    assert.notEqual(cwd, rootDir, "不能把插件数据根当工作区");
    assert.equal(cwd, join(rootDir, "workspaces", project.id));
    assert.equal(thread.warning, "not-a-git-repository");
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
    assert.match(String(first.branch), /^dsh\/payments-1-[a-z0-9]+$/u);
    assert.match(String(second.branch), /^dsh\/payments-2-[a-z0-9]+$/u);
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

  it("只有 .gitignore 里的文件时也拒绝回收（ignored 文件绝不随 worktree 删除）", async () => {
    // 复审 P0：git 的「干净」不包含 ignored 文件；.env / 模型缓存常被 ignore。
    const repo2 = join(root, "ignore-repo");
    mkdirSync(repo2, { recursive: true });
    await runGit(["init", "-b", "main"], repo2);
    writeFileSync(join(repo2, ".gitignore"), "*.env\nmodels/\n", "utf8");
    writeFileSync(join(repo2, "README.md"), "# demo\n", "utf8");
    await runGit(["add", "-A"], repo2);
    await runGit(
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"],
      repo2,
    );
    const store = new ProjectStore({ root: join(root, "data-ignore") }).load();
    const project = store.createProject("ignored", { dirs: [repo2] });
    const sessions = fakeSessions();
    const deps = { runGit, createSession: sessions.createSession };
    const thread = await createIsolatedThread({
      store,
      dataRoot: join(root, "data-ignore"),
      projectId: project.id,
      deps,
    });
    assert.ok(thread.worktree);
    writeFileSync(join(String(thread.worktree), ".env"), "SECRET=1\n", "utf8");

    const result = await reclaimThreadWorktree({ store, sessionId: thread.sessionId, deps });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, "dirty");
    assert.ok(readdirSync(String(thread.worktree)).includes(".env"), "ignored 文件必须还在");
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

describe("AUD-PROJ-01 无目录项目的线程 cwd 不落在插件数据根", () => {
  it("无目录项目：cwd 是 <dataRoot>/workspaces/<id>，不是 dataRoot", async () => {
    const dataRoot = join(root, "data");
    const store = new ProjectStore({ root: dataRoot }).load();
    const project = store.createProject("no-dirs");
    const sessions = fakeSessions();
    const thread = await createIsolatedThread({
      store,
      dataRoot,
      projectId: project.id,
      deps: { runGit, createSession: sessions.createSession },
    });
    const cwd = sessions.requests[0].cwd;
    assert.equal(cwd, join(dataRoot, "workspaces", project.id));
    assert.notEqual(cwd, dataRoot);
    assert.equal(thread.dir, cwd);
    // 目录真的建出来了（宿主 create 不会替我们 mkdir 失败的路径）
    assert.doesNotThrow(() => readdirSync(cwd));
  });
});

describe("AUD-PROJ-27 分支序号取已用最大值 + 1（删线程后不复用旧名）", () => {
  it("nextThreadIndex：扫 worktree 与分支名里的序号", () => {
    assert.equal(nextThreadIndex([]), 1);
    assert.equal(nextThreadIndex([{ branch: "dsh/p-1-abc123", worktree: "/w/p-1" }]), 2);
    assert.equal(
      nextThreadIndex([
        { branch: "dsh/p-3-abc123", worktree: "/w/p-3" },
        { branch: null, worktree: null },
      ]),
      4,
    );
    // 记录里没有 worktree（已回收）时仍能从分支名取到序号
    assert.equal(nextThreadIndex([{ branch: "dsh/p-7-abc123", worktree: null }]), 8);
  });

  it("删掉一条线程后新建线程不复用已存在的分支名", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    const deps = { runGit, createSession: fakeSessions().createSession };
    const first = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    assert.match(String(first.branch), /^dsh\/payments-1-/u);
    // 模拟「线程记录被删掉，但 worktree/分支还在」（真实数据有 164 次建线程 + 大量删除）
    store.detachThread(first.sessionId);
    const second = await createIsolatedThread({
      store,
      dataRoot: join(root, "data"),
      projectId: project.id,
      deps,
    });
    assert.match(String(second.branch), /^dsh\/payments-2-/u);
    assert.notEqual(second.branch, first.branch);
  });
});

describe("AUD-PROJ-21 建会话失败时回滚刚建的 worktree/分支", () => {
  it("createSession 抛错 → worktree 被移除、分支被删、审计留痕，原始错误照旧抛出", async () => {
    const store = new ProjectStore({ root: join(root, "data") }).load();
    const project = store.createProject("payments", { dirs: [repo] });
    /** @type {any[]} */
    const audits = [];
    store.appendAudit = (/** @type {any} */ entry) => {
      audits.push(entry);
      return entry;
    };
    await assert.rejects(
      () =>
        createIsolatedThread({
          store,
          dataRoot: join(root, "data"),
          projectId: project.id,
          deps: {
            runGit,
            createSession: async () => {
              throw new Error("boom");
            },
          },
        }),
      /boom/u,
    );
    const branches = await runGit(["branch", "--list", "dsh/*"], repo);
    assert.equal(String(branches.stdout).trim(), "", "回滚后不应留下 dsh/* 分支");
    const worktrees = await runGit(["worktree", "list", "--porcelain"], repo);
    assert.ok(!String(worktrees.stdout).includes(".dsh-worktrees"), "回滚后不应留下 worktree");
    assert.equal(store.listThreads(project.id).length, 0);
    assert.ok(audits.some((item) => item.action === "thread/worktree-rolled-back"));
  });
});
