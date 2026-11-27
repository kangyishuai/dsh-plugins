// @ts-check
// 决策日志：记录**每个回合**「有没有徵询、为什么没徵询、徵询后用户怎么反应」。
//
// 为什么单独一个文件而不是并进 usage.jsonl：用途不同。usage 是**钱的账本**（一次徵询一行，
// 有 token 与成本）；decisions 是**策略的证据**（一个回合一行，没有徵询的回合也要记），
// 用来事后回答「该徵询的时候有没有徵询」。两件事混在一起会让两边都难查。
//
// 落盘：`<dataRoot>/advisor/decisions.jsonl`。新行用单行 O_APPEND 追加（按文件串行写队列，
// 并发回合不会互相覆盖）；outcome 回填是「读-改-写整份」，但走唯一 tmp + rename 的原子重写，
// 并与追加共用同一个队列（审计 AUD-ADV-01）。超过上限（2 MiB）时滚动重命名保留一份历史。
import { join } from "node:path";

import { signalsOf } from "./adoption.js";
import { appendJsonLine, readJsonLines, serializeByPath, writeTextAtomic } from "./fs-atomic.js";
import { LEDGER_DIR } from "./ledger.js";
import { isInjectedContext, textOf, toolCallsOf } from "./transcript.js";

/** 决策日志文件名（与 usage.jsonl / advice.jsonl 同目录）。 */
export const DECISIONS_FILE = "decisions.jsonl";
/** 滚动阈值：与账本一致，超过就改名保留一份。 */
export const DECISIONS_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 没徵询时的原因码。**从主模型视角分类**，而不是按内部函数名：
 * 复盘时要回答的是「这一回合本该问吗」，所以分桶要能对应到「机会成本」。
 * @typedef {"skipped-disabled"|"skipped-not-configured"|"skipped-no-route"|"skipped-empty"|"skipped-budget"|"skipped-limit"|"skipped-immune"|"skipped-duplicate"|"skipped-needs-confirmation"|"skipped-not-requested"|"skipped-aborted"|"skipped-blocked"|"skipped-other"} SkipCode
 */

/** 原因文本 → 原因码。宿主侧的跳过原因是人话，这里用模式匹配归到稳定的小集合。 */
/** @type {Array<[RegExp, SkipCode]>} */
const SKIP_PATTERNS = [
  [/已关闭|disabled/iu, "skipped-disabled"],
  [/没配置|未配置|not.?configured/iu, "skipped-not-configured"],
  [/没有可用.*路由|no.?route/iu, "skipped-no-route"],
  [/还没有可发送|empty.?transcript/iu, "skipped-empty"],
  [/免疫窗口|immune/iu, "skipped-immune"],
  [/重复建议|duplicate/iu, "skipped-duplicate"],
  [/投递上限|会话上限|session.?cap/iu, "skipped-limit"],
  [/预算|额度|budget|quota/iu, "skipped-budget"],
  [/确认|confirm/iu, "skipped-needs-confirmation"],
  // finishTurn 在非正常结束时会写「回合被中断 / 被阻塞」，
  // 不加这两条就会归到 skipped-other（真实日志里踩到过）。
  [/中断|abort/iu, "skipped-aborted"],
  [/阻塞|blocked/iu, "skipped-blocked"],
];

/**
 * 把跳过原因归到稳定原因码。
 * @param {string} [reason] 宿主给的跳过原因（人话）
 * @returns {SkipCode}
 */
export function classifySkip(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text === "") return "skipped-not-requested";
  for (const [pattern, code] of SKIP_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return "skipped-other";
}

/**
 * 回合特征：用来给「该不该徵询」分桶的、可用不变量化的东西。
 * @param {{ answerChars?: number, toolCalls?: number, hadError?: boolean }} input
 * @returns {{ answerChars: number, toolCalls: number, hadError: boolean, longAnswer: boolean, usedTools: boolean }}
 */
export function turnFeatures(input) {
  const answerChars = Number.isFinite(input?.answerChars) ? Number(input.answerChars) : 0;
  const toolCalls = Number.isFinite(input?.toolCalls) ? Number(input.toolCalls) : 0;
  return {
    answerChars,
    toolCalls,
    hadError: input?.hadError === true,
    // 分桶阈值集中在这里，复盘脚本与日志用的是同一个口径。
    longAnswer: answerChars >= 800,
    usedTools: toolCalls > 0,
  };
}

/**
 * 组装一行决策记录。字段刻意保持扁平，方便 `jq` 直接查。
 * @param {{
 *   at?: string, sessionId: string, turn: number, endKind?: string,
 *   features?: { answerChars?: number, toolCalls?: number, hadError?: boolean },
 *   advice?: { adviceId?: string, severity?: string, trigger?: string, costUsd?: number },
 *   skipReason?: string,
 * }} input
 * @returns {any}
 */
export function buildDecision(input) {
  const advice = input.advice;
  const consulted = advice !== undefined && advice !== null;
  const endKind = input.endKind ?? "completed";
  // 结束原因本身就是最可靠的原因码来源；不要把它降级成「从人话里猜」。
  const endKindCode =
    endKind === "aborted" ? "skipped-aborted" : endKind === "blocked" ? "skipped-blocked" : null;
  return {
    at: input.at ?? new Date().toISOString(),
    sessionId: input.sessionId,
    turn: input.turn,
    endKind,
    consulted,
    // 没徵询时给出原因码，复盘时先看这一列。
    skipCode: consulted ? null : (endKindCode ?? classifySkip(input.skipReason)),
    skipReason: consulted ? null : (input.skipReason ?? ""),
    ...turnFeatures(input.features ?? {}),
    adviceId: advice?.adviceId ?? null,
    severity: advice?.severity ?? null,
    trigger: advice?.trigger ?? null,
    costUsd: typeof advice?.costUsd === "number" ? advice.costUsd : null,
    // 由下一回合回填：用户是照建议做了、还是自己另打了内容、还是什么都没做。
    outcome: null,
  };
}

/**
 * 判定上一回合建议的下场。**本函数只处理「下一条真人用户消息」这一种反应**：
 * 建议里出现过的可追踪信号（路径、反引号命令、证据 ref）命中就算 accepted，
 * 用户发了别的内容算 user-typed-other。`"no-action"` 不由本函数产出——
 * 它由回合跟踪器在「下个回合结束时仍没有任何真人反应」时回填（见 createDecisionTracker）。
 * @param {{ adviceText?: string, signals?: string[] }} advice
 * @param {string} nextUserText 下一回合用户输入
 * @returns {"accepted"|"user-typed-other"}
 */
export function outcomeOf(advice, nextUserText) {
  const text = typeof nextUserText === "string" ? nextUserText : "";
  if (text.trim() === "") return "user-typed-other";
  const signals = Array.isArray(advice?.signals) ? advice.signals : [];
  for (const signal of signals) {
    if (typeof signal === "string" && signal.length >= 3 && text.includes(signal))
      return "accepted";
  }
  // 没有信号可追踪时退化为「用户是否在说同一件事」：给不出结论就算另打字。
  return "user-typed-other";
}

/**
 * 在一段（已序列化的）事件载荷里找建议信号。
 * 与 `attributeAdoption` 的 `JSON.stringify(event.data)` 口径一致：工具参数、助手文本里
 * 出现建议提到的路径/命令/证据 ref，就算「主模型照着做了」（审计 AUD-ADV-07）。
 * @param {string} payload
 * @param {string[]} signals
 * @returns {string|null} 命中的信号；没有则 null
 */
export function matchSignalIn(payload, signals) {
  const text = typeof payload === "string" ? payload : "";
  if (text === "") return null;
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (typeof signal === "string" && signal.length >= 3 && text.includes(signal)) return signal;
  }
  return null;
}

/** 分桶键：把回合特征压成有限几个桶，复盘时直接出交叉表。 */
/** @param {any} record @returns {string} */
export function bucketOf(record) {
  const length = record?.longAnswer === true ? "长回答" : "短回答";
  const tools = record?.usedTools === true ? "有工具" : "无工具";
  const error = record?.hadError === true ? "有报错" : "无报错";
  return `${length}/${tools}/${error}`;
}

/**
 * 复盘统计。
 * @param {any[]} records
 * @returns {any}
 */
export function summarize(records) {
  const list = Array.isArray(records)
    ? records.filter((item) => item && typeof item === "object")
    : [];
  /** @type {Map<string, { turns: number, consulted: number, accepted: number, ignored: number, noAction: number }>} */
  const buckets = new Map();
  let consulted = 0;
  let accepted = 0;
  let ignored = 0;
  let noAction = 0;
  /** @type {Record<string, number>} */
  const skipCodes = {};
  const missed = [];
  const overConsulted = [];

  for (const record of list) {
    const bucket = bucketOf(record);
    const entry = buckets.get(bucket) ?? {
      turns: 0,
      consulted: 0,
      accepted: 0,
      ignored: 0,
      noAction: 0,
    };
    entry.turns += 1;
    if (record.consulted === true) {
      consulted += 1;
      entry.consulted += 1;
      if (record.outcome === "accepted") {
        accepted += 1;
        entry.accepted += 1;
      } else if (record.outcome === "user-typed-other") {
        ignored += 1;
        entry.ignored += 1;
        overConsulted.push(record);
      } else if (record.outcome === "no-action") {
        noAction += 1;
        entry.noAction += 1;
      }
    } else {
      const code = typeof record.skipCode === "string" ? record.skipCode : "skipped-other";
      skipCodes[code] = (skipCodes[code] ?? 0) + 1;
      // 疑似漏徵询：这一回合有工具、回答也不短，却没有徵询。
      if (record.usedTools === true && record.longAnswer === true && record.hadError !== true) {
        missed.push(record);
      }
    }
    buckets.set(bucket, entry);
  }

  const turns = list.length;
  const resolvedOutcomes = accepted + ignored + noAction;
  return {
    turns,
    consulted,
    consultRate: turns === 0 ? 0 : consulted / turns,
    accepted,
    ignored,
    noAction,
    // 采纳率只对「已经出结果」的徵询算，未回填的不进分母；但覆盖率要单独报，
    // 否则分母很小时「采纳率 0%」会被读成「建议从没被采纳」（审计 AUD-ADV-07）。
    acceptRate: accepted + ignored === 0 ? null : accepted / (accepted + ignored),
    resolvedOutcomes,
    pendingOutcomes: Math.max(0, consulted - resolvedOutcomes),
    outcomeCoverage: consulted === 0 ? null : resolvedOutcomes / consulted,
    skipCodes,
    buckets: [...buckets.entries()]
      .map(([bucket, value]) => ({ bucket, ...value }))
      .sort((a, b) => b.turns - a.turns),
    // 两类可疑样本：各留最近 5 条，够看模式就行。
    missed: missed.slice(-5),
    overConsulted: overConsulted.slice(-5),
  };
}

/**
 * 读决策日志（一行一条；坏行跳过，不让一行脏数据毁掉整份复盘）。
 * @param {string} path
 * @returns {Promise<any[]>}
 */
export function readDecisions(path) {
  return readJsonLines(path);
}

/**
 * 决策日志落盘器：只追加，超大时滚动。
 * @param {{ home: string, logger?: any }} options
 */
export function createDecisionLog(options) {
  const dir = join(options.home, LEDGER_DIR);
  const path = join(dir, DECISIONS_FILE);

  return {
    path,

    /**
     * 追加一行（O_APPEND 单写 + 进程内单写队列；不再读全文再覆盖，审计 AUD-ADV-01）。
     * @param {any} record
     * @returns {Promise<void>}
     */
    async append(record) {
      try {
        await appendJsonLine(path, record, {
          rotateBytes: DECISIONS_MAX_BYTES,
          rotateTo: `${path}.1`,
        });
      } catch (error) {
        options.logger?.warn?.(`[advisor] 写决策日志失败：${String(error)}`);
      }
    },

    /**
     * 回填上一回合的 outcome（改最后一条匹配记录）。
     *
     * 为什么这里仍是「读-改-写整份」而不是追加补丁行：`decisions.jsonl` 同时被
     * `pnpm advisor:review` 按「一行一条决策」直接读，补丁行会被它当成一个回合计入统计。
     * 重写只发生在回填（每次徵询最多一次），且与 append 共用同一个 per-path 队列 +
     * 唯一 tmp + rename，所以既不会丢追加，也不会留下半截文件。
     * @param {string} sessionId
     * @param {number} turn
     * @param {string} outcome
     * @param {string} [why] 归因依据（tool-call / assistant-message / user-message / no-follow-up）
     * @returns {Promise<boolean>} 是否真的改到了
     */
    async backfillOutcome(sessionId, turn, outcome, why = "") {
      try {
        return await serializeByPath(path, async () => {
          const records = await readDecisions(path);
          let changed = false;
          for (let index = records.length - 1; index >= 0; index -= 1) {
            const record = records[index];
            if (record?.sessionId === sessionId && record?.turn === turn) {
              if (record.outcome === outcome && (record.outcomeWhy ?? "") === why) return true;
              record.outcome = outcome;
              record.outcomeWhy = why;
              changed = true;
              break;
            }
          }
          if (!changed) return false;
          await writeTextAtomic(
            path,
            `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
          );
          return true;
        });
      } catch (error) {
        options.logger?.warn?.(`[advisor] 回填决策日志失败：${String(error)}`);
        return false;
      }
    },
  };
}

/**
 * 回合跟踪器：把「事件 → 回合特征 → 决策行 → outcome 回填」这条链路从 service 里拆出来，
 * 这样它可以脱离宿主包单独测试（service.js 依赖 @deepseek-ai/*，在单测环境里导入不了）。
 *
 * outcome 的三条路径（审计 AUD-ADV-07 / 09）：
 *   - accepted：后续**助手消息**或**工具调用参数**里出现建议信号，或下一条**真人**用户消息
 *     复述了信号。这是**启发式、无置信度区分**：路径 / 反引号命令 / 证据 ref 一视同仁，
 *     模型顺手复述同一条命令也可能被算成 accepted；若 `tools/execute` 的 `data` 含工具
 *     结果全文，读到的内容也可能被当成命中（`event.data` 形状待真机核实，复审 F6）。
 *   - user-typed-other：下一条真人用户消息没有命中任何信号；
 *   - no-action：下个回合结束时仍没有任何真人反应（目标自动继续等）。**会话结束时不会
 *     flush**：没有后续回合的 pending 会一直保持未回填，覆盖率里体现为 pending。
 * 宿主注入的 `user/message`（time-context / goal / runtime-context）不是用户反应，直接忽略。
 * post-answer / shadow 的建议在 `turn/end` 之后异步产生，`noteAdvice` 晚于该回合的
 * `finishTurn` → 记到**下一回合**的决策行、pending 也在下一回合才设置（复审 F7，既有错位，
 * 本批只记录不改；见 docs/testing/advisor.md）。
 * @param {{ log: ReturnType<typeof createDecisionLog>, now?: () => number }} options
 */
export function createDecisionTracker(options) {
  const log = options.log;
  /** @type {Map<string, { turn: number, answerChars: number, toolCalls: number, hadError: boolean }>} */
  const stats = new Map();
  /** @type {Map<string, any>} */
  const advice = new Map();
  /** @type {Map<string, { turn: number, signals: string[] }>} */
  const pending = new Map();

  /**
   * 后续事件里出现建议信号 → 回填 accepted。
   * @param {string} sessionId
   * @param {any} event
   * @param {string} why assistant-message | tool-call
   * @returns {{ turn: number, outcome: string } | null}
   */
  const claimFromEvent = (sessionId, event, why) => {
    const waiting = pending.get(sessionId);
    if (waiting === undefined) return null;
    const hit = matchSignalIn(JSON.stringify(event?.data ?? ""), waiting.signals);
    if (hit === null) return null;
    pending.delete(sessionId);
    void log.backfillOutcome(sessionId, waiting.turn, "accepted", why);
    return { turn: waiting.turn, outcome: "accepted" };
  };

  return {
    /**
     * 回合开始：重置本回合统计。
     * @param {string} sessionId
     * @param {number} turn
     */
    startTurn(sessionId, turn) {
      stats.set(sessionId, { turn, answerChars: 0, toolCalls: 0, hadError: false });
    },

    /**
     * 本回合确实徵询过时调用（由 runAdvisor 写入）。
     * @param {string} sessionId
     * @param {any} value
     */
    noteAdvice(sessionId, value) {
      advice.set(sessionId, value);
    },

    /**
     * 累计事件特征；并在后续事件里找建议信号回填 accepted。
     * @param {string} sessionId
     * @param {any} event
     * @returns {{ backfilled: { turn: number, outcome: string } | null }}
     */
    track(sessionId, event) {
      const type = event?.type;
      if (type === "assistant/message") {
        const message = event?.data?.message ?? event?.data;
        const current = stats.get(sessionId);
        if (current) {
          current.answerChars += textOf(message).length;
          current.toolCalls += toolCallsOf(message).length;
        }
        return { backfilled: claimFromEvent(sessionId, event, "assistant-message") };
      }
      if (type === "tools/execute") {
        const current = stats.get(sessionId);
        if (current) current.toolCalls += 1;
        return { backfilled: claimFromEvent(sessionId, event, "tool-call") };
      }
      if (type === "agent/error" || type === "agent/request-error") {
        const current = stats.get(sessionId);
        if (current) current.hadError = true;
        return { backfilled: null };
      }
      if (type !== "user/message") return { backfilled: null };

      const message = event?.data?.message ?? event?.data;
      // 注入的上下文不是真人反应：既不能算 accepted，也不能算 user-typed-other。
      if (isInjectedContext(message)) return { backfilled: null };
      const waiting = pending.get(sessionId);
      if (waiting === undefined) return { backfilled: null };
      const text = textOf(message);
      if (text === "") return { backfilled: null };
      pending.delete(sessionId);
      const outcome = outcomeOf({ signals: waiting.signals }, text);
      void log.backfillOutcome(sessionId, waiting.turn, outcome, "user-message");
      return { backfilled: { turn: waiting.turn, outcome } };
    },

    /**
     * 回合结束：写一行决策。
     * @param {{ sessionId: string, turn: number, endKind?: string, skipReason?: string, fallbackReason?: string }} input
     * @returns {Promise<any>} 写下的记录
     */
    async finishTurn(input) {
      const current = stats.get(input.sessionId);
      const turn =
        typeof current?.turn === "number" && Number.isFinite(current.turn)
          ? current.turn
          : input.turn;
      const usedAdvice = advice.get(input.sessionId);
      advice.delete(input.sessionId);
      const endKind = input.endKind ?? "completed";
      const record = buildDecision({
        sessionId: input.sessionId,
        turn,
        endKind,
        features: {
          answerChars: current?.answerChars ?? 0,
          toolCalls: current?.toolCalls ?? 0,
          hadError:
            current?.hadError === true || (endKind !== "completed" && endKind !== "aborted"),
        },
        advice: usedAdvice,
        // 非正常结束优先记结束原因，比「还没请示顾问」更有信息量。
        skipReason:
          endKind === "aborted"
            ? "回合被中断"
            : endKind === "blocked"
              ? "回合被阻塞"
              : (input.skipReason ?? input.fallbackReason),
      });
      // 上一回合的建议等到这个回合结束都没有真人反应 → no-action（该分支以前不可达）。
      const stale = pending.get(input.sessionId);
      if (stale !== undefined) {
        pending.delete(input.sessionId);
        await log.backfillOutcome(input.sessionId, stale.turn, "no-action", "no-follow-up");
      }
      if (record.consulted && usedAdvice?.adviceText) {
        pending.set(input.sessionId, {
          turn,
          signals: signalsOf({ advice: usedAdvice.adviceText, evidence: usedAdvice.evidence }),
        });
      }
      await log.append(record);
      return record;
    },
  };
}
