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

/**
 * 假宿主 schedule：**只认 shipped 契约**（`SchedulePatch.active?: boolean`）。
 *
 * 复审 F1：以前这个假件接受任意 patch，于是「插件发 `{status:"paused"}`」这种错误契约
 * 也能测绿。现在它复刻 `@deepseek-ai/dsh-schedule@0.2.2-rc.5` 的真实行为：
 *  - `update` 只在 `patch.active === false|true` 时改状态（`status` 之类未知键**静默忽略**）；
 *  - 未知 id 返回 `{id, code:'schedule_not_found'}`（不抛错）；
 *  - `delete` 返回 `{id, deleted:true}`，未知 id 返回 `{id, deleted:false, code:'schedule_not_found'}`；
 *  - 其它情况返回任务条目（含 `id` + `status`）。
 * 断言看 `status` 映射，而不是 patch 字面量——这样「改回错误契约」必然变红。
 */
function fakeSchedule(/** @type {{ failFor?: string[] }} */ options = {}) {
  /** @type {any[]} */
  const edits = [];
  const failing = new Set(Array.isArray(options.failFor) ? options.failFor : []);
  /** @type {Map<string, string>} scheduleId → "active" | "paused" */
  const status = new Map([
    ["sch_1", "active"],
    ["sch_2", "active"],
    ["sch_3", "active"],
  ]);
  return {
    edits,
    status,
    async edit(/** @type {any} */ request) {
      edits.push(request);
      const id = String(request?.id ?? "");
      if (failing.has(id)) throw new Error("host says no");
      if (!status.has(id)) {
        return request?.action === "delete"
          ? { id, deleted: false, code: "schedule_not_found" }
          : { id, code: "schedule_not_found" };
      }
      if (request?.action === "delete") {
        status.delete(id);
        return { id, deleted: true };
      }
      const patch = request?.patch ?? {};
      // 只认 active；status 等未知键被静默忽略（这正是宿主的行为）
      if (patch.active === false) status.set(id, "paused");
      else if (patch.active === true) status.set(id, "active");
      return { id, status: status.get(id), title: "", prompt: "" };
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
  it("pause → 宿主任务真的变成 paused（发对契约：patch.active=false）", async () => {
    const schedule = fakeSchedule();
    const result = await reconcileHostSchedules({ project: project(), action: "pause", schedule });
    assert.equal(result.ok, true);
    assert.equal(result.planned, "pause");
    assert.deepEqual(
      schedule.edits.map((edit) => [edit.id, edit.action]),
      [
        ["sch_1", "update"],
        ["sch_2", "update"],
      ],
      "enabled=false 的 routine 本来就是停的，不重复改",
    );
    // 关键断言在**宿主状态**上，不在 patch 字面量上（复审 F1：假绿来源）
    assert.equal(schedule.status.get("sch_1"), "paused", "routine 必须真被暂停");
    assert.equal(schedule.status.get("sch_2"), "paused", "schedule 提醒必须真被暂停");
    assert.equal(schedule.status.get("sch_3"), "active", "用户停用的条目不该被碰");
    for (const edit of schedule.edits) {
      assert.deepEqual(edit.patch, { active: false });
      assert.equal(Object.hasOwn(edit.patch, "status"), false, "宿主没有 patch.status 这个字段");
    }
    assert.deepEqual(
      result.handled.map((item) => item.scheduleId),
      ["sch_1", "sch_2"],
    );
    assert.deepEqual(result.skipped, ["sch_3"]);
  });

  it("resume → 只恢复 enabled!==false 的条目，且宿主状态真的回到 active", async () => {
    const schedule = fakeSchedule();
    // 先真的暂停一轮，再恢复：只改本地状态、宿主没动的实现会在这里露馅
    await reconcileHostSchedules({ project: project(), action: "pause", schedule });
    schedule.edits.length = 0;
    schedule.status.set("sch_3", "paused");
    const result = await reconcileHostSchedules({ project: project(), action: "resume", schedule });
    assert.equal(result.ok, true);
    assert.equal(schedule.status.get("sch_1"), "active");
    assert.equal(schedule.status.get("sch_2"), "active");
    for (const edit of schedule.edits) {
      assert.deepEqual(edit.patch, { active: true });
      assert.equal(Object.hasOwn(edit.patch, "status"), false);
    }
    assert.deepEqual(result.skipped, ["sch_3"]);
  });

  it("delete → 宿主条目全部真的消失（不是 pause）", async () => {
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
    assert.equal(schedule.status.size, 0, "删除后宿主里不该再有这些任务");
  });

  it("宿主服务不可用 → 不阻断（这台部署没有投递机制），但如实标 unavailable", async () => {
    // 复审 F6a/F7：`ctx.get("schedule")` 拿不到是部署级缺失，条目不可能被触发；
    // 不能因此把项目卡成不可删。调用方（deleteProject）会写一条审计说明。
    const result = await reconcileHostSchedules({
      project: project(),
      action: "delete",
      schedule: null,
    });
    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
    assert.equal(result.unavailable, 3);
    assert.deepEqual(result.skipped, ["schedule-unavailable"]);
  });

  it("宿主里已经没有这条任务（stale scheduleId）→ 目标状态已达成，不算失败", async () => {
    const schedule = fakeSchedule();
    const staleProject = {
      ...project(),
      reminders: [{ id: "rm_9", text: "旧提醒", scheduleId: "sch_gone", mode: "schedule" }],
    };
    const result = await reconcileHostSchedules({
      project: staleProject,
      action: "delete",
      schedule,
    });
    assert.equal(result.ok, true);
    assert.ok(
      result.handled.some((item) => item.scheduleId === "sch_gone" && item.missing === true),
      "not-found 记为 handled + missing（不能被当成删除失败阻塞项目删除）",
    );
  });

  it("宿主返回 conflict（条目被别处改过）→ 如实失败", async () => {
    const schedule = {
      edits: [],
      async edit(/** @type {any} */ request) {
        return { id: String(request?.id ?? ""), code: "schedule_conflict" };
      },
    };
    const result = await reconcileHostSchedules({
      project: project(),
      action: "pause",
      schedule,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures[0].reason, "schedule_conflict");
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

describe("宿主 SchedulePatch 契约（复审 F1）", () => {
  it("hostActivePatch 只产出 active 布尔（宿主没有 status 字段）", async () => {
    const { hostActivePatch } = await import("../lib/schedules.js");
    assert.deepEqual(hostActivePatch("pause"), { active: false });
    assert.deepEqual(hostActivePatch("resume"), { active: true });
    // 任何未知 op 都按「恢复」处理（宁可多开一次，也不要装作暂停了）
    assert.deepEqual(hostActivePatch("whatever"), { active: true });
  });

  it("classifyHostScheduleResult 认宿主的四种返回形状", async () => {
    const { classifyHostScheduleResult } = await import("../lib/schedules.js");
    assert.equal(
      classifyHostScheduleResult({ id: "s1", status: "paused", title: "t" }).kind,
      "task",
    );
    assert.equal(classifyHostScheduleResult({ id: "s1", status: "paused" }).status, "paused");
    assert.equal(classifyHostScheduleResult({ id: "s1", deleted: true }).kind, "deleted");
    assert.equal(
      classifyHostScheduleResult({ id: "s1", deleted: false, code: "schedule_not_found" }).kind,
      "not-found",
    );
    assert.equal(
      classifyHostScheduleResult({ id: "s1", code: "schedule_conflict" }).kind,
      "conflict",
    );
    // 宿主不用 {ok:false} 表达失败；不认识的形状不能当成功
    assert.equal(classifyHostScheduleResult({ ok: false }).kind, "unknown");
  });
});

describe("复审 N3：已耗尽的一次性任务不能被「恢复」当成失败", () => {
  it("isTerminalScheduleError 认宿主的 not_future（code / details.code / message 三种形态）", async () => {
    const { isTerminalScheduleError } = await import("../lib/schedules.js");
    const error = Object.assign(new Error("The scheduled time must be strictly in the future."), {
      code: "not_future",
    });
    assert.equal(isTerminalScheduleError(error), true);
    assert.equal(isTerminalScheduleError({ details: { code: "not_future" } }), true);
    assert.equal(isTerminalScheduleError(new Error("x: not_future")), true);
    assert.equal(isTerminalScheduleError(new Error("boom")), false);
    assert.equal(isTerminalScheduleError(null), false);
  });

  it("resume 时宿主报 not_future → 跳过且不写 failure（项目照常恢复）", async () => {
    /** @type {any[]} */
    const audits = [];
    /** @type {any[]} */
    const edits = [];
    const schedule = {
      edits,
      async edit(/** @type {any} */ request) {
        edits.push(request);
        throw Object.assign(new Error("The scheduled time must be strictly in the future."), {
          code: "not_future",
        });
      },
    };
    const result = await reconcileHostSchedules({
      project: project(),
      action: "resume",
      schedule,
      onAudit: (/** @type {any} */ entry) => audits.push(entry),
    });
    assert.equal(result.ok, true, "不能因为「恢复不了已结束的任务」让项目恢复失败");
    assert.equal(result.failures.length, 0);
    assert.equal(result.handled.length, 2);
    assert.ok(result.handled.every((item) => item.terminal === true));
    assert.deepEqual(
      audits.map((entry) => entry.action),
      ["routine/terminal", "reminder/terminal"],
      "审计写 terminal 而不是 reconcile-failed",
    );
  });

  it("pause 路径不套用终止态豁免（暂停失败必须如实报 failure）", async () => {
    const schedule = {
      async edit() {
        throw Object.assign(new Error("not_future"), { code: "not_future" });
      },
    };
    const result = await reconcileHostSchedules({
      project: project(),
      action: "pause",
      schedule,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 2);
  });
});
