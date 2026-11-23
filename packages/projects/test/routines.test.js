// @ts-check
// F36 Routines 单测：六档频率 → 宿主 timing 的映射是这功能唯一容易写错的地方。
// 宿主要 `HH:mm:ss`（docs/runtime/0.2.2-rc.5.md §14 实测：`09:30` 会被 ScheduleInputError 拒）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendRoutineHistory,
  buildRoutineTiming,
  describeRoutineFrequency,
  describeScheduleStatus,
  frequencyRunsAutomatically,
  historyFromDelivery,
  normalizeFrequency,
  normalizeRoutine,
  normalizeTime,
  ROUTINE_COST_HINT,
  ROUTINE_HISTORY_CAP,
  validateRoutineInput,
} from "../lib/routines.js";

describe("normalizeTime", () => {
  it("补成 HH:mm:ss（宿主的硬格式）", () => {
    assert.equal(normalizeTime("9:5"), "09:05:00");
    assert.equal(normalizeTime("09:30"), "09:30:00");
    assert.equal(normalizeTime("09:30:07"), "09:30:07");
    assert.equal(normalizeTime("09:30:07.123"), "09:30:07");
  });

  it("非法时间返回空串（不猜一个默认值）", () => {
    assert.equal(normalizeTime(""), "");
    assert.equal(normalizeTime("25:00"), "");
    assert.equal(normalizeTime("09:60"), "");
    assert.equal(normalizeTime("9点半"), "");
  });
});

describe("buildRoutineTiming", () => {
  it("六档都收敛成宿主认得的 timing 形状", () => {
    const cases = [
      { frequency: "manual", expect: null },
      { frequency: "hourly" },
      { frequency: "daily" },
      { frequency: "weekdays" },
      { frequency: "weekly", weekday: 3 },
      { frequency: "monthly", dayOfMonth: 15 },
    ];
    for (const item of cases) {
      const result = buildRoutineTiming(item.frequency, { time: "09:30", ...item });
      assert.equal(result.ok, true, item.frequency);
      if (!result.ok) continue;
      if (item.expect === null) assert.equal(result.timing, null);
      else assert.equal(typeof result.timing, "object");
    }
  });

  it("daily 用宿主 daily timing（time 已是 HH:mm:ss），cron 档用 expression + 时区", () => {
    const daily = buildRoutineTiming("daily", { time: "9:5", timeZone: "Asia/Shanghai" });
    assert.deepEqual(/** @type {any} */ (daily).timing, {
      kind: "daily",
      daily: { time: "09:05:00", time_zone: "Asia/Shanghai" },
    });
    const weekly = buildRoutineTiming("weekly", { time: "09:30", weekday: 3, timeZone: "UTC" });
    assert.deepEqual(/** @type {any} */ (weekly).timing, {
      kind: "cron",
      cron: { expression: "30 9 * * 3", time_zone: "UTC" },
    });
    // 周日写 7 也收敛成 0（宿主的 cron 周日是 0 或 7，这里统一成 0）
    const sunday = buildRoutineTiming("weekly", { time: "08:00", weekday: 7 });
    assert.equal(/** @type {any} */ (sunday).timing.cron.expression, "0 8 * * 0");
  });

  it("monthly 只接受 1–28（29–31 会在部分月份静默跳过一整月）", () => {
    const fifteenth = buildRoutineTiming("monthly", { time: "09:00", dayOfMonth: 15 });
    assert.equal(fifteenth.ok, true);
    assert.equal(/** @type {any} */ (fifteenth).timing.cron.expression, "0 9 15 * *");
    const thirtyFirst = buildRoutineTiming("monthly", { time: "09:00", dayOfMonth: 31 });
    assert.equal(thirtyFirst.ok, true);
    assert.equal(/** @type {any} */ (thirtyFirst).timing.cron.expression, "0 9 1 * *");
  });

  it("未知频率是错误，不是 manual", () => {
    const result = buildRoutineTiming("every-minute", {});
    assert.equal(result.ok, false);
    assert.equal(normalizeFrequency("every-minute"), "");
  });

  it("manual 不自动跑（也就不建 schedule）", () => {
    assert.equal(frequencyRunsAutomatically("manual"), false);
    assert.equal(frequencyRunsAutomatically("daily"), true);
  });
});

describe("describeRoutineFrequency / describeScheduleStatus", () => {
  const base = { time: "09:30:00", weekday: 3, dayOfMonth: 15 };
  it("六档都有可读描述", () => {
    assert.match(describeRoutineFrequency({ ...base, frequency: "manual" }), /手动/u);
    assert.equal(describeRoutineFrequency({ ...base, frequency: "hourly" }), "每小时的第 30 分");
    assert.equal(describeRoutineFrequency({ ...base, frequency: "daily" }), "每天 09:30");
    assert.equal(describeRoutineFrequency({ ...base, frequency: "weekdays" }), "工作日 09:30");
    assert.equal(describeRoutineFrequency({ ...base, frequency: "weekly" }), "每周三 09:30");
    assert.equal(describeRoutineFrequency({ ...base, frequency: "monthly" }), "每月 15 号 09:30");
  });

  it("宿主 status 原样反映（active/paused/ended/缺失各有说法）", () => {
    assert.equal(
      describeScheduleStatus({ status: "active", scheduledAt: "2026-12-01T00:00:00Z" }, true)
        .status,
      "active",
    );
    assert.equal(describeScheduleStatus({ status: "paused" }, true).status, "paused");
    assert.equal(describeScheduleStatus({ status: "ended" }, true).status, "ended");
    assert.equal(describeScheduleStatus(undefined, true).status, "missing");
    assert.equal(describeScheduleStatus(undefined, false).status, "off");
  });
});

describe("normalizeRoutine / history", () => {
  it("历史有上限，保留最近的", () => {
    let routine = normalizeRoutine({ id: "rt_1", frequency: "daily", name: "日报" });
    assert.ok(routine);
    for (let index = 0; index < ROUTINE_HISTORY_CAP + 5; index += 1) {
      routine = {
        ...routine,
        history: appendRoutineHistory(routine, { at: `t${index}`, status: "run" }),
      };
    }
    assert.equal(routine.history.length, ROUTINE_HISTORY_CAP);
    assert.equal(routine.history.at(-1).at, `t${ROUTINE_HISTORY_CAP + 4}`);
  });

  it("缺失 id/频率的记录读不进来（不伪造默认 routine）", () => {
    assert.equal(normalizeRoutine({ frequency: "daily" }), null);
    assert.equal(normalizeRoutine({ id: "rt_1" }), null);
    assert.equal(normalizeRoutine(null), null);
  });

  it("宿主投递记录映射成我们的历史条目", () => {
    const row = historyFromDelivery({
      scheduledAt: "2026-12-01T01:00:00.000Z",
      deliveredAt: "2026-12-01T01:00:01.000Z",
      messageId: "msg-1234567890",
      targetSessionId: "s1",
    });
    assert.equal(row.at, "2026-12-01T01:00:01.000Z");
    assert.equal(row.status, "delivered");
    assert.match(row.message, /message=/u);
  });

  it("创建入参校验：名字/指令必填，manual 不需要时间", () => {
    assert.equal(
      validateRoutineInput({ name: "", instructions: "x", frequency: "daily" }).ok,
      false,
    );
    assert.equal(
      validateRoutineInput({ name: "n", instructions: "", frequency: "daily" }).ok,
      false,
    );
    const manual = validateRoutineInput({ name: "n", instructions: "i", frequency: "manual" });
    assert.equal(manual.ok, true);
    assert.equal(manual.value.time, undefined);
    const daily = validateRoutineInput({
      name: "n",
      instructions: "i",
      frequency: "daily",
      time: "9:5",
    });
    assert.equal(/** @type {any} */ (daily).value.time, "09:05:00");
  });

  it("成本提示必须写明「一次模型调用」", () => {
    assert.match(ROUTINE_COST_HINT, /一次模型调用/u);
    assert.match(ROUTINE_COST_HINT, /60 秒/u);
  });
});
