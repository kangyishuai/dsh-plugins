// @ts-check
// Typert Remote 包装层：服务名 sessionRewind。
//
// 对浏览器暴露：candidates / preview / rewind / cuts / ghost / audit / rescues /
// restoreRescue / health。文件引擎在 ./files.js，工具钩子在 ./file-tracking.js，
// 审计与幽灵历史分别见 ./audit.js、./ghost.js。
//
// Remote 方法必须声明在「被导出的那个类自身」的原型上，否则 Typert 网关不会
// claim 端点（所有 /api/sessionRewind/* 会 404），见 docs/runtime §6.10。
// 因此 lib/index.js 直接导出本类，不要再包一层子类。
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage, isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import { estimateMessage } from "@deepseek-ai/dsh-token-meter/estimate";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { installFileTracking } from "./file-tracking.js";
import { createFileStore } from "./files.js";
import { collectGhost } from "./ghost.js";
import {
  appendRewindMarker,
  createMarkerMessageInput,
  ERROR_CODES,
  RewindRequestError,
  resolveRewindTarget,
  sessionEvents,
} from "./operations.js";
import { cutsOf, hasOpenToolCalls, listCandidatesPage, targetContent } from "./plan.js";

/**
 * 在 decorator 语法不可用（V8 装饰器关闭）的运行时里登记一个 Remote 方法。
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
    throw new Error(`session-rewind: cannot declare Remote method ${method}`);
  }
  initializers[0].call(Object.create(Proto.prototype));
}

/**
 * 数据根：config.dataRoot > $DSH_HOME > ~/.dsh，再拼插件目录。
 * @param {any} config 插件配置
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
 * 安全地从 ctx 上取一个宿主服务。
 * @param {any} ctx host 上下文
 * @param {string} name 服务名
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
 * 把内部错误转成线缆上的 RemoteError。
 * @param {unknown} error
 * @returns {never}
 */
function rethrowRemote(error) {
  if (error instanceof RemoteError) throw error;
  const code = /** @type {any} */ (error)?.code;
  if (typeof code === "string" && code.startsWith("session-rewind/")) {
    throw new RemoteError(code, error instanceof Error ? error.message : String(error), {
      details: /** @type {any} */ (error).details ?? null,
    });
  }
  if (error instanceof RewindRequestError) {
    throw new RemoteError(/** @type {any} */ (error).code, error.message, {
      details: /** @type {any} */ (error).details ?? null,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new RemoteError(ERROR_CODES.failed, message);
}

/**
 * 取消息里的纯文本（幽灵列表/预览用）。
 * @param {any} message
 * @returns {string}
 */
function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  let text = "";
  for (const block of message.content) {
    if (block && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * 会话 cwd；缺失或非绝对路径时返回 undefined。
 * @param {any} session
 * @returns {string | undefined}
 */
function cwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd.startsWith("/") ? cwd : undefined;
}

/**
 * 会话是否子代理（文件追踪/回溯都不参与）。
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

export class SessionRewindService extends TypertRemoteService {
  /**
   * @param {any} ctx host 上下文
   * @param {any} [config] 插件配置
   */
  constructor(ctx, config) {
    super(ctx, "sessionRewind");
    this.config = config ?? {};
    /** 每会话的进行中请求，防止并发回溯。 @type {Set<string>} */
    this.inflight = new Set();
    /** 数据根（不拼插件目录，交给 files.js）。 */
    this.dataRoot = resolveDataRoot(this.config);
    /** @type {any} */
    this._store = null;
    this.installFileTracking();
    this.installCommand();
  }

  /** 惰性创建文件引擎：数据根/配置在服务挂载后解析。 @returns {any} */
  get store() {
    if (this._store === null) {
      this._store = createFileStore({
        home: this.dataRoot,
        logger: this.ctx?.logger ?? console,
        options: {
          ...(typeof this.config.maxFileBytes === "number"
            ? { maxFileBytes: this.config.maxFileBytes }
            : {}),
          ...(typeof this.config.maxAnchors === "number"
            ? { maxAnchors: this.config.maxAnchors }
            : {}),
          ...(typeof this.config.rescueKeep === "number"
            ? { rescueKeep: this.config.rescueKeep }
            : {}),
          ...(typeof this.config.softCapBytes === "number"
            ? { softCapBytes: this.config.softCapBytes }
            : {}),
        },
      });
    }
    return this._store;
  }

  /** 文件追踪是否开启。 @returns {boolean} */
  trackingEnabled() {
    return this.config.fileTracking !== false;
  }

  /** 安装工具钩子（失败只告警，不影响回溯本体）。 */
  installFileTracking() {
    if (!this.trackingEnabled()) return;
    try {
      const tracking = installFileTracking(this.ctx, {
        store: this.store,
        logger: this.ctx?.logger ?? console,
        options: { enabled: true },
        isSubagentSession: (/** @type {any} */ session) => isSubagentSession(session),
        cwdOf: (/** @type {any} */ session) => cwdOf(session),
      });
      if (
        tracking &&
        typeof tracking.dispose === "function" &&
        typeof this.ctx?.effect === "function"
      ) {
        this.ctx.effect(() => tracking.dispose, "session-rewind file tracking");
      }
    } catch (error) {
      this.ctx?.logger?.warn?.(
        `session-rewind: file tracking unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 注册 /rewind 命令（裸调用由客户端 commandUi 装饰接管；这里处理 @seq 形式）。 */
  installCommand() {
    try {
      if (typeof this.ctx?.inject !== "function") return;
      this.ctx.inject(["commands"], (/** @type {any} */ scope) => {
        scope.effect(
          () =>
            scope.commands.register({
              name: "rewind",
              description: "Rewind this conversation to before a user message.",
              input: { hint: "@<seq> [chat|both]" },
              handler: (/** @type {any} */ invocation) => this.handleRewindCommand(invocation),
            }),
          "session-rewind: /rewind command",
        );
      });
    } catch (error) {
      this.ctx?.logger?.warn?.(
        `session-rewind: cannot register /rewind command: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `/rewind @<seq> [chat|both]` 命令入口。
   * @param {any} invocation CommandInvocation
   * @returns {Promise<any>}
   */
  async handleRewindCommand(invocation) {
    const raw = typeof invocation?.rawInput === "string" ? invocation.rawInput.trim() : "";
    const tokens = raw.split(/\s+/u).filter((/** @type {string} */ token) => token !== "");
    const targetToken = tokens.find((/** @type {string} */ token) => /^@?\d+$/u.test(token));
    if (targetToken === undefined) {
      return {
        kind: "error",
        text: "Usage: /rewind @<seq> [chat|both] — or pick a message from the UI.",
      };
    }
    const targetSeq = Number(targetToken.replace(/^@/u, ""));
    const modeToken = tokens.find(
      (/** @type {string} */ token) => token === "both" || token === "chat",
    );
    const mode = modeToken === "both" ? "both" : "chat";
    const session = invocation?.agent?.session;
    if (session === undefined) return { kind: "error", text: "No active session." };
    try {
      const result = await this.executeRewind({
        sessionId: session.id,
        targetSeq,
        mode,
        requestedBy: "command",
      });
      return {
        kind: "success",
        text: `Rewound to before message ${result.targetSeq} (${result.removedCount} messages, ~${result.tokens} tokens)${mode === "both" ? `; ${result.files?.restored.length ?? 0} files restored, ${result.files?.trashed.length ?? 0} moved to trash` : ""}.`,
        sourceEventSeq: result.markerSeq,
      };
    } catch (error) {
      return { kind: "error", text: error instanceof Error ? error.message : String(error) };
    }
  }

  /** @returns {any} */
  deps() {
    const sessions = serviceOf(this.ctx, "sessions");
    const agents = serviceOf(this.ctx, "agents");
    const store = this.store;
    return {
      available: Boolean(sessions) || Boolean(agents),
      getAgent: (/** @type {string} */ sessionId) =>
        typeof agents?.get === "function" ? agents.get(sessionId) : undefined,
      getSession: (/** @type {string} */ sessionId) =>
        typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined,
      createMarkerMessage: (/** @type {number} */ targetSeq, /** @type {any} */ extra) =>
        createUserMessage(createMarkerMessageInput(targetSeq, extra)),
      inflight: this.inflight,
      summarizeFiles: (/** @type {string} */ sessionId, /** @type {number} */ targetSeq) => {
        try {
          return store.summarize(sessionId, targetSeq);
        } catch (_error) {
          return undefined;
        }
      },
    };
  }

  /**
   * 用 token-meter 的启发式估算一组 surface 事件对应消息的 token。
   * @param {any[]} events 事件日志
   * @param {number[]} seqs surface 节点 seq
   * @returns {number}
   */
  estimateTokens(events, seqs) {
    let tokens = 0;
    for (const seq of seqs) {
      const event = events[seq];
      if (event === undefined) continue;
      try {
        const message = deriveEventMessage(event);
        if (message !== null) tokens += estimateMessage(message);
      } catch (_error) {
        /* 估算失败忽略 */
      }
    }
    return tokens;
  }

  /**
   * 列出可回溯的真人用户消息（分页/搜索）。
   * @param {{sessionId?: string, limit?: number, cursor?: number, q?: string}} [request]
   */
  async candidates(request) {
    try {
      const deps = this.deps();
      const { session } = sessionEvents(deps, /** @type {any} */ (request?.sessionId));
      const sessionId = session.id;
      const page = listCandidatesPage(session.snapshotEvents(), session.surface.nodes, {
        limit: request?.limit,
        cursor: request?.cursor,
        q: request?.q,
      });
      const candidates = [];
      for (const candidate of page.candidates) {
        /** @type {{fileCount: number, hasFiles: boolean}} */
        let info = { fileCount: 0, hasFiles: false };
        try {
          const summary = await this.store.summarize({ sessionId, targetSeq: candidate.seq });
          info = { fileCount: summary.fileCount ?? 0, hasFiles: (summary.fileCount ?? 0) > 0 };
        } catch (_error) {
          /* 文件摘要失败不影响候选列表 */
        }
        candidates.push({ ...candidate, ...info, reachable: true });
      }
      return { sessionId, candidates, nextCursor: page.nextCursor };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 回溯预览（dry-run）：不写任何东西。
   * @param {{sessionId?: string, targetSeq?: number}} [request]
   */
  async preview(request) {
    try {
      const deps = this.deps();
      const { session, sessionId, plan, targetEvent } = resolveRewindTarget(deps, request);
      const events = session.snapshotEvents();
      const tokens = this.estimateTokens(events, plan.shadowedSeqs);
      const target = targetContent(targetEvent);
      const subtitle = target.text.replace(/\s+/gu, " ").trim();
      /** @type {any} */
      let files = {
        available: false,
        tracked: false,
        totalBytes: 0,
        restore: [],
        trash: [],
        skipped: [],
        conflicts: [],
      };
      /** @type {any[]} */
      const warnings = [];
      if (this.trackingEnabled()) {
        const cwd = cwdOf(session);
        if (cwd !== undefined) {
          try {
            const filePlan = await this.store.planRestore({
              sessionId,
              targetSeq: plan.targetSeq,
              cwd,
            });
            files = {
              available: filePlan.available !== false,
              tracked: filePlan.tracked === true,
              totalBytes: filePlan.totalBytes ?? 0,
              restore: filePlan.restore ?? [],
              trash: filePlan.trash ?? [],
              skipped: filePlan.skipped ?? [],
              conflicts: filePlan.conflicts ?? [],
            };
            for (const warning of filePlan.warnings ?? []) warnings.push(warning);
          } catch (error) {
            warnings.push({
              code: "files-unavailable",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          warnings.push({
            code: "cwd-missing",
            message: "This session has no working directory; file restore is unavailable.",
          });
        }
      } else {
        warnings.push({
          code: "tracking-disabled",
          message: "File tracking is disabled in the plugin configuration.",
        });
      }
      return {
        sessionId,
        targetSeq: plan.targetSeq,
        target: {
          seq: plan.targetSeq,
          time: targetEvent?.time ?? 0,
          preview: subtitle.length <= 80 ? subtitle : `${subtitle.slice(0, 79)}…`,
          text: target.text,
          images: target.images,
        },
        chat: {
          removedCount: plan.shadowedSeqs.length,
          tokens,
          crossesOpenToolCall: hasOpenToolCalls(events, plan.targetSeq),
          reachable: true,
        },
        files,
        warnings,
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 回溯：mode=chat 只追加 marker；mode=both 先建救援点、再追加 marker、再还原文件。
   * @param {{sessionId?: string, targetSeq?: number, mode?: "chat" | "both"}} [request]
   */
  async rewind(request) {
    try {
      return await this.executeRewind({
        sessionId: request?.sessionId,
        targetSeq: request?.targetSeq,
        mode: request?.mode === "both" ? "both" : "chat",
        requestedBy: "remote",
      });
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * @param {{sessionId?: string, targetSeq?: number, mode: "chat" | "both", requestedBy: string}} input
   * @returns {Promise<any>}
   */
  async executeRewind(input) {
    const deps = this.deps();
    const resolved = resolveRewindTarget(deps, input);
    const { session, sessionId, plan, targetEvent } = resolved;
    const agent = deps.getAgent(sessionId);
    if (agent !== undefined && agent !== null && agent.status !== "idle") {
      throw new RewindRequestError(
        ERROR_CODES.busy,
        `session "${sessionId}" is not idle; stop the running turn before rewinding`,
      );
    }
    if (this.inflight.has(sessionId)) {
      throw new RewindRequestError(
        ERROR_CODES.failed,
        `a rewind is already in progress for session "${sessionId}"`,
      );
    }
    this.inflight.add(sessionId);
    const auditId =
      typeof this.store.newAuditId === "function" ? this.store.newAuditId() : `rw-${Date.now()}`;
    const mode = input.mode === "both" ? "both" : "chat";
    /** @type {any} */
    let files = null;
    /** @type {any} */
    let markerEvent;
    try {
      if (mode === "both") {
        const cwd = cwdOf(session);
        if (!this.trackingEnabled() || cwd === undefined) {
          throw new RewindRequestError(
            ERROR_CODES.filesUnavailable,
            "file restore is unavailable for this session (tracking disabled or no working directory)",
          );
        }
        const filePlan = await this.store.planRestore({
          sessionId,
          targetSeq: plan.targetSeq,
          cwd,
        });
        if (
          Array.isArray(filePlan.warnings) &&
          filePlan.warnings.some((/** @type {any} */ item) => item.code === "files-unavailable")
        ) {
          throw new RewindRequestError(
            ERROR_CODES.filesUnavailable,
            "file restore is unavailable for this session",
          );
        }
        if (Array.isArray(filePlan.conflicts) && filePlan.conflicts.length > 0) {
          const error = new RewindRequestError(
            ERROR_CODES.filesConflict,
            `file restore would overwrite externally changed files: ${filePlan.conflicts
              .map((/** @type {any} */ item) => item.path)
              .join(", ")}`,
          );
          /** @type {any} */ (error).details = { conflicts: filePlan.conflicts };
          throw error;
        }
        if (!Array.isArray(filePlan.actions) || filePlan.actions.length === 0) {
          // 没有需要改动的文件：仍然要追加会话 marker（applyRestore 在 actions 为空时
          // 会提前返回，不会调用 beforeApply）。
          markerEvent = appendRewindMarker(session, plan, deps, { mode: "both", auditId });
          files = {
            restored: [],
            trashed: [],
            skipped: filePlan.skipped ?? [],
            failed: [],
            rescueId: null,
          };
        } else {
          let outcome;
          try {
            outcome = await this.store.applyRestore({
              sessionId,
              cwd,
              plan: filePlan,
              auditId,
              beforeApply: () => {
                markerEvent = appendRewindMarker(session, plan, deps, { mode: "both", auditId });
              },
            });
          } catch (error) {
            if (markerEvent === undefined) throw error;
            // marker 已写入：会话已回溯，文件未能写入；返回部分结果而不是丢掉响应。
            outcome = {
              restored: [],
              trashed: [],
              skipped: filePlan.skipped ?? [],
              failed: [
                { path: "*", reason: error instanceof Error ? error.message : String(error) },
              ],
              rescueId: null,
            };
          }
          files = {
            restored: outcome.restored ?? [],
            trashed: outcome.trashed ?? [],
            skipped: outcome.skipped ?? [],
            failed: outcome.failed ?? [],
            rescueId: outcome.rescueId ?? null,
          };
        }
        // 文件失败不回滚会话；在响应里报告（客户端显示为部分成功）。
      } else {
        markerEvent = appendRewindMarker(session, plan, deps, { mode: "chat", auditId });
      }
      const events = session.snapshotEvents();
      const tokens = this.estimateTokens(events, plan.shadowedSeqs);
      const response = {
        targetSeq: plan.targetSeq,
        markerSeq: markerEvent.seq,
        removedCount: plan.shadowedSeqs.length,
        tokens,
        auditId,
        target: targetContent(targetEvent),
        files,
      };
      try {
        await this.store.appendAudit({
          id: auditId,
          sessionId,
          time: Date.now(),
          targetSeq: plan.targetSeq,
          markerSeq: markerEvent.seq,
          mode,
          removedCount: plan.shadowedSeqs.length,
          tokens,
          files,
          requestedBy: input.requestedBy,
        });
      } catch (error) {
        this.ctx?.logger?.warn?.(
          `session-rewind: audit append failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return response;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  /**
   * 已存在的回溯区间（客户端可见性兜底）。
   * @param {{sessionId?: string}} [request]
   */
  async cuts(request) {
    try {
      const { events } = sessionEvents(this.deps(), /** @type {any} */ (request?.sessionId));
      return { cuts: cutsOf(events) };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 幽灵历史：被每次回溯遮蔽的消息（搜索/分页）。
   * @param {{sessionId?: string, q?: string, cursor?: number, limit?: number}} [request]
   */
  async ghost(request) {
    try {
      const sessionId = request?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new RewindRequestError(ERROR_CODES.notFound, "a session id is required");
      }
      const { events } = sessionEvents(this.deps(), sessionId);
      const audits = await this.store.readAudit({ sessionId, limit: 500 });
      /** @type {Map<number, string>} */
      const modeByMarker = new Map();
      for (const entry of audits) {
        if (typeof entry.markerSeq === "number" && typeof entry.mode === "string")
          modeByMarker.set(entry.markerSeq, entry.mode);
      }
      /**
       * @param {any} event
       * @returns {{kind: "user" | "assistant", text: string, messageId: string} | null}
       */
      const describe = (event) => {
        if (!isAppendSurfaceEvent(event)) return null;
        const message = deriveEventMessage(event);
        if (message === null) return null;
        // 只列「人能看到」的内容：真人用户消息 + assistant 文本。
        // 注入上下文（runtime-context / system-reminder 等）也是 user/message，
        // 但放回输入框毫无意义，只会把面板刷满噪音；工具结果同理，先不列。
        if (event.type === "user/message") {
          if (event.data?.source?.kind !== "user") return null;
          return { kind: "user", text: textOfMessage(message), messageId: message.id };
        }
        if (event.type === "assistant/message") {
          return { kind: "assistant", text: textOfMessage(message), messageId: message.id };
        }
        return null;
      };
      return collectGhost(events, describe, {
        q: request?.q,
        cursor: request?.cursor,
        limit: request?.limit,
        modeByMarker,
      });
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 回溯审计记录（某个会话，倒序）。
   * @param {{sessionId?: string, limit?: number}} [request]
   */
  async audit(request) {
    try {
      return {
        entries: await this.store.readAudit({
          sessionId: request?.sessionId,
          limit: request?.limit,
        }),
      };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 某会话的救援点列表。
   * @param {{sessionId?: string}} [request]
   */
  async rescues(request) {
    try {
      if (typeof request?.sessionId !== "string") {
        throw new RewindRequestError(ERROR_CODES.notFound, "a session id is required");
      }
      return { rescues: await this.store.listRescues({ sessionId: request.sessionId }) };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 恢复某个救援点（先为当前受影响文件再建一个救援点）。
   * @param {{sessionId?: string, rescueId?: string}} [request]
   */
  async restoreRescue(request) {
    try {
      const deps = this.deps();
      const { session } = sessionEvents(deps, /** @type {any} */ (request?.sessionId));
      const sessionId = session.id;
      const cwd = cwdOf(session);
      if (cwd === undefined)
        throw new RewindRequestError(
          ERROR_CODES.filesUnavailable,
          "session has no working directory",
        );
      const rescueId = request?.rescueId;
      if (typeof rescueId !== "string" || rescueId === "") {
        throw new RewindRequestError(ERROR_CODES.rescueNotFound, "a rescue id is required");
      }
      const result = await this.store.restoreRescue({ sessionId, cwd, rescueId });
      if (Array.isArray(result.failed) && result.failed.length > 0) {
        const error = new RewindRequestError(
          ERROR_CODES.filesFailed,
          "some files could not be restored from the rescue point",
        );
        /** @type {any} */ (error).details = { files: result };
        throw error;
      }
      return result;
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 健康检查（doctor）：数据根、schema、usage、追踪状态、可选会话的 marker 形状。
   * @param {{sessionId?: string}} [request]
   */
  async health(request) {
    /** @type {{name: string, ok: boolean, detail: string}[]} */
    const checks = [];
    const push = (
      /** @type {string} */ name,
      /** @type {boolean} */ ok,
      /** @type {string} */ detail = "",
    ) => checks.push({ name, ok, detail });
    push("数据根", typeof this.dataRoot === "string" && this.dataRoot !== "", this.dataRoot);
    push(
      "文件追踪",
      this.trackingEnabled(),
      this.trackingEnabled() ? "enabled" : "disabled in config",
    );
    /** @type {any} */
    let usage = null;
    try {
      usage = await this.store.usage();
      push(
        "文件存储",
        true,
        `${usage.bytes} bytes / ${usage.entries} entries / ${usage.sessions} sessions`,
      );
    } catch (error) {
      push("文件存储", false, error instanceof Error ? error.message : String(error));
    }
    try {
      const audits = await this.store.readAudit({ limit: 1 });
      push("审计日志", true, `${audits.length} record(s) readable`);
    } catch (error) {
      push("审计日志", false, error instanceof Error ? error.message : String(error));
    }
    if (typeof request?.sessionId === "string" && request.sessionId !== "") {
      try {
        const { events, session } = sessionEvents(this.deps(), request.sessionId);
        const cuts = cutsOf(events);
        const shaped = cuts.every((cut) => cut.targetSeq < cut.markerSeq);
        push("会话 marker 形状", shaped, `${cuts.length} cut(s)`);
        push("会话 cwd", cwdOf(session) !== undefined, cwdOf(session) ?? "missing");
      } catch (error) {
        push("会话检查", false, error instanceof Error ? error.message : String(error));
      }
    }
    return {
      ok: checks.every((check) => check.ok),
      version: 1,
      dataRoot: this.dataRoot,
      checks,
      usage: usage ?? { bytes: 0, entries: 0, sessions: 0, blobs: 0 },
    };
  }
}

declareRemote(SessionRewindService, "candidates");
declareRemote(SessionRewindService, "preview");
declareRemote(SessionRewindService, "rewind");
declareRemote(SessionRewindService, "cuts");
declareRemote(SessionRewindService, "ghost");
declareRemote(SessionRewindService, "audit");
declareRemote(SessionRewindService, "rescues");
declareRemote(SessionRewindService, "restoreRescue");
declareRemote(SessionRewindService, "health");
