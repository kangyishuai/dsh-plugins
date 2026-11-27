// @ts-check
// 通知的判定逻辑：纯函数、零 I/O。
// 只关心「新出现的需要人处理的东西」，避免同一件事反复弹。

/**
 * @typedef {object} Snapshot
 * @property {Record<string, { state: string, projectId?: string }>} threads 按 sessionId 的线程状态
 * @property {string[]} projects 活跃项目 id（用于发现项目被删）
 */

/**
 * 比较两次快照，算出「这次新冒出来的」提醒。
 * 规则：
 * - 线程从非 failed 变成 failed → 一条 failed 提醒
 * - 线程从非 waiting-user 变成 waiting-user → 一条 waiting 提醒
 * - 线程从 working 变成 idle/resolved → 一条 completed 提醒（F58：完成也要通知）
 * - 已知线程消失（归档/删除）→ 不提醒
 * @param {Snapshot} previous
 * @param {Snapshot} next
 * @returns {{ kind: "failed" | "waiting-user" | "completed", projectId: string, sessionId: string }[]}
 */
export function diffAttention(previous, next) {
  const before = previous?.threads ?? {};
  const after = next?.threads ?? {};
  /** @type {{ kind: "failed" | "waiting-user" | "completed", projectId: string, sessionId: string }[]} */
  const out = [];
  for (const [sessionId, entry] of Object.entries(after)) {
    const was = before[sessionId]?.state;
    if (entry.state === "failed" && was !== "failed") {
      out.push({ kind: "failed", projectId: String(entry.projectId ?? ""), sessionId });
    } else if (entry.state === "waiting-user" && was !== "waiting-user") {
      out.push({ kind: "waiting-user", projectId: String(entry.projectId ?? ""), sessionId });
    } else if (
      was === "working" &&
      (entry.state === "idle" || entry.state === "resolved") &&
      before[sessionId]?.projectId === entry.projectId
    ) {
      // 只在「同一个项目内从在跑变成空闲」时提醒：刚归属过来还没有前一条状态的新线程不算完成
      out.push({ kind: "completed", projectId: String(entry.projectId ?? ""), sessionId });
    }
  }
  return out;
}

/**
 * 把多条提醒压成一句可读文案（同一项目内按类型计数）。
 * @param {{ kind: string }[]} items
 * @returns {{ failed: number, waiting: number, completed: number, text: string }}
 */
export function summarize(items) {
  const list = Array.isArray(items) ? items : [];
  const failed = list.filter((item) => item.kind === "failed").length;
  const waiting = list.filter((item) => item.kind === "waiting-user").length;
  const completed = list.filter((item) => item.kind === "completed").length;
  const parts = [];
  if (failed > 0) parts.push(`${failed} 个线程失败`);
  if (waiting > 0) parts.push(`${waiting} 个线程在等你`);
  if (completed > 0) parts.push(`${completed} 个线程完成了`);
  return { failed, waiting, completed, text: parts.join(" · ") };
}

/** 通知开关的默认值（F58：按项目可关；完成默认关——它最吵，失败与等你默认开）。 */
export const DEFAULT_NOTIFY_PREFS = Object.freeze({
  failed: true,
  "waiting-user": true,
  completed: false,
});

/**
 * 规范化通知偏好补丁：只认三个已知键，布尔值；未知键忽略。
 * @param {unknown} patch
 * @returns {{ ok: true, prefs: Record<string, boolean> } | { ok: false, reason: string }}
 */
export function normalizeNotifyPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, reason: "notify/patch-required" };
  }
  /** @type {Record<string, boolean>} */
  const prefs = {};
  for (const key of Object.keys(DEFAULT_NOTIFY_PREFS)) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = /** @type {any} */ (patch)[key];
    if (typeof value !== "boolean") return { ok: false, reason: `notify/invalid:${key}` };
    prefs[key] = value;
  }
  if (Object.keys(prefs).length === 0) return { ok: false, reason: "notify/patch-empty" };
  return { ok: true, prefs };
}

/**
 * 按项目偏好过滤提醒：项目没配置就用默认值。
 * @param {{ kind: string, projectId?: string }[]} items
 * @param {Record<string, Record<string, boolean>>} [byProject] projectId → 偏好
 * @returns {{ kind: string, projectId?: string }[]}
 */
export function filterAttention(items, byProject) {
  const list = Array.isArray(items) ? items : [];
  const prefsByProject = byProject && typeof byProject === "object" ? byProject : {};
  return list.filter((item) => {
    const projectId = String(item?.projectId ?? "");
    const override = projectId !== "" ? prefsByProject[projectId] : undefined;
    const prefs = {
      ...DEFAULT_NOTIFY_PREFS,
      ...(override && typeof override === "object" ? override : {}),
    };
    const prefsAny = /** @type {Record<string, boolean>} */ (prefs);
    return prefsAny[String(item?.kind ?? "")] !== false;
  });
}
