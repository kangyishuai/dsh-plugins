// @ts-check
// AUD-PROJ-02：暂停/归档/删除必须停掉宿主定时任务（routines / schedule 档提醒）。
//
// 为什么在这一层测：`lib/service.js` 顶层 import 了宿主包（运行时注入，仓库里没有），
// node --test 里 import 不了。所以对账逻辑抽到 `lib/schedules.js`，用**假 schedule 记录调用**
// 直接驱动；service 的接线用 service-wiring-guards 的源码守卫钉住。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkProjectAcceptsAutomation,
  collectHostSchedules,
  plannedScheduleAction,
  reconcileHostSchedules,
} from "../lib/schedules.js";

/** 假宿主 schedule：记录每次 edit 调用，可按 id 注入失败。 */
function fakeSchedule(/** @type {{ failFor?: string[] }} */ options = {}) {
  /** @type {any[]} */
  const edits = [];
  const failing = new Set(Array.isArray(options.failFor) ? options.failFor : []);
  return {
    edits,
    async edit(/** @type {any} */ request) {
      edits.push(request);
      if (failing.has(String(request?.id ?? ""))) throw new Error("host says no");
      return { ok: true };
    },
    async create() {
      throw new Error("not used");
    },
  };
}

const project = (patch = {}) => ({
  id: "prj_1",
  name: "alpha",
  state: "active",
  routines: [
    { id: "rt_1", name: "每日巡检", scheduleId: "sch_1", enabled: true },
    { id: "rt_2", name: "手动档", scheduleId: "", enabled: true },
    { id: "rt_3", name: "用户停用", scheduleId: "sch_3", enabled: false },
  ],
  reminders: [
    { id: "rm_1", text: "喝水", scheduleId: "sch_2", mode: "schedule" },
    { id: "rm_2", text: "计时器", scheduleId: "", mode: "timer" },
  ],
  ...patch,
});

describe("宿主定时的收集与计划", () => {
  it("只收有 scheduleId 的条目（manual routine / timer 提醒没有宿主条目）", () => {
    const entries = collectHostSchedules(project());
    assert.deepEqual(
      entries.map((entry) => entry.scheduleId),
      ["sch_1", "sch_3", "sch_2"],
    );
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["routine", "routine", "reminder"],
    );
  });

  it("项目状态 → 对账动作", () => {
    assert.equal(plannedScheduleAction("pause"), "pause");
    assert.equal(plannedScheduleAction("archive"), "pause");
    assert.equal(plannedScheduleAction("resume"), "resume");
    assert.equal(plannedScheduleAction("delete"), "delete");
    assert.equal(plannedScheduleAction("nonsense"), "none");
  });
});

describe("reconcileHostSchedules：假 schedule 记录调用（先红后绿的核心断言）", () => {
  it("pause → 所有宿主条目都 update 成 paused（用户停用的那条保持不动）", async () => {
    const schedule = fakeSchedule();
    const result = await reconcileHostSchedules({ project: project(), action: "pause", schedule });
    assert.equal(result.ok, true);
    assert.equal(result.planned, "pause");
    assert.deepEqual(
      schedule.edits.map((edit) => [edit.id, edit.action, edit.patch?.status]),
      [
        ["sch_1", "update", "paused"],
        ["sch_2", "update", "paused"],
      ],
      "enabled=false 的 routine 本来就是停的，不重复改",
    );
    assert.deepEqual(
      result.handled.map((item) => item.scheduleId),
      ["sch_1", "sch_2"],
    );
    assert.deepEqual(result.skipped, ["sch_3"]);
  });

  it("resume → 只恢复 enabled!==false 的条目", async () => {
    const schedule = fakeSchedule();
    const result = await reconcileHostSchedules({ project: project(), action: "resume", schedule });
    assert.equal(result.ok, true);
    assert.deepEqual(
      schedule.edits.map((edit) => [edit.id, edit.patch?.status]),
      [
        ["sch_1", "active"],
        ["sch_2", "active"],
      ],
    );
    assert.deepEqual(result.skipped, ["sch_3"]);
  });

  it("delete → 宿主条目全部 delete（不是 pause）", async () => {
    const schedule = fakeSchedule();
    const result = await reconcileHostSchedules({ project: project(), action: "delete", schedule });
    assert.equal(result.ok, true);
    assert.deepEqual(
      schedule.edits.map((edit) => [edit.id, edit.action]),
      [
        ["sch_1", "delete"],
        ["sch_3", "delete"],
        ["sch_2", "delete"],
      ],
    );
  });

  it("宿主服务不可用：如实失败，不假装成功", async () => {
    const result = await reconcileHostSchedules({
      project: project(),
      action: "delete",
      schedule: null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 3);
    assert.equal(result.failures[0].reason, "schedule-unavailable");
  });

  it("单个条目失败：其余继续，失败项带原因返回（删除项目要靠它决定是否阻断）", async () => {
    const schedule = fakeSchedule({ failFor: ["sch_1"] });
    const result = await reconcileHostSchedules({ project: project(), action: "delete", schedule });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scheduleId, "sch_1");
    assert.equal(result.failures[0].reason, "host says no");
    assert.equal(result.handled.length, 2);
  });

  it("没有宿主条目 / 未知动作：no-op", async () => {
    const schedule = fakeSchedule();
    const empty = await reconcileHostSchedules({
      project: { id: "p", routines: [], reminders: [] },
      action: "delete",
      schedule,
    });
    assert.deepEqual(empty.skipped, ["no-host-schedules"]);
    const unknown = await reconcileHostSchedules({ project: project(), action: "x", schedule });
    assert.deepEqual(unknown.skipped, ["no-action"]);
    assert.equal(schedule.edits.length, 0);
  });

  it("审计回调按每条处置触发（pause/失败各一条）", async () => {
    /** @type {any[]} */
    const audits = [];
    const schedule = fakeSchedule({ failFor: ["sch_2"] });
    await reconcileHostSchedules({
      project: project(),
      action: "pause",
      schedule,
      onAudit: (entry) => audits.push(entry),
    });
    assert.deepEqual(
      audits.map((entry) => entry.action),
      ["routine/reconciled", "reminder/reconcile-failed"],
    );
  });
});

describe("checkProjectAcceptsAutomation：暂停/归档下不新建花钱的定时", () => {
  it("active 放行，paused/archived 拒绝并给可读原因", () => {
    assert.deepEqual(checkProjectAcceptsAutomation({ state: "active" }), { ok: true, reason: "" });
    assert.deepEqual(checkProjectAcceptsAutomation({ state: "paused" }), {
      ok: false,
      reason: "project-paused",
    });
    assert.deepEqual(checkProjectAcceptsAutomation({ state: "archived" }), {
      ok: false,
      reason: "project-archived",
    });
    assert.equal(checkProjectAcceptsAutomation(null).ok, true);
  });
});
