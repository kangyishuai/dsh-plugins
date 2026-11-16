// @ts-check
// host 半的 Typert Remote Service：项目 CRUD、会话归属、上下文注入的挂载点。
// 注意（docs/runtime/0.2.1-rc.5.md §6.10）：Remote 方法必须声明在**这个被导出的类自身原型**上，
// 否则网关不会 claim 端点，所有 /api/projects/* 返回 404。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { attachProjectContext } from "./attach.js";
import { readProjectFiles } from "./project-files.js";
import { ProjectStore } from "./store.js";

/**
 * 运行时不支持装饰器语法，用命令式方式登记 Remote（与 advisor / next-step 同法）。
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
  if (initializers.length !== 1) {
    throw new Error(`projects: cannot declare Remote method ${method}`);
  }
  initializers[0].call(Object.create(Proto.prototype));
}

/**
 * 数据根必须可注入：优先配置项，其次进程环境给的 DSH_HOME。
 * @param {Record<string, unknown>|undefined} config
 * @returns {string}
 */
export function resolveDataRoot(config) {
  const configured = config?.dataRoot;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home !== "") return `${home}/projects`;
  throw new Error("projects: no data root; set config.dataRoot or export DSH_HOME");
}

export class ProjectsService extends TypertRemoteService {
  /**
   * @param {any} ctx
   * @param {Record<string, unknown>} [config]
   */
  constructor(ctx, config) {
    super(ctx, "projects");
    this.logger = ctx?.logger ?? console;
    /** @type {ProjectStore|undefined} */
    this.store = undefined;
    /** @type {string} */
    this.dataRoot = "";
    /** @type {Map<string, () => void>} */
    this.attached = new Map();
    /** @type {any} */
    this.agents = undefined;

    // Cordis 里未 inject 的服务属性访问会抛错（0.2.2-rc.3 实测），必须显式 inject。
    ctx.inject?.(["agents"], (/** @type {any} */ scope) => {
      this.agents = scope.agents;
    });

    try {
      this.dataRoot = resolveDataRoot(config);
      this.store = new ProjectStore({ root: this.dataRoot }).load();
      this.logger.info?.(
        `[projects] loaded ${this.store.listProjects().length} project(s) from ${this.store.file}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.(`[projects] store unavailable: ${message}`);
    }

    ctx.on?.("agent/created", (/** @type {any} */ payload) => this.onAgentCreated(payload?.agent));
    ctx.on?.("agent/disposed", (/** @type {any} */ payload) =>
      this.onAgentDisposed(payload?.agent?.id),
    );
    ctx.effect?.(() => () => {
      for (const dispose of this.attached.values()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      this.attached.clear();
    });
  }

  /**
   * 不能用 `#` 私有方法：Cordis 把 service 实例包成 Proxy，私有方法经代理调用会抛
   * `Receiver must be an instance of class ProjectsService`（0.2.2-rc.3 实测）。
   * @param {any} agent
   */
  onAgentCreated(agent) {
    const sessionId = agent?.id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    try {
      const result = attachProjectContext(this.store, this.dataRoot, agent);
      if (!result) return;
      this.attached.set(sessionId, result.dispose);
      this.logger.info?.(`[projects] project context attached to ${sessionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.(`[projects] context attach failed for ${sessionId}: ${message}`);
    }
  }

  /** @param {string|undefined} sessionId */
  onAgentDisposed(sessionId) {
    if (typeof sessionId !== "string") return;
    const dispose = this.attached.get(sessionId);
    this.attached.delete(sessionId);
    try {
      dispose?.();
    } catch {
      /* ignore */
    }
  }

  /** @returns {any} */
  requireStore() {
    if (!this.store) throw new Error("projects: store is unavailable");
    return this.store;
  }

  // ---- Remote：只读 ----

  listProjects() {
    const store = this.requireStore();
    // 顺带给出线程数：面板要用它显示「N 个线程」，避免每个项目再发一次 RPC。
    return store.listProjects().map((/** @type {any} */ project) => ({
      ...project,
      threadCount: store.listThreads(project.id).length,
    }));
  }

  /** @param {string} id */
  getProject(id) {
    return this.requireStore().getProject(id) ?? null;
  }

  /** @param {string} projectId */
  listThreads(projectId) {
    return this.requireStore().listThreads(projectId);
  }

  /** @param {string} sessionId */
  projectOfSession(sessionId) {
    return this.requireStore().projectOfSession(sessionId) ?? null;
  }

  /**
   * 项目内容文件（只读）：常设规则与记忆索引。
   * @param {string} projectId
   */
  getProjectContent(projectId) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const files = readProjectFiles(this.dataRoot, projectId);
    return { instructions: files.instructions, memoryIndex: files.memoryIndex };
  }

  /**
   * 审计尾巴（只读）：默认返回全局最近 100 条，给了 projectId 就只返回该项目的。
   * @param {string|undefined} projectId
   */
  listAudit(projectId) {
    const store = this.requireStore();
    const entries = Array.isArray(store.state?.audit) ? store.state.audit : [];
    const filtered = projectId
      ? entries.filter((/** @type {any} */ entry) => entry.projectId === projectId)
      : entries;
    return filtered.slice(-100);
  }

  // ---- Remote：写 ----

  /**
   * @param {string} name
   * @param {{goal?: string, dirs?: string[]}} [input]
   */
  createProject(name, input) {
    // SRC 模式（无生成描述符）要求 Remote 方法不带默认参数/解构/rest，否则网关直接拒绝。
    const store = this.requireStore();
    const project = store.createProject(name, input ?? {});
    store.save();
    return project;
  }

  /**
   * @param {string} id
   * @param {any} patch
   */
  updateProject(id, patch) {
    const store = this.requireStore();
    const project = store.updateProject(id, patch);
    store.save();
    return project;
  }

  /** @param {string} id */
  archiveProject(id) {
    const store = this.requireStore();
    const project = store.archiveProject(id);
    store.save();
    // 归档后立刻摘掉在线会话的项目上下文：否则已挂上的 agent 会带着归档项目的规则继续跑。
    for (const thread of store.listThreads(id)) {
      this.detachSession(thread.sessionId);
    }
    return project;
  }

  /**
   * 摘掉一个会话已挂的项目上下文（不动归属记录）。
   * @param {string} sessionId
   */
  detachSession(sessionId) {
    const dispose = this.attached.get(sessionId);
    if (!dispose) return false;
    this.attached.delete(sessionId);
    try {
      dispose();
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * @param {string} sessionId
   * @param {string} projectId
   */
  attachThread(sessionId, projectId) {
    const store = this.requireStore();
    const thread = store.attachThread(sessionId, projectId);
    store.save();
    // 会话通常先被创建、后归属：此时 agent 已经在线，补挂一次上下文，
    // 否则上下文要等到下次 resume 才生效（实测：create 后 250ms 内 agent 已就绪）。
    try {
      const agent = this.agents?.get?.(sessionId);
      if (agent && !this.attached.has(sessionId)) {
        const result = attachProjectContext(this.store, this.dataRoot, agent);
        if (result) this.attached.set(sessionId, result.dispose);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.(`[projects] live attach failed for ${sessionId}: ${message}`);
    }
    return thread;
  }

  /** 诊断：哪些会话已挂上项目上下文（只读，供冒烟/排障）。 */
  debugAttached() {
    return [...this.attached.keys()];
  }

  /** 只读概览：数据根、项目数、已挂上下文的会话数（给客户端首屏与冒烟用）。 */
  describe() {
    const projects = this.store ? this.store.listProjects() : [];
    return {
      dataRoot: this.dataRoot,
      available: Boolean(this.store),
      projectCount: projects.length,
      activeCount: projects.filter((p) => p.state === "active").length,
      attachedSessions: this.attached.size,
    };
  }

  /** @param {string} sessionId */
  detachThread(sessionId) {
    const store = this.requireStore();
    const removed = store.detachThread(sessionId);
    store.save();
    return removed;
  }
}

declareRemote(ProjectsService, "listProjects");
declareRemote(ProjectsService, "getProject");
declareRemote(ProjectsService, "listThreads");
declareRemote(ProjectsService, "projectOfSession");
declareRemote(ProjectsService, "createProject");
declareRemote(ProjectsService, "updateProject");
declareRemote(ProjectsService, "archiveProject");
declareRemote(ProjectsService, "attachThread");
declareRemote(ProjectsService, "detachThread");
declareRemote(ProjectsService, "debugAttached");
declareRemote(ProjectsService, "detachSession");
declareRemote(ProjectsService, "describe");
declareRemote(ProjectsService, "getProjectContent");
declareRemote(ProjectsService, "listAudit");
