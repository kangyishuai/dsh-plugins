// @ts-check
// host 半的 Typert Remote Service：项目 CRUD、会话归属、上下文注入的挂载点。
// 注意（docs/runtime/0.2.1-rc.5.md §6.10）：Remote 方法必须声明在**这个被导出的类自身原型**上，
// 否则网关不会 claim 端点，所有 /api/projects/* 返回 404。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { registerProjectContext } from "./attach.js";
import { buildFixTask, errorSignature, shouldContinueFix } from "./autofix.js";
import { buildPrText, nextPrAction, parsePrNumber, planPrCreate } from "./autopr.js";
import {
  checkStepBudget,
  checkThreadBudget,
  checkTokenBudget,
  checkWeeklyTokenBudget,
  startOfWeek,
  tokensOf,
} from "./budget.js";
import { runCommand } from "./exec.js";
import { executeApprovalCore } from "./execute.js";
import { checkPreapproval } from "./executor.js";
import { appendEntry } from "./memory.js";
import { initialStats, observeEvent, parseNumstat, summarizeForRow } from "./observability.js";
import { initialView, reduce, sortRows } from "./overview.js";
import { resolveDataRoot } from "./paths.js";
import { buildPersona } from "./persona.js";
import { readProjectFiles } from "./project-files.js";
import { buildPurgeManifest, DEFAULT_RETENTION_DAYS, selectExpired } from "./purge.js";
import { decideRoute } from "./routing.js";
import { ProjectStore } from "./store.js";
import { createIsolatedThread, reclaimThreadWorktree, reconcileWorktrees } from "./thread.js";

import { buildCoordinatorTools, REQUESTABLE_ACTIONS } from "./tools.js";
import { impactOf, trashDirFor } from "./trash.js";
import { buildEnvelope, createInjectionGuard, decideWake, pendingWakes } from "./wake.js";
import { planDeleteBranch, shouldDeleteBranchV2 } from "./worktree.js";

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
 * 跑一次 git。
 * 为什么不用 ctx.subprocess：那是个策略 seam（SubprocessSpawnSpec 要 argv/stdio/graceMs，
 * 返回的是带采集上限的句柄），而这里只需要一次短命令的 stdout/exit code。
 * 插件本身就跑在宿主 Node 进程里，node:child_process 总是可用；git 的失败一律由调用方降级。
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
async function runGit(args, cwd) {
  return runCommand("git", args, { cwd });
}

/**
 * 跑一次 gh。argv 里不含 "gh" 本身（由这里补）。
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runGh(args) {
  return runCommand("gh", args);
}

/**
 * 取一条消息里的纯文本（用于唤醒信封的 report）。
 * @param {any} message
 * @returns {string}
 */
function extractText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * 递归统计目录体积（只用于影响面展示，不追求精确到字节）。
 * @param {string} dir
 * @returns {number}
 */
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    try {
      if (entry.isDirectory()) total += dirSize(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      /* 读不到就跳过，不因为统计失败阻断删除 */
    }
  }
  return total;
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
    /** 上下文渲染诊断计数（describe() 暴露，便于真机排查）。 @type {any} */
    this.renderStats = {};
    /**
     * 信封防重：同一个 wakeId 只注入一次。
     * lastWakeTurn 水位只能挡住"已经写回状态"的重复，挡不住两个并发的 turn/end
     * 在写回之前同时通过检查——这个 guard 是同步的，用来闭掉那个竞态。
     * @type {{ shouldInject: (wakeId: string) => boolean, reset: () => void, size: () => number }}
     */
    this.wakeGuard = createInjectionGuard();
    /** 协调器会话的 agent（用于后续工具约束/提示）。 @type {Map<string, any>} */
    this.coordinatorAgents = new Map();
    /** 协调器工具注册的清理函数。 @type {Map<string, (() => void)[]>} */
    this.coordinatorToolDisposers = new Map();
    /** 每个线程会话的可观测统计（规格 §7.7.3：从事件累积，重启后从 0 起算）。 @type {Map<string, any>} */
    this.stats = new Map();
    /** 每个线程会话最近一条 assistant 文本（唤醒信封要带它，M0 实测不带模型读不到结果）。 @type {Map<string, string>} */
    this.lastMessages = new Map();
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
      // 冷会话唤醒：应用关着时线程跑完，协调器从没收到信封；启动后补一次（延迟到视图有数据时）
      setTimeout(() => {
        void this.reconcileWakes().catch((/** @type {any} */ error) => {
          this.logger?.warn?.(
            `[projects] cold-session wake skipped: ${String(error?.message ?? error).slice(0, 160)}`,
          );
        });
      }, 5000);
    });

    // 项目上下文：**全局注册一个按会话求值的条目**。
    // 依据 docs/runtime §11.18/§11.19：per-agent 注册在 agent/created 时无效；
    // 这里的 text 是函数，宿主 refreshContext 会用 resolveContext 按当前 agent/session 求值。
    /** @type {any} */
    this.workspaceRegistry = undefined;
    ctx.inject?.(["workspaceRegistry"], (/** @type {any} */ scope) => {
      this.workspaceRegistry = scope.workspaceRegistry;
    });

    ctx.inject?.(["systemPrompt"], (/** @type {any} */ scope) => {
      try {
        this.disposeProjectContext = registerProjectContext({
          getStore: () => this.store,
          getDataRoot: () => this.dataRoot,
          register: (definition) => scope.systemPrompt.context(definition),
          onRender: (/** @type {string} */ sessionId, /** @type {string} */ kind) => {
            if (!this.renderStats) this.renderStats = {};
            const stats = this.renderStats;
            stats[kind] = (stats[kind] ?? 0) + 1;
            stats.lastSession = String(sessionId).slice(0, 18);
            if (kind === "coordinator") stats.lastCoordinator = String(sessionId).slice(0, 18);
          },
          renderPersona: (project) =>
            buildPersona({
              projectName: project?.name ?? "",
              persona: project?.policy?.persona ?? "",
            }),
        });
        this.logger?.info?.("[projects] project context registered (global, per-session render)");
      } catch (error) {
        this.logger?.warn?.(
          `[projects] context registration failed: ${String(/** @type {any} */ (error)?.message ?? error)}`,
        );
      }
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
      this.stats.set(sessionId, observeEvent(this.stats.get(sessionId) ?? initialStats(), event));
      const previous = this.views.get(sessionId) ?? initialView();
      const next = reduce(previous, event);
      this.views.set(sessionId, next);
      if (String(event?.type) === "assistant/message") {
        const text = extractText(event?.data?.message);
        if (text !== "") this.lastMessages.set(sessionId, text);
        // token 用量挂在同一条事件上（宿主无独立 usage 记录）；累计到项目当天分桶
        const threadProject = this.store?.projectOfSession?.(sessionId);
        const usage = event?.data?.message?.usage ?? event?.data?.usage;
        if (threadProject && usage) {
          const nowMs = Date.now();
          const tokens = tokensOf({ at: new Date(nowMs).toISOString(), usage }, nowMs);
          if (tokens > 0) {
            this.store.addTokenUsage(threadProject.id, tokens, nowMs);
            // 必须落盘：token 分桶的设计要求「跨重启保留」（store 单测覆盖了 save 路径，
            // 但这里曾经只改内存不保存 —— 重启就丢，等于预算闸永远从 0 开始）。
            this.store.save();
            void this.enforceTokenBudget(threadProject.id, nowMs);
          }
        }
      }
      if (String(event?.type) === "turn/end") {
        void this.maybeWakeCoordinator(sessionId, next);
      }
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
  /**
   * token 到线就暂停项目（只暂停一次，避免每轮重复写审计）。
   * 「暂停」是保守且可逆的处置：不删数据、不打断正在跑的线程。
   * @param {string} projectId
   * @param {number} now
   */
  async enforceTokenBudget(projectId, now) {
    try {
      const store = this.requireStore();
      const project = store.getProject(projectId);
      if (!project) return;
      const verdict = checkTokenBudget({
        dailyTokens: project.budget?.dailyTokens,
        usedTokens: store.tokenUsageToday(projectId, now),
      });
      if (verdict.ok || project.state === "paused") return;
      store.updateProject(projectId, { state: "paused" });
      store.appendAudit({
        action: "budget/paused",
        projectId,
        reason: verdict.reason,
        used: verdict.used,
        limit: verdict.limit,
      });
      store.save();
    } catch (error) {
      this.logger?.warn?.(
        `[projects] token budget enforce failed: ${String(/** @type {any} */ (error)?.message ?? error)}`,
      );
    }
  }

  /**
   * 给协调器 agent 注册 project_* 工具（**agent 作用域**，不影响其它会话）。
   * 篮子只有 4 个工具：没有 bash / 写文件 / 删除 / 推送 / 合并。
   * @param {any} agent
   * @param {any} project
   */
  attachCoordinatorTools(agent, project) {
    try {
      const tools = agent?.ctx?.tools;
      if (!tools || typeof tools.register !== "function") {
        this.auditSkip(project?.id, "tools-skip", "no-tools-service");
        return;
      }
      const definitions = buildCoordinatorTools({
        startThread: (/** @type {string} */ task) => this.createThread(project.id, task),
        listThreads: async () => this.progress(project.id),
        messageThread: (/** @type {string} */ sessionId, /** @type {string} */ text) =>
          this.promptThread(sessionId, text),
        writeMemory: async (/** @type {string} */ text) => this.appendMemory(project.id, text),
        readMemory: async () => this.getProjectContent(project.id),
        requestAction: async (/** @type {any} */ request) => {
          const created = this.requireStore().appendApproval({ projectId: project.id, ...request });
          this.requireStore().appendAudit({
            action: "approval/requested",
            projectId: project.id,
            requestId: created.requestId,
            dangerAction: request.action,
          });
          this.requireStore().save();
          return created;
        },
      });
      /** @type {(() => void)[]} */
      const disposers = [];
      for (const definition of definitions) {
        const dispose = tools.register(definition);
        if (typeof dispose === "function") disposers.push(dispose);
      }
      this.coordinatorToolDisposers?.set?.(String(agent?.id ?? ""), disposers);
      const store = this.requireStore();
      store.appendAudit({
        action: "coordinator/tools",
        projectId: project.id,
        count: definitions.length,
      });
      store.save();
    } catch (error) {
      this.auditSkip(
        project?.id,
        "tools-skip",
        String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
      );
    }
  }

  /**
   * 把「装不上」记成可观测的审计，而不是只写日志（宿主默认看不到插件日志）。
   * @param {string|undefined} projectId
   * @param {string} action
   * @param {string} reason
   */
  auditSkip(projectId, action, reason) {
    try {
      const store = this.requireStore();
      store.appendAudit({ action: `coordinator/${action}`, projectId: projectId ?? null, reason });
      store.save();
    } catch {
      /* 审计都写不了就只能放弃 */
    }
  }

  /**
   * 往项目记忆里追加一条（幂等、有上限；写盘后写审计）。
   * @param {string} projectId
   * @param {string} text
   */
  appendMemory(projectId, text) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const file = join(this.dataRoot, projectId, "memory", "MEMORY.md");
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const result = appendEntry(existing, text, { at: new Date().toISOString() });
    if (!result.ok) {
      store.appendAudit({ action: "memory/rejected", projectId, reason: result.reason });
      store.save();
      return { ok: false, reason: result.reason, added: false };
    }
    if (result.added) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, result.text, { mode: 0o600 });
      store.appendAudit({ action: "memory/appended", projectId, chars: result.text.length });
      store.save();
      // 无需刷新挂载：上下文条目是函数，宿主每次请求都会重新渲染（见 attach.js）
    }
    return {
      ok: true,
      added: result.added,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  /**
   * 给一个线程会话投递一条消息。
   * @param {string} sessionId
   * @param {string} text
   */
  async promptThread(sessionId, text) {
    const sc = this.sessionController;
    if (!sc) throw new Error("projects: session controller unavailable");
    await sc.prompt(
      {
        requestId: `projects-thread-msg-${Date.now()}`,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
      },
      new AbortController().signal,
    );
    return { ok: true };
  }

  /**
   * 预热协调器会话并挂载人格。
   * @param {string} projectId
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async warmUpCoordinator(projectId, sessionId) {
    const sc = this.sessionController;
    if (!sc) return false;
    try {
      await sc.prompt(
        {
          requestId: `projects-coordinator-warmup-${Date.now()}`,
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: "（系统）协调器已就绪，等待项目事件。" }],
        },
        new AbortController().signal,
      );
    } catch {
      /* 预热失败不影响创建；下面还会重试挂载 */
    }
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const agent = this.agents?.get?.(sessionId);
      if (agent) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const store = this.requireStore();
    store.appendAudit({
      action: "coordinator/persona-skip",
      projectId,
      sessionId,
      reason: "agent-not-ready",
    });
    store.save();
    return false;
  }

  /**
   * agent 起来时的钩子。这里**不做任何 per-agent systemPrompt 注册**：
   * 实测在 agent/created 里注册进不了提示词（runtime §11.18）。
   * 项目上下文与协调器人格由构造函数里 registerProjectContext 全局注册、按会话求值（§11.20）。
   * @param {any} agent
   */
  onAgentCreated(agent) {
    const sessionId = String(agent?.id ?? "");
    if (sessionId === "") return;
    // 记下在线 agent，供工具注册/诊断使用
    this.coordinatorAgents?.set?.(sessionId, agent);
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

  /**
   * 暂停项目：不再能建新线程，已有线程不受影响（可逆）。
   * @param {string} id
   */
  pauseProject(id) {
    const store = this.requireStore();
    const project = store.updateProject(id, { state: "paused" });
    store.save();
    return project;
  }

  /**
   * 恢复项目。
   * @param {string} id
   */
  resumeProject(id) {
    const store = this.requireStore();
    const project = store.updateProject(id, { state: "active" });
    store.save();
    return project;
  }

  /** @param {string} id */
  /**
   * 取消归档：回到 active，线程归属与内容文件都还在（归档从不删数据）。
   * @param {string} id
   */
  unarchiveProject(id) {
    const store = this.requireStore();
    const project = store.updateProject(id, { state: "active" });
    store.appendAudit({ action: "project/unarchived", projectId: id });
    store.save();
    return project;
  }

  /**
   * @param {string} id
   */
  async archiveProject(id) {
    const store = this.requireStore();
    const project = store.archiveProject(id);
    store.save();
    // 归档后立刻摘掉在线会话的项目上下文：否则已挂上的 agent 会带着归档项目的规则继续跑。
    for (const thread of store.listThreads(id)) {
      this.detachSession(thread.sessionId);
    }
    // 归档时顺手清理已合并、无未推送提交的分支（规格 §7.7.5 三判据；失败只记录不阻断归档）
    try {
      await this.cleanupBranches(id, { dryRun: false, confirm: true });
    } catch {
      /* 分支清理失败不该让归档失败 */
    }
    return project;
  }

  /**
   * dry-run：删除这个项目会影响什么（数量/体积/是否在跑/能否恢复）。
   * @param {string} id
   */
  previewDeleteProject(id) {
    const store = this.requireStore();
    const project = store.getProject(id);
    if (!project) throw new Error(`projects: unknown project ${id}`);
    const threads = store.listThreads(id);
    const contentDir = `${this.dataRoot}/${id}`;
    let contentBytes = 0;
    let hasContentDir = false;
    try {
      if (existsSync(contentDir)) {
        hasContentDir = true;
        contentBytes = dirSize(contentDir);
      }
    } catch {
      hasContentDir = false;
    }
    return {
      projectId: id,
      name: project.name,
      impact: impactOf({ threads, contentBytes, hasContentDir, name: project.name }),
      threads: threads.map((/** @type {any} */ thread) => ({
        sessionId: thread.sessionId,
        state: thread.state,
      })),
      contentDir,
    };
  }

  /**
   * 删除项目：记录与内容文件移入回收站（会话日志不动），写审计。
   * 调用方应先跑 previewDeleteProject 把影响面展示给用户。
   * @param {string} id
   */
  deleteProject(id) {
    const store = this.requireStore();
    const preview = this.previewDeleteProject(id);
    const trashDir = trashDirFor({ dataRoot: this.dataRoot, projectId: id });
    mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    const removed = store.removeProject(id);
    // 内容文件（如果有）整体搬进回收站；搬不动就把元数据留在回收站里并报错
    if (preview.impact.hasContentDir && existsSync(preview.contentDir)) {
      try {
        renameSync(preview.contentDir, `${trashDir}/content`);
      } catch (error) {
        writeFileSync(
          `${trashDir}/manifest.json`,
          `${JSON.stringify({ project: removed.project, threads: removed.threads, contentDir: preview.contentDir, moved: false }, null, 2)}\n`,
          { mode: 0o600 },
        );
        store.save();
        throw new Error(
          `projects: content move failed (${String(/** @type {any} */ (error)?.message ?? error)})`,
        );
      }
    }
    writeFileSync(
      `${trashDir}/manifest.json`,
      `${JSON.stringify(
        {
          format: 1,
          deletedAt: new Date().toISOString(),
          project: removed.project,
          threads: removed.threads,
          contentDir: preview.contentDir,
          moved: preview.impact.hasContentDir,
          summary: preview.impact.summary,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    for (const thread of removed.threads) this.detachSession(thread.sessionId);
    store.appendAudit({ action: "project/deleted", projectId: id, reason: "trash", trashDir });
    store.save();
    return { deleted: true, trashDir, summary: preview.impact.summary };
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
    // 不需要在这里补挂上下文：项目上下文是**全局注册 + 按会话求值**的
    // （见构造函数的 registerProjectContext），归属一落盘，下一次请求就会渲染出来。
    return thread;
  }

  /**
   * 分支生命周期清理（规格 §7.7.5）。三条判据全部满足才删，且只用 `git branch -d`。
   * 默认 dry-run；真删需 `confirm: true`。
   * @param {string} projectId
   * @param {{ dryRun?: boolean, confirm?: boolean }} [options]
   */
  async cleanupBranches(projectId, options) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const dryRun = options?.dryRun !== false;
    const repoRoot = Array.isArray(project.dirs) ? String(project.dirs[0] ?? "") : "";
    /** @type {any[]} */
    const candidates = [];
    const threads = store.listThreads(projectId);

    for (const thread of threads) {
      const branch = typeof thread.branch === "string" ? thread.branch : "";
      if (branch === "") continue;
      // ① 必须是我们的分支且与记录一致
      const ours = branch.startsWith("dsh/") && branch === thread.branch;
      if (!ours) {
        candidates.push({ branch, ok: false, reason: "branch-not-ours" });
        continue;
      }
      if (repoRoot === "") {
        candidates.push({ branch, ok: false, reason: "no-repo" });
        continue;
      }
      const current = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
      if (String(current.stdout ?? "").trim() === branch) {
        candidates.push({ branch, ok: false, reason: "current-branch" });
        continue;
      }
      // 分支若还被某个 worktree 占用，`git branch -d` 会被拒。
      // 只有在 worktree **干净**（无未提交改动）时才移除它——未提交内容绝不丢。
      const worktree = typeof thread.worktree === "string" ? thread.worktree : "";
      if (worktree !== "") {
        const status = await runGit(["status", "--porcelain"], worktree);
        const clean = status.code === 0 && String(status.stdout ?? "").trim() === "";
        if (!clean) {
          candidates.push({ branch, ok: false, reason: "worktree-dirty" });
          continue;
        }
        if (!dryRun) {
          const removed = await runGit(["worktree", "remove", worktree], repoRoot);
          if (removed.code !== 0) {
            candidates.push({ branch, ok: false, reason: "worktree-remove-failed" });
            continue;
          }
          store.setThreadWorktree(thread.sessionId, { worktree: null });
          store.save();
        }
      }

      // ② 合并结果：记录里有 mergedAt，或远端确实已合并到 HEAD
      let merged = typeof thread.mergedAt === "string" && thread.mergedAt !== "";
      if (!merged) {
        const mergedIntoHead = await runGit(
          ["merge-base", "--is-ancestor", branch, "HEAD"],
          repoRoot,
        );
        merged = mergedIntoHead.code === 0;
      }
      // ③ 没有未推送提交
      const unpushed = await runGit(
        ["rev-list", "--count", branch, "--not", "--remotes"],
        repoRoot,
      );
      const verdict = shouldDeleteBranchV2({
        branch,
        threadBranch: thread.branch,
        merged,
        unpushedCommits:
          unpushed.code === 0 ? Number(String(unpushed.stdout).trim() || "0") : Number.NaN,
      });
      candidates.push({ branch, ok: verdict.ok, reason: verdict.reason });
    }

    if (dryRun || options?.confirm !== true) {
      return { ok: true, dryRun: true, candidates, deleted: [] };
    }

    /** @type {string[]} */
    const deleted = [];
    for (const item of candidates) {
      if (!item.ok) continue;
      const removed = await runGit(planDeleteBranch(item.branch), repoRoot);
      if (removed.code === 0) {
        deleted.push(item.branch);
        store.appendAudit({ action: "branch/deleted", projectId, branch: item.branch });
      } else {
        store.appendAudit({
          action: "branch/kept",
          projectId,
          branch: item.branch,
          reason: String(removed.stderr).split("\n")[0].slice(0, 160) || "delete-failed",
        });
      }
    }
    store.save();
    return { ok: true, dryRun: false, candidates, deleted };
  }

  /**
   * 回收站保留期清理（规格 §7.5 行 4c）。
   * 三道硬前提：开关 `purgeAfterRetention` 打开、调用方显式确认、只处理**超保留期**的条目。
   * 默认 dry-run：只报告「会删什么」，不真删。
   * @param {{ dryRun?: boolean, confirm?: string, retentionDays?: number, projectId?: string }} [options]
   * @returns {{ ok: boolean, reason?: string, eligible: any[], kept: number, purged: string[], manifestPath: string|null }}
   */
  purgeTrash(options) {
    const store = this.requireStore();
    const input = options ?? {};
    const dryRun = input.dryRun !== false; // 省略时按 dry-run 处理，删东西必须是显式选择

    /** @type {any[]} */
    const entries = [];
    const projects = input.projectId
      ? [store.getProject(String(input.projectId))].filter(Boolean)
      : store.listProjects();
    for (const project of projects) {
      const dir = this.trashRoot();
      if (!dir) continue;
      let names = [];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${project.id}-`))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(dir, name);
        entries.push({ name, path: full, bytes: this.sizeOf(full) });
      }
    }

    const retentionDays = Number.isFinite(input.retentionDays)
      ? Number(input.retentionDays)
      : DEFAULT_RETENTION_DAYS;
    const { eligible, kept } = selectExpired(entries, { retentionDays });

    if (dryRun) {
      return { ok: true, eligible, kept, purged: [], manifestPath: null };
    }

    // 真删：开关 + 显式确认
    const switchOn = projects.some(
      (/** @type {any} */ project) => project?.policy?.danger?.purgeAfterRetention === true,
    );
    if (!switchOn) {
      store.appendAudit({ action: "trash/purge-refused", reason: "switch-off" });
      store.save();
      return { ok: false, reason: "switch-off", eligible, kept, purged: [], manifestPath: null };
    }
    if (String(input.confirm ?? "").trim() !== "purge") {
      store.appendAudit({ action: "trash/purge-refused", reason: "confirm-required" });
      store.save();
      return {
        ok: false,
        reason: "confirm-required",
        eligible,
        kept,
        purged: [],
        manifestPath: null,
      };
    }

    // ② 执行前生成可恢复清单
    const purgedAt = new Date().toISOString();
    const manifest = buildPurgeManifest({ purgedAt, retentionDays, entries: eligible });
    const manifestPath = join(
      this.dataRoot,
      "trash",
      `purge-${purgedAt.replace(/[:.]/gu, "-")}.md`,
    );
    try {
      mkdirSync(join(this.dataRoot, "trash"), { recursive: true });
      writeFileSync(manifestPath, manifest, { mode: 0o600 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendAudit({ action: "trash/purge-refused", reason: `manifest-failed: ${message}` });
      store.save();
      return {
        ok: false,
        reason: "manifest-failed",
        eligible,
        kept,
        purged: [],
        manifestPath: null,
      };
    }

    const purged = [];
    for (const entry of eligible) {
      try {
        rmSync(entry.path, { recursive: true, force: true });
        purged.push(entry.name);
      } catch {
        /* 单个失败不影响其它；下面审计里会体现数量差异 */
      }
    }
    store.appendAudit({
      action: "trash/purged",
      count: purged.length,
      eligible: eligible.length,
      kept,
      retentionDays,
      manifestPath,
    });
    store.save();
    return { ok: true, eligible, kept, purged, manifestPath };
  }

  /** 回收站根目录（数据根下）。 @returns {string} */
  trashRoot() {
    return this.dataRoot ? join(this.dataRoot, "trash") : "";
  }

  /**
   * 递归求目录字节数（清单里要写「删了多少」）。
   * @param {string} dir
   * @returns {number}
   */
  sizeOf(dir) {
    let total = 0;
    let items = [];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) total += this.sizeOf(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
    return total;
  }

  /**
   * 冷会话唤醒：启动后补发「应用关着时欠下的」协调器信封。
   * 为什么需要：wake 原本只在 turn/end 触发；应用关着时线程跑完，协调器永远不知道。
   * 只处理需要人看的终态（done/failed/waiting-user），且由 decideWake 统一去重。
   * @returns {Promise<{ scanned: number, woken: number }>}
   */
  async reconcileWakes() {
    const store = this.requireStore();
    let scanned = 0;
    let woken = 0;
    for (const project of store.listProjects()) {
      if (project?.state !== "active") continue;
      if (typeof project.coordinatorSessionId !== "string" || project.coordinatorSessionId === "")
        continue;
      const threads = store.listThreads(project.id);
      scanned += threads.length;
      /** @type {Map<string, any>} */
      const views = new Map();
      for (const thread of threads) {
        const view = this.views.get(thread.sessionId);
        if (view) views.set(thread.sessionId, view);
      }
      for (const pending of pendingWakes(threads, views)) {
        await this.maybeWakeCoordinator(pending.sessionId, {
          turn: pending.turn,
          state: pending.state,
        });
        woken += 1;
      }
    }
    if (woken > 0) this.logger?.info?.(`[projects] cold-session wake: ${woken}/${scanned}`);
    return { scanned, woken };
  }

  /**
   * 给信封用的项目上下文摘要：常设规则 + 记忆索引，拼成一段文本。
   * 为什么放进信封：协调器会话拿不到宿主的 runtime context（runtime §11.24），
   * 而信封这条路已被实测证明能到达协调器（§11.8）。
   * @param {any} project
   * @returns {string}
   */
  renderProjectContextFor(project) {
    try {
      const files = readProjectFiles(this.dataRoot, project.id);
      const blocks = [];
      if (files.instructions !== "") blocks.push(`# 项目规则\n${files.instructions}`);
      if (files.memoryIndex !== "") blocks.push(`# 项目记忆索引\n${files.memoryIndex}`);
      return blocks.join("\n\n");
    } catch {
      return "";
    }
  }

  /**
   * 确保项目有一个协调器会话（没有就建一个），返回会话 id。
   * @param {string} projectId
   */
  async ensureCoordinator(projectId) {
    await this.waitServices();
    // 单飞：并发调用（面板 + 探针 + 唤醒路径）不能各建一个协调器会话。
    // 用 per-project Promise 复用同一个在途创建；完成后清掉，失败也不留脏。
    this.coordinatorInFlight = this.coordinatorInFlight ?? new Map();
    const inFlight = this.coordinatorInFlight.get(projectId);
    if (inFlight) return inFlight;
    const task = this.createCoordinator(projectId).finally(() => {
      this.coordinatorInFlight.delete(projectId);
    });
    this.coordinatorInFlight.set(projectId, task);
    return task;
  }

  /**
   * 真正的协调器创建逻辑（只由 ensureCoordinator 调用，保证单飞）。
   * @param {string} projectId
   */
  async createCoordinator(projectId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    if (typeof project.coordinatorSessionId === "string" && project.coordinatorSessionId !== "") {
      return { sessionId: project.coordinatorSessionId, created: false };
    }
    const sc = this.sessionController;
    if (!sc) throw new Error("projects: session controller unavailable");
    const cwd =
      Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : this.dataRoot;
    const created = await sc.create({ cwd });
    const sessionId = String(created.sessionId);

    // 把协调器会话挂进对应目录的 workspace，让它成为「正常工作区会话」。
    // 依据 runtime §11.21：裸会话拿不到运行时上下文提醒，于是项目上下文/人格都进不去。
    // 失败不阻断（协调器仍可用，只是暂时没有上下文）。
    try {
      const registry = this.workspaceRegistry;
      if (registry && typeof registry.create === "function") {
        const ws = await registry.create(cwd, project.name);
        if (ws && typeof ws.attachSession === "function") {
          await ws.attachSession(sessionId);
          store.appendAudit({
            action: "coordinator/workspace",
            projectId,
            sessionId,
            result: "attached",
          });
        }
      }
    } catch (error) {
      store.appendAudit({
        action: "coordinator/workspace",
        projectId,
        sessionId,
        result: "skipped",
        reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
      });
    }

    store.updateProject(projectId, { coordinatorSessionId: sessionId });
    store.appendAudit({ action: "coordinator/created", projectId, sessionId });
    store.save();
    // 显式挂人格：agent 是懒创建的，靠 agent/created 钩子会受时序影响。
    // 这里主动预热一轮（轻量文本）并在几秒内重试挂载；失败只记审计，不阻断。
    const attached = await this.warmUpCoordinator(projectId, sessionId);
    return { sessionId, created: true, personaAttached: attached };
  }

  /**
   * 线程一轮结束时唤醒协调器（同一轮只唤醒一次）。
   * 失败只记日志，不影响线程本身。
   * @param {string} sessionId
   * @param {any} view
   */
  async maybeWakeCoordinator(sessionId, view) {
    try {
      const store = this.store;
      if (!store) return;
      const project = store.projectOfSession(sessionId);
      if (!project) return;
      const coordinatorSessionId = project.coordinatorSessionId;
      if (typeof coordinatorSessionId !== "string" || coordinatorSessionId === "") {
        store.appendAudit({
          action: "wake/skipped",
          projectId: project.id,
          sessionId,
          reason: "no-coordinator",
        });
        store.save(); // 不落盘的话，重启后「为什么没反应」就查不到了
        return;
      }
      const thread = store
        .listThreads(project.id)
        .find((/** @type {any} */ item) => item.sessionId === sessionId);
      if (!thread) return;
      // 单线程步数预算（规格 §7.7.4）：超限只停唤醒，不杀会话——人还可以继续用
      const stepVerdict = checkStepBudget({
        maxSteps: project.budget?.maxStepsPerThread,
        steps: (this.stats.get(sessionId) ?? initialStats()).steps,
      });
      if (!stepVerdict.ok) {
        store.appendAudit({
          action: "wake/skipped",
          projectId: project.id,
          sessionId,
          reason: stepVerdict.reason,
          steps: stepVerdict.steps,
          limit: stepVerdict.limit,
        });
        store.save();
        return;
      }

      const turn = Number(view?.turn ?? 0);

      const envelope = buildEnvelope({
        reason: "thread-activity",
        trust: "principal",
        project: { id: project.id, name: project.name },
        thread: {
          sessionId,
          state: view?.state ?? "done",
          turn,
          branch: thread.branch ?? null,
        },
        context: this.renderProjectContextFor(project),
        // 人格同样走信封：宿主的 runtime-context 投递不到协调器会话（§11.24）
        persona: buildPersona({
          projectName: project.name,
          persona: project.policy?.persona ?? "",
        }),
        report: this.lastMessages.get(sessionId) ?? "",
        next:
          view?.state === "failed"
            ? "tell the user which thread failed and why, in one sentence"
            : "tell the user the thread's result in one short sentence",
        wakeId: `thread-activity:${sessionId}:${turn}`,
      });

      const decision = decideWake({
        turn,
        lastWakeTurn: Number(thread.lastWakeTurn ?? 0),
        wakeId: envelope.wakeId,
        guard: this.wakeGuard,
      });
      if (decision !== "send") {
        store.appendAudit({
          action: decision === "skip-dedupe" ? "wake/deduped" : "wake/skipped",
          projectId: project.id,
          sessionId,
          turn,
          wakeId: envelope.wakeId,
          reason: decision,
        });
        store.save();
        return;
      }
      if (this.wakeGuard.size() > 1000) this.wakeGuard.reset(); // 长跑不无限增长

      const sc = this.sessionController;
      if (!sc) return;
      await sc.prompt(
        {
          requestId: `projects-wake-${envelope.wakeId}`,
          sessionId: coordinatorSessionId,
          mode: "queue",
          content: [{ type: "text", text: envelope.text }],
        },
        new AbortController().signal,
      );
      store.setThreadWakeState(sessionId, turn);
      store.appendAudit({
        action: "wake/sent",
        projectId: project.id,
        sessionId,
        turn,
        wakeId: envelope.wakeId,
      });
      store.save();
    } catch (error) {
      this.logger?.warn?.(
        `[projects] wake failed: ${String(/** @type {any} */ (error)?.message ?? error)}`,
      );
    }
  }

  /**
   * 按规则处理一条输入：决策 → 必要时执行 → **一律写审计**。
   * L0/L1 下「新建线程」会被拦成提议（规格 §7.4：级别只增不减地放宽，默认只提议）。
   * @param {string} projectId
   * @param {string} text
   */
  async route(projectId, text) {
    await this.waitServices();
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const input = String(text ?? "").trim();
    if (input === "") throw new Error("projects: route requires text");

    const decision = this.previewRoute(projectId, input);
    /** @type {any} */
    const record = {
      action: "route",
      projectId,
      input: input.slice(0, 120),
      decision: { by: decision.by, action: decision.action, ruleId: decision.ruleId ?? null },
      autonomy: decision.autonomy,
    };

    if (decision.by === "blocked") {
      store.appendAudit({ ...record, result: "blocked", reason: decision.blockedReason ?? "" });
      store.save();
      return { executed: false, decision, reason: decision.blockedReason ?? "" };
    }

    if (decision.action === "new-thread") {
      try {
        const thread = await this.createThread(projectId, input);
        store.appendAudit({ ...record, result: "thread-created", sessionId: thread.sessionId });
        store.save();
        return { executed: true, decision, sessionId: thread.sessionId, isolated: thread.isolated };
      } catch (error) {
        store.appendAudit({
          ...record,
          result: "failed",
          reason: String(/** @type {any} */ (error)?.message ?? error),
        });
        store.save();
        return {
          executed: false,
          decision,
          reason: String(/** @type {any} */ (error)?.message ?? error),
        };
      }
    }

    // answer-inline / reuse-thread / propose：执行留给调用方（面板/协调器），这里只给决策
    store.appendAudit({
      ...record,
      result: decision.action === "propose" ? "proposed" : "handled-by-caller",
    });
    store.save();
    return { executed: false, decision, reason: "" };
  }

  /**
   * 申请一个危险动作（入审批队列，**不执行**）。
   * 协调器工具走同一条路径；面板也可以直接调用。
   * @param {string} projectId
   * @param {{ action?: string, reason?: string, args?: any }} request
   */
  async requestAction(projectId, request) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const action = String(request?.action ?? "");
    const reason = String(request?.reason ?? "").trim();
    if (!REQUESTABLE_ACTIONS.includes(action)) {
      return { ok: false, error: `action-not-requestable: ${action || "(empty)"}` };
    }
    if (reason === "") return { ok: false, error: "reason-required" };
    const created = store.appendApproval({
      projectId,
      action,
      args: request?.args ?? null,
      reason,
    });
    store.appendAudit({
      action: "approval/requested",
      projectId,
      requestId: created.requestId,
      dangerAction: action,
    });
    store.save();

    // 预授权（规格 §7.7.2）：命中则由 policy-grant 直接放行并立即尝试执行。
    // 闸门一条都不跳过——只是省掉「等人点一下」。
    const pre = checkPreapproval({
      action,
      preapprove: project.policy?.preapprove ?? [],
      danger: project.policy?.danger ?? {},
    });
    if (!pre.ok) return { ok: true, requestId: created.requestId, autoApproved: false };

    store.resolveApproval(created.requestId, "approved");
    store.appendAudit({
      action: "approval/auto-approved",
      projectId,
      requestId: created.requestId,
      dangerAction: action,
      source: "policy-grant",
    });
    store.save();
    // 预授权 = 预先委托执行权，因此立即尝试执行；闸门（开关/阈值/前置/证据/幂等）一条都不跳过
    const outcome = await this.executeApproval(created.requestId);
    return {
      ok: true,
      requestId: created.requestId,
      autoApproved: true,
      executed: outcome?.executed === true,
      ...(outcome?.executed === true ? {} : { reason: String(outcome?.reason ?? "not-executed") }),
    };
  }

  /**
   * 单个线程的可观测明细（规格 §7.7.3）：事件累积的步骤/命令/tokens，加 worktree 的 diff 摘要。
   * diff 用 `git diff --numstat <base>..HEAD` 现算；拿不到就给 null，让面板显示 n/a。
   * @param {string} projectId
   * @param {string} sessionId
   */
  async threadStats(projectId, sessionId) {
    const store = this.requireStore();
    const thread = store
      .listThreads(projectId)
      .find((/** @type {any} */ item) => item.sessionId === sessionId);
    if (!thread) throw new Error(`projects: unknown thread ${sessionId}`);
    const stats = this.stats.get(sessionId) ?? initialStats();

    let diff = null;
    const worktree = typeof thread.worktree === "string" ? thread.worktree : "";
    if (worktree !== "") {
      const base = thread.baseSha ?? "HEAD~1";
      const numstat = await runGit(["diff", "--numstat", `${base}..HEAD`], worktree);
      if (numstat.code === 0) diff = parseNumstat(numstat.stdout);
    }

    const stepVerdict = checkStepBudget({
      maxSteps: store.getProject(projectId)?.budget?.maxStepsPerThread,
      steps: stats.steps,
    });
    return {
      sessionId,
      stats,
      diff,
      overBudget: !stepVerdict.ok,
      budgetReason: stepVerdict.reason,
      summary: summarizeForRow({ stats, diff }),
    };
  }

  /**
   * 待审批队列（面板用）。
   * @param {string|undefined} projectId
   */
  listApprovals(projectId) {
    return this.requireStore().listApprovals(projectId);
  }

  /**
   * 根据一次 CI 失败决定要不要再修一轮；要修就给该线程投递修复任务。
   * **不 push、不开 PR**（ADR 0003）；碰到测试文件或无进展就停。
   * @param {string} projectId
   * @param {{ sessionId: string, log: string, changedFiles?: string[] }} input
   */
  async autoFixStep(projectId, input) {
    await this.waitServices();
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const sessionId = String(input?.sessionId ?? "");
    const thread = store
      .listThreads(projectId)
      .find((/** @type {any} */ item) => item.sessionId === sessionId);
    if (!thread) throw new Error(`projects: unknown thread ${sessionId}`);

    const signature = errorSignature(String(input?.log ?? ""));
    const verdict = shouldContinueFix({
      round: Number(thread.autoFixRound ?? 0),
      changedFiles: input?.changedFiles ?? thread.autoFixChanged ?? [],
      previousSignature: String(thread.autoFixSignature ?? ""),
      currentSignature: signature,
    });

    if (!verdict.continue) {
      store.appendAudit({
        action: "autofix/stopped",
        projectId,
        sessionId,
        reason: verdict.reason,
      });
      store.save();
      return { continued: false, reason: verdict.reason };
    }

    const task = buildFixTask({
      round: Number(thread.autoFixRound ?? 0),
      signature,
      projectName: project.name,
    });
    await this.promptThread(sessionId, task);
    store.setThreadAutoFix(sessionId, {
      round: Number(thread.autoFixRound ?? 0) + 1,
      signature,
      changedFiles: [],
    });
    store.appendAudit({
      action: "autofix/round",
      projectId,
      sessionId,
      round: Number(thread.autoFixRound ?? 0) + 1,
    });
    store.save();
    return { continued: true, reason: "", round: Number(thread.autoFixRound ?? 0) + 1 };
  }

  /**
   * 按档位给一个线程开 PR：推分支 →（需要时）gh pr create → 记录 PR 号与审计。
   * 档位 off 时什么都不做。gh 缺失/失败只降级并写审计，不重试到天荒地老。
   * @param {string} projectId
   * @param {string} sessionId
   * @param {{ tier?: string, base?: string, repo?: string, ciState?: string }} [options]
   */
  async openPr(projectId, sessionId, options) {
    await this.waitServices();
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const thread = store
      .listThreads(projectId)
      .find((/** @type {any} */ item) => item.sessionId === sessionId);
    if (!thread) throw new Error(`projects: unknown thread ${sessionId}`);

    const tier = String(options?.tier ?? "off");

    // 线程上没有 commits 字段：直接数（base..branch），否则任何线程都会被判成"没有提交"
    const repoRoot = Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : "";
    let commits = Number(thread.commits ?? 0);
    if (repoRoot !== "" && typeof thread.branch === "string" && thread.branch !== "") {
      const base = String(options?.base ?? "HEAD");
      const counted = await runGit(["rev-list", "--count", `${base}..${thread.branch}`], repoRoot);
      if (counted.code === 0) commits = Number(String(counted.stdout).trim() || "0");
    }

    const decision = nextPrAction({
      tier,
      thread: {
        branch: thread.branch ?? null,
        prNumber: thread.prNumber ?? null,
        commits,
        attempts: Number(thread.prAttempts ?? 0),
        ciState: options?.ciState ?? undefined,
      },
    });

    if (
      decision.action === "none" ||
      decision.action === "give-up" ||
      decision.action === "wait-ci"
    ) {
      store.appendAudit({
        action: "pr/decided",
        projectId,
        sessionId,
        decision: decision.action,
        reason: decision.reason,
      });
      store.save();
      return { opened: false, decision };
    }
    if (decision.action === "update") {
      store.appendAudit({
        action: "pr/decided",
        projectId,
        sessionId,
        decision: "update",
        prNumber: thread.prNumber,
      });
      store.save();
      return { opened: false, decision, prNumber: thread.prNumber ?? null };
    }

    const draft = decision.action === "open-draft";
    const text = buildPrText({
      projectName: project.name,
      task: this.lastMessages.get(sessionId) ?? project.goal ?? "",
      sessionId,
      branch: thread.branch ?? "",
    });
    const planned = planPrCreate({
      title: text.title,
      body: text.body,
      branch: String(thread.branch ?? ""),
      base: options?.base,
      repo: options?.repo,
      draft,
    });
    if ("error" in planned) {
      store.appendAudit({ action: "pr/failed", projectId, sessionId, reason: planned.error });
      store.save();
      return { opened: false, decision, reason: planned.error };
    }

    // 先推分支（worktree 内），再开 PR
    const worktree =
      typeof thread.worktree === "string" && thread.worktree !== "" ? thread.worktree : "";
    if (worktree !== "") {
      const pushed = await runGit(["push", "-u", "origin", String(thread.branch)], worktree);
      if (pushed.code !== 0) {
        store.appendAudit({ action: "pr/failed", projectId, sessionId, reason: "push-failed" });
        store.save();
        return { opened: false, decision, reason: "push-failed" };
      }
    }

    const gh = await runGh(planned.argv);
    const prNumber = gh.code === 0 ? parsePrNumber(gh.stdout) : null;
    if (gh.code !== 0 || prNumber === null) {
      const tryCount = Number(thread.prAttempts ?? 0) + 1;
      store.setThreadAutoFix(sessionId, {});
      store.appendAudit({
        action: "pr/failed",
        projectId,
        sessionId,
        reason: String(gh.stderr).split("\n")[0].slice(0, 160) || "gh-failed",
        attempts: tryCount,
      });
      store.save();
      return { opened: false, decision, reason: "gh-failed" };
    }

    store.setThreadWakeState(sessionId, Number(thread.lastWakeTurn ?? 0));
    store.appendAudit({ action: "pr/opened", projectId, sessionId, prNumber, draft });
    store.save();
    return { opened: true, decision, prNumber, draft, argv: planned.argv };
  }

  /**
   * 执行一条已批准的申请。**默认什么都不会执行**：危险开关全关。
   * 顺序固定：已批准 → 动作在白名单 → 开关打开 → 影响面在阈值内 → 执行 → 写恢复证据。
   * @param {string} requestId
   */
  async executeApproval(requestId) {
    // 执行分支在 lib/execute.js（不依赖宿主包，可在单测里直接驱动）；这里只负责把依赖接上。
    return executeApprovalCore(
      {
        store: this.requireStore(),
        dataRoot: this.dataRoot,
        runGit,
        runGh,
        purgeTrash: (/** @type {string} */ projectId) =>
          this.purgeTrash({ dryRun: false, confirm: "purge", projectId }),
        reclaimThread: (/** @type {string} */ sessionId) => this.reclaimThread(sessionId),
        deleteProject: async (/** @type {string} */ projectId) => this.deleteProject(projectId),
      },
      requestId,
    );
  }

  /**
   * 决议一条申请。**只改状态，不执行动作**——执行留给 M4 的受控执行器。
   * @param {string} requestId
   * @param {"approved"|"rejected"} status
   */
  resolveApproval(requestId, status) {
    const store = this.requireStore();
    const resolved = store.resolveApproval(
      requestId,
      status === "approved" ? "approved" : "rejected",
    );
    store.appendAudit({
      action: "approval/resolved",
      projectId: resolved.projectId,
      requestId,
      result: resolved.status,
    });
    store.save();
    return resolved;
  }

  /**
   * 路由 dry-run：给定一段输入，说清「按哪条规则、会做什么、被谁拦」。
   * 纯决策、零副作用——真正的执行（建线程等）留给 M3 后续步骤。
   * @param {string} projectId
   * @param {string} text
   */
  previewRoute(projectId, text) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const input = String(text ?? "");
    const decision = decideRoute({
      text: input,
      rules: project.policy?.routing?.rules ?? [],
      autonomy: project.policy?.autonomy ?? "L1",
      isQuestion:
        /[?？]\s*$/u.test(input.trim()) ||
        /^(why|how|what|when|where|who|is|are|can|should|能否|为什么|怎么|如何)/iu.test(
          input.trim(),
        ),
    });
    return {
      ...decision,
      autonomy: project.policy?.autonomy ?? "L1",
      allowFallback: project.policy?.routing?.fallback !== false,
      inputLength: input.length,
    };
  }

  /**
   * 线程进度（面板用）：状态由持久事件归约，按「需要我」优先排序。
   * @param {string} projectId
   */
  progress(projectId) {
    const store = this.requireStore();
    const threads = store.listThreads(projectId);
    const rows = threads.map((/** @type {any} */ thread) => {
      const stats = this.stats.get(thread.sessionId) ?? initialStats();
      return {
        sessionId: thread.sessionId,
        branch: thread.branch ?? null,
        worktree: thread.worktree ?? null,
        view: this.views.get(thread.sessionId) ?? initialView(),
        stats: { ...stats, commands: stats.commands.slice(-3) },
        summary: summarizeForRow({ stats }),
      };
    });
    const sorted = sortRows(rows);
    /** @type {Record<string, number>} */
    const counts = { "waiting-user": 0, failed: 0, working: 0, done: 0, idle: 0 };
    for (const row of rows) counts[row.view.state] = (counts[row.view.state] ?? 0) + 1;
    const project = store.getProject(projectId);
    const budget = checkThreadBudget({ project, threads, now: Date.now() });
    return {
      rows: sorted,
      counts,
      total: rows.length,
      attention: counts["waiting-user"] + counts.failed,
      budget: {
        ok: budget.ok,
        reason: budget.reason,
        used: budget.used,
        limits: project?.budget ?? null,
        tokensToday: store.tokenUsageToday(projectId, Date.now()),
      },
      projectState: project?.state ?? "active",
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
      renderStats: this.renderStats ?? {},
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
    // 预算闸：暂停/归档、每日线程数、并发数。拒绝时给可读原因，不静默降级。
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const nowMs = Date.now();
    const tokenVerdict = checkTokenBudget({
      dailyTokens: project.budget?.dailyTokens,
      usedTokens: store.tokenUsageToday(projectId, nowMs),
    });
    // 周预算（规格 §7.7.4）：按自然周（周一 00:00 起）聚合
    const weekVerdict = checkWeeklyTokenBudget({
      weeklyTokens: project.budget?.weeklyTokens,
      usedTokens: store.tokenUsageSince(projectId, startOfWeek(nowMs)),
    });
    if (!tokenVerdict.ok) {
      store.appendAudit({ action: "thread/rejected", projectId, reason: tokenVerdict.reason });
      store.save();
      throw new Error(
        `projects: ${tokenVerdict.reason} (used=${tokenVerdict.used}, limit=${tokenVerdict.limit})`,
      );
    }
    if (!weekVerdict.ok) {
      store.appendAudit({ action: "thread/rejected", projectId, reason: weekVerdict.reason });
      store.save();
      throw new Error(
        `projects: ${weekVerdict.reason} (used=${weekVerdict.used}, limit=${weekVerdict.limit})`,
      );
    }
    const verdict = checkThreadBudget({
      project,
      threads: store.listThreads(projectId),
      now: nowMs,
    });
    if (!verdict.ok) {
      store.appendAudit({ action: "thread/rejected", projectId, reason: verdict.reason });
      store.save();
      throw new Error(
        `projects: ${verdict.reason} (today=${verdict.used.today}, running=${verdict.used.running})`,
      );
    }
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
declareRemote(ProjectsService, "pauseProject");
declareRemote(ProjectsService, "resumeProject");
declareRemote(ProjectsService, "archiveProject");
declareRemote(ProjectsService, "unarchiveProject");
declareRemote(ProjectsService, "reconcileWakes");
declareRemote(ProjectsService, "purgeTrash");
declareRemote(ProjectsService, "cleanupBranches");
declareRemote(ProjectsService, "previewDeleteProject");
declareRemote(ProjectsService, "deleteProject");
declareRemote(ProjectsService, "attachThread");
declareRemote(ProjectsService, "detachThread");
declareRemote(ProjectsService, "createThread");
declareRemote(ProjectsService, "reclaimThread");
declareRemote(ProjectsService, "progress");
declareRemote(ProjectsService, "threadStats");
declareRemote(ProjectsService, "previewRoute");
declareRemote(ProjectsService, "route");
declareRemote(ProjectsService, "requestAction");
declareRemote(ProjectsService, "listApprovals");
declareRemote(ProjectsService, "resolveApproval");
declareRemote(ProjectsService, "executeApproval");
declareRemote(ProjectsService, "autoFixStep");
declareRemote(ProjectsService, "openPr");
declareRemote(ProjectsService, "ensureCoordinator");
declareRemote(ProjectsService, "debugAttached");
declareRemote(ProjectsService, "detachSession");
declareRemote(ProjectsService, "describe");
declareRemote(ProjectsService, "getProjectContent");
declareRemote(ProjectsService, "appendMemory");
declareRemote(ProjectsService, "listAudit");
