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
// 0.4.3 的一条不变量（见 docs/adr/0023）：**结构合法 ≠ 有用**。任何一次要产出卡片内容的调用都必须
// 带同一段对话；空输出重发原请求而不是「修格式」；写卡前再做一次落地校验（卡片里至少有一个对象
// 能在对话里找到）。没有对话内容时直接跳过，不调模型 —— 这条路径曾经稳定产出「这一轮没有拿到
// 任何对话内容，请把对话贴进来」的空卡，95 条历史记录全部来自这里。
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
  isCardDataV2,
  REVEAL_RECORD,
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
import { createFollowupTracker } from "./followup.js";
import { cheapSkipReason } from "./gates.js";
import { createGenerateStatus } from "./generate-status.js";
import { emptyOutputSummary, recoveryFor } from "./generation-budget.js";
import { createInflightRegistry, inflightBlocksGenerateNow } from "./inflight.js";
import { nextStepProjection } from "./projection.js";
import {
  buildMessages,
  buildRepairMessage,
  buildSystemPrompt,
  groundableText,
  hasContext,
  identityTokens,
  isGroundedIn,
  MATERIAL_CLIP,
  parseSuggestion,
  renderTranscript,
  textOf,
} from "./prompt.js";
import { shouldSkipForQueue } from "./queue-gate.js";
import { parseEvents, renderMarkdown, summarize, verdicts, writeReport } from "./report.js";
import { PROMPT_VERSION, SCHEME } from "./scheme.js";
import { foldSessionRecords } from "./session-records.js";
import { DEFAULT_SETTINGS, loadSettingsWithMeta, saveSettings } from "./settings.js";
import { endKindOf, turnEndDisposition } from "./turn-dispatch.js";
import { planCardWrite } from "./write-plan.js";

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
 * 折叠逻辑本身在 `session-records.js`（纯函数、有单测），这里只把宿主 session 适配成事件数组。
 * @param {any} session
 * @returns {{ cards: Map<number, any>, decisions: Map<number, any>, reveals: Map<number, true> }}
 */
function scanSession(session) {
  let events = [];
  if (typeof session?.snapshotEvents === "function") events = session.snapshotEvents();
  else if (Array.isArray(session?.log)) events = session.log;
  return foldSessionRecords(Array.isArray(events) ? events : [], pluginRecordOf);
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
 * 恢复路径 → 事件里的 `parse` 字段（报表按它分组对比）。
 * @param {"none" | "retry" | "repair"} recovery
 * @returns {"ok" | "retried" | "repaired"}
 */
function parseKindOf(recovery) {
  if (recovery === "retry") return "retried";
  return recovery === "repair" ? "repaired" : "ok";
}

/**
 * 本轮要发给模型的对话材料（一次算好，闸、请求、落地校验共用同一份）。
 *
 * 两个口径，别混用：
 * - `transcript` 发给模型（每条消息裁剪到 800 字，只留最近 N 条）；
 * - `material` 只用于**落地校验**（同一条窗口、不裁剪）：摘要里的数字/文件名常在回答后半段，
 *   拿裁剪过的版本去校验会误杀正常卡。它不发给模型。
 * @param {any} session
 * @param {any} settings
 * @returns {{ transcript: string, material: string }}
 */
function contextOf(session, settings) {
  const messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : [];
  const limit = settings?.contextMessages;
  return {
    transcript: renderTranscript(messages, { limit }),
    material: renderTranscript(messages, { limit, clip: MATERIAL_CLIP }),
  };
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
     *   generated: number, hidden: number, superseded: number, failed: number, aborted: number,
     *   skipped: number, acted: number, dismissed: number, revealed: number, impressions: number,
     * }}
     */
    this.counters = {
      generated: 0,
      // 生成成功但被档位抑制（没有显示）的回合数
      hidden: 0,
      // 生成跑完时这一轮已经翻过去了（用户在途时发了下一条）：候选以 shown:false 落库。
      // 单独计数是为了让这条改动的效果可观测（旧的 aborted/cancelled 会明显下降）。
      // 注意：这不是省 token 的改动——跑完会比中止多付输出 token。
      superseded: 0,
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
    /**
     * 每会话在途生成的登记簿（纯逻辑，见 inflight.js）：
     * `turn/start` 只标记 superseded、不 abort，让已花的 token 变成 `shown:false` 候选。
     */
    this.inflight = createInflightRegistry();
    /**
     * 每会话最近一次**已结束**的生成（成功也记）：客户端用 `generateState` 查询它，把自动生成/
     * 手动生成的失败落成「重试 + 原因摘要」，而不是只写进诊断日志（USIM-U2-04，见 generate-status.js）。
     */
    this.generateStatus = createGenerateStatus();
    /** 设置缓存（1s TTL），使「改文件即生效」成立又不必每次读盘。 */
    this.settingsCache = { at: 0, value: /** @type {any} */ (null) };
    /** 事件日志（惰性创建：需要知道包版本）。**缓存 promise**，避免并发创建写两条 meta。 @type {any} */
    this.eventLogHandle = null;
    /** @type {Promise<any> | null} */
    this.eventLogPromise = null;
    /** 首次写入前确保 meta 已经落盘的 promise。 @type {Promise<unknown> | null} */
    this.metaReady = null;
    /**
     * 待追踪的卡片（下一次用户消息到来时写 followup）；三条收尾路径 + 会话级上限见 followup.js。
     * 有卡在场的会话最多 32 个、单条最多留 15 分钟，到期按「用户没再说话」结算。
     */
    this.followups = createFollowupTracker({ now: () => Date.now() });
    /** 已记录的曝光（sid:turn），宿主侧去重。 @type {Set<string>} */
    this.impressionsSeen = new Set();
    this.installProjection();
    this.installListener();
    this.installFollowupSweep();
  }

  /**
   * TTL 扫描：会话切走在宿主里没有事件可听，所以「用户看完就走了」只能靠定时兜底结算。
   * 用 unref 的 interval，不拖住宿主/测试进程退出（与 dsh-projects 的计时器同一做法）。
   * @returns {void}
   */
  installFollowupSweep() {
    // 必须用 `this.ctx.effect(...)` 的**方法调用**形式：cordis 的 effect 内部依赖 `this`，
    // 先解构出函数再调用会丢掉上下文（installProjection 里也是同样的写法）。
    if (this.ctx === null || typeof this.ctx?.effect !== "function") return;
    try {
      this.ctx.effect(() => {
        const timer = setInterval(() => this.flushExpiredFollowups(), 60_000);
        if (typeof timer?.unref === "function") timer.unref();
        return () => clearInterval(timer);
      }, "next-step: followup ttl");
    } catch (error) {
      // 降级：没有定时器时 TTL 只在下一次会话事件时惰性结算。
      this.warn("cannot install followup sweep", error);
    }
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
    // 新一轮开始了：**不再 abort** 在途生成，只把它标记成 superseded。
    // 旧行为是立刻取消 → 14 天里 322 次「被下一轮取消」，已花的 token 全丢（AUD-NS-01）。
    // 现在生成跑完后以 `shown:false` 落库：不进对话流、不重复出卡，但候选留下了。
    if (event?.type === "turn/start") {
      // 过期 followup 顺手惰性结算一次（没有定时器时的兜底；幂等，不会重复写）。
      this.flushExpiredFollowups();
      this.inflight.supersede(session.id);
      // **不要**在这里收尾 followup：宿主的顺序是 `turn/start` 先于 `user/message`（冒烟实测），
      // 在此清掉 pending 就永远记不到「用户自己打了下一条」——而那正是最重要的隐式负反馈。
      return;
    }
    if (event?.type === "user/message") {
      this.handleUserMessage(session, event);
      return;
    }
    if (event?.type !== "turn/end") return;
    // 上一张卡的 pending 到这个回合结束都还没等到用户消息 → 结算成 typed:false
    // （真实续写走的是同一回合里的 user/message，早已被 consume 掉）。
    this.flushFollowupsBefore(session.id, event?.data?.turn);
    // AUD-NS-05：completed 的过滤下移到便宜闸之后。非 completed 的回合也进流程，
    // 命中 `turn-error` 并落一条 turn 事件（不调模型），闸门分布才可观测。
    const disposition = turnEndDisposition({
      subagent: isSubagentSession(session),
      turn: event?.data?.turn,
      reasonKind: event?.data?.reason?.kind,
    });
    if (!disposition.consider) return;
    // 不阻塞事件分发：生成是异步的，失败静默。
    // endKind 用归一化后的值（缺失/非字符串 → "unknown" → 命中 turn-error，绝不生成卡）。
    void this.maybeGenerate(session, disposition.turn, event, disposition.endKind);
  }

  /**
   * 用户发了一条消息 → 如果上一张卡还没被追踪过，写一条 followup（隐式负反馈）。
   * 注意：我们自己点击胶囊发出的消息也走这里（source.kind 为 user），这时 action 已经记过，
   * followup 仍然记——它能回答「点了之后是不是又反悔」。
   * @param {any} session
   * @param {any} event
   */
  handleUserMessage(session, event) {
    if (!this.followups.has(session.id)) return;
    const kind = event?.data?.source?.kind;
    if (kind !== undefined && kind !== "user") return;
    const text = textOf(/** @type {any} */ (event?.data)) || "";
    const settlement = this.followups.consume(session.id, { text, at: Date.now() });
    this.writeFollowup(settlement);
  }

  /**
   * 写一条 followup 事件（收尾路径共用；settlement 为 undefined 时什么都不做）。
   * @param {import("./followup.js").FollowupSettlement | undefined} settlement
   * @returns {void}
   */
  writeFollowup(settlement) {
    if (settlement === undefined) return;
    void this.writeEvent(
      followupEvent({
        at: settlement.at,
        sid: sidOf(settlement.sessionId),
        turn: settlement.turn,
        typed: settlement.typed,
        delayMs: settlement.delayMs,
        textChars: settlement.textChars,
        overlap: settlement.overlap,
      }),
    );
  }

  /**
   * 把某个会话里「更早回合」的 pending 结算成 typed:false（下一轮已经结束、用户没接话）。
   * @param {string} sessionId
   * @param {unknown} turn 当前回合号
   * @returns {void}
   */
  flushFollowupsBefore(sessionId, turn) {
    const pending = this.followups.get(sessionId);
    if (pending === undefined) return;
    if (!Number.isSafeInteger(turn)) return;
    if (pending.turn >= /** @type {number} */ (turn)) return;
    this.closeFollowup(sessionId, { typed: false });
  }

  /**
   * TTL 扫描：到期还没等到用户消息的 pending 结算成 typed:false。
   * @returns {void}
   */
  flushExpiredFollowups() {
    for (const settlement of this.followups.expire(Date.now())) this.writeFollowup(settlement);
  }

  /**
   * 登记「这张卡在场上」：下一条用户消息到来时写一条 followup。
   * @param {string} sessionId
   * @param {number} turn
   * @param {{ label?: string }[]} options
   * @param {number} at
   */
  rememberPending(sessionId, turn, options, at) {
    const labels = (Array.isArray(options) ? options : []).map(
      (/** @type {any} */ option) => option?.label,
    );
    const { evicted } = this.followups.remember(sessionId, {
      turn,
      labels,
      at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    });
    // 会话级上限挤出的旧条目也按「用户没再说话」结算，不丢负反馈。
    for (const settlement of evicted) this.writeFollowup(settlement);
  }

  /**
   * 收尾一条待追踪的 followup（下一轮已结束 / TTL 到期 / 会话级上限挤出都走这个幂等入口）。
   * 会话切走在宿主里没有可听的事件，只能靠 TTL 兜底（见 README「已知限制」）。
   * @param {string} sessionId
   * @param {{ typed: boolean }} input
   */
  closeFollowup(sessionId, input) {
    this.writeFollowup(this.followups.close(sessionId, { typed: input.typed, at: Date.now() }));
  }

  /**
   * 自动出卡：先过便宜的闸，再让模型判三档，最后按档位决定显示还是只存候选。
   * 关闭开关 = 到这里直接返回，不发请求。
   * @param {any} session
   * @param {number} turn
   * @param {any} event
   * @param {string} [endKindOverride] 已归一化的结束原因（缺省时从 event 里取并归一化）
   * @returns {Promise<void>}
   */
  async maybeGenerate(session, turn, event, endKindOverride) {
    const settings = await this.currentSettings();
    // 关闭 = 不发请求，也不留事件（没有请求就没有可复盘的东西）
    if (!settings.enabled || !settings.card) return;
    const sessionId = session.id;
    const { cards } = scanSession(session);
    const stats = answerStatsOf(session);
    const context = contextOf(session, settings);

    const skip = cheapSkipReason({
      enabled: settings.enabled,
      cardEnabled: settings.card,
      pauseUntil: settings.pauseUntil,
      now: Date.now(),
      queued: shouldSkipForQueue(queuedCountOf(this.ctx, sessionId)) ? 2 : 0,
      cardsForTurn: cards.has(turn),
      shownCardsInSession: shownCountOf(cards),
      maxCards: settings.maxCardsPerSession,
      // 归一化后的回合结束原因（见 turn-dispatch.endKindOf）：
      // 缺失/非字符串一律是 "unknown"，必然命中 turn-error 而不是漏过闸去调模型。
      endKind:
        typeof endKindOverride === "string" && endKindOverride !== ""
          ? endKindOverride
          : endKindOf(event?.data?.reason?.kind),
      answerChars: stats.answerChars,
      toolCalls: stats.toolCalls,
      contextChars: context.transcript.length,
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
      context,
    });
  }

  /**
   * 跑一次模型调用并为该轮写卡（自动门控与手动补生成共用），**并把结局记进每会话的
   * `generateStatus`**：自动生成失败没有会话记录可写，客户端只能靠这条记录得知「刚才失败了、
   * 原因是什么」（USIM-U2-04）。失败记录带 `detail`（schema 的 `json:empty`、宿主错误消息、
   * 超时秒数等），客户端把它做「一行原因 + 可展开详情」。
   * @param {any} session
   * @param {any} settings
   * @param {{
   *   turn: number, seq: number, force: boolean,
   *   feat?: { answerChars: number, toolCalls: number },
   *   context?: { transcript: string, material: string },
   * }} options
   *   force=true 时无视档位阈值（用户明确要卡），但仍受总开关/预算约束
   * @returns {Promise<{ ok: true, card: any } | { ok: false, reason: string, detail: string }>}
   */
  async writeCardFor(session, settings, options) {
    const outcome = await this.generateCardFor(session, settings, options);
    this.generateStatus.record(session.id, outcome, options.turn);
    return outcome;
  }

  /**
   * `writeCardFor` 的实现体（不记录：由外层统一记录，避免每个失败分支各抄一遍）。
   * @param {any} session
   * @param {any} settings
   * @param {{
   *   turn: number, seq: number, force: boolean,
   *   feat?: { answerChars: number, toolCalls: number },
   *   context?: { transcript: string, material: string },
   * }} options
   * @returns {Promise<{ ok: true, card: any } | { ok: false, reason: string, detail: string }>}
   */
  async generateCardFor(session, settings, options) {
    const sessionId = session.id;
    const turn = options.turn;
    const feat = options.feat ?? answerStatsOf(session);
    const sid = sidOf(sessionId);
    const context = options.context ?? contextOf(session, settings);
    // 补生成（force）绕过了便宜闸，所以这里再确认一次：对话是空的就不发请求。
    if (!hasContext(context.transcript)) {
      this.counters.skipped += 1;
      this.markSkip("no-context", "no conversation content to base a card on");
      return {
        ok: false,
        reason: "no-context",
        detail: "no conversation content to base a card on",
      };
    }
    // 同一会话又要起一次新生成：旧的那次已经没有任何价值，取消掉（登记簿负责 abort + 注销）。
    if (this.inflight.has(sessionId)) this.abortInflight(sessionId);
    const controller = new AbortController();
    this.inflight.begin(sessionId, turn, controller);
    const timer = setTimeout(
      () => controller.abort(new Error(TIMEOUT_MESSAGE)),
      settings.timeoutMs,
    );
    try {
      const result = await this.generate(session, settings, controller.signal, context);
      if (controller.signal.aborted) {
        const abortKind = abortReasonOf(controller.signal.reason);
        this.markAbort(controller.signal.reason, settings.timeoutMs);
        await this.writeErrorEvent(sid, turn, abortSkipKind(abortKind));
        return {
          ok: false,
          reason: abortKind,
          detail: abortReasonText(abortKind, settings.timeoutMs),
        };
      }
      // 同一会话又起了新的一次生成（登记簿已被替换、自己也被 abort）：算取消而不是超时。
      // 注意：`turn/start` 走的是 supersede（不 abort），不会命中这里——那种情况要继续往下走，
      // 把已经算出来的候选以 `shown:false` 落库（AUD-NS-01）。
      if (!this.inflight.isCurrent(sessionId, controller)) {
        this.markAbort(undefined, settings.timeoutMs);
        await this.writeErrorEvent(sid, turn, "cancelled");
        return {
          ok: false,
          reason: "cancelled",
          detail: abortReasonText("cancelled", settings.timeoutMs),
        };
      }
      if (result.ok !== true) {
        // 三种「没有可用卡片」的结局分开记，诊断面板才说得出是哪一种（docstring 见 generate）。
        if (result.failure === "ungrounded") {
          this.counters.failed += 1;
          this.lastError = "generated card is not grounded in this conversation";
          this.markFailure(this.lastError);
          await this.writeErrorEvent(sid, turn, "ungrounded", result.detail);
          return {
            ok: false,
            reason: "ungrounded",
            detail: result.detail ?? "generated card is not grounded in this conversation",
          };
        }
        // generate() 已经把原因写进 lastError；这里只补事件。
        await this.writeErrorEvent(sid, turn, "schema", this.lastError);
        return { ok: false, reason: "schema", detail: this.lastError };
      }
      const value = result.suggestion.value;
      // 三个输入共同决定 shown（见 write-plan.js）：
      // - 用户明确要卡（补生成）时不看档位；
      // - 自动路径按档位冻结；
      // - 这一轮已经被更新的回合取代时一律 shown:false（候选落库、不进对话流、不重复出卡）。
      const plan = planCardWrite({
        value,
        tier: settings.cardThreshold,
        force: options.force === true,
        superseded: this.inflight.isSuperseded(sessionId, controller),
      });
      const shown = plan.shown;
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
        return { ok: false, reason: "schema", detail: this.lastError };
      }
      appendPluginRecord(session, CARD_RECORD, card);
      this.counters.generated += 1;
      if (shown) {
        this.rememberPending(sessionId, turn, card.options, card.createdAt);
      } else {
        this.counters.hidden += 1;
        if (plan.gate === "superseded") {
          this.counters.superseded += 1;
          this.markSuperseded();
        }
      }
      this.lastError = "";
      await this.writeEvent(
        turnEvent({
          at: Date.now(),
          sid,
          turn,
          tier: settings.cardThreshold,
          feat,
          gate: plan.gate,
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
            // 三种恢复路径都记下来：ok（一次成功）/ retried（空输出重采样）/
            // repaired（带对话修格式）—— 复盘时这三种的输出分布完全不同
            parse: parseKindOf(result.recovery),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
        }),
      );
      return { ok: true, card };
    } catch (error) {
      // 超时/取消会让 generate() 以抛错收场（不是返回 null）：这种中止原来完全无痕，
      // 既不计 failed 也不写 lastSkip，诊断里看不到——所以先单独归类。
      if (controller.signal.aborted) {
        const abortKind = abortReasonOf(controller.signal.reason);
        this.markAbort(controller.signal.reason, settings.timeoutMs);
        await this.writeErrorEvent(sid, turn, abortSkipKind(abortKind));
        return {
          ok: false,
          reason: abortKind,
          detail: abortReasonText(abortKind, settings.timeoutMs),
        };
      }
      // 宿主自己抛的错误里也可能写着超时（定时器还没触发）：同样按中止记，不记成 failed。
      if (abortReasonOf(error) === "timeout") {
        this.markAbort(error, settings.timeoutMs);
        await this.writeErrorEvent(sid, turn, "timeout");
        return {
          ok: false,
          reason: "timeout",
          detail: abortReasonText("timeout", settings.timeoutMs),
        };
      }
      this.counters.failed += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markFailure(this.lastError);
      await this.writeErrorEvent(sid, turn, /route/u.test(this.lastError) ? "route" : "llm");
      this.warn("card generation failed", error);
      return {
        ok: false,
        reason: /route/u.test(this.lastError) ? "route" : "failed",
        detail: this.lastError,
      };
    } finally {
      clearTimeout(timer);
      this.inflight.finish(sessionId, controller);
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
   * 写一条 error 事件（失败/超时/取消/路由/落地校验），把「没出卡」的成因留痕。
   * @param {string} sid
   * @param {number} turn
   * @param {string} kind
   * @param {string} [detail]
   * @returns {Promise<void>}
   */
  async writeErrorEvent(sid, turn, kind, detail) {
    /** @type {any} */
    const mapped =
      kind === "schema" ||
      kind === "ungrounded" ||
      kind === "timeout" ||
      kind === "cancelled" ||
      kind === "route"
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
   * 一次额外补全：prepareCall + stream → 宽容解析 → （必要时）重采样或带对话修复 → 落地校验。
   *
   * 四种结局，全部显式返回（不再用 null 一锅端）：
   * - `{ ok: true, suggestion, … }`
   * - `{ ok: false, failure: "schema" }`      两次输出都不合格（原因已写进 lastError）
   * - `{ ok: false, failure: "ungrounded" }`  结构合格，但卡片里没有任何对象能在这段对话里找到
   *
   * 两条硬规则（见 docs/adr/0023）：
   * 1. **空输出不修复，重发原请求**：拿空字符串去「修格式」，模型手里就只剩「上次输出为空」这条
   *    信息，它的唯一出路是把它写成一张卡（「这一轮没有拿到任何对话内容…」）——历史 95 条垃圾卡
   *    全部来自这里；
   * 2. **修复请求必须带同一段对话**：修复是「改格式」，不是「重新想象内容」，没有原料就只能编。
   * @param {any} session
   * @param {any} settings
   * @param {AbortSignal} signal
   * @param {{ transcript: string, material: string }} context
   * @returns {Promise<
   *   | { ok: true, suggestion: NonNullable<ReturnType<typeof parseSuggestion>["suggestion"]>, route: string, latencyMs: number, repaired: boolean, recovery: "none" | "retry" | "repair", usage?: any }
   *   | { ok: false, failure: "schema" | "ungrounded", detail?: string }
   * >}
   */
  async generate(session, settings, signal, context) {
    const llm = serviceOf(this.ctx, "llm");
    if (llm === undefined || typeof llm.prepareCall !== "function") {
      throw new Error("host llm service is unavailable");
    }
    const route = this.routeFor(session, settings);
    const maxTokens = settings.maxTokens;
    const locale = this.localeName();
    const system = buildSystemPrompt({ locale });
    const transcript = context.transcript;
    /** @type {any} */
    let usage;
    /** 最近一次补全的结束原因（用于空输出诊断，不进用户可见 detail）。 @type {string | null} */
    let lastFinish = null;
    /** 最近一次补全的 usage。 @type {any} */
    let lastUsage = null;
    const startedAt = Date.now();

    /**
     * 跑一次补全，返回文本。
     * @param {{ role: string, content: any[] }[]} messages
     * @returns {Promise<string>}
     */
    const run = async (messages, budget = maxTokens) => {
      /**
       * @param {boolean} withReasoning
       * @param {number} [attemptBudget]
       * @returns {Promise<string>}
       */
      const attempt = async (withReasoning, attemptBudget = budget) => {
        const call = await llm.prepareCall(
          {
            provider: route.provider,
            model: route.model,
            maxTokens: attemptBudget,
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
        lastFinish = typeof finish?.kind === "string" ? finish.kind : null;
        lastUsage = usage ?? null;
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
          // 不支持 reasoningEffort=off 时，推理会重新打开；给推理留出预算，避免文本块为 0。
          return attempt(false, Math.min(4000, Math.max(budget, 2000)));
        }
        throw error;
      }
    };

    const messages = buildMessages({ transcript, locale });
    let raw = await run(messages);
    let parsed = parseSuggestion(raw);
    /** @type {"none" | "retry" | "repair"} */
    let recovery = "none";
    if (parsed.suggestion === null && parsed.problem !== null) {
      const plan = recoveryFor({ raw, baseMaxTokens: maxTokens, problem: parsed.problem });
      recovery = plan.plan === "escalate" ? "retry" : "repair";
      const summary = emptyOutputSummary({
        finish: lastFinish,
        usage: lastUsage,
        budget: maxTokens,
      });
      this.warn(
        `model output did not match the card schema (${parsed.problem.kind}: ${parsed.problem.detail}), ${
          plan.plan === "escalate"
            ? `empty output (${summary}), retrying with maxTokens=${plan.budget}`
            : "repairing with the transcript"
        }`,
      );
      // 空输出：可能是推理模型把 maxTokens 全用在推理块上（finish=max-tokens、textLen=0）。
      // 原样重发只会再空一次——升级预算重发同一个请求；仍空才带对话要求「只输出 JSON」。
      if (plan.plan === "escalate") {
        raw = await run(messages, plan.budget);
        parsed = parseSuggestion(raw);
        if (parsed.suggestion === null) {
          this.warn(
            `retry with maxTokens=${plan.budget} still empty (${emptyOutputSummary({
              finish: lastFinish,
              usage: lastUsage,
              budget: plan.budget,
            })}), asking for JSON-only repair`,
          );
          raw = await run(
            buildRepairMessage({ transcript, raw: "", problem: "json", detail: "empty output" }),
            plan.budget,
          );
          parsed = parseSuggestion(raw);
        }
      } else {
        // 有内容但格式不对：带同一段对话再要一次，只要求它修格式。
        raw = await run(
          buildRepairMessage({
            transcript,
            raw,
            problem: parsed.problem.kind,
            // 把「上一次 label 到底几字」带进修复请求：模型数不准自己的字数
            detail: parsed.problem.detail,
          }),
          plan.budget,
        );
        parsed = parseSuggestion(raw);
      }
    }
    if (parsed.suggestion === null) {
      const detail =
        parsed.problem === null ? "unknown" : `${parsed.problem.kind}:${parsed.problem.detail}`;
      this.counters.failed += 1;
      this.lastError = `model output did not match the card schema (${detail})`;
      this.markFailure(this.lastError);
      this.warn(
        `model output did not match the card schema: ${detail} (${emptyOutputSummary({
          finish: lastFinish,
          usage: lastUsage,
          budget: maxTokens,
        })})`,
      );
      return { ok: false, failure: "schema" };
    }
    if (parsed.detail !== "") {
      // 宽容解析里被容忍的问题（截断/丢弃单条），留在日志里便于复盘提示词
      this.warn(`card normalized with tolerated problems: ${parsed.detail}`);
    }
    // 落地校验：结构合法但讲不到这段对话（自述生成过程 / 凭空想象）的卡，一律不写进会话。
    if (!isGroundedIn(groundableText(parsed.suggestion), context.material)) {
      const detail = `identityTokens=${identityTokens(groundableText(parsed.suggestion)).size} matched=0 recovery=${recovery}`;
      this.warn(`discarded a card that is not grounded in this conversation (${detail})`);
      this.lastError = "generated card is not grounded in this conversation";
      return { ok: false, failure: "ungrounded", detail };
    }
    return {
      ok: true,
      suggestion: parsed.suggestion,
      route: `${route.provider}/${route.model}`,
      latencyMs: Date.now() - startedAt,
      repaired: recovery === "repair",
      recovery,
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
   * 旧版本设置（v1 / v2）的迁移结果会在这里**写回一次**（之后不再写）。
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
    // 并发调用（两个 diagnostics / diagnostics + report）必须共享同一个创建过程：
    // 各自 await 之后各自 createEventLog + ensureMeta 会写出两条 meta。
    if (this.eventLogPromise === null) {
      this.eventLogPromise = (async () => {
        const identity = await buildIdentity().catch(() => ({ version: "" }));
        const log = createEventLog({
          home: this.dataRoot,
          logger: this.logger,
          pkg: typeof identity.version === "string" ? identity.version : "",
        });
        this.eventLogHandle = log;
        // 起算点必须排在第一条事件之前：报表靠它算天数，顺序错了 meta 就没用。
        const tier = (await this.currentSettings().catch(() => DEFAULT_SETTINGS)).cardThreshold;
        this.metaReady = log.ensureMeta({ tier }).catch(() => false);
        return log;
      })();
    }
    return this.eventLogPromise;
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
      if (this.metaReady !== null) await this.metaReady;
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
   * 取消该会话在途的生成（用户已经点了胶囊，或同一会话又要起一次新生成）。
   * 注意 `turn/start` **不**走这里：那条路径只 `supersede()`，让生成跑完变成 `shown:false` 候选。
   * @param {string} sessionId
   */
  abortInflight(sessionId) {
    this.inflight.cancel(sessionId, new Error("superseded"));
  }

  /**
   * 记录一次「生成跑完时这一轮已经翻过去了」：候选以 shown:false 落库，不算失败。
   * 不碰 skipped / aborted / failed 三个计数（它既不是跳过也不是失败）。
   */
  markSuperseded() {
    this.lastSkip = {
      kind: "superseded",
      reason: "the user moved on before the card was ready; kept as a hidden candidate",
      at: Date.now(),
    };
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
      this.rememberPending(sessionId, turn, card.options, card.createdAt || Date.now());
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
        this.rememberPending(sessionId, turn, existing.options, Date.now());
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
      // F-2：被取代的旧回合会跑到 20s，用户这时点「补生成」不该被 inflight 挡住。
      // 只有「本次要的回合、且未被取代」才值得等；其余（别的回合 / superseded）取消后继续。
      const pending = this.inflight.get(sessionId);
      if (pending !== undefined) {
        if (inflightBlocksGenerateNow(pending, turn)) {
          return {
            ok: false,
            reason: "inflight",
            detail: "a generation for this turn is still running",
          };
        }
        this.abortInflight(sessionId);
      }
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
        : { ok: false, reason: result.reason, detail: result.detail ?? "" };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 客户端查询「这个会话现在的生成状态」：是否有在途生成、最近一次结束的生成结果。
   * **只读**（不写会话日志、不发模型调用），客户端在补生成入口挂载时查一次，把自动生成的失败
   * 显示成「重试 + 原因摘要」（USIM-U2-04）；在途时进入等待态并轮询它，而不是把一次 `inflight`
   * 回执当成永久状态。旧客户端/旧宿主不认识这个方法也没关系：调用失败时客户端按「没有信息」降级。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async generateState(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      if (sessionId === "") return { ok: false, reason: "missing" };
      const pending = this.inflight.get(sessionId);
      return {
        ok: true,
        inflight: pending !== undefined,
        // 在途生成对应的回合（没有在途时为 null）：客户端只在「同一回合」时等待，
        // 别的回合（例如被 superseded 的旧回合）不该挡住本回合的补生成按钮。
        turn: pending === undefined ? null : pending.turn,
        last: this.generateStatus.last(sessionId),
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 取消该会话的在途生成（客户端超时兜底用）：UI 结束 loading 前先让服务端真的停下来，
   * 避免「界面说超时了、后台还在跑」（USIM-U2-04 的要求）。只取消、不写决策/不写会话日志。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async cancelGenerate(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      if (sessionId === "") return { ok: false, reason: "missing" };
      const pending = this.inflight.get(sessionId);
      if (pending === undefined) return { ok: true, cancelled: false };
      // 复审 B2：带 turn 时只取消同一回合的在途生成，避免过期超时误杀更晚/别的窗口的生成。
      const turn = typeof request?.turn === "number" ? request.turn : null;
      if (turn !== null && pending.turn !== turn) return { ok: true, cancelled: false };
      this.abortInflight(sessionId);
      return { ok: true, cancelled: true };
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
   * `write === false` 时只算指标、不落盘（设置页的「回顾」块用，避免开一次设置就写一份报告）。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async report(request) {
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
      const write = request?.write !== false;
      const path = write ? await writeReport({ home: this.dataRoot, markdown }) : "";
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
          // 待追踪卡片数（会话级上限 32）：排障时能看出「有卡在等用户下一步」。
          followupPending: this.followups.size,
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
declareRemote(NextStepService, "generateState");
declareRemote(NextStepService, "cancelGenerate");
declareRemote(NextStepService, "impression");
declareRemote(NextStepService, "report");
declareRemote(NextStepService, "settings");
declareRemote(NextStepService, "updateSettings");
declareRemote(NextStepService, "diagnostics");

export { DEFAULT_SETTINGS };
