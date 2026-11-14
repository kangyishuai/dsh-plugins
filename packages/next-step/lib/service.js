// @ts-check
// host 半：服务名 nextStep。
//
// 职责：一轮正常结束 → 一次额外模型调用 → 把「决策卡」写进会话日志（plugin record）；
// 客户端通过投影读卡片、通过 Remote 写决策。状态全部属于会话数据，刷新/切会话/fork 后都能重建。
//
// v0.4 的三处结构性变化（见 docs/adr/0013）：
// 1. 判定语言是三档（must / could / no），**档位在写卡时决定 `shown`**；被抑制的候选照样落库，
//    用户点「生成下一步建议」时优先**揭示**它（不重新生成）。
// 2. 采集：每个合格回合写一条 turn 事件（无论出没出卡），加上 action / followup / impression /
//    promote / error。事件落在 `<dataRoot>/next-step/events.jsonl`，不写进会话日志。
// 3. 宽容解析 + 一次修复调用：格式问题不再让整张卡消失。
//
// 说明：插件可以 import 宿主的 @deepseek-ai/* 包（运行时由宿主解析），但不能把它们写进
// package.json 的 dependencies —— `pnpm check` 会拦（AGENTS.md 硬性约定 3）。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { abortReasonOf, abortReasonText, abortSkipKind, TIMEOUT_MESSAGE } from "./abort-reason.js";
import { buildIdentity } from "./build-info.js";
import {
  CARD_RECORD,
  DECISION_RECORD,
  isCardData,
  isCardDataV2,
  REVEAL_RECORD,
  readCard,
  resolveVisibility,
} from "./card-data.js";
import {
  actionEvent,
  createEventLog,
  errorEvent,
  eventsDirOf,
  eventsPathOf,
  followupEvent,
  impressionEvent,
  promoteEvent,
  sidOf,
  turnEvent,
} from "./events.js";
import { cheapSkipReason } from "./gates.js";
import { nextStepProjection } from "./projection.js";
import {
  buildMessages,
  buildRepairMessage,
  buildSystemPrompt,
  concreteTokens,
  parseSuggestion,
  renderTranscript,
  textOf,
} from "./prompt.js";
import { shouldSkipForQueue } from "./queue-gate.js";
import { parseEvents, renderMarkdown, summarize, verdicts, writeReport } from "./report.js";
import { PROMPT_VERSION, SCHEME, shouldShow } from "./scheme.js";
import { DEFAULT_SETTINGS, loadSettingsWithMeta, saveSettings } from "./settings.js";

/**
 * 与 session-rewind 相同的原因：运行时不支持装饰器语法时，用命令式方式登记 Remote 方法。
 * @param {any} Proto 承载方法的类
 * @param {string} method 方法名，同时也是线缆上的 export 名
 * @returns {void}
 */
function declareRemote(Proto, method) {
  /** @type {Function[]} */
  const initializers = [];
  Remote(method)(void 0, {
    name: method,
    static: false,
    private: false,
    addInitializer(/** @type {Function} */ initializer) {
      initializers.push(initializer);
    },
  });
  if (initializers.length !== 1) {
    throw new Error(`next-step: cannot declare Remote method ${method}`);
  }
  initializers[0].call(Object.create(Proto.prototype));
}

/**
 * 数据根：config.dataRoot > $DSH_HOME > ~/.dsh。
 * @param {any} config
 * @returns {string}
 */
export function resolveDataRoot(config) {
  if (config && typeof config.dataRoot === "string" && config.dataRoot.trim() !== "") {
    return config.dataRoot;
  }
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".dsh");
}

/**
 * 安全取宿主服务。
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get === "function") return ctx.get(name);
  } catch (_error) {
    return undefined;
  }
  try {
    return ctx?.[name];
  } catch (_error) {
    return undefined;
  }
}

/** @param {unknown} error @returns {never} */
function rethrowRemote(error) {
  if (error instanceof RemoteError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new RemoteError("next-step/failed", message);
}

/**
 * 是否子代理会话（子代理不生成决策卡）。
 * @param {any} session
 * @returns {boolean}
 */
function isSubagentSession(session) {
  const header = session?.header;
  if (!header || typeof header !== "object") return false;
  return (
    header.origin === "subagent" ||
    (typeof header.delegationDepth === "number" && header.delegationDepth > 0)
  );
}

/**
 * 读「用户已排队」的消息条数：next-turn + next-step。
 * 读不到就返回 0（宁可不拦，也不因为宿主形状变化误杀）。
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {number}
 */
function queuedCountOf(ctx, sessionId) {
  const inbox = serviceOf(ctx, "agents")?.get?.(sessionId)?.inbox;
  if (inbox === undefined || inbox === null) return 0;
  let count = 0;
  try {
    const nextStep = inbox.nextStep;
    const nextTurn = inbox.nextTurn;
    if (Array.isArray(nextStep)) count += nextStep.length;
    if (Array.isArray(nextTurn)) count += nextTurn.length;
  } catch (_error) {
    return 0;
  }
  return count;
}

/**
 * 读会话日志里的卡片、决策与揭示记录（全量，用于预算与去重；渲染走投影，不读这里）。
 * 卡片一律经 `readCard` 归一化（旧记录补 value/shown/tier/promptVersion 默认值）。
 * @param {any} session
 * @returns {{ cards: Map<number, any>, decisions: Map<number, any>, reveals: Map<number, true> }}
 */
function scanSession(session) {
  /** @type {Map<number, any>} */
  const cards = new Map();
  /** @type {Map<number, any>} */
  const decisions = new Map();
  /** @type {Map<number, true>} */
  const reveals = new Map();
  let events = [];
  if (typeof session?.snapshotEvents === "function") events = session.snapshotEvents();
  else if (Array.isArray(session?.log)) events = session.log;
  for (const event of Array.isArray(events) ? events : []) {
    const record = pluginRecordOf(event);
    if (record === undefined) continue;
    if (record.type === CARD_RECORD && isCardData(record.data)) {
      if (!cards.has(record.data.turn)) cards.set(record.data.turn, readCard(record.data));
    } else if (record.type === DECISION_RECORD && Number.isSafeInteger(record.data?.turn)) {
      if (!decisions.has(record.data.turn)) decisions.set(record.data.turn, record.data);
    } else if (record.type === REVEAL_RECORD && Number.isSafeInteger(record.data?.turn)) {
      reveals.set(record.data.turn, true);
    }
  }
  return { cards, decisions, reveals };
}

/**
 * 最近一个正常结束的回合（手动补生成用）。
 * @param {any} session
 * @returns {{ turn: number, seq: number } | undefined}
 */
function latestCompletedTurn(session) {
  let events = [];
  if (typeof session?.snapshotEvents === "function") events = session.snapshotEvents();
  else if (Array.isArray(session?.log)) events = session.log;
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type !== "turn/end") continue;
    if (event?.data?.reason?.kind !== "completed") continue;
    if (!Number.isSafeInteger(event?.data?.turn)) continue;
    return {
      turn: event.data.turn,
      seq: Number.isSafeInteger(event?.seq) ? event.seq : 0,
    };
  }
  return undefined;
}

/**
 * 本轮「回答量」的口径：最后一条 user 消息之后的 assistant 消息，累加文本字数与工具调用数。
 * 短答闸要用它——工具密集型回合的收尾回答往往只有一句（「改好了」），但上下文一点都不缺。
 * @param {any} session
 * @returns {{ answerChars: number, toolCalls: number }}
 */
function answerStatsOf(session) {
  const messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : [];
  const list = Array.isArray(messages) ? messages : [];
  let start = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      start = index + 1;
      break;
    }
  }
  let answerChars = 0;
  let toolCalls = 0;
  for (let index = start; index < list.length; index += 1) {
    const message = list[index];
    if (message?.role !== "assistant") continue;
    answerChars += textOf(message).length;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "tool-call") toolCalls += 1;
    }
  }
  return { answerChars, toolCalls };
}

/**
 * 卡片条数 → 其中"出过"的（预算闸只统计它们；被档位抑制的候选不占预算）。
 * @param {Map<number, any>} cards
 * @returns {number}
 */
function shownCountOf(cards) {
  let count = 0;
  for (const card of cards.values()) {
    if (card.shown === true) count += 1;
  }
  return count;
}

/** 目标：一次短补全。 */
export class NextStepService extends TypertRemoteService {
  /**
   * @param {any} ctx host 上下文
   * @param {any} [config] 插件配置
   */
  constructor(ctx, config) {
    super(ctx, "nextStep");
    this.config = config ?? {};
    this.logger = ctx?.logger ?? console;
    this.dataRoot = resolveDataRoot(this.config);
    /**
     * @type {{
     *   generated: number, hidden: number, failed: number, aborted: number,
     *   skipped: number, acted: number, dismissed: number, revealed: number, impressions: number,
     * }}
     */
    this.counters = {
      generated: 0,
      // 生成成功但被档位抑制（没有显示）的回合数
      hidden: 0,
      failed: 0,
      // 生成被中止（超时/取消）。单独计数：中止既不写会话日志、原来也不计数，
      // 导致「卡片没出来」在诊断里完全无痕（见 abort-reason.js 的说明）。
      aborted: 0,
      skipped: 0,
      acted: 0,
      dismissed: 0,
      revealed: 0,
      impressions: 0,
    };
    /** 最近一次失败原因（诊断面板用）。 */
    this.lastError = "";
    /**
     * 最近一次「这一轮没出卡」的原因——「我觉得该出卡却没出」时，先看这里。
     * kind: paused | queued | budget | turn-error | short-answer | model | failed | timeout | cancelled
     * @type {{ kind: string, reason: string, at: number } | null}
     */
    this.lastSkip = null;
    /** 每会话在途生成（abort 用）。 @type {Map<string, AbortController>} */
    this.inflight = new Map();
    /** 设置缓存（1s TTL），使「改文件即生效」成立又不必每次读盘。 */
    this.settingsCache = { at: 0, value: /** @type {any} */ (null) };
    /** 事件日志（惰性创建：需要知道包版本）。 @type {any} */
    this.eventLogHandle = null;
    /** 待追踪的卡片（下一次用户消息到来时写 followup）。 @type {Map<string, { turn: number, labels: string[], at: number }>} */
    this.pendingFollowup = new Map();
    /** 已记录的曝光（sid:turn），宿主侧去重。 @type {Set<string>} */
    this.impressionsSeen = new Set();
    this.installProjection();
    this.installListener();
  }

  /** 注册会话投影（失败只降级：卡片仍落库，只是界面读不到）。 */
  installProjection() {
    try {
      this.ctx.inject?.(/** @type {any} */ (["sessionProjections"]), (/** @type {any} */ scope) => {
        scope.effect(() => {
          const dispose = scope.sessionProjections.register(nextStepProjection());
          return () => {
            if (typeof dispose === "function") dispose();
          };
        }, "next-step: projection");
      });
    } catch (error) {
      this.warn("cannot install session projection", error);
    }
  }

  /** 监听回合结束与用户消息（后者用于隐式的「用户自己打了下一条」信号）。 */
  installListener() {
    try {
      this.ctx.on("session/event", (/** @type {any} */ session, /** @type {any} */ event) => {
        try {
          this.handleSessionEvent(session, event);
        } catch (error) {
          this.warn("session/event handler failed", error);
        }
      });
    } catch (error) {
      this.warn("cannot subscribe to session/event", error);
    }
  }

  /**
   * @param {any} session
   * @param {any} event
   */
  handleSessionEvent(session, event) {
    if (typeof session?.id !== "string") return;
    // 新一轮一旦开始，上一轮的生成就没有意义了（省一次请求、也避免把过期卡写进日志）。
    if (event?.type === "turn/start") {
      this.abortInflight(session.id);
      this.closeFollowup(session.id, { typed: false });
      return;
    }
    if (event?.type === "user/message") {
      this.handleUserMessage(session, event);
      return;
    }
    if (event?.type !== "turn/end") return;
    if (event?.data?.reason?.kind !== "completed") return;
    const turn = event?.data?.turn;
    if (!Number.isSafeInteger(turn)) return;
    if (isSubagentSession(session)) return;
    // 不阻塞事件分发：生成是异步的，失败静默。
    void this.maybeGenerate(session, turn, event);
  }

  /**
   * 用户发了一条消息 → 如果上一张卡还没被追踪过，写一条 followup（隐式负反馈）。
   * 注意：我们自己点击胶囊发出的消息也走这里（source.kind 为 user），这时 action 已经记过，
   * followup 仍然记——它能回答「点了之后是不是又反悔」。
   * @param {any} session
   * @param {any} event
   */
  handleUserMessage(session, event) {
    const pending = this.pendingFollowup.get(session.id);
    if (pending === undefined) return;
    const kind = event?.data?.source?.kind;
    if (kind !== undefined && kind !== "user") return;
    const text = textOf(/** @type {any} */ (event?.data)) || "";
    const tokens = concreteTokens(text);
    let overlap = 0;
    for (const label of pending.labels) {
      let shared = 0;
      for (const token of concreteTokens(label)) if (tokens.has(token)) shared += 1;
      if (shared > overlap) overlap = shared;
    }
    const delayMs = Math.max(0, Date.now() - pending.at);
    this.pendingFollowup.delete(session.id);
    void this.writeEvent(
      followupEvent({
        at: Date.now(),
        sid: sidOf(session.id),
        turn: pending.turn,
        typed: text.trim() !== "",
        delayMs,
        textChars: text.trim().length,
        overlap,
      }),
    );
  }

  /**
   * 收尾一条待追踪的 followup（没有用户消息就到了下一轮，或会话被切走）。
   * @param {string} sessionId
   * @param {{ typed: boolean }} input
   */
  closeFollowup(sessionId, input) {
    const pending = this.pendingFollowup.get(sessionId);
    if (pending === undefined) return;
    this.pendingFollowup.delete(sessionId);
    void this.writeEvent(
      followupEvent({
        at: Date.now(),
        sid: sidOf(sessionId),
        turn: pending.turn,
        typed: input.typed,
        delayMs: Math.max(0, Date.now() - pending.at),
        textChars: 0,
        overlap: 0,
      }),
    );
  }

  /**
   * 自动出卡：先过便宜的闸，再让模型判三档，最后按档位决定显示还是只存候选。
   * 关闭开关 = 到这里直接返回，不发请求。
   * @param {any} session
   * @param {number} turn
   * @param {any} event
   * @returns {Promise<void>}
   */
  async maybeGenerate(session, turn, event) {
    const settings = await this.currentSettings();
    // 关闭 = 不发请求，也不留事件（没有请求就没有可复盘的东西）
    if (!settings.enabled || !settings.card) return;
    const sessionId = session.id;
    const { cards } = scanSession(session);
    const stats = answerStatsOf(session);

    const skip = cheapSkipReason({
      enabled: settings.enabled,
      cardEnabled: settings.card,
      pauseUntil: settings.pauseUntil,
      now: Date.now(),
      queued: shouldSkipForQueue(queuedCountOf(this.ctx, sessionId)) ? 2 : 0,
      cardsForTurn: cards.has(turn),
      shownCardsInSession: shownCountOf(cards),
      maxCards: settings.maxCardsPerSession,
      endKind: event?.data?.reason?.kind,
      answerChars: stats.answerChars,
      toolCalls: stats.toolCalls,
    });
    if (skip !== null) {
      if (skip.reason !== "disabled") this.markSkip(skip.reason, skip.detail);
      await this.writeEvent(
        turnEvent({
          at: Date.now(),
          sid: sidOf(sessionId),
          turn,
          tier: settings.cardThreshold,
          feat: stats,
          gate: skip.reason,
        }),
      );
      return;
    }
    await this.writeCardFor(session, settings, {
      turn,
      seq: Number.isSafeInteger(event?.seq) ? event.seq : 0,
      force: false,
      feat: stats,
    });
  }

  /**
   * 跑一次模型调用并为该轮写卡（自动门控与手动补生成共用）。
   * @param {any} session
   * @param {any} settings
   * @param {{ turn: number, seq: number, force: boolean, feat?: { answerChars: number, toolCalls: number } }} options
   *   force=true 时无视档位阈值（用户明确要卡），但仍受总开关/预算约束
   * @returns {Promise<{ ok: true, card: any } | { ok: false, reason: string }>}
   */
  async writeCardFor(session, settings, options) {
    const sessionId = session.id;
    const turn = options.turn;
    const feat = options.feat ?? answerStatsOf(session);
    const sid = sidOf(sessionId);
    if (this.inflight.has(sessionId)) this.abortInflight(sessionId);
    const controller = new AbortController();
    this.inflight.set(sessionId, controller);
    const timer = setTimeout(
      () => controller.abort(new Error(TIMEOUT_MESSAGE)),
      settings.timeoutMs,
    );
    try {
      const result = await this.generate(session, settings, controller.signal);
      if (controller.signal.aborted) {
        this.markAbort(controller.signal.reason, settings.timeoutMs);
        await this.writeErrorEvent(
          sid,
          turn,
          abortSkipKind(abortReasonOf(controller.signal.reason)),
        );
        return { ok: false, reason: "aborted" };
      }
      // 同一会话又起了新的一次生成：这次被后来者取代，算取消而不是超时。
      if (this.inflight.get(sessionId) !== controller) {
        this.markAbort(undefined, settings.timeoutMs);
        await this.writeErrorEvent(sid, turn, "cancelled");
        return { ok: false, reason: "aborted" };
      }
      if (result === null) {
        // generate() 已经把原因写进 lastError；这里只补事件。
        await this.writeErrorEvent(sid, turn, "schema", this.lastError);
        return { ok: false, reason: "schema" };
      }
      const value = result.suggestion.value;
      // 用户明确要卡（补生成）时不看档位；自动路径按档位冻结 shown。
      const shown = options.force === true ? true : shouldShow(value, settings.cardThreshold);
      /** @type {any} */
      const card = {
        turn,
        seq: options.seq,
        summary: result.suggestion.summary,
        question: result.suggestion.question,
        options: result.suggestion.options,
        ...(result.suggestion.nextPrompt === undefined
          ? {}
          : { nextPrompt: result.suggestion.nextPrompt }),
        value,
        shown,
        tier: settings.cardThreshold,
        promptVersion: PROMPT_VERSION,
        model: result.route,
        createdAt: Date.now(),
      };
      if (!isCardDataV2(card)) {
        this.counters.failed += 1;
        this.lastError = "generated card failed validation";
        this.markFailure(this.lastError);
        await this.writeErrorEvent(sid, turn, "schema", this.lastError);
        return { ok: false, reason: "schema" };
      }
      appendPluginRecord(session, CARD_RECORD, card);
      this.counters.generated += 1;
      if (shown) {
        this.pendingFollowup.set(sessionId, {
          turn,
          labels: card.options.map((/** @type {any} */ option) => String(option.label)),
          at: card.createdAt,
        });
      } else {
        this.counters.hidden += 1;
      }
      this.lastError = "";
      await this.writeEvent(
        turnEvent({
          at: Date.now(),
          sid,
          turn,
          tier: settings.cardThreshold,
          feat,
          gate: "ok",
          cand: {
            value,
            shown,
            latencyMs: result.latencyMs,
            model: result.route,
            opts: card.options.map((/** @type {any} */ option) => ({
              stance: option.stance,
              label: option.label,
              len: String(option.label).length,
              concrete: true,
            })),
            summaryChars: card.summary.length,
            questionChars: card.question.length,
            hasGhost: card.nextPrompt !== undefined,
            parse: result.repaired ? "repaired" : "ok",
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
        }),
      );
      return { ok: true, card };
    } catch (error) {
      // 超时/取消会让 generate() 以抛错收场（不是返回 null）：这种中止原来完全无痕，
      // 既不计 failed 也不写 lastSkip，诊断里看不到——所以先单独归类。
      if (controller.signal.aborted) {
        this.markAbort(controller.signal.reason, settings.timeoutMs);
        await this.writeErrorEvent(
          sid,
          turn,
          abortSkipKind(abortReasonOf(controller.signal.reason)),
        );
        return { ok: false, reason: "aborted" };
      }
      // 宿主自己抛的错误里也可能写着超时（定时器还没触发）：同样按中止记，不记成 failed。
      if (abortReasonOf(error) === "timeout") {
        this.markAbort(error, settings.timeoutMs);
        await this.writeErrorEvent(sid, turn, "timeout");
        return { ok: false, reason: "aborted" };
      }
      this.counters.failed += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markFailure(this.lastError);
      await this.writeErrorEvent(sid, turn, /route/u.test(this.lastError) ? "route" : "llm");
      this.warn("card generation failed", error);
      return { ok: false, reason: "failed" };
    } finally {
      clearTimeout(timer);
      if (this.inflight.get(sessionId) === controller) this.inflight.delete(sessionId);
    }
  }

  /**
   * 记录一次「没出卡」及其原因（诊断面板显示最近一次）。
   * @param {string} kind paused | queued | budget | turn-error | short-answer | model | failed
   * @param {string} reason 用户可读的原因
   */
  markSkip(kind, reason) {
    this.counters.skipped += 1;
    this.lastSkip = {
      kind,
      reason: String(reason).slice(0, 160),
      at: Date.now(),
    };
  }

  /**
   * 记录一次失败（不算 skip；failed 计数已经加过）。
   * @param {string} reason
   */
  markFailure(reason) {
    this.lastSkip = {
      kind: "failed",
      reason: String(reason).slice(0, 160),
      at: Date.now(),
    };
  }

  /**
   * 记录一次「生成被中止」：计入 aborted 并写 lastSkip，让诊断行显示得出来。
   * 不碰 failed（中止不是失败，也不该把 lastError 写成中止原因）。
   * @param {unknown} reason AbortController 的 reason（超时时是本插件的 timeout Error）
   * @param {number} [timeoutMs]
   */
  markAbort(reason, timeoutMs) {
    const kind = abortReasonOf(reason);
    this.counters.aborted += 1;
    this.lastSkip = {
      kind: abortSkipKind(kind),
      reason: abortReasonText(kind, timeoutMs),
      at: Date.now(),
    };
  }

  /**
   * 写一条 error 事件（失败/超时/取消/路由），把「没出卡」的成因留痕。
   * @param {string} sid
   * @param {number} turn
   * @param {string} kind
   * @param {string} [detail]
   * @returns {Promise<void>}
   */
  async writeErrorEvent(sid, turn, kind, detail) {
    /** @type {any} */
    const mapped =
      kind === "schema" || kind === "timeout" || kind === "cancelled" || kind === "route"
        ? kind
        : "llm";
    await this.writeEvent(
      errorEvent({
        at: Date.now(),
        sid,
        turn,
        kind: mapped,
        ...(typeof detail === "string" && detail !== "" ? { detail } : {}),
      }),
    );
  }

  /**
   * 一次额外补全：prepareCall + stream → 宽容解析（失败时再修一次）。
   * @param {any} session
   * @param {any} settings
   * @param {AbortSignal} signal
   * @returns {Promise<{
   *   suggestion: NonNullable<ReturnType<typeof parseSuggestion>["suggestion"]>,
   *   route: string, latencyMs: number, repaired: boolean, usage?: any,
   * } | null>}
   */
  async generate(session, settings, signal) {
    const llm = serviceOf(this.ctx, "llm");
    if (llm === undefined || typeof llm.prepareCall !== "function") {
      throw new Error("host llm service is unavailable");
    }
    const route = this.routeFor(session, settings);
    const maxTokens = settings.maxTokens;
    const locale = this.localeName();
    const system = buildSystemPrompt({ locale });
    const transcript = renderTranscript(session.deriveMessages?.() ?? [], {
      limit: settings.contextMessages,
    });
    /** @type {any} */
    let usage;
    const startedAt = Date.now();

    /**
     * 跑一次补全，返回文本。
     * @param {{ role: string, content: any[] }[]} messages
     * @returns {Promise<string>}
     */
    const run = async (messages) => {
      /**
       * @param {boolean} withReasoning
       * @returns {Promise<string>}
       */
      const attempt = async (withReasoning) => {
        const call = await llm.prepareCall(
          {
            provider: route.provider,
            model: route.model,
            maxTokens,
            ...(withReasoning ? { reasoningEffort: "off" } : {}),
          },
          signal,
          /** @param {any} controls */
          (controls) => ({ ...controls }),
        );
        const assembler = new BlockAssembler();
        for await (const chunk of call.stream({
          ...call.config,
          messages: messages.map((message) =>
            createUserMessage({
              content: message.content,
              source: { kind: "next-step" },
            }),
          ),
          system,
          sessionId: session.id,
          purpose: "next-step",
          signal,
        })) {
          signal.throwIfAborted();
          if (chunk?.type === "usage") usage = chunk.usage;
          assembler.push(chunk);
        }
        const finish = assembler.finish;
        if (finish?.kind === "error") {
          throw new Error(`model finished with error: ${finish.failure?.message ?? "unknown"}`);
        }
        if (finish?.kind === "aborted") throw new Error("model call was aborted");
        let text = "";
        for (const block of assembler.blocks()) {
          if (block?.type === "text" && typeof block.text === "string") text += block.text;
        }
        return text;
      };
      try {
        return await attempt(true);
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (code === "UNSUPPORTED_REASONING_EFFORT" || code === "INVALID_MODEL_REASONING") {
          return attempt(false);
        }
        throw error;
      }
    };

    const messages = buildMessages({ transcript, locale });
    const raw = await run(messages);
    let parsed = parseSuggestion(raw);
    let repaired = false;
    if (parsed.suggestion === null && parsed.problem !== null) {
      // 格式问题不该由用户承担损失：带「原文 + 具体问题」再要一次，只要求它修格式。
      repaired = true;
      this.warn(
        `model output did not match the card schema (${parsed.problem.kind}: ${parsed.problem.detail}), retrying once`,
      );
      const repairRaw = await run(buildRepairMessage({ raw, problem: parsed.problem.kind }));
      parsed = parseSuggestion(repairRaw);
    }
    if (parsed.suggestion === null) {
      const detail =
        parsed.problem === null ? "unknown" : `${parsed.problem.kind}:${parsed.problem.detail}`;
      this.counters.failed += 1;
      this.lastError = `model output did not match the card schema (${detail})`;
      this.markFailure(this.lastError);
      this.warn(`model output did not match the card schema: ${detail}`);
      return null;
    }
    if (parsed.detail !== "") {
      // 宽容解析里被容忍的问题（截断/丢弃单条），留在日志里便于复盘提示词
      this.warn(`card normalized with tolerated problems: ${parsed.detail}`);
    }
    return {
      suggestion: parsed.suggestion,
      route: `${route.provider}/${route.model}`,
      latencyMs: Date.now() - startedAt,
      repaired,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /**
   * 选路：设置显式指定 > 会话当前模型 > 全局默认。
   * @param {any} session
   * @param {any} settings
   * @returns {{ provider: string, model: string }}
   */
  routeFor(session, settings) {
    if (settings.provider !== "" && settings.model !== "") {
      return { provider: settings.provider, model: settings.model };
    }
    const agents = serviceOf(this.ctx, "agents");
    const current = agents?.get?.(session.id)?.model?.current?.();
    if (typeof current?.provider === "string" && typeof current?.model === "string") {
      return { provider: current.provider, model: current.model };
    }
    const fallback = serviceOf(this.ctx, "agentDefaultModel")?.currentSelection?.();
    if (typeof fallback?.provider === "string" && typeof fallback?.model === "string") {
      return { provider: fallback.provider, model: fallback.model };
    }
    throw new Error("no model route is available for the suggestion call");
  }

  /** 界面语言（只用来自解释提示词，不参与校验）。 @returns {string} */
  localeName() {
    const configured = typeof this.config.locale === "string" ? this.config.locale : "";
    return configured === "" ? "auto" : configured;
  }

  /**
   * 当前设置：文件优先，1s 缓存。改文件即生效（不必重启宿主）。
   * v1 → v2 迁移结果会在这里**写回一次**（之后不再写）。
   * @returns {Promise<any>}
   */
  async currentSettings() {
    const now = Date.now();
    if (this.settingsCache.value !== null && now - this.settingsCache.at < 1000) {
      return this.settingsCache.value;
    }
    const { settings, migrated } = await loadSettingsWithMeta({
      home: this.dataRoot,
      logger: this.logger,
    });
    this.settingsCache = { at: now, value: settings };
    if (migrated) {
      // 幂等：写回后文件带上 schemaVersion，下次读就不再迁移。
      void saveSettings({ home: this.dataRoot, patch: settings, logger: this.logger }).catch(
        () => undefined,
      );
    }
    return settings;
  }

  /**
   * 事件日志（惰性创建；包版本用于自证）。
   * @returns {Promise<any>}
   */
  async eventLog() {
    if (this.eventLogHandle === null) {
      const identity = await buildIdentity().catch(() => ({ version: "" }));
      this.eventLogHandle = createEventLog({
        home: this.dataRoot,
        logger: this.logger,
        pkg: typeof identity.version === "string" ? identity.version : "",
      });
      void this.eventLogHandle.ensureMeta({
        tier: (await this.currentSettings().catch(() => DEFAULT_SETTINGS)).cardThreshold,
      });
    }
    return this.eventLogHandle;
  }

  /**
   * 写一条事件（采集关闭时直接跳过；任何失败都不影响回合）。
   * @param {any} event
   * @returns {Promise<void>}
   */
  async writeEvent(event) {
    try {
      const settings = await this.currentSettings();
      if (settings.telemetry !== true) return;
      const log = await this.eventLog();
      await log.append(event);
    } catch (error) {
      this.warn("cannot record event", error);
    }
  }

  /**
   * 取 live 会话。
   * @param {string} sessionId
   * @returns {any}
   */
  sessionOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new RemoteError("next-step/failed", "a session id is required");
    }
    const agent = serviceOf(this.ctx, "agents")?.get?.(sessionId);
    if (agent?.session) return agent.session;
    const sessions = serviceOf(this.ctx, "sessions");
    const session = sessions?.get?.(sessionId) ?? sessions?.store?.get?.(sessionId);
    if (session) return session;
    throw new RemoteError("next-step/failed", `session "${sessionId}" is not open`);
  }

  /**
   * 中止该会话在途的生成（用户已经做了选择，或又结束了一轮）。
   * @param {string} sessionId
   */
  abortInflight(sessionId) {
    const controller = this.inflight.get(sessionId);
    if (controller !== undefined) {
      this.inflight.delete(sessionId);
      try {
        controller.abort(new Error("superseded"));
      } catch (_error) {
        /* 已 abort */
      }
    }
  }

  /**
   * @param {string} message
   * @param {unknown} [error]
   */
  warn(message, error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    this.logger?.warn?.(`next-step: ${message}${detail}`);
  }

  // ---- Remote ------------------------------------------------------------

  /**
   * 用户选中一条建议：只写决策记录并返回要发送的文本，发送由客户端走输入框。
   * 返回的文本就是用户点的那粒胶囊上的 `label`（v0.2 起不再有隐藏的完整指令）。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async act(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      const turn = Number(request?.turn);
      const index = Number(request?.index);
      const settings = await this.currentSettings();
      if (!settings.enabled) return { ok: false, reason: "disabled" };
      const session = this.sessionOf(sessionId);
      const { cards, decisions, reveals } = scanSession(session);
      const card = cards.get(turn);
      if (card === undefined) return { ok: false, reason: "missing" };
      const state = resolveVisibility({
        card,
        revealed: reveals.get(turn) === true,
        decision: decisions.get(turn),
      });
      if (state === "hidden") return { ok: false, reason: "hidden" };
      if (state === "resolved") return { ok: false, reason: "stale" };
      const option = card.options[index];
      if (!Number.isSafeInteger(index) || index < 0 || option === undefined) {
        return { ok: false, reason: "missing" };
      }
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (label === "") return { ok: false, reason: "missing" };
      appendPluginRecord(session, DECISION_RECORD, {
        turn,
        phase: "sent",
        index,
        at: Date.now(),
      });
      this.counters.acted += 1;
      await this.writeEvent(
        actionEvent({
          at: Date.now(),
          sid: sidOf(sessionId),
          turn,
          kind: "clicked",
          index,
          stance: option.stance,
          labelLen: label.length,
          msSinceShown: card.createdAt > 0 ? Math.max(0, Date.now() - card.createdAt) : 0,
        }),
      );
      this.abortInflight(sessionId);
      return { ok: true, text: label };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 用户关掉这张卡。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async dismiss(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      const turn = Number(request?.turn);
      const session = this.sessionOf(sessionId);
      const { cards, decisions, reveals } = scanSession(session);
      const card = cards.get(turn);
      if (card === undefined) return { ok: false, reason: "missing" };
      const state = resolveVisibility({
        card,
        revealed: reveals.get(turn) === true,
        decision: decisions.get(turn),
      });
      if (state === "hidden") return { ok: false, reason: "hidden" };
      if (state === "resolved") return { ok: false, reason: "stale" };
      appendPluginRecord(session, DECISION_RECORD, { turn, phase: "dismissed", at: Date.now() });
      this.counters.dismissed += 1;
      await this.writeEvent(
        actionEvent({
          at: Date.now(),
          sid: sidOf(sessionId),
          turn,
          kind: "dismissed",
          msSinceShown: card.createdAt > 0 ? Math.max(0, Date.now() - card.createdAt) : 0,
        }),
      );
      return { ok: true };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 手动补生成：为最近一个正常结束的回合要一张卡。
   * **优先揭示已有候选**（不发模型调用、瞬时出卡）；只有这一轮压根没生成过候选时才真的调用模型。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async generateNow(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      const settings = await this.currentSettings();
      if (!settings.enabled || !settings.card) return { ok: false, reason: "disabled" };
      const session = this.sessionOf(sessionId);
      const latest = latestCompletedTurn(session);
      if (latest === undefined) return { ok: false, reason: "no-turn" };
      const requested = Number(request?.turn);
      const turn = Number.isSafeInteger(requested) ? requested : latest.turn;
      if (turn !== latest.turn) return { ok: false, reason: "stale" };
      const { cards, reveals } = scanSession(session);
      const existing = cards.get(turn);
      const via = request?.via === "command" ? "command" : "button";
      if (existing !== undefined) {
        if (existing.shown === true) return { ok: false, reason: "exists" };
        // 揭示：追加一条 reveal 记录（幂等），投影会让客户端把它渲染出来
        if (reveals.get(turn) !== true) {
          appendPluginRecord(session, REVEAL_RECORD, { turn, at: Date.now(), via });
        }
        this.counters.revealed += 1;
        await this.writeEvent(
          promoteEvent({
            at: Date.now(),
            sid: sidOf(sessionId),
            turn,
            found: true,
            value: existing.value,
          }),
        );
        return { ok: true, via: "reveal" };
      }
      if (shownCountOf(cards) >= settings.maxCardsPerSession) {
        return { ok: false, reason: "budget" };
      }
      if (this.inflight.has(sessionId)) return { ok: false, reason: "inflight" };
      const result = await this.writeCardFor(session, settings, {
        turn,
        seq: latest.seq,
        force: true,
      });
      await this.writeEvent(
        promoteEvent({ at: Date.now(), sid: sidOf(sessionId), turn, found: false }),
      );
      return result.ok === true
        ? { ok: true, via: "generated" }
        : { ok: false, reason: result.reason };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 客户端上报曝光：卡片**真正进入视口**（不是"组件挂载了"）。
   * 宿主按 sid+turn 去重；任何失败都不算错误（曝光是尽力而为的观测）。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async impression(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      const turn = Number(request?.turn);
      if (sessionId === "" || !Number.isSafeInteger(turn)) return { ok: false, reason: "missing" };
      const key = `${sidOf(sessionId)}:${String(turn)}`;
      if (this.impressionsSeen.has(key)) return { ok: true };
      this.impressionsSeen.add(key);
      this.counters.impressions += 1;
      const visibleMs = Number(request?.visibleMs);
      const ratio = Number(request?.ratio);
      await this.writeEvent(
        impressionEvent({
          at: Date.now(),
          sid: sidOf(sessionId),
          turn,
          visibleMs: Number.isFinite(visibleMs) ? visibleMs : 0,
          ratio: Number.isFinite(ratio) ? ratio : -1,
        }),
      );
      return { ok: true };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 复盘：读事件日志 → 指标 → 判读 → 写 Markdown 报告。
   * 默认只统计同一 scheme（v0.4）的事件，避免把不同口径的数据混算。
   * @returns {Promise<any>}
   */
  async report() {
    try {
      const log = await this.eventLog();
      const dir = eventsDirOf(this.dataRoot);
      /** @type {string[]} */
      const chunks = [];
      for (const file of [eventsPathOf(this.dataRoot), join(dir, "events.jsonl.1")]) {
        try {
          chunks.push(await readFile(file, "utf8"));
        } catch (_error) {
          /* 文件不存在是正常情况 */
        }
      }
      const parsed = parseEvents(chunks.join("\n"));
      const relevant = parsed.events.filter(
        (event) => event.scheme === SCHEME || event.scheme === undefined,
      );
      const metrics = summarize(relevant);
      const list = verdicts(metrics);
      const markdown = renderMarkdown(metrics, list);
      const path = await writeReport({ home: this.dataRoot, markdown });
      const stats = await log.stats();
      return {
        ok: true,
        path,
        stats,
        metrics,
        verdicts: list,
        insufficient: metrics.insufficient,
        badLines: parsed.badLines,
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 读设置（RPC）。
   * @returns {Promise<any>}
   */
  async settings() {
    try {
      return { ok: true, settings: await this.currentSettings() };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 合并写设置（RPC）。写盘即生效，下一次生成就会看到。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async updateSettings(request) {
    try {
      const merged = await saveSettings({
        home: this.dataRoot,
        patch: request?.patch,
        logger: this.logger,
      });
      this.settingsCache = { at: Date.now(), value: merged };
      return { ok: true, settings: merged };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 诊断信息。
   * @returns {Promise<any>}
   */
  async diagnostics() {
    try {
      const identity = await buildIdentity();
      const settings = await this.currentSettings();
      const telemetry = await this.eventLog()
        .then((log) => log.stats())
        .catch(() => ({ path: eventsPathOf(this.dataRoot), bytes: 0, lines: 0 }));
      return {
        ok: true,
        stats: {
          ...this.counters,
          inflight: this.inflight.size,
          lastError: this.lastError,
          lastSkip: this.lastSkip,
          dataRoot: this.dataRoot,
          settings,
          tier: settings.cardThreshold,
          promptVersion: PROMPT_VERSION,
          scheme: SCHEME,
          telemetry: { ...telemetry, enabled: settings.telemetry === true },
          // 运行时自证：与 `dsh plugin list` / npm tarball 对照用。
          version: identity.version,
          buildHash: identity.buildHash,
          buildFiles: identity.buildFiles,
          packagePath: identity.packagePath,
        },
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }
}

declareRemote(NextStepService, "act");
declareRemote(NextStepService, "dismiss");
declareRemote(NextStepService, "generateNow");
declareRemote(NextStepService, "impression");
declareRemote(NextStepService, "report");
declareRemote(NextStepService, "settings");
declareRemote(NextStepService, "updateSettings");
declareRemote(NextStepService, "diagnostics");

export { DEFAULT_SETTINGS };
