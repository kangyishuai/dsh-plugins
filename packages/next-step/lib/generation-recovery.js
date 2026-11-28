// @ts-check
// 生成编排（host-free、可注入 `callModel`）：首次调用 → 空输出升级预算重试 → 带对话的 JSON-only 修复。
//
// 为什么从 `service.js` 抽出来（2026-11-28）：这段状态机原来写在 `generate()` 里，而 `service.js`
// import 宿主的 `@deepseek-ai/*`，`node --test` 加载不了 —— 恢复路径的分支组合（升级后成功 / 升级后
// 仍空再修复 / 首轮畸形直接修复 / 升级后畸形按真实输出修复 / 三次全败）只能靠真机碰运气。把
// 「什么时候再发一次、发给模型的是什么、预算用哪个」抽成只依赖注入函数的纯编排后，
// `test/generation-recovery.test.js` 用脚本化 fake model 逐条钉住，service 只剩接线。
//
// 语义与 0.5.2 一致（见 docs/adr/0023 与 docs/testing/next-step.md「空输出预算升级」）：
// - **空输出不是格式问题**：原样重发同一个 `messages`，只把输出预算换成
//   `escalatedTokenBudget(base)`（推理模型会把预算全用在推理块上，finish=max-tokens、text="");
// - **非空畸形才「修格式」**：修复请求由调用方注入的 `buildRepairMessages` 构造，生产实现是
//   `prompt.js` 的 `buildRepairMessage`——它一定带同一段对话（丢对话就是历史 95 条垃圾卡的根因）；
// - **恢复最多两轮**：先升级预算重试一次，仍失败才修复一次；预算升级不重复升级；
// - 失败时保留**最后一次实际**的 finish / usage / budget，供 service 写诊断（warn / lastError）。
//
// 这个模块不读设置、不写会话、不调宿主：所有副作用都通过 `callModel` / `warn` 注入。

import { emptyOutputSummary, recoveryFor } from "./generation-budget.js";

/**
 * 一次补全的返回：适配器把宿主 stream 归约成文本 + 结束原因 + usage。
 *
 * `budget` 可选，但**建议**回报实际值：provider 不支持 `reasoningEffort=off` 时适配器会把预算
 * 抬高（`Math.min(4000, Math.max(budget, 2000))`），只回报请求值会让失败诊断写成设置里的数字。
 * @typedef {object} ModelCallResult
 * @property {string} text 文本块拼起来的输出（空串 = 空输出）
 * @property {string | null} [finish] 结束原因（`stop` / `max-tokens` / `aborted` …）
 * @property {any} [usage] usage chunk（`outputTokens` 用于空输出诊断）
 * @property {number} [budget] 这一次**实际**使用的输出预算
 */

/**
 * 发一次补全。真实实现走 `llm.prepareCall` + `stream`（service.js 里的 `run`），
 * 测试用脚本化 fake（见 `test/generation-recovery.test.js`）。抛错原样上抛（超时/取消靠它传播）。
 * @typedef {(messages: any[], budget: number) => Promise<ModelCallResult>} CallModel
 */

/**
 * 构造修复请求的 messages（生产 = `prompt.js` 的 `buildRepairMessage`）。
 * @typedef {(input: { transcript: string, raw: unknown, problem: any, detail?: unknown }) => any[]} BuildRepairMessages
 */

/**
 * 宽容解析（生产 = `prompt.js` 的 `parseSuggestion`）。
 * @typedef {(raw: unknown) => { suggestion: any, problem: { kind: string, detail: string } | null, detail?: string }} Parse
 */

/**
 * @typedef {object} RunWithRecoveryInput
 * @property {CallModel} callModel 发一次补全（外部注入）
 * @property {any[]} messages 首次请求的 messages（升级重试**原样重发**这一条）
 * @property {string} [transcript] 同一段对话（拼给 `buildRepairMessages` 用）
 * @property {BuildRepairMessages} buildRepairMessages 构造修复请求
 * @property {Parse} parse 解析模型输出
 * @property {number} baseMaxTokens 设置里的输出预算（升级策略的起点）
 * @property {(message: string) => void} [warn] 诊断日志出口（失败路径不静默）
 * @property {() => void} [onEscalate] 真正发升级预算请求**之前**回调（诊断计数用；这样中途超时/取消也算一次升级）
 */

/**
 * @typedef {object} RunWithRecoveryOutcome
 * @property {string} raw 最后一次补全的文本
 * @property {ReturnType<Parse>} parsed 最后一次解析结果（失败时 `suggestion === null`）
 * @property {"none" | "retry" | "repair"} recovery 实际走的路径：一次成功 / 升级后成功 / 到了修复那一步
 * @property {boolean} escalated 是否真的用**升级后的预算**发过请求（诊断计数器只看这个）
 * @property {string | null} lastFinish 最后一次补全的 finish
 * @property {any} lastUsage 最后一次补全的 usage
 * @property {number} lastBudget 最后一次补全实际使用的预算（可能高于设置值）
 * @property {number} calls 实际发起的补全次数（1–3）
 */

/** 设置不可用时的兜底预算（与 `recoveryFor` 的口径一致）。 */
const FALLBACK_BASE_TOKENS = 500;

/**
 * 解析失败 → service 写进 `lastError` / error 事件的 detail（报告按它分桶，见 `report.js` 的
 * `schemaDetailBucket`）。空输出固定是 `json:empty`，**不要**在这里附加诊断信息：
 * 用户可见 detail 保持旧口径，finish/usage/预算只进日志。
 * @param {{ problem?: { kind?: unknown, detail?: unknown } | null } | null | undefined} parsed
 * @returns {string}
 */
export function failureDetailOf(parsed) {
  const problem = parsed?.problem ?? null;
  if (problem === null || typeof problem !== "object") return "unknown";
  const kind = typeof problem.kind === "string" && problem.kind !== "" ? problem.kind : "unknown";
  const detail =
    typeof problem.detail === "string" && problem.detail !== "" ? problem.detail : "unknown";
  return `${kind}:${detail}`;
}

/**
 * 失败诊断摘要（只进 warn，不进用户可见 detail）：最后一次**实际**补全的 finish / outputTokens / 预算。
 * @param {RunWithRecoveryOutcome | null | undefined} outcome
 * @returns {string}
 */
export function failureSummaryOf(outcome) {
  return emptyOutputSummary({
    finish: outcome?.lastFinish,
    usage: outcome?.lastUsage,
    budget: outcome?.lastBudget,
  });
}

/**
 * 恢复结局 → turn 事件 `cand` 里与恢复相关的字段（`parse` + 可选 `esc`）。
 *
 * `parse` 的三种取值是 0.4.3 起的复盘口径（`ok` / `retried` / `repaired`），报表按它分组对比，
 * **不要改名**；`esc: true` 是 2026-11-28 新加的**增量**布尔：`parse:"retried"` 本身已隐含升级，
 * 但 `parse:"repaired"` 分不出「首轮畸形直接修」与「升级后仍空再修」。只在真的升级过时才写这个键，
 * 旧报表只读已知字段，不受影响。
 * @param {"none" | "retry" | "repair"} recovery
 * @param {boolean} escalated
 * @returns {{ parse: "ok" | "retried" | "repaired", esc?: true }}
 */
export function candidateRecoveryFields(recovery, escalated) {
  const parse = recovery === "retry" ? "retried" : recovery === "repair" ? "repaired" : "ok";
  return escalated === true ? { parse, esc: true } : { parse };
}

/**
 * 把一次恢复结局计入诊断计数器（`counters.budgetEscalations`）。
 *
 * 口径（为什么要单独一个函数）：**每次 generate 最多 +1**，不是「升级调用了几次」——
 * 升级后仍空再修复的那一轮也仍然只算一次预算升级，否则诊断里的数字会大于实际受影响的回合数。
 * 就地 +1 后返回新值（便于日志/测试断言）。
 * @param {any} counters service 的 counters（可变对象）
 * @param {{ escalated?: boolean } | null | undefined} outcome `runWithRecovery` 的返回值
 * @returns {number} 计入后的 `budgetEscalations`
 */
export function countBudgetEscalation(counters, outcome) {
  if (counters === null || typeof counters !== "object") return 0;
  const current = Number(counters.budgetEscalations);
  counters.budgetEscalations = Number.isFinite(current) && current > 0 ? Math.round(current) : 0;
  if (outcome?.escalated === true) counters.budgetEscalations += 1;
  return counters.budgetEscalations;
}

/**
 * 跑完整条恢复链：首次 → （空输出）升级预算重试 → （仍失败）带对话的 JSON-only 修复。
 *
 * 逐条对应 service 0.5.2 的行为（日志文案也保持一致，便于对照历史事件）：
 * 1. 首次失败且输出为**空**（trim 后）→ warn 一条带 finish/outputTokens/预算的摘要，
 *    用 `escalatedTokenBudget` 重发**同一个** `messages`；
 * 2. 重试成功 → `recovery:"retry"`；重试仍空 → 用 `raw:""` 的修复请求（要求只输出 JSON）；
 *    重试非空但畸形 → 用**真实畸形输出**构造修复请求（不许丢掉模型写的内容，也不许写成「（空）」）；
 * 3. 首次失败但输出非空 → 带对话修格式一次，预算不变（`recovery:"repair"`，`escalated:false`）。
 *
 * 任何一次 `callModel` 抛错（超时/取消/宿主 llm 错误）原样上抛：中止的归类是 service 的事，
 * 这里不吞错、不重试。
 * @param {RunWithRecoveryInput} input
 * @returns {Promise<RunWithRecoveryOutcome>}
 */
export async function runWithRecovery(input) {
  const callModel = input.callModel;
  const parse = input.parse;
  const buildRepairMessages = input.buildRepairMessages;
  const warn = typeof input.warn === "function" ? input.warn : () => {};
  const transcript = typeof input.transcript === "string" ? input.transcript : "";
  const baseRaw = Number(input.baseMaxTokens);
  const base = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.round(baseRaw) : FALLBACK_BASE_TOKENS;

  let calls = 0;
  /** @type {string | null} */
  let lastFinish = null;
  /** @type {any} */
  let lastUsage = null;
  let lastBudget = base;

  /**
   * @param {any[]} messages
   * @param {number} budget
   * @returns {Promise<{ raw: string, parsed: ReturnType<Parse> }>}
   */
  const call = async (messages, budget) => {
    calls += 1;
    lastBudget = budget;
    const result = await callModel(messages, budget);
    const text = typeof result?.text === "string" ? result.text : "";
    lastFinish = typeof result?.finish === "string" ? result.finish : null;
    lastUsage = result?.usage ?? null;
    const actual = Number(result?.budget);
    if (Number.isFinite(actual) && actual > 0) lastBudget = Math.round(actual);
    return { raw: text, parsed: parse(text) };
  };

  /**
   * @param {"none" | "retry" | "repair"} recovery
   * @param {boolean} escalated
   * @param {{ raw: string, parsed: ReturnType<Parse> }} state
   * @returns {RunWithRecoveryOutcome}
   */
  const outcomeOf = (recovery, escalated, state) => ({
    raw: state.raw,
    parsed: state.parsed,
    recovery,
    escalated,
    lastFinish,
    lastUsage,
    lastBudget,
    calls,
  });

  /** @param {{ suggestion?: unknown } | null | undefined} parsed */
  const parsedOk = (parsed) => parsed !== null && parsed !== undefined && parsed.suggestion != null;

  let state = await call(input.messages, base);
  if (parsedOk(state.parsed)) return outcomeOf("none", false, state);

  const problem = state.parsed?.problem ?? null;
  if (problem === null) {
    // 防御：自定义 parse 报「失败」却没给 problem。与旧 service 的 `problem !== null` 条件一致，
    // 不做恢复，交给调用方按 `failureDetailOf` 的 unknown 处理。
    return outcomeOf("none", false, state);
  }

  const plan = recoveryFor({ raw: state.raw, baseMaxTokens: base, problem });

  if (plan.plan === "escalate") {
    // 预算没变（例如设置已是上限 4000）时不算「升级」：仍重试，但不计 esc、不写升级计数。
    const escalated = plan.budget > base;
    if (escalated) input.onEscalate?.();
    // 空输出：先解释清楚为什么重试，再**原样重发**（请求体一个字都不改，只换预算）。
    warn(
      `model output did not match the card schema (${problem.kind}: ${problem.detail}), empty output (${emptyOutputSummary(
        { finish: lastFinish, usage: lastUsage, budget: base },
      )}), retrying with maxTokens=${plan.budget}${escalated ? "" : " (already at cap)"}`,
    );
    state = await call(input.messages, plan.budget);
    if (parsedOk(state.parsed)) return outcomeOf("retry", escalated, state);

    const retryProblem = state.parsed?.problem ?? null;
    if (state.raw.trim() === "") {
      warn(
        `retry with maxTokens=${plan.budget} still empty (${emptyOutputSummary({
          finish: lastFinish,
          usage: lastUsage,
          budget: plan.budget,
        })}), asking for JSON-only repair`,
      );
      state = await call(
        buildRepairMessages({ transcript, raw: "", problem: "json", detail: "empty output" }),
        plan.budget,
      );
      return outcomeOf("repair", escalated, state);
    }
    // 重试回来有内容但格式错：按**真实输出**修格式（问题描述也用这一次的解析结果，
    // 不能用首轮那条 json:empty —— 那会把「value 不合法」误导成「不是 JSON」）。
    const kind = retryProblem?.kind ?? problem.kind;
    const detail = retryProblem?.detail ?? problem.detail;
    warn(
      `retry with maxTokens=${plan.budget} returned malformed output (${kind}: ${detail}), repairing with the transcript`,
    );
    state = await call(
      buildRepairMessages({ transcript, raw: state.raw, problem: kind, detail }),
      plan.budget,
    );
    return outcomeOf("repair", escalated, state);
  }

  // 有内容但格式不对：带同一段对话再要一次，只要求它修格式，预算保持设置值。
  warn(
    `model output did not match the card schema (${problem.kind}: ${problem.detail}), repairing with the transcript`,
  );
  state = await call(
    buildRepairMessages({
      transcript,
      raw: state.raw,
      problem: problem.kind,
      detail: problem.detail,
    }),
    plan.budget,
  );
  return outcomeOf("repair", false, state);
}
