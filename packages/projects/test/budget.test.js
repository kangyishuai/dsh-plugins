// @ts-check
// 预算闸单测：暂停/归档、每日线程数、并发数。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkThreadBudget, DAY_MS, isToday, startOfDay } from "../lib/budget.js";

const base = Date.parse("2026-11-16T10:00:00+08:00");
const dayStart = startOfDay(base);
const at = (/** @type {number} */ offset) => new Date(dayStart + offset).toISOString();

describe("isToday / startOfDay", () => {
  it("当天起点是本地 00:00", () => {
    assert.equal(new Date(dayStart).getHours(), 0);
    assert.equal(new Date(dayStart).getMinutes(), 0);
  });

  it("当天内的算今天，前一天/后一天不算", () => {
    assert.equal(isToday({ createdAt: at(1) }, base), true);
    assert.equal(isToday({ createdAt: at(DAY_MS - 1) }, base), true);
    assert.equal(isToday({ createdAt: at(-1) }, base), false);
    assert.equal(isToday({ createdAt: at(DAY_MS + 1) }, base), false);
  });

  it("缺失/非法 createdAt 不算今天（保守）", () => {
    assert.equal(isToday({}, base), false);
    assert.equal(isToday({ createdAt: "not-a-date" }, base), false);
  });
});

describe("checkThreadBudget", () => {
  it("正常项目放行，并给出用量", () => {
    const result = checkThreadBudget({ project: { state: "active" }, threads: [], now: base });
    assert.deepEqual(result, { ok: true, reason: "", used: { today: 0, running: 0 } });
  });

  it("暂停的项目拒绝（可逆，不是删除）", () => {
    const result = checkThreadBudget({ project: { state: "paused" }, threads: [], now: base });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "project-paused");
  });

  it("归档的项目拒绝", () => {
    const result = checkThreadBudget({ project: { state: "archived" }, threads: [], now: base });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "project-archived");
  });

  it("每日线程数到线拒绝；昨天的线程不计入", () => {
    const threads = [
      { createdAt: at(1), state: "done" },
      { createdAt: at(2), state: "done" },
      { createdAt: at(-DAY_MS), state: "done" },
    ];
    const hit = checkThreadBudget({
      project: { state: "active", budget: { maxThreadsPerDay: 2 } },
      threads,
      now: base,
    });
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, "budget/threads-per-day");
    assert.deepEqual(hit.used, { today: 2, running: 0 });

    const room = checkThreadBudget({
      project: { state: "active", budget: { maxThreadsPerDay: 3 } },
      threads,
      now: base,
    });
    assert.equal(room.ok, true);
  });

  it("并发数到线拒绝（只看 working）", () => {
    const threads = [
      { createdAt: at(1), state: "working" },
      { createdAt: at(2), state: "done" },
    ];
    const hit = checkThreadBudget({
      project: { state: "active", budget: { maxConcurrent: 1 } },
      threads,
      now: base,
    });
    assert.equal(result_reason(hit), "budget/concurrent-threads");
    assert.deepEqual(hit.used, { today: 2, running: 1 });
  });

  it("未设上限时不受限", () => {
    const threads = Array.from({ length: 50 }, (_, index) => ({
      createdAt: at(index),
      state: "working",
    }));
    const result = checkThreadBudget({
      project: { state: "active", budget: {} },
      threads,
      now: base,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.used, { today: 50, running: 50 });
  });

  it("暂停优先于预算（原因更贴近用户意图）", () => {
    const result = checkThreadBudget({
      project: { state: "paused", budget: { maxThreadsPerDay: 0 } },
      threads: [],
      now: base,
    });
    assert.equal(result.reason, "project-paused");
  });
});

/** @param {{reason: string}} value */
function result_reason(value) {
  return value.reason;
}
