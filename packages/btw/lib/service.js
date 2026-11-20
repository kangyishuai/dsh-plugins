// @ts-check
// host 半的 Service 形态：导出 TypertRemoteService 子类，供 client 半通过 RPC 取数据。
// 依据 packages/next-step/lib/service.js 的既有形态（约定 §2：Remote 方法必须声明在
// 被导出的类本人原型上，否则 /api/btw/* 会 404；运行时无装饰器语法，用 declareRemote 命令式登记）。
import { fileURLToPath } from "node:url";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { renderBadge } from "./badge.js";
import { buildBoundedDigest, buildBoundedPrompt } from "./bounded.js";
import { parseAllowedTools } from "./config.js";
import { buildCostHint, formatCostHintLine, lastPromptTokens } from "./cost-hint.js";
import { createFollowUpQueue } from "./followup-queue.js";
import { formatDuration, formatTokens } from "./format.js";
import { appendRecord, lastRecord, listRecent } from "./history.js";
import { clip, LIMITS } from "./limits.js";
import { createLiveTracker } from "./live.js";
import { parseMarkdown } from "./markdown.js";
import { format, loadMessagesSync, pickLanguage } from "./messages.js";
import { historyFile, resolveDataRoot } from "./paths.js";
import { buildSettingsPatch, loadSettings, saveSettings } from "./settings.js";
import { observeUsage, runSideQuestion } from "./subagent.js";
import {
  listThreads,
  newThreadId,
  parseCommandArgs,
  promoteRecordForThread,
  renderPromoteDraft,
  renderThreadDetails,
  threadHistory,
} from "./threads.js";

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

/**
 * locale 目录（包内，随 npm 包发布）。用 fileURLToPath 处理安装路径里的空格
 * （`new URL().pathname` 会留下 %20）。
 * @returns {string}
 */
function localeDirOf() {
  return fileURLToPath(new URL("../locale/", import.meta.url));
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
  threadFull: "This side-question thread is full ({max} turns). Start a new one.",
  meta: "btw · new {newTokens} tokens · cached {cachedTokens} · {ms}",
  panelOnly: "Side question answered; the full answer is in the side-question panel.",
  reopen: "Last side question: {question}",
  costWarn:
    "This session's context is ~{pressure} tokens; a side question forks the whole session, and earlier runs actually used 0.75–1.2× that (~{low}–{high} tokens). If the cache expired, expect that order of magnitude.",
  costLast: "Last actual: {tokens} tokens.",
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
    // 配置里的白名单是静态的；设置文件里的会动态覆盖（每次使用前重读）。
    this.configAllowedTools = parseAllowedTools(this.config);
    this.allowedTools = this.configAllowedTools;
    this.language = pickLanguage(this.config?.language);
    this.usageBySession = observeUsage(ctx);
    // 面板流式：按 childSessionId 旁听 text-delta，`btw/live` 轮询取快照。
    this.liveTracker = createLiveTracker(ctx);
    // 抽屉追问借 composer 提交裸 `/btw`，真实参数从这里取（见 followup-queue.js）。
    this.followUps = createFollowUpQueue({});
    // locale 必须在注册命令**之前**同步读完：宿主没有 locale 服务，命令的 description /
    // hint / 结果 text 都是注册时/返回时的字面量（见 docs/runtime/0.2.2-rc.5.md §8），
    // 异步加载会让 `/btw` 的菜单文案永远停在英文 FALLBACK。文件只有几 KB，同步读可接受。
    /** @type {Record<string, string>} */
    this.messages = FALLBACK;
    try {
      this.messages = { ...FALLBACK, ...loadMessagesSync(localeDirOf(), this.language) };
    } catch {
      this.messages = FALLBACK;
    }

    // 命令注册：服务构造期就拿到 ctx，和 v0.1 的 apply() 等价。
    const inject = /** @type {any} */ (ctx).inject;
    if (typeof inject !== "function") {
      this.logger.warn("[btw] ctx.inject unavailable; /btw not registered");
      return;
    }
    inject.call(
      ctx,
      ["agents", "commands", "sessions", "subagents", "tokenMeter", "tools", "workspaceRegistry"],
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
    const file = historyFile(this.dataRoot, agent?.id ?? "");
    // 追问用 `/btw --thread <id> <问题>` 标记线程（见 threads.js 的 parseThreadFlag 说明）。
    const parsed = parseCommandArgs(String(invocation?.rawInput ?? ""));
    let threadId = parsed.threadId;
    let scope = parsed.scope;
    let rawQuestion = parsed.question;
    // 裸 `/btw`（无参数）时先看有没有抽屉登记的追问：
    // 有就当追问处理，没有才走「重开上一条」的老语义。
    if (threadId === "" && rawQuestion === "") {
      const queued = this.followUps.take(String(agent?.id ?? ""));
      if (queued !== undefined) {
        threadId = queued.threadId;
        scope = queued.scope;
        rawQuestion = queued.question;
      }
    }
    const question = clip(rawQuestion, LIMITS.questionChars);

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

    const stored = await loadSettings(this.dataRoot).catch(() => undefined);
    const allowedTools = stored === undefined ? this.allowedTools : new Set(stored.allowedTools);
    const sessionHistory = await listRecent(file, LIMITS.replayRecords).catch(() => []);
    // 成本提示（Phase 1，只提示不阻断）：父会话 contextPressure 粗估 + 上次真实 prompt 总量。
    // 探针结论：fork prompt 约为 contextPressure 的 0.75–1.2 倍，见 notes/btw/fork-cost.md §5。
    const pressure = this.pressureOf(String(agent?.id ?? ""));
    const costHint = buildCostHint({
      pressureTokens: Number(pressure?.pressureTokens),
      contextWindow: Number(pressure?.contextWindow),
      lastActualPromptTokens: lastPromptTokens(sessionHistory),
    });
    // 追问：把同线程的问答回放给模型（每轮重新 fork，靠上下文重建多轮语义）。
    const priorThread = threadId === "" ? [] : threadHistory(sessionHistory, threadId);
    if (threadId !== "" && priorThread.length >= LIMITS.threadTurns) {
      return {
        kind: "error",
        text: format(this.messages.threadFull ?? FALLBACK.threadFull, {
          max: LIMITS.threadTurns,
        }),
      };
    }
    const history = [...sessionHistory, ...priorThread].slice(-LIMITS.replayRecords);
    // bounded-context（ADR-0022）：只有用户显式开启、且父会话压力超过阈值时才用
    // spawn（fresh context）+「最近 N 条消息 + 问题」替代 full fork。默认关，绝不静默切换。
    /** @type {any[]} */
    let parentEvents = [];
    try {
      const parentSession = agent?.session;
      if (parentSession && typeof parentSession.snapshotEvents === "function") {
        parentEvents = parentSession.snapshotEvents();
      }
    } catch {
      parentEvents = [];
    }
    const boundedEligible =
      stored?.boundedContext === true &&
      Number(pressure?.pressureTokens) >= LIMITS.boundedTriggerTokens;
    let mode = "fork";
    /** @type {{ type: "text", text: string }[] | undefined} */
    let boundedPrompt;
    if (boundedEligible) {
      const digest = buildBoundedDigest(parentEvents);
      if (digest.messages > 0) {
        mode = "bounded";
        boundedPrompt = buildBoundedPrompt(question.text, digest, { history });
      }
    }
    // 线程 id 在 fork 之前就定下来：面板流式卡片和最终记录必须是同一个线程。
    const recordThreadId = threadId === "" ? newThreadId() : threadId;
    // 面板流式：登记这次 run；fork 拿到 childId 后 onChild 会接上实时文本。
    const run = this.liveTracker.begin(String(agent?.id ?? ""), {
      threadId: recordThreadId,
      question: question.text,
    });
    /** @type {Awaited<ReturnType<typeof runSideQuestion>>} */
    let outcome;
    try {
      outcome = await runSideQuestion({
        ctx: this.scoped,
        workspaceRegistry: this.scoped?.workspaceRegistry,
        agent,
        question: question.text,
        scope,
        history,
        provider: mode === "bounded" ? "spawn" : "fork",
        prompt: boundedPrompt,
        allowedTools,
        signal: invocation?.signal,
        usageBySession: this.usageBySession,
        onChild: (childId) => this.liveTracker.attachChild(run, childId),
      });
    } finally {
      this.liveTracker.finish(run);
    }

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

    const recordId = `btw_${Date.now().toString(36)}`;
    const record = {
      id: recordId,
      // 线程：追问沿用传入的 threadId；首问用 fork 前就定下的新线程 id（v0.4 流式共用）
      threadId: recordThreadId,
      parentSessionId: String(agent?.id ?? ""),
      childSessionId: outcome.childId ?? null,
      question: question.text,
      answer: outcome.text,
      // fork（全量父会话）或 bounded（spawn + 最近 N 条）；老记录没有该字段按 fork 处理。
      mode,
      status: outcome.status,
      cost: outcome.usage ?? null,
      ms: outcome.ms,
      at: Date.now(),
    };
    await appendRecord(file, record).catch(() => {});
    // 设置里关掉「主对话显示完整答案」时，只回一行提示；面板历史里仍有完整答案。
    // bounded 已经把成本封顶；此时再贴「fork 可能花几十万 tokens」的警告会误导，所以跳过。
    const answerHint = mode === "bounded" ? null : costHint;
    if (stored !== undefined && stored.echoAnswer === false) {
      return {
        kind: "success",
        text: this.withCostHint(this.messages.panelOnly ?? FALLBACK.panelOnly, answerHint),
      };
    }
    return { kind: "success", text: this.withCostHint(this.formatAnswer(record), answerHint) };
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
   * 徽章数据（抽屉底部展示用）：记录条数与范围说明。
   * @param {{ sessionId?: string, scope?: string, lang?: string } | undefined} request
   * @returns {Promise<{ records: number, badge: string }>}
   */
  async stats(request) {
    const input = request ?? {};
    const records = await listRecent(
      historyFile(this.dataRoot, String(input.sessionId ?? "")),
      LIMITS.perSessionRecords,
    );
    return {
      records: records.length,
      badge: renderBadge({
        records: records.length,
        scope: String(input.scope ?? ""),
        lang: String(input.lang ?? ""),
      }),
    };
  }

  /**
   * 线程列表（抽屉展示用）。参数必须是单一标识符（网关 SRC 校验）。
   * @param {{ sessionId?: string, limit?: number } | undefined} request
   * @returns {Promise<any[]>}
   */
  async threads(request) {
    const input = request ?? {};
    const limit = Math.min(
      Number(input.limit) || LIMITS.perSessionRecords,
      LIMITS.perSessionRecords,
    );
    const records = await listRecent(
      historyFile(this.dataRoot, String(input.sessionId ?? "")),
      limit,
    );
    return listThreads(records);
  }

  /**
   * 流式快照（面板轮询用）：该父会话里正在跑的旁问 + 已解析的 Markdown 块。
   *
   * 为什么走轮询而不是让 client 订阅子会话事件：子会话是 fork 出来的，
   * 它带着父会话的全部已完成轮次作为种子；client 一旦 retain 它就会把整段历史
   * 拉到浏览器里。旁问只需要最后几 KB 的增量文本，host 缓冲 + 短轮询更省。
   * @param {{ sessionId?: string } | undefined} request
   * @returns {Promise<{ runs: any[] }>}
   */
  async live(request) {
    const input = request ?? {};
    return {
      runs: this.liveTracker.list(String(input.sessionId ?? "")).map((run) => ({
        threadId: run.threadId,
        question: run.question,
        childId: run.childId,
        ms: run.ms,
        blocks: parseMarkdown(run.text).blocks,
      })),
    };
  }

  /**
   * 生成「一键转正」草稿文本。**只返回文本，不插入、不发送**——
   * 语义已与用户确认：插入 composer 草稿，由用户自己决定发不发。
   * @param {{ sessionId?: string, threadId?: string, recordId?: string, lang?: string, details?: string, unresolved?: string } | undefined} request
   * @returns {Promise<{ ok: boolean, text?: string, reason?: string }>}
   */
  async promote(request) {
    const input = request ?? {};
    const records = await listRecent(
      historyFile(this.dataRoot, String(input.sessionId ?? "")),
      LIMITS.perSessionRecords,
    );
    const threadId = String(input.threadId ?? "");
    const wanted = String(input.recordId ?? "");
    const record =
      threadId !== ""
        ? promoteRecordForThread(records, threadId)
        : wanted === ""
          ? records[records.length - 1]
          : records
              .slice()
              .reverse()
              .find((entry) => String(entry?.id ?? "") === wanted);
    if (record === undefined) return { ok: false, reason: "no_record" };
    // 线程级转正：把每一轮追问的 Q/A 放进「关键细节」，避免首问标题 + 末答结论语义错位。
    const threadDetails =
      threadId === "" ? "" : renderThreadDetails(records, threadId, String(input.lang ?? ""));
    const requestedDetails = String(input.details ?? "").trim();
    const details = [threadDetails, requestedDetails].filter((part) => part !== "").join("\n\n");
    // host 只负责生成完整草稿（四节 Markdown，最多 promoteChars）；草稿会不会撑爆
    // composer 取决于输入框宽度，所以「按行数收进预算」放在 client 半按实测宽度做
    // （host 进程看不到浏览器宽度；也避免为了一个纯 UI 预算去改 host 协议）。
    const text = renderPromoteDraft(record, {
      lang: String(input.lang ?? ""),
      details,
      unresolved: String(input.unresolved ?? ""),
      maxChars: LIMITS.promoteChars,
    }).slice(0, LIMITS.promoteChars);
    if (text.trim() === "") return { ok: false, reason: "empty" };
    return { ok: true, text };
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

  /**
   * 登记一次待处理的追问。client 在提交裸 `/btw` **之前**调用，
   * 这样命令文本里不必出现 `--thread t_xxx`。
   * @param {{ sessionId?: string, threadId?: string, question?: string, scope?: string } | undefined} request
   * @returns {Promise<{ ok: boolean, size: number }>}
   */
  async queueFollowUp(request) {
    const input = request ?? {};
    this.followUps.push(String(input.sessionId ?? ""), {
      threadId: String(input.threadId ?? ""),
      question: String(input.question ?? ""),
      scope: String(input.scope ?? ""),
    });
    return { ok: true, size: this.followUps.size() };
  }

  /**
   * 读当前设置（client 设置面板用）。
   * @param {undefined} request 参数必须存在且是单一标识符（网关 SRC 校验）。
   * @returns {Promise<any>}
   */
  async settings(request) {
    void request;
    const stored = await loadSettings(this.dataRoot);
    return {
      ...stored,
      configAllowedTools: [...this.configAllowedTools],
      readOnly: stored.allowedTools.length === 0,
    };
  }

  /**
   * 更新设置（只接受已知字段，未知字段忽略）。
   * @param {{ allowedTools?: string, historyLimit?: number } | undefined} request
   * @returns {Promise<any>}
   */
  async updateSettings(request) {
    const input = request ?? {};
    const saved = await saveSettings(this.dataRoot, buildSettingsPatch(input));
    this.allowedTools = new Set(saved.allowedTools);
    return { ...saved, readOnly: saved.allowedTools.length === 0 };
  }

  /**
   * 父会话最后一次请求的 prompt 压力（只读；拿不到就返回空对象）。
   * @param {string} sessionId
   * @returns {{ pressureTokens?: number, contextWindow?: number }}
   */
  pressureOf(sessionId) {
    try {
      const session = this.scoped?.sessions?.get?.(sessionId);
      if (session === undefined || session === null) return {};
      const pressure = this.scoped?.tokenMeter?.contextPressure?.(session);
      return pressure !== null && typeof pressure === "object" ? pressure : {};
    } catch {
      return {};
    }
  }

  /**
   * 成本粗估（client 面板用）：contextPressure + 本会话上一次真实 prompt 总量。
   * @param {{ sessionId?: string } | undefined} request
   * @returns {Promise<any>}
   */
  async costHint(request) {
    const input = request ?? {};
    const sessionId = String(input.sessionId ?? "");
    const pressure = this.pressureOf(sessionId);
    const records = await listRecent(
      historyFile(this.dataRoot, sessionId),
      LIMITS.perSessionRecords,
    ).catch(() => []);
    return buildCostHint({
      pressureTokens: Number(pressure?.pressureTokens),
      contextWindow: Number(pressure?.contextWindow),
      lastActualPromptTokens: lastPromptTokens(records),
    });
  }

  /**
   * 给 `/btw` 结果追加一行成本提示（只在高压力时出现，不阻断）。
   * @param {string} text
   * @param {import("./cost-hint.js").CostHint | null} hint null = 这次不提示（如 bounded 已封顶）
   * @returns {string}
   */
  withCostHint(text, hint) {
    const line = this.costHintLine(hint);
    return line === "" ? text : `${text}\n\n${line}`;
  }

  /**
   * @param {import("./cost-hint.js").CostHint | null} hint
   * @returns {string}
   */
  costHintLine(hint) {
    return formatCostHintLine(hint, this.messages);
  }

  /** @param {any} record */
  formatAnswer(record) {
    const usage = record.cost ?? {};
    const bounded = record.mode === "bounded" ? " · bounded" : "";
    const meta = `${format(this.messages.meta ?? FALLBACK.meta, {
      newTokens: formatTokens(usage.inputTokens),
      cachedTokens: formatTokens(usage.cacheReadTokens),
      ms: formatDuration(record.ms),
    })}${bounded}`;
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
declareRemote(BtwService, "live");
declareRemote(BtwService, "stats");
declareRemote(BtwService, "queueFollowUp");
declareRemote(BtwService, "threads");
declareRemote(BtwService, "promote");
declareRemote(BtwService, "costHint");
declareRemote(BtwService, "settings");
declareRemote(BtwService, "updateSettings");
