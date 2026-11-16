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
import { createIsolatedThread, reclaimThreadWorktree } from "../lib/thread.js";

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
