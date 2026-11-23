// @ts-check
// Overview 状态机单测：六态迁移表逐条 + 重启重建 + todo 步进 + 副标题 + 分组/药丸/估计。
// B1（F16/F25/F26/F27）新增的纯函数都在这里钉住；UI 只做渲染，不再自己算状态。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveState,
  deriveThreadState,
  estimateRemainingMs,
  filterRows,
  firstSentence,
  groupRows,
  hasErrorFinish,
  initialView,
  isFailureEnd,
  mergeRecord,
  needsAttention,
  pillCounts,
  reduce,
  replay,
  STATE_GROUPS,
  STATE_PILLS,
  STATE_RANK,
  settleState,
  sortRows,
  THREAD_STATES,
  todoSummary,
} from "../lib/overview.js";

const at = (/** @type {number} */ n) => 1_700_000_000_000 + n;

describe("六态（F16）", () => {
  it("六态齐全、排序权重覆盖全部、排序顺序与规格一致", () => {
    assert.deepEqual(
      [...THREAD_STATES].sort(),
      ["archived", "failed", "idle", "resolved", "waiting-user", "working"].sort(),
    );
    for (const state of THREAD_STATES) assert.equal(typeof STATE_RANK[state], "number");
    assert.ok(STATE_RANK["waiting-user"] < STATE_RANK.failed);
    assert.ok(STATE_RANK.failed < STATE_RANK.working);
    assert.ok(STATE_RANK.working < STATE_RANK.resolved);
    assert.ok(STATE_RANK.resolved < STATE_RANK.idle);
    assert.ok(STATE_RANK.idle < STATE_RANK.archived, "归档永远在最后");
  });

  it("deriveState 的优先级：archived > 等你 > 失败 > 在跑 > 已解决 > 空闲", () => {
    assert.equal(
      deriveState({
        ...initialView(),
        archived: true,
        awaitingUser: true,
        lastTurnFailed: true,
        state: "working",
        resolved: true,
      }),
      "archived",
    );
    assert.equal(
      deriveState({ ...initialView(), awaitingUser: true, lastTurnFailed: true }),
      "waiting-user",
    );
    assert.equal(
      deriveState({ ...initialView(), lastTurnFailed: true, state: "working" }),
      "failed",
    );
    assert.equal(deriveState({ ...initialView(), state: "working" }), "working");
    assert.equal(deriveState({ ...initialView(), resolved: true }), "resolved");
    // 内部归约的 done 对外一律当 idle（F16 的 done→idle 映射）
    assert.equal(deriveState({ ...initialView(), state: "done" }), "idle");
    assert.equal(deriveState(initialView()), "idle");
  });

  it("持久记录能叠回视图：重启后 resolved/archived 还在", () => {
    const resolved = mergeRecord(initialView(), {
      state: "resolved",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(resolved.resolved, true);
    assert.equal(deriveState(resolved), "resolved");
    const archived = mergeRecord(initialView(), { state: "archived" });
    assert.equal(archived.archived, true);
    assert.equal(deriveState(archived), "archived");
    assert.equal(
      deriveThreadState(undefined, { state: "resolved", resolvedAt: "2026-01-01T00:00:00.000Z" }),
      "resolved",
      "内存视图为空（刚重启）也要能读回",
    );
  });

  it("宿主实时事实优先于事件推导（pendingInput / running）", () => {
    assert.equal(
      settleState({ view: initialView(), record: { state: "idle" }, pendingInput: ["question"] }),
      "waiting-user",
    );
    assert.equal(
      settleState({ view: initialView(), record: { state: "idle" }, running: true }),
      "working",
    );
    // 归档是用户显式决定，压过一切实时事实
    assert.equal(
      settleState({ record: { state: "archived" }, running: true, pendingInput: ["approval"] }),
      "archived",
    );
  });
});

describe("reduce", () => {
  it("turn/start → working", () => {
    const view = reduce(initialView(), { type: "turn/start", at: at(1), data: { turn: 3 } });
    assert.equal(view.state, "working");
    assert.equal(view.turn, 3);
  });

  it("turn/end 正常 → done + 未读", () => {
    const view = reduce(
      reduce(initialView(), { type: "turn/start", at: at(1), data: { turn: 1 } }),
      {
        type: "turn/end",
        at: at(2),
        data: { turn: 1 },
      },
    );
    assert.equal(view.state, "done");
    assert.equal(view.unread, true);
    assert.equal(view.lastTurnFailed, false);
  });

  it("turn/end 带错误 → failed，且不算未读", () => {
    const view = reduce(initialView(), {
      type: "turn/end",
      at: at(2),
      data: { reason: { kind: "error" } },
    });
    assert.equal(view.state, "failed");
    assert.equal(view.lastTurnFailed, true);
    assert.equal(view.unread, false);
  });

  it("待处理交互优先于 failed/working", () => {
    const failed = reduce(initialView(), {
      type: "turn/end",
      at: at(1),
      data: { reason: { kind: "error" } },
    });
    const waiting = reduce(failed, { type: "interaction/pending", at: at(2) });
    assert.equal(deriveState(waiting), "waiting-user");
    const cleared = reduce(waiting, { type: "interaction/cleared", at: at(3) });
    assert.equal(deriveState(cleared), "failed", "清掉交互后回到 failed");
  });

  it("用户打开会话清未读；失败态保留", () => {
    const done = reduce(initialView(), { type: "turn/end", at: at(1) });
    assert.equal(reduce(done, { type: "session/opened", at: at(2) }).state, "idle");
    const failed = reduce(initialView(), {
      type: "turn/end",
      at: at(1),
      data: { reason: "cancelled" },
    });
    assert.equal(reduce(failed, { type: "session/opened", at: at(2) }).state, "failed");
  });

  it("不认识的事件不改变状态（前向兼容）", () => {
    const before = reduce(initialView(), { type: "turn/start", at: at(1), data: { turn: 1 } });
    const after = reduce(before, { type: "some/future-event", at: at(2), data: { x: 1 } });
    assert.deepEqual(after, before);
  });

  it("turn/start 会清掉上一轮的 failed 与手动 resolve", () => {
    const failed = reduce(initialView(), {
      type: "turn/end",
      at: at(1),
      data: { reason: { kind: "error" } },
    });
    const restarted = reduce(failed, { type: "turn/start", at: at(2), data: { turn: 2 } });
    assert.equal(restarted.state, "working");
    assert.equal(restarted.lastTurnFailed, false);
    const resolved = reduce(
      { ...initialView(), resolved: true },
      { type: "turn/start", at: at(3) },
    );
    assert.equal(resolved.resolved, false, "新的一轮开始了，旧的「已解决」不再成立");
  });
});

describe("todo/write 步进（F27）", () => {
  it("整表快照：total = 条数，done = completed 条数", () => {
    assert.deepEqual(
      todoSummary({
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "pending" },
        ],
      }),
      { total: 3, done: 1 },
    );
    assert.deepEqual(todoSummary({ todos: [] }), { total: 0, done: 0 });
    assert.equal(todoSummary({}), null, "不认识的形状不当作 0/0");
    assert.equal(todoSummary({ todos: "nope" }), null);
  });

  it("归约后视图带最新快照，且没有 todo 时仍是 0/0（UI 显示「—」）", () => {
    const view = reduce(initialView(), {
      type: "todo/write",
      at: at(1),
      data: { todos: [{ status: "completed" }, { status: "pending" }] },
    });
    assert.deepEqual(view.todos, { total: 2, done: 1 });
    assert.deepEqual(initialView().todos, { total: 0, done: 0 });
  });

  it("todo/write 不改六态（清单与状态正交）", () => {
    const working = reduce(initialView(), { type: "turn/start", at: at(1), data: { turn: 1 } });
    const after = reduce(working, {
      type: "todo/write",
      at: at(2),
      data: { todos: [{ status: "completed" }] },
    });
    assert.equal(after.state, "working");
  });
});

describe("副标题（F27）", () => {
  it("tool/call 的可读摘要成为副标题", () => {
    const view = reduce(initialView(), {
      type: "tool/call",
      at: at(1),
      data: { name: "bash", args: { command: "pnpm test" } },
    });
    assert.equal(view.subtitle, "pnpm test");
  });

  it("没有 tool/call 时用 assistant 第一句兜底，且截断", () => {
    const view = reduce(initialView(), {
      type: "assistant/message",
      at: at(1),
      data: {
        message: { content: [{ type: "text", text: "**已完成**第一句。第二句不该出现。" }] },
      },
    });
    assert.equal(view.subtitle, "已完成第一句");
    assert.equal(firstSentence("   "), "");
  });

  it("工具摘要优先于 assistant 兜底；两者都没有就留空", () => {
    const withTool = reduce(
      reduce(initialView(), {
        type: "assistant/message",
        at: at(1),
        data: { message: { content: [{ type: "text", text: "hi there." }] } },
      }),
      { type: "tool/call", at: at(2), data: { name: "read" } },
    );
    assert.equal(withTool.subtitle, "read");
    assert.equal(initialView().subtitle, "");
  });
});

describe("分组 / 药丸 / 估计（F25/F26）", () => {
  const rows = [
    { sessionId: "wait", view: { ...initialView(), state: "waiting-user" } },
    { sessionId: "fail", view: { ...initialView(), state: "failed", lastActivityAt: at(9) } },
    { sessionId: "work", view: { ...initialView(), state: "working" } },
    { sessionId: "review", view: { ...initialView(), state: "resolved" } },
    { sessionId: "idle", view: { ...initialView(), state: "idle" } },
    { sessionId: "old", view: { ...initialView(), state: "archived" } },
  ];

  it("分组顺序固定，「等你」组含失败", () => {
    const groups = groupRows(rows);
    assert.deepEqual(
      groups.map((group) => group.id),
      STATE_GROUPS.map((group) => group.id),
    );
    const waiting = groups.find((group) => group.id === "waiting-user");
    assert.equal(waiting?.count, 2);
    assert.deepEqual(waiting?.rows.map((/** @type {any} */ row) => row.sessionId).sort(), [
      "fail",
      "wait",
    ]);
    assert.equal(groups.find((group) => group.id === "archived")?.count, 1);
  });

  it("药丸条五类计数，archived 不占药丸位", () => {
    const counts = pillCounts(rows);
    assert.deepEqual(counts, {
      "waiting-user": 1,
      failed: 1,
      working: 1,
      resolved: 1,
      idle: 1,
    });
    assert.equal(STATE_PILLS.length, 5);
  });

  it("过滤留空=全部，否则只留该状态", () => {
    assert.equal(filterRows(rows, "").length, 6);
    assert.deepEqual(
      filterRows(rows, "failed").map((/** @type {any} */ row) => row.sessionId),
      ["fail"],
    );
  });

  it("排序：等你 > 失败 > 在跑 > 已解决 > 空闲 > 归档", () => {
    assert.deepEqual(
      sortRows(rows).map((row) => row.sessionId),
      ["wait", "fail", "work", "review", "idle", "old"],
    );
  });

  it("剩余时间估计只在「有剩余步数 + 至少两个样本」时给，否则 null（不编）", () => {
    assert.equal(estimateRemainingMs({ todos: null }), null);
    assert.equal(estimateRemainingMs({ todos: { total: 3, done: 3 } }), null);
    assert.equal(
      estimateRemainingMs({
        todos: { total: 6, done: 4 },
        steps: 1,
        firstActivityAt: at(1),
        lastActivityAt: at(2),
      }),
      null,
    );
    // 3 步用了 6 分钟 → 每步 3 分钟；剩 2 步 → 6 分钟
    const estimate = estimateRemainingMs({
      todos: { total: 6, done: 4 },
      steps: 3,
      firstActivityAt: at(1),
      lastActivityAt: at(1) + 6 * 60_000,
    });
    assert.equal(estimate, 6 * 60_000);
    // 极短/极长都夹在 30s ~ 60min
    assert.equal(
      estimateRemainingMs({
        todos: { total: 2, done: 0 },
        steps: 2,
        firstActivityAt: at(1),
        lastActivityAt: at(1) + 10,
      }),
      30_000,
    );
  });

  it("needsAttention 只留 waiting-user 与 failed（与分组口径一致）", () => {
    assert.deepEqual(
      needsAttention(rows).map((row) => row.sessionId),
      ["wait", "fail"],
    );
  });
});

describe("assistant/attempt 级别的失败", () => {
  it("hasErrorFinish 认出 rc.3 的真实形状", () => {
    assert.equal(
      hasErrorFinish({
        stream: [
          {
            chunk: {
              type: "finish",
              reason: { kind: "error", failure: { code: "MISSING_CREDENTIAL" } },
            },
          },
        ],
      }),
      true,
    );
    assert.equal(
      hasErrorFinish({ stream: [{ chunk: { type: "finish", reason: { kind: "end_turn" } } }] }),
      false,
    );
    assert.equal(hasErrorFinish({ stream: [] }), false);
    assert.equal(hasErrorFinish({}), false);
  });

  it("turn/end 不带 reason 时，靠本轮 attempt 的失败把状态判成 failed", () => {
    const events = [
      { type: "turn/start", at: at(1), data: { turn: 1 } },
      {
        type: "assistant/attempt",
        at: at(2),
        data: { stream: [{ chunk: { type: "finish", reason: { kind: "error" } } }] },
      },
      { type: "turn/end", at: at(3), data: { turn: 1 } },
    ];
    const view = replay(events);
    assert.equal(view.state, "failed", "这正是真机上曾误判成 done 的场景");
    assert.equal(view.lastTurnFailed, true);
  });

  it("下一轮开始时清掉上一轮的 attempt 失败标记", () => {
    const events = [
      { type: "turn/start", at: at(1), data: { turn: 1 } },
      {
        type: "assistant/attempt",
        at: at(2),
        data: { stream: [{ chunk: { type: "finish", reason: { kind: "error" } } }] },
      },
      { type: "turn/end", at: at(3), data: { turn: 1 } },
      { type: "turn/start", at: at(4), data: { turn: 2 } },
      { type: "turn/end", at: at(5), data: { turn: 2 } },
    ];
    const view = replay(events);
    assert.equal(view.state, "done");
    assert.equal(view.lastAttemptFailed, false);
  });
});

describe("isFailureEnd", () => {
  it("识别对象 reason / 字符串 reason / data.error", () => {
    assert.equal(isFailureEnd({ data: { reason: { kind: "error" } } }), true);
    assert.equal(isFailureEnd({ data: { finishReason: "aborted" } }), true);
    assert.equal(isFailureEnd({ data: { error: { message: "boom" } } }), true);
    assert.equal(isFailureEnd({ data: { reason: { kind: "end_turn" } } }), false);
    assert.equal(isFailureEnd({ data: {} }), false);
    assert.equal(isFailureEnd({}), false);
  });
});

describe("replay", () => {
  it("重放一串事件得到与增量一致的结果（重启重建）", () => {
    const events = [
      { type: "turn/start", at: at(1), data: { turn: 1 } },
      { type: "turn/end", at: at(2), data: {} },
      { type: "turn/start", at: at(3), data: { turn: 2 } },
      { type: "turn/end", at: at(4), data: { reason: { kind: "error" } } },
    ];
    const incremental = events.reduce(reduce, initialView());
    assert.deepEqual(replay(events), incremental);
    assert.equal(replay(events).state, "failed");
    assert.equal(replay(events).turn, 2);
    assert.equal(replay(events).lastActivityAt, at(4));
  });

  it("空输入回到初始视图", () => {
    assert.deepEqual(replay([]), initialView());
    // @ts-expect-error 故意传 undefined
    assert.deepEqual(replay(undefined), initialView());
  });
});

describe("排序与「需要我」", () => {
  const rows = [
    { sessionId: "idle-1", view: { ...initialView(), state: "idle" } },
    { sessionId: "work-1", view: { ...initialView(), state: "working" } },
    { sessionId: "fail-1", view: { ...initialView(), state: "failed", lastActivityAt: at(9) } },
    {
      sessionId: "wait-1",
      view: { ...initialView(), state: "waiting-user", lastActivityAt: at(1) },
    },
    { sessionId: "done-1", view: { ...initialView(), state: "done" } },
  ];

  it("按状态权重排序（done 与 idle 同档，按时间排）", () => {
    const sorted = sortRows(rows).map((row) => row.sessionId);
    assert.equal(sorted[0], "wait-1");
    assert.equal(sorted[1], "fail-1");
    assert.equal(sorted[2], "work-1");
    assert.ok(sorted.includes("done-1") && sorted.includes("idle-1"));
  });

  it("同档按最近活动时间降序", () => {
    const same = [
      { sessionId: "a", view: { ...initialView(), state: "working", lastActivityAt: at(1) } },
      { sessionId: "b", view: { ...initialView(), state: "working", lastActivityAt: at(5) } },
    ];
    assert.deepEqual(
      sortRows(same).map((row) => row.sessionId),
      ["b", "a"],
    );
  });
});

describe("B1 审查 P0-2：重启后 failed / working 仍读得到", () => {
  it("mergeRecord 把记录里的 failed 映射成 lastTurnFailed（内存视图为空也要能读回）", () => {
    const failed = mergeRecord(undefined, { state: "failed", resolvedAt: null });
    assert.equal(failed.lastTurnFailed, true);
    assert.equal(deriveState(failed), "failed");
    assert.equal(deriveThreadState(undefined, { state: "failed" }), "failed");
  });

  it("mergeRecord 把记录里的 waiting-user 读回（P2：写到盘上再读不会变 idle）", () => {
    const view = mergeRecord(undefined, { state: "waiting-user", resolvedAt: null });
    assert.equal(view.awaitingUser, true);
    assert.equal(deriveState(view), "waiting-user");
    assert.equal(deriveThreadState(undefined, { state: "waiting-user" }), "waiting-user");
    // B1 之前的历史拼写 `waiting` 同样按「等你」读（不伪造别的状态）
    assert.equal(deriveThreadState(undefined, { state: "waiting" }), "waiting-user");
    // 别的状态不会被误读成「等你」
    assert.equal(mergeRecord(undefined, { state: "idle" }).awaitingUser, false);
  });

  it("mergeRecord 把记录里的 working 映射回视图（不是 idle）", () => {
    assert.equal(mergeRecord(undefined, { state: "working" }).state, "working");
    assert.equal(deriveThreadState(undefined, { state: "working" }), "working");
    // 宿主说「真停了」时仍以宿主为准：settleState 的 running 优先级更高
    assert.equal(
      settleState({ view: undefined, record: { state: "working" }, running: false }),
      "working",
      "没有宿主 running 事实时按持久事实显示（重启后就是这样）",
    );
  });

  it("记录里的 failed 优先于视图里的 resolved（失败要人处理，与 deriveState 口径一致）", () => {
    const view = { ...initialView(), resolved: true };
    // 记录还是上一轮失败（还没被进度写回）：resolve 是用户显式决定，优先
    assert.equal(deriveState(mergeRecord(view, { state: "failed" })), "failed");
    // 但记录一旦是 resolved，就保持 resolved
    assert.equal(deriveThreadState(view, { state: "resolved" }), "resolved");
  });
});

describe("B1 审查 P1-4：firstActivityAt 用最早时间，估得出非 null 的 ~Nm", () => {
  it("真实 reduce 出来的视图：firstActivityAt 是最早事件、last 是最近事件", () => {
    const events = [
      { type: "turn/start", at: at(1), data: { turn: 1 } },
      { type: "tool/call", at: at(2), data: { name: "bash" } },
      { type: "turn/end", at: at(3), data: { turn: 1 } },
    ];
    const view = reduce(reduce(reduce(initialView(), events[0]), events[1]), events[2]);
    assert.equal(view.firstActivityAt, at(1), "第一次活动就是最早的时间（不是 Math.max）");
    assert.equal(view.lastActivityAt, at(3));
    assert.notEqual(view.firstActivityAt, view.lastActivityAt);
  });

  it("从真实 reduce 的视图能估出非 null 的剩余时间（原来恒为 null）", () => {
    const t0 = at(1);
    const events = [
      { type: "turn/start", at: t0, data: { turn: 1 } },
      {
        type: "todo/write",
        at: t0 + 60_000,
        data: { todos: [{ content: "a" }, { content: "b" }, { content: "c" }] },
      },
      { type: "tool/call", at: t0 + 180_000, data: { name: "bash" } },
      { type: "tool/call", at: t0 + 360_000, data: { name: "bash" } },
    ];
    const view = events.reduce((acc, event) => reduce(acc, event), initialView());
    assert.equal(view.todos.total, 3);
    assert.equal(view.todos.done, 0);
    assert.equal(view.firstActivityAt, t0, "最早事件");
    assert.equal(view.lastActivityAt, t0 + 360_000, "最近事件");
    const estimate = estimateRemainingMs({
      todos: view.todos,
      steps: 3, // 步数来自 observability 的 stats（与视图同一条事件流计数）
      firstActivityAt: view.firstActivityAt,
      lastActivityAt: view.lastActivityAt,
    });
    // 3 步用了 6 分钟 → 每步 3 分钟；剩 3 步 → 9 分钟
    assert.equal(estimate, 9 * 60_000, "有 2+ 样本 + 剩余步数就必须给得出估计");
  });
});
