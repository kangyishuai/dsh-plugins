// @ts-check
// host 半：Typert Remote Service + 工具 + Web 路由。
//
// Remote 方法必须声明在**导出的类自身原型**上（见 docs/runtime/0.2.1-rc.5.md §6.10），
// 运行时不支持装饰器语法，所以用 declareRemote 的命令式写法（与 advisor / session-rewind 一致）。
//
// 方法体只是把请求交给 ./library.js（契约逻辑放那里，单测能直接覆盖）；这一层不做业务判断。
// 漏一条 declareRemote 只会让那**一个**端点 404（docs/runtime/0.2.2-rc.3.md §12.6），
// test/remote-declarations.test.js 用静态对账拦住这种漏写。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { describeAudit, formatAudit } from "./audit.js";
import { createArtifactLibrary, LIBRARY_METHODS } from "./library.js";
import { createRouteHandler } from "./route.js";
import { createArtifactStore, resolveDataRoot } from "./store.js";
import { createToolDefinition } from "./tool.js";

/** 路由前缀：GET /artifacts/<id>[?v=N][&download=1]。 */
export const ROUTE_PREFIX = "/artifacts";

/**
 * 命令式登记 Remote 方法（运行时不支持装饰器）。
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
  if (initializers.length !== 1)
    throw new Error(`artifacts: cannot declare Remote method ${method}`);
  initializers[0].call(Object.create(Proto.prototype));
}

/** 服务名：客户端用 `artifacts/<method>` 调用。 */
export const SERVICE_NAME = "artifacts";

export class ArtifactsService extends TypertRemoteService {
  /**
   * @param {any} ctx
   * @param {any} [config]
   */
  constructor(ctx, config) {
    super(ctx, SERVICE_NAME);
    this.config = config ?? {};
    this.logger = ctx?.logger ?? console;
    this.dataRoot = resolveDataRoot(this.config);
    this.store = createArtifactStore({ root: this.dataRoot });
    this.library = createArtifactLibrary({ store: this.store, routePrefix: ROUTE_PREFIX });

    // Cordis 的服务必须在 inject 作用域里取：直接读 ctx.webServer 会抛 "cannot get property without inject"。
    /** @type {any} */
    let webServer;
    try {
      this.ctx.inject?.(/** @type {any} */ (["webServer"]), (/** @type {any} */ scope) => {
        webServer = scope.webServer;
      });
    } catch (error) {
      this.logger.warn("[artifacts] no web server (headless profile?)", error);
    }
    const baseUrl = () => {
      const port = webServer?.port;
      if (typeof port !== "number" || port <= 0) return "";
      const protocol = typeof webServer?.protocol === "string" ? webServer.protocol : "http:";
      return `${protocol}//127.0.0.1:${port}`;
    };
    this.baseUrl = baseUrl;
    this.installTool();
    this.installRoute();
  }

  /** 注册 `artifact` 工具。 */
  installTool() {
    const definition = createToolDefinition({ store: this.store, baseUrl: this.baseUrl });
    try {
      this.ctx.inject?.(/** @type {any} */ (["tools"]), (/** @type {any} */ scope) => {
        scope.effect(() => {
          const dispose = scope.tools.register(definition);
          return () => {
            if (typeof dispose === "function") dispose();
          };
        }, "artifacts: tool");
      });
    } catch (error) {
      this.logger.warn("[artifacts] cannot install tool", error);
    }
  }

  /** 注册只读路由。 */
  installRoute() {
    try {
      // connection 也要在 inject 作用域里取，否则 requestRejection 会抛错。
      this.ctx.inject?.(
        /** @type {any} */ (["webServer", "connection"]),
        (/** @type {any} */ scope) => {
          const handler = createRouteHandler({
            store: this.store,
            connection: () => scope.connection,
          });
          scope.effect(
            () => scope.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }),
            "artifacts: route",
          );
        },
      );
    } catch (error) {
      this.logger.warn("[artifacts] cannot install route (no web server?)", error);
    }
  }

  /**
   * 审计日志（ADR 0002 §4）：破坏性操作必须留痕——做了什么、影响多少、是否 dry-run。
   * 记录由纯函数 `describeAudit()` 生成、结果存在**每次调用的局部变量**里：
   * 不要退回到 `this.lastAudit` 之类的共享字段，并发时会串号（见 ./audit.js 头部）。
   * @param {import("./audit.js").AuditRecord} record
   * @returns {void}
   */
  audit(record) {
    if (record.level === "warn")
      this.logger.warn?.(formatAudit(record), record.code, record.fields);
    else this.logger.info?.(formatAudit(record), record.fields);
  }

  // ---- Remote 方法：全部转交 ./library.js ---------------------------------
  // 参数形状与返回信封见 docs/plugin-conventions.md §8（跨插件契约）。

  /**
   * 列表 + 汇总。参数 `{ projectId?, sessionId?, threadId?, kind?, title?, since?, until?,
   * includeArchived?, onlyArchived?, limit? }`；不传 `projectId` = 全量。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async list(request) {
    return this.library.list(request ?? {});
  }

  /**
   * 轮询/预览：`{ id, since? }`。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async latest(request) {
    return this.library.latest(request ?? {});
  }

  /**
   * 契约探针（无参数）：返回 contract / packageVersion / kinds / maxBytes / methods。
   * @returns {Promise<any>}
   */
  async version() {
    return this.library.version();
  }

  /**
   * 归档/取消归档：`{ ids?, projectId?, archived?, dryRun? }`。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async archive(request) {
    // try/finally：即使契约层意外抛出（真实 bug / 宿主序列化失败），审计也要落一条。
    // 结果与异常都是**本次调用的局部变量**——并发调用不会读到彼此的状态。
    /** @type {{ result?: any, failure?: unknown }} */
    const call = {};
    try {
      call.result = await this.library.archive(request ?? {});
      return call.result;
    } catch (error) {
      call.failure = error;
      throw error;
    } finally {
      this.audit(describeAudit("archive", call.result, call.failure));
    }
  }

  /**
   * 级联清理（默认移入回收站）：`{ ids?, projectId?, dryRun? }`。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async remove(request) {
    // try/finally：即使契约层意外抛出（真实 bug / 宿主序列化失败），审计也要落一条。
    // 结果与异常都是**本次调用的局部变量**——并发调用不会读到彼此的状态。
    /** @type {{ result?: any, failure?: unknown }} */
    const call = {};
    try {
      call.result = await this.library.remove(request ?? {});
      return call.result;
    } catch (error) {
      call.failure = error;
      throw error;
    } finally {
      this.audit(describeAudit("remove", call.result, call.failure));
    }
  }

  /**
   * 从回收站恢复：`{ ids, dryRun? }`。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async restore(request) {
    // try/finally：即使契约层意外抛出（真实 bug / 宿主序列化失败），审计也要落一条。
    // 结果与异常都是**本次调用的局部变量**——并发调用不会读到彼此的状态。
    /** @type {{ result?: any, failure?: unknown }} */
    const call = {};
    try {
      call.result = await this.library.restore(request ?? {});
      return call.result;
    } catch (error) {
      call.failure = error;
      throw error;
    } finally {
      this.audit(describeAudit("restore", call.result, call.failure));
    }
  }

  /**
   * 回收站清单（无参数）。
   * @returns {Promise<any>}
   */
  async trash() {
    return this.library.trash();
  }

  /**
   * 硬删回收站条目（不可恢复）：`{ ids?, projectId?, dryRun? }`。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async purge(request) {
    // try/finally：即使契约层意外抛出（真实 bug / 宿主序列化失败），审计也要落一条。
    // 结果与异常都是**本次调用的局部变量**——并发调用不会读到彼此的状态。
    /** @type {{ result?: any, failure?: unknown }} */
    const call = {};
    try {
      call.result = await this.library.purge(request ?? {});
      return call.result;
    } catch (error) {
      call.failure = error;
      throw error;
    } finally {
      this.audit(describeAudit("purge", call.result, call.failure));
    }
  }
}

for (const method of LIBRARY_METHODS) declareRemote(ArtifactsService, method);
