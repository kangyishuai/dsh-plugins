// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planRoutineUpdate } from "../lib/routines.js";

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
