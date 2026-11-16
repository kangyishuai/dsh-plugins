// @ts-check
// host 半的 Typert Remote Service：项目 CRUD、会话归属、上下文注入的挂载点。
// 注意（docs/runtime/0.2.1-rc.5.md §6.10）：Remote 方法必须声明在**这个被导出的类自身原型**上，
// 否则网关不会 claim 端点，所有 /api/projects/* 返回 404。
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { attachProjectContext } from "./attach.js";
import { initialView, reduce, sortRows } from "./overview.js";
import { readProjectFiles } from "./project-files.js";
import { ProjectStore } from "./store.js";
import { createIsolatedThread, reclaimThreadWorktree, reconcileWorktrees } from "./thread.js";

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

const execFile = promisify(execFileCallback);

/**
 * 跑一次 git。
 * 为什么不用 ctx.subprocess：那是个策略 seam（SubprocessSpawnSpec 要 argv/stdio/graceMs，
 * 返回的是带采集上限的句柄），而这里只需要一次短命令的 stdout/exit code。
 * 插件本身就跑在宿主 Node 进程里，node:child_process 总是可用；git 的失败一律由调用方降级。
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runGit(args, cwd) {
  try {
    const { stdout, stderr } = await execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    return {
      code: Number(anyError?.code ?? 1),
      stdout: String(anyError?.stdout ?? ""),
      stderr: String(anyError?.stderr ?? ""),
    };
  }
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
    /** 每个线程会话的状态视图（从持久事件归约，重启后可由 replay 重建）。 @type {Map<string, any>} */
    this.views = new Map();
    /** @type {any} */
    this.agents = undefined;
    /** @type {any} */
    this.sessionController = undefined;

    // Cordis 里未 inject 的服务属性访问会抛错（0.2.2-rc.3 实测），必须显式 inject。
    // inject 回调是异步的：外部可能在本服务刚构造、回调还没跑时就调 createThread。
    // 用一个就绪 Promise 兜住这个时序（配上超时，避免依赖缺失时永久挂起）。
    /** @type {() => void} */
    let markReady = () => {};
    this.servicesReady = new Promise((resolve) => {
      markReady = () => resolve(undefined);
    });
    ctx.inject?.(["agents", "sessionController"], (/** @type {any} */ scope) => {
      this.agents = scope.agents;
      this.sessionController = scope.sessionController;
      markReady();
    });
    ctx.inject?.(["sessionController"], (/** @type {any} */ scope) => {
      this.sessionController = scope.sessionController;
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
    // 启动对账：记录有、磁盘没的 worktree 直接清掉记录（反向不删，只报告）
    try {
      if (this.store) {
        const changes = reconcileWorktrees(this.store, { exists: (path) => existsSync(path) });
        if (changes.length > 0) {
          for (const change of changes) {
            this.store.appendAudit({
              action: "worktree/missing",
              projectId: null,
              sessionId: change.sessionId,
            });
          }
          this.store.save();
          this.logger.info?.(`[projects] reconciled ${changes.length} missing worktree(s)`);
        }
      }
    } catch (error) {
      this.logger.warn?.(
        `[projects] reconcile failed: ${String(/** @type {any} */ (error)?.message ?? error)}`,
      );
    }

    // 归档一个会话 → 尽力回收它的 worktree（脏/未推送/当前会话会被拒绝）
    ctx.on?.("workspace/session-archived", (/** @type {any} */ request) => {
      const sessionId = String(request?.sessionId ?? "");
      if (sessionId === "") return undefined;
      void this.onSessionArchived(sessionId);
      return undefined;
    });

    ctx.on?.("session/event", (/** @type {any} */ session, /** @type {any} */ event) => {
      const sessionId = String(session?.id ?? "");
      if (sessionId === "" || !this.store) return;
      // 只跟项目线程，其它会话零开销
      if (!this.store.projectOfSession(sessionId)) return;
      const previous = this.views.get(sessionId) ?? initialView();
      this.views.set(sessionId, reduce(previous, event));
    });
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

  /**
   * 会话归档后的回收钩子：不抛错（归档已经成功，回收失败只记录）。
   * @param {string} sessionId
   */
  async onSessionArchived(sessionId) {
    try {
      const store = this.requireStore();
      if (!store.projectOfSession(sessionId)) return;
      const result = await reclaimThreadWorktree({
        store,
        sessionId,
        deps: { runGit },
      });
      store.appendAudit({
        action: "worktree/reclaim",
        projectId: null,
        sessionId,
        result: result.reason || "ok",
      });
      store.save();
      if (!result.reclaimed) {
        this.logger.info?.(`[projects] kept worktree for ${sessionId}: ${result.reason}`);
      }
    } catch (error) {
      this.logger.warn?.(
        `[projects] archive reclaim failed for ${sessionId}: ${String(/** @type {any} */ (error)?.message ?? error)}`,
      );
    }
  }

  /** 等注入就绪（最多 5s）；超时视为依赖缺失，由调用方报错。 */
  async waitServices() {
    await Promise.race([this.servicesReady, new Promise((resolve) => setTimeout(resolve, 5000))]);
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

  /**
   * 线程进度（面板用）：状态由持久事件归约，按「需要我」优先排序。
   * @param {string} projectId
   */
  progress(projectId) {
    const store = this.requireStore();
    const threads = store.listThreads(projectId);
    const rows = threads.map((/** @type {any} */ thread) => ({
      sessionId: thread.sessionId,
      branch: thread.branch ?? null,
      worktree: thread.worktree ?? null,
      view: this.views.get(thread.sessionId) ?? initialView(),
    }));
    const sorted = sortRows(rows);
    /** @type {Record<string, number>} */
    const counts = { "waiting-user": 0, failed: 0, working: 0, done: 0, idle: 0 };
    for (const row of rows) counts[row.view.state] = (counts[row.view.state] ?? 0) + 1;
    return {
      rows: sorted,
      counts,
      total: rows.length,
      attention: counts["waiting-user"] + counts.failed,
    };
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

  /**
   * 建一个线程（尽力隔离到独立 worktree）。
   * @param {string} projectId
   * @param {string} task
   */
  async createThread(projectId, task) {
    await this.waitServices();
    const store = this.requireStore();
    const sc = this.sessionController;
    if (!sc) throw new Error("projects: session controller unavailable");
    const thread = await createIsolatedThread({
      store,
      dataRoot: this.dataRoot,
      projectId,
      deps: {
        runGit: runGit,
        createSession: async (/** @type {{cwd: string}} */ request) => {
          const created = await sc.create({ cwd: request.cwd });
          return { sessionId: String(created.sessionId) };
        },
      },
    });
    store.save();
    if (typeof task === "string" && task.trim() !== "") {
      try {
        await sc.prompt(
          {
            requestId: `projects-thread-${Date.now()}`,
            sessionId: thread.sessionId,
            mode: "queue",
            content: [{ type: "text", text: task }],
          },
          new AbortController().signal,
        );
      } catch {
        /* 投递失败不影响线程本身；面板会显示 idle */
      }
    }
    return thread;
  }

  /**
   * 回收一个线程的 worktree（三重判据不满足就拒绝）。
   * @param {string} sessionId
   */
  async reclaimThread(sessionId) {
    const store = this.requireStore();
    const result = await reclaimThreadWorktree({ store, sessionId, deps: { runGit } });
    store.save();
    return result;
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
declareRemote(ProjectsService, "createThread");
declareRemote(ProjectsService, "reclaimThread");
declareRemote(ProjectsService, "progress");
declareRemote(ProjectsService, "debugAttached");
declareRemote(ProjectsService, "detachSession");
declareRemote(ProjectsService, "describe");
declareRemote(ProjectsService, "getProjectContent");
declareRemote(ProjectsService, "listAudit");
