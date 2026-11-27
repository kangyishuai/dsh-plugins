// @ts-check
// F29 自动 resolve：纯函数、零 I/O（服务层负责启动/每日触发与写审计）。
// 口径（spec-plan §2.1）：项目字段 `autoResolveDays` 为 N 时，**无活动 ≥ N 天**的线程
// 自动标记 resolved（写审计 `thread/auto-resolved`）；null = 关闭（默认）。
// 判据只用持久化事实：`lastActivityAt`（事件回写）→ 退化为 `createdAt`。
// 没有时间事实的线程不猜（宁可不动，也不把「不知道」当「很久没动」）。

/** 一天的毫秒数。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {any} days @returns {number|null} */
export function autoResolveDaysOf(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) return null;
  const int = Math.trunc(value);
  // 与 store.normalizeAutoResolveDays 同一区间：1..365，其余一律当关闭
  return int >= 1 && int <= 365 ? int : null;
}

/**
 * 这条线程现在该不该被自动 resolve。
 * @param {any} thread 线程记录（含 state / resolvedAt / lastActivityAt / createdAt）
 * @param {number|null} days 项目的 autoResolveDays
 * @param {number} now 毫秒时间戳
 * @returns {{ due: boolean, reason: string, ageMs: number }}
 *   reason: off / no-thread / archived / already-resolved / no-activity / not-yet / inactive
 */
export function autoResolveDue(thread, days, now) {
  const thresholdDays = autoResolveDaysOf(days);
  if (thresholdDays === null) return { due: false, reason: "off", ageMs: 0 };
  if (!thread || typeof thread !== "object") {
    return { due: false, reason: "no-thread", ageMs: 0 };
  }
  if (String(thread.state ?? "") === "archived") {
    return { due: false, reason: "archived", ageMs: 0 };
  }
  const resolvedAt = String(thread.resolvedAt ?? "");
  if (resolvedAt !== "" && !Number.isNaN(Date.parse(resolvedAt))) {
    return { due: false, reason: "already-resolved", ageMs: 0 };
  }
  if (String(thread.state ?? "") === "resolved") {
    return { due: false, reason: "already-resolved", ageMs: 0 };
  }
  const lastActivityMs = Date.parse(String(thread.lastActivityAt ?? thread.createdAt ?? ""));
  if (Number.isNaN(lastActivityMs)) {
    // 没有时间事实：不猜。等下一次事件回写 lastActivityAt 再算。
    return { due: false, reason: "no-activity", ageMs: 0 };
  }
  const ageMs = Math.max(0, Number(now) - lastActivityMs);
  const thresholdMs = thresholdDays * DAY_MS;
  // 边界口径：**刚好 N 天也 resolve**（>=），「超过 N 天」自然覆盖。
  if (ageMs < thresholdMs) return { due: false, reason: "not-yet", ageMs };
  return { due: true, reason: "inactive", ageMs };
}

/**
 * 一趟检查要 resolve 哪些线程（纯函数，便于单测与服务层复用）。
 * @param {{ id: string, autoResolveDays?: number|null }[]} projects
 * @param {Record<string, any>} threads sessionId → 记录
 * @param {number} now
 * @returns {{ targets: { projectId: string, sessionId: string, days: number, idleDays: number }[], checked: number }}
 */
export function planAutoResolve(projects, threads, now) {
  /** @type {{ projectId: string, sessionId: string, days: number, idleDays: number }[]} */
  const targets = [];
  let checked = 0;
  const list = Array.isArray(projects) ? projects : [];
  for (const project of list) {
    const days = autoResolveDaysOf(project?.autoResolveDays);
    if (days === null) continue; // 关闭的项目零开销
    for (const [sessionId, thread] of Object.entries(threads ?? {})) {
      if (String(thread?.projectId ?? "") !== String(project?.id ?? "")) continue;
      checked += 1;
      const verdict = autoResolveDue(thread, days, now);
      if (!verdict.due) continue;
      targets.push({
        projectId: String(project.id),
        sessionId: String(sessionId),
        days,
        idleDays: Math.floor(verdict.ageMs / DAY_MS),
      });
    }
  }
  return { targets, checked };
}
