// @ts-check
// 可观测纯逻辑：从事件推导步骤/命令/tokens，diff 解析，缺失数据显式 n/a。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  initialStats,
  observeEvent,
  parseNumstat,
  summarizeEvents,
  summarizeForRow,
  tokensFrom,
} from "../lib/observability.js";

describe("observeEvent", () => {
  it("assistant/attempt 记一步，并累计 tokens", () => {
    const s = observeEvent(initialStats(), {
      type: "assistant/attempt",
      data: { usage: { inputTokens: 10, outputTokens: 5 } },
      time: 1,
    });
    assert.equal(s.steps, 1);
    assert.equal(s.tokens, 15);
    assert.equal(s.usageSeen, true);
  });

  it("没有 usage 时不虚构 token（usageSeen=false）", () => {
    const s = observeEvent(initialStats(), { type: "assistant/attempt", data: {} });
    assert.equal(s.steps, 1);
    assert.equal(s.tokens, 0);
    assert.equal(s.usageSeen, false);
  });

  it("tool/call 记工具与命令名，tool/result 回填成功与否", () => {
    let s = observeEvent(initialStats(), {
      type: "tool/call",
      data: { args: { command: "pnpm test\nsecond line" } },
      time: 2,
    });
    assert.equal(s.toolCalls, 1);
    assert.deepEqual(s.commands, [{ name: "pnpm test", ok: null }]);

    s = observeEvent(s, { type: "tool/result", data: { ok: false }, time: 3 });
    assert.deepEqual(s.commands, [{ name: "pnpm test", ok: false }]);
  });

  it("取不到 command 时退回工具名（不编造）", () => {
    const s = observeEvent(initialStats(), { type: "tool/call", data: { name: "read_file" } });
    assert.equal(s.commands[0].name, "read_file");
  });

  it("命令明细有上限（长跑不会无限增长）", () => {
    let s = initialStats();
    for (let i = 0; i < 30; i += 1) {
      s = observeEvent(s, { type: "tool/call", data: { args: { command: `cmd-${i}` } } });
    }
    assert.ok(s.commands.length <= 12, `实际 ${s.commands.length}`);
    assert.equal(s.commands.at(-1)?.name, "cmd-29");
  });

  it("未知事件原样返回（不改坏输入）", () => {
    const base = initialStats();
    assert.deepEqual(observeEvent(base, { type: "something/else" }), base);
  });
});

describe("tokensFrom", () => {
  it("兼容三种字段名", () => {
    assert.equal(tokensFrom({ totalTokens: 7 }), 7);
    assert.equal(tokensFrom({ total: 9 }), 9);
    assert.equal(tokensFrom({ inputTokens: 4, outputTokens: 6 }), 10);
    assert.equal(tokensFrom(null), 0);
  });
});

describe("summarizeEvents", () => {
  it("一次归约一串事件，兼容 {type,event} 包装", () => {
    const s = summarizeEvents([
      { type: "assistant/attempt", data: {} },
      { event: { type: "tool/call", data: { args: { command: "ls" } } } },
    ]);
    assert.equal(s.steps, 1);
    assert.equal(s.toolCalls, 1);
  });
});

describe("parseNumstat", () => {
  it("正常多文件", () => {
    assert.deepEqual(parseNumstat("3\t1\ta.js\n2\t0\tb.js"), { files: 2, added: 5, removed: 1 });
  });

  it("空输出 = 无改动", () => {
    assert.deepEqual(parseNumstat(""), { files: 0, added: 0, removed: 0 });
  });

  it("二进制文件（-/-）不能装作数字，返回 null 显示 n/a", () => {
    assert.equal(parseNumstat("-\t-\timg.png"), null);
  });
});

describe("summarizeForRow", () => {
  it("有 diff 时给出文件数与增删", () => {
    const text = summarizeForRow({
      stats: { ...initialStats(), steps: 2, toolCalls: 3, tokens: 100, usageSeen: true },
      diff: { files: 1, added: 5, removed: 2 },
    });
    assert.match(text, /2 步/u);
    assert.match(text, /3 次工具/u);
    assert.match(text, /diff 1 文件 \+5\/-2/u);
    assert.match(text, /100 tokens/u);
  });

  it("缺 diff / 缺 usage 时显式写 n/a", () => {
    const text = summarizeForRow({ stats: initialStats(), diff: null });
    assert.match(text, /diff n\/a/u);
    assert.match(text, /tokens n\/a/u);
  });
});
