// @ts-check
// 项目仓储：元数据的唯一真源。
// 为什么不用 ctx.storage.domain：M1 阶段元数据需要「人可读 + 可测试 + 可导出」，
// 先用带原子写的 JSON 仓储，把 schema 版本与迁移握在自己手里；M2 再评估迁到 storageDomain
// （届时用同一套 spec 形状，迁移点集中在 load/save 两处）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultRules } from "./routing.js";

/** 当前元数据格式版本。任何不兼容变更都要 +1 并在 migrate() 里补一步。 */
export const FORMAT_VERSION = 1;

/**
 * @typedef {object} ProjectPolicy
 * @property {'L0'|'L1'|'L2'|'L3'} autonomy
 * @property {readonly string[]} preapprove
 * @property {Record<string, boolean>} danger 危险动作开关，默认全 false
 * @property {{ rules: any[], fallback: boolean }} routing 路由规则（扁平结构）与是否允许模型兜底
 * @property {string} persona 协调器人格；空串表示用内置默认人格
 * @property {Record<string, true>} repoGrants 直推保护分支的 per-repo 首次授予
 * @property {{minApprovals:number, maxDiffFiles:number, maxDiffLines:number}} merge 合并门槛
 */

/**
 * @typedef {object} ProjectRecord
 * @property {string} id
 * @property {string} name
 * @property {string} goal
 * @property {'active'|'paused'|'archived'} state
 * @property {string[]} dirs
 * @property {string|null} coordinatorSessionId
 * @property {ProjectPolicy} policy
 * @property {{dailyTokens:number|null, maxThreadsPerDay:number|null, maxStepsPerThread:number|null}} budget
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} ThreadRecord
 * @property {string} projectId
 * @property {'idle'|'working'|'waiting'|'done'|'failed'} state
 * @property {string|null} branch
 * @property {string|null} lastPushedSha
 * @property {string|null} baseSha
 * @property {string|null} worktree
 * @property {number} seq
 */

/** 危险动作开关的默认值：全部关闭（"归档"是可逆动作，由 state 表达，不在此列）。 */
export const DEFAULT_DANGER = Object.freeze({
  forcePushOwnBranch: false,
  pushProtectedBranch: false,
  autoMerge: false,
  trashAuto: false,
  purgeAfterRetention: false,
  editProfile: false,
});

/** @returns {ProjectPolicy} */
export function defaultPolicy() {
  return {
    autonomy: "L1",
    preapprove: [],
    danger: { ...DEFAULT_DANGER },
    // 路由：扁平规则数组 + 是否允许模型兜底（兜底也只能提议，不能直接执行危险动作）
    routing: { rules: defaultRules(), fallback: true },
    // 协调器人格；空串表示用内置默认人格
    persona: "",
    // 直推保护分支的 per-repo 首次授予：只有显式 true 的仓库才允许
    repoGrants: {},
    // 合并门槛（规格 §7.5 行 3 的 ④⑤）：默认要求 1 个人批过
    merge: { minApprovals: 1, maxDiffFiles: 20, maxDiffLines: 600 },
  };
}

/**
 * 把任意 policy 收敛成合法形状（缺失补齐、类型纠正、危险开关默认关）。
 * normalize() 与 updateProject() 共用，避免两套规则漂移。
 * @param {any} raw
 * @param {any} [fallbackPolicy] 未指定的字段从这里继承
 */
export function normalizePolicy(raw, fallbackPolicy) {
  const policy = raw && typeof raw === "object" ? raw : {};
  const previous = fallbackPolicy && typeof fallbackPolicy === "object" ? fallbackPolicy : {};
  const routingRaw = policy.routing ?? previous.routing ?? {};
  const levels = ["L0", "L1", "L2", "L3"];
  return {
    autonomy: levels.includes(policy.autonomy)
      ? policy.autonomy
      : levels.includes(previous.autonomy)
        ? previous.autonomy
        : "L1",
    preapprove: Array.isArray(policy.preapprove)
      ? policy.preapprove
      : Array.isArray(previous.preapprove)
        ? previous.preapprove
        : [],
    danger: {
      ...DEFAULT_DANGER,
      ...(previous.danger && typeof previous.danger === "object" ? previous.danger : {}),
      ...(policy.danger && typeof policy.danger === "object" ? policy.danger : {}),
    },
    routing: {
      rules: Array.isArray(routingRaw?.rules) ? routingRaw.rules : [],
      fallback: routingRaw?.fallback !== false,
    },
    persona:
      typeof policy.persona === "string"
        ? policy.persona
        : typeof previous.persona === "string"
          ? previous.persona
          : "",
    merge: (() => {
      const raw = policy.merge ?? previous.merge ?? {};
      const num = (/** @type {any} */ value, /** @type {number} */ fallback) =>
        Number.isFinite(value) ? Math.max(0, Number(value)) : fallback;
      return {
        minApprovals: num(raw.minApprovals, 1),
        maxDiffFiles: num(raw.maxDiffFiles, 20),
        maxDiffLines: num(raw.maxDiffLines, 600),
      };
    })(),
    // 只接受显式 true 的仓库授权；其它写法一律当没授权
    repoGrants: (() => {
      const pick = (/** @type {any} */ source) =>
        source && typeof source === "object" && !Array.isArray(source)
          ? Object.fromEntries(
              Object.entries(source).filter(
                ([key, value]) => typeof key === "string" && value === true,
              ),
            )
          : {};
      const fromPolicy = pick(policy.repoGrants);
      return Object.keys(fromPolicy).length > 0 ? fromPolicy : pick(previous.repoGrants);
    })(),
  };
}

/** @param {number} [now] */
function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

/** @param {string} path @returns {any} */
function emptyState(path) {
  return {
    format: FORMAT_VERSION,
    root: path,
    projects: {},
    threads: {},
    audit: [],
    approvals: [],
  };
}

/**
 * 把任意输入收敛成合法状态；不认识的字段保留（前向兼容），缺失的补齐。
 * @param {any} raw
 * @param {string} root
 */
export function normalize(raw, root) {
  const state = emptyState(root);
  if (!raw || typeof raw !== "object") return state;
  const format = Number.isInteger(raw.format) ? raw.format : 0;
  if (format > FORMAT_VERSION) {
    throw new Error(
      `projects: metadata format ${format} is newer than supported ${FORMAT_VERSION}`,
    );
  }
  state.format = Math.max(FORMAT_VERSION, format === 0 ? FORMAT_VERSION : format);
  if (raw.projects && typeof raw.projects === "object") {
    for (const [id, value] of Object.entries(raw.projects)) {
      if (!value || typeof value !== "object") continue;
      const project = /** @type {any} */ (value);
      state.projects[id] = {
        ...project,
        id,
        name: typeof project.name === "string" ? project.name : id,
        goal: typeof project.goal === "string" ? project.goal : "",
        state: ["active", "paused", "archived"].includes(project.state) ? project.state : "active",
        dirs: Array.isArray(project.dirs)
          ? project.dirs.filter((/** @type {unknown} */ d) => typeof d === "string")
          : [],
        coordinatorSessionId:
          typeof project.coordinatorSessionId === "string" ? project.coordinatorSessionId : null,
        policy: normalizePolicy(project.policy),
        budget: {
          dailyTokens:
            typeof project.budget?.dailyTokens === "number" ? project.budget.dailyTokens : null,
          maxThreadsPerDay:
            typeof project.budget?.maxThreadsPerDay === "number"
              ? project.budget.maxThreadsPerDay
              : null,
          maxStepsPerThread:
            typeof project.budget?.maxStepsPerThread === "number"
              ? project.budget.maxStepsPerThread
              : null,
        },
        createdAt: typeof project.createdAt === "string" ? project.createdAt : iso(),
        updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : iso(),
      };
    }
  }
  if (raw.threads && typeof raw.threads === "object") {
    for (const [sessionId, value] of Object.entries(raw.threads)) {
      const thread = /** @type {any} */ (value);
      if (!thread || typeof thread.projectId !== "string") continue;
      state.threads[sessionId] = {
        ...thread,
        projectId: thread.projectId,
        state: ["idle", "working", "waiting", "done", "failed"].includes(thread.state)
          ? thread.state
          : "idle",
        branch: typeof thread.branch === "string" ? thread.branch : null,
        lastPushedSha: typeof thread.lastPushedSha === "string" ? thread.lastPushedSha : null,
        baseSha: typeof thread.baseSha === "string" ? thread.baseSha : null,
        worktree: typeof thread.worktree === "string" ? thread.worktree : null,
        seq: Number.isInteger(thread.seq) ? thread.seq : 0,
        createdAt: typeof thread.createdAt === "string" ? thread.createdAt : iso(),
        lastWakeTurn: Number.isInteger(thread.lastWakeTurn) ? thread.lastWakeTurn : 0,
        autoFixRound: Number.isInteger(thread.autoFixRound) ? thread.autoFixRound : 0,
        autoFixSignature:
          typeof thread.autoFixSignature === "string" ? thread.autoFixSignature : "",
        autoFixChanged: Array.isArray(thread.autoFixChanged) ? thread.autoFixChanged : [],
      };
    }
  }
  if (Array.isArray(raw.audit)) state.audit = raw.audit.slice(-5000);
  state.approvals = Array.isArray(raw.approvals) ? raw.approvals : [];
  state.usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  return state;
}

/** 稳定的短 id（不引入依赖：时间戳 + 随机段）。 */
export function newProjectId(/** @type {number} */ now = Date.now()) {
  const random = Math.random().toString(36).slice(2, 10);
  return `prj_${now.toString(36)}${random}`;
}

export class ProjectStore {
  /** @type {any} */
  state;

  /**
   * @param {{root: string, now?: () => number}} options
   */
  constructor(options) {
    if (!options || typeof options.root !== "string" || options.root === "") {
      throw new Error("projects: store requires an injectable data root");
    }
    this.root = options.root;
    this.file = join(options.root, "projects.json");
    this.now = options.now ?? (() => Date.now());
    /** @type {any} */
    this.state = emptyState(this.root);
  }

  load() {
    if (!existsSync(this.file)) {
      mkdirSync(dirname(this.file), { recursive: true });
      this.state = emptyState(this.root);
      return this;
    }
    const text = readFileSync(this.file, "utf8");
    /** @type {any} */
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (_error) {
      // 不认识的/损坏的文件不删：改名隔离后从空状态起步（硬性约定 1：保留而非 rm -rf）
      const quarantine = `${this.file}.corrupt-${this.now()}`;
      try {
        renameSync(this.file, quarantine);
      } catch {
        /* 隔离失败就保留原文件 */
      }
      throw new Error(`projects: metadata is not valid JSON, quarantined to ${quarantine}`);
    }
    this.state = normalize(raw, this.root);
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${this.now()}`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    return this;
  }

  /** @param {string} name @param {{goal?: string, dirs?: string[], template?: boolean}} [input] */
  createProject(name, input = {}) {
    const trimmed = String(name ?? "").trim();
    if (trimmed === "") throw new Error("projects: project name is required");
    const id = newProjectId(this.now());
    const stamp = iso(this.now());
    this.state.projects[id] = {
      id,
      name: trimmed,
      goal: typeof input.goal === "string" ? input.goal : "",
      state: "active",
      dirs: Array.isArray(input.dirs) ? input.dirs.filter((d) => typeof d === "string") : [],
      coordinatorSessionId: null,
      policy: defaultPolicy(),
      budget: {
        dailyTokens: null,
        maxThreadsPerDay: null,
        maxStepsPerThread: null,
        maxConcurrent: null,
      },
      createdAt: stamp,
      updatedAt: stamp,
    };
    return { ...this.state.projects[id] };
  }

  /** @param {string} id */
  getProject(id) {
    const found = this.state.projects[id];
    return found ? { ...found } : undefined;
  }

  listProjects() {
    return Object.values(this.state.projects).map((/** @type {any} */ p) => ({ ...p }));
  }

  /**
   * @param {string} id
   * @param {Partial<{name: string, goal: string, state: string, dirs: string[], coordinatorSessionId: string|null, policy: any, persona: string, budget: any}>} patch
   */
  updateProject(id, patch) {
    const current = this.state.projects[id];
    if (!current) throw new Error(`projects: unknown project ${id}`);
    const next = { ...current };
    if (typeof patch.name === "string" && patch.name.trim() !== "") next.name = patch.name.trim();
    if (typeof patch.goal === "string") next.goal = patch.goal;
    if (["active", "paused", "archived"].includes(String(patch.state))) next.state = patch.state;
    if (Array.isArray(patch.dirs))
      next.dirs = patch.dirs.filter((/** @type {unknown} */ d) => typeof d === "string");
    if (patch.coordinatorSessionId === null || typeof patch.coordinatorSessionId === "string") {
      next.coordinatorSessionId = patch.coordinatorSessionId;
    }
    if (patch.policy && typeof patch.policy === "object") {
      next.policy = normalizePolicy(patch.policy, current.policy);
    }
    if (typeof patch.persona === "string") {
      next.policy = normalizePolicy(
        { ...(next.policy ?? current.policy), persona: patch.persona },
        current.policy,
      );
    }
    if (patch.budget && typeof patch.budget === "object") {
      next.budget = { ...(current.budget ?? {}), ...patch.budget };
    }
    next.updatedAt = iso(this.now());
    this.state.projects[id] = next;
    return { ...next };
  }

  /**
   * 归档是唯一"默认开启"的自动化动作；它可逆，且不删数据。
   * @param {string} id
   */
  archiveProject(id) {
    return this.updateProject(id, { state: "archived" });
  }

  /** @param {string} sessionId @param {string} projectId */
  attachThread(sessionId, projectId) {
    if (!this.state.projects[projectId]) throw new Error(`projects: unknown project ${projectId}`);
    const current = this.state.threads[sessionId];
    this.state.threads[sessionId] = {
      projectId,
      state: current?.state ?? "idle",
      branch: current?.branch ?? null,
      worktree: current?.worktree ?? null,
      seq: current?.seq ?? 0,
      createdAt: current?.createdAt ?? iso(this.now()),
      lastWakeTurn: current?.lastWakeTurn ?? 0,
      autoFixRound: current?.autoFixRound ?? 0,
      autoFixSignature: current?.autoFixSignature ?? "",
      autoFixChanged: current?.autoFixChanged ?? [],
    };
    return { ...this.state.threads[sessionId] };
  }

  /**
   * 删除一个项目记录，并摘掉它的线程归属（**不动会话日志**）。
   * 返回被删内容，供调用方写进回收站清单。
   * @param {string} id
   */
  removeProject(id) {
    const project = this.state.projects[id];
    if (!project) throw new Error(`projects: unknown project ${id}`);
    const threads = Object.entries(this.state.threads)
      .filter(([, thread]) => /** @type {any} */ (thread).projectId === id)
      .map(([sessionId, thread]) => ({ sessionId, .../** @type {any} */ (thread) }));
    delete this.state.projects[id];
    for (const thread of threads) delete this.state.threads[thread.sessionId];
    return { project: { ...project }, threads };
  }

  /**
   * 记录线程的 worktree 归属（建 worktree 成功后调用）。
   * @param {string} sessionId
   * @param {{ branch?: string|null, worktree?: string|null, baseSha?: string|null, lastPushedSha?: string|null, state?: string, prNumber?: number, mergedAt?: string|null }} patch
   */
  setThreadWorktree(sessionId, patch) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    if (typeof patch.branch === "string" || patch.branch === null) current.branch = patch.branch;
    if (typeof patch.lastPushedSha === "string" || patch.lastPushedSha === null) {
      current.lastPushedSha = patch.lastPushedSha;
    }
    if (typeof patch.worktree === "string" || patch.worktree === null)
      current.worktree = patch.worktree;
    if (typeof patch.baseSha === "string" || patch.baseSha === null)
      current.baseSha = patch.baseSha;
    if (typeof patch.state === "string") current.state = patch.state;
    // 线程 ↔ PR 关联：合并成功时据此标记，回收判据才敢放行 squash 合并的分支
    if (Number.isFinite(patch.prNumber)) current.prNumber = Number(patch.prNumber);
    if (typeof patch.mergedAt === "string" || patch.mergedAt === null)
      current.mergedAt = patch.mergedAt;
    return { ...current };
  }

  /**
   * 累加今天的 token 花费（按项目 + 本地日期分桶，跨重启保留）。
   * @param {string} projectId
   * @param {number} tokens
   * @param {number} [now]
   * @returns {{ date: string, tokens: number }}
   */
  /**
   * 把回收站里的项目放回仓储（规格 §7.5 行 4a 的可恢复性）。
   * 同 id 已存在时拒绝，不覆盖当前项目。
   * @param {{ project: any, threads: any[] }} input
   */
  restoreProject(input) {
    const project = input?.project;
    const threads = Array.isArray(input?.threads) ? input.threads : [];
    const id = String(project?.id ?? "");
    if (id === "") throw new Error("projects: restoreProject requires project.id");
    if (this.state.projects[id]) throw new Error(`projects: project already exists ${id}`);
    // 恢复要**保留原状态**：归档的仍是归档、暂停的仍是暂停，别把用户显式设过的状态抹掉
    const state = ["active", "paused", "archived"].includes(String(project?.state))
      ? String(project.state)
      : "active";
    this.state.projects[id] = { ...project, state };
    for (const thread of threads) {
      const sessionId = String(thread?.sessionId ?? "");
      if (sessionId === "") continue;
      const { sessionId: _ignored, ...rest } = thread;
      this.state.threads[sessionId] = { ...rest, projectId: id };
    }
    return { project: { ...this.state.projects[id] }, threadCount: threads.length };
  }

  /**
   * 记 token 用量。**按天分桶**（周预算要跨天求和，单日桶算不出来）。
   * 保留最近 21 天，避免无限增长；兼容旧的 `{date, tokens}` 形状。
   * @param {string} projectId @param {number} tokens @param {number} [now]
   */
  addTokenUsage(projectId, tokens, now = this.now()) {
    const amount = Number.isFinite(tokens) ? Math.max(0, Math.trunc(Number(tokens))) : 0;
    const date = new Date(now).toISOString().slice(0, 10);
    this.state.usage = this.state.usage ?? {};
    const bucket = this.state.usage[projectId] ?? { days: {} };
    // 旧形状（单日桶）迁移成按天表
    if (!bucket.days) {
      bucket.days = {};
      if (typeof bucket.date === "string") bucket.days[bucket.date] = Number(bucket.tokens ?? 0);
      delete bucket.date;
      delete bucket.tokens;
    }
    bucket.days[date] = (Number(bucket.days[date]) || 0) + amount;
    const keys = Object.keys(bucket.days).sort();
    for (const stale of keys.slice(0, Math.max(0, keys.length - 21))) delete bucket.days[stale];
    this.state.usage[projectId] = bucket;
    return { date, tokens: bucket.days[date] };
  }

  /**
   * 指定日期（本地日）的用量。
   * @param {string} projectId @param {number} [now]
   * @returns {number}
   */
  tokenUsageToday(projectId, now = this.now()) {
    return this.tokenUsageOn(projectId, now);
  }

  /**
   * 某一天的用量。
   * @param {string} projectId @param {number} [now]
   * @returns {number}
   */
  tokenUsageOn(projectId, now = this.now()) {
    const date = new Date(now).toISOString().slice(0, 10);
    const bucket = this.state.usage?.[projectId];
    if (!bucket) return 0;
    if (bucket.days) return Number(bucket.days[date]) || 0;
    return bucket.date === date ? Number(bucket.tokens) || 0 : 0; // 旧形状兜底
  }

  /**
   * 从某个时刻（含）起的累计用量（周预算用）。
   * @param {string} projectId @param {number} [fromMs]
   * @returns {number}
   */
  tokenUsageSince(projectId, fromMs = 0) {
    const bucket = this.state.usage?.[projectId];
    if (!bucket) return 0;
    const fromDate = new Date(fromMs).toISOString().slice(0, 10);
    if (bucket.days) {
      return Object.entries(bucket.days)
        .filter(([date]) => date >= fromDate)
        .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
    }
    return Number(bucket.tokens) || 0; // 旧形状：只有一天的量
  }

  /**
   * 记录 auto-fix 进度（轮次 / 上次错误签名 / 上次改动文件）。
   * @param {string} sessionId
   * @param {{ round?: number, signature?: string, changedFiles?: string[] }} patch
   */
  setThreadAutoFix(sessionId, patch) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    if (Number.isInteger(patch.round)) current.autoFixRound = patch.round;
    if (typeof patch.signature === "string") current.autoFixSignature = patch.signature;
    if (Array.isArray(patch.changedFiles)) current.autoFixChanged = patch.changedFiles;
    return { ...current };
  }

  /**
   * 记录线程已经唤醒到第几轮（避免同一轮重复唤醒协调器）。
   * @param {string} sessionId
   * @param {number} turn
   */
  setThreadWakeState(sessionId, turn) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    current.lastWakeTurn = Number.isInteger(turn) ? turn : (current.lastWakeTurn ?? 0);
    return { ...current };
  }

  /**
   * 记录一条待审批的危险动作申请。
   * @param {{ projectId: string, action: string, args?: any, reason: string }} request
   * @returns {{ requestId: string }}
   */
  appendApproval(request) {
    const requestId = `apr_${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.state.approvals.push({
      requestId,
      projectId: String(request.projectId),
      action: String(request.action),
      args: request.args ?? null,
      reason: String(request.reason ?? ""),
      status: "pending",
      at: iso(this.now()),
      resolvedAt: null,
    });
    return { requestId };
  }

  /**
   * @param {string} [projectId] 省略则返回全部
   * @returns {any[]}
   */
  listApprovals(projectId) {
    return this.state.approvals.filter((/** @type {any} */ item) =>
      projectId ? item.projectId === projectId : true,
    );
  }

  /**
   * 标记一条申请已执行（幂等保护：同一申请不能执行两次）。
   * @param {string} requestId
   * @param {any} [evidence]
   */
  /**
   * 占位（claim）：真正执行**之前**先原子占用，防并发重复执行。
   * 与 executedAt 分开存：占位失败可释放，已执行则不可再动。
   * @param {string} requestId
   * @returns {{ requestId: string }}
   */
  claimApproval(requestId) {
    const found = this.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === requestId,
    );
    if (!found) throw new Error(`projects: unknown approval ${requestId}`);
    if (typeof found.executedAt === "string" && found.executedAt !== "") {
      throw new Error(`projects: approval ${requestId} already executed`);
    }
    if (typeof found.claimedAt === "string" && found.claimedAt !== "") {
      throw new Error(`projects: approval ${requestId} already claimed`);
    }
    found.claimedAt = iso(this.now());
    return { requestId };
  }

  /**
   * 释放占位：执行被拒绝或失败时调用，让同一张申请还能重试。
   * 已执行的申请不会被释放（宁可留痕，也不给重复执行的缝隙）。
   * @param {string} requestId
   * @returns {boolean} 是否真的释放了
   */
  releaseApproval(requestId) {
    const found = this.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === requestId,
    );
    if (!found) return false;
    if (typeof found.executedAt === "string" && found.executedAt !== "") return false;
    if (typeof found.claimedAt !== "string" || found.claimedAt === "") return false;
    found.claimedAt = null;
    return true;
  }

  /**
   * @param {string} requestId
   * @param {any} [evidence]
   */
  markApprovalExecuted(requestId, evidence) {
    const found = this.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === requestId,
    );
    if (!found) throw new Error(`projects: unknown approval ${requestId}`);
    if (typeof found.executedAt === "string" && found.executedAt !== "") {
      throw new Error(`projects: approval ${requestId} already executed`);
    }
    found.executedAt = iso(this.now());
    found.claimedAt = null;
    found.evidence = evidence ?? null;
    return { ...found };
  }

  /**
   * 决议一条申请（approved / rejected）。只改状态，**不执行**动作。
   * @param {string} requestId
   * @param {"approved"|"rejected"} status
   */
  resolveApproval(requestId, status) {
    const found = this.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === requestId,
    );
    if (!found) throw new Error(`projects: unknown approval ${requestId}`);
    if (typeof found.executedAt === "string" && found.executedAt !== "") {
      throw new Error(`projects: approval ${requestId} already executed`);
    }
    found.status = status;
    found.resolvedAt = iso(this.now());
    return { ...found };
  }

  /** @param {string} sessionId */
  detachThread(sessionId) {
    const existed = Boolean(this.state.threads[sessionId]);
    delete this.state.threads[sessionId];
    return existed;
  }

  /** @param {string} sessionId */
  projectOfSession(sessionId) {
    const thread = this.state.threads[sessionId];
    if (!thread) return undefined;
    return this.getProject(thread.projectId);
  }

  /** @param {string} projectId */
  listThreads(projectId) {
    /** @type {any} */ (this.state);
    const entries = /** @type {Array<[string, any]>} */ (Object.entries(this.state.threads));
    return entries
      .filter(([, thread]) => thread.projectId === projectId)
      .map(([sessionId, thread]) => ({ sessionId, ...thread }));
  }

  /** @param {any} entry */
  appendAudit(entry) {
    this.state.audit.push({ at: iso(this.now()), ...entry });
    if (this.state.audit.length > 5000) this.state.audit.splice(0, this.state.audit.length - 5000);
  }

  /** 清空（仅测试与"删除数据"的显式动作使用）。 */
  destroy() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
