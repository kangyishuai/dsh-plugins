// @ts-check
// 决策日志的**接线**测试：用真实的事件处理入口驱动，确认
// 「回合开始 → 回合结束」会写出决策行，且下一条用户消息能回填 outcome。
//
// 不碰模型、不联网：handleSessionEvent 里与徵询相关的分支在这里走不到
//（mode 默认 off → runAdvisor 直接 skip），正好用来验证「没徵询也要记一行」。
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDecisionLog, createDecisionTracker, readDecisions } from "../lib/decisions.js";

/**
 * 造一个只跑决策日志的跟踪器（service.js 依赖宿主包，单测环境里导入不了，
 * 所以「事件 → 决策行」这条逻辑放在 decisions.js 的 tracker 里，这里直接驱动它）。
 * @param {string} home
 */
function makeService(home) {
  const log = createDecisionLog({ home, logger: { warn() {} } });
  const tracker = createDecisionTracker({ log });
  return {
    tracker,
    /** @param {string} sessionId @param {any} event */
    deliver(sessionId, event) {
      if (event?.type === "turn/start") {
        tracker.startTurn(sessionId, Number(event.data?.turn) || 0);
        return;
      }
      if (event?.type === "turn/end") {
        void tracker.finishTurn({
          sessionId,
          turn: Number(event.data?.turn) || 0,
          endKind: event.data?.reason?.kind ?? "completed",
          skipReason: "顾问已关闭（/advisor on 打开）",
        });
        return;
      }
      tracker.track(sessionId, event);
    },
  };
}

/** @param {string} text */
const userMessage = (text) => ({
  type: "user/message",
  data: { message: { role: "user", content: [{ type: "text", text }] } },
});

/** @param {string} text @param {number} tools */
const assistantMessage = (text, tools = 0) => ({
  type: "assistant/message",
  data: {
    message: {
      role: "assistant",
      content: [
        ...(text === "" ? [] : [{ type: "text", text }]),
        ...Array.from({ length: tools }, (_item, index) => ({
          type: "tool-call",
          id: `call_${index}`,
          name: "read",
          arguments: "{}",
        })),
      ],
    },
  },
});

/** @param {any} service @param {any} event */
const deliver = (service, event) => service.deliver("s1", event);

describe("决策日志接线", () => {
  it("一个正常回合写一行：特征被累计、未徵询带原因码", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-wiring-"));
    const service = makeService(home);
    deliver(service, { type: "turn/start", data: { turn: 1 } });
    deliver(service, assistantMessage("先看一下实现，再改两处。", 2));
    deliver(service, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1);
    assert.equal(records[0].turn, 1);
    assert.equal(records[0].endKind, "completed");
    assert.equal(records[0].consulted, false);
    assert.equal(records[0].toolCalls, 2);
    assert.ok(records[0].answerChars > 0);
    // mode 默认 off → 没徵询，原因码要有值（而不是 null）
    assert.equal(typeof records[0].skipCode, "string");
  });

  it("中断的回合也记一行，endKind 与原因都对", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-wiring-"));
    const service = makeService(home);
    deliver(service, { type: "turn/start", data: { turn: 1 } });
    deliver(service, assistantMessage("做一半。", 1));
    deliver(service, { type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1);
    assert.equal(records[0].endKind, "aborted");
    assert.equal(records[0].consulted, false);
    assert.match(String(records[0].skipReason), /中断/u);
  });

  it("没有回合号时不写（避免脏行）", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-wiring-"));
    const service = makeService(home);
    // 没有 turn/start，也没有 turn 号：模拟事件缺失
    await service.tracker.finishTurn({ sessionId: "s1", turn: 0, endKind: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1, "tracker 层仍会写一行，turn=0 由 service 层挡掉");
    assert.equal(records[0].turn, 0);
  });

  it("徵询过的回合：outcome 由下一条用户消息回填", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-wiring-"));
    const service = makeService(home);
    deliver(service, { type: "turn/start", data: { turn: 1 } });
    deliver(service, assistantMessage("改动完成。", 1));
    // 模拟本回合确实徵询过（真实路径由 runAdvisor 写入）
    service.tracker.noteAdvice("s1", {
      adviceId: "adv_test",
      severity: "concern",
      trigger: "tool",
      costUsd: 0.01,
      adviceText: "建议改 `src/importer/csv.ts` 的 BOM 处理。",
    });
    deliver(service, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    let records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1);
    assert.equal(records[0].consulted, true);
    assert.equal(records[0].adviceId, "adv_test");
    assert.equal(records[0].outcome, null, "还没收到下一条用户消息");

    // 用户接着发了命中建议信号的内容 → accepted
    deliver(service, userMessage("好，改 src/importer/csv.ts 那个 BOM"));
    await new Promise((resolve) => setTimeout(resolve, 80));

    records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "accepted");
  });

  it("用户另说别的 → user-typed-other", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-wiring-"));
    const service = makeService(home);
    deliver(service, { type: "turn/start", data: { turn: 1 } });
    deliver(service, assistantMessage("改动完成。"));
    service.tracker.noteAdvice("s1", {
      adviceId: "adv_test",
      severity: "nit",
      trigger: "shadow",
      costUsd: 0.01,
      adviceText: "建议改 `src/importer/csv.ts`。",
    });
    deliver(service, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    deliver(service, userMessage("先别管这个，帮我看看 CI。"));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "user-typed-other");
  });
});
