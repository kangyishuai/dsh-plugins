// @ts-check
// P0-2 的回归网：`replay()` 必须真的被启动路径用上，否则重启后视图归零。
//
// 分两层锁：
//   1. 纯函数 + 真实 ProjectStore：写事件 → 落盘 → 新 store load → hydrateThreadView 非 idle；
//   2. service 接线契约（测试进程不能 import 宿主包，所以读源码断言）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  applyRecordResolution,
  compactEvent,
  deriveThreadState,
  hydrateThreadView,
  REPLAY_EVENT_CAP,
  replay,
} from "../lib/overview.js";
import { ProjectStore } from "../lib/store.js";

const PKG_DIR = join(import.meta.dirname, "..");
const AT = Date.parse("2026-11-23T10:00:00.000Z");

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-replay-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 一轮失败的事件序列（与宿主 rc.5 的形状一致：turn/start → attempt(error) → turn/end）。 */
function failedTurn() {
  return [
    { type: "turn/start", at: AT, data: { turn: 1 } },
    {
      type: "assistant/attempt",
      at: AT + 10,
      data: {
        stream: [{ chunk: { type: "finish", reason: { kind: "error", failure: "no-model" } } }],
      },
    },
    { type: "turn/end", at: AT + 20, data: {} },
  ];
}

describe("compactEvent：只留可回放的最小事实", () => {
  it("认识的事件被收敛成可回放形状（正文/参数不落盘）", () => {
    const attempt = compactEvent(failedTurn()[1]);
    const message = compactEvent({
      type: "assistant/message",
      at: AT + 30,
      data: { message: { content: [{ type: "text", text: "我会先看一遍代码。再改。" }] } },
    });
    const tool = compactEvent({
      type: "tool/call",
      at: AT + 40,
      data: { args: { command: "pnpm test" } },
    });
    const todos = compactEvent({
      type: "todo/write",
      at: AT + 50,
      data: { todos: [{ content: "修 bug", status: "completed" }] },
    });
    const pending = compactEvent({ type: "interaction/pending", at: AT + 60, data: {} });
    for (const item of [attempt, message, tool, todos, pending]) assert.ok(item !== null);
    const text = JSON.stringify([attempt, message, tool, todos, pending]);
    assert.ok(!text.includes("no-model"), "failure 正文不进盘");
    assert.ok(!text.includes("再改"), "assistant 正文只留第一句");
    assert.deepEqual(message?.data, {
      message: { content: [{ type: "text", text: "我会先看一遍代码" }] },
    });
    assert.deepEqual(tool?.data, { name: "pnpm test" }, "tool/call 只留摘要");
  });

  it("不改变视图的事件返回 null（不占盘）；坏 todo 形状不存（避免回放成 0/0）", () => {
    assert.equal(compactEvent({ type: "user/message", data: { message: { content: [] } } }), null);
    assert.equal(compactEvent({ type: "tool/result", data: { ok: true } }), null);
    assert.equal(
      compactEvent({ type: "assistant/attempt", data: {} }),
      null,
      "正常 attempt 不加视图",
    );
    assert.equal(compactEvent({ type: "todo/write", data: { todos: "坏" } }), null);
    assert.equal(compactEvent(/** @type {any} */ (null)), null);
  });

  it("压缩后的事件回放出来与原始事件同样的视图（摘要不是另一套事实）", () => {
    const events = failedTurn();
    /** @type {any[]} */
    const compacted = events.map((event) => compactEvent(event)).filter(Boolean);
    assert.equal(deriveThreadState(replay(compacted), {}), "failed");
    assert.equal(deriveThreadState(replay(events), {}), "failed");
  });
});

describe("hydrateThreadView：重启等价", () => {
  it("先写事件 → 新 store load → replay 后状态非 idle（P0-2 的核心断言）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("s-1", project.id);
    store.setThreadWorktree("s-1", { worktree: null, branch: null, baseSha: null });
    for (const event of failedTurn()) {
      const compact = compactEvent(event);
      if (compact) store.appendThreadEvent("s-1", compact);
    }
    store.save();

    // 模拟重启：全新 store 实例，不经过任何内存视图
    const cold = new ProjectStore({ root }).load();
    const record = cold.state.threads["s-1"];
    assert.ok(Array.isArray(record.events) && record.events.length === 3, "journal 落盘并读回");
    const view = hydrateThreadView(record, record.events);
    const state = deriveThreadState(view, record);
    assert.notEqual(state, "idle", "重启后视图不能归零");
    assert.equal(state, "failed");
    // 对照：没接 replay（空事件）时只能推出 idle —— 这正是修复前的病
    assert.equal(deriveThreadState(hydrateThreadView(record, []), record), "idle");
  });

  it("人工 resolve 盖过更早的失败（重启后不会弹回 failed）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("s-2", project.id);
    for (const event of failedTurn()) {
      const compact = compactEvent(event);
      if (compact) store.appendThreadEvent("s-2", compact);
    }
    store.setThreadResolved("s-2", true);
    store.save();

    const cold = new ProjectStore({ root }).load();
    const record = cold.state.threads["s-2"];
    assert.equal(deriveThreadState(hydrateThreadView(record, record.events), record), "resolved");
  });

  it("resolve 之后又有新活动 → 旧 resolvedAt 过期，新的失败态赢", () => {
    const record = {
      state: "failed",
      resolvedAt: "2026-11-23T10:00:00.000Z",
      lastActivityAt: "2026-11-23T10:00:00.000Z",
    };
    const events = [
      { type: "turn/start", at: Date.parse("2026-11-23T11:00:00.000Z"), data: { turn: 2 } },
      {
        type: "turn/end",
        at: Date.parse("2026-11-23T11:00:10.000Z"),
        data: { reason: { kind: "error" } },
      },
    ];
    assert.equal(deriveThreadState(hydrateThreadView(record, events), record), "failed");
    // resolvedAt 之后没有任何活动 → resolved 生效（盘上的 state 也会是 resolved）
    const resolvedLater = {
      ...record,
      state: "resolved",
      resolvedAt: "2026-11-23T12:00:00.000Z",
    };
    assert.equal(
      deriveThreadState(applyRecordResolution(replay(events), resolvedLater), resolvedLater),
      "resolved",
    );
  });

  it("journal 有上限：只留尾部 REPLAY_EVENT_CAP 条", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("s-3", project.id);
    for (let index = 0; index < REPLAY_EVENT_CAP + 25; index += 1) {
      store.appendThreadEvent("s-3", { type: "session/activity", at: AT + index });
    }
    assert.equal(store.state.threads["s-3"].events.length, REPLAY_EVENT_CAP);
    store.save();
    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    assert.equal(raw.threads["s-3"].events.length, REPLAY_EVENT_CAP);
    assert.equal(raw.threads["s-3"].events.at(-1).at, AT + REPLAY_EVENT_CAP + 24);
  });

  it("旧数据没有 events 字段也能读（升级不丢已写状态）", () => {
    writeFileSync(
      join(root, "projects.json"),
      `${JSON.stringify({
        format: 1,
        projects: { prj_old: { id: "prj_old", name: "old", state: "active", dirs: [] } },
        threads: {
          "s-old": { projectId: "prj_old", state: "failed", lastActivityAt: null },
        },
        audit: [],
      })}\n`,
      "utf8",
    );
    const store = new ProjectStore({ root }).load();
    const record = store.state.threads["s-old"];
    assert.deepEqual(record.events, []);
    assert.equal(deriveThreadState(hydrateThreadView(record, record.events), record), "failed");
  });
});

describe("service 接线契约：启动路径必须调用 replay（P0-2）", () => {
  it("构造时 hydrateViews()，事件路径 appendThreadEvent，且只对结构性事件立刻落盘", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(join(PKG_DIR, "lib", "service.js"), "utf8");
    assert.match(source, /this\.hydrateViews\(\)/u, "启动路径必须重建视图");
    assert.match(source, /hydrateThreadView\(thread, thread\.events\)/u);
    assert.match(source, /this\.store\.appendThreadEvent\(sessionId, compact\)/u);
    assert.match(source, /const compact = compactEvent\(event\)/u);
    assert.match(source, /journaledNow/u);
  });
});
