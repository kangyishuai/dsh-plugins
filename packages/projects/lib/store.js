// @ts-check
// 项目仓储：元数据的唯一真源。
// 为什么不用 ctx.storage.domain：M1 阶段元数据需要「人可读 + 可测试 + 可导出」，
// 先用带原子写的 JSON 仓储，把 schema 版本与迁移握在自己手里；M2 再评估迁到 storageDomain
// （届时用同一套 spec 形状，迁移点集中在 load/save 两处）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_BUDGET } from "./budget.js";
import { mergeArtifactRefs, normalizeArtifactRef } from "./library.js";
import { DEFAULT_NOTIFY_PREFS } from "./notify.js";
import { REPLAY_EVENT_CAP, THREAD_STATES } from "./overview.js";
import { DEFAULT_REMINDER_MODE, normalizeReminder } from "./reminders.js";
import { MAX_ROUTINES, normalizeRoutine } from "./routines.js";
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
 * @property {{tier:'off'|'draft'|'ready'|'auto-merge'}} pr PR 档位（F21/F22；per-project opt-out）
 */

/** 项目 Context 的上限（F2/F35）。宿主侧没有目录数配额，这个上限是产品约束 + 防误贴一大串路径。 */
export const MAX_DIRS = 10;
/** 项目可关联的 GitHub 仓库上限（F2 的 Context 多选里的「仓库」维度）。 */
export const MAX_REPOS = 10;
/** 图标是短标记（emoji 或一两个字符），不是图片路径。 */
export const MAX_ICON_LENGTH = 8;

/** F39：goal 上限（对齐 Claude Projects 的 8,000 字符）。 */
export const MAX_GOAL_CHARS = 8_000;

/** F23：线程标题上限（右键重命名）。 */
export const MAX_THREAD_TITLE_CHARS = 120;

/**
 * F42：线程默认 effort 的**上限**（只防超长垃圾，不做枚举白名单）。
 *
 * 为什么没有白名单：`reasoningEffort` 是**部署与模型给的枚举**，不是宿主的固定三档。
 * 本机实测默认档是 `max`，另有 `xhigh` / `off`；以前写死 ["low","medium","high"]
 * 会把这些值**静默清空**（normalizeThreadDefaults 丢值），而 UI 还提示「已保存」。
 * 合法性由写路径对照 modelCatalog.reasoning.efforts 校验（拿不到目录时按非空即收）。
 */
export const MAX_EFFORT_LENGTH = 40;

/**
 * 线程记录里允许持久化的 state 词表。
 *
 * 六态词表只有一份：`overview.js` 的 `THREAD_STATES`（`waiting-user` 带连字符）。
 * 这里另外接受 `waiting` / `done` 两个**旧数据 / 事件层原始态**：前者是 B1 之前写进去的
 * 历史拼写，后者是 `reduce()` 内部「一轮正常跑完」的原始事实（对外一律收敛成 idle）。
 * B1 审查 P0-2：以前白名单写的是 `waiting`，而 `deriveState()` 产出 `waiting-user`，
 * 于是「等你」永远写不进去；两端统一到这份词表后，写→回读才闭环。
 */
export const THREAD_STATE_VALUES = Object.freeze([...THREAD_STATES, "waiting", "done"]);

/** @param {unknown} value @returns {boolean} */
export function isThreadState(value) {
  return typeof value === "string" && THREAD_STATE_VALUES.includes(value);
}

/**
 * @typedef {object} ProjectRecord
 * @property {string} id
 * @property {string} name
 * @property {string} goal
 * @property {string} icon 项目图标（F1；短标记，默认空串 = 不显示）
 * @property {'active'|'paused'|'archived'} state
 * @property {string|null} archivedAt 归档时间（F1；未归档为 null）
 * @property {string[]} dirs 项目目录（F35：≤10，全部生效）
 * @property {string[]} repos 关联仓库 owner/repo（F2）
 * @property {number|null} autoResolveDays 自动 resolve 天数（F29；B1 只占位，B6 才执行）
 * @property {string|null} coordinatorSessionId
 * @property {ProjectPolicy} policy
 * @property {{dailyTokens:number|null, maxThreadsPerDay:number|null, maxStepsPerThread:number|null}} budget
 * @property {boolean} pinned 收藏（个人视图状态；只影响列表排序，不触发其它动作）
 * @property {string|null} preset F52 线程权限档位名（null = 继承宿主默认；**存名字不存 spec**）
 * @property {any[]} artifactRefs F33 项目产物的自存引用（id/标题/类型/版本/字节/时间/来源）
 * @property {'timer'|'schedule'} reminderDefault F30 新提醒的默认模式
 * @property {any[]} routines F36 定时任务（本地记录 + scheduleId 指向宿主条目）
 * @property {any[]} reminders F30 提醒（timer 落盘自恢复；schedule 记宿主 id）
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} ThreadRecord
 * @property {string} projectId
 * @property {'idle'|'working'|'waiting-user'|'waiting'|'done'|'failed'|'resolved'|'archived'} state
 *   六态里 resolved/archived 是插件域（宿主无原语），其余由事件回写。
 * @property {string|null} resolvedAt 手动 resolve 时间（F29）
 * @property {boolean} unread 手动标记的未读（F31；宿主无 read 概念，只能插件存）
 * @property {{total:number, done:number}|null} todos 最近一次 todo/write 快照（F27）
 * @property {string} subtitle 最近一条 tool/call 的可读摘要（F27；空串 = 没有，不编）
 * @property {string|null} lastActivityAt 最近活动时间（ISO；重启后仍能算时长）
 * @property {string|null} dir 该线程实际使用的项目目录（F35 多目录）
 * @property {string|null} branch
 * @property {string|null} lastPushedSha
 * @property {string|null} baseSha
 * @property {string|null} worktree
 * @property {number} seq
 * @property {Array<{type: string, at?: number, data?: any}>} events 可回放的持久事件（P0-2；只存 reduce 认的字段）
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
    // F21：PR/CI 轮询档位。**以前全仓没有这个字段**，`pollPrs` 读 `policy.pr.tier` 永远拿到
    // undefined 再退回 "draft"——写进策略也改不了行为，等于没有 per-project opt-out。
    // off = 这个项目完全不轮询（也挡住 Create PR 的自动开档）；默认 draft。
    pr: { tier: "draft" },
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
    // F55：本地文件夹授权记录（path → {mode, at, used}）。只收敛已知 mode，其余原样丢弃。
    folderAuth: (() => {
      var merged = {
        ...(previous.folderAuth && typeof previous.folderAuth === "object"
          ? previous.folderAuth
          : {}),
        ...(policy.folderAuth && typeof policy.folderAuth === "object" ? policy.folderAuth : {}),
      };
      /** @type {Record<string, any>} */
      var out = {};
      /** @type {Record<string, any>} */
      var mergedAny = merged;
      /** @type {any} */
      var record = null;
      for (var key of Object.keys(mergedAny)) {
        record = mergedAny[key];
        if (!record || typeof record !== "object") continue;
        if (!["deny", "default", "once"].includes(record.mode)) continue;
        out[key] = {
          mode: record.mode,
          at: typeof record.at === "string" ? record.at : "",
          used: record.used === true,
        };
      }
      return out;
    })(),
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
    // F21：PR 档位。只接受四档词表里的值；非法值落回上一份合法值，再不行才 draft。
    pr: (() => {
      const tiers = ["off", "draft", "ready", "auto-merge"];
      const pick = (/** @type {any} */ value) =>
        tiers.includes(String(value ?? "")) ? String(value) : "";
      const tier = pick(policy.pr?.tier) || pick(previous.pr?.tier) || "draft";
      return { tier };
    })(),
  };
}

/** @param {number} [now] */
function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

/**
 * 目录列表**形状收敛**：只留字符串、去空、去重，**不截断**。
 *
 * 为什么不在 load 时截断（B1 审查 P0-3）：`projects.json` 是用户数据，load 时静默砍掉第 11+
 * 个目录，会在下一次 save 后永久丢失——违反硬性约定 1（不认识的条目保留，不整段丢）。
 * 上限只在**写入口**拒绝（`createProject` / `updateProject`），那里能给用户报错。
 * @param {unknown} value
 * @returns {string[]}
 */
export function filterDirs(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (path === "" || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

/**
 * 目录列表收敛（形状收敛 + 上限截断）。
 *
 * 注意：**写入口不再用它兜底截断**（P2 复审）。`filterDirs` 的注释承诺「上限只在写入口拒绝」，
 * 但 `createProject` 曾经悄悄只留前 10 个——用户贴 12 个目录会静默丢 2 个，而 `updateProject`
 * 是显式报错的，两条入口说法不一致。现在 `createProject` 也显式拒绝；这个函数只给
 * 「已经校验过数量」的调用方做形状收敛，单测仍覆盖它的截断行为。
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeDirs(value) {
  return filterDirs(value).slice(0, MAX_DIRS);
}

/**
 * 仓库列表**形状收敛**：只认 `owner/repo`，去重，**不截断**（load 用；理由同 filterDirs）。
 * @param {unknown} value
 * @returns {string[]}
 */
export function filterRepos(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item
      .trim()
      .replace(/^https?:\/\/github\.com\//u, "")
      .replace(/\/+$/u, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 仓库列表收敛（写入口用）：形状收敛 + 上限截断（F2）。
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeRepos(value) {
  return filterRepos(value).slice(0, MAX_REPOS);
}

/**
 * 图标收敛：短标记（emoji / 一两个字符）；空串表示不显示。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeIcon(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_ICON_LENGTH);
}

/** @param {unknown} value @returns {number|null} */
function normalizeAutoResolveDays(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const days = Math.trunc(value);
  if (days < 1 || days > 365) return null;
  return days;
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
 * F58：通知偏好归一。只认三个已知键，非布尔值回落默认值。
 * @param {unknown} value
 * @returns {Record<string, boolean>}
 */
export function normalizeNotifyPrefs(value) {
  const source = value && typeof value === "object" ? /** @type {any} */ (value) : {};
  /** @type {Record<string, boolean>} */
  const out = { ...DEFAULT_NOTIFY_PREFS };
  for (const key of Object.keys(DEFAULT_NOTIFY_PREFS)) {
    if (typeof source[key] === "boolean") out[key] = source[key];
  }
  return out;
}

/**
 * 把任意输入收敛成合法状态；不认识的字段保留（前向兼容），缺失的补齐。
 * @param {any} raw
 * @param {string} root
 */
/**
 * F42：线程默认模型/effort 归一：只认字符串；effort 非空即收（部署枚举，不写死档位）。
 * @param {unknown} value
 * @returns {{ provider: string, model: string, reasoningEffort: string }}
 */
export function normalizeThreadDefaults(value) {
  const source = value && typeof value === "object" ? /** @type {any} */ (value) : {};
  const provider = typeof source.provider === "string" ? source.provider.trim() : "";
  const model = typeof source.model === "string" ? source.model.trim() : "";
  const effort =
    typeof source.reasoningEffort === "string"
      ? source.reasoningEffort.trim().slice(0, MAX_EFFORT_LENGTH)
      : "";
  return {
    provider,
    model,
    // 非空即收：白名单会丢部署特有的档位（max/xhigh/off）；空串 = 继承宿主默认。
    reasoningEffort: effort,
  };
}

/**
 * 把任意输入收敛成合法状态；不认识的字段保留（前向兼容），缺失的补齐。
 * @param {any} raw
 * @param {string} root
 * @returns {any}
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
        icon: normalizeIcon(project.icon),
        state: ["active", "paused", "archived"].includes(project.state) ? project.state : "active",
        // 归档时间：旧数据没有就补 null；state=archived 但没有时间的老数据也补 null（不伪造时间）
        archivedAt:
          project.state === "archived" && typeof project.archivedAt === "string"
            ? project.archivedAt
            : null,
        // load 只做类型过滤、**不截断**：用户数据不能在下一次 save 后永久丢失（P0-3）。
        // 上限由写入口拒绝（createProject/updateProject）。
        dirs: filterDirs(project.dirs),
        repos: filterRepos(project.repos),
        autoResolveDays: normalizeAutoResolveDays(project.autoResolveDays),
        coordinatorSessionId:
          typeof project.coordinatorSessionId === "string" ? project.coordinatorSessionId : null,
        policy: normalizePolicy(project.policy),
        // F22：新项目带默认预算；老记录里**显式写过的 null** 保持 null（升级不改变已有项目行为），
        // 整段 budget 缺失（更早的数据）才补默认值。
        budget:
          project.budget && typeof project.budget === "object"
            ? {
                dailyTokens:
                  typeof project.budget.dailyTokens === "number"
                    ? project.budget.dailyTokens
                    : null,
                maxThreadsPerDay:
                  typeof project.budget.maxThreadsPerDay === "number"
                    ? project.budget.maxThreadsPerDay
                    : null,
                maxConcurrent:
                  typeof project.budget.maxConcurrent === "number"
                    ? project.budget.maxConcurrent
                    : null,
                maxStepsPerThread:
                  typeof project.budget.maxStepsPerThread === "number"
                    ? project.budget.maxStepsPerThread
                    : null,
              }
            : { ...DEFAULT_BUDGET },
        // F58：按项目的通知开关（失败/等你默认开，完成默认关）
        notifyPrefs: normalizeNotifyPrefs(project.notifyPrefs),
        // F42：新建线程的默认模型 / effort（空串 = 继承宿主的默认模型）
        threadDefaults: normalizeThreadDefaults(project.threadDefaults),
        // F52：权限档位名（空串 = 继承宿主）。名字的合法性由写入口 `catalog()` 校验，
        // 读盘只收敛类型——部署换了 preset 名字，旧记录也不该让整份数据读不出来。
        preset: typeof project.preset === "string" && project.preset !== "" ? project.preset : null,
        // F30：新提醒默认模式（timer 免费；schedule 计费）
        reminderDefault: ["timer", "schedule"].includes(project.reminderDefault)
          ? project.reminderDefault
          : DEFAULT_REMINDER_MODE,
        // F33：产物引用（自存映射）。旧数据缺失即空数组；非法条目丢弃，不让整份数据读不出来。
        artifactRefs: (Array.isArray(project.artifactRefs) ? project.artifactRefs : [])
          .map((/** @type {any} */ item) => normalizeArtifactRef(item))
          .filter(Boolean),
        // F36/F30：本地记录数组。**只收敛已知形状、保留未知字段**，旧数据缺失即空数组。
        routines: (Array.isArray(project.routines) ? project.routines : [])
          .map((/** @type {any} */ item) => normalizeRoutine(item))
          .filter(Boolean),
        reminders: (Array.isArray(project.reminders) ? project.reminders : [])
          .map((/** @type {any} */ item) => normalizeReminder(item))
          .filter(Boolean),
        // 旧数据没有 pinned：缺失即 false（不 bump formatVersion——纯增量可选字段，
        // 老版本读到 pinned 也只是忽略，两个方向都能读；破坏性变更才需要迁移步骤）。
        pinned: project.pinned === true,
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
        // 六态词表统一（P0-2）：`waiting-user` 必须能读回来，否则重启后「等你」变 idle。
        state: isThreadState(thread.state) ? thread.state : "idle",
        resolvedAt: typeof thread.resolvedAt === "string" ? thread.resolvedAt : null,
        unread: thread.unread === true,
        todos:
          thread.todos && Number.isFinite(thread.todos.total) && Number.isFinite(thread.todos.done)
            ? {
                total: Math.max(0, Math.trunc(thread.todos.total)),
                done: Math.max(0, Math.trunc(thread.todos.done)),
              }
            : null,
        subtitle: typeof thread.subtitle === "string" ? thread.subtitle.slice(0, 120) : "",
        // F23：右键「重命名」写回的人工标题；空串 = 用宿主投影的标题
        title:
          typeof thread.title === "string" ? thread.title.slice(0, MAX_THREAD_TITLE_CHARS) : "",
        lastActivityAt: typeof thread.lastActivityAt === "string" ? thread.lastActivityAt : null,
        dir: typeof thread.dir === "string" ? thread.dir : null,
        branch: typeof thread.branch === "string" ? thread.branch : null,
        lastPushedSha: typeof thread.lastPushedSha === "string" ? thread.lastPushedSha : null,
        baseSha: typeof thread.baseSha === "string" ? thread.baseSha : null,
        worktree: typeof thread.worktree === "string" ? thread.worktree : null,
        // F21：PR 的 CI 状态与 head sha（轮询写回；旧数据缺字段就是 null，不伪造）
        ciState: ["passing", "failing", "pending", "none"].includes(thread.ciState)
          ? thread.ciState
          : null,
        headRefOid: typeof thread.headRefOid === "string" ? thread.headRefOid : null,
        seq: Number.isInteger(thread.seq) ? thread.seq : 0,
        // P0-2：重启后靠这串事件重建 Overview。只收敛已知形状（type 字符串 + 可选数字 at），
        // 不认识/损坏的条目丢弃——它们是缓存性质的事实，丢了顶多视图旧一点，不能让整份数据读不出来。
        events: (Array.isArray(thread.events) ? thread.events : [])
          .filter(
            (/** @type {any} */ item) =>
              item && typeof item === "object" && typeof item.type === "string" && item.type !== "",
          )
          .slice(-REPLAY_EVENT_CAP)
          .map((/** @type {any} */ item) => ({
            type: item.type,
            ...(Number.isFinite(item.at) ? { at: Number(item.at) } : {}),
            ...(item.data && typeof item.data === "object" ? { data: item.data } : {}),
          })),
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

  /** @param {string} name @param {{goal?: string, icon?: string, dirs?: string[], repos?: string[], autoResolveDays?: number|null, template?: boolean}} [input] */
  createProject(name, input = {}) {
    const trimmed = String(name ?? "").trim();
    if (trimmed === "") throw new Error("projects: project name is required");
    const goal = typeof input.goal === "string" ? input.goal : "";
    if (goal.length > MAX_GOAL_CHARS) {
      throw new Error(`projects: goal exceeds ${MAX_GOAL_CHARS} characters (got ${goal.length})`);
    }
    const id = newProjectId(this.now());
    const stamp = iso(this.now());
    // P2 复审：与 updateProject 同口径——超上限就明确拒绝，不再静默截断（静默丢用户数据）
    const dirs = filterDirs(input.dirs);
    if (dirs.length > MAX_DIRS) {
      throw new Error(`projects: at most ${MAX_DIRS} project dirs (got ${dirs.length})`);
    }
    this.state.projects[id] = {
      id,
      name: trimmed,
      goal,
      icon: normalizeIcon(input.icon),
      state: "active",
      archivedAt: null,
      dirs,
      repos: normalizeRepos(input.repos),
      autoResolveDays: normalizeAutoResolveDays(input.autoResolveDays),
      coordinatorSessionId: null,
      pinned: false,
      policy: defaultPolicy(),
      // F22：默认预算（日线程 20 / 并发 2 / 步数 60 / token 不限），不再是"全 null = 闸门不生效"
      budget: { ...DEFAULT_BUDGET },
      notifyPrefs: { ...DEFAULT_NOTIFY_PREFS },
      threadDefaults: { provider: "", model: "", reasoningEffort: "" },
      preset: null,
      reminderDefault: DEFAULT_REMINDER_MODE,
      // F33：项目产出的产物引用（我们自存的 projectId↔artifactId 映射；artifacts meta 不保证有）
      artifactRefs: [],
      routines: [],
      reminders: [],
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
   * @param {Partial<{name: string, goal: string, icon: string, state: string, dirs: string[], repos: string[], autoResolveDays: number|null, coordinatorSessionId: string|null, pinned: boolean, policy: any, persona: string, budget: any}>} patch
   */
  updateProject(id, patch) {
    const current = this.state.projects[id];
    if (!current) throw new Error(`projects: unknown project ${id}`);
    const next = { ...current };
    if (typeof patch.name === "string" && patch.name.trim() !== "") next.name = patch.name.trim();
    if (typeof patch.goal === "string") {
      if (patch.goal.length > MAX_GOAL_CHARS) {
        throw new Error(
          `projects: goal exceeds ${MAX_GOAL_CHARS} characters (got ${patch.goal.length})`,
        );
      }
      next.goal = patch.goal;
    }
    if (typeof patch.icon === "string") next.icon = normalizeIcon(patch.icon);
    if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
    if (patch.autoResolveDays === null || typeof patch.autoResolveDays === "number") {
      next.autoResolveDays = normalizeAutoResolveDays(patch.autoResolveDays);
    }
    if (["active", "paused", "archived"].includes(String(patch.state))) {
      next.state = patch.state;
      // 归档时间（F1）由状态迁移自动维护：进归档记时间，离开归档清掉。
      if (next.state === "archived") {
        next.archivedAt =
          typeof current.archivedAt === "string" ? current.archivedAt : iso(this.now());
      } else {
        next.archivedAt = null;
      }
    }
    if (Array.isArray(patch.dirs)) {
      const requested = patch.dirs.filter(
        (/** @type {unknown} */ d) => typeof d === "string" && d.trim() !== "",
      );
      if (requested.length > MAX_DIRS) {
        throw new Error(`projects: at most ${MAX_DIRS} project dirs (got ${requested.length})`);
      }
      next.dirs = normalizeDirs(patch.dirs);
    }
    if (Array.isArray(patch.repos)) {
      const requested = patch.repos.filter(
        (/** @type {unknown} */ r) => typeof r === "string" && r.trim() !== "",
      );
      if (requested.length > MAX_REPOS) {
        throw new Error(`projects: at most ${MAX_REPOS} repos (got ${requested.length})`);
      }
      next.repos = normalizeRepos(patch.repos);
    }
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
   * 收藏 / 取消收藏：只改 pinned 一个字段。
   * 为什么不复用 updateProject：收藏是「个人视图状态」，不该顺手改别的字段；
   * 单独一个方法让调用点无法误传 policy/dirs。
   * @param {string} id @param {boolean} pinned
   */
  setPinned(id, pinned) {
    const current = this.state.projects[id];
    if (!current) throw new Error(`projects: unknown project ${id}`);
    current.pinned = pinned === true;
    // 刻意**不**动 updatedAt：列表按「上次活跃」排序时，收藏不该让一个项目假装刚被用过。
    // 排序里「收藏永远最前」是独立规则（sortProjects），不依赖 updatedAt。
    return { ...current };
  }

  /**
   * 归档是唯一"默认开启"的自动化动作；它可逆，且不删数据。
   * @param {string} id
   */
  archiveProject(id) {
    return this.updateProject(id, { state: "archived" });
  }

  /**
   * 把会话挂进项目。F15：**线程不可跨项目移动**（Claude Projects 里 thread 属于一个项目，
   * 移来移去会让审计/记忆/PR 归属全部失真）。规则：
   *  - 空槽（没有归属记录）→ 允许挂；
   *  - 已在本项目 → 幂等（保留既有字段）；
   *  - 已在**另一个**项目 → 拒绝，并说清它在哪（要换项目必须先 detach）。
   * 返回 `moved: false` 让调用方知道这不是一次"搬家"。
   * @param {string} sessionId @param {string} projectId
   */
  attachThread(sessionId, projectId) {
    if (!this.state.projects[projectId]) throw new Error(`projects: unknown project ${projectId}`);
    const current = this.state.threads[sessionId];
    if (current && typeof current.projectId === "string" && current.projectId !== projectId) {
      const error = new Error(
        `projects: thread ${sessionId} already belongs to project ${current.projectId}; detach it first`,
      );
      // @ts-expect-error 附加字段：调用方/审计要能拿到"原来在哪"
      error.code = "thread-in-other-project";
      // @ts-expect-error 同上
      error.currentProjectId = current.projectId;
      throw error;
    }
    this.state.threads[sessionId] = {
      projectId,
      state: current?.state ?? "idle",
      resolvedAt: current?.resolvedAt ?? null,
      unread: current?.unread === true,
      todos: current?.todos ?? null,
      subtitle: current?.subtitle ?? "",
      lastActivityAt: current?.lastActivityAt ?? null,
      dir: current?.dir ?? null,
      branch: current?.branch ?? null,
      worktree: current?.worktree ?? null,
      ciState: current?.ciState ?? null,
      headRefOid: current?.headRefOid ?? null,
      seq: current?.seq ?? 0,
      createdAt: current?.createdAt ?? iso(this.now()),
      lastWakeTurn: current?.lastWakeTurn ?? 0,
      autoFixRound: current?.autoFixRound ?? 0,
      autoFixSignature: current?.autoFixSignature ?? "",
      autoFixChanged: current?.autoFixChanged ?? [],
      events: Array.isArray(current?.events) ? current.events : [],
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
   * 写回 PR 的 CI 状态（F21 轮询结果）。只接受四态，其余保持不变。
   * @param {string} sessionId
   * @param {{ ciState?: string, headRefOid?: string, prNumber?: number }} patch
   */
  setThreadCi(sessionId, patch) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    const allowed = ["passing", "failing", "pending", "none"];
    if (allowed.includes(String(patch?.ciState ?? ""))) current.ciState = String(patch.ciState);
    if (typeof patch?.headRefOid === "string") current.headRefOid = patch.headRefOid;
    if (Number.isFinite(patch?.prNumber)) current.prNumber = Number(patch.prNumber);
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
   * 事件回写持久状态（F16 的 P0-1 修复）：只有真的变了才返回 changed=true，
   * 调用方据此决定要不要落盘（避免每个事件都写一次 projects.json）。
   * @param {string} sessionId
   * @param {string} state 六态之一
   * @returns {{ changed: boolean, state: string, record: any }}
   */
  setThreadState(sessionId, state) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    const next = isThreadState(state) ? state : current.state;
    const changed = next !== current.state;
    if (changed) current.state = next;
    // resolvedAt 跟着 resolved 走（P2 复审：注释以前说这里维护，代码却没写）：
    // 进入 resolved 记时间；离开 resolved（重开/又跑起来/归档）就清掉，避免「已 resolve 时间」泄漏。
    if (next === "resolved") {
      if (typeof current.resolvedAt !== "string" || current.resolvedAt === "") {
        current.resolvedAt = iso(this.now());
      }
    } else if (current.resolvedAt != null) {
      current.resolvedAt = null;
    }
    return { changed, state: current.state, record: { ...current } };
  }

  /**
   * 手动 resolve / 重开（F29）。自动 resolve 留给 B6（autoResolveDays 只是占位）。
   * @param {string} sessionId @param {boolean} resolved
   * @returns {any} 回读的线程记录
   */
  setThreadResolved(sessionId, resolved) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    current.state = resolved ? "resolved" : "idle";
    current.resolvedAt = resolved ? iso(this.now()) : null;
    return { ...current };
  }

  /**
   * F33：记录一条产物引用（projectId↔artifactId 的自存映射）。
   * 发布产物时在项目线程里调用；同 id 后写覆盖前写（版本上涨），最多 MAX_ARTIFACT_REFS 条。
   * @param {string} projectId @param {unknown} ref
   * @returns {{ refs: any[], ref: any } | null} null = 引用不合法（不写盘）
   */
  recordArtifact(projectId, ref) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const normalized = normalizeArtifactRef(ref);
    if (normalized === null) return null;
    current.artifactRefs = mergeArtifactRefs(current.artifactRefs, normalized);
    current.updatedAt = iso(this.now());
    return {
      refs: current.artifactRefs.map((/** @type {any} */ item) => ({ ...item })),
      ref: normalized,
    };
  }

  /**
   * F33：读项目的产物引用（按最近更新排序）。
   * @param {string} projectId
   * @returns {any[]}
   */
  listArtifactRefs(projectId) {
    const current = this.state.projects[projectId];
    if (!current) return [];
    return (Array.isArray(current.artifactRefs) ? current.artifactRefs : []).map(
      (/** @type {any} */ item) => ({ ...item }),
    );
  }

  /**
   * F42：写线程默认模型 / effort；空串表示「继承宿主默认」。
   * @param {string} projectId @param {unknown} patch
   * @returns {{ defaults: { provider: string, model: string, reasoningEffort: string } }}
   */
  setThreadDefaults(projectId, patch) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const merged = normalizeThreadDefaults({
      ...normalizeThreadDefaults(current.threadDefaults),
      ...(patch && typeof patch === "object" ? patch : {}),
    });
    current.threadDefaults = merged;
    current.updatedAt = iso(this.now());
    return { defaults: merged };
  }

  /**
   * F23：人工线程标题（右键重命名）。空串表示清除，回到宿主投影的标题。
   * @param {string} sessionId @param {string} title
   * @returns {{ sessionId: string, title: string }}
   */
  setThreadTitle(sessionId, title) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    const value = String(title ?? "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_THREAD_TITLE_CHARS);
    current.title = value;
    if (value !== "") current.unread = false;
    return { sessionId, title: value };
  }

  /**
   * F58：写项目的通知开关（部分补丁，未提供的键保持原值）。
   * @param {string} projectId @param {unknown} patch
   * @returns {{ project: any, prefs: Record<string, boolean> }}
   */
  setNotifyPrefs(projectId, patch) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    /** @type {Record<string, boolean>} */
    const clean = {};
    for (const key of Object.keys(DEFAULT_NOTIFY_PREFS)) {
      const value =
        patch && typeof patch === "object" ? /** @type {any} */ (patch)[key] : undefined;
      if (typeof value === "boolean") clean[key] = value;
    }
    const merged = normalizeNotifyPrefs({ ...normalizeNotifyPrefs(current.notifyPrefs), ...clean });
    current.notifyPrefs = merged;
    current.updatedAt = iso(this.now());
    return { project: { ...current }, prefs: merged };
  }

  /**
   * F52：写项目的线程权限档位名（空串/null = 继承宿主默认）。
   * 只做形状收敛；名字是否在本部署的 `catalog()` 里由 service 校验（名字不能写死）。
   * @param {string} projectId @param {unknown} preset
   * @returns {{ project: any, preset: string|null }}
   */
  setProjectPreset(projectId, preset) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const value = String(preset ?? "").trim();
    current.preset = value === "" ? null : value;
    current.updatedAt = iso(this.now());
    return { project: { ...current }, preset: current.preset };
  }

  /**
   * F30：写新提醒的默认模式（timer / schedule）。
   * @param {string} projectId @param {unknown} mode
   * @returns {{ project: any, reminderDefault: string }}
   */
  setReminderDefault(projectId, mode) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const value = ["timer", "schedule"].includes(String(mode))
      ? String(mode)
      : DEFAULT_REMINDER_MODE;
    current.reminderDefault = value;
    current.updatedAt = iso(this.now());
    return { project: { ...current }, reminderDefault: value };
  }

  /**
   * F36：项目的定时任务列表（副本，调用方改不到仓储里）。
   * @param {string} projectId
   * @returns {any[]}
   */
  listRoutines(projectId) {
    const current = this.state.projects[projectId];
    if (!current) return [];
    return (Array.isArray(current.routines) ? current.routines : []).map(
      (/** @type {any} */ item) => ({
        ...item,
        history: Array.isArray(item.history)
          ? item.history.map((/** @type {any} */ row) => ({ ...row }))
          : [],
      }),
    );
  }

  /**
   * F36：新增一条 routine（上限 `MAX_ROUTINES`，由调用方保证 id 唯一）。
   * @param {string} projectId @param {any} routine
   * @returns {{ routine: any, count: number }}
   */
  addRoutine(projectId, routine) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    if (!Array.isArray(current.routines)) current.routines = [];
    if (current.routines.length >= MAX_ROUTINES) {
      throw new Error(
        `projects: at most ${MAX_ROUTINES} routines (got ${current.routines.length})`,
      );
    }
    const normalized = normalizeRoutine(routine);
    if (!normalized) throw new Error("projects: invalid routine");
    current.routines.push(normalized);
    current.updatedAt = iso(this.now());
    return { routine: { ...normalized }, count: current.routines.length };
  }

  /**
   * F36：改一条 routine（开关 / lastRunAt / history）。
   * @param {string} projectId @param {string} routineId @param {any} patch
   * @returns {{ routine: any }}
   */
  patchRoutine(projectId, routineId, patch) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const list = Array.isArray(current.routines) ? current.routines : [];
    const index = list.findIndex((/** @type {any} */ item) => item?.id === routineId);
    if (index < 0) throw new Error(`projects: unknown routine ${routineId}`);
    const merged = normalizeRoutine({
      ...list[index],
      ...(patch && typeof patch === "object" ? patch : {}),
    });
    if (!merged) throw new Error("projects: invalid routine patch");
    list[index] = merged;
    current.updatedAt = iso(this.now());
    return {
      routine: { ...merged, history: merged.history.map((/** @type {any} */ row) => ({ ...row })) },
    };
  }

  /**
   * F36：删一条 routine。
   * @param {string} projectId @param {string} routineId
   * @returns {{ removed: boolean, count: number }}
   */
  removeRoutine(projectId, routineId) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const list = Array.isArray(current.routines) ? current.routines : [];
    const next = list.filter((/** @type {any} */ item) => item?.id !== routineId);
    current.routines = next;
    current.updatedAt = iso(this.now());
    return { removed: next.length !== list.length, count: next.length };
  }

  /**
   * F30：一个项目的提醒列表。
   * @param {string} projectId
   * @returns {any[]}
   */
  listReminders(projectId) {
    const current = this.state.projects[projectId];
    if (!current) return [];
    return (Array.isArray(current.reminders) ? current.reminders : []).map(
      (/** @type {any} */ item) => ({ ...item }),
    );
  }

  /**
   * F30：全部项目的提醒（启动时 arm 用）。
   * @returns {any[]}
   */
  listAllReminders() {
    /** @type {any[]} */
    const out = [];
    for (const [projectId, project] of Object.entries(this.state.projects)) {
      for (const item of Array.isArray(/** @type {any} */ (project).reminders)
        ? /** @type {any} */ (project).reminders
        : []) {
        out.push({ ...item, projectId });
      }
    }
    return out;
  }

  /**
   * F30：新增一条提醒。
   * @param {string} projectId @param {any} reminder
   * @returns {{ reminder: any }}
   */
  addReminder(projectId, reminder) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    if (!Array.isArray(current.reminders)) current.reminders = [];
    const normalized = normalizeReminder({ ...reminder, projectId });
    if (!normalized) throw new Error("projects: invalid reminder");
    current.reminders.push(normalized);
    current.updatedAt = iso(this.now());
    return { reminder: { ...normalized } };
  }

  /**
   * F30：改一条提醒（fired / notified / cancelled / done）。
   * @param {string} projectId @param {string} reminderId @param {any} patch
   * @returns {{ reminder: any }}
   */
  patchReminder(projectId, reminderId, patch) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const list = Array.isArray(current.reminders) ? current.reminders : [];
    const index = list.findIndex((/** @type {any} */ item) => item?.id === reminderId);
    if (index < 0) throw new Error(`projects: unknown reminder ${reminderId}`);
    const merged = normalizeReminder({
      ...list[index],
      ...(patch && typeof patch === "object" ? patch : {}),
    });
    if (!merged) throw new Error("projects: invalid reminder patch");
    list[index] = merged;
    current.updatedAt = iso(this.now());
    return { reminder: { ...merged } };
  }

  /**
   * F30：删一条提醒（取消后清理 / 过期清理）。
   * @param {string} projectId @param {string} reminderId
   * @returns {{ removed: boolean }}
   */
  removeReminder(projectId, reminderId) {
    const current = this.state.projects[projectId];
    if (!current) throw new Error(`projects: unknown project ${projectId}`);
    const list = Array.isArray(current.reminders) ? current.reminders : [];
    const next = list.filter((/** @type {any} */ item) => item?.id !== reminderId);
    current.reminders = next;
    current.updatedAt = iso(this.now());
    return { removed: next.length !== list.length };
  }

  /**
   * 手动标记未读（F31）。宿主没有 read 概念，只能插件自己存。
   * @param {string} sessionId @param {boolean} unread
   */
  setThreadUnread(sessionId, unread) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    current.unread = unread === true;
    return { ...current };
  }

  /**
   * 记录 todo/write 的整表快照（F27 的步进 n/m）。
   * @param {string} sessionId @param {{total:number, done:number}|null} todos
   */
  setThreadTodos(sessionId, todos) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    current.todos = todos ?? null;
    return { ...current };
  }

  /**
   * 记录行副标题（最近一条 tool/call 的可读摘要）。空串表示没有，不编。
   * @param {string} sessionId @param {string} subtitle
   */
  setThreadSubtitle(sessionId, subtitle) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    current.subtitle = String(subtitle ?? "").slice(0, 120);
    return { ...current };
  }

  /**
   * 最近活动时间（ISO）。重启后行时长/`~Nm` 估计要用它。
   * @param {string} sessionId @param {number} at 毫秒时间戳
   */
  setThreadActivity(sessionId, at) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    if (Number.isFinite(at) && at > 0) current.lastActivityAt = iso(at);
    return { ...current };
  }

  /**
   * 追加一条可回放的持久事件（P0-2）。只留尾部 REPLAY_EVENT_CAP 条，
   * 返回是否真的写了（调用方据此决定要不要落盘）。
   * @param {string} sessionId
   * @param {{ type: string, at?: number, data?: any }} event
   * @returns {boolean}
   */
  appendThreadEvent(sessionId, event) {
    const current = this.state.threads[sessionId];
    if (!current) return false;
    if (!event || typeof event.type !== "string" || event.type === "") return false;
    if (!Array.isArray(current.events)) current.events = [];
    current.events.push(event);
    if (current.events.length > REPLAY_EVENT_CAP) {
      current.events = current.events.slice(-REPLAY_EVENT_CAP);
    }
    return true;
  }

  /**
   * 记录该线程实际使用的项目目录（F35 多目录）。
   * @param {string} sessionId @param {string|null} dir
   */
  setThreadDir(sessionId, dir) {
    const current = this.state.threads[sessionId];
    if (!current) throw new Error(`projects: unknown thread ${sessionId}`);
    current.dir = typeof dir === "string" && dir !== "" ? dir : null;
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

  /**
   * 这个会话是不是某个项目的协调器？（F9/F11：协调器不属于任何线程）
   * @param {string} sessionId
   * @returns {any|undefined}
   */
  projectOfCoordinatorSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return undefined;
    for (const project of Object.values(this.state.projects)) {
      const anyProject = /** @type {any} */ (project);
      if (anyProject.coordinatorSessionId === sessionId) return anyProject;
    }
    return undefined;
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
