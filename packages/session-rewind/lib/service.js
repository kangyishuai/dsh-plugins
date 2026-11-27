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
import { settleAgent } from "./agent-settle.js";
import {
  bothModeBlockedReason,
  formatBothConflicts,
  formatBothPreview,
  formatBothUnavailable,
  formatRewindReceipt,
  parseRewindCommand,
} from "./command.js";
import { installFileTracking } from "./file-tracking.js";
import { createFileStore } from "./files.js";
import { collectGhost } from "./ghost.js";
import { buildHealth, sessionHealthFacts } from "./health.js";
import {
  createMarkerMessageInput,
  ERROR_CODES,
  RewindRequestError,
  resolveRewindTarget,
  sessionEvents,
} from "./operations.js";
import { findOrphans, pruneOrphans } from "./orphans.js";
import {
  countVisibleMessages,
  cutsOf,
  hasOpenToolCalls,
  listCandidatesPage,
  targetContent,
} from "./plan.js";
import { createRewindFlow } from "./rewind-flow.js";
import { stateChangeSummary } from "./state-changes.js";
import { describeToolImpact, installRewindTool, listToolCandidates } from "./tool.js";

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
    /** @type {any} */
    this._flow = null;
    this.installFileTracking();
    this.installCommand();
    // 只读 agent 工具：让模型自己看清候选与影响面（绝不执行回溯）。
    this.readOnlyToolInstalled = false;
    if (this.config.readOnlyTool !== false) {
      installRewindTool({
        ctx: this.ctx,
        logger: this.ctx?.logger ?? console,
        host: { call: (sessionId, request) => this.toolPayload(sessionId, request) },
        onInstalled: () => {
          this.readOnlyToolInstalled = true;
        },
      });
    }
    // 启动维护：清一次已删除会话的残留数据 + 清无引用内容（失败只告警，不阻塞插件）。
    void this.startupMaintenance();
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

  /**
   * 删除已不存在会话的插件数据（entries/trash/rescues）。audit.jsonl 保留。
   *
   * 安全约定（AUD-REW-01 + 复审 B1）：
   * - 枚举不到存活会话、未知宿主布局、或任一 workspace 不可读（`incomplete`）时视为枚举失败并
   *   跳过清理；
   * - 删除前先把 dry-run 计划写审计（`cleanup-orphans-plan`），审计失败则不删；
   * - 不认识的插件数据条目保留并逐条告警；
   * - 删除结果（含逐条失败）写审计并告警。
   * @returns {Promise<void>}
   */
  async cleanupOrphans() {
    try {
      const result = await pruneOrphans({
        dataRoot: this.dataRoot,
        onPlan: async (report) => {
          await this.store.appendAudit({
            id: `cleanup-plan-${Date.now()}`,
            action: "cleanup-orphans-plan",
            time: Date.now(),
            sessionId: null,
            sessions: report.sessionIds,
            trash: report.trashIds,
            rescues: report.rescueIds,
            bytes: report.bytes,
            liveSessionCount: report.liveSessionCount,
            enumerationFailed: report.enumerationFailed,
            incomplete: report.incomplete,
            unreadableWorkspaces: report.unreadableWorkspaces,
            unknownWorkspaces: report.unknownWorkspaces,
            unknownIds: report.unknownIds,
          });
        },
      });
      // 不认识的条目保留是安全行为，但必须告警（AGENTS 硬性约定 1「保留并告警」）。
      for (const unknown of result.report.unknownIds ?? []) {
        this.ctx?.logger?.warn?.(
          `session-rewind: keeping unrecognized orphan candidate ${unknown.root}/${unknown.id} (${unknown.reason})`,
        );
      }
      if (result.reason === "enumeration-failed") {
        /** @type {string[]} */
        const problems = [];
        if (result.report.unreadableWorkspaces > 0) {
          problems.push(`${result.report.unreadableWorkspaces} unreadable workspace(s)`);
        }
        const unknownWorkspaces = Array.isArray(result.report.unknownWorkspaces)
          ? result.report.unknownWorkspaces
          : [];
        if (unknownWorkspaces.length > 0) {
          problems.push(`${unknownWorkspaces.length} workspace(s) with unknown layout`);
        }
        this.ctx?.logger?.warn?.(
          `session-rewind: cannot enumerate live sessions${
            problems.length > 0 ? ` (${problems.join(", ")})` : " (found 0 sessions)"
          }; skipped orphan cleanup`,
        );
        return;
      }
      if (result.reason === "plan-audit-failed") {
        this.ctx?.logger?.warn?.(
          "session-rewind: cannot write the orphan-cleanup audit plan; skipped orphan cleanup",
        );
        return;
      }
      const removed =
        result.removed.sessions.length +
        result.removed.trash.length +
        result.removed.rescues.length;
      if (removed > 0) {
        this.ctx?.logger?.info?.(
          `session-rewind: cleaned ${removed} orphan data dir(s) (${result.report.bytes} bytes)`,
        );
      }
      for (const failure of result.failed) {
        this.ctx?.logger?.warn?.(
          `session-rewind: cannot remove orphan data "${failure.target}": ${failure.error}`,
        );
      }
      if (removed > 0 || result.failed.length > 0) {
        try {
          await this.store.appendAudit({
            id: `cleanup-${Date.now()}`,
            action: "cleanup-orphans",
            time: Date.now(),
            sessionId: null,
            sessions: result.removed.sessions,
            trash: result.removed.trash,
            rescues: result.removed.rescues,
            bytes: result.report.bytes,
            liveSessionCount: result.report.liveSessionCount,
            failed: result.failed,
          });
        } catch (_error) {
          /* 审计失败不影响清理 */
        }
      }
    } catch (error) {
      this.ctx?.logger?.warn?.(
        `session-rewind: orphan cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 启动维护（失败只告警，不阻塞插件）：
   * 1) 清理已删除会话的残留数据（AUD-REW-01 的护栏在 orphans.js）；
   * 2) 清一次没有任何 entry/manifest 引用的 blob（AUD-REW-24：内容不再长期滞留）。
   * @returns {Promise<void>}
   */
  async startupMaintenance() {
    if (this.config.cleanupOrphans !== false) await this.cleanupOrphans();
    if (this.config.gcOnStartup !== false) await this.collectBlobs();
  }

  /**
   * 清掉无引用的 blob（有引用保护；只删内容，不动 entries/manifests）。
   * @returns {Promise<void>}
   */
  async collectBlobs() {
    try {
      const result = await this.store.collectGarbage();
      if (result.removedBlobs > 0) {
        this.ctx?.logger?.info?.(
          `session-rewind: removed ${result.removedBlobs} unreferenced blob(s) (${result.bytesFreed} bytes)`,
        );
        try {
          await this.store.appendAudit({
            id: `gc-${Date.now()}`,
            action: "gc-blobs",
            time: Date.now(),
            sessionId: null,
            removedBlobs: result.removedBlobs,
            bytesFreed: result.bytesFreed,
          });
        } catch (_error) {
          /* 审计失败不影响 GC */
        }
      }
    } catch (error) {
      this.ctx?.logger?.warn?.(
        `session-rewind: blob GC failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
   * `/rewind @<seq> [chat|both] [confirm]` 命令入口（AUD-REW-09）。
   *
   * `both` 会写工作区文件：先 preview 回执影响面，必须显式带 `confirm` 才执行；运行中的会话
   * 一律拒绝（命令没有确认框来解释「会先停止回合」）。`chat` 行为不变。
   * @param {any} invocation CommandInvocation
   * @returns {Promise<any>}
   */
  async handleRewindCommand(invocation) {
    const parsed = parseRewindCommand(invocation?.rawInput);
    if (parsed.ok !== true) return { kind: "error", text: parsed.text };
    const session = invocation?.agent?.session;
    if (session === undefined) return { kind: "error", text: "No active session." };
    const sessionId = session.id;
    if (parsed.mode === "both") {
      const status = invocation?.agent?.status;
      if (typeof status === "string" && status !== "idle") {
        return {
          kind: "error",
          text: "The session is running. Stop the current turn first (Esc), or pick the message in the UI: the dialog stops the turn for you and shows the full impact before writing.",
        };
      }
      if (parsed.confirmed !== true) {
        let preview;
        try {
          preview = await this.preview({ sessionId, targetSeq: parsed.targetSeq });
        } catch (error) {
          return {
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          };
        }
        if (Array.isArray(preview?.files?.conflicts) && preview.files.conflicts.length > 0) {
          return { kind: "error", text: formatBothConflicts(preview) };
        }
        const blocked = bothModeBlockedReason(preview);
        if (blocked !== null) {
          return { kind: "error", text: formatBothUnavailable(blocked) };
        }
        return { kind: "success", text: formatBothPreview(preview, parsed.targetSeq) };
      }
    }
    try {
      const result = await this.executeRewind({
        sessionId,
        targetSeq: parsed.targetSeq,
        mode: parsed.mode,
        requestedBy: parsed.mode === "both" ? "command-confirm" : "command",
      });
      return {
        kind: "success",
        text: formatRewindReceipt(result, parsed.mode),
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
   * 只读工具的数据面：候选列表 / 单条影响面。绝不写日志。
   * @param {string} sessionId
   * @param {{query?: string, limit?: number, targetSeq?: number}} [request]
   * @returns {Promise<any>}
   */
  async toolPayload(sessionId, request) {
    try {
      const deps = this.deps();
      const { session } = sessionEvents(deps, sessionId);
      const events = session.snapshotEvents();
      const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
      if (typeof request?.targetSeq === "number") {
        const impact = describeToolImpact(events, nodes, request.targetSeq);
        if (impact.ok !== true)
          return { ok: true, value: { kind: "error", session_id: sessionId, error: impact.error } };
        return {
          ok: true,
          value: {
            kind: "impact",
            session_id: sessionId,
            impact: {
              target_seq: impact.targetSeq,
              removed_messages: impact.removedCount,
              crosses_open_tool_call: impact.crossesOpenToolCall,
              text: impact.text,
            },
          },
        };
      }
      const listed = listToolCandidates(events, nodes, {
        ...(typeof request?.query === "string" ? { query: request.query } : {}),
        ...(typeof request?.limit === "number" ? { limit: request.limit } : {}),
      });
      return {
        ok: true,
        value: {
          kind: "list",
          session_id: sessionId,
          total: listed.total,
          candidates: listed.items.map((item) => ({
            seq: item.seq,
            ...(typeof item.time === "number" ? { time: item.time } : {}),
            preview: item.preview,
          })),
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 回溯预览（dry-run）：不写任何东西。
   * @param {{sessionId?: string, targetSeq?: number}} [request]
   */
  async preview(request) {
    try {
      const deps = this.deps();
      const { session, sessionId, plan, targetEvent } = resolveRewindTarget(deps, request, {
        allowRunning: true,
      });
      const events = session.snapshotEvents();
      const tokens = this.estimateTokens(events, plan.shadowedSeqs);
      const target = targetContent(targetEvent);
      const subtitle = target.text.replace(/\s+/gu, " ").trim();
      // 被撤回区间里改过的会话状态（plan/goal/todo/模型…）：回溯不会回滚它们，只提示。
      const stateChanges = stateChangeSummary(events, plan.surfaceStart, plan.surfaceEnd);
      // USIM-U2-20：与面板 ghost 列表同口径的「用户/助手消息」条数。
      const removedMessageCount = countVisibleMessages(events, plan.shadowedSeqs);
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
          removedMessageCount,
          tokens,
          crossesOpenToolCall: hasOpenToolCalls(events, plan.targetSeq),
          reachable: true,
          stateChanges,
        },
        stateChanges,
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
   * 一次回溯的编排：下沉到 rewind-flow.js（不 import 宿主包，可单测，AUD-REW-10）。
   * @returns {any}
   */
  rewindFlow() {
    if (this._flow === null) {
      this._flow = createRewindFlow({
        store: this.store,
        config: this.config,
        trackingEnabled: () => this.trackingEnabled(),
        cwdOf: (/** @type {any} */ session) => cwdOf(session),
        logger: this.ctx?.logger ?? console,
        inflight: this.inflight,
        serviceDeps: () => this.deps(),
        estimateTokens: (/** @type {any[]} */ events, /** @type {number[]} */ seqs) =>
          this.estimateTokens(events, seqs),
        settle: (/** @type {any} */ agent, /** @type {any} */ options) =>
          settleAgent(agent, options),
      });
    }
    return this._flow;
  }

  /**
   * @param {{sessionId?: string, targetSeq?: number, mode: "chat" | "both", requestedBy: string}} input
   * @returns {Promise<any>}
   */
  async executeRewind(input) {
    return this.rewindFlow().execute(input);
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
      // 审计：时间线里要把「从救援点恢复文件」和回溯事件放在同一条轴上。
      try {
        await this.store.appendAudit({
          version: 1,
          action: "rescue-restore",
          id:
            typeof this.store.newAuditId === "function"
              ? this.store.newAuditId()
              : `rr-${Date.now()}`,
          time: Date.now(),
          sessionId,
          rescueId,
          mode: "files",
          targetSeq: null,
          markerSeq: null,
          removedCount: null,
          tokens: null,
          files: {
            restored: result.restored ?? [],
            trashed: [],
            skipped: [],
            failed: result.failed ?? [],
            rescueId: result.safetyRescueId ?? null,
          },
          requestedBy: "ui",
        });
      } catch (error) {
        this.ctx?.logger?.warn?.(
          `session-rewind: rescue-restore audit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
   * 会话回收站操作列表（AUD-REW-08）：被回溯移走的文件在这里可见、可恢复。
   * @param {{sessionId?: string}} [request]
   */
  async trash(request) {
    try {
      const sessionId = request?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new RewindRequestError(ERROR_CODES.notFound, "a session id is required");
      }
      return { operations: await this.store.listTrash({ sessionId }) };
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 从回收站恢复一次回溯移走的文件（恢复前先建 rescue-of-rescue，与救援点恢复同一套安全网）。
   * @param {{sessionId?: string, auditId?: string}} [request]
   */
  async restoreTrash(request) {
    try {
      const deps = this.deps();
      const { session } = sessionEvents(deps, /** @type {any} */ (request?.sessionId));
      const sessionId = session.id;
      const cwd = cwdOf(session);
      if (cwd === undefined) {
        throw new RewindRequestError(
          ERROR_CODES.filesUnavailable,
          "session has no working directory",
        );
      }
      const auditId = request?.auditId;
      if (typeof auditId !== "string" || auditId === "") {
        throw new RewindRequestError(ERROR_CODES.notFound, "a trash id is required");
      }
      const result = await this.store.restoreTrash({ sessionId, cwd, auditId });
      try {
        await this.store.appendAudit({
          version: 1,
          action: "trash-restore",
          id:
            typeof this.store.newAuditId === "function"
              ? this.store.newAuditId()
              : `tr-${Date.now()}`,
          time: Date.now(),
          sessionId,
          trashId: auditId,
          rescueId: result.safetyRescueId ?? null,
          mode: "files",
          targetSeq: null,
          markerSeq: null,
          removedCount: null,
          tokens: null,
          files: {
            restored: result.restored ?? [],
            trashed: [],
            skipped: [],
            failed: result.failed ?? [],
            rescueId: result.safetyRescueId ?? null,
          },
          requestedBy: "ui",
        });
      } catch (error) {
        this.ctx?.logger?.warn?.(
          `session-rewind: trash-restore audit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (Array.isArray(result.failed) && result.failed.length > 0) {
        const error = new RewindRequestError(
          ERROR_CODES.filesFailed,
          "some files could not be restored from the trash",
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
   * 清空一次回收站操作（永久删除）。`dryRun: true` 只回影响面，供客户端二次确认（ADR 0002）。
   * @param {{sessionId?: string, auditId?: string, dryRun?: boolean}} [request]
   */
  async clearTrash(request) {
    try {
      const deps = this.deps();
      const { session } = sessionEvents(deps, /** @type {any} */ (request?.sessionId));
      const sessionId = session.id;
      const auditId = request?.auditId;
      if (typeof auditId !== "string" || auditId === "") {
        throw new RewindRequestError(ERROR_CODES.notFound, "a trash id is required");
      }
      const dryRun = request?.dryRun === true;
      const result = await this.store.clearTrash({ sessionId, auditId, dryRun });
      if (dryRun !== true) {
        try {
          await this.store.appendAudit({
            version: 1,
            action: "trash-clear",
            id:
              typeof this.store.newAuditId === "function"
                ? this.store.newAuditId()
                : `tc-${Date.now()}`,
            time: Date.now(),
            sessionId,
            trashId: auditId,
            mode: "files",
            targetSeq: null,
            markerSeq: null,
            removedCount: null,
            tokens: null,
            files: { restored: [], trashed: [], skipped: [], failed: [], cleared: result.files },
            bytes: result.bytes,
            paths: result.paths,
            requestedBy: "ui",
          });
        } catch (error) {
          this.ctx?.logger?.warn?.(
            `session-rewind: trash-clear audit failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return result;
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 健康检查（doctor）：数据根、usage、追踪状态、可选会话的 marker 形状。
   *
   * 检查项的构造在 ./health.js（host-free、可单测）；这里只提供宿主能力。
   * USIM-U3-06：审计条数按真实行数统计，不再用 `readAudit({ limit: 1 })` 把长度当条数。
   * @param {{sessionId?: string}} [request]
   */
  async health(request) {
    const sessionId =
      typeof request?.sessionId === "string" && request.sessionId !== ""
        ? request.sessionId
        : undefined;
    return buildHealth({
      dataRoot: this.dataRoot,
      trackingEnabled: this.trackingEnabled(),
      store: this.store,
      findOrphans,
      config: this.config,
      readOnlyToolInstalled: this.readOnlyToolInstalled === true,
      ...(sessionId === undefined
        ? {}
        : {
            sessionId,
            sessionCheck: (/** @type {string} */ id) => {
              const { events, session } = sessionEvents(this.deps(), id);
              return sessionHealthFacts(events, cwdOf(session));
            },
          }),
    });
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
declareRemote(SessionRewindService, "trash");
declareRemote(SessionRewindService, "restoreTrash");
declareRemote(SessionRewindService, "clearTrash");
declareRemote(SessionRewindService, "health");
