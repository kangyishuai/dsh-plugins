// @ts-check
// Typert Remote 包装层：把 operations 的方法暴露给浏览器，一条 /api 通道。
// declareRemote 的写法参考 Jaylor-Wang/dsh-tool-session-delete（MIT），见根目录 NOTICE。
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  createAgentToolController,
  normalizeToolError,
  summarizePlanForModel,
} from "./agent-tool.js";
import { createOperations } from "./operations.js";
import { resolveDataRoot } from "./paths.js";

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
    throw new Error("session-delete: cannot declare Remote method " + method);
  }
  initializers[0].call(Object.create(Proto.prototype));
}

/**
 * @param {unknown} error
 * @returns {never}
 */
function rethrow(error) {
  if (error instanceof RemoteError) throw error;
  const code = /** @type {any} */ (error)?.code;
  const message = error instanceof Error ? error.message : String(error);
  throw new RemoteError(typeof code === "string" ? code : "session-delete/failed", message, {
    details: /** @type {any} */ (error)?.details ?? null,
  });
}

export class SessionDeleteService extends TypertRemoteService {
  /**
   * @param {any} ctx host 上下文
   * @param {{ dataRoot?: unknown }} [config]
   */
  constructor(ctx, config) {
    super(ctx, "sessionDelete");
    this.config = config ?? {};
    /** @type {any} */
    this._ops = null;
    /** @type {boolean} */
    this.agentToolRegistered = false;
    this.installAgentTool();
  }

  /**
   * 惰性创建操作层：能力探测必须发生在宿主服务挂载之后，不能在构造函数里固化。
   * @returns {any}
   */
  get ops() {
    if (this._ops === null) {
      this._ops = createOperations({
        ctx: this.ctx,
        dataRoot: resolveDataRoot(this.config),
        logger: this.ctx.logger ?? console,
      });
    }
    return this._ops;
  }

  /** 能力快照、数据根、待恢复的操作数。 */
  async health() {
    return this.ops.health();
  }

  /**
   * 注册模型工具：两段式 plan → token → delete。
   * 必须等 ctx.tools 就绪：插件构造时 tools 运行时可能还没挂载，
   * 用 ctx.inject 延迟到服务可用（并在服务重建时重新注册）。
   */
  installAgentTool() {
    const register = (/** @type {any} */ scopedCtx) => {
      void this.registerAgentTool(scopedCtx);
    };
    try {
      if (typeof this.ctx?.inject === "function") {
        this.ctx.inject(["tools"], register);
        return;
      }
      register(this.ctx);
    } catch (error) {
      this.ctx?.logger?.warn?.(
        "session-delete: cannot schedule agent tool registration: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * @param {any} scopedCtx 注入 tools 之后的上下文
   */
  async registerAgentTool(scopedCtx) {
    try {
      const tools = scopedCtx?.tools;
      if (!tools || typeof tools.register !== "function") return;
      const module = await import("@deepseek-ai/dsh-tools");
      const defineTool = module.defineTool;
      if (typeof defineTool !== "function") return;
      const controller = createAgentToolController({
        ops: {
          plan: (/** @type {string} */ sessionId) => this.ops.plan(sessionId),
          trash: (/** @type {string} */ sessionId, /** @type {any} */ request) =>
            this.ops.trash(sessionId, request),
        },
      });
      tools.register(
        defineTool({
          name: "session_delete",
          description:
            "Delete a DSH session permanently but recoverably (moves it to the local trash). " +
            "Two steps are mandatory: call with action=plan to preview what will be removed and obtain a single-use token, " +
            "then call again with action=delete and that token. Never delete the caller's own session. " +
            "The token expires in 2 minutes and becomes invalid if the session changes.",
          parameters: {
            action: {
              type: "string",
              required: true,
              enum: ["plan", "delete"],
              description: "plan = read-only preview and token; delete = execute with the token",
            },
            sessionId: { type: "string", required: true, description: "Target session id" },
            token: { type: "string", description: "Required for action=delete; from action=plan" },
            cascade: {
              type: "boolean",
              description: "Also delete child (subagent) sessions; default false",
            },
          },
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (/** @type {any} */ _args, /** @type {any} */ value) => [
              { type: "text", text: JSON.stringify(value, null, 2) },
            ],
          },
          async execute(/** @type {any} */ args, /** @type {any} */ exec) {
            const agent = exec?.agent;
            const callerSessionId =
              agent?.session?.id ?? agent?.session?.header?.id ?? agent?.sessionId ?? undefined;
            try {
              if (args.action === "plan") {
                const result = await controller.plan({
                  sessionId: args.sessionId,
                  cascade: args.cascade,
                });
                return Object.assign({}, result, { summary: summarizePlanForModel(result) });
              }
              return await controller.remove({
                sessionId: args.sessionId,
                token: args.token,
                cascade: args.cascade,
                callerSessionId: typeof callerSessionId === "string" ? callerSessionId : undefined,
              });
            } catch (error) {
              return normalizeToolError(error);
            }
          },
        }),
      );
      this.agentToolRegistered = true;
      this.ctx.logger?.info?.("session-delete: agent tool registered: session_delete");
    } catch (error) {
      this.ctx.logger?.warn?.(
        "session-delete: agent tool unavailable: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * 只读：返回完整影响面（plan/dry-run 的数据源）。
   * @param {{ sessionId: string }} request
   */
  async plan(request) {
    try {
      return await this.ops.plan(request?.sessionId);
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 把会话移入回收站。
   * @param {{ sessionId: string, digest?: string, title?: string | null, cascade?: boolean }} request
   */
  async trash(request) {
    try {
      return await this.ops.trash(request?.sessionId, {
        digest: request?.digest,
        title: request?.title,
        cascade: request?.cascade === true,
        operator: "ui",
      });
    } catch (error) {
      rethrow(error);
    }
  }

  async list() {
    try {
      return await this.ops.list();
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 从回收站恢复。
   * @param {{ entryId: string }} request
   */
  async restore(request) {
    try {
      return await this.ops.restore(request?.entryId, { operator: "ui" });
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 彻底删除一个回收站条目。
   * @param {{ entryId: string }} request
   */
  async purge(request) {
    try {
      return await this.ops.purge(request?.entryId, { operator: "ui" });
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * @param {{ limit?: number }} [request]
   */
  async audit(request) {
    try {
      return await this.ops.auditLog(request?.limit ?? 100);
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 批量恢复回收站条目。
   * @param {{ entryIds?: string[] }} request
   */
  async restoreMany(request) {
    try {
      return await this.ops.restoreMany({ entryIds: request?.entryIds, operator: "ui" });
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 批量彻底删除回收站条目。
   * @param {{ entryIds?: string[] }} request
   */
  async purgeMany(request) {
    try {
      return await this.ops.purgeMany({ entryIds: request?.entryIds, operator: "ui" });
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 最近的操作回执。
   * @param {{ limit?: number }} [request]
   */
  async receipts(request) {
    try {
      return await this.ops.receipts(request?.limit ?? 50);
    } catch (error) {
      rethrow(error);
    }
  }

  /** 全库体检：只读。 */
  async healthScan() {
    try {
      const report = await this.ops.scanHealth();
      return Object.assign({}, report, { agentTool: this.agentToolRegistered === true });
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * 清理体检发现的失效引用（只动登记表）。
   * @param {{ classes?: string[] }} [request]
   */
  async cleanHealth(request) {
    try {
      return await this.ops.cleanHealth({ classes: request?.classes, operator: "ui" });
    } catch (error) {
      rethrow(error);
    }
  }

  /**
   * @param {{ sessionId: string }} request
   */
  async reconcile(request) {
    try {
      return { checks: await this.ops.reconcile(request?.sessionId) };
    } catch (error) {
      rethrow(error);
    }
  }
}

declareRemote(SessionDeleteService, "health");
declareRemote(SessionDeleteService, "plan");
declareRemote(SessionDeleteService, "trash");
declareRemote(SessionDeleteService, "list");
declareRemote(SessionDeleteService, "restore");
declareRemote(SessionDeleteService, "purge");
declareRemote(SessionDeleteService, "audit");
declareRemote(SessionDeleteService, "restoreMany");
declareRemote(SessionDeleteService, "purgeMany");
declareRemote(SessionDeleteService, "receipts");
declareRemote(SessionDeleteService, "healthScan");
declareRemote(SessionDeleteService, "cleanHealth");
declareRemote(SessionDeleteService, "reconcile");
