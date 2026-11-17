// @ts-check
// 项目预算闸：纯函数、零 I/O。
// M2 范围只做「线程数量」维度（每日新建数 + 并发数）；
// token 维度的花费闸留到 M3 与 tokenMeter 一起接（避免现在猜计量口径）。

/** 一天的毫秒数。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 一条线程记录是否算在「今天」。
 * @param {{ createdAt?: string }} thread
 * @param {number} now
 * @returns {boolean}
 */
export function isToday(thread, now) {
  const created = Date.parse(String(thread?.createdAt ?? ""));
  if (!Number.isFinite(created)) return false;
  return created >= startOfDay(now) && created < startOfDay(now) + DAY_MS;
}

/**
 * 本地时区的一天起点。
 * @param {number} now
 * @returns {number}
 */
export function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 是否允许再建一个线程。
 * 规则：项目暂停 → 拒；每日上限 → 拒；并发上限 → 拒。任一命中给可读原因。
 * @param {object} input
 * @param {{state?: string, budget?: {maxThreadsPerDay?: number|null, maxConcurrent?: number|null}}} input.project
 * @param {{createdAt?: string, state?: string}[]} input.threads
 * @param {number} [input.now]
 * @returns {{ ok: boolean, reason: string, used: { today: number, running: number } }}
 */
export function checkThreadBudget(input) {
  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now();
  const threads = Array.isArray(input?.threads) ? input.threads : [];
  const today = threads.filter((thread) => isToday(thread, now)).length;
  const running = threads.filter((thread) => thread?.state === "working").length;
  const used = { today, running };

  if (input?.project?.state === "paused") return { ok: false, reason: "project-paused", used };
  if (input?.project?.state === "archived") return { ok: false, reason: "project-archived", used };

  const maxPerDay = input?.project?.budget?.maxThreadsPerDay;
  if (Number.isFinite(maxPerDay) && today >= Number(maxPerDay)) {
    return { ok: false, reason: "budget/threads-per-day", used };
  }

  const maxConcurrent = input?.project?.budget?.maxConcurrent;
  if (Number.isFinite(maxConcurrent) && running >= Number(maxConcurrent)) {
    return { ok: false, reason: "budget/concurrent-threads", used };
  }

  return { ok: true, reason: "", used };
}

/**
 * 与「今天」相关的 token 累计（宿主的 `TokenUsage` 形状：inputTokens/outputTokens/totalTokens?）。
 * @param {{ usage?: any, at?: string }} record
 * @param {number} now
 * @returns {number}
 */
export function tokensOf(record, now) {
  if (!isToday({ createdAt: record?.at }, now)) return 0;
  const usage = record?.usage;
  if (!usage || typeof usage !== "object") return 0;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const input = Number(usage.inputTokens);
  const output = Number(usage.outputTokens);
  const sum = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  return Math.max(0, sum);
}

/**
 * 今天的 token 花费是否已到线。
 * 单独的判定（不与线程数混在一起）——两件事的处置不同：到 token 线应该「暂停项目」，
 * 到线程数线只是「今天不再建」。
 * @param {{ dailyTokens?: number|null, usedTokens: number }} input
 * @returns {{ ok: boolean, used: number, limit: number|null, reason: string }}
 */
export function checkTokenBudget(input) {
  const limit = Number.isFinite(input?.dailyTokens) ? Number(input.dailyTokens) : null;
  const used = Number.isFinite(input?.usedTokens) ? Number(input.usedTokens) : 0;
  if (limit === null) return { ok: true, used, limit: null, reason: "" };
  if (used >= limit) return { ok: false, used, limit, reason: "budget/daily-tokens" };
  return { ok: true, used, limit, reason: "" };
}
