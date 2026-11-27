// @ts-check
// 预算闸单测：暂停/归档、每日线程数、并发数。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkStepBudget,
  checkThreadBudget,
  checkTokenBudget,
  checkWeeklyTokenBudget,
  DAY_MS,
  isToday,
  startOfDay,
  startOfWeek,
  tokensOf,
} from "../lib/budget.js";

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

// ---- token 维度 ----

describe("tokensOf", () => {
  const now = Date.parse("2026-11-16T10:00:00+08:00");
  const today = new Date(startOfDay(now) + 60_000).toISOString();

  it("优先用 totalTokens", () => {
    assert.equal(
      tokensOf({ at: today, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 99 } }, now),
      99,
    );
  });

  it("没有 totalTokens 时用 input+output", () => {
    assert.equal(tokensOf({ at: today, usage: { inputTokens: 10, outputTokens: 5 } }, now), 15);
  });

  it("不是今天的记录不计入", () => {
    const yesterday = new Date(startOfDay(now) - 1000).toISOString();
    assert.equal(tokensOf({ at: yesterday, usage: { totalTokens: 99 } }, now), 0);
  });

  it("缺 usage / 非法数字按 0（不抛错、不产生 NaN 累计）", () => {
    assert.equal(tokensOf({ at: today }, now), 0);
    assert.equal(tokensOf({ at: today, usage: {} }, now), 0);
    assert.equal(tokensOf({ at: today, usage: { inputTokens: "x" } }, now), 0);
    assert.equal(tokensOf({ at: today, usage: { inputTokens: -5, outputTokens: -5 } }, now), 0);
  });
});

describe("checkTokenBudget", () => {
  it("未设上限时永远放行", () => {
    assert.deepEqual(checkTokenBudget({ dailyTokens: null, usedTokens: 10_000 }), {
      ok: true,
      used: 10_000,
      limit: null,
      reason: "",
    });
  });

  it("到线拒绝并给出原因（与线程数原因分开）", () => {
    const hit = checkTokenBudget({ dailyTokens: 1000, usedTokens: 1000 });
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, "budget/daily-tokens");
  });

  it("未到线放行", () => {
    assert.equal(checkTokenBudget({ dailyTokens: 1000, usedTokens: 999 }).ok, true);
  });
});

describe("周预算与步数预算（规格 §7.7.4）", () => {
  it("周起点是本地周一 00:00", () => {
    const wednesday = new Date(2026, 10, 18, 15, 30, 0).getTime(); // 2026-11-18 周三
    const start = startOfWeek(wednesday);
    const date = new Date(start);
    assert.equal(date.getDay(), 1, "应为周一");
    assert.equal(date.getHours(), 0);
    assert.equal(date.getMinutes(), 0);
    assert.ok(start <= wednesday && wednesday - start < 7 * 24 * 3600 * 1000);
  });

  it("周内任何一天算出的周起点相同，跨周则不同", () => {
    const mon = new Date(2026, 10, 16, 1, 0, 0).getTime();
    const sun = new Date(2026, 10, 22, 23, 0, 0).getTime();
    const nextMon = new Date(2026, 10, 23, 1, 0, 0).getTime();
    assert.equal(startOfWeek(mon), startOfWeek(sun));
    assert.notEqual(startOfWeek(mon), startOfWeek(nextMon));
  });

  it("周预算：未配置不限制；到线即拒", () => {
    assert.deepEqual(checkWeeklyTokenBudget({ weeklyTokens: null, usedTokens: 999 }), {
      ok: true,
      used: 999,
      limit: null,
      reason: "",
    });
    assert.equal(
      checkWeeklyTokenBudget({ weeklyTokens: 100, usedTokens: 100 }).reason,
      "budget/weekly-tokens",
    );
    assert.equal(checkWeeklyTokenBudget({ weeklyTokens: 100, usedTokens: 99 }).ok, true);
  });

  it("步数预算：等于上限仍放行，超过才拒", () => {
    assert.equal(checkStepBudget({ maxSteps: 3, steps: 3 }).ok, true);
    assert.equal(checkStepBudget({ maxSteps: 3, steps: 4 }).reason, "budget/steps-per-thread");
    assert.equal(checkStepBudget({ maxSteps: null, steps: 999 }).ok, true);
  });
});

describe("AUD-PROJ-04：周 token 预算字段（以前是死闸门）", () => {
  it("weeklyTokens 在预算字段表里，补丁可写、可清空、负数拒绝", async () => {
    const { BUDGET_FIELDS, DEFAULT_BUDGET, normalizeBudgetPatch } = await import(
      "../lib/budget.js"
    );
    assert.ok(BUDGET_FIELDS.includes("weeklyTokens"));
    assert.equal(DEFAULT_BUDGET.weeklyTokens, null);
    assert.deepEqual(normalizeBudgetPatch({ weeklyTokens: 12000 }), {
      ok: true,
      budget: { weeklyTokens: 12000 },
    });
    assert.deepEqual(normalizeBudgetPatch({ weeklyTokens: null }), {
      ok: true,
      budget: { weeklyTokens: null },
    });
    const bad = normalizeBudgetPatch({ weeklyTokens: -5 });
    assert.equal(bad.ok, false);
    assert.equal(/** @type {any} */ (bad).reason, "budget/invalid:weeklyTokens");
  });

  it("checkWeeklyTokenBudget：null 不限、到线拒建、未到线放行", () => {
    assert.equal(checkWeeklyTokenBudget({ weeklyTokens: null, usedTokens: 999999 }).ok, true);
    assert.equal(checkWeeklyTokenBudget({ weeklyTokens: 100, usedTokens: 99 }).ok, true);
    const hit = checkWeeklyTokenBudget({ weeklyTokens: 100, usedTokens: 100 });
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, "budget/weekly-tokens");
    assert.equal(hit.limit, 100);
  });

  it("周起点是本地周一 00:00（与日闸同口径），且 sum(周起之后) >= sum(今天)", async () => {
    const { startOfDay, startOfWeek } = await import("../lib/budget.js");
    const now = new Date();
    now.setHours(13, 0, 0, 0);
    const weekStart = startOfWeek(now.getTime());
    assert.ok(weekStart <= startOfDay(now.getTime()));
    const week = new Date(weekStart);
    assert.equal(week.getHours(), 0);
    assert.equal((week.getDay() + 6) % 7, 0, "必须是周一");
  });
});
