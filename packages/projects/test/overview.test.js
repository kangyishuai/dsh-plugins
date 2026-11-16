// @ts-check
// Overview 状态机单测：迁移表逐条 + 重启重建 + 排序。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveState,
  initialView,
  isFailureEnd,
  needsAttention,
  reduce,
  replay,
  STATE_RANK,
  sortRows,
  THREAD_STATES,
} from "../lib/overview.js";

const at = (/** @type {number} */ n) => 1_700_000_000_000 + n;

describe("states", () => {
  it("五态齐全且排序权重覆盖全部", () => {
    assert.equal(THREAD_STATES.length, 5);
    for (const state of THREAD_STATES) assert.equal(typeof STATE_RANK[state], "number");
    assert.ok(STATE_RANK["waiting-user"] < STATE_RANK.failed);
    assert.ok(STATE_RANK.failed < STATE_RANK.working);
    assert.ok(STATE_RANK.working < STATE_RANK.done);
    assert.ok(STATE_RANK.done < STATE_RANK.idle);
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
    assert.equal(waiting.state, "waiting-user");
    const cleared = reduce(waiting, { type: "interaction/cleared", at: at(3) });
    assert.equal(cleared.state, "failed", "清掉交互后回到 failed");
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

  it("turn/start 会清掉上一轮的 failed", () => {
    const failed = reduce(initialView(), {
      type: "turn/end",
      at: at(1),
      data: { reason: { kind: "error" } },
    });
    const restarted = reduce(failed, { type: "turn/start", at: at(2), data: { turn: 2 } });
    assert.equal(restarted.state, "working");
    assert.equal(restarted.lastTurnFailed, false);
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

  it("按状态权重排序", () => {
    assert.deepEqual(
      sortRows(rows).map((row) => row.sessionId),
      ["wait-1", "fail-1", "work-1", "done-1", "idle-1"],
    );
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

  it("needsAttention 只留 waiting-user 与 failed", () => {
    assert.deepEqual(
      needsAttention(rows).map((row) => row.sessionId),
      ["wait-1", "fail-1"],
    );
  });

  it("deriveState 的优先级固定", () => {
    assert.equal(
      deriveState({ ...initialView(), awaitingUser: true, lastTurnFailed: true }),
      "waiting-user",
    );
    assert.equal(
      deriveState({ ...initialView(), lastTurnFailed: true, state: "working" }),
      "failed",
    );
    assert.equal(deriveState({ ...initialView(), state: "working" }), "working");
    assert.equal(deriveState({ ...initialView(), unread: true }), "done");
    assert.equal(deriveState(initialView()), "idle");
  });
});
