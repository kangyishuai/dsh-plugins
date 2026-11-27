// @ts-check
// inflight 登记簿单测：钉住 AUD-NS-01 的三个不变量。
//
// 背景：`turn/start` 原来立刻 abort 在途生成，14 天 322 次「被下一轮取消」（占生成尝试 29.6%），
// 已花的 token 全丢、诊断里还看不到。现在改用「标记 superseded、不 abort」——
// 生成跑完写成 `shown:false` 候选。下面每条断言对应一个曾经出错的语义。
import assert from "node:assert/strict";
import test from "node:test";

import { createInflightRegistry, inflightBlocksGenerateNow } from "../lib/inflight.js";

/**
 * 假的 AbortController：记录 abort 有没有被调用、原因是什么。
 * @returns {{ controller: AbortController, state: { aborted: boolean, reason: unknown } }}
 */
function fakeController() {
  /** @type {{ aborted: boolean, reason: unknown }} */
  const state = { aborted: false, reason: undefined };
  /** @type {any} */
  const controller = {
    signal: { aborted: false },
    /** @param {unknown} [reason] */
    abort(reason) {
      state.aborted = true;
      state.reason = reason;
      controller.signal.aborted = true;
    },
  };
  return { controller, state };
}

test("supersede 只打标记、绝不 abort（322 次取消不再丢 token）", () => {
  const registry = createInflightRegistry();
  const { controller, state } = fakeController();
  registry.begin("s1", 3, controller);

  const entry = registry.supersede("s1");
  assert.equal(entry?.turn, 3);
  assert.equal(state.aborted, false, "supersede 不取消在途生成");
  assert.equal(registry.isSuperseded("s1", controller), true);
  assert.equal(registry.isCurrent("s1", controller), true, "仍然是当前生成（只是已被取代）");
  // 没有在途生成时 supersede 是无害的 no-op
  assert.equal(registry.supersede("nope"), undefined);
});

test("begin 顶掉上一笔时把上一笔返回给调用方（由调用方决定 abort）", () => {
  const registry = createInflightRegistry();
  const first = fakeController();
  const second = fakeController();
  assert.equal(registry.begin("s1", 1, first.controller), undefined);
  const previous = registry.begin("s1", 2, second.controller);
  assert.equal(previous?.controller, first.controller);
  assert.equal(registry.get("s1")?.controller, second.controller);
  assert.equal(registry.size, 1);
});

test("finish 只注销自己那一笔（晚到的旧生成不能删掉新生成）", () => {
  const registry = createInflightRegistry();
  const oldController = fakeController();
  const newController = fakeController();
  registry.begin("s1", 1, oldController.controller);
  registry.begin("s1", 2, newController.controller);

  assert.equal(
    registry.finish("s1", oldController.controller),
    false,
    "旧 controller 不该注销别人的登记",
  );
  assert.equal(registry.get("s1")?.controller, newController.controller);
  assert.equal(registry.finish("s1", newController.controller), true);
  assert.equal(registry.has("s1"), false);
});

test("cancel 会 abort 并注销（用户点了胶囊 / 同一会话要起新生成）", () => {
  const registry = createInflightRegistry();
  const { controller, state } = fakeController();
  registry.begin("s1", 1, controller);

  const reason = new Error("superseded");
  const entry = registry.cancel("s1", reason);
  assert.equal(entry?.turn, 1);
  assert.equal(state.aborted, true);
  assert.equal(state.reason, reason);
  assert.equal(registry.has("s1"), false, "cancel 之后必须注销");
  // 已经注销后再 cancel 是 no-op（不重复 abort）
  assert.equal(registry.cancel("s1"), undefined);
});

test("按会话隔离：一个会话的在途生成不会影响另一个会话", () => {
  const registry = createInflightRegistry();
  const a = fakeController();
  const b = fakeController();
  registry.begin("s1", 1, a.controller);
  registry.begin("s2", 5, b.controller);

  registry.supersede("s1");
  assert.equal(registry.isSuperseded("s1", a.controller), true);
  assert.equal(registry.isSuperseded("s2", b.controller), false);
  assert.equal(b.state.aborted, false);
  assert.equal(registry.size, 2);
});

test("手动补生成（generateNow）：同一回合且未取代才等；异回合 / 已被取代 → 取消后继续", () => {
  // 背景（F-2）：0.4.4 之前 turn/start 会 abort 在途生成，补生成按钮那时候 `inflight` 必为空；
  // 现在 superseded 的旧回合会跑到 20s，用户点「补生成」会撞上 `{ok:false, reason:"inflight"}`，
  // 按钮显示「正在生成，请稍候」而什么都不发生。旧的那笔既然注定 shown:false（或根本不是本回合），
  // 就该取消掉、让补生成真的发出去。
  assert.equal(inflightBlocksGenerateNow(undefined, 5), false, "没有在途生成：不挡");
  assert.equal(
    inflightBlocksGenerateNow({ turn: 5, superseded: false }, 5),
    true,
    "同一回合、正常在途：等它跑完（补生成会重复调用模型）",
  );
  assert.equal(
    inflightBlocksGenerateNow({ turn: 5, superseded: true }, 5),
    false,
    "同一回合但已被取代：结果注定 shown:false，取消后重新生成",
  );
  assert.equal(
    inflightBlocksGenerateNow({ turn: 4, superseded: false }, 5),
    false,
    "在途的是别的回合：不是用户要的那张卡，取消",
  );
  assert.equal(inflightBlocksGenerateNow({ turn: 4, superseded: true }, 5), false);
});
