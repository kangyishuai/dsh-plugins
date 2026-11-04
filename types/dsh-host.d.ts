/**
 * DSH 宿主服务的最小类型声明（手写，仅供 JSDoc 类型检查）。
 *
 * - 依据：DSH 桌面版 0.2.1-rc.5 的勘察结果，见 docs/runtime/0.2.1-rc.5.md
 * - 只声明本仓库实际用到、且已验证过的成员；没验证的一律标成可选或 unknown。
 * - DSH 升级后先核对这里，再改插件代码。
 */
declare namespace DSH {
  interface Logger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  interface SessionRegistry {
    /** 把 live 会话状态落盘 */
    flush(): Promise<void>;
  }

  interface SessionPersistence {
    /** 读取会话日志的元信息（体积等）。注意：没有删除接口 */
    stat(sessionId: string): Promise<Record<string, unknown> | undefined>;
  }

  interface WorkspaceRegistry {
    archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>;
    unarchiveSession(sessionId: string): Promise<void>;
    detachSession(sessionId: string): Promise<void>;
  }

  /** host 半 `apply(ctx, config)` 拿到的 Cordis 上下文 */
  interface HostContext {
    logger: Logger;
    sessions?: SessionRegistry;
    sessionPersistence?: SessionPersistence;
    workspaceRegistry?: WorkspaceRegistry;
    [service: string]: unknown;
  }
}
