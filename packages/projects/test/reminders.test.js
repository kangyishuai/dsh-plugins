// @ts-check
// F30 提醒单测：到期判断、重启恢复计划、状态迁移、过期清理。
// 重点覆盖「关机期间到点」——这是 timer 模式唯一的技术难点，必须由纯函数兜住。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_REMINDER_MODE,
  markCancelled,
  markDone,
  markFired,
  normalizeReminder,
  normalizeReminderAt,
  normalizeReminderMode,
  planReminderRecovery,
  purgeExpiredReminders,
  remainingTime,
  resolveReminderMode,
  SCHEDULE_MODE_NOTE,
  scheduleTimingFor,
  splitByDue,
  TIMER_MODE_NOTE,
  validateReminderInput,
} from "../lib/reminders.js";

const now = Date.parse("2026-12-01T00:00:00.000Z");

describe("模式选择", () => {
  it("默认 timer（免费）；本条选择优先于项目默认", () => {
    assert.equal(DEFAULT_REMINDER_MODE, "timer");
    assert.equal(resolveReminderMode(undefined, undefined), "timer");
    assert.equal(resolveReminderMode("timer", "schedule"), "schedule");
    assert.equal(resolveReminderMode("schedule", ""), "schedule");
    assert.equal(resolveReminderMode("timer", "nonsense"), "timer");
    assert.equal(normalizeReminderMode("auto"), "");
  });

  it("两种模式的成本差异写在文案里（UI 直接引用）", () => {
    assert.match(TIMER_MODE_NOTE, /不花模型调用/u);
    assert.match(TIMER_MODE_NOTE, /关着/u);
    assert.match(SCHEDULE_MODE_NOTE, /一次模型调用/u);
    assert.match(SCHEDULE_MODE_NOTE, /关着也会跑/u);
  });
});

describe("normalizeReminderAt / normalizeReminder", () => {
  it("接受 ISO / Date / 毫秒，非法返回空串", () => {
    assert.equal(normalizeReminderAt("2026-12-01T09:00:00.000Z"), "2026-12-01T09:00:00.000Z");
    assert.equal(normalizeReminderAt(new Date(now)), "2026-12-01T00:00:00.000Z");
    assert.equal(normalizeReminderAt(now), "2026-12-01T00:00:00.000Z");
    assert.equal(normalizeReminderAt("not-a-date"), "");
    assert.equal(normalizeReminderAt(undefined), "");
  });

  it("过去的时间照样收（重启恢复要的就是「已经到期」）", () => {
    assert.equal(normalizeReminderAt("2020-01-01T00:00:00.000Z"), "2020-01-01T00:00:00.000Z");
  });

  it("记录收敛：缺 id/到期时间读不进来，状态非法回落 pending", () => {
    assert.equal(normalizeReminder({ at: "2026-12-01T09:00:00.000Z" }), null);
    assert.equal(normalizeReminder({ id: "rm_1" }), null);
    const record = normalizeReminder({
      id: "rm_1",
      at: "2026-12-01T09:00:00.000Z",
      state: "weird",
    });
    assert.equal(record.state, "pending");
    assert.equal(record.mode, "timer");
  });
});

describe("splitByDue / planReminderRecovery（重启恢复）", () => {
  const list = [
    { id: "a", at: "2026-11-30T23:00:00.000Z", state: "pending", mode: "timer" }, // 关机期间过期
    { id: "b", at: "2026-12-01T01:00:00.000Z", state: "pending", mode: "timer" }, // 还没到
    { id: "c", at: "2026-12-01T01:00:00.000Z", state: "fired", mode: "timer" }, // 已触发
  ];

  it("分出来 due / pending，且不把已触发的再算一遍", () => {
    const result = splitByDue(list, now);
    assert.deepEqual(
      result.due.map((item) => item.id),
      ["a"],
    );
    assert.deepEqual(
      result.pending.map((item) => item.id),
      ["b"],
    );
  });

  it("恢复计划：过期的 delayMs=0（启动立刻补），未到期的按剩余毫秒", () => {
    const plan = planReminderRecovery(list, now);
    assert.deepEqual(plan.overdue, ["a"]);
    assert.deepEqual(plan.pending, ["b"]);
    assert.deepEqual(plan.arm, [
      { id: "a", delayMs: 0 },
      { id: "b", delayMs: 60 * 60 * 1000 },
    ]);
  });

  it("空/非法输入不会炸，也不会凭空造提醒", () => {
    assert.deepEqual(planReminderRecovery([], now), { arm: [], overdue: [], pending: [] });
    assert.deepEqual(planReminderRecovery(/** @type {any} */ (null), now), {
      arm: [],
      overdue: [],
      pending: [],
    });
  });
});

describe("状态迁移", () => {
  const base = {
    id: "rm_1",
    at: "2026-12-01T01:00:00.000Z",
    state: "pending",
    mode: "timer",
    text: "x",
  };

  it("fired 会带 firedAt + unread（未读标记靠本机持久化，宿主没有）", () => {
    const fired = markFired(base, now);
    assert.equal(fired.state, "fired");
    assert.equal(fired.firedAt, "2026-12-01T00:00:00.000Z");
    assert.equal(fired.unread, true);
    assert.equal(fired.notified, false);
  });

  it("取消 / 提前完成都会清 unread", () => {
    assert.equal(markCancelled(base, now).state, "cancelled");
    assert.equal(markCancelled(base, now).unread, false);
    assert.equal(markDone(base, now).state, "done");
    assert.equal(markDone(base, now).doneAt, "2026-12-01T00:00:00.000Z");
  });
});

describe("purgeExpiredReminders", () => {
  it("只清超期的终态记录，pending 永不动", () => {
    const old = "2026-11-01T00:00:00.000Z";
    const list = [
      { id: "pending-old", at: old, state: "pending" },
      { id: "fired-old", at: old, state: "fired", firedAt: old },
      {
        id: "fired-new",
        at: "2026-11-30T00:00:00.000Z",
        state: "fired",
        firedAt: "2026-11-30T00:00:00.000Z",
      },
    ];
    const result = purgeExpiredReminders(list, now);
    assert.deepEqual(result.dropped, ["fired-old"]);
    assert.deepEqual(
      result.kept.map((item) => item.id).sort(),
      ["fired-new", "pending-old"].sort(),
    );
  });
});

describe("scheduleTimingFor（schedule 模式的宿主 timing）", () => {
  it("60 秒内用 after_seconds（实测能真投递），远的用 at + IANA 时区", () => {
    const near = scheduleTimingFor("2026-12-01T00:00:30.000Z", now, "Asia/Shanghai");
    assert.deepEqual(near, { kind: "after", after_seconds: 30 });
    // 已经过期 → 至少 1 秒（宿主的 after_seconds 不接受 0）
    assert.deepEqual(scheduleTimingFor("2026-11-30T00:00:00.000Z", now, "UTC"), {
      kind: "after",
      after_seconds: 1,
    });
    const far = scheduleTimingFor("2026-12-01T09:30:00.000Z", now, "Asia/Shanghai");
    assert.equal(far.kind, "at");
    assert.equal(far.at.time_zone, "Asia/Shanghai");
    // 09:30Z = 上海 17:30（时区换算交给 Intl，不自己算偏移）
    assert.equal(far.at.date, "2026-12-01");
    assert.equal(far.at.time, "17:30:00");
  });
});

describe("validateReminderInput / remainingTime", () => {
  it("文本必填、模式必须是两种之一", () => {
    assert.equal(
      validateReminderInput({ at: "2026-12-01T01:00:00.000Z", text: "", mode: "timer" }).ok,
      false,
    );
    assert.equal(
      validateReminderInput({ at: "2026-12-01T01:00:00.000Z", text: "喝水", mode: "nope" }).ok,
      false,
    );
    const ok = validateReminderInput({
      at: "2026-12-01T01:00:00.000Z",
      text: "喝水",
      mode: "schedule",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.mode, "schedule");
  });

  it("剩余时间文案：已到期 / 分钟 / 小时 / 天", () => {
    assert.equal(remainingTime("2026-11-30T23:00:00.000Z", now).text, "已到期");
    assert.equal(remainingTime("2026-12-01T00:05:00.000Z", now).text, "5 分钟后");
    assert.equal(remainingTime("2026-12-01T03:00:00.000Z", now).text, "3 小时后");
    assert.equal(remainingTime("2026-12-03T00:00:00.000Z", now).text, "2 天后");
  });
});
