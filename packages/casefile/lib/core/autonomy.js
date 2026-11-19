// @ts-check
// core/autonomy.js：自主性阶梯（L0–L3）的解锁与预算判定。
//
// 为什么要有这一层：`runCycle` 已经能自动跑"构建→检查→关闭义务"，但**谁能让它
// 无人值守地跑**必须有硬条件，否则就是"全自动复刻"——那是明确不做的非目标。
//
// 硬规则（写死，不可配置放宽）：
//   1. 只有 `scope: "selected"` 的项目能升到 L3；
//   2. 只有 existence / structure / behavior / visual 四类义务允许 L3；
//      `coverage`（覆盖率硬门）与 `regression`（回归门）永远人工复核；
//   3. 每条义务必须有**可执行的检查配方**（`check`），否则"没人验"会被自动跑成绿灯；
//   4. 必须有预算上限；预算耗尽或任一轮 fail/unknown 立即停。

export const AUTONOMY_LEVELS = /** @type {const} */ (["L0", "L1", "L2", "L3"]);

/** L3 允许自动关闭的义务种类。 */
export const L3_ALLOWED_KINDS = /** @type {const} */ ([
  "existence",
  "structure",
  "behavior",
  "visual",
]);

export const AUTONOMY_DEFAULT_BUDGET = {
  maxRounds: 5,
  maxBuilds: 20,
  maxWallClockMs: 30 * 60 * 1000,
};

/**
 * 归一化预算：缺项用默认值，非法值报错。
 * @param {Record<string, any> | null | undefined} raw
 * @returns {{ maxRounds: number, maxBuilds: number, maxWallClockMs: number }}
 */
export function normalizeBudget(raw) {
  /** @param {"maxRounds" | "maxBuilds" | "maxWallClockMs"} key */
  const pick = (key) => {
    const value = raw?.[key];
    if (value == null) return AUTONOMY_DEFAULT_BUDGET[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw Object.assign(new Error(`预算 ${key} 必须是正数`), { code: "invalid-input" });
    }
    return Math.floor(value);
  };
  return {
    maxRounds: pick("maxRounds"),
    maxBuilds: pick("maxBuilds"),
    maxWallClockMs: pick("maxWallClockMs"),
  };
}

/**
 * 判断能否解锁到 L3。
 * @param {{
 *   project: Record<string, any>,
 *   obligations: Record<string, any>[],
 *   budget?: Record<string, any> | null,
 * }} input
 * @returns {{ ok: boolean, blockers: string[], budget: { maxRounds: number, maxBuilds: number, maxWallClockMs: number } }}
 */
export function evaluateUnlock(input) {
  /** @type {string[]} */
  const blockers = [];
  const project = input.project ?? {};
  if (project.scope !== "selected") {
    blockers.push("scope-not-selected");
  }
  const obligations = Array.isArray(input.obligations) ? input.obligations : [];
  if (obligations.length === 0) {
    blockers.push("no-obligations");
  }
  const disallowed = obligations.filter((item) => !L3_ALLOWED_KINDS.includes(item.kind));
  if (disallowed.length > 0) {
    blockers.push(
      `kind-not-allowed:${[...new Set(disallowed.map((item) => item.kind))].join(",")}`,
    );
  }
  const withoutCheck = obligations.filter((item) => item.check == null);
  if (withoutCheck.length > 0) {
    blockers.push(`obligation-without-check:${withoutCheck.length}`);
  }
  if (project.state === "archived") {
    blockers.push("project-archived");
  }
  let budget = AUTONOMY_DEFAULT_BUDGET;
  try {
    budget = normalizeBudget(input.budget);
  } catch {
    blockers.push("invalid-budget");
  }
  return { ok: blockers.length === 0, blockers, budget };
}

/**
 * 按预算判停。
 * @param {{
 *   builds: Record<string, any>[],
 *   startedAt: string | null,
 *   nowMs?: number,
 *   budget: { maxRounds: number, maxBuilds: number, maxWallClockMs: number },
 *   lastVerdict?: string | null,
 * }} input
 * @returns {{ stop: boolean, reason: string | null, detail: Record<string, any> }}
 */
export function evaluateBudget(input) {
  const builds = Array.isArray(input.builds) ? input.builds : [];
  const budget = input.budget ?? AUTONOMY_DEFAULT_BUDGET;
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const startedMs = input.startedAt == null ? null : Date.parse(input.startedAt);
  const elapsedMs =
    startedMs == null || !Number.isFinite(startedMs) ? 0 : Math.max(0, nowMs - startedMs);
  const detail = {
    builds: builds.length,
    budgetBuilds: budget.maxBuilds,
    elapsedMs,
    budgetMs: budget.maxWallClockMs,
  };
  // 任何一轮 fail/unknown 立即停：无人值守时"失败"必须交回给人，不能刷灯。
  if (input.lastVerdict === "fail" || input.lastVerdict === "unknown") {
    return { stop: true, reason: `l3-${input.lastVerdict}`, detail };
  }
  if (builds.length >= budget.maxBuilds) {
    return { stop: true, reason: "l3-budget-builds", detail };
  }
  if (elapsedMs >= budget.maxWallClockMs) {
    return { stop: true, reason: "l3-budget-time", detail };
  }
  return { stop: false, reason: null, detail };
}

/**
 * 归一化项目上的 autonomy 字段。
 * @param {Record<string, any> | null | undefined} raw
 * @returns {{ level: "L0" | "L1" | "L2" | "L3", unlockedAt: string | null, budget: { maxRounds: number, maxBuilds: number, maxWallClockMs: number } }}
 */
export function normalizeAutonomy(raw) {
  const level = raw && AUTONOMY_LEVELS.includes(raw.level) ? raw.level : "L2";
  return {
    level,
    unlockedAt: typeof raw?.unlockedAt === "string" ? raw.unlockedAt : null,
    budget: normalizeBudget(raw?.budget ?? null),
  };
}
