// @ts-check
// host 半：服务名 nextStep。
//
// 职责：一轮正常结束 → 一次额外模型调用 → 把「决策卡」写进会话日志（plugin record）；
// 客户端通过投影读卡片、通过 Remote 写决策。状态全部属于会话数据，刷新/切会话/fork 后都能重建。
//
// 说明：插件可以 import 宿主的 @deepseek-ai/* 包（运行时由宿主解析），但不能把它们写进
// package.json 的 dependencies —— `pnpm check` 会拦（AGENTS.md 硬性约定 3）。
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { abortReasonOf, abortReasonText, abortSkipKind, TIMEOUT_MESSAGE } from "./abort-reason.js";
import { buildIdentity } from "./build-info.js";
import { cheapSkipReason } from "./gates.js";
import {
  CARD_RECORD,
  DECISION_RECORD,
  isCardData,
  isDecisionData,
  nextStepProjection,
} from "./projection.js";
import {
  buildMessages,
  buildSystemPrompt,
  parseSuggestion,
  renderTranscript,
  textOf,
} from "./prompt.js";
import { shouldSkipForQueue } from "./queue-gate.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

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
 * 读会话日志里的卡片与决策（全量，用于预算与去重；渲染走投影，不读这里）。
 * @param {any} session
 * @returns {{ cards: Map<number, any>, decisions: Map<number, any> }}
 */
function scanSession(session) {
  /** @type {Map<number, any>} */
  const cards = new Map();
  /** @type {Map<number, any>} */
  const decisions = new Map();
  let events = [];
  if (typeof session?.snapshotEvents === "function") events = session.snapshotEvents();
  else if (Array.isArray(session?.log)) events = session.log;
  for (const event of Array.isArray(events) ? events : []) {
    const record = pluginRecordOf(event);
    if (record === undefined) continue;
    if (record.type === CARD_RECORD && isCardData(record.data)) {
      if (!cards.has(record.data.turn)) cards.set(record.data.turn, record.data);
    } else if (record.type === DECISION_RECORD && isDecisionData(record.data)) {
      if (!decisions.has(record.data.turn)) decisions.set(record.data.turn, record.data);
    }
  }
  return { cards, decisions };
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
    /** @type {{ generated: number, failed: number, aborted: number, skipped: number, skippedByModel: number, acted: number, dismissed: number }} */
    this.counters = {
      generated: 0,
      failed: 0,
      // 生成被中止（超时/取消）。单独计数：中止既不写会话日志、原来也不计数，
      // 导致「卡片没出来」在诊断里完全无痕（见 abort-reason.js 的说明）。
      aborted: 0,
      skipped: 0,
      skippedByModel: 0,
      acted: 0,
      dismissed: 0,
    };
    /** 最近一次失败原因（诊断面板用）。 */
    this.lastError = "";
    /**
     * 最近一次「这一轮没出卡」的原因——「我觉得该出卡却没出」时，先看这里。
     * kind: paused | queued | budget | model | failed
     * @type {{ kind: string, reason: string, at: number } | null}
     */
    this.lastSkip = null;
    /** 每会话在途生成（abort 用）。 @type {Map<string, AbortController>} */
    this.inflight = new Map();
    /** 设置缓存（1s TTL），使「改文件即生效」成立又不必每次读盘。 */
    this.settingsCache = { at: 0, value: /** @type {any} */ (null) };
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

  /** 监听回合结束。 */
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
    // 新一轮一旦开始，上一轮的生成就没有意义了（省一次请求、也避免把过期卡写进日志）。
    if (event?.type === "turn/start" && typeof session?.id === "string") {
      this.abortInflight(session.id);
      return;
    }
    if (event?.type !== "turn/end") return;
    if (event?.data?.reason?.kind !== "completed") return;
    const turn = event?.data?.turn;
    if (!Number.isSafeInteger(turn)) return;
    if (isSubagentSession(session)) return;
    if (typeof session?.id !== "string") return;
    // 不阻塞事件分发：生成是异步的，失败静默。
    void this.maybeGenerate(session, turn, event);
  }

  /**
   * 自动出卡：先过便宜的闸，再让模型自评 needed。
   * 关闭开关 = 到这里直接返回，不发请求。
   * @param {any} session
   * @param {number} turn
   * @param {any} event
   * @returns {Promise<void>}
   */
  async maybeGenerate(session, turn, event) {
    const settings = await this.currentSettings();
    if (!settings.enabled || !settings.card) return;
    const sessionId = session.id;
    const { cards } = scanSession(session);

    // 便宜闸统一在 gates.js：不通过就不发那次模型调用。
    // 「上一轮报错/被中断」和「回答太短」是新加的两条——前者不该在旁边推销下一步，
    // 后者没有足够上下文，生成出来必然是套话。
    const messages = typeof session.deriveMessages === "function" ? session.deriveMessages() : [];
    let lastAnswerChars = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        lastAnswerChars = textOf(messages[index]).length;
        break;
      }
    }
    const skip = cheapSkipReason({
      enabled: settings.enabled,
      cardEnabled: settings.card,
      pauseUntil: settings.pauseUntil,
      now: Date.now(),
      queued: shouldSkipForQueue(queuedCountOf(this.ctx, sessionId)) ? 2 : 0,
      cardsForTurn: cards.has(turn),
      cardsInSession: cards.size,
      maxCards: settings.maxCardsPerSession,
      endKind: event?.data?.reason?.kind,
      answerChars: lastAnswerChars,
    });
    if (skip !== null) {
      if (skip.reason !== "disabled") this.markSkip(skip.reason, skip.detail);
      return;
    }
    await this.writeCardFor(session, settings, {
      turn,
      seq: Number.isSafeInteger(event?.seq) ? event.seq : 0,
      force: false,
    });
  }

  /**
   * 跑一次模型调用并为该轮写卡（自动门控与手动补生成共用）。
   * @param {any} session
   * @param {any} settings
   * @param {{ turn: number, seq: number, force: boolean }} options force=true 时忽略模型的 needed=false
   * @returns {Promise<{ ok: true, card: any } | { ok: false, reason: string }>}
   */
  async writeCardFor(session, settings, options) {
    const sessionId = session.id;
    const turn = options.turn;
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
        return { ok: false, reason: "aborted" };
      }
      // 同一会话又起了新的一次生成：这次被后来者取代，算取消而不是超时。
      if (this.inflight.get(sessionId) !== controller) {
        this.markAbort(undefined, settings.timeoutMs);
        return { ok: false, reason: "aborted" };
      }
      if (result === null) {
        this.counters.failed += 1;
        this.lastError = "model output did not match the card schema";
        this.markFailure(this.lastError);
        return { ok: false, reason: "schema" };
      }
      // 模型自评「这一轮不需要继续」：自动门控下不出卡，但把理由留给诊断。
      if (result.suggestion.needed === false && options.force !== true) {
        this.counters.skippedByModel += 1;
        this.markSkip("model", result.suggestion.reason);
        return { ok: false, reason: "not-needed" };
      }
      const card = {
        turn,
        seq: options.seq,
        summary: result.suggestion.summary,
        question: result.suggestion.question,
        options: result.suggestion.options,
        ...(result.suggestion.nextPrompt === undefined
          ? {}
          : { nextPrompt: result.suggestion.nextPrompt }),
        model: result.route,
        createdAt: Date.now(),
      };
      if (!isCardData(card)) {
        this.counters.failed += 1;
        this.lastError = "generated card failed validation";
        this.markFailure(this.lastError);
        return { ok: false, reason: "schema" };
      }
      appendPluginRecord(session, CARD_RECORD, card);
      this.counters.generated += 1;
      this.lastError = "";
      return { ok: true, card };
    } catch (error) {
      // 超时/取消会让 generate() 以抛错收场（不是返回 null）：这种中止原来完全无痕，
      // 既不计 failed 也不写 lastSkip，诊断里看不到——所以先单独归类。
      if (controller.signal.aborted) {
        this.markAbort(controller.signal.reason, settings.timeoutMs);
        return { ok: false, reason: "aborted" };
      }
      // 宿主自己抛的错误里也可能写着超时（定时器还没触发）：同样按中止记，不记成 failed。
      if (abortReasonOf(error) === "timeout") {
        this.markAbort(error, settings.timeoutMs);
        return { ok: false, reason: "aborted" };
      }
      this.counters.failed += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markFailure(this.lastError);
      this.warn("card generation failed", error);
      return { ok: false, reason: "failed" };
    } finally {
      clearTimeout(timer);
      if (this.inflight.get(sessionId) === controller) this.inflight.delete(sessionId);
    }
  }

  /**
   * 记录一次「没出卡」及其原因（诊断面板显示最近一次）。
   * @param {string} kind paused | queued | budget | model | failed
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
   * 一次额外补全：prepareCall + stream，产出已校验的建议。
   * @param {any} session
   * @param {any} settings
   * @param {AbortSignal} signal
   * @returns {Promise<{ suggestion: NonNullable<ReturnType<typeof parseSuggestion>>, route: string } | null>}
   */
  async generate(session, settings, signal) {
    const llm = serviceOf(this.ctx, "llm");
    if (llm === undefined || typeof llm.prepareCall !== "function") {
      throw new Error("host llm service is unavailable");
    }
    const route = this.routeFor(session, settings);
    const maxTokens = settings.maxTokens;
    const messages = buildMessages({
      transcript: renderTranscript(session.deriveMessages?.() ?? [], {
        limit: settings.contextMessages,
      }),
      locale: this.localeName(),
    }).map((message) =>
      createUserMessage({ content: message.content, source: { kind: "next-step" } }),
    );
    const system = buildSystemPrompt({ locale: this.localeName() });

    /**
     * @param {boolean} withReasoning
     * @returns {Promise<string>}
     */
    const run = async (withReasoning) => {
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
      const options = {
        ...call.config,
        messages,
        system,
        sessionId: session.id,
        purpose: "next-step",
        signal,
      };
      for await (const chunk of call.stream(options)) {
        signal.throwIfAborted();
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

    let raw;
    try {
      raw = await run(true);
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === "UNSUPPORTED_REASONING_EFFORT" || code === "INVALID_MODEL_REASONING") {
        raw = await run(false);
      } else {
        throw error;
      }
    }
    const suggestion = parseSuggestion(raw);
    if (suggestion === null) {
      // 解析失败是静默的；把模型输出的开头留在日志里，排障时能分辨「模型跑偏」还是「宿主链路坏」。
      this.warn(`model output did not match the card schema: ${String(raw ?? "").slice(0, 200)}`);
      return null;
    }
    return { suggestion, route: `${route.provider}/${route.model}` };
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
   * @returns {Promise<any>}
   */
  async currentSettings() {
    const now = Date.now();
    if (this.settingsCache.value !== null && now - this.settingsCache.at < 1000) {
      return this.settingsCache.value;
    }
    const value = await loadSettings({ home: this.dataRoot, logger: this.logger });
    this.settingsCache = { at: now, value };
    return value;
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
      const { cards, decisions } = scanSession(session);
      const card = cards.get(turn);
      if (card === undefined) return { ok: false, reason: "missing" };
      if (decisions.has(turn)) return { ok: false, reason: "stale" };
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
      const { cards, decisions } = scanSession(session);
      if (!cards.has(turn)) return { ok: false, reason: "missing" };
      if (!decisions.has(turn)) {
        appendPluginRecord(session, DECISION_RECORD, { turn, phase: "dismissed", at: Date.now() });
      }
      this.counters.dismissed += 1;
      return { ok: true };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 手动补生成：为最近一个正常结束的回合强制出一张卡（用户点「生成」或 /next-step）。
   * 自动门控被跳过时用它兜底；模型判断 needed=false 时也照出（用户明确要了）。
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
      const { cards } = scanSession(session);
      if (cards.has(turn)) return { ok: false, reason: "exists" };
      if (cards.size >= settings.maxCardsPerSession) return { ok: false, reason: "budget" };
      if (this.inflight.has(sessionId)) return { ok: false, reason: "inflight" };
      const result = await this.writeCardFor(session, settings, {
        turn,
        seq: latest.seq,
        force: true,
      });
      return result.ok === true ? { ok: true } : { ok: false, reason: result.reason };
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
      return {
        ok: true,
        stats: {
          ...this.counters,
          inflight: this.inflight.size,
          lastError: this.lastError,
          lastSkip: this.lastSkip,
          dataRoot: this.dataRoot,
          settings: await this.currentSettings(),
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
declareRemote(NextStepService, "settings");
declareRemote(NextStepService, "updateSettings");
declareRemote(NextStepService, "diagnostics");

export { DEFAULT_SETTINGS };
