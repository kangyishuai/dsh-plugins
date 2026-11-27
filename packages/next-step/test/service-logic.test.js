// @ts-check
// write-plan / turn-dispatch / session-records 三个纯模块的单测。
//
// 这一批是 AUD-NS-01 / NS-05 / NS-06 的「可测化」落点：原来写在 service.js 里
// （import @deepseek-ai/* → node --test 加载不了）的分支，抽成纯函数后逐个钉住。
import assert from "node:assert/strict";
import test from "node:test";

import { CARD_RECORD, DECISION_RECORD, REVEAL_RECORD } from "../lib/card-data.js";
import { cheapSkipReason } from "../lib/gates.js";
import { foldSessionRecords } from "../lib/session-records.js";
import { endKindOf, turnEndDisposition } from "../lib/turn-dispatch.js";
import { planCardWrite } from "../lib/write-plan.js";

test("planCardWrite：正常路径按档位决定显示", () => {
  assert.deepEqual(planCardWrite({ value: "must", tier: "could" }), {
    shown: true,
    gate: "ok",
  });
  assert.deepEqual(planCardWrite({ value: "could", tier: "must" }), {
    shown: false,
    gate: "ok",
  });
  assert.deepEqual(planCardWrite({ value: "no", tier: "any" }), { shown: true, gate: "ok" });
});

test("planCardWrite：superseded 一律写 shown:false（不丢 token、也不塞回过期卡）", () => {
  // 用户档位再宽也不显示；手动补生成（force）也不能覆盖「这一轮已经翻过去了」。
  assert.deepEqual(planCardWrite({ value: "must", tier: "any", superseded: true }), {
    shown: false,
    gate: "superseded",
  });
  assert.deepEqual(
    planCardWrite({ value: "could", tier: "could", force: true, superseded: true }),
    {
      shown: false,
      gate: "superseded",
    },
  );
  // 非 superseded 时 force 仍然优先（补生成要真的出卡）
  assert.deepEqual(planCardWrite({ value: "no", tier: "must", force: true }), {
    shown: true,
    gate: "ok",
  });
});

test("turnEndDisposition：非 completed 的回合也要进流程（AUD-NS-05：turn-error 闸可达）", () => {
  // 关键回归：原来 service 在进入闸之前就把非 completed 的 turn/end 丢掉了，
  // 于是 cheapSkipReason 的 turn-error 分支永远为假。现在任何 reason.kind 都要被考虑。
  for (const turn of [1, 7, 42]) {
    assert.equal(turnEndDisposition({ turn }).consider, true);
    assert.equal(turnEndDisposition({ turn }).endKind, "unknown", "缺 reason 归一化成 unknown");
  }
  assert.equal(turnEndDisposition({ turn: 3, subagent: true }).consider, false);
  assert.equal(turnEndDisposition({ turn: "3" }).consider, false);
  assert.equal(turnEndDisposition({ turn: 3.5 }).consider, false);
  assert.equal(turnEndDisposition({}).consider, false);
});

test("endKindOf：reason 缺失 / 非字符串 / 空串一律归一化成 unknown", () => {
  // 这条是 AUD-NS-05 的护栏：completed 过滤下移之后，缺 reason 的 turn/end 也会进流程；
  // 若不归一化，`cheapSkipReason` 的 turn-error 分支不成立，可能给「原因未知」的回合出卡。
  for (const raw of [undefined, null, "", 42, {}, [], "   "]) {
    assert.equal(endKindOf(raw), "unknown", `raw=${JSON.stringify(raw)}`);
  }
  for (const kind of ["completed", "aborted", "error", "max-tokens", "paused"]) {
    assert.equal(endKindOf(kind), kind);
  }
});

test("接线组合：只有 completed 会放行生成，其余（含缺 reason）一律命中 turn-error", () => {
  /** @type {any} 其它闸全部放行的基线（该出卡的回合）。 */
  const pass = {
    enabled: true,
    cardEnabled: true,
    pauseUntil: 0,
    now: 1_000,
    queued: 0,
    cardsForTurn: false,
    shownCardsInSession: 0,
    maxCards: 60,
    answerChars: 500,
    toolCalls: 2,
    contextChars: 900,
  };
  // 缺 reason / null / 非法值：都必须命中 turn-error，绝不能落到 null（= 调模型）
  for (const reasonKind of [undefined, null, "", 42, {}]) {
    const disposition = turnEndDisposition({ turn: 3, reasonKind });
    assert.equal(disposition.consider, true, "缺 reason 也要进流程以便留痕");
    const skip = cheapSkipReason({ ...pass, endKind: disposition.endKind });
    assert.equal(skip?.reason, "turn-error", `reasonKind=${JSON.stringify(reasonKind)}`);
  }
  // 非 completed：只留遥测，不生成
  for (const reasonKind of ["aborted", "error", "max-tokens"]) {
    const disposition = turnEndDisposition({ turn: 3, reasonKind });
    assert.equal(cheapSkipReason({ ...pass, endKind: disposition.endKind })?.reason, "turn-error");
  }
  // completed：现有生成路径不变（闸全部放行）
  const completed = turnEndDisposition({ turn: 3, reasonKind: "completed" });
  assert.equal(completed.endKind, "completed");
  assert.equal(cheapSkipReason({ ...pass, endKind: completed.endKind }), null);
});

test("foldSessionRecords：三张表都按「每回合第一条赢」，非法记录被忽略", () => {
  /** @type {any} */
  const card = (/** @type {number} */ turn) => ({
    turn,
    summary: `摘要 ${turn}`,
    question: `问题 ${turn}`,
    options: [{ stance: "a", label: "改成 %5" }],
    value: "could",
    shown: true,
    tier: "could",
    promptVersion: 4,
  });
  const events = [
    { plugin: { type: CARD_RECORD, data: card(1) } },
    { plugin: { type: CARD_RECORD, data: card(1) } }, // 同回合第二条：丢
    { plugin: { type: CARD_RECORD, data: { turn: 2, summary: "" } } }, // 结构不合法：丢
    { plugin: { type: DECISION_RECORD, data: { turn: 1, phase: "sent", index: 0 } } },
    { plugin: { type: DECISION_RECORD, data: { turn: 1, phase: "dismissed" } } }, // 同回合第二条：丢
    { plugin: { type: REVEAL_RECORD, data: { turn: 3 } } },
    { plugin: undefined }, // 不是插件记录：丢
    { plugin: { type: "plugin:other/thing", data: { turn: 1 } } }, // 别人的记录：丢
    {
      plugin: {
        type: CARD_RECORD,
        get data() {
          throw new Error("boom");
        },
      },
    }, // 坏记录：不能炸
  ];
  const records = foldSessionRecords(events, (/** @type {any} */ event) => event.plugin);
  assert.deepEqual([...records.cards.keys()], [1]);
  assert.equal(records.cards.get(1)?.summary, "摘要 1");
  assert.equal(records.decisions.get(1)?.phase, "sent");
  assert.equal(records.reveals.get(3), true);
});

test("foldSessionRecords：recordOf 抛错/事件数组异常时不炸（宿主形状变化要降级）", () => {
  const records = foldSessionRecords([{ bad: true }], () => {
    throw new Error("host changed");
  });
  assert.equal(records.cards.size, 0);
  assert.equal(records.decisions.size, 0);
  assert.equal(records.reveals.size, 0);
  // 非数组输入按空处理（service 里 session.snapshotEvents() 可能返回 undefined）
  assert.equal(foldSessionRecords(/** @type {any} */ (undefined), () => undefined).cards.size, 0);
});
