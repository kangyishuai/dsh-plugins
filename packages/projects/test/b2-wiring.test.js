// @ts-check
// B2 单测：F15 跨项目移动禁止 / F21 轮询纯函数 / F10 信封扩展 / F17 tasks 明细。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { initialView, reduce, todoItems } from "../lib/overview.js";
import {
  nextPollDelay,
  POLL_MAX_MS,
  POLL_MIN_MS,
  parsePrList,
  planThreadPatches,
  realtimeCiSpec,
  rollupState,
  shouldPollProject,
} from "../lib/pr-poll.js";
import { ProjectStore } from "../lib/store.js";
import { buildEnvelope } from "../lib/wake.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-b2-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("F15 线程不可跨项目移动", () => {
  it("空槽可以挂进项目（不是搬家的唯一合法情况）", () => {
    const store = new ProjectStore({ root }).load();
    const a = store.createProject("alpha");
    const thread = store.attachThread("s-1", a.id);
    assert.equal(thread.projectId, a.id);
    assert.equal(store.projectOfSession("s-1").id, a.id);
  });

  it("已在 A 项目 → 拒绝移到 B，并指出原来在哪", () => {
    const store = new ProjectStore({ root }).load();
    const a = store.createProject("alpha");
    const b = store.createProject("beta");
    store.attachThread("s-1", a.id);
    assert.throws(
      () => store.attachThread("s-1", b.id),
      (error) => {
        const anyError = /** @type {any} */ (error);
        assert.equal(anyError.code, "thread-in-other-project");
        assert.equal(anyError.currentProjectId, a.id);
        return /already belongs to project/u.test(String(anyError.message));
      },
    );
    // 拒绝之后归属没被改：记录仍指向 A
    assert.equal(store.projectOfSession("s-1").id, a.id);
  });

  it("同一项目重复 attach 是幂等的（保留 todos/分支等既有字段）", () => {
    const store = new ProjectStore({ root }).load();
    const a = store.createProject("alpha");
    store.attachThread("s-1", a.id);
    store.setThreadTodos("s-1", { total: 3, done: 1 });
    store.setThreadWorktree("s-1", { branch: "dsh/x" });
    const again = store.attachThread("s-1", a.id);
    assert.deepEqual(again.todos, { total: 3, done: 1 });
    assert.equal(again.branch, "dsh/x");
  });

  it("detach 之后可以挂进另一个项目（先摘再挂是唯一路径）", () => {
    const store = new ProjectStore({ root }).load();
    const a = store.createProject("alpha");
    const b = store.createProject("beta");
    store.attachThread("s-1", a.id);
    assert.equal(store.detachThread("s-1"), true);
    const moved = store.attachThread("s-1", b.id);
    assert.equal(moved.projectId, b.id);
  });

  it("未知项目仍然直接拒绝", () => {
    const store = new ProjectStore({ root }).load();
    assert.throws(() => store.attachThread("s-1", "nope"), /unknown project/u);
  });
});

describe("F21 PR/CI 轮询（纯函数）", () => {
  it("间隔恒在 30–90s，连续失败退避但不超上限", () => {
    assert.equal(nextPollDelay({ failures: 0 }), POLL_MIN_MS);
    assert.ok(nextPollDelay({ failures: 1 }) > POLL_MIN_MS);
    assert.equal(nextPollDelay({ failures: 9 }), POLL_MAX_MS);
    assert.ok(nextPollDelay({ base: 1 }) >= POLL_MIN_MS);
  });

  it("只有「有开放 PR + 档位不是 off」才轮询", () => {
    assert.deepEqual(shouldPollProject({ prTier: "draft", threads: [] }), {
      poll: false,
      reason: "no-open-pr",
      openPrs: 0,
    });
    assert.equal(shouldPollProject({ prTier: "off", threads: [{ prNumber: 12 }] }).poll, false);
    assert.equal(shouldPollProject({ prTier: "draft", threads: [{ prNumber: 12 }] }).poll, true);
  });

  it("statusCheckRollup 归约成四态（没有 checks 是 none，不编 pending）", () => {
    assert.equal(rollupState([]), "none");
    assert.equal(rollupState(null), "none");
    assert.equal(rollupState([{ conclusion: "SUCCESS" }]), "passing");
    assert.equal(rollupState([{ conclusion: "FAILURE" }]), "failing");
    assert.equal(rollupState([{ status: "IN_PROGRESS" }]), "pending");
    assert.equal(rollupState([{ conclusion: "SUCCESS" }, { state: "PENDING" }]), "failing");
  });

  it("解析 gh pr list 输出；坏 JSON 明确失败而不是空列表冒充成功", () => {
    const parsed = parsePrList(
      JSON.stringify([
        { number: 7, headRefOid: "abc", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
        { number: 0 },
        { number: "x" },
      ]),
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].ciState, "passing");
    assert.equal(parsePrList("not json").ok, false);
    assert.equal(parsePrList("").reason, "empty-output");
    assert.equal(parsePrList("{}").reason, "not-an-array");
  });

  it("只给变化过的线程出补丁（避免每轮无意义落盘）", () => {
    const rows = [{ number: 7, headRefOid: "new", ciState: "failing" }];
    const patches = planThreadPatches(
      {
        threads: [
          { sessionId: "s-1", prNumber: 7, ciState: "passing", headRefOid: "old" },
          { sessionId: "s-2", prNumber: 8, ciState: "passing" },
          { sessionId: "s-3", prNumber: 7, ciState: "failing", headRefOid: "new" },
        ],
      },
      rows,
    );
    assert.deepEqual(patches, [{ sessionId: "s-1", ciState: "failing", headRefOid: "new" }]);
  });

  it("实验档说清前置条件与后果（不是假开关）", () => {
    const spec = realtimeCiSpec();
    assert.equal(spec.key, "realtimeCi");
    assert.ok(spec.requires.some((item) => /管理员/u.test(item)));
    assert.ok(/webhook/u.test(spec.warning));
  });
});

describe("F10 信封扩展：最近线程 + 记忆索引", () => {
  it("两段各自独立出现，空串时不占上下文", () => {
    const envelope = buildEnvelope({
      reason: "thread-activity",
      project: { id: "p1", name: "alpha" },
      thread: { sessionId: "s1", state: "done", turn: 2 },
      report: "done",
      next: "tell the user",
      memoryIndex: "MEMORY.md 的索引",
      recentThread: "- 别的线程 (state=working)",
    });
    const names = envelope.sections.map((section) => section.name);
    assert.ok(names.includes("memory"));
    assert.ok(names.includes("recent-thread"));
    assert.match(envelope.text, /project-memory-index:/u);
    assert.match(envelope.text, /recent-thread:/u);

    const bare = buildEnvelope({
      reason: "thread-activity",
      project: { id: "p1", name: "alpha" },
      thread: { sessionId: "s1" },
      report: "done",
      next: "x",
    });
    assert.equal(
      bare.sections.some((section) => section.name === "memory"),
      false,
    );
    assert.equal(
      bare.sections.some((section) => section.name === "recent-thread"),
      false,
    );
  });

  it("超长段落被裁剪（不把整个 MEMORY.md 塞进每一步）", () => {
    const envelope = buildEnvelope({
      reason: "thread-activity",
      project: { id: "p1", name: "alpha" },
      thread: { sessionId: "s1" },
      report: "done",
      next: "x",
      memoryIndex: "行\n".repeat(5000),
    });
    assert.ok(envelope.text.length < 6000);
    assert.match(envelope.text, /truncated/u);
  });
});

describe("F17 Tasks 逐项明细", () => {
  it("todo/write 归约出 ✓/◌ 需要的 content+status，并保留 n/m", () => {
    const view = reduce(initialView(), {
      type: "todo/write",
      data: {
        todos: [
          { content: "写单测", status: "completed" },
          { content: "跑冒烟", status: "pending" },
        ],
      },
    });
    assert.deepEqual(view.todos, { total: 2, done: 1 });
    assert.equal(view.todoItems.length, 2);
    assert.equal(view.todoItems[0].content, "写单测");
    assert.equal(view.todoItems[1].status, "pending");
  });

  it("坏形状不覆盖旧快照（不把坏数据当 0/0）", () => {
    const base = reduce(initialView(), {
      type: "todo/write",
      data: { todos: [{ content: "a", status: "completed" }] },
    });
    const after = reduce(base, { type: "todo/write", data: { nope: true } });
    assert.deepEqual(after.todos, { total: 1, done: 1 });
    assert.equal(todoItems({ nope: true }).length, 0);
  });
});
