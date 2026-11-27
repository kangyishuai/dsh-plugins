// @ts-check
// host 半的 Typert Remote Service：项目 CRUD、会话归属、上下文注入的挂载点。
// 注意（docs/runtime/0.2.1-rc.5.md §6.10）：Remote 方法必须声明在**这个被导出的类自身原型**上，
// 否则网关不会 claim 端点，所有 /api/projects/* 返回 404。
import {
  accessSync,
  constants,
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

import { artifactRefFromToolResult } from "./artifact-ref.js";
import { registerProjectContext } from "./attach.js";
import { createAutoRetryScheduler, shouldAutoRetry } from "./auto-retry.js";
import { buildFixTask, errorSignature, shouldContinueFix } from "./autofix.js";
import {
  buildPrText,
  canMergePr,
  nextPrAction,
  parsePrNumber,
  pickPollRoot,
  pickRepoRoot,
  planHttpsPush,
  planMergeSteps,
  planPrCreate,
} from "./autopr.js";
import { autoResolveDaysOf, planAutoResolve } from "./autoresolve.js";
import {
  checkStepBudget,
  checkThreadBudget,
  checkTokenBudget,
  checkWeeklyTokenBudget,
  DEFAULT_BUDGET,
  isToday,
  normalizeBudgetPatch,
  startOfWeek,
  tokensOf,
} from "./budget.js";
import { mountCoordinatorTools } from "./coordinator-tools.js";
import { runCommand } from "./exec.js";
import { executeApprovalCore } from "./execute.js";
import {
  allowedMergeMethodsFromRepo,
  assessMergePr,
  checkPreapproval,
  parseRepoFromRemote,
} from "./executor.js";
import { applyFolderDecision, consumeOnceFolderGrant, folderAuthSummary } from "./folder-auth.js";
import { githubCheckResult, parseGhAuthStatus, parseGhRepoList } from "./github.js";
import { ARTIFACTS_CONTRACT, refFromArtifactRow, summarizeArtifactRefs } from "./library.js";
import { appendEntry, parseMemoryBlocks } from "./memory.js";
import { addFragment, forgetMemoryItem, listFragments, readFragment } from "./memory-store.js";
import { buildMentionItems } from "./mentions.js";
import { normalizeNotifyPatch } from "./notify.js";
import {
  initialStats,
  observeEvent,
  parseNumstat,
  selectDiffTargets,
  summarizeForRow,
  toolSummaryOf,
} from "./observability.js";
import {
  compactEvent,
  deriveState,
  estimateRemainingMs,
  groupRows,
  hydrateThreadView,
  initialView,
  mergeRecord,
  pillCounts,
  reduce,
  resolveLiveRunning,
  settleState,
  sortRows,
  todoSummary,
} from "./overview.js";
import { resolveDataRoot } from "./paths.js";
import {
  fallbackSessionEvents,
  INHERIT_PRESET,
  inheritOption,
  PRESET_SAFETY_NOTES,
  planPresetApplication,
  summarizeCatalog,
  verifyPresetApplication,
} from "./permission-narrow.js";
import { buildPersona } from "./persona.js";
import {
  nextPollDelay,
  PR_LIST_FIELDS,
  parsePrList,
  planThreadPatches,
  realtimeCiSpec,
  shouldPollProject,
} from "./pr-poll.js";
import { INSTRUCTION_CHAR_LIMIT, listMemoryFiles, readProjectFiles } from "./project-files.js";
import { buildPurgeManifest, DEFAULT_RETENTION_DAYS, selectExpired } from "./purge.js";
import {
  DEFAULT_REMINDER_MODE,
  markCancelled,
  markDone,
  markFired,
  newReminderId,
  normalizeReminderMode,
  planReminderRecovery,
  purgeExpiredReminders,
  REMINDER_MODE_OPTIONS,
  remainingTime,
  resolveReminderMode,
  scheduleTimingFor,
  validateReminderInput,
} from "./reminders.js";
import {
  appendRoutineHistory,
  buildRoutineTiming,
  describeRoutineFrequency,
  describeScheduleStatus,
  historyFromDelivery,
  MANUAL_COST_HINT,
  mergeRoutineEditInput,
  newRoutineId,
  planRoutineHostAction,
  planRoutineUpdate,
  ROUTINE_COST_HINT,
  validateRoutineInput,
} from "./routines.js";
import { decideRoute } from "./routing.js";
import { deriveSubtitle, deriveToolState } from "./row-subtitle.js";
import { ProjectStore } from "./store.js";
import {
  MANAGED_BEGIN,
  mergeManagedBlock,
  planTemplate,
  renderManagedAgentsBlock,
} from "./template.js";
import { createIsolatedThread, reclaimThreadWorktree, reconcileWorktrees } from "./thread.js";
import { REQUESTABLE_ACTIONS } from "./tools.js";
import { impactOf, TRASH_DIR, trashDirFor, trashProjectIdOf } from "./trash.js";
import { buildEnvelope, createInjectionGuard, decideWake, pendingWakes } from "./wake.js";
import { planDeleteBranch, shouldDeleteBranchV2 } from "./worktree.js";
import {
  createPrCore,
  selectModelParams,
  selectThreadModelCore,
  sendToCoordinatorCore,
  shouldRecordCoordinatorMessage,
  steerThreadCore,
} from "./write-paths.js";

/** 协调器发言在内存里最多留多少条（F11 汇报渲染；只影响面板，不影响宿主持久化）。 */
export const COORDINATOR_MESSAGE_CAP = 40;

/**
 * 运行时不支持装饰器语法，用命令式方式登记 Remote（与 advisor / next-step 同法）。
 * @param {any} Proto
 * @param {string} method
 * @returns {void}
 */

/**
 * 声明一个 Remote 方法（网关只认这个被导出类自身原型上的声明）。
 * @param {any} Proto @param {string} method
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
/**
 * 跑 gh。**必须能传 cwd**：`gh pr create` 会在 cwd 里解析 git 上下文，
 * 从宿主进程 cwd（不是仓库）调用会直接报 "fatal: not a git repository"——
 * 真实仓库端到端验证时踩到（桩 gh 不关心 cwd，所以单测/冒烟都发现不了）。
 * @param {string[]} args
 * @param {string} [cwd]
 */
async function runGh(args, cwd) {
  return runCommand("gh", args, { cwd });
}

/**
 * 读一个宿主服务的 override（F52 兜底路径的回读：`approval.overrideOf` / `sandboxPolicy.overrideOf`）。
 * 拿不到/调用失败一律返回 undefined——**不编造**，"读不到"和"没有 override"是两件事。
 * @param {any} service @param {string} method @param {any} session
 * @returns {string|undefined}
 */
function hostOverride(service, method, session) {
  if (!service || typeof service[method] !== "function") return undefined;
  try {
    const value = service[method](session);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
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

/**
 * F33：为某个项目目录挑一个「会话作用域」。
 *
 * `workspaceFiles` 的 scope 是 `{sessionId, workspaceRoot}`：会话的 cwd 在 worktree 里时，
 * 用项目目录当 root 可能列不出内容（宿主按会话 workspace 求值）。所以优先挑 `thread.dir`
 * 正好等于该目录的线程，其次挑目录在同一条路径链上的线程，最后才退回第一个线程。
 * @param {any[]} threads @param {string} dir @param {string} fallback
 * @returns {string}
 */
function sessionForProjectDir(threads, dir, fallback) {
  const withSession = (Array.isArray(threads) ? threads : []).filter(
    (thread) => String(thread?.sessionId ?? "") !== "",
  );
  const target = String(dir ?? "");
  const exact = withSession.find((thread) => String(thread?.dir ?? "") === target);
  if (exact) return String(exact.sessionId);
  const related = withSession.find((thread) => {
    const own = String(thread?.dir ?? "");
    if (own === "") return false;
    return own === target || own.startsWith(`${target}/`) || target.startsWith(`${own}/`);
  });
  if (related) return String(related.sessionId);
  return String(fallback ?? "");
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
    /** F33：等待结果的 artifact 工具调用（sessionId → callId 集合），结果回来后记录 projectId↔artifactId。 @type {Map<string, Map<string, number>>} */
    this.pendingArtifactCalls = new Map();
    /** 每个线程会话的可观测统计（规格 §7.7.3：从事件累积，重启后从 0 起算）。 @type {Map<string, any>} */
    this.stats = new Map();
    /** 每个线程会话最近一条 assistant 文本（唤醒信封要带它，M0 实测不带模型读不到结果）。 @type {Map<string, string>} */
    this.lastMessages = new Map();
    /**
     * 宿主实时状态缓存（F16/F31 的权威源 `state().pendingInput` + `list()` 的会话摘要）。
     * 按 session 缓存 `state()`，TTL 2.5s；面板/通知器每隔几秒就会问一次，且只问自己项目的线程。
     * @type {Map<string, { at: number, value: any }>}
     */
    this.liveStateCache = new Map();
    /** @type {{ at: number, summaries: Map<string, any> }} */
    this.liveSummaryCache = { at: 0, summaries: new Map() };
    this.liveSummaryCache = { at: 0, summaries: new Map() };
    /**
     * 协调器会话的最近发言（F11 汇报渲染）。只存内存：协调器的正文由宿主持久化，
     * 我们只需要"面板打开时能看到最近几条 + 结论"，重启后靠宿主 replay 重建。
     * projectId → [{role, text, at}]（每个项目最多 COORDINATOR_MESSAGE_CAP 条）。
     * @type {Map<string, Array<{ role: string, text: string, at: number }>>}
     */
    this.coordinatorMessages = new Map();
    /**
     * F21 PR/CI 轮询状态（默认轮询：只对「有开放 PR 的项目」；应用关闭即停）。
     * @type {{ timer: any, running: boolean, lastAt: number, lastResult: any, failures: number, inFlight: boolean }}
     */
    /** @type {any} */
    this.prPoll = {
      timer: null,
      running: false,
      lastAt: 0,
      lastResult: null,
      failures: 0,
      inFlight: false,
      lastFailure: "",
    };
    /**
     * UI 状态（F63 首启一次 / F25 分组折叠）。优先 `storageDomain`（探针写验证过跨重启保留：
     * `<DSH_HOME>/storages/projects_ui.json`），拿不到就退化成「本次宿主运行内有效」的内存值，
     * 并在 RPC 回执里如实标 available:false（不假装已持久化）。
     * @type {{ firstRunDone: boolean, collapsedGroups: Record<string, boolean>, realtimeCi?: boolean }}
     */
    this.uiStateFallback = { firstRunDone: false, collapsedGroups: {}, realtimeCi: false };
    /** @type {{ loaded: boolean, loading: Promise<any>|undefined, domain: any }} */
    this.uiDomain = { loaded: false, loading: undefined, domain: null };
    /**
     * F52：会话句柄缓存（sessionId → Session）。`permissionPresets.set(session, name)` 收 Session，
     * 而 `sessionController.create()` 只回 sessionId——句柄只能从 `agent/created` 的 `agent.session`
     * 或 `sessions` 注册表拿，拿不到就如实标「待应用」，不假装已生效。
     * @type {Map<string, any>}
     */
    this.sessionHandles = new Map();
    /**
     * F52：每个会话的「写→回读」结果（面板直接用，别让 UI 自己猜）。
     * @type {Map<string, any>}
     */
    this.presetApplied = new Map();
    /**
     * F30：本机计时器的句柄（reminderId → Timeout）。重启后由 armReminders 按盘上记录重建。
     * @type {Map<string, any>}
     */
    this.reminderTimers = new Map();
    /** @type {{ at: number, armed: number, overdue: number }} */
    this.reminderArming = { at: 0, armed: 0, overdue: 0 };
    /** F29：每日自动 resolve 的 timer 句柄（dispose 时清掉）。 @type {any} */
    this.autoResolveTimer = null;
    /** P0-3：线程 diff 摘要缓存（sessionId → {key, at, diff}）。progress 每 5s 轮询，
     * 不缓存的话每行每 5s 都 spawn 一次 git。 @type {Map<string, {key: string, at: number, diff: any}>} */
    this.diffCache = new Map();
    /** M6-P0：同一项目的并发 progress 合并成一次计算（notifier + 详情页会同时轮询）。 @type {Map<string, Promise<any>>} */
    this.progressInFlight = new Map();
    // M6：失败自动重试调度器（单例/重查/上限/可取消都在 lib 里，有伪定时器单测）
    // 触发不能只挂在 progress()（只有详情页打开时才轮询）：面板关着也要能重试。
    // 每 30s 扫一遍活跃项目的内存视图，failed 且未超限就交给调度器（调度器自己单例/重查/上限）。
    this.autoRetryScanTimer = setInterval(() => {
      try {
        this.scanAutoRetry();
      } catch {
        /* 后台扫描失败不打扰用户 */
      }
    }, 30_000);
    this.autoRetryScanTimer.unref?.();
    this.autoRetryScheduler = createAutoRetryScheduler({
      delayMs: 60_000,
      maxAttempts: 2,
      readState: (/** @type {string} */ sessionId) => {
        const store = this.store;
        if (!store) return { enabled: false, state: "", attempts: 0 };
        // 注意：`projectOfSession` 返回的是**项目对象**（不是 id）；之前当 id 用，
        // 导致 enabled 永远 false、定时器到点直接放弃——真机 20 小时都没触发。
        const project = store.projectOfSession?.(sessionId) ?? null;
        const thread = store.state?.threads?.[sessionId] ?? null;
        // 用内存视图 + 记录推导六态：后台扫描时 progress 可能没跑过，盘上的 state 还是 working
        const view = mergeRecord(this.views.get(sessionId), thread);
        return {
          enabled: project?.policy?.autoRetry === true,
          state: deriveState(view),
          attempts: Number(thread?.autoRetryCount ?? 0),
        };
      },
      onRetry: (/** @type {string} */ sessionId, /** @type {number} */ nextAttempts) => {
        try {
          const store = this.requireStore();
          const project = store.projectOfSession?.(sessionId) ?? null;
          const projectId = String(project?.id ?? "");
          if (projectId === "") return;
          store.setThreadWorktree(sessionId, { autoRetryCount: nextAttempts });
          store.appendAudit({ action: "thread/auto-retry", projectId, sessionId });
          store.save();
          void this.steerThread(sessionId, "继续").catch(() => {});
        } catch {
          /* 自动重试失败不打扰用户 */
        }
      },
    });
    /** M3：每会话最近一次 tool/call 的工具名（生成态 `✓✓✓ Using X` 用）。 @type {Map<string, string>} */
    this.currentTools = new Map();
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
      // F21：默认轮询 PR/CI（只对「有开放 PR 的项目」；30–90s 退避；应用关闭即停）。
      // 延后到首屏之后再起，避免和冷会话唤醒抢 gh 子进程。
      setTimeout(() => {
        try {
          if (this.prPoll?.running !== true) this.setPrPolling(true);
        } catch (error) {
          this.logger?.warn?.(
            `[projects] pr polling not started: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
          );
        }
      }, 20_000);
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
      this.store.onSaveError = (/** @type {any} */ error) =>
        this.logger?.warn?.(
          `[projects] save failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`,
        );
      this.logger.info?.(
        `[projects] loaded ${this.store.listProjects().length} project(s) from ${this.store.file}`,
      );
      // F30：启动即恢复计时（关机期间到点的提醒在这里补触发；随后 armReminders 再排其余）。
      this.armReminders();
      // P0-2：用持久事件重建 Overview（重启后视图不再归零）。
      this.hydrateViews();
      // F29：启动先检查一次自动 resolve，之后每日一次（timer 在 dispose 时清掉）。
      this.runAutoResolve(Date.now());
      this.startAutoResolveTimer();
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
      // 协调器会话（F9/F11）：记最近发言，让项目页的协调者区能显示"结论"。
      // 它不属于任何线程，所以不走下面的线程归约路径。
      const coordinatorProject = this.store.projectOfCoordinatorSession?.(sessionId);
      if (coordinatorProject) {
        if (String(event?.type ?? "") === "assistant/message") {
          const text = extractText(event?.data?.message);
          if (text !== "") this.recordCoordinatorMessage(coordinatorProject.id, "assistant", text);
        } else if (String(event?.type ?? "") === "user/message") {
          const text = extractText(event?.data?.message);
          if (text !== "") this.recordCoordinatorMessage(coordinatorProject.id, "user", text);
        }
        return;
      }
      // 只跟项目线程，其它会话零开销
      const threadProjectForEvent = this.store.projectOfSession(sessionId);
      if (!threadProjectForEvent) return;
      // F33 产物归属：线程里调用 artifacts 的 `artifact` 工具成功后，把 id 记进项目的 artifactRefs。
      // 只解析 tool/result 的文本消息（artifacts 工具返回 JSON），不读产物字节；失败绝不打断事件处理。
      try {
        const eventType = String(event?.type ?? "");
        if (eventType === "tool/call") {
          const toolName = String(event?.data?.name ?? "").trim();
          if (toolName !== "") this.currentTools.set(sessionId, toolName);
        }
        if (eventType === "tool/call") {
          const callName = String(event?.data?.name ?? "");
          const callId = String(event?.data?.callId ?? "");
          if (callName === "artifact" && callId !== "") {
            const pending = this.pendingArtifactCalls.get(sessionId) ?? new Map();
            pending.set(callId, Date.now());
            this.pendingArtifactCalls.set(sessionId, pending);
          }
        } else if (eventType === "tool/result") {
          const callId = String(
            event?.data?.message?.toolCallId ??
              event?.data?.callId ??
              event?.data?.message?.callId ??
              "",
          );
          const pending = this.pendingArtifactCalls.get(sessionId);
          if (pending && callId !== "" && pending.has(callId)) {
            pending.delete(callId);
            const ref = artifactRefFromToolResult(extractText(event?.data?.message), {
              sessionId,
              toolCallId: callId,
              // 记录"什么时候产出的"：catalog 行没有这个时间，UI 的"时间未知"就是漏了它
              at: new Date().toISOString(),
            });
            if (ref) this.recordArtifact(threadProjectForEvent.id, ref);
          }
        }
      } catch (error) {
        this.logger?.warn?.(
          `[projects] artifact ref record failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        );
      }
      this.stats.set(sessionId, observeEvent(this.stats.get(sessionId) ?? initialStats(), event));
      const previous = this.views.get(sessionId) ?? initialView();
      const next = reduce(previous, event);
      this.views.set(sessionId, next);
      // P0-2：把「可回放的最小事实」追加进 projects.json，重启后由 replay() 重建同一份视图。
      // 只有结构性事件（轮/待处理/会话开关）立刻落盘，正文类事件等下一次状态变化一起刷——
      // 否则每条 assistant/message 都原子写一次 projects.json，写盘比事件还密。
      let journaledNow = false;
      try {
        const compact = compactEvent(event);
        if (compact && this.store.appendThreadEvent(sessionId, compact)) {
          journaledNow = [
            "turn/start",
            "turn/end",
            "todo/write",
            "interaction/pending",
            "interaction/cleared",
            "session/opened",
            "session/activity",
          ].includes(String(event?.type ?? ""));
        }
      } catch (error) {
        this.logger?.warn?.(
          `[projects] replay journal failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        );
      }
      // 事件回写持久状态（F16 的 P0-1）：todo 快照 / 副标题 / 六态都落 projects.json，
      // 面板没打开、宿主重启后仍读得到。只在真的变了才写盘（避免每个事件都原子写一次）。
      try {
        // 事件是高频路径（每条 tool/call 一次）：合并写盘（250ms 窗口），dispose 时 flush
        if (this.applyThreadEvent(sessionId, event, next) || journaledNow) this.store.saveSoon(250);
      } catch (error) {
        this.logger?.warn?.(
          `[projects] thread state write-back failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        );
      }
      // 状态类事件会让实时缓存立刻过时：不清的话面板最多慢 2.5s 才看到「在跑/等你」变化
      if (
        ["turn/start", "turn/end", "interaction/pending", "interaction/cleared"].includes(
          String(event?.type ?? ""),
        )
      ) {
        this.liveStateCache = new Map();
        this.liveSummaryCache = { at: 0, summaries: new Map() };
      }
      if (String(event?.type) === "assistant/message") {
        const text = extractText(event?.data?.message);
        if (text !== "") this.lastMessages.set(sessionId, text);
        // token 用量挂在同一条事件上（宿主无独立 usage 记录）；累计到项目当天分桶
        const threadProject = this.store?.projectOfSession?.(sessionId);
        // 协调器会话不在 state.threads 里：不单独归桶的话，它的自动唤醒/对话 token 永不入账，
        // 「到线暂停」的预算闸对这部分支出永远不生效（审查指出）。
        const coordinatorProject = threadProject
          ? null
          : this.store
              ?.listProjects?.()
              .find(
                (/** @type {any} */ project) =>
                  String(project.coordinatorSessionId ?? "") === sessionId,
              );
        const usageProject = threadProject ?? coordinatorProject ?? null;
        const usage = event?.data?.message?.usage ?? event?.data?.usage;
        if (usageProject && usage) {
          const nowMs = Date.now();
          const tokens = tokensOf({ at: new Date(nowMs).toISOString(), usage }, nowMs);
          if (tokens > 0) {
            this.store.addTokenUsage(usageProject.id, tokens, nowMs);
            // 必须落盘：token 分桶的设计要求「跨重启保留」（store 单测覆盖了 save 路径，
            // 但这里曾经只改内存不保存 —— 重启就丢，等于预算闸永远从 0 开始）。
            this.store.save();
            void this.enforceTokenBudget(usageProject.id, nowMs);
          }
        }
      }
      if (String(event?.type) === "turn/end") {
        void this.maybeWakeCoordinator(sessionId, next);
      }
    });
    ctx.effect?.(() => () => {
      // F29：自动 resolve 的每日检查随应用关闭即停（不留悬挂 timer）
      if (this.autoResolveTimer !== null && this.autoResolveTimer !== undefined) {
        clearInterval(this.autoResolveTimer);
        this.autoResolveTimer = null;
      }
      // F30：本机提醒的计时器也要随插件卸载清掉（之前只 unref，卸载后仍可能触发）
      for (const timer of this.reminderTimers.values()) {
        try {
          clearTimeout(timer);
        } catch {
          /* ignore */
        }
      }
      this.reminderTimers.clear();
      // F21：应用关闭即停（不留定时器，也不让 gh 子进程继续跑）
      this.prPoll.running = false;
      if (this.prPoll.timer !== null) {
        clearTimeout(this.prPoll.timer);
        this.prPoll.timer = null;
      }
      for (const dispose of this.attached.values()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      clearInterval(this.autoRetryScanTimer);
      this.autoRetryScheduler.cancelAll();
      // 合并写盘可能还有排队中的一次：dispose 前落盘，避免丢最后一批状态
      try {
        this.store?.flush?.();
      } catch {
        /* 关闭阶段写盘失败不抛 */
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
    const sessionId = String(agent?.id ?? "");
    const outcome = mountCoordinatorTools({
      agent,
      deps: {
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
      },
      onAudit: (/** @type {any} */ result) => {
        if (result.attached) {
          const store = this.requireStore();
          store.appendAudit({
            action: "coordinator/tools",
            projectId: project.id,
            count: result.count,
          });
          store.save();
          return;
        }
        this.auditSkip(project.id, "tools-skip", result.reason);
      },
    });
    if (outcome.attached) {
      this.coordinatorToolDisposers?.set?.(sessionId, outcome.disposers);
    }
    return outcome.attached;
  }

  /**
   * 给「某个会话如果是协调器」挂工具：`agent/created` 与 `warmUpCoordinator` 两条路共用。
   * 幂等（已挂过直接返回 true）；不是协调器会话返回 false。
   * B2 复审 P0：以前 `attachCoordinatorTools` 全仓零调用者，project_* 工具运行时不存在。
   * @param {string} sessionId
   * @param {any} [agent]
   * @returns {boolean}
   */
  attachCoordinatorToolsFor(sessionId, agent) {
    const sid = String(sessionId ?? "");
    if (sid === "") return false;
    if (this.coordinatorToolDisposers?.has?.(sid) === true) return true;
    const store = this.store;
    if (!store) return false;
    const project = store
      .listProjects()
      .find((/** @type {any} */ item) => item.coordinatorSessionId === sid);
    if (!project) return false;
    const liveAgent = agent ?? this.coordinatorAgents?.get?.(sid);
    if (!liveAgent) return false;
    return this.attachCoordinatorTools(liveAgent, project);
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
  /**
   * 探一下目录能不能当项目目录用（规格 §3.x）：是不是 git 仓库决定线程能不能隔离。
   * 走查发现"绑了非 git 目录 → 线程静默降级成共享目录"，界面必须能如实告知。
   * @param {{ path?: string }} [options]
   */
  inspectDir(options) {
    const path = String(options?.path ?? "").trim();
    if (path === "") return { exists: false, isGit: false, writable: false };
    const exists = existsSync(path);
    let writable = false;
    if (exists) {
      try {
        accessSync(path, constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }
    return { exists, isGit: exists && existsSync(join(path, ".git")), writable };
  }

  /**
   * 保存项目常设规则（instructions.md）。走查发现「记忆」页签只读，用户没法自己写规则。
   * 有上限（20k 字符）：这个文件每次请求都会注入，太长会持续吃上下文。
   * @param {{ projectId?: string, text?: string }} [options]
   */
  setProjectInstructions(options) {
    const store = this.requireStore();
    const projectId = String(options?.projectId ?? "");
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const text = String(options?.text ?? "");
    const MAX = 20_000;
    if (text.length > MAX) {
      store.appendAudit({ action: "project/instructions-rejected", projectId, reason: "too-long" });
      store.save();
      return { ok: false, reason: "too-long", limit: MAX };
    }
    const file = join(this.dataRoot, projectId, "instructions.md");
    mkdirSync(dirname(file), { recursive: true });
    if (text.trim() === "") {
      // 清空 = 删文件：留一个空文件会让"有没有规则"变得难以判断
      if (existsSync(file)) rmSync(file, { force: true });
      store.appendAudit({ action: "project/instructions-cleared", projectId });
      store.save();
      return { ok: true, chars: 0 };
    }
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    store.appendAudit({ action: "project/instructions-saved", projectId, chars: text.length });
    store.save();
    // 无需刷新挂载：上下文条目是函数，宿主每次请求都会重新读（见 attach.js）
    return { ok: true, chars: text.length };
  }

  /**
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
      if (agent) {
        // P0：agent 一出现就挂工具（agent/created 可能早于/晚于这条路径，`attachCoordinatorToolsFor` 幂等）
        try {
          this.attachCoordinatorToolsFor(sessionId, agent);
        } catch (error) {
          this.auditSkip(
            projectId,
            "tools-skip",
            String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
          );
        }
        return true;
      }
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
    // B2 复审 P0：协调器会话一建好就把 project_* 工具挂到**它自己的作用域**。
    // 提示词（systemPrompt）在 agent/created 里注册无效（runtime §11.18），但工具是每步从
    // scope 解析的，这里挂上之后下一轮就能用；`warmUpCoordinator` 里还有一次幂等重试。
    try {
      this.attachCoordinatorToolsFor(sessionId, agent);
    } catch (error) {
      this.auditSkip(
        undefined,
        "tools-skip",
        String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
      );
    }
    // F52：agent 一出生就记住它的 Session 句柄（`permissionPresets.set/current` 收 Session），
    // 并在这个会话属于某个项目（线程或协调器）时套用项目档位 → 回读写进 presetApplied。
    // 放在工具挂载之后：那条路径有专门的守卫测试（零调用者回归），不能被新逻辑挡住。
    try {
      this.rememberSession(sessionId, agent?.session);
      const store = this.store;
      const owner =
        store?.projectOfCoordinatorSession?.(sessionId) ?? store?.projectOfSession?.(sessionId);
      const projectId = String(owner?.id ?? "");
      if (projectId !== "" && typeof owner?.preset === "string" && owner.preset !== "") {
        const kind = owner?.coordinatorSessionId === sessionId ? "coordinator" : "thread";
        void this.applyPresetToSession(projectId, sessionId, kind).catch(
          (/** @type {any} */ error) => {
            this.logger?.warn?.(
              `[projects] preset apply failed: ${String(error?.message ?? error).slice(0, 160)}`,
            );
          },
        );
      }
    } catch (error) {
      this.logger?.warn?.(
        `[projects] preset handle skipped: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
      );
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
    // 会话级缓存跟着 agent 走：agent 已经销毁的会话不需要再留消息/工具名（Map 只增不减）
    this.lastMessages?.delete?.(sessionId);
    this.currentTools?.delete?.(sessionId);
    this.presetApplied?.delete?.(sessionId);
    // 协调器工具跟着 agent 走：agent 没了就把注册摘掉，别在作用域里留指向旧 agent 的定义
    this.coordinatorAgents?.delete?.(sessionId);
    const disposers = this.coordinatorToolDisposers?.get?.(sessionId);
    this.coordinatorToolDisposers?.delete?.(sessionId);
    for (const unmount of disposers ?? []) {
      try {
        unmount();
      } catch {
        /* ignore */
      }
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
      // 归档状态与宿主同步（F16：archived 必须跟着宿主 archive 走，否则面板和侧栏说法不一致）
      if (store.state?.threads?.[sessionId]) {
        const written = store.setThreadState(sessionId, "archived");
        if (written.changed) store.save();
      }
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

  /**
   * 取一个宿主服务，**一律判 undefined**（Service.listService ⊃ 实际装载，见 scope-confirmed §12.3-6）。
   * 用 `ctx.get` 而不是 inject：缺服务时插件要能降级，而不是整个激活失败。
   * @param {string} name
   * @returns {any}
   */
  hostService(name) {
    try {
      const ctx = /** @type {any} */ (this.ctx);
      return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 读所有线程会话的实时状态（`state()` 的 pendingInput/running 是「等你」的权威源）
   * 与会话摘要（`list()` 的 title/updatedAt，行标题与时长用）。
   * 缓存 2.5s：面板与通知器会重复问，别每次都把 N 个会话打一遍。
   * 任何一步失败都只是**没有那个事实**（调用方退回事件推导），绝不编造 running/pendingInput。
   * @param {boolean} [force]
   * @returns {Promise<{ states: Map<string, any>, summaries: Map<string, any> }>}
   */
  /**
   * 取宿主侧的实时 state()/list()。
   * @param {boolean} [force]
   * @param {string[]|null} [sessionIds] 只取这些会话（progress 传本项目线程，避免"全库 120 次 state()"）
   */
  async liveSessionFacts(force = false, sessionIds = null) {
    const now = Date.now();
    const sc = this.sessionController;
    const tracked =
      Array.isArray(sessionIds) && sessionIds.length > 0
        ? sessionIds.map(String)
        : this.store
          ? Object.keys(this.store.state?.threads ?? {})
          : [];
    // 硬上限：一个项目里堆上百个线程时不把宿主读穿；超出的行退回事件推导
    const capped = tracked.length > 200;
    const ids = tracked.slice(0, 200);
    /** @type {Map<string, any>} */
    const states = new Map();
    /** @type {Map<string, any>} */
    const summaries = new Map();
    const stale = /** @type {string[]} */ ([]);
    for (const sessionId of ids) {
      const cached = this.liveStateCache.get(sessionId);
      if (!force && cached && now - cached.at < 2500) {
        if (cached.value) states.set(sessionId, cached.value);
        continue;
      }
      stale.push(sessionId);
    }
    if (sc && typeof sc.state === "function" && stale.length > 0) {
      await Promise.all(
        stale.map(async (sessionId) => {
          try {
            const value = await sc.state({ sessionId }, AbortSignal.timeout(1500));
            this.liveStateCache.set(sessionId, { at: now, value });
            if (value && typeof value === "object") states.set(sessionId, value);
          } catch {
            /* 冷会话/服务不可用：留空，交给事件推导与持久记录 */
            this.liveStateCache.set(sessionId, { at: now, value: null });
          }
        }),
      );
    }
    const summaryStale = force || now - this.liveSummaryCache.at >= 2500;
    if (summaryStale && sc && typeof sc.list === "function") {
      try {
        const items = await sc.list(AbortSignal.timeout(4000));
        /** @type {Map<string, any>} */
        const next = new Map();
        for (const item of Array.isArray(items) ? items : []) {
          const sessionId = String(item?.sessionId ?? "");
          if (sessionId !== "") next.set(sessionId, item);
        }
        this.liveSummaryCache = { at: now, summaries: next };
      } catch {
        /* 摘要拿不到只是少个标题，不影响状态 */
      }
    }
    for (const sessionId of ids) {
      const summary = this.liveSummaryCache.summaries.get(sessionId);
      if (summary !== undefined) summaries.set(sessionId, summary);
    }
    // 缓存上限：会话删了之后 entry 会一直留着，超过 500 条就从最旧的开始丢
    if (this.liveStateCache.size > 500) {
      const entries = [...this.liveStateCache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < entries.length - 500; i += 1) this.liveStateCache.delete(entries[i][0]);
    }
    return { states, summaries, partial: capped };
  }

  /**
   * 把一条会话事件里的「可持久事实」写回线程记录（F16 的 P0-1：事件回写持久 state）。
   * 只写变化过的字段；返回是否落盘。
   * @param {string} sessionId
   * @param {any} event
   * @param {any} view
   */
  applyThreadEvent(sessionId, event, view) {
    const store = this.store;
    if (!store) return false;
    const record = store.state?.threads?.[sessionId];
    if (!record) return false;
    const type = String(event?.type ?? "");
    let dirty = false;
    const at = Number(event?.at ?? event?.time ?? 0);

    // 新一轮开始：上一轮的「已解决」不再成立（手动 resolve 的解除点）
    if (
      type === "turn/start" &&
      typeof record.resolvedAt === "string" &&
      record.resolvedAt !== ""
    ) {
      store.setThreadResolved(sessionId, false);
      dirty = true;
    }
    if (type === "todo/write") {
      const snapshot = todoSummary(event?.data);
      if (snapshot !== null) {
        const previous = record.todos;
        if (!previous || previous.total !== snapshot.total || previous.done !== snapshot.done) {
          store.setThreadTodos(sessionId, snapshot);
          dirty = true;
        }
      }
    }
    // 副标题只从 tool/call 持久化（人可读、短）；assistant 文本只在内存里兜底，不落盘
    if (type === "tool/call") {
      const subtitle = toolSummaryOf(event?.data);
      if (subtitle !== "" && subtitle !== record.subtitle) {
        store.setThreadSubtitle(sessionId, subtitle);
        dirty = true;
      }
    }
    if (Number.isFinite(at) && at > 0) store.setThreadActivity(sessionId, at);

    // 实时事实（pendingInput/running）在 progress 里统一结算；这里只用事件事实，
    // 这样即使面板没打开，状态也会随事件回写。
    const state = settleState({ view, record });
    const written = store.setThreadState(sessionId, state);
    if (written.changed) dirty = true;
    return dirty;
  }

  /**
   * UI 状态域（storageDomain）句柄：`open()` 只做一次；失败/缺失都返回 null 并降级。
   * Domain 名一次性占用（同一进程别开两次）——所以这里用单飞（single-flight）。
   * @returns {Promise<any|null>}
   */
  async uiDomainHandle() {
    if (this.uiDomain.loaded) return this.uiDomain.domain;
    if (this.uiDomain.loading) return this.uiDomain.loading;
    this.uiDomain.loading = (async () => {
      const sd = this.hostService("storageDomain");
      if (!sd || typeof sd.open !== "function") return null;
      try {
        const domain = await sd.open({
          name: "projects_ui",
          version: 1,
          global: {
            // 探针实测：schema 只被 `.parse()` 调用，宿主不校验返回值
            schema: { parse: (/** @type {any} */ value) => value },
            initial: { firstRunDone: false, collapsedGroups: {} },
          },
          tables: {},
        });
        return domain ?? null;
      } catch (error) {
        this.logger?.warn?.(
          `[projects] storageDomain unavailable: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        );
        return null;
      }
    })();
    this.uiDomain.domain = await this.uiDomain.loading;
    this.uiDomain.loaded = true;
    this.uiDomain.loading = undefined;
    return this.uiDomain.domain;
  }

  /** @param {any} value @returns {Record<string, boolean>} */
  normalizeCollapsed(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    /** @type {Record<string, boolean>} */
    const out = {};
    for (const [key, on] of Object.entries(value)) {
      if (typeof key === "string" && key !== "" && on === true) out[key] = true;
    }
    return out;
  }

  /**
   * 读 UI 状态（F63/F25）：**回读值**，不带推断。
   * @returns {Promise<{ available: boolean, firstRunDone: boolean, collapsedGroups: Record<string, boolean>, realtimeCi: boolean }>}
   */
  async uiStateInternal() {
    const domain = await this.uiDomainHandle();
    let firstRunDone = this.uiStateFallback.firstRunDone === true;
    let collapsedGroups = this.normalizeCollapsed(this.uiStateFallback.collapsedGroups);
    // F21 实验档开关：默认关；写验证过的持久面同上（storageDomain 全局区）
    let realtimeCi = /** @type {any} */ (this.uiStateFallback).realtimeCi === true;
    if (domain && typeof domain.global?.get === "function") {
      try {
        const value = domain.global.get() ?? {};
        firstRunDone = value.firstRunDone === true;
        collapsedGroups = this.normalizeCollapsed(value.collapsedGroups);
        realtimeCi = value.realtimeCi === true;
        // 回读值才是真源：同步内存副本，降级时仍用最后一次读到的值
        this.uiStateFallback = { firstRunDone, collapsedGroups, realtimeCi };
      } catch {
        /* 读失败：用内存值，available 仍为 true（域在，只是这次没读到） */
      }
    }
    return { available: Boolean(domain), firstRunDone, collapsedGroups, realtimeCi };
  }

  /**
   * 写 UI 状态并返回**回读值**（避免"假开关"）。
   * @param {{ firstRunDone?: boolean, collapsedGroups?: Record<string, boolean>, realtimeCi?: boolean }} patch
   * @returns {Promise<{ available: boolean, firstRunDone: boolean, collapsedGroups: Record<string, boolean>, realtimeCi: boolean }>}
   */
  async writeUiState(patch) {
    const current = await this.uiStateInternal();
    const next = {
      firstRunDone:
        typeof patch?.firstRunDone === "boolean" ? patch.firstRunDone : current.firstRunDone,
      collapsedGroups:
        patch?.collapsedGroups && typeof patch.collapsedGroups === "object"
          ? this.normalizeCollapsed(patch.collapsedGroups)
          : current.collapsedGroups,
      realtimeCi: typeof patch?.realtimeCi === "boolean" ? patch.realtimeCi : current.realtimeCi,
    };
    this.uiStateFallback = { ...next };
    const domain = await this.uiDomainHandle();
    if (domain && typeof domain.global?.set === "function") {
      try {
        domain.global.set(next);
      } catch (error) {
        this.logger?.warn?.(`[projects] ui state write failed: ${String(error).slice(0, 160)}`);
      }
    }
    return this.uiStateInternal();
  }

  // ---- Remote：只读 ----

  /**
   * 项目列表（F1/F31）：顺带给出线程数、未读数与「需要你」计数。
   * 未读由宿主的 `state().pendingInput`（权威）与手动标记（thread.unread）共同派生；
   * 宿主服务拿不到时退回事件推导，**不编造** waiting/unread。
   * @returns {Promise<any[]>}
   */
  async listProjects() {
    const store = this.requireStore();
    const facts = await this.liveSessionFacts();
    const archivedIds = new Set(
      Array.isArray(this.workspaceRegistry?.archivedSessionIds)
        ? this.workspaceRegistry.archivedSessionIds.map(String)
        : [],
    );
    return store.listProjects().map((/** @type {any} */ project) => {
      const threads = store.listThreads(project.id);
      let waiting = 0;
      let working = 0;
      let failed = 0;
      let unread = 0;
      for (const thread of threads) {
        const live = facts.states.get(thread.sessionId);
        const pendingInput = Array.isArray(live?.pendingInput) ? live.pendingInput : [];
        const view = mergeRecord(this.views.get(thread.sessionId), thread);
        const running =
          resolveLiveRunning(view, live?.running) ||
          (live === undefined && view.state === "working");
        const hostArchived = archivedIds.has(thread.sessionId);
        const state = hostArchived
          ? "archived"
          : settleState({
              view,
              record:
                !hostArchived && thread.state === "archived"
                  ? { ...thread, state: "idle" }
                  : thread,
              running,
              pendingInput,
            });
        if (state === "waiting-user") waiting += 1;
        if (state === "working") working += 1;
        if (state === "failed") failed += 1;
        if (pendingInput.length > 0 || thread.unread === true) unread += 1;
      }
      return {
        ...project,
        threadCount: threads.length,
        waiting,
        working,
        failed,
        unread,
      };
    });
  }

  /**
   * 网关按**参数名**绑定实参：客户端历史调用传 `{ projectId }`，冒烟/旧代码传 `{ id }`。
   * 两个名字都接（只认 `id` 会让客户端「写后回读」恒为 null）。
   * @param {string} [id] @param {string} [projectId]
   */
  getProject(id, projectId) {
    const target = String(projectId ?? id ?? "");
    return this.requireStore().getProject(target) ?? null;
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
    const memory = this.listMemoryFragments(projectId);
    return {
      instructions: files.instructions,
      memoryIndex: files.memoryIndex,
      // F37：碎片列表 + 索引拆块（UI 的「逐条 forget / 预览」用）
      entries: parseMemoryBlocks(files.memoryIndex),
      fragments: memory.fragments,
      memoryChars: files.memoryIndex.length,
      instructionsChars: files.instructions.length,
      // M5：Memory 两层呈现（Claude 的 instructions 计数 / MEMORY.md 更新于 / Memory files 列表）
      instructionsLimit: INSTRUCTION_CHAR_LIMIT,
      instructionsUpdatedAt: files.instructionsStat?.updatedAt ?? null,
      memoryUpdatedAt: files.memoryStat?.updatedAt ?? null,
      memoryFiles: listMemoryFiles(this.dataRoot, projectId),
    };
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
   * @param {{goal?: string, dirs?: string[], template?: boolean}} [input]
   */
  createProject(name, input) {
    // SRC 模式（无生成描述符）要求 Remote 方法不带默认参数/解构/rest，否则网关直接拒绝。
    const store = this.requireStore();
    const project = store.createProject(name, input ?? {});
    store.save();
    // 一键建项目模板（规格 §7.7.6）：只在显式要求时动作，失败不阻断建项目
    if (input?.template === true) {
      try {
        const dir = Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : "";
        const agentsPath = dir === "" ? "AGENTS.md" : `${dir.replace(/\/+$/u, "")}/AGENTS.md`;
        const instructionsPath =
          dir === "" ? "instructions.md" : `${dir.replace(/\/+$/u, "")}/instructions.md`;
        const plan = planTemplate({
          dir,
          exists: {
            dirExists: dir === "" ? true : existsSync(dir),
            agentsMd: existsSync(agentsPath),
            instructionsMd: existsSync(instructionsPath),
          },
        });
        for (const mkdir of plan.mkdirs) mkdirSync(mkdir, { recursive: true });
        for (const file of plan.files) {
          mkdirSync(dirname(file.path), { recursive: true });
          writeFileSync(file.path, file.content, { flag: "wx" }); // wx：绝不覆盖用户已有文件
        }
        store.appendAudit({
          action: "project/template",
          projectId: project.id,
          created: plan.files.map((file) => file.path),
          skipped: plan.skipped.map((item) => item.path),
        });
        store.save();
      } catch (error) {
        store.appendAudit({
          action: "project/template-failed",
          projectId: project.id,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
        });
        store.save();
      }
    }
    return project;
  }

  /**
   * @param {string} id
   * @param {any} patch
   */
  updateProject(id, patch) {
    const store = this.requireStore();
    const before = store.getProject(id);
    const project = store.updateProject(id, patch);
    store.save();
    // 可见性变化也是一次用户动作，留痕（也方便冒烟确认写路径真的走到了 host）
    if (typeof patch?.visibleViewsText === "string") {
      store.appendAudit({
        action: "project/visible-views",
        projectId: id,
        visibleViews: project?.visibleViews ?? [],
      });
      store.save();
    }
    // 安全面变更必须留痕：危险开关、自治等级、路由规则都直接影响"插件能替你做什么"
    const afterDanger = project?.policy?.danger ?? {};
    const beforeDanger = before?.policy?.danger ?? {};
    const switched = [
      "forcePushOwnBranch",
      "pushProtectedBranch",
      "autoMerge",
      "trashAuto",
      "purgeAfterRetention",
      "editProfile",
    ].filter((key) => (beforeDanger[key] === true) !== (afterDanger[key] === true));
    const autonomyChanged =
      String(before?.policy?.autonomy ?? "") !== String(project?.policy?.autonomy ?? "");
    const routingChanged =
      JSON.stringify(before?.policy?.routing ?? null) !==
      JSON.stringify(project?.policy?.routing ?? null);
    if (switched.length > 0 || autonomyChanged || routingChanged) {
      store.appendAudit({
        action: "project/policy-changed",
        projectId: id,
        switched: switched.map((key) => ({ key, on: afterDanger[key] === true })),
        ...(autonomyChanged
          ? { autonomy: { from: before?.policy?.autonomy, to: project?.policy?.autonomy } }
          : {}),
        ...(routingChanged ? { routing: "changed" } : {}),
      });
      store.save();
    }
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

  /**
   * 收藏 / 取消收藏项目。
   * 只改 pinned 一个字段：不杀线程、不动 worktree、不触发唤醒——收藏是视图状态，
   * 副作用越少越不会出现"收个藏把项目停了"这类意外（U2：UI 状态必须有持久化字段）。
   * @param {string} projectId
   * @param {boolean} pinned
   */
  setProjectPinned(projectId, pinned) {
    const store = this.requireStore();
    const project = store.setPinned(String(projectId ?? ""), pinned === true);
    store.appendAudit({
      action: pinned === true ? "project/pinned" : "project/unpinned",
      projectId: project.id,
    });
    store.save();
    return project;
  }

  /**
   * 把一个会话的内存视图标成「已解决」（手动 resolve 与自动 resolve 共用）。
   * @param {string} sessionId
   */
  markViewResolved(sessionId) {
    const view = this.views.get(sessionId) ?? initialView();
    this.views.set(sessionId, {
      ...view,
      resolved: true,
      archived: false,
      lastTurnFailed: false,
      lastAttemptFailed: false,
      awaitingUser: false,
      state: "done",
      unread: false,
    });
  }

  /**
   * P0-2：用盘上的持久事件重建 Overview（service 构造时调用一次）。
   * 事件来源是 store 的 `thread.events`（`compactEvent` 收敛后的最小事实）；
   * 拿不到事件的旧数据回退到记录本身（`mergeRecord`），所以升级后不会丢已写的状态。
   * @returns {{ restored: number, failed: number }}
   */
  hydrateViews() {
    const store = this.store;
    if (!store) return { restored: 0, failed: 0 };
    let restored = 0;
    let failed = 0;
    for (const project of store.listProjects()) {
      for (const thread of store.listThreads(project.id)) {
        const sessionId = String(thread?.sessionId ?? "");
        if (sessionId === "") continue;
        try {
          const view = hydrateThreadView(thread, thread.events);
          this.views.set(sessionId, view);
          if (view.lastActivityAt > 0) restored += 1;
          if (view.lastTurnFailed === true) failed += 1;
        } catch (error) {
          failed += 1;
          this.logger?.warn?.(
            `[projects] replay failed for ${sessionId.slice(0, 18)}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)}`,
          );
        }
      }
    }
    if (restored > 0) {
      this.logger?.info?.(`[projects] replayed ${restored} thread view(s) from persisted events`);
    }
    return { restored, failed };
  }

  /**
   * F29：每日一次的自动 resolve 检查（启动时也跑一次）。
   * 只改「无活动 ≥ N 天」的线程；写审计 `thread/auto-resolved` 并同步内存视图
   * （否则下一次 progress 会拿旧的失败视图把状态推回去）。
   * @param {number} [now]
   * @returns {{ ok: true, checked: number, resolved: { projectId: string, sessionId: string, days: number, idleDays: number }[] }}
   */
  runAutoResolve(now = Date.now()) {
    const store = this.requireStore();
    const projects = store.listProjects();
    const plan = planAutoResolve(projects, store.state?.threads ?? {}, now);
    if (plan.targets.length === 0) return { ok: true, checked: plan.checked, resolved: [] };
    /** @type {{ projectId: string, sessionId: string, days: number, idleDays: number }[]} */
    const done = [];
    for (const target of plan.targets) {
      try {
        store.setThreadResolved(target.sessionId, true);
        store.appendAudit({
          action: "thread/auto-resolved",
          projectId: target.projectId,
          sessionId: target.sessionId,
          days: target.days,
          idleDays: target.idleDays,
        });
        this.markViewResolved(target.sessionId);
        done.push(target);
      } catch (error) {
        this.logger?.warn?.(
          `[projects] auto resolve failed for ${target.sessionId.slice(0, 18)}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)}`,
        );
      }
    }
    if (done.length > 0) store.save();
    return { ok: true, checked: plan.checked, resolved: done };
  }

  /**
   * RPC 入口：手动跑一次自动 resolve 检查（设置页/排障/冒烟用；与每日 timer 同一份逻辑）。
   */
  checkAutoResolve() {
    return this.runAutoResolve(Date.now());
  }

  /** F29：每日一次的 timer（幂等；dispose 时清掉）。 */
  startAutoResolveTimer() {
    if (this.autoResolveTimer !== null && this.autoResolveTimer !== undefined) return;
    const timer = setInterval(
      () => {
        try {
          this.runAutoResolve(Date.now());
        } catch (error) {
          this.logger?.warn?.(
            `[projects] auto resolve timer failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
          );
        }
      },
      24 * 60 * 60 * 1000,
    );
    // Node 里 unref 让测试/CLI 进程能退出；宿主进程不靠这个 timer 存活。
    timer?.unref?.();
    this.autoResolveTimer = timer;
  }

  /**
   * F29：设置「N 天无活动自动 resolve」（null = 关）。返回回读值，UI 不自己猜。
   * 设置页可能被宿主禁用，所以项目详情右栏也能改（同一个 RPC）。
   * Remote 的位置参数按**形参名**传（Typert 网关口径），所以签名保持扁平：
   * `{ projectId, days }`，不要包一层 `input`（包了 RPC 会拿不到实参）。
   * @param {string} projectId
   * @param {number|null} days
   */
  /**
   * 保存自定义视图（面板「+ 新增视图」）。参数是位置参数，客户端用同名键传（Typert 网关约定）。
   * @param {string} projectId
   * @param {string} name
   * @param {string} [filter]
   * @param {string} [query]
   */
  /**
   * 写右栏可见视图（D1）。`viewsText` = 逗号分隔的 id（标量参数，避免网关收窄嵌套对象）。
   * @param {string} projectId
   * @param {string} viewsText
   */
  async setVisibleViews(projectId, viewsText) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const views = String(viewsText ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const result = store.setVisibleViews(project.id, views);
    store.appendAudit({
      action: "project/visible-views",
      projectId: project.id,
      visibleViews: result.visibleViews,
    });
    store.save();
    return { ok: true, visibleViews: result.visibleViews };
  }

  /**
   * 保存自定义视图。
   * @param {string} projectId @param {string} name @param {string} [filter] @param {string} [query]
   */
  /**
   * PR 概览（三卡数据源）：只读 `gh pr view --json`，不打开浏览器、不合并。
   * 合并/审阅动作需要新的宿主 seam（见 README 的已知限制），这里只给事实。
   * @param {string} projectId @param {string} sessionId
   */
  async prOverview(projectId, sessionId) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const thread = store
      .listThreads(project.id)
      .find((/** @type {any} */ item) => String(item.sessionId) === String(sessionId));
    if (!thread) throw new Error(`projects: unknown thread ${sessionId}`);
    const prNumber = Number(thread.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, reason: "no-pr" };
    // 多目录项目：优先用线程 worktree，避免去另一个仓库查同号 PR
    const repoRoot = pickRepoRoot({ worktree: thread.worktree, dirs: project.dirs });
    if (repoRoot === "") return { ok: false, reason: "no-dir" };
    const gh = await runGh(
      ["pr", "view", String(prNumber), "--json", "number,title,url,state,isDraft,mergeable"],
      repoRoot,
    );
    if (gh.code !== 0) return { ok: false, reason: "gh-failed" };
    try {
      const data = JSON.parse(String(gh.stdout ?? ""));
      return {
        ok: true,
        pr: {
          number: Number(data.number ?? prNumber),
          title: String(data.title ?? ""),
          url: String(data.url ?? ""),
          state: String(data.state ?? ""),
          isDraft: data.isDraft === true,
          mergeable: String(data.mergeable ?? ""),
        },
      };
    } catch {
      return { ok: false, reason: "parse-failed" };
    }
  }

  /**
   * 保存自定义视图。
   * @param {string} projectId @param {string} name @param {string} [filter] @param {string} [query]
   */
  /**
   * 合并 PR（不可逆动作，门禁三重：PR 存在 + 二次确认 + 危险开关 autoMerge）。
   * `gh pr merge --squash --delete-branch` 在项目目录跑；成功记 mergedAt 与审计。
   * @param {string} projectId @param {string} sessionId @param {boolean} [confirm]
   */
  async mergePr(projectId, sessionId, confirm) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const thread = store
      .listThreads(project.id)
      .find((/** @type {any} */ item) => String(item.sessionId) === String(sessionId));
    if (!thread) throw new Error(`projects: unknown thread ${sessionId}`);
    const decision = canMergePr({
      prNumber: Number(thread.prNumber),
      confirmed: confirm === true,
      dangerAutoMerge: project.policy?.danger?.autoMerge === true,
    });
    if (!decision.ok) {
      store.appendAudit({
        action: "pr/merge-refused",
        projectId: project.id,
        sessionId,
        reason: decision.reason,
      });
      store.save();
      return { ok: false, reason: decision.reason };
    }
    // 多目录项目：合并必须在**线程 worktree 所属仓库**里跑（否则会合并错仓库的同号 PR）
    const repoRoot = pickRepoRoot({ worktree: thread.worktree, dirs: project.dirs });
    if (repoRoot === "") return { ok: false, reason: "no-dir" };
    const prNumber = Number(thread.prNumber);
    const viewFields =
      "isDraft,mergeable,state,statusCheckRollup,reviews,additions,deletions,changedFiles";
    const readPr = async () => {
      const gh = await runGh(["pr", "view", String(prNumber), "--json", viewFields], repoRoot);
      if (gh.code !== 0) return { ok: false, reason: "merge/pr-view-failed" };
      try {
        return { ok: true, pr: JSON.parse(String(gh.stdout ?? "")) };
      } catch {
        return { ok: false, reason: "merge/pr-view-failed" };
      }
    };
    let view = await readPr();
    if (!view.ok) {
      store.appendAudit({
        action: "pr/merge-refused",
        projectId: project.id,
        sessionId,
        prNumber,
        reason: view.reason,
      });
      store.save();
      return { ok: false, reason: view.reason };
    }
    // 草稿 PR 直接 merge 会被 GitHub 拒（真机踩过：GraphQL "still a draft"），先 pr ready，
    // 再重新读一次做完整门禁（CI / 批准数 / mergeable / 改动量阈值）
    if (view.pr?.isDraft === true) {
      const ready = await runGh(["pr", "ready", String(prNumber)], repoRoot);
      if (ready.code !== 0) {
        store.appendAudit({
          action: "pr/merge-refused",
          projectId: project.id,
          sessionId,
          prNumber,
          reason: "merge/pr-ready-failed",
        });
        store.save();
        return { ok: false, reason: "merge/pr-ready-failed" };
      }
      view = await readPr();
      if (!view.ok) return { ok: false, reason: view.reason };
    }
    // 合并方式：仓库 API 的 allow_squash_merge（拿不到就当未知，拒绝而不是猜）
    const remote = await runGit(["remote", "get-url", "origin"], repoRoot);
    const repo = remote.code === 0 ? parseRepoFromRemote(String(remote.stdout ?? "").trim()) : "";
    let allowedMethods = null;
    if (repo !== "") {
      const repoInfo = await runGh(["api", `repos/${repo}`], repoRoot);
      if (repoInfo.code === 0) {
        try {
          allowedMethods = allowedMergeMethodsFromRepo(JSON.parse(String(repoInfo.stdout ?? "")));
        } catch {
          allowedMethods = null;
        }
      }
    }
    let verdict = assessMergePr({
      pr: view.pr,
      allowedMethods,
      minApprovals: Number(project.policy?.merge?.minApprovals ?? 1),
      maxDiffFiles: Number(project.policy?.merge?.maxDiffFiles ?? 20),
      maxDiffLines: Number(project.policy?.merge?.maxDiffLines ?? 600),
    });
    // GitHub 刚建 PR 时 mergeable 可能还在算：有界重试（与审批执行器同一套语义）
    for (let attempt = 0; !verdict.ok && attempt < 5; attempt += 1) {
      if (verdict.reason !== "merge/pr-mergeable-unknown") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      view = await readPr();
      if (!view.ok) break;
      verdict = assessMergePr({
        pr: view.pr,
        allowedMethods,
        minApprovals: Number(project.policy?.merge?.minApprovals ?? 1),
        maxDiffFiles: Number(project.policy?.merge?.maxDiffFiles ?? 20),
        maxDiffLines: Number(project.policy?.merge?.maxDiffLines ?? 600),
      });
    }
    if (!verdict.ok) {
      store.appendAudit({
        action: "pr/merge-refused",
        projectId: project.id,
        sessionId,
        prNumber,
        reason: verdict.reason,
      });
      store.save();
      return { ok: false, reason: verdict.reason };
    }
    const planned = planMergeSteps({ prNumber, isDraft: false });
    if ("error" in planned) return { ok: false, reason: planned.error };
    /** @type {{ code: number, stdout: string, stderr: string }} */
    let gh = { code: 0, stdout: "", stderr: "" };
    for (const argv of planned.steps) {
      gh = await runGh(argv, repoRoot);
      if (gh.code !== 0) break;
    }
    if (gh.code !== 0) {
      store.appendAudit({
        action: "pr/merge-failed",
        projectId: project.id,
        sessionId,
        prNumber: Number(thread.prNumber),
        detail: String(gh.stderr ?? "")
          .split("\n")[0]
          .slice(0, 200),
      });
      store.save();
      return { ok: false, reason: "gh-failed" };
    }
    store.setThreadWorktree(sessionId, { mergedAt: new Date().toISOString() });
    store.appendAudit({
      action: "pr/merged",
      projectId: project.id,
      sessionId,
      prNumber: Number(thread.prNumber),
    });
    store.save();
    return { ok: true, prNumber: Number(thread.prNumber) };
  }

  /**
   * 保存自定义视图。
   * @param {string} projectId @param {string} name @param {string} [filter] @param {string} [query]
   */
  /**
   * 编辑一条 routine（指令/频率/时间）：先同步宿主定时，再改本地记录——
   * 宿主改失败就整体失败，绝不出现「本地说 10:00、宿主还按 09:00 投递」的漂移。
   * @param {string} projectId @param {string} routineId @param {any} input
   */
  async updateRoutine(projectId, routineId, input) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const routine = store
      .listRoutines(project.id)
      .find((/** @type {any} */ item) => String(item.id) === String(routineId));
    if (!routine) return { ok: false, reason: "routine/not-found" };
    const planned = planRoutineUpdate({
      ...mergeRoutineEditInput(routine, input ?? {}),
      timeZone: this.hostTimeZone(),
    });
    if (!planned.ok) return { ok: false, reason: planned.reason };
    // 定时↔手动必须真的建/删宿主定时：只 update 会让「改成手动」继续按旧频率烧 token，
    // 而「手动改成每天」因为原本没有 scheduleId 会变成永不投递。
    const wantsTiming = Object.hasOwn(planned.hostPatch, "timing");
    const action = planRoutineHostAction({
      scheduleId: String(routine.scheduleId ?? ""),
      wantsTiming,
    });
    const schedule = this.scheduleHost();
    let nextScheduleId = String(routine.scheduleId ?? "");
    if (action === "delete" || action === "update") {
      if (!schedule || typeof schedule.edit !== "function") {
        return { ok: false, reason: "schedule-unavailable" };
      }
      try {
        await schedule.edit(
          action === "delete"
            ? { id: nextScheduleId, action: "delete" }
            : { id: nextScheduleId, action: "update", patch: planned.hostPatch },
        );
      } catch (error) {
        store.appendAudit({
          action: "routine/update-failed",
          projectId: project.id,
          routineId,
          reason: action,
          detail: String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
        });
        store.save();
        return { ok: false, reason: "schedule-failed" };
      }
      if (action === "delete") nextScheduleId = "";
    } else if (action === "create") {
      if (!schedule || typeof schedule.create !== "function") {
        return { ok: false, reason: "schedule-unavailable" };
      }
      const cwd =
        Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : this.dataRoot;
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        /* 目录已存在/无权限：宿主 create 会报出真正原因 */
      }
      try {
        const created = await schedule.create({
          title: `[${String(project.name ?? project.id)}] ${String(planned.local.name)}`.slice(
            0,
            120,
          ),
          prompt: String(planned.local.instructions),
          timing: planned.hostPatch.timing,
          target: { kind: "new", create: { cwd } },
        });
        nextScheduleId = String(created?.id ?? "");
      } catch (error) {
        store.appendAudit({
          action: "routine/update-failed",
          projectId: project.id,
          routineId,
          reason: "create",
          detail: String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
        });
        store.save();
        return { ok: false, reason: "schedule-failed" };
      }
      if (nextScheduleId === "") return { ok: false, reason: "schedule/no-id" };
    }
    const written = store.patchRoutine(project.id, routineId, {
      ...planned.local,
      scheduleId: nextScheduleId,
    });
    store.appendAudit({
      action: "routine/updated",
      projectId: project.id,
      routineId,
      frequency: planned.local.frequency,
      hostAction: action,
      scheduleId: nextScheduleId,
    });
    store.save();
    return { ok: true, routine: written.routine, hostAction: action };
  }

  /**
   * 保存自定义视图。
   * @param {string} projectId @param {string} name @param {string} [filter] @param {string} [query]
   */
  async addView(projectId, name, filter, query) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const view = store.addView(project.id, { name, filter, query });
    store.save();
    store.appendAudit({ action: "view/added", projectId: project.id, viewId: view.id });
    return { view, views: store.getProject(project.id)?.views ?? [] };
  }

  /**
   * 删除自定义视图。
   * @param {string} projectId
   * @param {string} viewId
   */
  async deleteView(projectId, viewId) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const views = store.deleteView(project.id, String(viewId ?? ""));
    store.save();
    store.appendAudit({ action: "view/deleted", projectId: project.id, viewId });
    return { views };
  }

  /**
   * 自动 resolve 天数（null = 关）。
   * @param {string} projectId
   * @param {number|null} days
   */
  setAutoResolveDays(projectId, days) {
    const store = this.requireStore();
    const id = String(projectId ?? "");
    const project = store.getProject(id);
    if (!project) throw new Error(`projects: unknown project ${id}`);
    const raw = days ?? null;
    const normalized = raw === null ? null : autoResolveDaysOf(raw);
    if (raw !== null && normalized === null) {
      throw new Error("projects: autoResolveDays must be an integer in 1..365 or null");
    }
    const updated = store.updateProject(id, { autoResolveDays: normalized });
    store.appendAudit({
      action: "project/auto-resolve",
      projectId: id,
      days: updated.autoResolveDays,
    });
    store.save();
    return {
      ok: true,
      projectId: id,
      autoResolveDays: updated.autoResolveDays,
    };
  }

  /**
   * 手动 Resolve / 重开（F29）。自动 resolve（autoResolveDays）见 runAutoResolve。
   * 返回**回读值**：客户端据此更新，而不是自己猜。
   * @param {string} sessionId
   * @param {boolean} resolved
   */
  resolveThread(sessionId, resolved) {
    const store = this.requireStore();
    const id = String(sessionId ?? "");
    const project = store.projectOfSession(id);
    if (!project) throw new Error(`projects: unknown thread ${id}`);
    const record = store.setThreadResolved(id, resolved === true);
    store.appendAudit({
      action: resolved === true ? "thread/resolved" : "thread/reopened",
      projectId: project.id,
      sessionId: id,
    });
    store.save();
    // 内存视图同步：否则下一次 progress 会拿旧视图把状态推回去。
    // resolve 是用户对「失败/完成」的显式确认，因此要一起清掉失败标记——否则
    // deriveState 的 `failed > resolved` 会立刻把刚点的「已解决」弹回失败。
    // `resolvedAt` 仍是我们唯一持久化的事实；重开后由 replay + applyRecordResolution 重建。
    if (resolved === true) this.markViewResolved(id);
    else {
      const view = this.views.get(id) ?? initialView();
      this.views.set(id, {
        ...view,
        resolved: false,
        archived: false,
        state: view.lastTurnFailed ? "failed" : "idle",
        unread: false,
      });
    }
    this.liveCache = { at: 0, states: new Map(), summaries: new Map() };
    return {
      ok: true,
      sessionId: id,
      state: record.state,
      resolvedAt: record.resolvedAt,
      readback: store.state?.threads?.[id]?.state ?? record.state,
    };
  }

  /**
   * 标记未读 / 已读（F31）。宿主没有 read 概念，只能存插件自己的 flag；
   * 「等你」的圆点由 pendingInput 派生，不受这里影响（两件事，不混）。
   * @param {string} sessionId
   * @param {boolean} unread
   */
  setThreadUnread(sessionId, unread) {
    const store = this.requireStore();
    const id = String(sessionId ?? "");
    const project = store.projectOfSession(id);
    if (!project) throw new Error(`projects: unknown thread ${id}`);
    const record = store.setThreadUnread(id, unread === true);
    store.appendAudit({
      action: unread === true ? "thread/marked-unread" : "thread/marked-read",
      projectId: project.id,
      sessionId: id,
    });
    store.save();
    return {
      ok: true,
      sessionId: id,
      unread: record.unread,
      readback: store.state?.threads?.[id]?.unread === true,
    };
  }

  /**
   * UI 状态（F63 首启是否已看过 / F25 分组折叠）：storageDomain 持久化，跨重启保留。
   * @returns {Promise<{ available: boolean, firstRunDone: boolean, collapsedGroups: Record<string, boolean> }>}
   */
  uiState() {
    return this.uiStateInternal();
  }

  /** @param {boolean} done */
  async setFirstRunDone(done) {
    return this.writeUiState({ firstRunDone: done === true });
  }

  /**
   * 折叠/展开一个 Overview 分组（F25）。`group` 是 STATE_GROUPS 的 id。
   * @param {string} group
   * @param {boolean} collapsed
   */
  async setGroupCollapsed(group, collapsed) {
    const id = String(group ?? "").trim();
    if (id === "") throw new Error("projects: group id is required");
    const snapshot = await this.uiStateInternal();
    const collapsedGroups = { ...snapshot.collapsedGroups };
    if (collapsed === true) collapsedGroups[id] = true;
    else delete collapsedGroups[id];
    return this.writeUiState({ collapsedGroups });
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
    // worktree 不会随删除消失：把它们列进影响面，别让用户以为点了删除就清空了磁盘
    const worktrees = threads
      .filter((/** @type {any} */ thread) => String(thread?.worktree ?? "") !== "")
      .map((/** @type {any} */ thread) => ({
        sessionId: String(thread.sessionId ?? ""),
        branch: String(thread.branch ?? ""),
        worktree: String(thread.worktree),
      }));
    return {
      projectId: id,
      name: project.name,
      impact: impactOf({
        threads,
        contentBytes,
        hasContentDir,
        name: project.name,
        worktrees,
      }),
      worktrees,
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
  async deleteProject(id) {
    const store = this.requireStore();
    const preview = this.previewDeleteProject(id);
    // 在跑的线程：删掉记录后 agent 的结果无法回写，用户会以为任务还在跑（审查实测）
    const previewThreads = store.listThreads(id);
    const live = await this.liveSessionFacts(
      false,
      previewThreads
        .map((/** @type {any} */ thread) => String(thread.sessionId ?? ""))
        .filter(Boolean),
    );
    const busy = previewThreads.filter((/** @type {any} */ thread) =>
      this.threadBusy(thread, live.states),
    );
    if (busy.length > 0) {
      throw new Error(
        `projects: project has ${busy.length} running/waiting thread(s); stop them before deleting`,
      );
    }
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
          worktrees: preview.worktrees,
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
    const id = String(sessionId ?? "").trim();
    if (id === "") throw new Error("projects: sessionId is required");
    const thread = store.attachThread(id, projectId);
    store.save();
    // 不需要在这里补挂上下文：项目上下文是**全局注册 + 按会话求值**的
    // （见构造函数的 registerProjectContext），归属一落盘，下一次请求就会渲染出来。
    return thread;
  }

  /**
   * 回收站里有哪些项目（规格 §7.5 行 4a 的可恢复性：**能删就要能看、能还原**）。
   * 直接扫数据根下的 `trash/`，每个子目录读 manifest.json。
   */
  listTrash() {
    const root = join(this.dataRoot, TRASH_DIR);
    if (!existsSync(root)) return { entries: [] };
    /** @type {any[]} */
    const entries = [];
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const deletedAt = Date.parse(String(manifest?.deletedAt ?? "")) || 0;
        const project = manifest?.project ?? {};
        entries.push({
          entryId: name,
          projectId: String(project.id ?? ""),
          name: String(project.name ?? "(未命名)"),
          deletedAt,
          threadCount: Array.isArray(manifest?.threads) ? manifest.threads.length : 0,
          sizeBytes: this.sizeOf(dir),
          restorable: String(project.id ?? "") !== "",
        });
      } catch {
        // 认不出的条目保留在列表里并标不可恢复，绝不静默忽略（约定 1）
        entries.push({
          entryId: name,
          projectId: "",
          name,
          deletedAt: 0,
          threadCount: 0,
          sizeBytes: 0,
          restorable: false,
        });
      }
    }
    entries.sort((a, b) => b.deletedAt - a.deletedAt);
    return { entries };
  }

  /**
   * 彻底删除**一个**回收站条目（不可恢复）。ADR 0002：必须显式 confirm，并写审计。
   * 与 purgeTrash 的区别：那个只清「超过保留期」的，这个是用户主动清"刚删错又不想留"的。
   * @param {{ entryId?: string, confirm?: boolean }} [options]
   */
  deleteTrashEntry(options) {
    const input = options ?? {};
    const entryId = String(input.entryId ?? "");
    if (!/^[A-Za-z0-9_.-]+$/u.test(entryId) || entryId.includes("..")) {
      throw new Error("projects: invalid trash entry");
    }
    const dir = join(this.dataRoot, TRASH_DIR, entryId);
    if (!existsSync(dir)) throw new Error(`projects: trash entry not found ${entryId}`);
    if (input.confirm !== true) {
      // 不确认时只报影响面，不动手（与 purgeTrash 的 dry-run 同款语义）
      return { ok: false, reason: "confirm-required", entryId, bytes: this.sizeOf(dir) };
    }
    const bytes = this.sizeOf(dir);
    rmSync(dir, { recursive: true, force: true });
    const store = this.requireStore();
    store.appendAudit({ action: "trash/entry-deleted", entryId, bytes });
    store.save();
    return { ok: true, entryId, bytes };
  }

  /**
   * 清空回收站（不可恢复）。ADR 0002：必须显式 confirm，并写审计。
   * @param {{ confirm?: boolean }} [options]
   */
  emptyTrash(options) {
    const input = options ?? {};
    const root = join(this.dataRoot, TRASH_DIR);
    const names = existsSync(root) ? readdirSync(root) : [];
    let bytes = 0;
    for (const name of names) bytes += this.sizeOf(join(root, name));
    if (input.confirm !== true) {
      return { ok: false, reason: "confirm-required", count: names.length, bytes };
    }
    for (const name of names) rmSync(join(root, name), { recursive: true, force: true });
    const store = this.requireStore();
    store.appendAudit({ action: "trash/emptied", count: names.length, bytes });
    store.save();
    return { ok: true, count: names.length, bytes };
  }

  /**
   * 从回收站恢复一个项目（把 manifest 里的元数据放回仓储，内容目录搬回去）。
   * @param {string} entryId 回收站子目录名（不接受路径分隔符）
   */
  restoreTrash(entryId) {
    const store = this.requireStore();
    const id = String(entryId ?? "");
    if (!/^[A-Za-z0-9_.-]+$/u.test(id) || id.includes("..")) {
      throw new Error("projects: invalid trash entry");
    }
    const dir = join(this.dataRoot, TRASH_DIR, id);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`projects: trash entry not found ${id}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const project = manifest?.project;
    if (!project?.id) throw new Error("projects: trash manifest has no project");

    const restored = store.restoreProject({ project, threads: manifest.threads ?? [] });
    // 内容目录搬回项目目录（失败则报错，元数据已恢复但内容留在回收站，可再试）
    const contentTrash = join(dir, "content");
    if (existsSync(contentTrash)) {
      const target = join(this.dataRoot, String(project.id));
      try {
        renameSync(contentTrash, target);
      } catch (error) {
        store.appendAudit({
          action: "project/restore-content-failed",
          projectId: project.id,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
        });
        store.save();
        throw new Error(
          `projects: content restore failed (${String(/** @type {any} */ (error)?.message ?? error)})`,
        );
      }
    }
    rmSync(dir, { recursive: true, force: true });
    store.appendAudit({
      action: "project/restored",
      projectId: project.id,
      entryId: id,
      threadCount: restored.threadCount,
    });
    store.save();
    return {
      ok: true,
      projectId: project.id,
      name: restored.project.name,
      threadCount: restored.threadCount,
    };
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
    const live = await this.liveSessionFacts(
      false,
      threads.map((/** @type {any} */ thread) => String(thread.sessionId ?? "")).filter(Boolean),
    );
    for (const thread of threads) {
      const branch = typeof thread.branch === "string" ? thread.branch : "";
      if (branch === "") continue;
      // 在跑/等你的线程：worktree 就是它的工作目录，删了会打断 agent（审查实测）
      if (this.threadBusy(thread, live.states)) {
        candidates.push({ branch, ok: false, reason: "thread-busy" });
        continue;
      }
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
    const onlyProjectId = input.projectId ? String(input.projectId) : "";
    const dir = this.trashRoot();
    if (dir) {
      /** @type {string[]} */
      let names = [];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        names = [];
      }
      for (const name of names) {
        // 目录名是 `<projectId>-<ISO 时间戳>`；projectId 不含 "-"（prj_xxx）
        const projectId = trashProjectIdOf(name);
        if (onlyProjectId !== "" && projectId !== onlyProjectId) continue;
        const full = join(dir, name);
        entries.push({ name, projectId, path: full, bytes: this.sizeOf(full) });
      }
    }
    // 开关语义：按项目过滤时看该项目的开关；全局清理时"任一项目打开"即可（旧口径）
    const projects = onlyProjectId
      ? [store.getProject(onlyProjectId)].filter(Boolean)
      : store.listProjects();

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
   * 记忆索引（MEMORY.md）单段落，用于 wake 信封（F10）。读不到就是空串。
   * @param {any} project
   * @returns {string}
   */
  renderMemoryIndexFor(project) {
    try {
      return String(readProjectFiles(this.dataRoot, project.id).memoryIndex ?? "").trim();
    } catch {
      return "";
    }
  }

  /**
   * 最近线程的一行摘要（F10）：除本次触发的线程外，最近活动的 3 个线程。
   * 为什么要它：协调器只看单条信封时不知道"同类线程已经在跑"，容易重复派活。
   * @param {any} project
   * @param {string} excludeSessionId
   * @returns {string}
   */
  renderRecentThreadFor(project, excludeSessionId) {
    const store = this.store;
    if (!store) return "";
    const threads = /** @type {any[]} */ (store.listThreads(project.id))
      .filter((/** @type {any} */ thread) => thread.sessionId !== excludeSessionId)
      .map((/** @type {any} */ thread) => ({
        ...thread,
        view: this.views.get(String(thread.sessionId)) ?? null,
        activity: Number(thread.lastActivityAt ? Date.parse(thread.lastActivityAt) : 0) || 0,
      }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.activity - a.activity)
      .slice(0, 3);
    if (threads.length === 0) return "";
    return threads
      .map((/** @type {any} */ thread) => {
        const state = String(thread.view?.state ?? thread.state ?? "idle");
        const title = String(thread.subtitle ?? "").trim() || String(thread.sessionId).slice(0, 12);
        const branch =
          typeof thread.branch === "string" && thread.branch !== "" ? ` · ${thread.branch}` : "";
        const pr = Number.isInteger(Number(thread.prNumber))
          ? ` · PR #${Number(thread.prNumber)}`
          : "";
        return `- ${title} (state=${state}${branch}${pr})`;
      })
      .join("\n");
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
    // F52：协调器会话同样套用项目档位（句柄拿不到就标 pending，等 agent/created 或「应用」按钮补）
    if (typeof project.preset === "string" && project.preset !== "") {
      try {
        await this.applyPresetToSession(projectId, sessionId, "coordinator");
      } catch (error) {
        store.appendAudit({
          action: "preset/pending",
          projectId,
          sessionId,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
        });
        store.save();
      }
    }
    // F42：协调器会话也要套用项目级默认模型 / effort（空串 = 继承宿主默认）。
    // 少了这一步，宿主默认模型若是严格校验的供应商，协调者一开会话就 400
    // （真机：deepseek-official 拒绝 REA MCP 的 pattern 里孤立代理项转义）。
    // 协调者用**自己的**默认模型（与线程分开），没设就继承宿主默认。
    const coordinatorDefaults = project.coordinatorDefaults ?? { provider: "", model: "" };
    if (
      String(coordinatorDefaults.provider ?? "") !== "" &&
      String(coordinatorDefaults.model ?? "") !== ""
    ) {
      try {
        // 直接调宿主 selectModel：协调者不是「线程」，走 selectThreadModel 会找不到线程记录
        // （真机审计原文：projects: unknown thread session-…）。
        await sc.selectModel(
          selectModelParams(
            sessionId,
            coordinatorDefaults.provider,
            coordinatorDefaults.model,
            coordinatorDefaults.reasoningEffort || "",
          ),
          new AbortController().signal,
        );
        store.appendAudit({
          action: "coordinator/model-default",
          projectId,
          sessionId,
          provider: coordinatorDefaults.provider,
          model: coordinatorDefaults.model,
        });
        store.save();
      } catch (error) {
        store.appendAudit({
          action: "coordinator/model-default-failed",
          projectId,
          sessionId,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 120),
        });
        store.save();
      }
    }
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
        // F10：协调者上下文 = 最近消息（report）+ 最近线程（recentThread）+ 记忆索引（memoryIndex）
        memoryIndex: this.renderMemoryIndexFor(project),
        recentThread: this.renderRecentThreadFor(project, sessionId),
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
   * 一次线程的 diff 摘要（P0-3）。
   * 口径：`git diff --numstat <baseSha>`——**故意不带 `..HEAD`**，让工作区里还没提交的
   * 改动也算「这一线程改了什么」；只算提交的话，线程刚写完文件面板上仍是 n/a（冒烟亲测）。
   * 找不到 worktree / git 失败一律返回 null（UI 显示 n/a，不编 0）。
   * 带 5s 缓存：progress 每 5s 轮询一次，不缓存的话每行每 5s spawn 一次 git。
   * @param {any} thread
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{files: number, added: number, removed: number}|null>}
   */
  async diffOfThread(thread, options) {
    const sessionId = String(thread?.sessionId ?? "");
    const worktree = typeof thread?.worktree === "string" ? thread.worktree : "";
    if (worktree === "") return null;
    const base = String(thread?.baseSha ?? "");
    const key = `${worktree}|${base}`;
    const now = Date.now();
    const cached = this.diffCache.get(sessionId);
    // TTL 与 5s 轮询错开：原来 5000 恰好等于轮询间隔，实测 63% miss、缓存等于没有；
    // 但也不能太长（15s 会让刚改的文件等一轮轮询才现），取 8s。
    if (options?.force !== true && cached && cached.key === key && now - cached.at < 8000) {
      return cached.diff;
    }
    let diff = null;
    try {
      const numstat = await runGit(["diff", "--numstat", base === "" ? "HEAD~1" : base], worktree);
      if (numstat.code === 0) diff = parseNumstat(numstat.stdout);
    } catch {
      diff = null; // git 不可用/目录没了：如实 n/a
    }
    this.diffCache.set(sessionId, { key, at: now, diff });
    return diff;
  }

  /**
   * 给一批线程算 diff 摘要（并行；单行失败不影响其它行）。
   * @param {any[]} threads
   * @returns {Promise<Map<string, any>>}
   */
  async diffSummaries(threads) {
    /** @type {Map<string, any>} */
    const diffs = new Map();
    // 只算最近 N 条有 worktree 的线程，且并发度上限 4：
    // 以前对每条线程 Promise.all 直接 spawn git，200 线程 = 200 个并发子进程。
    const targets = selectDiffTargets(threads, 24);
    const queue = [...targets];
    const workerCount = Math.min(4, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const thread = queue.shift();
          const sessionId = String(thread?.sessionId ?? "");
          try {
            diffs.set(sessionId, await this.diffOfThread(thread));
          } catch {
            diffs.set(sessionId, null);
          }
        }
      }),
    );
    return diffs;
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

    // P0-3：diff 与 progress 行摘要共用同一条路径（含工作区未提交改动），
    // 否则详情页和行摘要会对同一个线程给出两个不同的「改了多少」。
    const diff = await this.diffOfThread(thread, { force: true });

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
    /** @type {{ code: number, stdout: string, stderr: string } | null} */
    let pushedHttps = null;
    if (worktree !== "") {
      const pushed = await runGit(["push", "-u", "origin", String(thread.branch)], worktree);
      // 兜底：宿主进程里 `git push origin` 可能拿不到 osxkeychain/SSH 凭据（真机踩到——
      // 同一命令在用户 shell 里成功、在宿主里失败）。gh CLI 在宿主环境里可用（GH_TOKEN），
      // 所以用它的 credential helper 走 https 再推一次；两条都失败才如实报 push-failed。
      if (pushed.code !== 0) {
        const repoUrl = await runGh(["repo", "view", "--json", "url", "--jq", ".url"], worktree);
        const httpsUrl = String(repoUrl.stdout ?? "").trim();
        if (repoUrl.code === 0 && httpsUrl !== "") {
          const plannedPush = planHttpsPush({ url: httpsUrl, branch: String(thread.branch) });
          if (!("error" in plannedPush)) {
            pushedHttps = await runGit(plannedPush.argv, worktree);
          }
        }
      }
      if (pushed.code !== 0 && (pushedHttps === null || pushedHttps.code !== 0)) {
        store.appendAudit({
          action: "pr/failed",
          projectId,
          sessionId,
          reason: "push-failed",
          // 把 stderr 首行带上：没有它只能看到 "push-failed"，排查全靠猜（本轮真机踩到）
          detail: [
            `ssh/cred: ${String(pushed.stderr ?? "").split("\n")[0]}`,
            `https+gh: ${String(pushedHttps?.stderr ?? "").split("\n")[0]}`,
          ]
            .join(" | ")
            .slice(0, 300),
        });
        store.save();
        return { opened: false, decision, reason: "push-failed" };
      }
    }

    if (pushedHttps !== null && pushedHttps.code === 0) {
      store.appendAudit({ action: "pr/push-fallback", projectId, sessionId, via: "gh-credential" });
      store.save();
    }
    const gh = await runGh(planned.argv, worktree !== "" ? worktree : repoRoot || undefined);
    const prNumber = gh.code === 0 ? parsePrNumber(gh.stdout) : null;
    if (gh.code !== 0 || prNumber === null) {
      const tryCount = Number(thread.prAttempts ?? 0) + 1;
      // 以前只把 tryCount 写进审计、从不落盘 → nextPrAction 的 give-up 上限永远不触发
      store.setThreadWorktree(sessionId, { prAttempts: tryCount });
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
    // 记下 PR 号：合并成功时据此把线程标成"已合并"，回收判据才敢放行（squash 无法用祖先关系证明）
    store.setThreadWorktree(sessionId, { prNumber });
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
   * 组装一行 Overview 数据（F25/F26/F27）。
   * 六态 = 宿主实时事实（archived/pendingInput/running）+ 事件归约 + 持久记录；
   * 步进 = todo/write 快照（没有就是 null，UI 显示「—」）；副标题 = 最近 tool/call（没有留空）。
   * @param {any} thread
   * @param {{ states: Map<string, any>, summaries: Map<string, any> }} facts
   * @param {Set<string>} archivedIds
   * @param {number} now
   * @returns {any}
   */
  /**
   * M6：失败自动重试（诚实语义：失败结束后重发「继续」，最多 2 次，60 秒后执行）。
   * 具体定时/单例/重查/上限由 lib `createAutoRetryScheduler` 负责（有单测）。
   * @param {string} _projectId @param {string} sessionId
   */
  /**
   * 后台扫描：对「当前视图判定为 failed 且重试未超限」的线程挂重试定时器。
   * 调度器内部会再单例/重查/限次，所以这里重复调用是安全的。
   */
  scanAutoRetry() {
    const store = this.store;
    if (!store) return;
    for (const project of store.listProjects()) {
      if (project.state !== "active") continue;
      if (project.policy?.autoRetry !== true) continue;
      for (const thread of store.listThreads(project.id)) {
        const sessionId = String(thread?.sessionId ?? "");
        if (sessionId === "") continue;
        if (Number(thread?.autoRetryCount ?? 0) >= 2) continue;
        const view = mergeRecord(this.views.get(sessionId), thread);
        const state = deriveState(view);
        if (state !== "failed") continue;
        // 新鲜度窗口：只对「最近 15 分钟内失败」的线程重试。
        // 否则冷启动会把几天前的陈旧失败也自动「继续」，白烧 token。
        const lastActivity = Number(view.lastActivityAt ?? 0);
        if (lastActivity > 0 && Date.now() - lastActivity > 15 * 60_000) continue;
        this.autoRetryScheduler.schedule(sessionId);
      }
    }
  }

  /**
   * 给某个线程挂失败自动重试（调度器负责单例/重查/上限）。
   * @param {string} _projectId @param {string} sessionId
   */
  scheduleAutoRetry(_projectId, sessionId) {
    this.autoRetryScheduler.schedule(String(sessionId));
  }

  /**
   * 组装一行 Overview 数据（F25/F26/F27）。
   * @param {any} thread
   * @param {{ states: Map<string, any>, summaries: Map<string, any> }} facts
   * @param {Set<string>} archivedIds
   * @param {number} now
   * @param {any} [diff]
   * @returns {any}
   */
  buildThreadRow(thread, facts, archivedIds, now, diff = null) {
    const sessionId = String(thread.sessionId);
    const live = facts.states.get(sessionId);
    const summary = facts.summaries.get(sessionId);
    const view = mergeRecord(this.views.get(sessionId), thread);
    const pendingInput = Array.isArray(live?.pendingInput) ? live.pendingInput.map(String) : [];
    const running =
      resolveLiveRunning(view, live?.running) || (live === undefined && view.state === "working");
    const hostArchived = archivedIds.has(sessionId);
    // 宿主侧 unarchive 之后记录里可能还留着 archived：以宿主为准（archive 可逆）
    const record =
      !hostArchived && thread.state === "archived" ? { ...thread, state: "idle" } : thread;
    const state = hostArchived ? "archived" : settleState({ view, record, running, pendingInput });
    const stats = this.stats.get(sessionId) ?? initialStats();
    const persistedTodos = thread.todos && Number(thread.todos.total) > 0 ? thread.todos : null;
    const todos = view.todos.total > 0 ? view.todos : persistedTodos;
    const steps =
      todos && Number(todos.total) > 0
        ? {
            done: Math.min(Number(todos.done) || 0, Number(todos.total)),
            total: Number(todos.total),
          }
        : null;
    // `~Nm` 是**估计**（已观测每步耗时 × 剩余步数），样本不足时 null（UI 不显示）
    const estimateMs = estimateRemainingMs({
      todos: steps,
      steps: stats.steps,
      firstActivityAt: view.firstActivityAt,
      lastActivityAt: view.lastActivityAt,
    });
    const createdAtMs = Date.parse(String(thread.createdAt ?? ""));
    const resolvedAtMs = Date.parse(String(thread.resolvedAt ?? ""));
    const durationMs = Number.isFinite(createdAtMs)
      ? Math.max(0, (Number.isFinite(resolvedAtMs) ? resolvedAtMs : now) - createdAtMs)
      : null;
    return {
      sessionId,
      branch: thread.branch ?? null,
      worktree: thread.worktree ?? null,
      dir: thread.dir ?? null,
      // 有没有独立 worktree 决定"隔不隔离"，界面要能如实显示（走查发现用户看不出来）
      isolated: typeof thread.worktree === "string" && thread.worktree !== "",
      // 会话标题：优先人工重命名（F23 写回 thread.title），其次用户建线程时写的任务
      // （宿主 title 投影可能只是首个工具名，如 glob/bash），最后才用投影标题；
      // 都没有就留空，由 UI 退化显示分支/短 id
      title: String(thread.title || thread.task || summary?.projections?.values?.title || ""),
      // 原始任务单独给 UI：展开面板要能回看"我当初让它做什么"
      task: String(thread.task || ""),
      view: { ...view, state, pendingInput },
      stats: { ...stats, commands: stats.commands.slice(-3) },
      // P0-3：行摘要里的 diff 来自真实 git numstat（以前这里只传 stats，文案恒 `diff n/a`）
      diff: diff ?? null,
      summary: summarizeForRow({ stats, diff }),
      subtitle: view.subtitle || thread.subtitle || "",
      // M3：当前工具名（working 才有；重启后客户端显示 `✓✓✓ Using X`）
      currentTool: deriveToolState({
        state,
        tool: this.currentTools.get(sessionId) ?? "",
      }).tool,
      // M2.1：副标题语义（client 按 kind 取 i18n 文案；这里只给"哪一类信息"）
      ...(() => {
        const sub = deriveSubtitle({
          state,
          pendingInput,
          subtitle: view.subtitle || thread.subtitle || "",
        });
        return { subtitleKind: sub.kind, subtitleDetail: sub.detail };
      })(),
      steps,
      estimateMs,
      // 未读：等你（pendingInput 权威）或用户手动标记；两者都不是就没有圆点
      unread: pendingInput.length > 0 || thread.unread === true,
      manualUnread: thread.unread === true,
      resolvedAt: thread.resolvedAt ?? null,
      prNumber: Number.isFinite(thread.prNumber) ? Number(thread.prNumber) : null,
      // F21/U16：CI 状态（轮询写回；没有就是 null，UI 不编颜色）
      ciState: typeof thread.ciState === "string" ? thread.ciState : null,
      headRefOid: typeof thread.headRefOid === "string" ? thread.headRefOid : null,
      // F17：Tasks 逐项（todo/write 的整表快照），行内可展开看图
      tasks: Array.isArray(view.todoItems) ? view.todoItems : [],
      durationMs,
      createdAt: thread.createdAt ?? null,
      pendingInput,
    };
  }

  /**
   * 把行里的可持久事实写回记录（只写变化；返回是否脏）。
   * @param {any} thread @param {any} row
   */
  persistRowFacts(thread, row) {
    const store = this.store;
    if (!store) return false;
    const sessionId = String(thread.sessionId);
    let dirty = false;
    if (
      row.steps &&
      (!thread.todos ||
        thread.todos.total !== row.steps.total ||
        thread.todos.done !== row.steps.done)
    ) {
      store.setThreadTodos(sessionId, row.steps);
      dirty = true;
    }
    if (row.subtitle !== "" && row.subtitle !== thread.subtitle) {
      store.setThreadSubtitle(sessionId, row.subtitle);
      dirty = true;
    }
    if (row.view.lastActivityAt > 0) {
      const iso = new Date(row.view.lastActivityAt).toISOString();
      if (thread.lastActivityAt !== iso) {
        store.setThreadActivity(sessionId, row.view.lastActivityAt);
        dirty = true;
      }
    }
    const written = store.setThreadState(sessionId, row.view.state);
    if (written.changed) dirty = true;
    return dirty;
  }

  /**
   * 线程进度（面板用）：六态由宿主实时事实 + 持久事件共同结算，按「需要我」优先排序；
   * 同时给出分组（F25）与药丸条计数（F26）。异步：要读宿主 `state()/list()`，
   * 两者任一不可用都退回事件推导（降级，不报错）。
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  /**
   * 轻量线程状态（给全局通知轮询用）：只回 sessionId + 六态 + 项目通知开关，
   * 不做 git / 不读文件 / 不组装行。全局 notifier 以前每 5s 对每个活跃项目调 `progress()`，
   * 每条 isolated 线程 spawn 一次 git；有 N 个项目时就是 N 倍进程风暴。
   * @returns {Promise<Array<{ projectId: string, notifyPrefs: any, rows: Array<{ sessionId: string, state: string }> }>>}
   */
  async threadStates() {
    const store = this.requireStore();
    /** @type {any[]} */
    const out = [];
    for (const project of store.listProjects()) {
      // 暂停项目里仍可能有在跑/等你的线程：通知器不能整段跳过（审查实测）
      if (project.state === "archived") continue;
      const threads = store.listThreads(project.id);
      const ids = threads
        .map((/** @type {any} */ thread) => String(thread.sessionId ?? ""))
        .filter(Boolean);
      // 与 progress 用同一个权威源：宿主 pendingInput 决定「等你」，只有事件推导会漏报
      const live = await this.liveSessionFacts(false, ids);
      /** @type {any[]} */
      const rows = [];
      for (const thread of threads) {
        const sessionId = String(thread?.sessionId ?? "");
        if (sessionId === "") continue;
        const liveState = live.states.get(sessionId);
        const pending = Array.isArray(liveState?.pendingInput) ? liveState.pendingInput.length : 0;
        const view = mergeRecord(this.views.get(sessionId), thread);
        const state = deriveState({
          ...view,
          awaitingUser: pending > 0 ? true : view.awaitingUser,
        });
        rows.push({ sessionId, state });
      }
      out.push({ projectId: project.id, notifyPrefs: project.notifyPrefs ?? {}, rows });
    }
    return out;
  }

  /**
   * 这条线程现在是否"在跑/等你"（要保护工作目录与分支，不许回收/归档清理）。
   * @param {any} thread
   * @param {Map<string, any>} states liveSessionFacts 的 states
   * @returns {boolean}
   */
  threadBusy(thread, states) {
    const live = states?.get?.(String(thread?.sessionId ?? ""));
    const pending = Array.isArray(live?.pendingInput) ? live.pendingInput.length : 0;
    const view = mergeRecord(this.views.get(String(thread?.sessionId ?? "")), thread);
    const state = deriveState({ ...view, awaitingUser: pending > 0 ? true : view.awaitingUser });
    return state === "working" || state === "waiting-user" || pending > 0;
  }

  /**
   * 同一项目并发 progress 合并：全局 notifier（每 5s）和详情页（每 5s）会同时打进来，
   * 不合并就会 2× 计算、2× spawn git。
   * @param {string} [projectId]
   * @returns {Promise<any>}
   */
  async progress(projectId) {
    const key = String(projectId ?? "");
    const existing = this.progressInFlight.get(key);
    if (existing) return existing;
    const task = this.progressUncoalesced(key).finally(() => {
      this.progressInFlight.delete(key);
    });
    this.progressInFlight.set(key, task);
    return task;
  }

  /**
   * @param {string} key
   * @returns {Promise<any>}
   */
  async progressUncoalesced(key) {
    const projectId = key;
    const store = this.requireStore();
    const threads = store.listThreads(projectId);
    // 只问本项目的线程：此前对全库线程逐个 state()，多项目/大项目时是 O(全库) 宿主调用
    const facts = await this.liveSessionFacts(
      false,
      threads.map((/** @type {any} */ thread) => String(thread.sessionId ?? "")).filter(Boolean),
    );
    const archivedIds = new Set(
      Array.isArray(this.workspaceRegistry?.archivedSessionIds)
        ? this.workspaceRegistry.archivedSessionIds.map(String)
        : [],
    );
    const now = Date.now();
    // P0-3：先把每行 worktree 的 diff 摘要算好（带缓存），再组装行；
    // 否则行摘要里 `diff n/a` 恒真，用户永远看不到「这一线程改了什么」。
    const diffs = await this.diffSummaries(threads);
    const autoRetryEnabled = store.getProject(projectId)?.policy?.autoRetry === true;
    let dirty = false;
    const rows = threads.map((/** @type {any} */ thread) => {
      const row = this.buildThreadRow(
        thread,
        facts,
        archivedIds,
        now,
        diffs.get(String(thread.sessionId)) ?? null,
      );
      // F34：线程行内嵌产物卡需要 `row.artifacts`——以前客户端有这个分支但服务端从不喂数据，
      // 于是产物卡永远不渲染（真机走查发现）。按 source.sessionId 归属，最多 5 条。
      try {
        const sid = String(thread.sessionId ?? "");
        row.artifacts = store
          .listArtifactRefs(projectId)
          .filter((/** @type {any} */ ref) => String(ref?.source?.sessionId ?? "") === sid)
          .slice(0, 5)
          .map((/** @type {any} */ ref) => ({
            id: ref.id,
            title: ref.title,
            kind: ref.kind,
            version: ref.version,
            bytes: ref.bytes,
            at: ref.at,
            updatedAt: ref.at,
            // 行内缩略图要用它（之前只喂给 Library，行里的缩略卡因此没有封面）
            coverUrl: typeof ref.coverUrl === "string" ? ref.coverUrl : "",
          }));
      } catch {
        row.artifacts = [];
      }
      try {
        if (this.persistRowFacts(thread, row)) dirty = true;
        // M6：失败自动重试（仅在「刚变成失败」时排一次；上限 2 次）
        const retryDecision = shouldAutoRetry({
          enabled: autoRetryEnabled,
          state: String(row.view?.state ?? ""),
          previousState: String(thread.state ?? ""),
          attempts: Number(thread.autoRetryCount ?? 0),
        });
        if (retryDecision.retry) this.scheduleAutoRetry(projectId, String(thread.sessionId));
        // 注意：**不**在非失败时清零。以前一旦观测到 idle 就归零，导致
        // failed→idle→failed 每轮都算「第一次失败」，可以每 60s 无限重试，
        // 「最多 2 次」根本不成立。现在计数是线程生命周期内累计的。
      } catch (error) {
        this.logger?.warn?.(
          `[projects] row state persist failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        );
      }
      return row;
    });
    if (dirty) store.save();
    const sorted = sortRows(rows);
    const counts = pillCounts(rows);
    const project = store.getProject(projectId);
    const budget = checkThreadBudget({ project, threads, now: Date.now() });
    return {
      rows: sorted,
      counts,
      groups: groupRows(sorted),
      pills: counts,
      total: rows.length,
      attention: (counts["waiting-user"] ?? 0) + (counts.failed ?? 0),
      budget: {
        ok: budget.ok,
        reason: budget.reason,
        used: budget.used,
        limits: project?.budget ?? null,
        tokensToday: store.tokenUsageToday(projectId, Date.now()),
      },
      usageDays: this.usageDays(projectId),
      projectState: project?.state ?? "active",
      // 自定义视图（面板「+ 新增视图」保存的筛选条件）
      views: Array.isArray(project?.views) ? project.views : [],
      // 默认模型两套（客户端药丸的回读源；不必再单独 getProject）
      threadDefaults: project?.threadDefaults ?? null,
      coordinatorDefaults: project?.coordinatorDefaults ?? null,
      visibleViews: Array.isArray(project?.visibleViews) ? project.visibleViews : null,
    };
  }

  /**
   * 最近 7 天 token 用量（F28/U10 的迷你图）。宿主没有用量 API，这是我们自己按天记的分桶；
   * 没跑过模型的日期是 0（真实值，不是缺数据）。
   * @param {string} projectId
   * @returns {{ date: string, tokens: number }[]}
   */
  usageDays(projectId) {
    const store = this.store;
    const bucket = store?.state?.usage?.[projectId];
    const days = bucket && typeof bucket.days === "object" ? bucket.days : {};
    /** @type {{ date: string, tokens: number }[]} */
    const out = [];
    const now = Date.now();
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      out.push({ date, tokens: Number(days[date]) || 0 });
    }
    return out;
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
      lastSaveError: this.store?.lastSaveError ?? "",
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
          // 成功也要留痕：面板建线程不写审计的话，"可审计"就只是句口号（走查发现）
          store.appendAudit({
            action: "thread/created",
            projectId,
            sessionId: String(created.sessionId),
            isolated: created.isolated === true,
            task: String(task ?? "").slice(0, 120),
          });
          store.save();
          return { sessionId: String(created.sessionId) };
        },
      },
    });
    // 行标题优先展示用户写的任务：宿主投影标题可能是首个工具名（真机审查抓到的 P1）
    store.setThreadTask(thread.sessionId, String(task ?? ""));
    store.save();
    // F52：新线程会话套用项目权限档位（默认 null = 继承宿主，什么都不做）
    if (typeof project.preset === "string" && project.preset !== "") {
      try {
        await this.applyPresetToSession(projectId, thread.sessionId, "thread");
      } catch (error) {
        store.appendAudit({
          action: "preset/pending",
          projectId,
          sessionId: thread.sessionId,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
        });
        store.save();
      }
    }
    // F42：新线程套用项目级默认模型 / effort（空串 = 继承宿主默认，不强行 selectModel）
    const defaults = project.threadDefaults ?? { provider: "", model: "" };
    if (String(defaults.provider ?? "") !== "" && String(defaults.model ?? "") !== "") {
      try {
        await this.selectThreadModel(projectId, thread.sessionId, {
          provider: defaults.provider,
          model: defaults.model,
          reasoningEffort: defaults.reasoningEffort || undefined,
        });
      } catch (error) {
        store.appendAudit({
          action: "thread/model-default-failed",
          projectId,
          sessionId: thread.sessionId,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 120),
        });
        store.save();
      }
    }
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
      } catch (error) {
        // 线程建成功、任务从没送达：以前完全静默，用户看到一条永远 idle 的线程
        const reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 160);
        store.appendAudit({
          action: "thread/prompt-failed",
          projectId,
          sessionId: thread.sessionId,
          reason,
        });
        store.save();
        /** @type {any} */ (thread).promptFailed = true;
        thread.warning = `prompt-failed: ${reason}`;
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
    const id = String(sessionId ?? "");
    const thread = store.state?.threads?.[id];
    if (thread) {
      const live = await this.liveSessionFacts(false, [id]);
      if (this.threadBusy(thread, live.states)) {
        return { reclaimed: false, reason: "thread-busy" };
      }
    }
    const result = await reclaimThreadWorktree({ store, sessionId: id, deps: { runGit } });
    store.save();
    return result;
  }

  /** @param {string} sessionId */
  detachThread(sessionId) {
    const store = this.requireStore();
    const id = String(sessionId ?? "");
    const project = store.projectOfSession(id);
    const record = store.state?.threads?.[id] ?? null;
    // 记录删掉后 worktree 目录与 dsh/ 分支仍在磁盘：必须如实告诉调用方，别让它们变孤儿
    const orphaned = {
      worktree: String(record?.worktree ?? ""),
      branch: String(record?.branch ?? ""),
    };
    const removed = store.detachThread(id);
    if (removed) {
      store.appendAudit({
        action: "thread/detached",
        ...(project?.id ? { projectId: project.id } : {}),
        sessionId: id,
        ...(orphaned.worktree !== "" ? { worktree: orphaned.worktree } : {}),
        ...(orphaned.branch !== "" ? { branch: orphaned.branch } : {}),
      });
    }
    store.save();
    return { detached: removed === true, ...orphaned };
  }

  // ================= B2：把桩接通（协调器 / 审批 / PR / thread 体验） =================

  /**
   * 记一条协调器发言（F11）。上限 COORDINATOR_MESSAGE_CAP 条，按时间顺序。
   * @param {string} projectId @param {"assistant"|"user"} role @param {string} text
   */
  recordCoordinatorMessage(projectId, role, text) {
    const cap = COORDINATOR_MESSAGE_CAP;
    const list = this.coordinatorMessages.get(projectId) ?? [];
    const at = Date.now();
    // P2 复审：乐观写 + 宿主 user/message 事件双写会重复，按「同角色同文本 + 时间窗」去重
    if (
      shouldRecordCoordinatorMessage(
        list,
        role === "assistant" ? "assistant" : "user",
        text,
        at,
      ) !== true
    ) {
      return false;
    }
    list.push({ role, text: String(text).slice(0, 4000), at });
    while (list.length > cap) list.shift();
    this.coordinatorMessages.set(projectId, list);
    return true;
  }

  /**
   * F9 + F11：给协调器发一句话，并把「它现在在哪、有没有新建会话」回读给面板。
   * 不用裸 `approval.request`；投递走 `sessionController.prompt`（探针写验证过）。
   * @param {string} projectId
   * @param {string} text
   */
  async sendToCoordinator(projectId, text) {
    await this.waitServices();
    return sendToCoordinatorCore({
      store: this.requireStore(),
      sessionController: this.sessionController,
      ensureCoordinator: (/** @type {string} */ id) => this.ensureCoordinator(id),
      recordMessage: (
        /** @type {string} */ id,
        /** @type {"user"|"assistant"} */ role,
        /** @type {string} */ body,
      ) => this.recordCoordinatorMessage(id, role, body),
      projectId,
      text,
    });
  }

  /**
   * F11/U4：协调者区的读模型 —— 最近发言（含结论）+ 它引用的线程（chip 数据）。
   * 线程 chip 带 state/branch/prNumber/tasks，让 client 不必再查一遍。
   * @param {string} projectId
   */
  coordinatorView(projectId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const sessionId =
      typeof project.coordinatorSessionId === "string" ? project.coordinatorSessionId : "";
    const messages = (this.coordinatorMessages.get(projectId) ?? []).map((item) => ({
      role: item.role,
      text: item.text,
      at: item.at,
    }));
    const rows = store.listThreads(projectId).map((/** @type {any} */ thread) => {
      const view = mergeRecord(this.views.get(String(thread.sessionId)), thread);
      return {
        sessionId: String(thread.sessionId),
        title: thread.subtitle || `turn ${Number(view.turn ?? 0)}`,
        state: String(view.state ?? "idle"),
        branch: thread.branch ?? null,
        worktree: thread.worktree ?? null,
        prNumber: Number.isInteger(Number(thread.prNumber)) ? Number(thread.prNumber) : null,
        ciState: thread.ciState ?? null,
        tasks: thread.todos ?? null,
      };
    });
    // M6：结论旁边露产物（Claude 的「结论 + 产物 chip」）；取最近 3 条本项目产物
    const artifacts = store
      .listArtifactRefs(project.id)
      .slice(-3)
      .map((/** @type {any} */ ref) => ({
        id: String(ref?.id ?? ""),
        title: String(ref?.title ?? ""),
        kind: String(ref?.kind ?? ""),
        version: Number.isFinite(Number(ref?.version)) ? Number(ref.version) : null,
        bytes: Number.isFinite(Number(ref?.bytes)) ? Number(ref.bytes) : null,
        at: String(ref?.at ?? ""),
        coverUrl: String(ref?.coverUrl ?? ""),
      }))
      .filter((/** @type {any} */ item) => item.id !== "");
    return {
      sessionId,
      available: sessionId !== "",
      messages,
      threads: rows,
      // 结论 = 最后一条 assistant 消息（协调者汇报的"上浮"内容）
      conclusion: [...messages].reverse().find((item) => item.role === "assistant")?.text ?? "",
      // M6：结论旁的产品（只有结论才配产物 chips，过程消息不占位）
      artifacts,
      compaction: this.compactionStatus(),
    };
  }

  /**
   * F10：协调者上下文策略。`compaction` 是**部署相关**服务（live desktop 有，CLI/web profile
   * 可能被 disabled），所以这里一律 `ctx.get()` 判空兜底，绝不假设它存在。
   * @returns {{ available: boolean, mode: string, note: string }}
   */
  compactionStatus() {
    const compaction = this.hostService("compaction");
    if (!compaction) {
      return { available: false, mode: "none", note: "compaction unavailable in this deployment" };
    }
    const mode =
      typeof compaction.mode === "string"
        ? compaction.mode
        : typeof compaction.threshold === "number"
          ? `threshold:${compaction.threshold}`
          : "available";
    return { available: true, mode, note: "" };
  }

  /**
   * F13/F45：Restart —— 丢掉当前协调器会话，重开一个（旧会话不删，留着可追溯）。
   * 为什么是"重开"而不是"重连"：宿主没有云端 worker（R1），会话是本机 session；
   * Restart 的语义就是「换一个新会话继续」，当前那条回复会丢（与 Claude 相同结局）。
   * @param {string} projectId
   */
  async restartCoordinator(projectId) {
    await this.waitServices();
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const previous =
      typeof project.coordinatorSessionId === "string" ? project.coordinatorSessionId : "";
    if (previous !== "") this.detachSession(previous);
    store.updateProject(projectId, { coordinatorSessionId: null });
    this.coordinatorMessages.delete(projectId);
    store.appendAudit({
      action: "coordinator/restart",
      projectId,
      previousSessionId: previous || null,
      result: "detached",
    });
    store.save();
    const created = await this.ensureCoordinator(projectId);
    store.appendAudit({
      action: "coordinator/restarted",
      projectId,
      sessionId: String(created.sessionId),
      previousSessionId: previous || null,
    });
    store.save();
    return {
      restarted: true,
      previousSessionId: previous,
      sessionId: String(created.sessionId),
      created: created.created === true,
    };
  }

  /**
   * F19：线程 steering —— 给运行中的线程插一句话（`mode:'steer'`，探针写验证过）。
   * 线程没在跑时宿主会把 steer 排队；这里如实回读 running 状态，不假装"已经生效"。
   * @param {string} sessionId
   * @param {string} text
   */
  async steerThread(sessionId, text) {
    await this.waitServices();
    return steerThreadCore({
      store: this.requireStore(),
      sessionController: this.sessionController,
      sessionId,
      text,
    });
  }

  /**
   * F24/F42：宿主模型目录（分组 + 每个模型的 effort）。`ctx.get()` 判空，缺了就明说。
   * @returns {Promise<{ available: boolean, groups: any[], reason: string }>}
   */
  async modelCatalog() {
    await this.waitServices();
    const sc = this.sessionController;
    if (!sc || typeof sc.modelCatalog !== "function") {
      return { available: false, groups: [], reason: "session-controller-unavailable" };
    }
    try {
      const value = await sc.modelCatalog(new AbortController().signal);
      const groups = Array.isArray(value)
        ? value
        : Array.isArray(value?.groups)
          ? value.groups
          : [];
      return { available: true, groups, reason: "" };
    } catch (error) {
      return {
        available: false,
        groups: [],
        reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
      };
    }
  }

  /**
   * F24：给一个线程换模型 / effort（转 `session/selectModel`），**回读** `modelSelection`。
   * @param {string} projectId
   * @param {string} sessionId
   * @param {{ provider?: string, model?: string, reasoningEffort?: string }} input
   */
  async selectThreadModel(projectId, sessionId, input) {
    await this.waitServices();
    return selectThreadModelCore({
      store: this.requireStore(),
      sessionController: this.sessionController,
      projectId,
      sessionId,
      input,
    });
  }

  /**
   * F12/F20：Create PR 的按钮入口 —— 走既有 `openPr`，并回读线程的 PR/分支状态。
   * 与 `openPr` 的区别只在语义：这里给面板一个"用户点了 Create PR"的窄接口，
   * 档位由项目策略决定（默认 draft），不在 UI 里偷偷升级到 auto-merge。
   * @param {string} projectId
   * @param {string} sessionId
   * @param {{ tier?: string, base?: string, repo?: string }} [options]
   */
  async createPr(projectId, sessionId, options) {
    return createPrCore({
      store: this.requireStore(),
      openPr: (/** @type {string} */ id, /** @type {string} */ sid, /** @type {any} */ opts) =>
        this.openPr(id, sid, opts),
      projectId,
      sessionId,
      options,
    });
  }

  /**
   * F21：轮询一轮所有项目的开放 PR（`gh pr list --json …`）。
   * 默认档：只对有开放 PR 的项目、30–90s 退避、连续失败退避、应用关闭即停。
   */
  async pollPrs() {
    if (this.prPoll.inFlight) return { skipped: true, reason: "in-flight", projects: [] };
    this.prPoll.inFlight = true;
    try {
      const store = this.requireStore();
      /** @type {Array<{ projectId: string, name: string, polled: boolean, reason: string, openPrs: number, rows: any[], patches: number }>} */
      const projects = [];
      for (const project of store.listProjects()) {
        if (project.state !== "active") continue;
        const threads = store.listThreads(project.id);
        const verdict = shouldPollProject({
          prTier: project.policy?.pr?.tier ?? "draft",
          threads,
        });
        if (!verdict.poll) {
          projects.push({
            projectId: project.id,
            name: project.name,
            polled: false,
            reason: verdict.reason,
            openPrs: verdict.openPrs,
            rows: [],
            patches: 0,
          });
          continue;
        }
        const repoRoot = pickPollRoot({ threads, dirs: project.dirs });
        if (repoRoot === "") {
          projects.push({
            projectId: project.id,
            name: project.name,
            polled: false,
            reason: "no-dir",
            openPrs: verdict.openPrs,
            rows: [],
            patches: 0,
          });
          continue;
        }
        const gh = await runGh(["pr", "list", "--json", PR_LIST_FIELDS, "--limit", "30"], repoRoot);
        const parsed =
          gh.code === 0 ? parsePrList(gh.stdout) : { ok: false, rows: [], reason: "gh-failed" };
        if (!parsed.ok) {
          if (this.prPoll.lastFailure !== parsed.reason) {
            store.appendAudit({
              action: "pr/poll-failed",
              projectId: project.id,
              reason: parsed.reason,
            });
            this.prPoll.lastFailure = parsed.reason;
            store.save();
          }
          projects.push({
            projectId: project.id,
            name: project.name,
            polled: false,
            reason: parsed.reason,
            openPrs: verdict.openPrs,
            rows: [],
            patches: 0,
          });
          continue;
        }
        const patches = planThreadPatches({ threads }, parsed.rows);
        for (const patch of patches) {
          try {
            store.setThreadCi(patch.sessionId, patch);
          } catch {
            /* 线程可能在轮询期间被移除 */
          }
        }
        if (patches.length > 0) {
          store.appendAudit({
            action: "pr/polled",
            projectId: project.id,
            openPrs: verdict.openPrs,
            changed: patches.length,
          });
          store.save();
        }
        projects.push({
          projectId: project.id,
          name: project.name,
          polled: true,
          reason: "",
          openPrs: verdict.openPrs,
          rows: parsed.rows,
          patches: patches.length,
        });
      }
      const anyPolled = projects.some((item) => item.polled);
      this.prPoll.failures = anyPolled ? 0 : this.prPoll.failures + 1;
      this.prPoll.lastAt = Date.now();
      const result = {
        at: this.prPoll.lastAt,
        projects,
        nextDelayMs: nextPollDelay({ failures: this.prPoll.failures }),
      };
      this.prPoll.lastResult = result;
      if (anyPolled) this.prPoll.lastFailure = "";
      // 不在这里无条件 store.save()：每 30–90s 全量重写且挤审计，改动已在 patron 分支里落盘
      return result;
    } finally {
      this.prPoll.inFlight = false;
    }
  }

  /**
   * F21：PR 轮询的状态回读（设置页/冒烟用）。
   * @returns {{ running: boolean, lastAt: number, failures: number, nextDelayMs: number, projects: number }}
   */
  prPollState() {
    const store = this.store;
    let projects = 0;
    try {
      projects = store ? store.listProjects().length : 0;
    } catch {
      projects = 0;
    }
    return {
      running: this.prPoll.running === true,
      lastAt: this.prPoll.lastAt,
      failures: this.prPoll.failures,
      nextDelayMs: nextPollDelay({ failures: this.prPoll.failures }),
      projects,
    };
  }

  /**
   * F21：起/停轮询定时器（幂等）。由宿主 `start()` 与设置开关驱动；dispose 时清掉。
   * @param {boolean} [enabled]
   */
  setPrPolling(enabled) {
    const on = enabled !== false;
    if (this.prPoll.timer !== null) {
      clearTimeout(this.prPoll.timer);
      this.prPoll.timer = null;
    }
    this.prPoll.running = on;
    if (!on) return this.prPollState();
    const tick = async () => {
      if (!this.prPoll.running) return;
      try {
        await this.pollPrs();
      } catch (error) {
        this.prPoll.failures += 1;
        this.logger?.warn?.(
          `[projects] pr poll failed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        );
      }
      if (!this.prPoll.running) return;
      const delay = nextPollDelay({ failures: this.prPoll.failures });
      this.prPoll.timer = setTimeout(() => void tick(), delay);
      if (typeof this.prPoll.timer?.unref === "function") this.prPoll.timer.unref();
    };
    this.prPoll.timer = setTimeout(() => void tick(), nextPollDelay({ failures: 0 }));
    if (typeof this.prPoll.timer?.unref === "function") this.prPoll.timer.unref();
    return this.prPollState();
  }

  /**
   * F21：实验性实时监听的规格（前置条件 + 警示），面板照抄，不自己编文案。
   * @returns {{ key: string, requires: string[], warning: string }}
   */
  realtimeCiSpec() {
    return realtimeCiSpec();
  }

  /**
   * F21：实验性实时监听开关。**未实现**（B2 复审 P1）：不接受写入、不启动任何子进程，
   * 只回读现状 + 说明（README/UI 同步改成 disabled，不再宣称"会建临时 webhook"）。
   * @param {boolean} enabled
   */
  async setRealtimeCi(enabled) {
    const spec = realtimeCiSpec();
    const store = this.store;
    if (store) {
      store.appendAudit({
        action: "realtime-ci/refused",
        projectId: null,
        requested: enabled === true,
        reason: "not-implemented",
      });
      store.save();
    }
    return {
      available: false,
      implemented: false,
      realtimeCi: false,
      requested: enabled === true,
      reason: "not-implemented",
      spec,
    };
  }
  // —— B3：记忆碎片 / 预算 / 授权 / GitHub / 模板 / 用量 / 提及 / 重命名 ——

  /**
   * F37：新增一条记忆碎片（独立 .md + MEMORY.md 索引行）。
   * 索引行与正文分开：MEMORY.md 始终短，正文按需读取。
   * @param {string} projectId @param {string} [title] @param {string} [text]
   */
  addMemoryFragment(projectId, title, text) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const result = addFragment(this.dataRoot, projectId, title, text);
    if (result.ok !== true) {
      store.appendAudit({ action: "memory/fragment-rejected", projectId, reason: result.reason });
      store.save();
      return result;
    }
    store.appendAudit({
      action: "memory/fragment-added",
      projectId,
      slug: result.slug,
      chars: result.chars,
    });
    store.save();
    return result;
  }

  /**
   * F37：列出记忆碎片（标题从索引行取，读不到标题就用 slug）。
   *
   * 复审 P2：必须**先校验项目存在**再碰文件系统——`projectId` 直接拼进
   * `<dataRoot>/<projectId>/memory/fragments/`，不校验就能用 `../` 枚举 dataRoot 外的目录名。
   * @param {string} projectId
   */
  listMemoryFragments(projectId) {
    const store = this.requireStore();
    const id = String(projectId ?? "");
    if (!store.getProject(id)) throw new Error(`projects: unknown project ${id}`);
    return listFragments(this.dataRoot, id);
  }

  /**
   * F37：读一个碎片全文（UI 预览用）。
   * @param {string} projectId @param {string} slug
   */
  readMemoryFragment(projectId, slug) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    return readFragment(this.dataRoot, projectId, slug);
  }

  /**
   * F37：忘掉一条记忆。
   * kind=fragment：删碎片文件 + 索引行；kind=entry：只删索引里那一条（稳定 id）。
   * @param {string} projectId @param {string} kind @param {string} id
   */
  forgetMemory(projectId, kind, id) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    // 路径守卫在 memory-store：未知 kind、`../`、`..%2F`、绝对路径、非法块 id 一律拒绝。
    const result = forgetMemoryItem(this.dataRoot, projectId, kind, id);
    if (result.ok !== true) {
      store.appendAudit({
        action: "memory/forget-refused",
        projectId,
        kind,
        id,
        reason: result.reason,
      });
      store.save();
      return result;
    }
    store.appendAudit({ action: "memory/forgotten", projectId, kind: result.kind, id: result.id });
    store.save();
    return result;
  }

  /**
   * F22：写项目预算（null = 不限）。返回**回读值**，避免假开关。
   * @param {string} projectId @param {any} budget
   */
  setBudget(projectId, budget) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const normalized = normalizeBudgetPatch(budget);
    if (normalized.ok !== true) {
      store.appendAudit({ action: "budget/rejected", projectId, reason: normalized.reason });
      store.save();
      return { ok: false, reason: normalized.reason };
    }
    const updated = store.updateProject(projectId, { budget: normalized.budget });
    store.appendAudit({ action: "budget/updated", projectId, budget: updated.budget });
    store.save();
    return { ok: true, budget: { ...updated.budget }, defaults: { ...DEFAULT_BUDGET } };
  }

  /**
   * F58：写项目的通知开关，返回回读值。
   * @param {string} projectId @param {any} prefs
   */
  setNotifyPrefs(projectId, prefs) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const normalized = normalizeNotifyPatch(prefs);
    if (normalized.ok !== true) {
      return { ok: false, reason: normalized.reason };
    }
    const result = store.setNotifyPrefs(projectId, normalized.prefs);
    store.appendAudit({ action: "notify/prefs", projectId, prefs: result.prefs });
    store.save();
    return { ok: true, prefs: { ...result.prefs } };
  }

  /**
   * F23：线程重命名（右键菜单）。返回回读值。
   * @param {string} sessionId @param {string} title
   */
  renameThread(sessionId, title) {
    const store = this.requireStore();
    if (!store.state?.threads?.[sessionId])
      throw new Error(`projects: unknown thread ${sessionId}`);
    const result = store.setThreadTitle(sessionId, String(title ?? ""));
    store.appendAudit({ action: "thread/renamed", sessionId, title: result.title });
    store.save();
    const readback = store.state.threads[sessionId];
    return { ok: true, sessionId, title: String(readback?.title ?? "") };
  }

  /**
   * F55 / U20：本地文件夹授权卡的三键。
   * - deny：记 denied（执行器不再为这个目录发起请求）
   * - default：落到本项目 store（跨重启保留）
   * - once：一次性凭据，语义对齐宿主 approval 的 `allowed-once`
   * @param {string} projectId @param {string} path @param {string} decision
   */
  authorizeFolder(projectId, path, decision) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const result = applyFolderDecision(project.policy, path, decision, Date.now());
    if (result.ok !== true) return { ok: false, reason: result.reason };
    store.updateProject(projectId, { policy: result.policy });
    store.appendAudit({
      action: "folder/authorized",
      projectId,
      path,
      decision: result.record.mode,
    });
    store.save();
    const readback = store.getProject(projectId);
    return {
      ok: true,
      path,
      decision: result.record.mode,
      // 宿主语义：only-once ↔ approval `allowed-once`；default 是我们自己的 store
      hostSemantics: result.record.mode === "once" ? "allowed-once" : "project-store",
      summary: folderAuthSummary(readback?.policy, path),
    };
  }

  /**
   * F55：消费一张一次性凭据（用掉即失效）。
   * @param {string} projectId @param {string} path
   */
  consumeFolderGrant(projectId, path) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const result = consumeOnceFolderGrant(project.policy, path);
    if (result.ok !== true) return { ok: false, reason: result.reason };
    store.updateProject(projectId, { policy: result.policy });
    store.appendAudit({ action: "folder/once-consumed", projectId, path });
    store.save();
    return { ok: true, path, summary: folderAuthSummary(result.policy, path) };
  }

  /**
   * F4：GitHub 连接检查（只读）。`gh auth status` + `gh repo list --limit 5`，
   * 失败时给出可操作的下一步（装 gh / 登录 / 补 scope），不存任何 token。
   */
  async githubCheck() {
    const auth = await runGh(["auth", "status"]);
    const parsed = parseGhAuthStatus(auth);
    const repos =
      parsed.authenticated === true
        ? parseGhRepoList(await runGh(["repo", "list", "--limit", "5"]))
        : { count: 0, repos: [], hint: parsed.hint };
    const result = githubCheckResult(parsed, repos);
    this.store?.appendAudit?.({
      action: "github/checked",
      level: result.level,
      repoCount: result.repoCount,
    });
    this.store?.save?.();
    return { ...result, repos: repos.repos, scopes: parsed.scopes };
  }

  /**
   * F5：补全项目模板——把受管区块合并进 AGENTS.md（幂等），并补齐 instructions.md。
   * 不覆盖用户内容：受管区块外的东西原样保留。
   * @param {string} projectId
   */
  applyProjectTemplate(projectId) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const dir =
      Array.isArray(project.dirs) && project.dirs.length > 0 ? String(project.dirs[0]) : "";
    const base = dir === "" ? join(this.dataRoot, project.id) : dir.replace(/\/+$/u, "");
    mkdirSync(base, { recursive: true });
    const agentsPath = join(base, "AGENTS.md");
    const block = renderManagedAgentsBlock({
      name: project.name,
      budget: project.budget,
    });
    const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
    const merged = mergeManagedBlock(existing, block);
    writeFileSync(agentsPath, merged.text, { mode: 0o600 });
    // instructions.md 的**读路径**固定在数据根（project-files.js）；写进用户仓库等于
    // 模板永远读不到 + 往别人仓库丢未跟踪文件（审查实测）。AGENTS.md 仍写项目目录（受管块）。
    const instructions = join(this.dataRoot, project.id, "instructions.md");
    let instructionsCreated = false;
    if (!existsSync(instructions)) {
      const plan = planTemplate({
        dir: base,
        exists: { dirExists: true, agentsMd: false, instructionsMd: false },
      });
      const template = plan.files.find((file) => String(file.path).endsWith("instructions.md"));
      mkdirSync(dirname(instructions), { recursive: true });
      try {
        writeFileSync(instructions, template?.content ?? "", { flag: "wx" });
        instructionsCreated = true;
      } catch {
        /* 并发创建：已存在就跳过 */
      }
    }
    store.appendAudit({
      action: "project/template-applied",
      projectId: project.id,
      agents: agentsPath,
      replaced: merged.replaced,
      instructionsCreated,
    });
    store.save();
    return {
      ok: true,
      agentsPath,
      agentsCreated: merged.created,
      agentsReplaced: merged.replaced,
      instructionsCreated,
      managed: { begin: MANAGED_BEGIN, chars: block.length },
    };
  }

  /**
   * F33：Library 视图 = 文件面（宿主 `workspaceFiles`）+ 产物面（artifacts 或我们自存的映射）。
   *
   * 事实边界（docs/runtime 0.2.2-rc.5 §13）：
   *  - `workspaceFiles` 的 scope 是 `{sessionId, workspaceRoot}`：没有会话就没有文件面（明说，不装空）；
   *  - `search` 只搜**文件名/路径**，不搜正文——UI 必须写「按文件名搜索」；
   *  - 多目录 = 多个 workspaceRoot，逐个 list；
   *  - artifacts 未装 / 契约不是 artifacts/2 → `available:false` + reason，**不能**显示「没有产物」。
   * @param {string} projectId
   */
  async libraryView(projectId) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const refs = store.listArtifactRefs(project.id);
    const threads = store.listThreads(project.id);
    const sessionId =
      threads.find((/** @type {any} */ thread) => String(thread.sessionId ?? "") !== "")
        ?.sessionId ??
      (typeof project.coordinatorSessionId === "string" ? project.coordinatorSessionId : "") ??
      "";
    const dirs = Array.isArray(project.dirs) ? project.dirs.filter(Boolean) : [];

    // —— 文件面 ——
    /** @type {any[]} */
    const fileDirs = [];
    const files = {
      available: false,
      reason: "",
      sessionId: String(sessionId ?? ""),
      dirs: fileDirs,
      total: 0,
      partial: false,
    };
    /** 一个目录可能要换几个会话作用域才列得出内容（worktree 线程 vs 项目目录线程）。 */
    // 审查实测：空目录 × 10 目录 × 200 线程 × 3 路径能打出 6000 次串行 RPC（6.9s）。
    // 收敛为「首选会话 + 1 个兜底 + 2 个 path」，并给整次 libraryView 一个总预算。
    const budget = { left: 8, exhausted: false };
    const listDirWithFallback = async (/** @type {string} */ dir) => {
      const candidates = [];
      const preferred = sessionForProjectDir(threads, dir, String(sessionId ?? ""));
      if (preferred !== "") candidates.push(preferred);
      for (const thread of threads) {
        const candidate = String(thread?.sessionId ?? "");
        if (candidate !== "" && !candidates.includes(candidate)) candidates.push(candidate);
        if (candidates.length >= 2) break;
      }
      const coordinator =
        typeof project.coordinatorSessionId === "string" ? project.coordinatorSessionId : "";
      if (candidates.length < 2 && coordinator !== "" && !candidates.includes(coordinator)) {
        candidates.push(coordinator);
      }
      /** @type {any} */
      let fallbackResult = null;
      // 宿主 `list` 的 path 是「workspace 内路径」：实测空串会返回空列表，
      // 用 "." 表示根才列得出直接子项；绝对路径作为最后兜底（同为 root 时应被接受）。
      const pathCandidates = [".", dir];
      for (const listPath of pathCandidates) {
        for (const candidate of candidates) {
          if (budget.left <= 0) {
            budget.exhausted = true;
            break;
          }
          budget.left -= 1;
          try {
            // 宿主 Remote 的签名是 (scope, path, signal)：漏传 signal 会在实现里
            // `signal.throwIfAborted()` 直接抛，表现为「列不出任何文件」而不是报错。
            const page = await workspaceFiles.list(
              { sessionId: candidate, workspaceRoot: dir },
              listPath,
              new AbortController().signal,
            );
            const entriesOut = (Array.isArray(page?.entries) ? page.entries : [])
              .slice(0, 200)
              .map((/** @type {any} */ entry) => ({
                name: String(entry?.name ?? entry?.path ?? ""),
                path: String(entry?.path ?? entry?.name ?? ""),
                type: String(entry?.type ?? entry?.kind ?? "file"),
                size: Number(entry?.size ?? entry?.bytes ?? 0),
                updatedAt: Number(entry?.updatedAt ?? entry?.mtimeMs ?? 0) || null,
              }));
            const result = {
              dir,
              listedPath: listPath,
              ok: true,
              truncated: page?.truncated === true,
              entries: entriesOut,
            };
            if (entriesOut.length > 0) return result;
            fallbackResult = fallbackResult ?? result;
          } catch (error) {
            fallbackResult = fallbackResult ?? {
              dir,
              listedPath: listPath,
              ok: false,
              truncated: false,
              entries: [],
              error: String(error instanceof Error ? error.message : error).slice(0, 200),
            };
          }
        }
      }
      return fallbackResult ?? { dir, ok: true, truncated: false, entries: [] };
    };
    const workspaceFiles = this.hostService("workspaceFiles");
    if (dirs.length === 0) files.reason = "no-dir";
    else if (String(sessionId ?? "") === "") files.reason = "no-session";
    else if (workspaceFiles === undefined || typeof workspaceFiles.list !== "function")
      files.reason = "host-unavailable";
    else {
      files.available = true;
      for (const dir of dirs) {
        if (budget.left <= 0) {
          budget.exhausted = true;
          break;
        }
        const listed = await listDirWithFallback(dir);
        files.dirs.push(listed);
        files.total += listed.entries.length;
      }
      files.partial = budget.exhausted === true;
    }

    // —— 产物面 ——
    /** @type {any[]} */
    const artifactRows = [];
    const artifacts = {
      available: false,
      reason: "",
      contract: "",
      rows: artifactRows,
      summary: { count: 0, bytes: 0 },
      stored: refs,
      storedSummary: summarizeArtifactRefs(refs),
    };
    const service = this.hostService("artifacts");
    if (service === undefined || typeof service.list !== "function") {
      artifacts.reason = "artifacts-not-installed";
    } else {
      let contract = "";
      let probed = false;
      try {
        const version = await service.version();
        contract = String(version?.contract ?? "");
        probed = true;
      } catch {
        artifacts.reason = "artifacts-version-unavailable";
      }
      artifacts.contract = contract;
      if (probed && contract !== ARTIFACTS_CONTRACT) {
        artifacts.reason = "artifacts-contract-mismatch";
      } else if (probed) {
        try {
          const page = await service.list({ projectId: project.id });
          artifacts.available = true;
          artifacts.rows = (Array.isArray(page?.artifacts) ? page.artifacts : [])
            .map((/** @type {any} */ row) => refFromArtifactRow(row))
            .filter(Boolean);
          const summary = page?.summary ?? {};
          artifacts.summary = {
            count: Number(summary.count ?? artifacts.rows.length),
            bytes: Number(summary.bytes ?? summarizeArtifactRefs(artifacts.rows).bytes),
          };
        } catch {
          artifacts.reason = "artifacts-list-failed";
        }
      }
    }
    // 产物面合并：服务在线时以服务行为准，再用自存映射补齐旧产物；离线时只给映射（UI 降级只列文件面）。
    if (artifacts.available) {
      // artifacts 服务返回的行没有我们记的 `at`；用自存引用把时间补回去（否则 UI 只能显示"时间未知"）
      const refById = new Map(refs.map((/** @type {any} */ ref) => [ref.id, ref]));
      artifacts.rows = artifacts.rows.map((/** @type {any} */ row) => {
        const ref = refById.get(row.id);
        if (!ref) return row;
        const atMs = ref.at ? Date.parse(ref.at) : Number.NaN;
        return {
          ...row,
          at: row.at ?? ref.at ?? null,
          updatedAt: row.updatedAt ?? (Number.isFinite(atMs) ? atMs : null),
        };
      });
      const seen = new Set(artifacts.rows.map((/** @type {any} */ row) => row.id));
      for (const ref of refs) {
        if (!seen.has(ref.id)) artifacts.rows.push(ref);
      }
      artifacts.summary = {
        count: artifacts.rows.length,
        bytes: artifacts.rows.reduce(
          (/** @type {number} */ sum, /** @type {any} */ row) => sum + Number(row.bytes ?? 0),
          0,
        ),
      };
    }
    return { projectId: project.id, files, artifacts };
  }

  /**
   * F33：记录一条产物引用（projectId↔artifactId）。发布产物时在项目线程里调用。
   * 只写我们自己的 store；不复制产物字节（字节由 artifacts 管）。
   * @param {string} projectId @param {any} ref
   */
  recordArtifact(projectId, ref) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const written = store.recordArtifact(project.id, ref);
    if (written === null) throw new Error("projects: artifact ref needs a valid id");
    store.appendAudit({
      action: "library/artifact-recorded",
      projectId: project.id,
      artifactId: written.ref.id,
      version: written.ref.version,
      bytes: written.ref.bytes,
    });
    store.save();
    return {
      ok: true,
      ref: written.ref,
      refs: written.refs,
      summary: summarizeArtifactRefs(written.refs),
    };
  }

  /**
   * F33：按文件名搜索项目文件（`workspaceFiles.search` 只匹配名称与路径）。
   * @param {string} projectId @param {string} query
   */
  async searchLibraryFiles(projectId, query) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const text = String(query ?? "").trim();
    const threads = store.listThreads(project.id);
    const fallbackSession =
      threads.find((/** @type {any} */ thread) => String(thread.sessionId ?? "") !== "")
        ?.sessionId ?? "";
    const dirs = Array.isArray(project.dirs) ? project.dirs.filter(Boolean) : [];
    if (dirs.length === 0) return { available: false, reason: "no-dir", query: text, matches: [] };
    const workspaceFiles = this.hostService("workspaceFiles");
    if (workspaceFiles === undefined || typeof workspaceFiles.search !== "function")
      return { available: false, reason: "host-unavailable", query: text, matches: [] };
    if (text === "") return { available: true, reason: "", query: "", matches: [], nameOnly: true };
    /** @type {any[]} */
    const matches = [];
    let searched = 0;
    let lastError = "";
    // 多目录项目以前只搜 dirs[0]：其它目录里的文件永远搜不到（审查指出）
    for (const dir of dirs.slice(0, 10)) {
      const sessionId = sessionForProjectDir(threads, String(dir), fallbackSession);
      if (String(sessionId) === "") continue;
      try {
        const page = await workspaceFiles.search(
          { sessionId: String(sessionId), workspaceRoot: String(dir) },
          {
            query: text,
            excludedPaths: [],
            includeHidden: true,
            respectGitignore: true,
          },
          new AbortController().signal,
        );
        searched += 1;
        for (const match of Array.isArray(page?.matches) ? page.matches : []) {
          if (matches.length >= 50) break;
          matches.push({
            path: String(match?.path ?? ""),
            type: String(match?.type ?? "file"),
            dir: String(dir),
          });
        }
      } catch (error) {
        lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
      }
      if (matches.length >= 50) break;
    }
    if (searched === 0) {
      return {
        available: false,
        reason: "search-failed",
        query: text,
        matches: [],
        error: lastError,
      };
    }
    return {
      available: true,
      reason: "",
      query: text,
      matches,
      nameOnly: true,
      dirsSearched: searched,
    };
  }

  /**
   * F42：写项目级线程默认模型 / effort，返回回读值（空串 = 继承宿主默认）。
   * @param {string} projectId @param {string} [provider] @param {string} [model] @param {string} [reasoningEffort]
   */
  /**
   * 写项目级**协调者**默认模型 / effort（与线程默认独立）。
   * @param {string} projectId @param {string} [provider] @param {string} [model] @param {string} [reasoningEffort]
   */
  setCoordinatorDefaults(projectId, provider, model, reasoningEffort) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const result = store.setCoordinatorDefaults(projectId, {
      provider: String(provider ?? ""),
      model: String(model ?? ""),
      reasoningEffort: String(reasoningEffort ?? ""),
    });
    store.appendAudit({ action: "coordinator/defaults", projectId, defaults: result.defaults });
    store.save();
    const readback = store.getProject(projectId);
    return {
      ok: true,
      defaults: { ...(readback?.coordinatorDefaults ?? result.defaults) },
    };
  }

  /**
   * F42：写项目级线程默认模型 / effort，返回回读值（空串 = 继承宿主默认）。
   * @param {string} projectId @param {string} [provider] @param {string} [model] @param {string} [reasoningEffort]
   */
  setThreadDefaults(projectId, provider, model, reasoningEffort) {
    const store = this.requireStore();
    if (!store.getProject(projectId)) throw new Error(`projects: unknown project ${projectId}`);
    const result = store.setThreadDefaults(projectId, {
      provider: String(provider ?? ""),
      model: String(model ?? ""),
      reasoningEffort: String(reasoningEffort ?? ""),
    });
    store.appendAudit({ action: "thread/defaults", projectId, defaults: result.defaults });
    store.save();
    const readback = store.getProject(projectId);
    return { ok: true, defaults: { ...(readback?.threadDefaults ?? result.defaults) } };
  }

  /**
   * F49：Usage 视图（token / 上下文占用，**不显示金额**：宿主没有价目 API）。
   * @param {string} projectId
   */
  usageView(projectId) {
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const days = this.usageDays(project.id);
    const threads = store.listThreads(project.id);
    const files = readProjectFiles(this.dataRoot, project.id);
    const fragments = this.listMemoryFragments(project.id);
    const now = Date.now();
    const totalTokens = days.reduce((sum, day) => sum + day.tokens, 0);
    return {
      projectId: project.id,
      days,
      totalTokens,
      todayTokens: days.length > 0 ? days[days.length - 1].tokens : 0,
      threads: {
        total: threads.length,
        today: threads.filter((/** @type {any} */ thread) => isToday(thread, now)).length,
        working: threads.filter((/** @type {any} */ thread) => thread.state === "working").length,
        waiting: threads.filter((/** @type {any} */ thread) => thread.state === "waiting-user")
          .length,
      },
      context: {
        instructionsChars: files.instructions.length,
        memoryChars: files.memoryIndex.length,
        fragments: fragments.fragments.length,
        fragmentsChars: fragments.totalChars,
        budget: { ...project.budget },
      },
      // 诚实呈现：没有钱这一项
      money: null,
      note: "宿主没有价目 API：这里只统计 token 与上下文占用，不显示金额。",
    };
  }

  /**
   * F62：`@` 候选（项目 + 线程）。client 的 inputTriggers source 回调这里取数据。
   * @param {string} [query]
   */
  mentionItems(query) {
    const store = this.requireStore();
    const projects = store.listProjects();
    /** @type {any[]} */
    const threads = [];
    for (const project of projects) {
      for (const thread of store.listThreads(project.id)) {
        threads.push({
          sessionId: thread.sessionId,
          projectId: project.id,
          title: String(thread.title ?? thread.subtitle ?? ""),
          lastActivityAt: thread.lastActivityAt,
          createdAt: thread.createdAt,
        });
      }
    }
    return buildMentionItems({ projects, threads, query: String(query ?? "") });
  }

  /**
   * F3：最近会话（「从会话开线程」用）。走宿主 sessionController.list，只读。
   * @param {string} projectId
   */
  async recentSessions(projectId) {
    await this.waitServices();
    const store = this.requireStore();
    const project = store.getProject(String(projectId ?? ""));
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const sc = this.sessionController;
    if (!sc || typeof sc.list !== "function")
      return { ok: false, reason: "sessions/unavailable", sessions: [] };
    /** 把宿主 list 的几种回执形状归一成数组（P0 复审：0.2.2 返回 `{items}`）。 */
    const normalizeList = (/** @type {any} */ value) => {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.sessions)) return value.sessions;
      if (Array.isArray(value?.value?.items)) return value.value.items;
      return [];
    };
    /** @type {any[]} */
    let items = [];
    /** @type {string} */
    let lastError = "";
    try {
      // typert 的 Remote 签名是 list(request, signal)；也兼容只传 signal 的版本。
      // 两种**各自 try**：第一种抛错不能吃掉第二种（旧实现就是在 catch 里直接放弃）。
      const attempts = [
        () => sc.list({}, AbortSignal.timeout(4000)),
        () => sc.list(AbortSignal.timeout(4000)),
      ];
      for (const attempt of attempts) {
        try {
          items = normalizeList(await attempt());
        } catch (error) {
          lastError = String(/** @type {any} */ (error)?.message ?? error);
        }
        if (items.length > 0) break;
      }
    } catch (error) {
      lastError = String(/** @type {any} */ (error)?.message ?? error);
    }
    if (items.length === 0 && lastError !== "") {
      return { ok: false, reason: `sessions/unavailable: ${lastError.slice(0, 80)}`, sessions: [] };
    }
    const attached = new Set(
      store.listThreads(project.id).map((/** @type {any} */ thread) => thread.sessionId),
    );
    const sessions = (Array.isArray(items) ? items : [])
      .map((item) => ({
        sessionId: String(item?.sessionId ?? ""),
        title: String(item?.projections?.values?.title ?? item?.title ?? ""),
        updatedAt: item?.updatedAt ?? item?.createdAt ?? null,
        attached: attached.has(String(item?.sessionId ?? "")),
      }))
      .filter((item) => item.sessionId !== "")
      .slice(0, 20);
    return { ok: true, sessions };
  }

  // ===== B4 · F52 权限收窄 / F36 Routines / F30 双模式提醒 =====
  //
  // 三件事共用一条原则：**写→回读**。RPC 返回里带宿主读回值（preset 的 current(session)、
  // schedule 的 status/next、提醒的盘上状态），UI 只渲染回读值，不渲染"我刚写进去的东西"。

  /** @returns {any} 宿主的 permissionPresets（按 `ctx.get()` 判空） */
  permissionPresets() {
    return this.hostService("permissionPresets");
  }

  /** @returns {any} 宿主的 schedule（按 `ctx.get()` 判空） */
  scheduleHost() {
    return this.hostService("schedule");
  }

  /** 宿主时区名（IANA）；拿不到就 UTC（宿主 side 换算，我们只传名字） */
  hostTimeZone() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof zone === "string" && zone !== "" ? zone : "UTC";
    } catch {
      return "UTC";
    }
  }

  /**
   * 记住一个 Session 句柄（`permissionPresets.set/current` 收 Session，不收 sessionId）。
   * @param {string} sessionId @param {any} session
   */
  rememberSession(sessionId, session) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (!session || typeof session.append !== "function") return;
    this.sessionHandles.set(sessionId, session);
  }

  /**
   * 取会话句柄：先缓存，再试 `sessions` 注册表，最后 `sessionController.resolveAgent`。
   * 三条路都不通就返回 undefined——调用方必须如实标「待应用」，不许假装已生效。
   * @param {string} sessionId
   * @returns {Promise<any|undefined>}
   */
  async sessionHandleFor(sessionId) {
    const cached = this.sessionHandles.get(sessionId);
    if (cached) return cached;
    const sessions = this.hostService("sessions");
    if (sessions && typeof sessions === "object") {
      for (const method of ["get", "lookup", "resolve"]) {
        const fn = /** @type {any} */ (sessions)[method];
        if (typeof fn !== "function") continue;
        try {
          const found = await fn.call(sessions, sessionId);
          if (found && typeof found.append === "function") {
            this.sessionHandles.set(sessionId, found);
            return found;
          }
        } catch {
          /* 这条获取路径不通就试下一条 */
        }
      }
    }
    const sc = this.sessionController;
    const resolveAgent = /** @type {any} */ (sc)?.resolveAgent;
    if (typeof resolveAgent === "function") {
      try {
        const resolved = await resolveAgent.call(sc, sessionId);
        const session = resolved?.agent?.session;
        if (session && typeof session.append === "function") {
          this.sessionHandles.set(sessionId, session);
          return session;
        }
      } catch {
        /* agent 可能还是懒创建的：留给 agent/created 钩子或「应用」按钮重试 */
      }
    }
    return undefined;
  }

  /**
   * F52：宿主的 catalog + 人话选项 + 本部署默认档。**名字一律来自 catalog，不写死**。
   * @returns {any}
   */
  permissionCatalog() {
    const presets = this.permissionPresets();
    if (!presets || typeof presets.catalog !== "function") {
      return {
        available: false,
        reason: "permission-presets-unavailable",
        options: [],
        defaultPreset: "",
        notes: [...PRESET_SAFETY_NOTES],
        inherit: inheritOption(
          { kind: "custom", label: "未知", detail: "宿主没有 permissionPresets 服务" },
          "",
        ),
      };
    }
    let catalog;
    try {
      catalog = presets.catalog();
    } catch (error) {
      return {
        available: false,
        reason: `permission-catalog-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)}`,
        options: [],
        defaultPreset: "",
        notes: [...PRESET_SAFETY_NOTES],
        inherit: inheritOption({ kind: "custom", label: "未知", detail: "" }, ""),
      };
    }
    const summary = summarizeCatalog(catalog, (/** @type {string} */ name) =>
      presets.resolve(name),
    );
    return {
      available: true,
      reason: "",
      options: summary.options,
      defaultPreset: summary.defaultPreset,
      defaultHuman: summary.defaultHuman,
      inherit: inheritOption(summary.defaultHuman, summary.defaultPreset),
      notes: [...PRESET_SAFETY_NOTES],
    };
  }

  /**
   * F52：给一个会话套用项目档位（并回读）。返回的结构就是证据：
   * `targetPreset` / `currentPreset` / `mode` / `ok` / `reason`。
   * @param {string} projectId @param {string} sessionId @param {string} kind
   * @returns {Promise<any>}
   */
  async applyPresetToSession(projectId, sessionId, kind) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    const targetPreset = typeof project?.preset === "string" ? project.preset : "";
    const record = {
      sessionId,
      kind,
      projectId,
      targetPreset,
      currentPreset: "",
      mode: "",
      ok: false,
      reason: "",
      at: new Date().toISOString(),
    };
    if (targetPreset === INHERIT_PRESET) {
      record.ok = true;
      record.mode = "inherit";
      record.reason = "inherit-host-default";
      this.presetApplied.set(sessionId, record);
      return record;
    }
    const presets = this.permissionPresets();
    if (!presets) {
      record.reason = "permission-presets-unavailable";
      this.presetApplied.set(sessionId, record);
      return record;
    }
    const session = await this.sessionHandleFor(sessionId);
    if (!session) {
      record.reason = "session-handle-unavailable";
      this.presetApplied.set(sessionId, record);
      store.appendAudit({
        action: "preset/pending",
        projectId,
        sessionId,
        kind,
        preset: targetPreset,
      });
      store.save();
      return record;
    }
    let names = [];
    try {
      const catalog = presets.catalog();
      names = (Array.isArray(catalog?.options) ? catalog.options : []).map(
        (/** @type {any} */ option) =>
          typeof option === "string" ? option : String(option?.value ?? ""),
      );
    } catch {
      names = [];
    }
    let spec;
    try {
      spec = typeof presets.resolve === "function" ? presets.resolve(targetPreset) : undefined;
    } catch {
      spec = undefined;
    }
    const plan = planPresetApplication({
      preset: targetPreset,
      catalogNames: names,
      fallbackSpec: spec,
    });
    try {
      if (plan.mode === "preset" && typeof presets.set === "function") {
        presets.set(session, plan.name);
        record.mode = "preset";
      } else if (plan.mode === "fallback") {
        // 没有匹配档位：用两个会话事件兜底（公开 Session API，不引宿主包）
        for (const event of fallbackSessionEvents(plan.spec))
          session.append(event.type, event.payload);
        record.mode = "fallback";
      } else {
        record.mode = "invalid";
        record.reason = plan.mode === "invalid" ? plan.reason : "preset/set-unavailable";
      }
    } catch (error) {
      record.mode = record.mode || "error";
      record.reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 160);
    }
    // 回读：preset 路径读 `current(session)`；兜底路径读 approval/sandbox 的 override
    try {
      const currentPreset = String(presets.current?.(session) ?? "");
      record.currentPreset = currentPreset;
      const currentSpec =
        record.mode === "fallback" ? this.sessionOverrideSpec(session) : undefined;
      const verdict = verifyPresetApplication({
        targetPreset,
        currentPreset,
        targetSpec: spec,
        currentSpec,
      });
      record.ok = verdict.ok;
      if (!verdict.ok && record.reason === "") record.reason = verdict.reason;
    } catch (error) {
      record.reason = `preset/readback-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)}`;
    }
    this.presetApplied.set(sessionId, record);
    store.appendAudit({
      action: record.ok ? "preset/applied" : "preset/apply-failed",
      projectId,
      sessionId,
      kind,
      preset: targetPreset,
      current: record.currentPreset,
      mode: record.mode,
      reason: record.reason,
    });
    store.save();
    return record;
  }

  /**
   * 兜底路径的回读：approval/sandbox 的 override（都收 Session，见 runtime §12）。
   * @param {any} session
   * @returns {{ sandbox: string, approval: string }|undefined}
   */
  sessionOverrideSpec(session) {
    const approval = hostOverride(this.hostService("approval"), "overrideOf", session);
    const sandbox = hostOverride(this.hostService("sandboxPolicy"), "overrideOf", session);
    if (approval === undefined && sandbox === undefined) return undefined;
    return { approval: approval ?? "", sandbox: sandbox ?? "" };
  }

  /**
   * F52：把项目档位应用到协调器 + 全部线程（旧会话补应用）。返回逐会话回读结果。
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async applyProjectPreset(projectId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    /** @type {string[]} */
    const targets = [];
    if (typeof project.coordinatorSessionId === "string" && project.coordinatorSessionId !== "") {
      targets.push(project.coordinatorSessionId);
    }
    for (const thread of store.listThreads(projectId)) {
      if (thread?.state === "archived") continue;
      targets.push(String(thread.sessionId));
    }
    /** @type {any[]} */
    const applied = [];
    /** @type {string[]} */
    const pending = [];
    for (const sessionId of targets) {
      const kind = sessionId === project.coordinatorSessionId ? "coordinator" : "thread";
      // eslint-disable-next-line no-await-in-loop -- 会话句柄获取是串行的宿主调用，逐条等更稳
      const record = await this.applyPresetToSession(projectId, sessionId, kind);
      applied.push(record);
      if (!record.ok) pending.push(sessionId);
    }
    return {
      projectId,
      preset: project.preset ?? null,
      applied,
      pending,
      at: new Date().toISOString(),
    };
  }

  /**
   * F52：面板/冒烟用的读视图：目录 + 项目当前选择 + 每个会话的回读。
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async permissionState(projectId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const catalog = this.permissionCatalog();
    /** @type {any[]} */
    const sessions = [];
    if (typeof project.coordinatorSessionId === "string" && project.coordinatorSessionId !== "") {
      sessions.push({
        sessionId: project.coordinatorSessionId,
        kind: "coordinator",
        ...(this.presetApplied.get(project.coordinatorSessionId) ?? {}),
      });
    }
    for (const thread of store.listThreads(projectId)) {
      const record = this.presetApplied.get(String(thread.sessionId));
      sessions.push({
        sessionId: thread.sessionId,
        kind: "thread",
        ...(record ?? {}),
      });
    }
    return {
      projectId,
      preset: project.preset ?? null,
      catalog,
      sessions,
      appliedCount: sessions.filter((/** @type {any} */ item) => item.ok === true).length,
      pendingCount: sessions.filter((/** @type {any} */ item) => item.ok !== true).length,
    };
  }

  /**
   * F52：写项目档位（先 `catalog()` 校验名字，再写盘，再套用到现有会话并回读）。
   * @param {string} projectId @param {unknown} preset
   * @returns {Promise<any>}
   */
  async setProjectPreset(projectId, preset) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const value = String(preset ?? "").trim();
    const catalog = this.permissionCatalog();
    if (value !== INHERIT_PRESET) {
      if (!catalog.available) {
        return {
          ok: false,
          reason: catalog.reason || "permission-presets-unavailable",
          preset: project.preset ?? null,
        };
      }
      const names = catalog.options.map((/** @type {any} */ option) => String(option.name));
      if (!names.includes(value))
        return {
          ok: false,
          reason: `preset/not-in-catalog:${value}`,
          preset: project.preset ?? null,
        };
    }
    const written = store.setProjectPreset(projectId, value);
    store.appendAudit({
      action: "preset/selected",
      projectId,
      preset: written.preset,
      previous: project.preset ?? null,
    });
    store.save();
    const applied = await this.applyProjectPreset(projectId);
    return { ok: true, reason: "", preset: written.preset, applied, catalog };
  }

  // —— F36 Routines ——

  /**
   * 一条 routine 的宿主侧状态（`schedule.view`），拿不到就如实说没有。
   * @param {string} scheduleId
   * @returns {Promise<any|undefined>}
   */
  async scheduleEntry(scheduleId) {
    if (scheduleId === "") return undefined;
    const schedule = this.scheduleHost();
    if (!schedule || typeof schedule.view !== "function") return undefined;
    try {
      return await schedule.view({ id: scheduleId });
    } catch {
      return undefined;
    }
  }

  /**
   * F36：Routines 视图（列表 + 每条 routine 的宿主状态 + 历史 + 成本提示）。
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async routinesView(projectId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const schedule = this.scheduleHost();
    const available = Boolean(schedule && typeof schedule.create === "function");
    /** @type {any[]} */
    const routines = [];
    for (const routine of store.listRoutines(projectId)) {
      const entry = await this.scheduleEntry(routine.scheduleId);
      const status = describeScheduleStatus(entry, routine.enabled !== false);
      routines.push({
        ...routine,
        description: describeRoutineFrequency(routine),
        status,
        lastDelivery: entry?.lastDelivery ?? null,
        hostStatus: entry?.status ?? (routine.scheduleId === "" ? "manual" : "missing"),
      });
    }
    return {
      projectId,
      available,
      reason: available ? "" : "schedule-unavailable",
      costHint: ROUTINE_COST_HINT,
      manualHint: MANUAL_COST_HINT,
      timeZone: this.hostTimeZone(),
      routines,
      projectDir:
        Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : this.dataRoot,
    };
  }

  /**
   * F36：新建 routine。先建宿主 schedule（自动档），再落本地记录；本地失败时把宿主条目删掉（补偿）。
   * @param {string} projectId @param {any} input
   * @returns {Promise<any>}
   */
  async createRoutine(projectId, input) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const checked = validateRoutineInput({
      ...(input && typeof input === "object" ? input : {}),
      timeZone: this.hostTimeZone(),
    });
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const value = checked.value;
    const timing = buildRoutineTiming(value.frequency, {
      time: value.time,
      weekday: value.weekday,
      dayOfMonth: value.dayOfMonth,
      timeZone: this.hostTimeZone(),
    });
    if (!timing.ok) return { ok: false, reason: timing.reason };
    const routineId = newRoutineId();
    /** @type {any} */
    let scheduleId = "";
    const schedule = this.scheduleHost();
    if (timing.timing !== null) {
      if (!schedule || typeof schedule.create !== "function") {
        return { ok: false, reason: "schedule-unavailable" };
      }
      const cwd =
        Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : this.dataRoot;
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        /* 目录已存在/无权限：宿主 create 会报出真正原因 */
      }
      try {
        const created = await schedule.create({
          title: `[${String(project.name ?? projectId)}] ${value.name}`.slice(0, 120),
          prompt: value.instructions,
          timing: timing.timing,
          target: { kind: "new", create: { cwd } },
        });
        scheduleId = String(created?.id ?? "");
      } catch (error) {
        store.appendAudit({
          action: "routine/create-failed",
          projectId,
          frequency: value.frequency,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 160),
        });
        store.save();
        return {
          ok: false,
          reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
        };
      }
      if (scheduleId === "") return { ok: false, reason: "schedule/no-id" };
    }
    try {
      const added = store.addRoutine(projectId, {
        id: routineId,
        name: value.name,
        instructions: value.instructions,
        frequency: value.frequency,
        time: value.time ?? "09:00:00",
        weekday: value.weekday,
        dayOfMonth: value.dayOfMonth,
        timeZone: this.hostTimeZone(),
        cron: timing.expression,
        enabled: true,
        spaceId: String(projectId),
        scheduleId,
        createdAt: new Date().toISOString(),
        lastRunAt: "",
        history: [],
      });
      store.appendAudit({
        action: "routine/created",
        projectId,
        routineId,
        frequency: value.frequency,
        scheduleId,
      });
      store.save();
      const entry = await this.scheduleEntry(scheduleId);
      return {
        ok: true,
        routine: {
          ...added.routine,
          description: describeRoutineFrequency(added.routine),
          status: describeScheduleStatus(entry, true),
        },
        scheduleId,
        timing: timing.timing,
      };
    } catch (error) {
      // 补偿：本地没落成，宿主那条要撤掉，否则会静默继续花 token
      if (scheduleId !== "" && schedule && typeof schedule.edit === "function") {
        try {
          await schedule.edit({ id: scheduleId, action: "delete" });
        } catch {
          /* 补偿失败：下面的错误里会带 routine 记录，让用户能在宿主侧清理 */
        }
      }
      return {
        ok: false,
        reason: String(/** @type {any} */ (error)?.message ?? error).slice(0, 200),
      };
    }
  }

  /**
   * F36：启停（宿主侧 paused/active + 本地 enabled 双写，回读宿主 status）。
   * @param {string} projectId @param {string} routineId @param {boolean} enabled
   * @returns {Promise<any>}
   */
  async setRoutineEnabled(projectId, routineId, enabled) {
    const store = this.requireStore();
    const routine = store
      .listRoutines(projectId)
      .find((/** @type {any} */ item) => item.id === routineId);
    if (!routine) return { ok: false, reason: "routine/not-found" };
    const schedule = this.scheduleHost();
    let hostResult = "manual";
    if (routine.scheduleId !== "") {
      if (!schedule || typeof schedule.edit !== "function")
        return { ok: false, reason: "schedule-unavailable" };
      try {
        await schedule.edit({
          id: routine.scheduleId,
          action: "update",
          patch: { status: enabled === true ? "active" : "paused" },
        });
        hostResult = enabled === true ? "active" : "paused";
      } catch (error) {
        return {
          ok: false,
          reason: `schedule/edit-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        };
      }
    }
    const updated = store.patchRoutine(projectId, routineId, { enabled: enabled === true });
    store.appendAudit({
      action: "routine/toggle",
      projectId,
      routineId,
      enabled: enabled === true,
      hostResult,
    });
    store.save();
    const entry = await this.scheduleEntry(routine.scheduleId);
    return {
      ok: true,
      routine: {
        ...updated.routine,
        description: describeRoutineFrequency(updated.routine),
        status: describeScheduleStatus(entry, enabled === true),
      },
      hostResult,
    };
  }

  /**
   * F36：删除（先删宿主条目，再删本地；宿主删失败就不动本地，避免留下会花钱的孤儿）。
   * @param {string} projectId @param {string} routineId
   * @returns {Promise<any>}
   */
  async deleteRoutine(projectId, routineId) {
    const store = this.requireStore();
    const routine = store
      .listRoutines(projectId)
      .find((/** @type {any} */ item) => item.id === routineId);
    if (!routine) return { ok: false, reason: "routine/not-found" };
    const schedule = this.scheduleHost();
    if (routine.scheduleId !== "") {
      if (!schedule || typeof schedule.edit !== "function")
        return { ok: false, reason: "schedule-unavailable" };
      try {
        await schedule.edit({ id: routine.scheduleId, action: "delete" });
      } catch (error) {
        return {
          ok: false,
          reason: `schedule/delete-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        };
      }
    }
    const removed = store.removeRoutine(projectId, routineId);
    store.appendAudit({
      action: "routine/deleted",
      projectId,
      routineId,
      removed: removed.removed,
    });
    store.save();
    return { ok: true, ...removed };
  }

  /**
   * F36：Run now（宿主 `schedule.run` 会真投递 = 真花一次模型调用；手动档也要有一个能跑的路径）。
   * @param {string} projectId @param {string} routineId
   * @returns {Promise<any>}
   */
  async runRoutineNow(projectId, routineId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const routine = store
      .listRoutines(projectId)
      .find((/** @type {any} */ item) => item.id === routineId);
    if (!routine) return { ok: false, reason: "routine/not-found" };
    const schedule = this.scheduleHost();
    const at = new Date().toISOString();
    if (routine.scheduleId !== "" && schedule && typeof schedule.run === "function") {
      try {
        await schedule.run({ id: routine.scheduleId });
        store.patchRoutine(projectId, routineId, {
          lastRunAt: at,
          history: appendRoutineHistory(routine, {
            at,
            status: "run-now",
            message: "通过宿主 schedule.run 投递（会跑一次模型）",
            source: "run-now",
          }),
        });
        store.appendAudit({ action: "routine/run-now", projectId, routineId, via: "schedule" });
        store.save();
        return { ok: true, via: "schedule", at };
      } catch (error) {
        const reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 200);
        store.patchRoutine(projectId, routineId, {
          history: appendRoutineHistory(routine, {
            at,
            status: "run-failed",
            message: reason,
            source: "run-now",
          }),
        });
        store.appendAudit({ action: "routine/run-failed", projectId, routineId, reason });
        store.save();
        return { ok: false, reason };
      }
    }
    // 手动档：没有宿主条目，直接往协调器会话投一条（协调器不存在就先建）
    const coordinator = await this.ensureCoordinator(projectId);
    const sessionId = String(coordinator?.sessionId ?? "");
    if (sessionId === "") return { ok: false, reason: "routine/no-target-session" };
    try {
      await this.promptThread(sessionId, routine.instructions);
      store.patchRoutine(projectId, routineId, {
        lastRunAt: at,
        history: appendRoutineHistory(routine, {
          at,
          status: "run-now",
          message: `投递到协调器会话 ${sessionId.slice(0, 10)}（会跑一次模型）`,
          source: "run-now",
        }),
      });
      store.appendAudit({
        action: "routine/run-now",
        projectId,
        routineId,
        via: "coordinator",
        sessionId,
      });
      store.save();
      return { ok: true, via: "coordinator", sessionId, at };
    } catch (error) {
      const reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 200);
      store.patchRoutine(projectId, routineId, {
        history: appendRoutineHistory(routine, {
          at,
          status: "run-failed",
          message: reason,
          source: "run-now",
        }),
      });
      store.save();
      return { ok: false, reason };
    }
  }

  /**
   * F36：History（宿主 `schedule.history` 的投递记录 + 本地 Run now 记录，合起来按时间倒序）。
   * @param {string} projectId @param {string} routineId
   * @returns {Promise<any>}
   */
  async routineHistory(projectId, routineId) {
    const store = this.requireStore();
    const routine = store
      .listRoutines(projectId)
      .find((/** @type {any} */ item) => item.id === routineId);
    if (!routine) return { ok: false, reason: "routine/not-found" };
    const schedule = this.scheduleHost();
    /** @type {any[]} */
    const deliveries = [];
    let retention = null;
    let hostAvailable = false;
    if (routine.scheduleId !== "" && schedule && typeof schedule.history === "function") {
      try {
        const result = await schedule.history({ id: routine.scheduleId, limit: 20 });
        hostAvailable = true;
        retention = result?.retention ?? null;
        for (const record of Array.isArray(result?.records) ? result.records : []) {
          deliveries.push({ ...historyFromDelivery(record), source: "host" });
        }
      } catch {
        hostAvailable = false;
      }
    }
    const local = (Array.isArray(routine.history) ? routine.history : []).map(
      (/** @type {any} */ row) => ({ ...row, source: row.source || "local" }),
    );
    const rows = [...deliveries, ...local]
      .filter((/** @type {any} */ row) => typeof row.at === "string" && row.at !== "")
      .sort((/** @type {any} */ left, /** @type {any} */ right) => (left.at < right.at ? 1 : -1))
      .slice(0, 20);
    return {
      ok: true,
      routineId,
      scheduleId: routine.scheduleId,
      hostAvailable,
      retention,
      rows,
    };
  }

  // —— F30 提醒（双模式） ——

  /**
   * F30：提醒视图（列表 + 默认模式 + 两种模式的成本差异 + 本机 arm 状态）。
   * @param {string} projectId
   * @returns {any}
   */
  remindersView(projectId) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    // 过期清理只在读的时候做：pending 永不动，fired/cancelled/done 超 7 天清掉
    const purged = purgeExpiredReminders(store.listReminders(projectId), Date.now());
    if (purged.dropped.length > 0) {
      for (const id of purged.dropped) store.removeReminder(projectId, id);
      store.save();
    }
    const now = Date.now();
    const list = purged.kept
      .map((/** @type {any} */ reminder) => ({
        ...reminder,
        remaining: remainingTime(reminder.at, now),
      }))
      .sort((/** @type {any} */ left, /** @type {any} */ right) => (left.at < right.at ? -1 : 1));
    const schedule = this.scheduleHost();
    return {
      projectId,
      defaultMode: project.reminderDefault ?? DEFAULT_REMINDER_MODE,
      options: REMINDER_MODE_OPTIONS,
      list,
      pendingCount: list.filter((/** @type {any} */ item) => item.state === "pending").length,
      unreadCount: list.filter((/** @type {any} */ item) => item.state === "fired" && item.unread)
        .length,
      armed: this.reminderArming,
      scheduleAvailable: Boolean(schedule && typeof schedule.create === "function"),
    };
  }

  /**
   * F30：改项目默认模式（timer 免费 / schedule 计费）。
   * @param {string} projectId @param {unknown} mode
   * @returns {any}
   */
  setReminderDefault(projectId, mode) {
    const store = this.requireStore();
    const value = normalizeReminderMode(mode);
    if (value === "") return { ok: false, reason: "reminder/unknown-mode" };
    const written = store.setReminderDefault(projectId, value);
    store.appendAudit({ action: "reminder/default", projectId, mode: value });
    store.save();
    return { ok: true, reminderDefault: written.reminderDefault };
  }

  /**
   * F30：新建提醒。
   * - timer：只落本地 + 起 setTimeout（重启由 armReminders 恢复）；
   * - schedule：转宿主 `schedule.create`（到点会跑一次模型），本地记 scheduleId。
   * @param {string} projectId @param {any} input
   * @returns {Promise<any>}
   */
  async createReminder(projectId, input) {
    const store = this.requireStore();
    const project = store.getProject(projectId);
    if (!project) throw new Error(`projects: unknown project ${projectId}`);
    const mode = resolveReminderMode(project.reminderDefault, input?.mode);
    const checked = validateReminderInput({ at: input?.at, text: input?.text, mode });
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const value = checked.value;
    const reminderId = newReminderId();
    let scheduleId = "";
    if (value.mode === "schedule") {
      const schedule = this.scheduleHost();
      if (!schedule || typeof schedule.create !== "function") {
        return { ok: false, reason: "schedule-unavailable" };
      }
      const cwd =
        Array.isArray(project.dirs) && project.dirs.length > 0 ? project.dirs[0] : this.dataRoot;
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        /* 目录问题由宿主 create 报出真正原因 */
      }
      try {
        const created = await schedule.create({
          title: `提醒：${String(project.name ?? projectId)}`.slice(0, 120),
          prompt: `提醒（${new Date(value.at).toLocaleString()}）：${value.text}`,
          timing: scheduleTimingFor(value.at, Date.now(), this.hostTimeZone()),
          target: { kind: "new", create: { cwd } },
        });
        scheduleId = String(created?.id ?? "");
        if (scheduleId === "") return { ok: false, reason: "schedule/no-id" };
      } catch (error) {
        return {
          ok: false,
          reason: `schedule/create-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
        };
      }
    }
    const added = store.addReminder(projectId, {
      id: reminderId,
      projectId,
      at: value.at,
      text: value.text,
      mode: value.mode,
      state: "pending",
      createdAt: new Date().toISOString(),
      scheduleId,
    });
    store.appendAudit({
      action: "reminder/created",
      projectId,
      reminderId,
      mode: value.mode,
      at: value.at,
    });
    store.save();
    if (value.mode === "timer") this.armReminders();
    return {
      ok: true,
      reminder: { ...added.reminder, remaining: remainingTime(value.at, Date.now()) },
      mode: value.mode,
      scheduleId,
    };
  }

  /**
   * F30：取消（schedule 模式同时删宿主条目）。
   * @param {string} projectId @param {string} reminderId
   * @returns {Promise<any>}
   */
  async cancelReminder(projectId, reminderId) {
    const store = this.requireStore();
    const reminder = store
      .listReminders(projectId)
      .find((/** @type {any} */ item) => item.id === reminderId);
    if (!reminder) return { ok: false, reason: "reminder/not-found" };
    if (reminder.state !== "pending")
      return { ok: false, reason: `reminder/not-pending:${reminder.state}` };
    if (reminder.scheduleId !== "") {
      const schedule = this.scheduleHost();
      if (schedule && typeof schedule.edit === "function") {
        try {
          await schedule.edit({ id: reminder.scheduleId, action: "delete" });
        } catch (error) {
          return {
            ok: false,
            reason: `schedule/delete-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
          };
        }
      }
    }
    const patched = store.patchReminder(projectId, reminderId, markCancelled(reminder, Date.now()));
    store.appendAudit({ action: "reminder/cancelled", projectId, reminderId });
    store.save();
    if (reminder.mode === "timer") this.armReminders();
    return { ok: true, reminder: patched.reminder };
  }

  /**
   * F30：提前完成（还没响就被处理掉；不会触发 toast）。
   * @param {string} projectId @param {string} reminderId
   * @returns {Promise<any>}
   */
  async completeReminder(projectId, reminderId) {
    const store = this.requireStore();
    const reminder = store
      .listReminders(projectId)
      .find((/** @type {any} */ item) => item.id === reminderId);
    if (!reminder) return { ok: false, reason: "reminder/not-found" };
    if (reminder.state === "pending" && reminder.scheduleId !== "") {
      const schedule = this.scheduleHost();
      if (schedule && typeof schedule.edit === "function") {
        try {
          await schedule.edit({ id: reminder.scheduleId, action: "delete" });
        } catch (error) {
          return {
            ok: false,
            reason: `schedule/delete-failed:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`,
          };
        }
      }
    }
    const patched = store.patchReminder(projectId, reminderId, markDone(reminder, Date.now()));
    store.appendAudit({ action: "reminder/completed", projectId, reminderId });
    store.save();
    if (reminder.mode === "timer") this.armReminders();
    return { ok: true, reminder: patched.reminder };
  }

  /**
   * F30：到点但还没通知过的提醒（通知器轮询它来弹 toast；弹过就 ack）。
   * @param {string} projectId
   * @returns {any}
   */
  dueReminders(projectId) {
    const store = this.requireStore();
    const list = store.listReminders(projectId);
    const unread = list.filter(
      (/** @type {any} */ item) => item.state === "fired" && item.unread === true,
    );
    return {
      projectId,
      todo: unread.filter((/** @type {any} */ item) => item.notified !== true),
      unreadCount: unread.length,
      armed: this.reminderArming,
    };
  }

  /**
   * F30：**全部项目**的到点提醒（通知器只发一次 listProjects，但 toast 要跨项目）。
   * @returns {any}
   */
  allDueReminders() {
    if (!this.store) return { projects: [], todo: [], armed: this.reminderArming };
    /** @type {any[]} */
    const todo = [];
    /** @type {any[]} */
    const projects = [];
    for (const project of this.store.listProjects()) {
      const view = this.dueReminders(String(project.id));
      if (view.todo.length > 0) {
        projects.push({ projectId: project.id, name: project.name });
        todo.push(
          ...view.todo.map((/** @type {any} */ item) => ({ ...item, projectId: project.id })),
        );
      }
    }
    return { projects, todo, armed: this.reminderArming };
  }

  /**
   * F30：toast 已展示 → 标 notified（避免关掉面板又弹一次）。
   * @param {string} projectId @param {string} reminderId
   * @returns {any}
   */
  ackReminder(projectId, reminderId) {
    const store = this.requireStore();
    const reminder = store
      .listReminders(projectId)
      .find((/** @type {any} */ item) => item.id === reminderId);
    if (!reminder) return { ok: false, reason: "reminder/not-found" };
    const patched = store.patchReminder(projectId, reminderId, { notified: true, unread: false });
    store.save();
    return { ok: true, reminder: patched.reminder };
  }

  /**
   * F30：按盘上记录重建本机计时器。启动、创建/取消/完成之后都调一次（幂等）。
   * 返回的 `armed/overdue` 是「现在有几条真的在等」的证据，UI 直接显示。
   * @returns {{ at: number, armed: number, overdue: number }}
   */
  armReminders() {
    for (const timer of this.reminderTimers.values()) {
      try {
        clearTimeout(timer);
      } catch {
        /* ignore */
      }
    }
    this.reminderTimers.clear();
    if (!this.store) {
      this.reminderArming = { at: Date.now(), armed: 0, overdue: 0 };
      return this.reminderArming;
    }
    const timers = this.store
      .listAllReminders()
      .filter(
        (/** @type {any} */ reminder) => reminder.mode === "timer" && reminder.state === "pending",
      );
    const now = Date.now();
    const plan = planReminderRecovery(timers, now);
    for (const item of plan.arm) {
      const reminder = timers.find((/** @type {any} */ record) => record.id === item.id);
      if (!reminder) continue;
      const projectId = String(reminder.projectId ?? "");
      // setTimeout 的上限是 2^31-1 ms（约 24.8 天）；更远的先挂一段，到点再判断。
      const delay = Math.min(item.delayMs, 2_000_000_000);
      const timer = setTimeout(() => {
        this.reminderTimers.delete(item.id);
        this.fireReminder(projectId, item.id);
      }, delay);
      timer?.unref?.();
      this.reminderTimers.set(item.id, timer);
    }
    this.reminderArming = { at: now, armed: plan.arm.length, overdue: plan.overdue.length };
    this.logger?.info?.(
      `[projects] reminders armed: ${plan.arm.length} (overdue ${plan.overdue.length})`,
    );
    return this.reminderArming;
  }

  /**
   * F30：一条提醒到点。到期就写回盘（state=fired + unread），没到期就再排一次
   * （`>>>` 上限导致的提前唤醒会走到这里；重启恢复的「关机期间到点」也是这条路径）。
   * @param {string} projectId @param {string} reminderId
   * @returns {any}
   */
  fireReminder(projectId, reminderId) {
    const store = this.store;
    if (!store) return { ok: false, reason: "store-unavailable" };
    const reminder = store
      .listReminders(projectId)
      .find((/** @type {any} */ item) => item.id === reminderId);
    if (reminder?.state !== "pending") return { ok: false, reason: "reminder/not-pending" };
    const dueAt = Date.parse(String(reminder.at));
    const now = Date.now();
    if (Number.isFinite(dueAt) && dueAt > now) {
      const timer = setTimeout(
        () => {
          this.reminderTimers.delete(reminderId);
          this.fireReminder(projectId, reminderId);
        },
        Math.min(dueAt - now, 2_000_000_000),
      );
      timer?.unref?.();
      this.reminderTimers.set(reminderId, timer);
      return { ok: false, reason: "reminder/not-due-yet" };
    }
    const patched = store.patchReminder(projectId, reminderId, markFired(reminder, now));
    store.appendAudit({ action: "reminder/fired", projectId, reminderId });
    store.save();
    return { ok: true, reminder: patched.reminder };
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
declareRemote(ProjectsService, "setProjectPinned");
declareRemote(ProjectsService, "resolveThread");
declareRemote(ProjectsService, "checkAutoResolve");
declareRemote(ProjectsService, "setAutoResolveDays");
declareRemote(ProjectsService, "addView");
declareRemote(ProjectsService, "prOverview");
declareRemote(ProjectsService, "mergePr");
declareRemote(ProjectsService, "setVisibleViews");
declareRemote(ProjectsService, "deleteView");
declareRemote(ProjectsService, "setThreadUnread");
declareRemote(ProjectsService, "uiState");
declareRemote(ProjectsService, "setFirstRunDone");
declareRemote(ProjectsService, "setGroupCollapsed");
declareRemote(ProjectsService, "reconcileWakes");
declareRemote(ProjectsService, "purgeTrash");
declareRemote(ProjectsService, "cleanupBranches");
declareRemote(ProjectsService, "listTrash");
declareRemote(ProjectsService, "restoreTrash");
declareRemote(ProjectsService, "deleteTrashEntry");
declareRemote(ProjectsService, "emptyTrash");
declareRemote(ProjectsService, "previewDeleteProject");
declareRemote(ProjectsService, "deleteProject");
declareRemote(ProjectsService, "attachThread");
declareRemote(ProjectsService, "detachThread");
declareRemote(ProjectsService, "createThread");
declareRemote(ProjectsService, "reclaimThread");
declareRemote(ProjectsService, "progress");
declareRemote(ProjectsService, "threadStates");
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
declareRemote(ProjectsService, "setProjectInstructions");
declareRemote(ProjectsService, "inspectDir");
declareRemote(ProjectsService, "listAudit");
declareRemote(ProjectsService, "sendToCoordinator");
declareRemote(ProjectsService, "coordinatorView");
declareRemote(ProjectsService, "restartCoordinator");
declareRemote(ProjectsService, "steerThread");
declareRemote(ProjectsService, "modelCatalog");
declareRemote(ProjectsService, "selectThreadModel");
// F17：Tasks 明细走 `progress()` 的行内 `tasks` 字段；单独的 threadTasks RPC 已删（零调用者）。
declareRemote(ProjectsService, "createPr");
declareRemote(ProjectsService, "pollPrs");
declareRemote(ProjectsService, "prPollState");
declareRemote(ProjectsService, "setPrPolling");
declareRemote(ProjectsService, "setRealtimeCi");
declareRemote(ProjectsService, "realtimeCiSpec");
declareRemote(ProjectsService, "addMemoryFragment");
declareRemote(ProjectsService, "listMemoryFragments");
declareRemote(ProjectsService, "readMemoryFragment");
declareRemote(ProjectsService, "forgetMemory");
declareRemote(ProjectsService, "setBudget");
declareRemote(ProjectsService, "setNotifyPrefs");
declareRemote(ProjectsService, "renameThread");
declareRemote(ProjectsService, "authorizeFolder");
declareRemote(ProjectsService, "consumeFolderGrant");
declareRemote(ProjectsService, "githubCheck");
declareRemote(ProjectsService, "applyProjectTemplate");
declareRemote(ProjectsService, "usageView");
declareRemote(ProjectsService, "mentionItems");
declareRemote(ProjectsService, "recentSessions");
declareRemote(ProjectsService, "setThreadDefaults");
declareRemote(ProjectsService, "setCoordinatorDefaults");
// B5 · F33/F34 Library
declareRemote(ProjectsService, "libraryView");
declareRemote(ProjectsService, "recordArtifact");
declareRemote(ProjectsService, "searchLibraryFiles");
// B4 · F52 权限收窄
declareRemote(ProjectsService, "permissionCatalog");
declareRemote(ProjectsService, "permissionState");
declareRemote(ProjectsService, "setProjectPreset");
declareRemote(ProjectsService, "applyProjectPreset");
// B4 · F36 Routines
declareRemote(ProjectsService, "routinesView");
declareRemote(ProjectsService, "createRoutine");
declareRemote(ProjectsService, "setRoutineEnabled");
declareRemote(ProjectsService, "updateRoutine");
declareRemote(ProjectsService, "deleteRoutine");
declareRemote(ProjectsService, "runRoutineNow");
declareRemote(ProjectsService, "routineHistory");
// B4 · F30 双模式提醒
declareRemote(ProjectsService, "remindersView");
declareRemote(ProjectsService, "setReminderDefault");
declareRemote(ProjectsService, "createReminder");
declareRemote(ProjectsService, "cancelReminder");
declareRemote(ProjectsService, "completeReminder");
declareRemote(ProjectsService, "dueReminders");
declareRemote(ProjectsService, "allDueReminders");
declareRemote(ProjectsService, "ackReminder");
