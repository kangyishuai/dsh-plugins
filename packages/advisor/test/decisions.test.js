// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  bucketOf,
  buildDecision,
  classifySkip,
  createDecisionLog,
  outcomeOf,
  readDecisions,
  summarize,
  turnFeatures,
} from "../lib/decisions.js";

describe("classifySkip", () => {
  it("把宿主的人话原因归到稳定原因码", () => {
    assert.equal(classifySkip("顾问已关闭（/advisor on 打开）"), "skipped-disabled");
    assert.equal(classifySkip("还没配置顾问模型（/advisor 选择）"), "skipped-not-configured");
    assert.equal(classifySkip("没有可用的模型路由"), "skipped-no-route");
    assert.equal(classifySkip("会话里还没有可发送的内容"), "skipped-empty");
    assert.equal(classifySkip("免疫窗口内（上一条建议刚投递过）"), "skipped-immune");
    assert.equal(classifySkip("重复建议（24h 内说过）"), "skipped-duplicate");
    assert.equal(classifySkip("已达会话投递上限"), "skipped-limit");
    assert.equal(classifySkip("超出当日预算"), "skipped-budget");
  });

  it("空原因归到 not-requested，未识别的归到 other", () => {
    assert.equal(classifySkip(""), "skipped-not-requested");
    assert.equal(classifySkip(undefined), "skipped-not-requested");
    assert.equal(classifySkip("某种没见过的原因"), "skipped-other");
  });
});

describe("turnFeatures", () => {
  it("分桶阈值口径固定（长回答 ≥ 800 字、有工具 = 调用数 > 0）", () => {
    assert.deepEqual(turnFeatures({ answerChars: 799, toolCalls: 0 }), {
      answerChars: 799,
      toolCalls: 0,
      hadError: false,
      longAnswer: false,
      usedTools: false,
    });
    assert.equal(turnFeatures({ answerChars: 800 }).longAnswer, true);
    assert.equal(turnFeatures({ toolCalls: 1 }).usedTools, true);
  });

  it("缺字段时按 0 / false 处理，不抛错", () => {
    const features = turnFeatures({});
    assert.equal(features.answerChars, 0);
    assert.equal(features.toolCalls, 0);
    assert.equal(features.hadError, false);
  });
});

describe("buildDecision", () => {
  it("徵询过：带建议字段，原因码为空，outcome 待回填", () => {
    const record = buildDecision({
      sessionId: "s1",
      turn: 3,
      features: { answerChars: 900, toolCalls: 2 },
      advice: { adviceId: "adv_1", severity: "concern", trigger: "tool", costUsd: 0.09 },
    });
    assert.equal(record.consulted, true);
    assert.equal(record.skipCode, null);
    assert.equal(record.adviceId, "adv_1");
    assert.equal(record.severity, "concern");
    assert.equal(record.costUsd, 0.09);
    assert.equal(record.outcome, null);
    assert.equal(record.longAnswer, true);
    assert.equal(record.usedTools, true);
  });

  it("没徵询：记原因码与原因文本，建议字段为空", () => {
    const record = buildDecision({
      sessionId: "s1",
      turn: 4,
      skipReason: "已达会话投递上限",
      features: { answerChars: 10 },
    });
    assert.equal(record.consulted, false);
    assert.equal(record.skipCode, "skipped-limit");
    assert.equal(record.skipReason, "已达会话投递上限");
    assert.equal(record.adviceId, null);
  });
});

describe("outcomeOf", () => {
  it("下一条用户消息命中建议里的信号 → accepted", () => {
    assert.equal(
      outcomeOf(
        { signals: ["src/importer/csv.ts", "pnpm test"] },
        "先改 src/importer/csv.ts 再跑 pnpm test",
      ),
      "accepted",
    );
  });

  it("没命中 → user-typed-other；空消息也算另打字", () => {
    assert.equal(outcomeOf({ signals: ["a.ts"] }, "换个方向，先写文档"), "user-typed-other");
    assert.equal(outcomeOf({ signals: ["a.ts"] }, ""), "user-typed-other");
    assert.equal(outcomeOf({}, "随便说点什么"), "user-typed-other");
  });
});

describe("summarize", () => {
  const records = [
    buildDecision({
      sessionId: "s1",
      turn: 1,
      features: { answerChars: 1200, toolCalls: 3 },
      advice: { adviceId: "adv_1", severity: "concern", trigger: "tool", costUsd: 0.09 },
    }),
    buildDecision({
      sessionId: "s1",
      turn: 2,
      features: { answerChars: 1500, toolCalls: 4 },
      skipReason: "会话里还没有可发送的内容",
    }),
    buildDecision({
      sessionId: "s2",
      turn: 1,
      features: { answerChars: 100 },
      advice: { adviceId: "adv_2", severity: "nit", trigger: "shadow", costUsd: 0.02 },
    }),
  ];
  records[0].outcome = "accepted";
  records[2].outcome = "user-typed-other";

  it("徵询率与采纳率分开算", () => {
    const stats = summarize(records);
    assert.equal(stats.turns, 3);
    assert.equal(stats.consulted, 2);
    assert.ok(Math.abs(stats.consultRate - 2 / 3) < 1e-9);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.ignored, 1);
    assert.equal(stats.acceptRate, 0.5);
  });

  it("按分桶出交叉表，并给出两类可疑样本", () => {
    const stats = summarize(records);
    const long = stats.buckets.find(
      (/** @type {any} */ item) => item.bucket === "长回答/有工具/无报错",
    );
    assert.equal(long.turns, 2);
    assert.equal(long.consulted, 1);
    // 有工具 + 长回答 + 无报错却没徵询 → 疑似漏徵询
    assert.equal(stats.missed.length, 1);
    assert.equal(stats.missed[0].turn, 2);
    // 徵询了但用户另打字 → 疑似无效徵询
    assert.equal(stats.overConsulted.length, 1);
    assert.equal(stats.skipCodes["skipped-empty"], 1);
  });

  it("空输入不炸，采纳率为 null（分母为 0）", () => {
    const stats = summarize([]);
    assert.equal(stats.turns, 0);
    assert.equal(stats.consultRate, 0);
    assert.equal(stats.acceptRate, null);
  });
});

describe("createDecisionLog", () => {
  it("追加一行并可读回", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-decisions-"));
    const log = createDecisionLog({ home });
    await log.append({ sessionId: "s1", turn: 1, consulted: false });
    await log.append({ sessionId: "s1", turn: 2, consulted: true, outcome: null });
    const records = await readDecisions(log.path);
    assert.equal(records.length, 2);
    assert.equal(records[1].consulted, true);
    const text = await readFile(log.path, "utf8");
    assert.ok(text.endsWith("\n"), "每行以换行结尾，方便 jq 与追加");
  });

  it("回填 outcome 只改匹配的那一条", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-decisions-"));
    const log = createDecisionLog({ home });
    await log.append({ sessionId: "s1", turn: 1, consulted: true, outcome: null });
    await log.append({ sessionId: "s1", turn: 2, consulted: true, outcome: null });
    const changed = await log.backfillOutcome("s1", 1, "accepted");
    assert.equal(changed, true);
    const records = await readDecisions(log.path);
    assert.equal(records[0].outcome, "accepted");
    assert.equal(records[1].outcome, null);
  });

  it("回填不存在的回合 → false，不写坏文件", async () => {
    const home = await mkdtemp(join(tmpdir(), "advisor-decisions-"));
    const log = createDecisionLog({ home });
    await log.append({ sessionId: "s1", turn: 1, consulted: true, outcome: null });
    assert.equal(await log.backfillOutcome("s9", 1, "accepted"), false);
    const records = await readDecisions(log.path);
    assert.equal(records.length, 1);
  });
});

describe("bucketOf", () => {
  it("桶名与复盘脚本的列一致", () => {
    assert.equal(
      bucketOf({ longAnswer: true, usedTools: true, hadError: false }),
      "长回答/有工具/无报错",
    );
    assert.equal(bucketOf({}), "短回答/无工具/无报错");
  });
});
