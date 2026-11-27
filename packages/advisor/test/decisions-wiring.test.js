// @ts-check
// 决策日志的**接线**测试：用真实的事件处理入口驱动，确认
// 「回合开始 → 回合结束」会写出决策行，且下一条用户消息能回填 outcome。
//
// 不碰模型、不联网：handleSessionEvent 里与征询相关的分支在这里走不到
//（mode 默认 off → runAdvisor 直接 skip），正好用来验证「没征询也要记一行」。
//
// 等待策略：**不用 sleep 猜时序**。回合结束的 `finishTurn` 直接 await；`track()` 里的
// outcome 回填是 fire-and-forget，用 `decisionLog.flush()`（等所有在途写落盘）兜住。
// 旧版每步 `setTimeout(50/80/120)` 曾在全仓 verify 并发时偶发红（复审指出的既有 flake）。
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createDecisionLog, createDecisionTracker, readDecisions } from "../lib/decisions.js";
import { cleanupTempDirs, tempDir } from "./temp.js";

after(cleanupTempDirs);

/**
 * 造一个只跑决策日志的跟踪器（service.js 依赖宿主包，单测环境里导入不了，
 * 所以「事件 → 决策行」这条逻辑放在 decisions.js 的 tracker 里，这里直接驱动它）。
 * `deliver` 是 async 的：turn/end 等 `finishTurn`，其余事件等 `flush()`。
 * @param {string} home
 */
function makeService(home) {
  const log = createDecisionLog({ home, logger: /** @type {any} */ ({ warn() {} }) });
  const tracker = createDecisionTracker({ log });
  return {
    tracker,
    /** @returns {Promise<void>} 等到当前所有写操作落盘。 */
    settle: () => log.flush(),
    /**
     * @param {string} sessionId
     * @param {any} event
     * @returns {Promise<{ backfilled: { turn: number, outcome: string } | null } | undefined>}
     */
    async deliver(sessionId, event) {
      if (event?.type === "turn/start") {
        tracker.startTurn(sessionId, Number(event.data?.turn) || 0);
        return undefined;
      }
      if (event?.type === "turn/end") {
        await tracker.finishTurn({
          sessionId,
          turn: Number(event.data?.turn) || 0,
          endKind: event.data?.reason?.kind ?? "completed",
          skipReason: "顾问已关闭（/advisor on 打开）",
        });
        return undefined;
      }
      const result = tracker.track(sessionId, event);
      // track() 内部用 void 触发回填，这里等它落盘后再断言。
      await log.flush();
      return result;
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
  it("一个正常回合写一行：特征被累计、未征询带原因码", async () => {
    const home = await tempDir("advisor-wiring");
    const service = makeService(home);
    await deliver(service, { type: "turn/start", data: { turn: 1 } });
    await deliver(service, assistantMessage("先看一下实现，再改两处。", 2));
    await deliver(service, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1);
    assert.equal(records[0].turn, 1);
    assert.equal(records[0].endKind, "completed");
    assert.equal(records[0].consulted, false);
    assert.equal(records[0].toolCalls, 2);
    assert.ok(records[0].answerChars > 0);
    // mode 默认 off → 没征询，原因码要有值（而不是 null）
    assert.equal(typeof records[0].skipCode, "string");
  });

  it("中断的回合也记一行，endKind 与原因都对", async () => {
    const home = await tempDir("advisor-wiring");
    const service = makeService(home);
    await deliver(service, { type: "turn/start", data: { turn: 1 } });
    await deliver(service, assistantMessage("做一半。", 1));
    await deliver(service, { type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } });

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1);
    assert.equal(records[0].endKind, "aborted");
    assert.equal(records[0].consulted, false);
    assert.match(String(records[0].skipReason), /中断/u);
  });

  it("没有回合号时不写（避免脏行）", async () => {
    const home = await tempDir("advisor-wiring");
    const service = makeService(home);
    // 没有 turn/start，也没有 turn 号：模拟事件缺失
    await service.tracker.finishTurn({ sessionId: "s1", turn: 0, endKind: "completed" });
    await service.settle();

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1, "tracker 层仍会写一行，turn=0 由 service 层挡掉");
    assert.equal(records[0].turn, 0);
  });

  it("征询过的回合：outcome 由下一条用户消息回填", async () => {
    const home = await tempDir("advisor-wiring");
    const service = makeService(home);
    await deliver(service, { type: "turn/start", data: { turn: 1 } });
    await deliver(service, assistantMessage("改动完成。", 1));
    // 模拟本回合确实征询过（真实路径由 runAdvisor 写入）
    service.tracker.noteAdvice("s1", {
      adviceId: "adv_test",
      severity: "concern",
      trigger: "tool",
      costUsd: 0.01,
      adviceText: "建议改 `src/importer/csv.ts` 的 BOM 处理。",
    });
    await deliver(service, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });

    let records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records.length, 1);
    assert.equal(records[0].consulted, true);
    assert.equal(records[0].adviceId, "adv_test");
    assert.equal(records[0].outcome, null, "还没收到下一条用户消息");

    // 用户接着发了命中建议信号的内容 → accepted
    await deliver(service, userMessage("好，改 src/importer/csv.ts 那个 BOM"));

    records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "accepted");
  });

  it("用户另说别的 → user-typed-other", async () => {
    const home = await tempDir("advisor-wiring");
    const service = makeService(home);
    await deliver(service, { type: "turn/start", data: { turn: 1 } });
    await deliver(service, assistantMessage("改动完成。"));
    service.tracker.noteAdvice("s1", {
      adviceId: "adv_test",
      severity: "nit",
      trigger: "shadow",
      costUsd: 0.01,
      adviceText: "建议改 `src/importer/csv.ts`。",
    });
    await deliver(service, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });

    await deliver(service, userMessage("先别管这个，帮我看看 CI。"));

    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "user-typed-other");
  });
});

describe("outcome 回填：accepted / user-typed-other / no-action 三条路径都可达（AUD-ADV-07 / 09）", () => {
  /**
   * 造一个「第 1 回合征询过」的现场，返回跟踪器与决策日志目录。
   * @param {string} prefix
   */
  async function consulted(prefix) {
    const home = await tempDir(prefix);
    const service = makeService(home);
    await deliver(service, { type: "turn/start", data: { turn: 1 } });
    await deliver(service, assistantMessage("改动完成。", 1));
    service.tracker.noteAdvice("s1", {
      adviceId: "adv_test",
      severity: "concern",
      trigger: "tool",
      costUsd: 0.01,
      adviceText: "建议改 `src/importer/csv.ts` 的 BOM 处理。",
      evidence: [{ ref: "call_1" }],
    });
    await deliver(service, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });
    return { home, service };
  }

  it("下一回合的助手消息里出现建议信号 → accepted（不再只有用户复述才认）", async () => {
    const { home, service } = await consulted("advisor-wiring");
    await deliver(service, { type: "turn/start", data: { turn: 2 } });
    await deliver(service, assistantMessage("好，我改 src/importer/csv.ts 的 BOM 解析。"));
    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "accepted");
    assert.equal(records[0].outcomeWhy, "assistant-message");
  });

  it("下一回合的工具参数里有建议信号 → accepted", async () => {
    const { home, service } = await consulted("advisor-wiring");
    await deliver(service, { type: "turn/start", data: { turn: 2 } });
    await deliver(service, {
      type: "tools/execute",
      data: { tool: "edit", args: { path: "src/importer/csv.ts" } },
    });
    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "accepted");
    assert.equal(records[0].outcomeWhy, "tool-call");
  });

  it("宿主注入的 user/message（source.kind=goal）不算用户反应，不误判 accepted/other", async () => {
    const { home, service } = await consulted("advisor-wiring");
    await deliver(service, { type: "turn/start", data: { turn: 2 } });
    await deliver(service, {
      type: "user/message",
      data: {
        message: {
          role: "user",
          source: { kind: "goal" },
          content: [{ type: "text", text: "自动继续：把 src/importer/csv.ts 也处理掉" }],
        },
      },
    });
    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, null, "注入消息不该回填 outcome");
  });

  it("下一回合没有真人消息就结束时，回填 no-action（该分支不再不可达）", async () => {
    const { home, service } = await consulted("advisor-wiring");
    await deliver(service, { type: "turn/start", data: { turn: 2 } });
    await deliver(service, assistantMessage("继续做别的。"));
    await deliver(service, {
      type: "turn/end",
      data: { turn: 2, reason: { kind: "completed" } },
    });
    const records = await readDecisions(join(home, "advisor", "decisions.jsonl"));
    assert.equal(records[0].outcome, "no-action");
    assert.equal(records[0].outcomeWhy, "no-follow-up");
  });
});
