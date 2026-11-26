// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeRoutineEditInput,
  planRoutineHostAction,
  planRoutineUpdate,
} from "../lib/routines.js";

describe("Routine 编辑计划（纯函数）", () => {
  it("daily 改动 → 本地补丁带时间，宿主 patch 带 prompt + daily timing", () => {
    const planned = planRoutineUpdate({
      name: "日报",
      instructions: "写三条要点",
      frequency: "daily",
      time: "09:00",
      timeZone: "Asia/Shanghai",
    });
    assert.equal(planned.ok, true);
    const value = /** @type {any} */ (planned);
    assert.equal(value.local.frequency, "daily");
    assert.equal(value.local.time, "09:00:00");
    assert.equal(value.hostPatch.prompt, "写三条要点");
    assert.equal(value.hostPatch.timing.daily.time, "09:00:00");
  });

  it("编辑只传指令/频率时，weekday/dayOfMonth/time 从旧记录补上（不然频率漂移）", () => {
    const merged = mergeRoutineEditInput(
      { name: "周报", weekday: 5, dayOfMonth: undefined, time: "18:00:00" },
      { instructions: "写周报", frequency: "weekly" },
    );
    assert.equal(merged.weekday, 5);
    assert.equal(merged.time, "18:00:00");
    assert.equal(merged.name, "周报");
    // 显式传入的值优先
    assert.equal(mergeRoutineEditInput({ weekday: 5 }, { weekday: 1 }).weekday, 1);
  });

  it("宿主动作规划：定时↔手动必须真的建/删，否则漂移", () => {
    assert.equal(planRoutineHostAction({ scheduleId: "sch-1", wantsTiming: true }), "update");
    assert.equal(planRoutineHostAction({ scheduleId: "sch-1", wantsTiming: false }), "delete");
    assert.equal(planRoutineHostAction({ scheduleId: "", wantsTiming: true }), "create");
    assert.equal(planRoutineHostAction({ scheduleId: "", wantsTiming: false }), "none");
    // 与 planRoutineUpdate 串起来：manual 档没有 timing → 应该 delete
    const manual = /** @type {any} */ (
      planRoutineUpdate({ name: "x", instructions: "y", frequency: "manual" })
    );
    assert.equal("timing" in manual.hostPatch, false);
    assert.equal(planRoutineHostAction({ scheduleId: "sch-1", wantsTiming: false }), "delete");
  });

  it("manual → 不产生宿主 timing；空指令/坏频率拒绝", () => {
    const manual = /** @type {any} */ (
      planRoutineUpdate({ name: "手动", instructions: "随时", frequency: "manual" })
    );
    assert.equal(manual.ok, true);
    assert.equal("timing" in manual.hostPatch, false);
    assert.deepEqual(planRoutineUpdate({ name: "x", instructions: " ", frequency: "daily" }), {
      ok: false,
      reason: "routine/instructions-required",
    });
    assert.deepEqual(planRoutineUpdate({ name: "x", instructions: "y", frequency: "nope" }), {
      ok: false,
      reason: "routine/unknown-frequency",
    });
  });
});
