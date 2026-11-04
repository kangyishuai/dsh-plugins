// @ts-check
// Typert Remote 包装层：把 operations 的方法暴露给浏览器，一条 /api 通道。
// declareRemote 的写法参考 Jaylor-Wang/dsh-tool-session-delete（MIT），见根目录 NOTICE。
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
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
   * @param {{ sessionId: string, digest?: string, title?: string | null }} request
   */
  async trash(request) {
    try {
      return await this.ops.trash(request?.sessionId, {
        digest: request?.digest,
        title: request?.title,
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

  /** 全库体检：只读。 */
  async healthScan() {
    try {
      return await this.ops.scanHealth();
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
declareRemote(SessionDeleteService, "healthScan");
declareRemote(SessionDeleteService, "cleanHealth");
declareRemote(SessionDeleteService, "reconcile");
