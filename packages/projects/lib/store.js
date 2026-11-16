// @ts-check
// 项目仓储：元数据的唯一真源。
// 为什么不用 ctx.storage.domain：M1 阶段元数据需要「人可读 + 可测试 + 可导出」，
// 先用带原子写的 JSON 仓储，把 schema 版本与迁移握在自己手里；M2 再评估迁到 storageDomain
// （届时用同一套 spec 形状，迁移点集中在 load/save 两处）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 当前元数据格式版本。任何不兼容变更都要 +1 并在 migrate() 里补一步。 */
export const FORMAT_VERSION = 1;

/**
 * @typedef {object} ProjectPolicy
 * @property {'L0'|'L1'|'L2'|'L3'} autonomy
 * @property {readonly string[]} preapprove
 * @property {Record<string, boolean>} danger 危险动作开关，默认全 false
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
        policy: {
          autonomy: ["L0", "L1", "L2", "L3"].includes(project.policy?.autonomy)
            ? project.policy.autonomy
            : "L1",
          preapprove: Array.isArray(project.policy?.preapprove) ? project.policy.preapprove : [],
          danger: { ...DEFAULT_DANGER, ...(project.policy?.danger ?? {}) },
        },
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
        worktree: typeof thread.worktree === "string" ? thread.worktree : null,
        seq: Number.isInteger(thread.seq) ? thread.seq : 0,
        createdAt: typeof thread.createdAt === "string" ? thread.createdAt : iso(),
      };
    }
  }
  if (Array.isArray(raw.audit)) state.audit = raw.audit.slice(-5000);
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

  /** @param {string} name @param {{goal?: string, dirs?: string[]}} [input] */
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
   * @param {Partial<{name: string, goal: string, state: string, dirs: string[], coordinatorSessionId: string|null}>} patch
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
    };
    return { ...this.state.threads[sessionId] };
  }

  /**
   * 记录线程的 worktree 归属（建 worktree 成功后调用）。
   * @param {string} sessionId
   * @param {{ branch?: string|null, worktree?: string|null, baseSha?: string|null, state?: string }} patch
   */
  setThreadWorktree(sessionId, patch) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    if (typeof patch.branch === "string" || patch.branch === null) current.branch = patch.branch;
    if (typeof patch.worktree === "string" || patch.worktree === null)
      current.worktree = patch.worktree;
    if (typeof patch.baseSha === "string" || patch.baseSha === null)
      current.baseSha = patch.baseSha;
    if (typeof patch.state === "string") current.state = patch.state;
    return { ...current };
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
