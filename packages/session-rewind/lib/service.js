// @ts-check
// Typert Remote 包装层：服务名 sessionRewind，向浏览器暴露 candidates / rewind / cuts。
//
// Remote 方法必须声明在「被导出的那个类自身」的原型上，否则 Typert 网关不会
// claim 端点（所有 /api/sessionRewind/* 会 404），见 docs/runtime/0.2.1-rc.5.md §6.10。
// 因此 lib/index.js 直接导出本类，不要再包一层子类。
// declareRemote 的写法参考 session-delete/lib/service.js（无装饰器运行时的等价登记）。

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  candidatesResponse,
  createMarkerMessageInput,
  cutsResponse,
  ERROR_CODES,
  RewindRequestError,
  rewindResponse,
} from "./operations.js";

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
 * 安全地从 ctx 上取一个宿主服务（Cordis 用 ctx.get；测试替身可能直接挂属性）。
 * @param {any} ctx host 上下文
 * @param {string} name 服务名
 * @returns {any}
 */
function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get === "function") return ctx.get(name);
  } catch {
    return undefined;
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 把内部错误转成线缆上的 RemoteError。业务失败已经带 `session-rewind/*` code；
 * 其余（宿主拒绝 append、服务缺失等）统一归到 failed，保留原始 message。
 * @param {unknown} error
 * @returns {never}
 */
function rethrowRemote(error) {
  if (error instanceof RemoteError) throw error;
  if (error instanceof RewindRequestError) {
    throw new RemoteError(error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new RemoteError(ERROR_CODES.failed, message);
}

export class SessionRewindService extends TypertRemoteService {
  /**
   * @param {any} ctx host 上下文
   */
  constructor(ctx) {
    super(ctx, "sessionRewind");
    /** 每会话的进行中请求，防止同会话并发回溯。 @type {Set<string>} */
    this.inflight = new Set();
  }

  /**
   * 惰性解析宿主服务：能力必须在服务挂载之后探测，不能在构造函数里固化。
   * @returns {import("./operations.js").ServiceDeps}
   */
  deps() {
    const sessions = serviceOf(this.ctx, "sessions");
    const agents = serviceOf(this.ctx, "agents");
    return {
      available: Boolean(sessions) || Boolean(agents),
      getAgent: (sessionId) =>
        typeof agents?.get === "function" ? agents.get(sessionId) : undefined,
      getSession: (sessionId) =>
        typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined,
      createMarkerMessage: (targetSeq) => createUserMessage(createMarkerMessageInput(targetSeq)),
      inflight: this.inflight,
    };
  }

  /**
   * 列出可回溯的真人用户消息（最新在前）。
   * @param {{ sessionId?: string, limit?: number }} [request]
   */
  async candidates(request) {
    try {
      return candidatesResponse(this.deps(), request);
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 回溯到某条用户消息之前：追加 marker，把目标及其后的内容移出模型上下文。
   * @param {{ sessionId?: string, targetSeq?: number }} [request]
   */
  async rewind(request) {
    try {
      return rewindResponse(this.deps(), request);
    } catch (error) {
      rethrowRemote(error);
    }
  }

  /**
   * 已存在的回溯区间（客户端从日志兜底）。
   * @param {{ sessionId?: string }} [request]
   */
  async cuts(request) {
    try {
      return cutsResponse(this.deps(), request);
    } catch (error) {
      rethrowRemote(error);
    }
  }
}

declareRemote(SessionRewindService, "candidates");
declareRemote(SessionRewindService, "rewind");
declareRemote(SessionRewindService, "cuts");
