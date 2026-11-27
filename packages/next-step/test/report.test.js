// @ts-check
// report.js 单测：解析、Wilson 区间、指标汇总（含左连接出的"忽略"与漏判）、
// 样本门禁、判读规则、Markdown 结构与报表文件保留策略。
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  intervalsOverlap,
  labelBucketOf,
  MIN_SHOWN,
  MIN_TURNS,
  parseEvents,
  REPORT_KEEP,
  renderMarkdown,
  reportFileName,
  summarize,
  verdicts,
  wilson,
  writeReport,
} from "../lib/report.js";

/** @type {string[]} */
const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * 造一条 turn 事件。
 * @param {{ sid?: string, turn?: number, shown?: boolean, value?: string, tier?: string, clicks?: never, pv?: number, gate?: string, opts?: any[] }} [input]
 * @returns {any}
 */
function turnEvent(input = {}) {
  const gate = input.gate ?? "ok";
  return {
    v: 1,
    scheme: "v0.4",
    pv: input.pv ?? 3,
    t: "turn",
    at: 1000 + (input.turn ?? 1),
    sid: input.sid ?? "abcd1234",
    turn: input.turn ?? 1,
    tier: input.tier ?? "could",
    feat: { answerChars: 500, toolCalls: 2 },
    gate,
    ...(gate === "ok"
      ? {
          cand: {
            value: input.value ?? "could",
            shown: input.shown ?? true,
            opts: input.opts ?? [
              { stance: "a", label: "跑 next-step 冒烟", len: 15, concrete: true },
              { stance: "b", label: "合并 PR #114", len: 11, concrete: true },
            ],
          },
        }
      : {}),
  };
}

/**
 * 造一条 schema 类 error 事件（detail 用 service 实际写入的形状：
 * `model output did not match the card schema (json:empty)`）。
 * @param {string} problem `json:empty` / `options:...` 等
 * @param {{ turn?: number, pv?: number, kind?: string, detail?: string }} [input]
 * @returns {any}
 */
function schemaErrorEvent(problem, input = {}) {
  return {
    v: 1,
    scheme: "v0.4",
    pv: input.pv ?? 4,
    pkg: "0.4.3",
    t: "error",
    at: 5000 + (input.turn ?? 1),
    sid: "abcd1234",
    turn: input.turn ?? 1,
    kind: input.kind ?? "schema",
    detail: input.detail ?? `model output did not match the card schema (${problem})`,
  };
}

/**
 * 造一份「按 pv 形态」的事件集：正常出卡回合 + 若干 schema 失败。
 * 数值取审计的 pv3/pv4 形态（pv4 = 79 空 + 23 格式，这里取 78 + 24 便于边界断言）。
 * @param {{ pv?: number, okTurns?: number, empties?: number, formats?: string[] }} [input]
 * @returns {any[]}
 */
function shapeEvents({ pv = 4, okTurns = 120, empties = 0, formats = [] } = {}) {
  /** @type {any[]} */
  const events = [];
  for (let turn = 1; turn <= okTurns; turn += 1) events.push(turnEvent({ turn, pv }));
  let turn = okTurns;
  for (let index = 0; index < empties; index += 1) {
    turn += 1;
    events.push(schemaErrorEvent("json:empty", { turn, pv }));
  }
  for (const problem of formats) {
    turn += 1;
    events.push(schemaErrorEvent(problem, { turn, pv }));
  }
  return events;
}

/** pv4（0.4.3 行为）形态：78 条空输出 + 24 条非空格式失败。 */
function pv4ShapeEvents() {
  return shapeEvents({
    pv: 4,
    okTurns: 120,
    empties: 78,
    formats: [
      ...Array.from({ length: 20 }, () => "json:no-object"),
      ...Array.from({ length: 2 }, () => "json:unparsable"),
      "options:dropped-option:0:label-length:22",
      "options:none",
    ],
  });
}

/** pv3（0.4.0–0.4.2 行为）形态：2 条空输出 + 17 条非空格式失败。 */
function pv3ShapeEvents() {
  return shapeEvents({
    pv: 3,
    okTurns: 120,
    empties: 2,
    formats: [
      ...Array.from({ length: 3 }, () => "json:no-object"),
      ...Array.from({ length: 2 }, () => "json:unparsable"),
      ...Array.from({ length: 12 }, () => "options:dropped-option:0:label-length:22"),
    ],
  });
}

test("parseEvents：坏行跳过并计数，非对象/缺 t 也算坏行", () => {
  const text = [
    JSON.stringify({ t: "turn", sid: "a", turn: 1 }),
    "not json",
    "",
    JSON.stringify([1, 2]),
    JSON.stringify({ noType: true }),
  ].join("\n");
  const { events, badLines } = parseEvents(text);
  assert.equal(events.length, 1);
  assert.equal(badLines, 3);
  assert.deepEqual(parseEvents(""), { events: [], badLines: 0 });
});

test("wilson：已知值与边界", () => {
  assert.equal(wilson(0, 0), null);
  const half = wilson(5, 10);
  assert.equal(half?.p, 0.5);
  assert.ok(half.low > 0.2 && half.low < 0.3, `low=${half?.low}`);
  assert.ok(half.high > 0.7 && half.high < 0.8, `high=${half?.high}`);
  const all = wilson(10, 10);
  assert.equal(all?.p, 1);
  assert.ok(all.low > 0.6, "全部命中时下界不应是 1（小样本区间要宽）");
  assert.equal(all.high, 1);
  // 样本越大区间越窄
  const wide = wilson(5, 10);
  const narrow = wilson(50, 100);
  assert.ok(wide !== null && narrow !== null, "两个区间都应存在");
  assert.ok(narrow.high - narrow.low < wide.high - wide.low, "样本更大时区间应更窄");
});

test("intervalsOverlap：重叠/分离/缺失", () => {
  assert.equal(intervalsOverlap({ low: 0.1, high: 0.3 }, { low: 0.2, high: 0.4 }), true);
  assert.equal(intervalsOverlap({ low: 0.1, high: 0.3 }, { low: 0.35, high: 0.5 }), false);
  assert.equal(intervalsOverlap(null, { low: 0.1, high: 0.2 }), true);
});

test("labelBucketOf：分桶边界", () => {
  assert.equal(labelBucketOf(0), "≤8");
  assert.equal(labelBucketOf(8), "≤8");
  assert.equal(labelBucketOf(9), "9–12");
  assert.equal(labelBucketOf(12), "9–12");
  assert.equal(labelBucketOf(13), "13–16");
  assert.equal(labelBucketOf(17), "17–20");
});

test("summarize：空输入不抛错，比例为 null", () => {
  const metrics = summarize([]);
  assert.equal(metrics.turns, 0);
  assert.equal(metrics.shown, 0);
  assert.equal(metrics.rates.ctr, null);
  assert.equal(metrics.insufficient, true);
  // 没有 schema 失败时，空输出占比没有分母（用 null，而不是 0 假装看过数据）
  assert.equal(metrics.emptyShare, null);
  assert.deepEqual(metrics.errors.byDetail, {});
});

test("summarize：忽略 = 出过的卡 − 点击 − 关闭（左连接，不依赖显式 ignored 事件）", () => {
  const events = [
    turnEvent({ turn: 1 }),
    turnEvent({ turn: 2 }),
    turnEvent({ turn: 3 }),
    { v: 1, t: "action", at: 2, sid: "abcd1234", turn: 1, kind: "clicked", index: 0 },
    { v: 1, t: "action", at: 3, sid: "abcd1234", turn: 2, kind: "dismissed" },
  ];
  const metrics = summarize(events);
  assert.equal(metrics.shown, 3);
  assert.equal(metrics.clicked, 1);
  assert.equal(metrics.dismissed, 1);
  assert.equal(metrics.ignored, 1, "第 3 张卡没人理 → 忽略");
  assert.equal(metrics.rates.ctr, 1 / 3);
});

test("summarize：漏判 = 揭示 + 抑制后用户自己打了相关的一句", () => {
  const events = [
    turnEvent({ turn: 1, shown: false, value: "no" }),
    turnEvent({ turn: 2, shown: false, value: "could" }),
    turnEvent({ turn: 3, shown: false, value: "could" }),
    { v: 1, t: "promote", at: 2, sid: "abcd1234", turn: 1, found: true, value: "no" },
    // 有重合 → 算漏判
    {
      v: 1,
      t: "followup",
      at: 2,
      sid: "abcd1234",
      turn: 2,
      typed: true,
      delayMs: 1000,
      textChars: 12,
      overlap: 1,
    },
    // 无重合 → 不算（用户想说的是另一件事）
    {
      v: 1,
      t: "followup",
      at: 2,
      sid: "abcd1234",
      turn: 3,
      typed: true,
      delayMs: 1000,
      textChars: 12,
      overlap: 0,
    },
  ];
  const metrics = summarize(events);
  assert.equal(metrics.suppressed, 3);
  assert.equal(metrics.promoted, 1);
  assert.equal(metrics.missedByOverlap, 1);
  assert.equal(metrics.misses, 2);
  assert.equal(metrics.rates.missRate, 2 / 3);
});

test("summarize：曝光分三档（可见 / 未进视口 / 未知）", () => {
  const events = [
    turnEvent({ turn: 1 }),
    turnEvent({ turn: 2 }),
    turnEvent({ turn: 3 }),
    { v: 1, t: "impression", at: 2, sid: "abcd1234", turn: 1, visibleMs: 2400, ratio: 0.9 },
    { v: 1, t: "impression", at: 2, sid: "abcd1234", turn: 2, visibleMs: 0, ratio: 0 },
    { v: 1, t: "impression", at: 2, sid: "abcd1234", turn: 3, visibleMs: 0, ratio: -1 },
  ];
  const metrics = summarize(events);
  assert.equal(metrics.seen, 1);
  assert.equal(metrics.unseen, 1);
  assert.equal(metrics.unseenUnknown, 1, "ratio<0 单列未知，不进曝光率分母");
  assert.equal(metrics.rates.seenRate, 1 / 3);
});

test("summarize：同一张卡多次上报曝光时取最大可见时长", () => {
  const events = [
    turnEvent({ turn: 1 }),
    { v: 1, t: "impression", at: 2, sid: "abcd1234", turn: 1, visibleMs: 300, ratio: 0.5 },
    { v: 1, t: "impression", at: 3, sid: "abcd1234", turn: 1, visibleMs: 2000, ratio: 0.8 },
    { v: 1, t: "impression", at: 4, sid: "abcd1234", turn: 1, visibleMs: 0, ratio: 0 },
  ];
  const metrics = summarize(events);
  assert.equal(metrics.seen, 1);
  assert.equal(metrics.unseen, 0);
});

test("summarize：闸门与失败计数；schemaShare 用「ok 回合 + 失败数」当分母", () => {
  const events = [
    turnEvent({ turn: 1 }),
    turnEvent({ turn: 2, gate: "short-answer" }),
    turnEvent({ turn: 3, gate: "budget" }),
    { v: 1, t: "error", at: 5, sid: "abcd1234", turn: 4, kind: "schema" },
    { v: 1, t: "error", at: 5, sid: "abcd1234", turn: 5, kind: "timeout" },
  ];
  const metrics = summarize(events);
  assert.equal(metrics.gates.ok, 1);
  assert.equal(metrics.gates["short-answer"], 1);
  assert.equal(metrics.gates.budget, 1);
  assert.equal(metrics.errors.total, 2);
  assert.equal(metrics.errors.byKind.schema, 1);
  assert.equal(metrics.schemaShare, 1 / 3);
});

test("summarize：pv4 形态（78 空 + 24 格式）拆 byDetail，空输出不冒充格式失败", () => {
  // 审计结论：0.4.3 的 102 条 schema 里 79 条是「模型返回空文本」，不是格式变严。
  // 报表必须把这两类分开，否则「schema 错误 5.5×」会被误读成「解析要放宽」。
  const metrics = summarize(pv4ShapeEvents());
  assert.equal(metrics.insufficient, false, "120 个出卡回合要够判读门槛");
  assert.equal(metrics.errors.total, 102);
  assert.equal(metrics.errors.byKind.schema, 102);
  assert.deepEqual(metrics.errors.byDetail, {
    "json:empty": 78,
    "json:no-object": 20,
    "json:unparsable": 2,
    options: 2,
  });
  assert.equal(metrics.errors.schema, 102);
  assert.equal(metrics.errors.empty, 78);
  assert.equal(metrics.errors.format, 24, "非空格式失败 = schema 失败 − 空输出");
  // 分子只算非空格式失败；分母仍是「正常出卡回合 + 全部失败结局」
  assert.equal(metrics.schemaShare, 24 / 222);
  // 空输出占 schema 失败的比例（不是占全部生成结局）
  assert.equal(metrics.emptyShare, 78 / 102);

  const codes = verdicts(metrics).map((item) => item.code);
  assert.ok(codes.includes("empty-generations"), `实际判读=${JSON.stringify(codes)}`);
  assert.equal(
    codes.includes("schema-failures"),
    false,
    "空输出占比高 ≠ 解析需要放宽（那正是本口径要防的误读）",
  );
});

test("summarize：pv3 形态（2 空 + 17 格式）两条判读都不触发（空输出是 0.4.3 才集中的新口径）", () => {
  const metrics = summarize(pv3ShapeEvents());
  assert.equal(metrics.errors.total, 19);
  assert.deepEqual(metrics.errors.byDetail, {
    "json:empty": 2,
    "json:no-object": 3,
    "json:unparsable": 2,
    options: 12,
  });
  assert.equal(metrics.emptyShare, 2 / 19);
  assert.equal(metrics.schemaShare, 17 / 139);

  const codes = verdicts(metrics).map((item) => item.code);
  assert.equal(codes.includes("schema-failures"), false);
  assert.equal(codes.includes("empty-generations"), false);
});

test("verdicts：非空格式失败仍走 schema-failures；空输出占比低时不报 empty-generations", () => {
  // 格式失败 54 / (100 正常 + 60 失败结局) = 33.75% → 该报「解析/修复调用」；
  // 空输出只有 6/60 = 10% → 不该抢戏报成「模型空输出」。
  const metrics = summarize(
    shapeEvents({
      pv: 4,
      okTurns: 100,
      empties: 6,
      formats: Array.from({ length: 54 }, () => "json:no-object"),
    }),
  );
  assert.equal(metrics.schemaShare, 54 / 160);
  assert.equal(metrics.emptyShare, 6 / 60);
  const list = verdicts(metrics);
  const codes = list.map((item) => item.code);
  assert.ok(codes.includes("schema-failures"));
  const schemaVerdict = list.find((item) => item.code === "schema-failures");
  assert.match(schemaVerdict === undefined ? "" : schemaVerdict.text, /非空格式失败/u);
  assert.equal(codes.includes("empty-generations"), false);
});

test("renderMarkdown：归因段印出「空输出 vs 非空格式失败」拆分与 empty-generations", () => {
  const metrics = summarize(pv4ShapeEvents());
  const markdown = renderMarkdown(metrics, verdicts(metrics));
  assert.match(markdown, /空输出/u);
  assert.match(markdown, /非空格式失败/u);
  assert.match(markdown, /empty-generations/u);
});

test("summarize：分组统计（判定/档位/第几条/选项数/label 长度/提示词版本）", () => {
  const events = [
    turnEvent({ turn: 1, value: "must" }),
    turnEvent({ turn: 2, value: "could", tier: "any" }),
    turnEvent({ turn: 3, value: "could", pv: 4 }),
    { v: 1, t: "action", at: 2, sid: "abcd1234", turn: 1, kind: "clicked", index: 0 },
    { v: 1, t: "action", at: 3, sid: "abcd1234", turn: 2, kind: "clicked", index: 1 },
  ];
  const metrics = summarize(events);
  assert.equal(metrics.byValue.must.n, 1);
  assert.equal(metrics.byValue.must.clicked, 1);
  assert.equal(metrics.byValue.could.n, 2);
  assert.equal(metrics.byValue.could.clicked, 1);
  assert.equal(metrics.byTier.any.n, 1);
  assert.equal(metrics.byIndex["0"].clicked, 1);
  assert.equal(metrics.byIndex["1"].clicked, 1);
  // 分母 = 该位置被**展示**的次数（三张卡各 2 粒 → 两个位置各 3 次），不是点击次数。
  assert.equal(metrics.byIndex["0"].n, 3);
  assert.equal(metrics.byIndex["1"].n, 3);
  assert.equal(metrics.byOptionCount["2"].n, 3);
  assert.equal(metrics.byPromptVersion["4"].n, 1);
  // label 长度桶按"每张卡的每条 option"铺开
  assert.equal(metrics.byLabelBucket["13–16"].n, 3, "15 字的 label 出现 3 次");
});

test("summarize：byIndex 的分母是该位置被展示的次数（AUD-NS-03）", () => {
  // 10 张卡各 2 粒，只有第 0 粒被点过 3 次。修复前 byIndex 只在点击时 bump，
  // 于是第二粒的 n 恒等于它的点击次数（这里是 0）——`second-option-useless` 的 n>=20 永远达不到。
  const events = [];
  for (let turn = 1; turn <= 10; turn += 1) events.push(turnEvent({ turn }));
  for (const turn of [1, 2, 3]) {
    events.push({ v: 1, t: "action", at: 2, sid: "abcd1234", turn, kind: "clicked", index: 0 });
  }
  const metrics = summarize(events);
  assert.equal(metrics.byIndex["0"].n, 10, "第 0 粒被展示 10 次");
  assert.equal(metrics.byIndex["1"].n, 10, "第 1 粒同样被展示 10 次（不是 0）");
  assert.equal(metrics.byIndex["0"].clicked, 3);
  assert.equal(metrics.byIndex["1"].clicked, 0);
  // 点击率的分母 = 展示次数
  assert.equal(metrics.byIndex["0"].ctr, 0.3);
  assert.equal(metrics.byIndex["1"].ctr, 0);
});

test("verdicts：真实事件形态下 second-option-useless 可命中（AUD-NS-03）", () => {
  // 80 张卡 × 2 粒（够 MIN_TURNS=80 / MIN_SHOWN=25），只点第 0 粒。
  // 修复前第二粒的 n=0，判读结构上不可达；修复后 n=80、0 次点击，区间上界 <10% → 必须命中。
  const events = [];
  for (let turn = 1; turn <= MIN_TURNS; turn += 1) events.push(turnEvent({ turn }));
  for (let turn = 1; turn <= 10; turn += 1) {
    events.push({ v: 1, t: "action", at: 2, sid: "abcd1234", turn, kind: "clicked", index: 0 });
  }
  const metrics = summarize(events);
  assert.equal(metrics.insufficient, false, "样本必须够，否则判读一律不输出");
  assert.equal(metrics.byIndex["1"].n, MIN_TURNS);
  const codes = verdicts(metrics).map((item) => item.code);
  assert.ok(codes.includes("second-option-useless"), `实际判读=${JSON.stringify(codes)}`);
});

test("verdicts：样本不足时一条判读都不给", () => {
  const metrics = summarize([turnEvent({ turn: 1 })]);
  assert.equal(metrics.insufficient, true);
  assert.deepEqual(verdicts(metrics), []);
});

/**
 * 造一个"样本充足"的指标骨架（默认全部健康，可通过 overrides 触发规则）。
 * @param {any} [overrides]
 * @returns {any}
 */
function healthyMetrics(overrides = {}) {
  const base = {
    turns: MIN_TURNS + 10,
    shown: MIN_SHOWN + 10,
    suppressed: 20,
    seen: MIN_SHOWN,
    unseen: 10,
    unseenUnknown: 0,
    clicked: 8,
    dismissed: 2,
    ignored: 25,
    promoted: 0,
    missedByOverlap: 0,
    misses: 0,
    rates: {
      cardRate: 0.5,
      seenRate: 0.9,
      ctr: 0.25,
      ignoreRate: 0.3,
      missRate: 0,
    },
    ci: {
      ctr: wilson(8, MIN_SHOWN + 10),
      missRate: null,
    },
    byValue: {
      must: { n: 10, clicked: 3, ctr: 0.3, ci: wilson(3, 10) },
      could: { n: 20, clicked: 5, ctr: 0.25, ci: wilson(5, 20) },
    },
    byIndex: { 0: { n: 30, clicked: 8, ctr: 0.27, ci: wilson(8, 30) } },
    byOptionCount: {},
    byLabelBucket: {},
    byTier: {},
    byPromptVersion: {},
    gates: { ok: MIN_TURNS },
    errors: { total: 0, byKind: {}, byDetail: {}, schema: 0, empty: 0, format: 0 },
    schemaShare: 0,
    emptyShare: null,
    insufficient: false,
  };
  return { ...base, ...overrides, rates: { ...base.rates, ...(overrides.rates ?? {}) } };
}

test("verdicts：曝光率过低 → 先修位置，不动提示词", () => {
  const list = verdicts(healthyMetrics({ rates: { seenRate: 0.3 } }));
  const codes = list.map((item) => item.code);
  assert.ok(codes.includes("low-exposure"));
  const exposure = list.find((item) => item.code === "low-exposure");
  assert.notEqual(exposure, undefined);
  assert.match(exposure === undefined ? "" : exposure.action, /位置|时机/u);
});

test("verdicts：看见了却忽略 → 改内容（不是门控）", () => {
  const list = verdicts(healthyMetrics({ rates: { seenRate: 0.9, ignoreRate: 0.85 } }));
  const codes = list.map((item) => item.code);
  assert.ok(codes.includes("ignored-but-seen"));
});

test("verdicts：漏判率过高 → 建议把档位往积极调", () => {
  const list = verdicts(healthyMetrics({ rates: { missRate: 0.4 }, misses: 8, suppressed: 20 }));
  assert.ok(list.some((item) => item.code === "too-strict"));
});

test("verdicts：must 与 could 区间重叠 → 三档没有区分力", () => {
  const list = verdicts(healthyMetrics());
  assert.ok(list.some((item) => item.code === "tiers-indistinct"));
  // 区间明显分离时不应报这条
  const separated = verdicts(
    healthyMetrics({
      byValue: {
        must: { n: 40, clicked: 20, ctr: 0.5, ci: wilson(20, 40) },
        could: { n: 40, clicked: 2, ctr: 0.05, ci: wilson(2, 40) },
      },
    }),
  );
  assert.equal(
    separated.some((item) => item.code === "tiers-indistinct"),
    false,
  );
});

test("verdicts：第二条没人点 / 格式失败偏多 / 预算命中 各自触发", () => {
  const second = verdicts(
    healthyMetrics({
      byIndex: {
        0: { n: 40, clicked: 18, ctr: 0.45, ci: wilson(18, 40) },
        1: { n: 40, clicked: 0, ctr: 0, ci: wilson(0, 40) },
      },
    }),
  ).map((item) => item.code);
  assert.ok(second.includes("second-option-useless"));

  const schema = verdicts(healthyMetrics({ schemaShare: 0.3 })).map((item) => item.code);
  assert.ok(schema.includes("schema-failures"));

  const budget = verdicts(healthyMetrics({ gates: { ok: 80, budget: 3 } })).map(
    (item) => item.code,
  );
  assert.ok(budget.includes("budget-hit"));
});

test("verdicts：全部健康时没有任何判读", () => {
  const list = verdicts(
    healthyMetrics({
      byValue: {},
      byIndex: { 0: { n: 30, clicked: 8, ctr: 0.27, ci: wilson(8, 30) } },
      rates: { seenRate: 0.95, ctr: 0.25, ignoreRate: 0.3, missRate: 0 },
    }),
  );
  assert.deepEqual(list, []);
});

test("renderMarkdown：五段齐全、印出分母与区间、带口径说明", () => {
  const metrics = healthyMetrics({ rates: { seenRate: 0.3 } });
  const markdown = renderMarkdown(metrics, verdicts(metrics));
  for (const heading of [
    "## 1. 样本量",
    "## 2. 频率",
    "## 3. 归因",
    "## 4. 内容与按钮",
    "## 5. 建议动作",
  ]) {
    assert.equal(markdown.includes(heading), true, `缺少段落：${heading}`);
  }
  assert.match(markdown, /\*\*80\*\*|合格回合：\*\*\d+\*\*/u, "样本量段落要印出回合数");
  assert.match(markdown, /点击率：\d+%（\d+\/\d+）/u, "点击率要带分母");
  assert.match(markdown, /Wilson/u, "口径说明要提到区间方法");
  assert.ok(markdown.endsWith("\n"));
});

test("renderMarkdown：样本不足时明写「不给判读」", () => {
  const metrics = summarize([turnEvent({ turn: 1 })]);
  const markdown = renderMarkdown(metrics, verdicts(metrics));
  assert.match(markdown, /样本不足/u);
  assert.match(markdown, /暂无建议/u);
});

test("reportFileName：UTC 时间戳，同一天不同秒不覆盖", () => {
  const a = reportFileName(Date.UTC(2026, 10, 14, 10, 20, 30));
  assert.match(a, /^report-20261114-102030\.md$/u);
  const b = reportFileName(Date.UTC(2026, 10, 14, 10, 20, 31));
  assert.notEqual(a, b);
});

test("writeReport：写入数据根下、只保留最新 N 份", async () => {
  const home = await mkdtemp(join(tmpdir(), "ns-report-"));
  tempDirs.push(home);
  const dir = join(home, "next-step");
  // 先造一批"旧"报表
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < REPORT_KEEP + 3; index += 1) {
    const at = Date.UTC(2026, 0, 1, 0, 0, index);
    await writeFile(join(dir, reportFileName(at)), "old", "utf8");
  }
  const path = await writeReport({
    home,
    markdown: "# new\n",
    now: Date.UTC(2026, 0, 2, 0, 0, 0),
  });
  assert.equal(await readFile(path, "utf8"), "# new\n");
  const reports = (await readdir(dir)).filter((name) => name.startsWith("report-"));
  assert.equal(reports.length, REPORT_KEEP, `期望保留 ${REPORT_KEEP} 份，实际=${reports.length}`);
  assert.equal(reports.includes(reportFileName(Date.UTC(2026, 1, 1, 0, 0, 0))), false);
  // 保留的是最新的若干份：最老的那批不该还在
  assert.equal(
    reports.includes(reportFileName(Date.UTC(2026, 0, 2, 0, 0, 0))),
    true,
    "新报告必须留下",
  );
});
