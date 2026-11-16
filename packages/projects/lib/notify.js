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
 * - 已知线程消失（归档/删除）→ 不提醒
 * @param {Snapshot} previous
 * @param {Snapshot} next
 * @returns {{ kind: "failed" | "waiting-user", projectId: string, sessionId: string }[]}
 */
export function diffAttention(previous, next) {
  const before = previous?.threads ?? {};
  const after = next?.threads ?? {};
  /** @type {{ kind: "failed" | "waiting-user", projectId: string, sessionId: string }[]} */
  const out = [];
  for (const [sessionId, entry] of Object.entries(after)) {
    const was = before[sessionId]?.state;
    if (entry.state === "failed" && was !== "failed") {
      out.push({ kind: "failed", projectId: String(entry.projectId ?? ""), sessionId });
    } else if (entry.state === "waiting-user" && was !== "waiting-user") {
      out.push({ kind: "waiting-user", projectId: String(entry.projectId ?? ""), sessionId });
    }
  }
  return out;
}

/**
 * 把多条提醒压成一句可读文案（同一项目内按类型计数）。
 * @param {{ kind: string }[]} items
 * @returns {{ failed: number, waiting: number, text: string }}
 */
export function summarize(items) {
  const list = Array.isArray(items) ? items : [];
  const failed = list.filter((item) => item.kind === "failed").length;
  const waiting = list.filter((item) => item.kind === "waiting-user").length;
  const parts = [];
  if (failed > 0) parts.push(`${failed} 个线程失败`);
  if (waiting > 0) parts.push(`${waiting} 个线程在等你`);
  return { failed, waiting, text: parts.join(" · ") };
}
