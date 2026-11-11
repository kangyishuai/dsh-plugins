// @ts-check
// host 半：服务名 advisor。
//
// 职责：
//   1) 注册 `advisor` 工具（主模型在关键时刻徵询第二模型，结果作为工具结果回到主模型）；
//   2) 注册 `/advisor` 命令（status / ask / cancel / doctor / on / off / <route>）；
//   3) 对客户端暴露代理 RPC（routes / models / modelInfo / candidates / setModel / state / doctor）；
//   4) shadow 模式：回合结束后跑一次顾问，只记账不回灌。
//
// 关键工程约束（见 docs/runtime/0.2.2-rc.1.md §9.15）：
//   - 额外模型调用**不产生 usage 事件**，成本必须自己记（ledger.js）；
//   - `llm/stream` 会看见我们自己的调用 ⇒ 一律按 `purpose:"advisor"` 过滤（递归防护）；
//   - `session/event` 监听器里**同步** append 会撞重入保护 ⇒ 一律异步一拍再写。
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { callAdvisor } from "./call.js";
import {
  checkBudget,
  estimateCostUsd,
  fingerprint,
  isHollowAdvice,
  rememberFingerprint,
} from "./guard.js";
import { createLedger } from "./ledger.js";
import { parseAdvice, summarizeAdvice, TOOL_DESCRIPTION } from "./prompt.js";
import { pairingCheck, resolveRoute } from "./route.js";
import { isConfigured, loadSettings, mergeSettings, saveSettings } from "./settings.js";
import { renderToolOutput, TOOL_NAME, TOOL_OUTPUT_SCHEMA, TOOL_PARAMETERS } from "./tool-schema.js";
import { buildTranscript } from "./transcript.js";

/** 命令名：`/advisor`。 */
export const COMMAND_NAME = "advisor";

/**
 * 与 session-rewind / next-step 相同的原因：运行时不支持装饰器语法，用命令式方式登记 Remote。
 * @param {any} Proto
 * @param {string} method
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
    throw new Error(`advisor: cannot declare Remote method ${method}`);
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
  return joinHome();
}

/** @returns {string} */
function joinHome() {
  const env = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return env === "" ? ".dsh" : `${env}/.dsh`;
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

/**
 * 子代理会话判定（shadow 只在顶层会话跑，避免多份顾问调用叠加）。
 * @param {any} session
 * @returns {boolean}
 */
function isSubagentSession(session) {
  const header = session?.header;
  return header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0;
}

/**
 * 把错误统一成 RemoteError（客户端只看到 code + message）。
 * @param {unknown} error
 * @param {string} [fallbackCode]
 * @returns {never}
 */
function rethrowRemote(error, fallbackCode = "advisor/failed") {
  if (error instanceof RemoteError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new RemoteError(fallbackCode, message);
}

export class AdvisorService extends TypertRemoteService {
  /**
   * @param {any} ctx
   * @param {any} [config]
   */
  constructor(ctx, config) {
    super(ctx, "advisor");
    this.config = config ?? {};
    this.logger = ctx?.logger ?? console;
    this.dataRoot = resolveDataRoot(this.config);
    this.ledger = createLedger({ home: this.dataRoot, logger: this.logger });
    void this.ledger.ready();
    /** @type {{ at: number, value: any }} */
    this.settingsCache = { at: 0, value: null };
    /** 每会话回合序号（工具路径拿不到 turn，自己数）。 @type {Map<string, number>} */
    this.turnOf = new Map();
    /** 在途徵询（cancel 用）。 @type {Map<string, AbortController>} */
    this.inflight = new Map();
    /** 去重表（shadow 投递用）。 @type {Map<string, number>} */
    this.seen = new Map();
    /** 最近一次结果（status / 工具卡 / 诊断）。 @type {any} */
    this.lastResult = null;
    /** 每会话已投递的建议条数（sessionCap 用）。 @type {Map<string, number>} */
    this.delivered = new Map();
    /** 每会话最近一次「为什么没徵询」。 @type {Map<string, string>} */
    this.lastSkip = new Map();
    /** @type {{ calls: number, failures: number, skipped: number, shadow: number }} */
    this.counters = { calls: 0, failures: 0, skipped: 0, shadow: 0 };

    this.installTool();
    this.installCommand();
    this.installShadowListener();
  }

  // ---- 设置 -------------------------------------------------------------

  /**
   * 当前设置：文件优先，1s 缓存（改文件即生效，不必重启）。
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
   * 写设置（原子落盘 + 失效缓存）。
   * @param {unknown} patch
   * @returns {Promise<any>}
   */
  async writeSettings(patch) {
    const current = await this.currentSettings();
    const next = mergeSettings(current, patch);
    const saved = await saveSettings({ home: this.dataRoot, settings: next });
    this.settingsCache = { at: Date.now(), value: saved };
    return saved;
  }

  // ---- 宿主服务代理（客户端不直接碰 llm） --------------------------------

  /** @returns {any} */
  llm() {
    return serviceOf(this.ctx, "llm");
  }

  /**
   * 会话当前主模型（配对校验用）。
   * @param {any} session
   * @returns {{ provider: string, model: string }|undefined}
   */
  mainModelOf(session) {
    const sessionId = typeof session?.id === "string" ? session.id : "";
    const agents = serviceOf(this.ctx, "agents");
    const current = agents?.get?.(sessionId)?.model?.current?.();
    if (typeof current?.provider === "string" && typeof current?.model === "string") {
      return { provider: current.provider, model: current.model };
    }
    return undefined;
  }

  /**
   * 已注册的路由（含用户手写的 pi-ai 路由）。
   * @returns {Promise<Array<{ provider: string, displayName: string, source: "catalog"|"declared" }>>}
   */
  async listRoutes() {
    const llm = this.llm();
    /** @type {Map<string, any>} */
    const out = new Map();
    try {
      for (const provider of (await llm?.listProviders?.()) ?? []) {
        if (typeof provider?.id !== "string") continue;
        out.set(provider.id, {
          provider: provider.id,
          displayName:
            typeof provider.name === "string" && provider.name !== "" ? provider.name : provider.id,
          source: "catalog",
        });
      }
    } catch (error) {
      this.warn("listProviders failed", error);
    }
    try {
      for (const entry of (await llm?.listConfigurableProviders?.()) ?? []) {
        if (typeof entry?.provider !== "string") continue;
        const existing = out.get(entry.provider);
        const displayName =
          typeof entry.displayName === "string" && entry.displayName !== ""
            ? entry.displayName
            : entry.provider;
        if (existing === undefined) {
          out.set(entry.provider, { provider: entry.provider, displayName, source: "declared" });
        } else {
          existing.displayName = displayName;
        }
      }
    } catch (error) {
      this.warn("listConfigurableProviders failed", error);
    }
    return [...out.values()];
  }

  /**
   * 某路由下的模型。
   * @param {string} provider
   * @returns {Promise<Array<{ id: string, name: string }>>}
   */
  async listModelsOf(provider) {
    if (typeof provider !== "string" || provider === "") return [];
    try {
      const models = (await this.llm()?.listModels?.(provider)) ?? [];
      return models
        .filter((/** @type {any} */ model) => typeof model?.id === "string")
        .map((/** @type {any} */ model) => ({
          id: model.id,
          name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
        }));
    } catch (error) {
      this.warn("listModels failed", error);
      return [];
    }
  }

  /**
   * 精确模型元数据（思考档下拉的唯一可信来源）。
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{ provider: string, model: string, contextWindow?: number, defaultMaxTokens?: number, efforts: Array<{ id: string }>, defaultEffort?: string }|null>}
   */
  async resolveModel(provider, model) {
    try {
      const info = await this.llm()?.resolveModelInfo?.(provider, model);
      if (info === undefined || info === null) return null;
      const efforts = Array.isArray(info.reasoning?.efforts)
        ? info.reasoning.efforts
            .filter((/** @type {any} */ effort) => typeof effort?.id === "string")
            .map((/** @type {any} */ effort) => ({ id: effort.id }))
        : [];
      return {
        provider,
        model,
        ...(typeof info.context?.contextWindow === "number"
          ? { contextWindow: info.context.contextWindow }
          : {}),
        ...(typeof info.defaultMaxTokens === "number"
          ? { defaultMaxTokens: info.defaultMaxTokens }
          : {}),
        efforts,
        ...(typeof info.reasoning?.defaultEffort === "string"
          ? { defaultEffort: info.reasoning.defaultEffort }
          : {}),
      };
    } catch (error) {
      this.warn("resolveModelInfo failed", error);
      return null;
    }
  }

  // ---- 核心：一次徵询 ----------------------------------------------------

  /**
   * 跑一次顾问徵询。所有失败都返回结构化结果，绝不抛。
   * @param {{ session: any, trigger: "tool"|"shadow"|"manual", focus?: string, signal?: AbortSignal }} input
   * @returns {Promise<any>}
   */
  async runAdvisor(input) {
    const { session, trigger } = input;
    const settings = await this.currentSettings();
    const sessionId = typeof session?.id === "string" ? session.id : "";

    /** @param {string} reason @param {string} [code] */
    const skip = (reason, code = "skipped") => {
      if (sessionId !== "") this.lastSkip.set(sessionId, reason);
      this.counters.skipped += 1;
      return {
        status: "skipped",
        code,
        reason,
        advice: "",
        severity: "nit",
        risks: [],
        acceptance: [],
        evidence: [],
      };
    };

    if (settings.mode === "off") return skip("顾问已关闭（/advisor on 打开）", "disabled");
    if (!isConfigured(settings)) return skip("还没配置顾问模型（/advisor 选择）", "not_configured");
    // shadow 的语义是「只记账、不回灌」。模型主动徵询时同样不给建议，
    // 否则它照样会把建议吃进上下文，shadow 就名不副实。
    if (trigger === "tool" && settings.mode === "shadow") {
      return skip(
        "shadow 模式只记账，不把建议回灌给模型（/advisor on 切到 advisory）",
        "shadow_mode",
      );
    }

    const mainModel = this.mainModelOf(session);
    const resolved = resolveRoute({ settings, mainModel });
    if (resolved.route.provider === "" || resolved.route.model === "") {
      return skip("没有可用的模型路由", "no_route");
    }

    const pairing = pairingCheck({
      tiers: settings.tiers,
      main: mainModel ?? { provider: "unknown", model: "unknown" },
      advisor: resolved.route,
      enforcement: settings.pairingEnforcement,
    });
    if (!pairing.allowed) return skip(`配对校验未通过：${pairing.message}`, "pairing_rejected");

    const turn = this.turnOf.get(sessionId) ?? 0;
    const now = Date.now();
    const counters = this.ledger.counters(sessionId, now);
    const budget = checkBudget({ settings, counters, now });
    if (!budget.ok) {
      this.counters.skipped += 1;
      /** @type {Record<string, string>} */
      const reasons = {
        turn_limit: `本回合已达上限（${budget.used}/${budget.limit}）`,
        session_limit: `本会话已达上限（${budget.used}/${budget.limit}）`,
        hour_limit: `本小时已达上限（${budget.used}/${budget.limit}）`,
        day_budget: `今日预算已用完（$${budget.used.toFixed(4)}/$${budget.limit}）`,
      };
      const reason = reasons[budget.code] ?? "预算不足";
      if (sessionId !== "") this.lastSkip.set(sessionId, reason);
      return {
        status: "skipped",
        code: "budget_exhausted",
        reason,
        advice: "",
        severity: "nit",
        risks: [],
        acceptance: [],
        evidence: [],
      };
    }

    // 上下文：包含工具调用与结果（这是与「只发文本」的关键区别）。
    const messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : [];
    const transcript = buildTranscript(messages, {
      scope: settings.privacyScope,
      redactSecrets: settings.redact,
      maxChars: settings.maxInputChars,
    });
    if (transcript.text.trim() === "") return skip("会话里还没有可发送的内容", "empty_transcript");

    const controller = new AbortController();
    if (sessionId !== "") this.inflight.set(sessionId, controller);
    const signal =
      input.signal === undefined
        ? controller.signal
        : typeof AbortSignal.any === "function"
          ? AbortSignal.any([input.signal, controller.signal])
          : controller.signal;

    const estimatedCost = estimateCostUsd({
      inputTokens: Math.ceil(transcript.text.length / 3),
      outputTokens: settings.maxTokens / 2,
      priceInputPerMTok: settings.priceInputPerMTok,
      priceOutputPerMTok: settings.priceOutputPerMTok,
    });

    const started = Date.now();
    let call;
    try {
      call = await callAdvisor({
        llm: this.llm(),
        route: resolved.route,
        settings,
        transcript: transcript.text,
        focus: input.focus,
        locale: this.localeName(),
        sessionId,
        signal,
        logger: this.logger,
      });
    } finally {
      if (sessionId !== "" && this.inflight.get(sessionId) === controller)
        this.inflight.delete(sessionId);
    }

    const costUsd =
      call.ok && call.usage !== undefined
        ? estimateCostUsd({
            inputTokens: call.usage.inputTokens,
            outputTokens: call.usage.outputTokens,
            priceInputPerMTok: settings.priceInputPerMTok,
            priceOutputPerMTok: settings.priceOutputPerMTok,
          })
        : 0;

    const usageLine = call.ok
      ? `${formatTokens(call.usage?.inputTokens ?? 0)} in / ${formatTokens(call.usage?.outputTokens ?? 0)} out / ${formatMs(call.ms)}${costUsd > 0 ? ` / ≈$${costUsd.toFixed(4)}` : ""}`
      : `${formatMs(Date.now() - started)}`;

    const baseResult = {
      status: /** @type {string} */ ("unavailable"),
      code: call.code ?? "error",
      reason: call.message ?? "",
      advice: "",
      severity: "nit",
      risks: [],
      acceptance: [],
      evidence: [],
      model: `${resolved.route.provider}/${resolved.route.model}`,
      effort: call.effort ?? "",
      usage: usageLine,
      pairing: { kind: pairing.kind, message: pairing.message },
      sameAsMain: resolved.sameAsMain,
      truncated: transcript.stats.truncated,
      redactions: transcript.stats.redactions,
    };

    if (!call.ok) {
      this.counters.failures += 1;
      this.lastResult = baseResult;
      await this.ledger.record({
        at: new Date().toISOString(),
        sessionId,
        trigger,
        provider: resolved.route.provider,
        model: resolved.route.model,
        effort: call.effort ?? "",
        verdict: "unavailable",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        ms: Date.now() - started,
        code: baseResult.code,
      });
      return baseResult;
    }

    const parsed = parseAdvice(call.text ?? "");
    const usage = call.usage;
    this.ledger.noteCall(sessionId, { turn, costUsd, at: Date.now() });
    this.counters.calls += 1;

    if (!parsed.ok) {
      const result = { ...baseResult, status: "unavailable", code: `advice_${parsed.reason}` };
      this.counters.failures += 1;
      this.lastResult = result;
      await this.ledger.record({
        at: new Date().toISOString(),
        sessionId,
        trigger,
        provider: resolved.route.provider,
        model: resolved.route.model,
        effort: call.effort ?? "",
        verdict: "unavailable",
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        costUsd,
        ms: Date.now() - started,
        code: result.code,
      });
      return result;
    }

    const advice = parsed.advice;
    const hollow = advice.verdict === "reviewed" && isHollowAdvice(advice.advice);

    // 会话级投递上限：到顶后只放 blocker（长任务真出大事时仍然能说话）。
    const delivered = this.delivered.get(sessionId) ?? 0;
    if (
      advice.verdict === "reviewed" &&
      !hollow &&
      settings.sessionCap > 0 &&
      delivered >= settings.sessionCap &&
      advice.severity !== "blocker"
    ) {
      await this.ledger.record({
        at: new Date().toISOString(),
        sessionId,
        trigger,
        provider: resolved.route.provider,
        model: resolved.route.model,
        effort: call.effort ?? "",
        verdict: "declined",
        severity: advice.severity,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        costUsd,
        ms: Date.now() - started,
        code: "session_cap",
      });
      const capped = {
        ...baseResult,
        status: "skipped",
        code: "session_cap",
        reason: `本会话已投递 ${delivered} 条建议（上限 ${settings.sessionCap}），仅 blocker 会继续投递`,
      };
      this.lastResult = capped;
      if (sessionId !== "") this.lastSkip.set(sessionId, "已达会话投递上限");
      this.counters.skipped += 1;
      return capped;
    }
    const result = {
      ...baseResult,
      status: advice.verdict === "declined" || hollow ? "declined" : "reviewed",
      code: "ok",
      advice: advice.advice,
      severity: advice.severity,
      risks: advice.risks,
      acceptance: advice.acceptance,
      evidence: advice.evidence,
      summary: summarizeAdvice(advice),
    };
    this.lastResult = result;

    await this.ledger.record({
      at: new Date().toISOString(),
      sessionId,
      trigger,
      provider: resolved.route.provider,
      model: resolved.route.model,
      effort: call.effort ?? "",
      verdict: result.status === "reviewed" ? "reviewed" : "declined",
      severity: result.severity,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      costUsd,
      ms: Date.now() - started,
    });
    if (result.status === "reviewed" && settings.sessionCap > 0 && sessionId !== "") {
      this.delivered.set(sessionId, (this.delivered.get(sessionId) ?? 0) + 1);
    }
    if (trigger === "shadow") this.counters.shadow += 1;
    void estimatedCost;
    return result;
  }

  /**
   * 界面语言（只影响提示词里的一句说明，不参与校验）。
   * @returns {string}
   */
  localeName() {
    const configured = typeof this.config.locale === "string" ? this.config.locale : "";
    return configured === "" ? "auto" : configured;
  }

  // ---- 装配：工具 --------------------------------------------------------

  /** 注册 `advisor` 工具。失败只降级（命令与 RPC 仍然可用）。 */
  installTool() {
    try {
      this.ctx.inject?.(/** @type {any} */ (["tools"]), (/** @type {any} */ scope) => {
        scope.effect(() => {
          const definition = this.toolDefinition();
          const dispose = scope.tools.register(definition);
          return () => {
            if (typeof dispose === "function") dispose();
          };
        }, "advisor: tool");
      });
    } catch (error) {
      this.warn("cannot install advisor tool", error);
    }
  }

  /** @returns {any} */
  toolDefinition() {
    return {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolOutput },
      /**
       * @param {any} args
       * @param {any} exec
       * @returns {Promise<any>}
       */
      execute: async (args, exec) => {
        const agent = exec?.agent;
        const session = agent?.session;
        if (session === undefined || session === null) {
          return { status: "unavailable", code: "no_session", reason: "没有可用的会话上下文" };
        }
        return this.runAdvisor({
          session,
          trigger: "tool",
          focus: typeof args?.focus === "string" ? args.focus : undefined,
          signal: exec?.signal,
        });
      },
    };
  }

  // ---- 装配：命令 --------------------------------------------------------

  /** 注册 `/advisor` 命令（文本形式，任何界面都能用）。 */
  installCommand() {
    try {
      this.ctx.inject?.(/** @type {any} */ (["commands"]), (/** @type {any} */ scope) => {
        scope.effect(() => {
          const dispose = scope.commands.register({
            name: COMMAND_NAME,
            description: "Consult the advisor: status, choose a model, ask now, or turn it off",
            input: { hint: "[status|on|off|ask|cancel|doctor|<provider>/<model>]" },
            /** @param {{ agent: any, rawInput: string }} invocation */
            handler: (invocation) => this.handleCommand(invocation),
          });
          return () => {
            if (typeof dispose === "function") dispose();
          };
        }, "advisor: command");
      });
    } catch (error) {
      this.warn("cannot install advisor command", error);
    }
  }

  /**
   * @param {{ agent: any, rawInput?: string }} invocation
   * @returns {Promise<any>}
   */
  async handleCommand(invocation) {
    const raw = typeof invocation?.rawInput === "string" ? invocation.rawInput.trim() : "";
    const session = invocation?.agent?.session;
    const sessionId = typeof session?.id === "string" ? session.id : "";
    const settings = await this.currentSettings();

    if (raw === "" || raw === "status") {
      return { kind: "success", text: await this.statusText(settings, sessionId) };
    }
    if (raw === "on") {
      const next = await this.writeSettings({
        mode: isConfigured(settings)
          ? "advisory"
          : settings.mode === "off"
            ? "advisory"
            : settings.mode,
      });
      if (!isConfigured(next)) {
        return {
          kind: "error",
          text: "还没有选顾问模型。用 /advisor 打开选择器，或 /advisor <provider>/<model> 直接指定。",
        };
      }
      return { kind: "success", text: `顾问已开启（${next.provider}/${next.model}）。` };
    }
    if (raw === "off") {
      await this.writeSettings({ mode: "off" });
      return { kind: "success", text: "顾问已关闭（/advisor on 重新开启）。" };
    }
    if (raw === "shadow") {
      await this.writeSettings({ mode: "shadow" });
      return {
        kind: "success",
        text: "已切到 shadow 模式：照常调用并记账，但不把建议回灌给模型。",
      };
    }
    if (raw === "ask") {
      if (session === undefined) return { kind: "error", text: "当前没有会话。" };
      const result = await this.runAdvisor({ session, trigger: "manual" });
      return {
        kind: result.status === "reviewed" ? "success" : "error",
        text: this.describeResult(result),
      };
    }
    if (raw === "cancel") {
      const controller = this.inflight.get(sessionId);
      if (controller === undefined) return { kind: "error", text: "没有在途的顾问徵询。" };
      try {
        controller.abort(new Error("user cancelled"));
      } catch (_error) {
        /* 已中止 */
      }
      return { kind: "success", text: "已取消本次顾问徵询。" };
    }
    if (raw === "doctor") {
      const checks = await this.doctorChecks(sessionId);
      return {
        kind: "success",
        text: checks.map((check) => `${iconOf(check.status)} ${check.message}`).join("\n"),
      };
    }

    // <provider>/<model> [effort]
    const parts = raw.split(/\s+/u);
    const routePart = parts[0] ?? "";
    const slash = routePart.indexOf("/");
    if (slash <= 0) {
      return {
        kind: "error",
        text: `无法识别的参数：${raw}。可用：status / on / off / shadow / ask / cancel / doctor / <provider>/<model>`,
      };
    }
    const provider = routePart.slice(0, slash);
    const model = routePart.slice(slash + 1);
    const effort = parts[1] ?? "";
    const saved = await this.setModel({ provider, model, reasoningEffort: effort });
    if (!saved.ok) return { kind: "error", text: saved.message };
    return {
      kind: "success",
      text: `顾问已设为 ${provider}/${model}${effort === "" ? "" : ` · 思考档 ${effort}`}（下一次徵询生效）。`,
    };
  }

  /**
   * 状态文本（`/advisor status`）。
   * @param {any} settings
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async statusText(settings, sessionId) {
    const counters = this.ledger.counters(sessionId || "unknown");
    const totals = this.ledger.totals();
    const last = this.lastResult;
    const skip = sessionId === "" ? undefined : this.lastSkip.get(sessionId);
    const route = isConfigured(settings) ? `${settings.provider}/${settings.model}` : "（未配置）";
    return [
      `模式：${settings.mode}`,
      `顾问：${route}${settings.reasoningEffort === "" ? "" : ` · 思考档 ${settings.reasoningEffort}`}`,
      `本会话：${counters.sessionCalls} 次（本回合 ${counters.turnCalls}/${
        settings.maxCallsPerTurn === 0 ? "∞" : settings.maxCallsPerTurn
      }，本会话上限 ${settings.maxCallsPerSession === 0 ? "∞" : settings.maxCallsPerSession}）`,
      `累计 token：${totals.inputTokens} in / ${totals.outputTokens} out（${totals.calls} 次）`,
      `最近一次：${last === null ? "（还没有）" : `${last.status}${last.code && last.code !== "ok" ? ` · ${last.code}` : ""}${last.usage ? ` · ${last.usage}` : ""}`}`,
      `最近跳过：${skip ?? "（无）"}`,
    ].join("\n");
  }

  /**
   * @param {any} result
   * @returns {string}
   */
  describeResult(result) {
    if (result.status === "reviewed") {
      const head = `顾问（${result.model}，${result.severity}）：\n${result.advice}`;
      const risks = result.risks.length > 0 ? `\n风险：${result.risks.join("；")}` : "";
      const acceptance =
        result.acceptance.length > 0 ? `\n验收：${result.acceptance.join("；")}` : "";
      return `${head}${risks}${acceptance}\n${result.usage}`;
    }
    if (result.status === "declined") return `顾问认为无需建议。\n${result.usage ?? ""}`.trim();
    if (result.status === "skipped") return `未徵询：${result.reason}`;
    return `顾问不可用（${result.code}）：${result.reason}`;
  }

  // ---- 装配：shadow 监听 ------------------------------------------------

  /** 监听回合结束：shadow 模式跑一次顾问，只记账。 */
  installShadowListener() {
    try {
      this.ctx.on?.("session/event", (/** @type {any} */ session, /** @type {any} */ event) => {
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
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (sessionId !== "" && event?.type === "turn/start") {
      const next = (this.turnOf.get(sessionId) ?? 0) + 1;
      this.turnOf.set(sessionId, next);
      this.ledger.resetTurn(sessionId, next);
      return;
    }
    if (event?.type !== "turn/end") return;
    if (event?.data?.reason?.kind !== "completed") return;
    if (isSubagentSession(session)) return;
    // 重要：不能在事件分发里同步写会话（重入保护），必须异步一拍。
    void (async () => {
      try {
        const settings = await this.currentSettings();
        if (settings.mode !== "shadow") return;
        const result = await this.runAdvisor({ session, trigger: "shadow" });
        if (result.status === "reviewed") {
          const id = fingerprint(result.advice);
          const remembered = rememberFingerprint(this.seen, id, Date.now());
          this.seen = remembered.table;
          this.counters.skipped += remembered.duplicate ? 1 : 0;
        }
      } catch (error) {
        this.warn("shadow review failed", error);
      }
    })();
  }

  // ---- Remote 方法 ------------------------------------------------------

  /**
   * 选择器用的候选（宿主把 provider/model 拼好，客户端只渲染）。
   * @returns {Promise<any>}
   */
  async candidates() {
    try {
      const settings = await this.currentSettings();
      const routes = await this.listRoutes();
      /** @type {Array<{ label: string, items: any[] }>} */
      const groups = [];
      for (const route of routes) {
        const models = await this.listModelsOf(route.provider);
        /** @type {any[]} */
        const items = models.slice(0, 40).map((model) => ({
          id: `${route.provider}/${model.id}`,
          label: `${route.displayName} · ${model.name}`,
          detail: route.source === "declared" ? "自定义路由" : undefined,
          provider: route.provider,
          model: model.id,
        }));
        if (items.length === 0) {
          items.push({
            id: `${route.provider}/`,
            label: `${route.displayName} · （没有可用模型）`,
            detail: "打开 设置 → 模型 检查该路由",
            disabled: true,
            reason: "该路由没有列出模型；检查 baseURL / 密钥，或在 设置 → 模型 里补模型目录",
          });
        }
        groups.push({ label: route.displayName, items });
      }
      const current = isConfigured(settings)
        ? {
            id: `${settings.provider}/${settings.model}`,
            provider: settings.provider,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
            label: `${settings.provider}/${settings.model}`,
            detail:
              settings.mode === "off" ? "已配置但当前关闭" : `当前顾问 · 模式 ${settings.mode}`,
          }
        : null;
      return {
        ok: true,
        groups,
        current,
        extras: [
          { id: "off", label: "不使用顾问（off）", detail: "随时用 /advisor 重新开启" },
          {
            id: "settings",
            label: "+ 配置 provider / 模型…",
            detail: "/advisor doctor 查看缺少什么",
          },
        ],
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 设置顾问模型（选择器与命令共用）。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async setModel(request) {
    try {
      const provider = typeof request?.provider === "string" ? request.provider.trim() : "";
      const model = typeof request?.model === "string" ? request.model.trim() : "";
      const effort =
        typeof request?.reasoningEffort === "string" ? request.reasoningEffort.trim() : "";

      if (provider === "" && model === "") {
        const saved = await this.writeSettings({
          mode: "off",
          provider: "",
          model: "",
          reasoningEffort: "",
        });
        return { ok: true, route: null, settings: saved };
      }
      if (provider === "" || model === "") {
        return { ok: false, code: "invalid_route", message: "provider 与 model 必须同时给出" };
      }

      const info = await this.resolveModel(provider, model);
      if (info === null) {
        return {
          ok: false,
          code: "unknown_route",
          message: `拿不到 ${provider}/${model} 的元数据：检查该 provider 是否已在 设置 → 模型 配好（baseURL / 密钥 / 模型目录）`,
        };
      }
      if (
        effort !== "" &&
        info.efforts.length > 0 &&
        !info.efforts.some((item) => item.id === effort)
      ) {
        return {
          ok: false,
          code: "UNSUPPORTED_REASONING_EFFORT",
          message: `${provider}/${model} 不支持思考档「${effort}」。可选：${info.efforts.map((item) => item.id).join(" / ")}`,
        };
      }

      const saved = await this.writeSettings({
        provider,
        model,
        reasoningEffort: effort,
        mode: "advisory",
      });
      return {
        ok: true,
        route: { provider, model, reasoningEffort: effort },
        settings: saved,
        info,
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 当前状态（客户端状态卡用）。
   * @returns {Promise<any>}
   */
  async state() {
    try {
      const settings = await this.currentSettings();
      const totals = this.ledger.totals();
      return {
        ok: true,
        mode: settings.mode,
        route: isConfigured(settings)
          ? {
              provider: settings.provider,
              model: settings.model,
              reasoningEffort: settings.reasoningEffort,
            }
          : null,
        budgets: {
          maxCallsPerTurn: settings.maxCallsPerTurn,
          maxCallsPerSession: settings.maxCallsPerSession,
          maxCallsPerHour: settings.maxCallsPerHour,
          maxCostPerDayUsd: settings.maxCostPerDayUsd,
        },
        totals,
        last: this.lastResult,
        counters: this.counters,
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 读设置（只读）。
   * @returns {Promise<any>}
   */
  async settings() {
    try {
      const settings = await this.currentSettings();
      return { ok: true, settings, dataRoot: this.dataRoot, ledgerPath: this.ledger.path };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 合并写设置。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async updateSettings(request) {
    try {
      const patch = request?.patch ?? request ?? {};
      const saved = await this.writeSettings(patch);
      return { ok: true, settings: saved };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 代理：路由清单。
   * @returns {Promise<any>}
   */
  async routes() {
    try {
      return { ok: true, routes: await this.listRoutes() };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 代理：模型清单。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async models(request) {
    try {
      const provider = typeof request?.provider === "string" ? request.provider : "";
      return { ok: true, models: await this.listModelsOf(provider) };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 代理：模型元数据（含真实思考档）。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async modelInfo(request) {
    try {
      const provider = typeof request?.provider === "string" ? request.provider : "";
      const model = typeof request?.model === "string" ? request.model : "";
      const info = await this.resolveModel(provider, model);
      return { ok: info !== null, info };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 诊断：逐项自检，每条都给出「下一步」。
   * @param {any} request
   * @returns {Promise<any>}
   */
  async doctor(request) {
    try {
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      const checks = await this.doctorChecks(sessionId);
      return { ok: true, checks };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Array<{ id: string, status: "pass"|"warn"|"fail", message: string, action?: string }>>}
   */
  async doctorChecks(sessionId) {
    const settings = await this.currentSettings();
    /** @type {Array<{ id: string, status: "pass"|"warn"|"fail", message: string, action?: string }>} */
    const checks = [];

    const llm = this.llm();
    if (llm === undefined) {
      checks.push({
        id: "llm",
        status: "fail",
        message: "宿主 llm 服务不可用（DSH 版本不匹配？）",
      });
      return checks;
    }
    checks.push({ id: "llm", status: "pass", message: "宿主 llm 服务可用" });

    const routes = await this.listRoutes();
    checks.push(
      routes.length > 0
        ? { id: "routes", status: "pass", message: `已注册 ${routes.length} 条 provider 路由` }
        : {
            id: "routes",
            status: "fail",
            message: "没有任何 provider 路由：先在 设置 → 模型 里配置一个",
            action: "settings:models",
          },
    );

    if (!isConfigured(settings)) {
      checks.push({
        id: "route",
        status: "warn",
        message: "还没选顾问模型：/advisor 打开选择器",
        action: "advisor:pick",
      });
    } else {
      const info = await this.resolveModel(settings.provider, settings.model);
      checks.push(
        info === null
          ? {
              id: "route",
              status: "fail",
              message: `顾问 ${settings.provider}/${settings.model} 解析失败：路由或密钥可能没配好`,
              action: "settings:models",
            }
          : {
              id: "route",
              status: "pass",
              message:
                `顾问 ${settings.provider}/${settings.model}` +
                (info.contextWindow === undefined ? "" : ` · 上下文 ${info.contextWindow}`) +
                (info.efforts.length === 0
                  ? " · 无思考档"
                  : ` · 思考档 ${info.efforts.map((item) => item.id).join("/")}`),
            },
      );
      if (
        settings.reasoningEffort !== "" &&
        info !== null &&
        info.efforts.length > 0 &&
        !info.efforts.some((item) => item.id === settings.reasoningEffort)
      ) {
        checks.push({
          id: "effort",
          status: "warn",
          message: `设置的思考档「${settings.reasoningEffort}」不在该模型支持列表里，将被自动降级重试`,
        });
      }
    }

    checks.push({
      id: "mode",
      status: settings.mode === "off" ? "warn" : "pass",
      message: settings.mode === "off" ? "当前模式是 off：不会徵询" : `当前模式 ${settings.mode}`,
    });

    if (sessionId !== "") {
      const counters = this.ledger.counters(sessionId);
      const budget = checkBudget({ settings, counters, now: Date.now() });
      checks.push(
        budget.ok
          ? {
              id: "budget",
              status: "pass",
              message: `预算充足（本会话已用 ${counters.sessionCalls} 次）`,
            }
          : {
              id: "budget",
              status: "warn",
              message: `预算受限：${budget.code}（${budget.used}/${budget.limit}）`,
            },
      );
    }

    const totals = this.ledger.totals();
    checks.push({
      id: "ledger",
      status: "pass",
      message: `账本 ${totals.calls} 次 · ${totals.inputTokens} in / ${totals.outputTokens} out · ${this.ledger.path}`,
    });

    if (this.lastResult?.code && this.lastResult.code !== "ok") {
      checks.push({
        id: "last",
        status: "warn",
        message: `最近一次失败：${this.lastResult.code} — ${this.lastResult.reason ?? ""}`,
      });
    }

    return checks;
  }

  /**
   * @param {string} message
   * @param {unknown} [error]
   */
  warn(message, error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    this.logger?.warn?.(`advisor: ${message}${detail}`);
  }
}

/**
 * @param {string} status
 * @returns {string}
 */
function iconOf(status) {
  return status === "pass" ? "✅" : status === "warn" ? "⚠️" : "❌";
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatTokens(value) {
  const n = Number(value) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  const n = Number(ms) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

declareRemote(AdvisorService, "candidates");
declareRemote(AdvisorService, "setModel");
declareRemote(AdvisorService, "state");
declareRemote(AdvisorService, "settings");
declareRemote(AdvisorService, "updateSettings");
declareRemote(AdvisorService, "routes");
declareRemote(AdvisorService, "models");
declareRemote(AdvisorService, "modelInfo");
declareRemote(AdvisorService, "doctor");
