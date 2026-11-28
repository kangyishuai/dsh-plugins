// @ts-check
// 生成编排（generation-recovery.js）的 fake-model 契约测试。
//
// 为什么需要这一层（2026-11-28）：恢复链原来整个长在 `service.js` 的 `generate()` 里，而 service
// import 宿主的 `@deepseek-ai/*`，`node --test` 加载不了 —— 于是「首轮空 → 升级预算 → 成功 /
// 仍空再修复 / 首轮畸形直接修复 / 升级后畸形按真实输出修复 / 三次全败」这些分支只有真机能碰，
// 真机又要花额度、还要恰好遇到推理模型吃光预算。这里把 `callModel` 换成**脚本化 fake model**
// （每次调用按脚本吐 `{ text, finish, usage }`，并记录收到的 messages / budget），
// 恢复链的每个分支都能确定性地跑；messages / 修复请求 / 解析用的是 prompt.js 的**真实**实现，
// 不复制文案、不伪造解析结果。
//
// 断言口径（与 service 一致，见 docs/testing/next-step.md「生成编排契约测试」）：
// - 空输出 → 原样重发同一个请求，预算换成 `escalatedTokenBudget(base)`；
// - 修复请求必须带同一段对话，空输出才允许标「（空）」；
// - 失败时最后一次实际 finish / usage / budget 必须可拿来做诊断（`failureSummaryOf`）；
// - `detail` 保持 `json:empty`（报告分桶靠它，见 report.js），诊断数字只进日志。
import assert from "node:assert/strict";
import test from "node:test";

import { escalatedTokenBudget } from "../lib/generation-budget.js";
import {
  candidateRecoveryFields,
  countBudgetEscalation,
  failureDetailOf,
  failureSummaryOf,
  runWithRecovery,
} from "../lib/generation-recovery.js";
import { buildMessages, buildRepairMessage, parseSuggestion } from "../lib/prompt.js";

/** 设置里的默认输出预算（与 DEFAULT_SETTINGS.maxTokens 一致）。 */
const BASE = 2000;
/** 一段有唯一事实标记的对话，用来证明「重发/修复请求里仍然带着原料」。 */
const TRANSCRIPT = [
  "用户：改 importer/csv.ts 的流式读取，峰值内存能不能别顶到 1.8 GB",
  "助手：改完了：peak-mem 从 1.8 GB 降到 90 MB，补了 3 条边界用例。",
].join("\n\n");
const FACT_MARKER = "importer/csv.ts";

/** 一个能通过 `parseSuggestion` 的合法输出（与 prompt.test.js 的 fixture 同形）。 */
function validOutput() {
  return JSON.stringify({
    value: "must",
    reason: "改完还没跑验证。",
    summary: "改完 importer/csv.ts 的流式读取，peak-mem 从 1.8 GB 降到 90 MB。",
    question: "先跑 verify 还是先补边界用例？",
    options: [{ stance: "verify", label: "跑一遍 pnpm verify" }],
  });
}

/**
 * 脚本化 fake model：第 n 次调用吐 `steps[n]`，同时记录收到的 messages / budget。
 *
 * step 形状 `{ text?, finish?, usage? }`；给 `Error` 就抛（模拟超时/宿主错误）。
 * @param {Array<{ text?: string, finish?: string, usage?: any } | Error>} steps
 * @returns {{ calls: { messages: any[], budget: number }[], callModel: (messages: any[], budget: number) => Promise<{ text: string, finish: string, usage: any }> }}
 */
function scriptedModel(steps) {
  /** @type {{ messages: any[], budget: number }[]} */
  const calls = [];
  return {
    calls,
    async callModel(messages, budget) {
      calls.push({ messages, budget });
      const step = steps[calls.length - 1];
      if (step === undefined) throw new Error(`fake model 第 ${calls.length} 次调用没有脚本`);
      if (step instanceof Error) throw step;
      return {
        text: step.text ?? "",
        finish: step.finish ?? "stop",
        usage: step.usage ?? { outputTokens: 7 },
      };
    },
  };
}

/**
 * 跑一遍编排（真实 messages / 修复请求 / 解析，fake model 与 warn 注入）。
 * @param {Array<{ text?: string, finish?: string, usage?: any } | Error>} steps
 * @param {{ baseMaxTokens?: number }} [options]
 */
function runRecovery(steps, options = {}) {
  const fake = scriptedModel(steps);
  /** @type {string[]} */
  const warnings = [];
  const result = runWithRecovery({
    callModel: fake.callModel,
    messages: buildMessages({ transcript: TRANSCRIPT }),
    transcript: TRANSCRIPT,
    buildRepairMessages: buildRepairMessage,
    parse: parseSuggestion,
    baseMaxTokens: options.baseMaxTokens ?? BASE,
    warn: (message) => warnings.push(message),
  });
  return { fake, warnings, result };
}

/** @param {any} call */
function textOfCall(call) {
  return call.messages[0].content[0].text;
}

const ONE_EMPTY = { text: "", finish: "max-tokens", usage: { outputTokens: 500 } };
const STILL_EMPTY = { text: "", finish: "max-tokens", usage: { outputTokens: 3000 } };

test("一次成功：不恢复、不升级、只发一次请求（recovery=none）", async () => {
  const { fake, warnings, result } = runRecovery([{ text: validOutput() }]);
  const outcome = await result;
  assert.notEqual(outcome.parsed.suggestion, null, "合法 JSON 必须解析成功");
  assert.equal(outcome.recovery, "none");
  assert.equal(outcome.escalated, false);
  assert.equal(outcome.calls, 1);
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [BASE],
  );
  assert.equal(warnings.length, 0, "一次成功不该产生任何恢复日志");
});

test("首轮空输出 → 升级预算重发**同一个**请求 → 成功（recovery=retry）", async () => {
  const escalated = escalatedTokenBudget(BASE);
  assert.notEqual(escalated, BASE, "基线预算必须真的被升级（否则这条用例没意义）");
  const { fake, warnings, result } = runRecovery([
    ONE_EMPTY,
    { text: validOutput(), finish: "stop", usage: { outputTokens: 735 } },
  ]);
  const outcome = await result;

  assert.notEqual(outcome.parsed.suggestion, null, "升级后的合法输出必须解析成功");
  assert.equal(outcome.recovery, "retry", "空输出被预算升级救回来的路径是 retry");
  assert.equal(outcome.escalated, true);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [BASE, escalated],
    "预算序列：设置值 → escalatedTokenBudget(设置值)",
  );
  // 空输出不是格式问题：重发的必须是**同一个请求**（不是修复请求、更不是空字符串）
  assert.deepEqual(fake.calls[1].messages, fake.calls[0].messages, "升级重试必须原样重发同一请求");
  assert.equal(textOfCall(fake.calls[1]).includes(FACT_MARKER), true, "重发的请求仍然带着对话");
  assert.equal(outcome.lastFinish, "stop");
  assert.deepEqual(outcome.lastUsage, { outputTokens: 735 });
  assert.equal(outcome.lastBudget, escalated, "lastBudget 是最后一次**实际**预算");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /empty output/u);
  assert.match(warnings[0], /finish=max-tokens/u, "warn 带最后 finish");
  assert.match(warnings[0], /outputTokens=500/u, "warn 带最后 outputTokens");
  assert.match(
    warnings[0],
    new RegExp(`retrying with maxTokens=${escalated}`, "u"),
    "warn 写清升级后的预算",
  );
});

test("首轮空 → 升级后仍空 → 第三次带对话 JSON-only 修复 → 成功（recovery=repair，calls=3）", async () => {
  const escalated = escalatedTokenBudget(BASE);
  const { fake, warnings, result } = runRecovery([
    ONE_EMPTY,
    STILL_EMPTY,
    { text: validOutput(), finish: "stop" },
  ]);
  const outcome = await result;

  assert.notEqual(outcome.parsed.suggestion, null);
  assert.equal(outcome.recovery, "repair");
  assert.equal(outcome.escalated, true, "虽然最后一步是修复，升级确实发生过");
  assert.equal(outcome.calls, 3);
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [BASE, escalated, escalated],
    "修复调用沿用升级后的预算，不再回到设置值",
  );

  // 第三次请求：真实 buildRepairMessage —— 带同一段对话 + 「只输出修正后的 JSON 对象」
  const repairText = textOfCall(fake.calls[2]);
  assert.notDeepEqual(fake.calls[2].messages, fake.calls[1].messages, "修复请求不是重发原请求");
  assert.equal(repairText.includes(FACT_MARKER), true, "修复请求必须带同一段对话（ADR 0023）");
  assert.equal(repairText.includes("请只输出修正后的 JSON 对象"), true, "明确要求只输出 JSON");
  assert.equal(repairText.includes("（空）"), true, "两次都空，回贴的原文照实标「（空）」");

  assert.equal(warnings.length, 2, "第一次空输出 + 重试仍空，各一条 warn");
  assert.match(warnings[0], /retrying with maxTokens=/u);
  assert.match(warnings[1], /still empty/u);
  assert.match(warnings[1], /outputTokens=3000/u, "重试仍空的 warn 用最后一次的 usage");
  assert.match(warnings[1], /asking for JSON-only repair/u);
});

test("首轮非空但畸形 → 带对话修格式，**预算不升级**（recovery=repair，calls=2）", async () => {
  // 合法 JSON、但 options 一条可用的都没有 → problem.kind = "options"
  const malformed = JSON.stringify({
    value: "must",
    reason: "改完还没跑验证。",
    summary: "改完了",
    question: "下一步？",
  });
  const { fake, warnings, result } = runRecovery([{ text: malformed }, { text: validOutput() }]);
  const outcome = await result;

  assert.notEqual(outcome.parsed.suggestion, null);
  assert.equal(outcome.recovery, "repair");
  assert.equal(outcome.escalated, false, "有内容就不升级预算（升级只针对空输出）");
  assert.equal(outcome.calls, 2);
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [BASE, BASE],
    "修复请求的预算保持设置值",
  );
  const repairText = textOfCall(fake.calls[1]);
  assert.equal(repairText.includes(FACT_MARKER), true, "修复请求带同一段对话");
  assert.equal(repairText.includes(malformed), true, "同时回贴真实畸形输出");
  assert.match(warnings[0], /repairing with the transcript/u);
  assert.match(warnings[0], /options: options-missing/u, "warn 带出解析失败的具体 kind/detail");
});

test("升级后非空但畸形 → 修复请求回贴**真实畸形输出**（不是空串 /「（空）」）", async () => {
  const escalated = escalatedTokenBudget(BASE);
  // 非空、但缺 options：空输出已经过去，这一轮是「有内容但格式错」
  const malformed = JSON.stringify({
    value: "must",
    reason: "改完还没跑验证。",
    summary: "改完了",
    question: "下一步？",
  });
  const { fake, warnings, result } = runRecovery([
    ONE_EMPTY,
    { text: malformed, finish: "stop", usage: { outputTokens: 412 } },
    { text: validOutput(), finish: "stop" },
  ]);
  const outcome = await result;

  assert.notEqual(outcome.parsed.suggestion, null);
  assert.equal(outcome.recovery, "repair");
  assert.equal(outcome.escalated, true);
  assert.equal(outcome.calls, 3);
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [BASE, escalated, escalated],
  );

  const repairText = textOfCall(fake.calls[2]);
  assert.equal(repairText.includes(malformed), true, "必须回贴真实畸形输出，模型才知道改哪里");
  assert.equal(
    repairText.includes("（空）"),
    false,
    "畸形输出不是空输出：不许把原文替换成「（空）」",
  );
  // 问题描述用**重试那一次**的解析结果（options），不能沿用首轮的 json:empty 把人误导成「不是 JSON」
  assert.equal(repairText.includes("options 里没有一条可用的建议"), true);
  assert.match(warnings[1], /returned malformed output \(options: options-missing\)/u);
});

test("三次全败：不虚构卡片、detail 仍是 json:empty、诊断带最后实际预算/finish/outputTokens", async () => {
  const escalated = escalatedTokenBudget(BASE);
  const { fake, warnings, result } = runRecovery([
    ONE_EMPTY,
    STILL_EMPTY,
    { text: "", finish: "max-tokens", usage: { outputTokens: 3000 } },
  ]);
  const outcome = await result;

  assert.equal(outcome.parsed.suggestion, null, "全部失败不许返回任何 suggestion");
  assert.equal(outcome.recovery, "repair", "失败时 recovery 记最后尝试的那一步");
  assert.equal(outcome.calls, 3);
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [BASE, escalated, escalated],
  );
  // 用户可见 detail 保持旧口径：报告按 `json:empty` 分桶（report.js 的 schemaDetailBucket）
  assert.equal(failureDetailOf(outcome.parsed), "json:empty");
  // 日志诊断：最后一次**实际**补全的 finish / outputTokens / maxTokens
  assert.equal(
    failureSummaryOf(outcome),
    `finish=max-tokens outputTokens=3000 maxTokens=${escalated}`,
  );
  assert.equal(outcome.lastBudget, escalated, "lastBudget 是最后一次实际预算（可能 > 设置值）");
  // 编排内只有两条 warn（空输出→重试、仍空→修复）；「最终失败」那条由 service 用 failureSummaryOf
  // 拼出来（见下面的断言），不在这里重复发。
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /retrying with maxTokens=/u);
  assert.match(warnings[1], /asking for JSON-only repair/u);
});

test("预算不越上限：base=4000 时升级仍是 4000（不会变成 16000）", async () => {
  const { fake, result } = runRecovery([ONE_EMPTY, { text: validOutput() }], {
    baseMaxTokens: 4000,
  });
  const outcome = await result;
  assert.equal(outcome.recovery, "retry");
  assert.deepEqual(
    fake.calls.map((call) => call.budget),
    [4000, 4000],
    "escalatedTokenBudget 的上限是 4000，升级请求不许超",
  );
  assert.equal(outcome.lastBudget, 4000);
});

test("callModel 抛错（超时/取消/宿主 llm 失败）原样上抛，不重试、不吞错", async () => {
  const boom = Object.assign(new Error("model call was aborted"), { code: "ABORTED" });
  const { fake, result } = runRecovery([ONE_EMPTY, boom]);
  await assert.rejects(result, /model call was aborted/u);
  assert.equal(fake.calls.length, 2, "抛错就结束：不会再去发修复请求");
});

test("warn 缺失时不崩（编排只依赖 callModel/parse/buildRepairMessages）", async () => {
  const fake = scriptedModel([ONE_EMPTY, { text: validOutput() }]);
  const outcome = await runWithRecovery({
    callModel: fake.callModel,
    messages: buildMessages({ transcript: TRANSCRIPT }),
    transcript: TRANSCRIPT,
    buildRepairMessages: buildRepairMessage,
    parse: parseSuggestion,
    baseMaxTokens: BASE,
  });
  assert.equal(outcome.recovery, "retry");
  assert.equal(outcome.calls, 2);
});

test("countBudgetEscalation：每次 generate 最多 +1（升级后再修复也只算一次）", async () => {
  // 用真实结局驱动计数：升级后仍空再修复的那一轮，calls=3 但预算升级只发生一次口径。
  const { result } = runRecovery([ONE_EMPTY, STILL_EMPTY, { text: validOutput() }]);
  const outcome = await result;
  assert.equal(outcome.calls, 3);
  const counters = { budgetEscalations: 0 };
  assert.equal(countBudgetEscalation(counters, outcome), 1, "三次调用只记一次预算升级");
  assert.equal(counters.budgetEscalations, 1);

  // 没升级的回合不加；null / 脏 counters 不崩。
  assert.equal(countBudgetEscalation(counters, { escalated: false }), 1);
  assert.equal(countBudgetEscalation(counters, null), 1);
  assert.equal(countBudgetEscalation(null, { escalated: true }), 0);
  /** @type {any} */
  const dirty = {};
  assert.equal(countBudgetEscalation(dirty, { escalated: true }), 1, "脏 counters 从 0 起算");
  assert.equal(countBudgetEscalation(/** @type {any} */ ({}), { escalated: false }), 0);
});

test("candidateRecoveryFields：parse 口径不变，esc 只在真的升级过时出现（事件向后兼容）", () => {
  // 0.4.3 起的三种 parse 取值是报表分组口径，改名会让旧报表断档。
  assert.deepEqual(candidateRecoveryFields("none", false), { parse: "ok" });
  assert.deepEqual(candidateRecoveryFields("retry", true), { parse: "retried", esc: true });
  assert.deepEqual(candidateRecoveryFields("repair", false), { parse: "repaired" });
  // 升级后才修复：parse 仍是 repaired，但 esc 记下「这次多花了 token」
  assert.deepEqual(candidateRecoveryFields("repair", true), { parse: "repaired", esc: true });
  // 不升级就不许凭空出现 esc 键（旧报表的字段集合保持稳定）
  assert.equal("esc" in candidateRecoveryFields("none", false), false);
  assert.equal("esc" in candidateRecoveryFields("repair", false), false);
});

test("candidateRecoveryFields 与真实结局接线：三条路径的 cand 字段", async () => {
  const retried = await runRecovery([ONE_EMPTY, { text: validOutput() }]).result;
  const repairedOnly = await runRecovery([
    {
      text: JSON.stringify({ value: "must", reason: "x", summary: "改完了", question: "下一步？" }),
    },
    { text: validOutput() },
  ]).result;
  const repairedAfterEscalation = await runRecovery([
    ONE_EMPTY,
    STILL_EMPTY,
    { text: validOutput() },
  ]).result;
  assert.deepEqual(candidateRecoveryFields(retried.recovery, retried.escalated), {
    parse: "retried",
    esc: true,
  });
  assert.deepEqual(candidateRecoveryFields(repairedOnly.recovery, repairedOnly.escalated), {
    parse: "repaired",
  });
  assert.deepEqual(
    candidateRecoveryFields(repairedAfterEscalation.recovery, repairedAfterEscalation.escalated),
    { parse: "repaired", esc: true },
    "同样是 repaired，升级过的回合必须能从事件里区分出来",
  );
});

test("failureDetailOf：problem 缺失/不完整时归一成 unknown（旧 service 的 undefined:undefined 去掉）", () => {
  assert.equal(
    failureDetailOf({ problem: { kind: "json", detail: "empty" } }),
    "json:empty",
    "空输出的 detail 必须保持 json:empty",
  );
  assert.equal(
    failureDetailOf({ problem: { kind: "value", detail: "value-missing" } }),
    "value:value-missing",
  );
  assert.equal(failureDetailOf({ problem: null }), "unknown");
  assert.equal(failureDetailOf(null), "unknown");
  assert.equal(failureDetailOf({ problem: {} }), "unknown:unknown");
});

test("自定义 parse 报失败却没给 problem：不做恢复（与旧 service 的 problem !== null 条件一致）", async () => {
  const fake = scriptedModel([{ text: "not json" }]);
  const outcome = await runWithRecovery({
    callModel: fake.callModel,
    messages: buildMessages({ transcript: TRANSCRIPT }),
    transcript: TRANSCRIPT,
    buildRepairMessages: buildRepairMessage,
    parse: () => ({ suggestion: null, problem: null }),
    baseMaxTokens: BASE,
  });
  assert.equal(outcome.calls, 1);
  assert.equal(outcome.recovery, "none");
  assert.equal(outcome.escalated, false);
  assert.deepEqual(outcome.parsed, { suggestion: null, problem: null });
});
