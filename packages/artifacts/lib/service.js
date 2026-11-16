// @ts-check
// host 半：Typert Remote Service + 工具 + Web 路由。
//
// Remote 方法必须声明在**导出的类自身原型**上（见 docs/runtime/0.2.1-rc.5.md §6.10），
// 运行时不支持装饰器语法，所以用 declareRemote 的命令式写法（与 advisor / session-rewind 一致）。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createRouteHandler } from "./route.js";
import { createArtifactStore, resolveDataRoot } from "./store.js";
import { createToolDefinition } from "./tool.js";

/** 路由前缀：GET /artifacts/<id>[?v=N]。 */
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
   * 客户端轮询用：只返回版本号与变更后的正文。
   * @param {any} [request]
   * @returns {Promise<any>}
   */
  async latest(request) {
    const id = String(request?.id ?? "");
    const since = Number(request?.since ?? 0);
    const found = await this.store.read(id);
    if (found === undefined)
      return { ok: false, code: "artifacts/not-found", message: `unknown artifact: ${id}` };
    const meta = found.meta;
    const bytes = meta.versions[meta.versions.length - 1]?.bytes ?? 0;
    if (Number.isInteger(since) && since === found.version) {
      return { ok: true, id, title: meta.title, version: found.version, changed: false };
    }
    return {
      ok: true,
      id,
      title: meta.title,
      version: found.version,
      versions: meta.versions.map((/** @type {any} */ item) => item.version),
      bytes,
      changed: true,
      coverUrl: `${ROUTE_PREFIX}/${encodeURIComponent(id)}/cover.svg`,
      html: found.html,
    };
  }

  /**
   * 列表：面板与工具行都用它。
   * @returns {Promise<any>}
   */
  async list() {
    const rows = await this.store.list();
    return {
      ok: true,
      artifacts: rows.map((/** @type {any} */ meta) => ({
        id: meta.id,
        title: meta.title,
        latest: meta.latest,
        bytes: meta.versions[meta.versions.length - 1]?.bytes ?? 0,
        updatedAt: meta.updatedAt,
        coverUrl: `${ROUTE_PREFIX}/${encodeURIComponent(meta.id)}/cover.svg`,
      })),
    };
  }
}

declareRemote(ArtifactsService, "latest");
declareRemote(ArtifactsService, "list");
