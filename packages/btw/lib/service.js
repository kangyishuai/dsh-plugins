// @ts-check
// host 半的 Service 形态：导出 TypertRemoteService 子类，供 client 半通过 RPC 取数据。
// 依据 packages/next-step/lib/service.js 的既有形态（约定 §2：Remote 方法必须声明在
// 被导出的类本人原型上，否则 /api/btw/* 会 404；运行时无装饰器语法，用 declareRemote 命令式登记）。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { parseAllowedTools } from "./config.js";
import { appendRecord, lastRecord, listRecent } from "./history.js";
import { clip, LIMITS } from "./limits.js";
import { format, loadMessages, pickLanguage } from "./messages.js";
import { historyFile, resolveDataRoot } from "./paths.js";
import { observeUsage, runSideQuestion } from "./subagent.js";

/**
 * 命令式登记 Remote 方法（运行时没有装饰器语法）。
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
  if (initializers.length !== 1) throw new Error(`btw: cannot declare Remote method ${method}`);
  initializers[0].call(Object.create(Proto.prototype));
}

/** 默认文案（locale 未加载时兜底）。 */
const FALLBACK = {
  description: "Ask a read-only side question without interrupting the main task",
  hint: "[question]",
  noHistory: "No side question yet in this session.",
  forkUnavailable: "Side questions are unavailable right now (the subagent runtime is not loaded).",
  forkFailed: "The side question could not start. Try again, or ask in the main conversation.",
  emptyAnswer: "The model returned no answer. Try rephrasing, or ask in the main conversation.",
  timeout: "The side question timed out before it answered.",
  cancelled: "The side question was cancelled.",
  tooLong: "That question is too long ({length} characters, limit {max}).",
  meta: "btw · new {newTokens} tokens · cached {cachedTokens} · {ms}ms",
  reopen: "Last side question: {question}",
};

/**
 * 旁问服务：注册 `/btw` 命令，并对外暴露只读的历史查询。
 */
export class BtwService extends TypertRemoteService {
  /**
   * @param {any} ctx host 上下文
   * @param {any} [config] 插件配置
   */
  constructor(ctx, config) {
    super(ctx, "btw");
    this.ctx = ctx;
    this.config = config ?? {};
    this.logger = ctx?.logger ?? console;
    this.dataRoot = resolveDataRoot(this.config);
    this.allowedTools = parseAllowedTools(this.config);
    this.language = pickLanguage(this.config?.language);
    this.usageBySession = observeUsage(ctx);
    /** @type {Record<string, string>} */
    this.messages = FALLBACK;
    // locale 加载（不阻塞激活）
    const localeDir = new URL("../locale/", import.meta.url).pathname;
    void loadMessages(localeDir, this.language)
      .then((loaded) => {
        this.messages = { ...FALLBACK, ...loaded };
      })
      .catch(() => {});

    // 命令注册：服务构造期就拿到 ctx，和 v0.1 的 apply() 等价。
    const inject = /** @type {any} */ (ctx).inject;
    if (typeof inject !== "function") {
      this.logger.warn("[btw] ctx.inject unavailable; /btw not registered");
      return;
    }
    inject.call(
      ctx,
      ["agents", "commands", "subagents", "tools", "workspaceRegistry"],
      (/** @type {any} */ scoped) => {
        this.scoped = scoped;
        this.registerCommand(scoped);
      },
    );
  }

  /** @param {any} scoped */
  registerCommand(scoped) {
    const commands = scoped?.commands;
    if (typeof commands?.register !== "function") {
      this.logger.warn("[btw] commands service unavailable; /btw not registered");
      return;
    }
    commands.register({
      name: "btw",
      description: this.messages.description ?? FALLBACK.description,
      input: { hint: this.messages.hint ?? FALLBACK.hint },
      recordInput: false,
      /** @param {any} invocation */
      handler: (invocation) => this.handle(invocation),
    });
    this.logger.info(
      `[btw] /btw registered (read-only, ${this.allowedTools.size} allowed tool(s))`,
    );
  }

  /**
   * 命令处理：核心逻辑与 v0.1 一致，只是搬进类方法。
   * @param {any} invocation
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
   */
  async handle(invocation) {
    const agent = invocation?.agent;
    const question = clip(String(invocation?.rawInput ?? "").trim(), LIMITS.questionChars);
    const file = historyFile(this.dataRoot, agent?.id ?? "");

    if (question.text === "") {
      const previous = await lastRecord(file).catch(() => undefined);
      if (previous === undefined)
        return { kind: "error", text: this.messages.noHistory ?? FALLBACK.noHistory };
      return { kind: "success", text: this.formatReopen(previous) };
    }
    if (question.truncated) {
      return {
        kind: "error",
        text: format(this.messages.tooLong ?? FALLBACK.tooLong, {
          length: String(invocation?.rawInput ?? "").trim().length,
          max: LIMITS.questionChars,
        }),
      };
    }

    const history = await listRecent(file, LIMITS.replayRecords).catch(() => []);
    const outcome = await runSideQuestion({
      ctx: this.scoped,
      workspaceRegistry: this.scoped?.workspaceRegistry,
      agent,
      question: question.text,
      history,
      allowedTools: this.allowedTools,
      signal: invocation?.signal,
      usageBySession: this.usageBySession,
    });

    if (outcome.code === "subagents_unavailable") {
      return { kind: "error", text: this.messages.forkUnavailable ?? FALLBACK.forkUnavailable };
    }
    if (!outcome.ok) {
      const key =
        outcome.status === "timeout"
          ? "timeout"
          : outcome.status === "cancelled"
            ? "cancelled"
            : outcome.code === "empty_answer"
              ? "emptyAnswer"
              : "forkFailed";
      return { kind: "error", text: this.messages[key] ?? FALLBACK[key] ?? FALLBACK.forkFailed };
    }

    const record = {
      id: `btw_${Date.now().toString(36)}`,
      parentSessionId: String(agent?.id ?? ""),
      childSessionId: outcome.childId ?? null,
      question: question.text,
      answer: outcome.text,
      status: outcome.status,
      cost: outcome.usage ?? null,
      ms: outcome.ms,
      at: Date.now(),
    };
    await appendRecord(file, record).catch(() => {});
    return { kind: "success", text: this.formatAnswer(record) };
  }

  /**
   * 只读历史查询（给 client 半用）。
   * 参数必须是单个标识符、**不能有默认值/解构/剩余参数**——网关注册时会做 SRC 签名校验
   * （dsh-api-gateway: "SRC method ... must use unique identifier parameters"）。
   * @param {{ sessionId?: string, limit?: number } | undefined} request
   * @returns {Promise<any[]>}
   */
  async history(request) {
    const input = request ?? {};
    const limit = Math.min(Number(input.limit) || LIMITS.replayRecords, LIMITS.perSessionRecords);
    return listRecent(historyFile(this.dataRoot, String(input.sessionId ?? "")), limit);
  }

  /**
   * 最近一条旁问（裸 `/btw` 重开用）。同上：单标识符参数，无默认值。
   * @param {{ sessionId?: string } | undefined} request
   * @returns {Promise<any | undefined>}
   */
  async last(request) {
    const input = request ?? {};
    return lastRecord(historyFile(this.dataRoot, String(input.sessionId ?? "")));
  }

  /** @param {any} record */
  formatAnswer(record) {
    const usage = record.cost ?? {};
    const meta = format(this.messages.meta ?? FALLBACK.meta, {
      newTokens: String(usage.inputTokens ?? 0),
      cachedTokens: String(usage.cacheReadTokens ?? 0),
      ms: String(record.ms ?? 0),
    });
    const lines = [record.answer, "", `— ${meta}`];
    if (record.status === "truncated")
      lines.push(this.messages.truncated ?? "The answer was cut off; ask again to retry.");
    return lines.join("\n");
  }

  /** @param {any} record */
  formatReopen(record) {
    const heading = format(this.messages.reopen ?? FALLBACK.reopen, {
      question: String(record.question ?? ""),
    });
    return [heading, "", String(record.answer ?? "")].join("\n");
  }
}

declareRemote(BtwService, "history");
declareRemote(BtwService, "last");
