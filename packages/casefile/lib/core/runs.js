// @ts-check
// core/runs.js：构建/验收运行记录与循环停止条件。纯 Node，可单测。
//
// 口径（spec/03-acceptance.md §4–§5）：
//   - 每次构建产出一个 BuildRun，带 implementationDigest；
//   - 每次检查产出一个 CheckResult，绑定「实现 digest + 原件 digest + 采集时刻」；
//   - 实现变了 → 依赖它的已关闭义务自动回到 open（stale），不静默保留绿灯。

import { shortDigest } from "./digest.js";
import { newId, nowIso } from "./model.js";

/** 构建状态。 */
export const BUILD_STATUSES = /** @type {const} */ ([
  "running",
  "pass",
  "fail",
  "error",
  "stopped",
]);

/** 默认停止条件。 */
export const DEFAULT_STOP = {
  maxRounds: 5,
  maxFailures: 3,
  noProgressRounds: 2,
};

/**
 * 规范化一次构建。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeBuildRun(input) {
  const command = String(input?.command ?? "").trim();
  if (command === "") {
    throw Object.assign(new Error("command 不能为空"), { code: "invalid-input" });
  }
  const status = String(input?.status ?? "running");
  if (!BUILD_STATUSES.includes(/** @type {any} */ (status))) {
    throw Object.assign(new Error(`status 必须是 ${BUILD_STATUSES.join(" | ")}`), {
      code: "invalid-input",
    });
  }
  return {
    id: newId("build"),
    round: Number.isInteger(input?.round) && input.round > 0 ? input.round : 1,
    command,
    cwd: input?.cwd == null ? null : String(input.cwd),
    status,
    exitCode: Number.isInteger(input?.exitCode) ? input.exitCode : null,
    implementationDigest:
      input?.implementationDigest == null ? null : String(input.implementationDigest),
    startedAt: input?.startedAt == null ? nowIso() : String(input.startedAt),
    endedAt: input?.endedAt == null ? null : String(input.endedAt),
    detail: input?.detail == null ? "" : String(input.detail).slice(0, 4000),
    artifacts: Array.isArray(input?.artifacts) ? input.artifacts.map(String) : [],
  };
}

/**
 * 下一轮轮次。
 * @param {Array<Record<string, any>>} builds
 * @returns {number}
 */
export function nextRound(builds) {
  const max = builds.reduce((acc, item) => Math.max(acc, Number(item.round) || 0), 0);
  return max + 1;
}

/**
 * 最近一次构建（按 round 取最大）。
 * @param {Array<Record<string, any>>} builds
 * @returns {Record<string, any> | undefined}
 */
export function latestBuild(builds) {
  return [...builds].sort((a, b) => (Number(b.round) || 0) - (Number(a.round) || 0))[0];
}

/**
 * 循环停止条件（spec/03-acceptance.md §5.2）。
 * @param {{
 *   builds: Array<Record<string, any>>,
 *   checks: Array<Record<string, any>>,
 *   openObligations: number,
 *   stop?: Partial<typeof DEFAULT_STOP>,
 * }} input
 * @returns {{ stop: boolean, reason: string, detail: Record<string, any> }}
 */
export function evaluateStop(input) {
  const stop = { ...DEFAULT_STOP, ...(input.stop ?? {}) };
  const builds = input.builds ?? [];
  const checks = input.checks ?? [];
  const rounds = builds.length;
  const failures = builds.filter(
    (item) => item.status === "fail" || item.status === "error",
  ).length;
  const detail = {
    rounds,
    failures,
    openObligations: input.openObligations ?? 0,
    maxRounds: stop.maxRounds,
    maxFailures: stop.maxFailures,
  };
  if (rounds >= stop.maxRounds) {
    return { stop: true, reason: "max-rounds", detail };
  }
  if (failures >= stop.maxFailures) {
    return { stop: true, reason: "max-failures", detail };
  }
  // 连续无进展：最近 N 轮构建都没有产出新的实现 digest
  const recent = [...builds].sort((a, b) => (Number(b.round) || 0) - (Number(a.round) || 0));
  const digests = recent
    .slice(0, stop.noProgressRounds + 1)
    .map((item) => item.implementationDigest)
    .filter((value) => typeof value === "string" && value !== "");
  const noProgress = digests.length >= stop.noProgressRounds + 1 && new Set(digests).size === 1;
  if (noProgress) {
    return {
      stop: true,
      reason: "no-progress",
      detail: { ...detail, digest: shortDigest(digests[0]) },
    };
  }
  if (checks.some((item) => item.verdict === "unknown")) {
    const unknown = checks.filter((item) => item.verdict === "unknown").length;
    return { stop: true, reason: "checker-unknown", detail: { ...detail, unknown } };
  }
  return { stop: false, reason: "continue", detail };
}

/**
 * 判断已关闭的义务是否因实现/原件变化而失效（stale）。
 * @param {{
 *   obligations: Array<Record<string, any>>,
 *   checks: Array<Record<string, any>>,
 *   implementationDigest: string | null,
 *   originalDigest: string | null,
 *   maxAgeMs?: number,
 *   now?: number,
 * }} input
 * @returns {Array<{ obligationId: string, reasons: string[] }>}
 */
export function findStaleObligations(input) {
  const maxAgeMs = input.maxAgeMs ?? 24 * 3600 * 1000;
  const now = input.now ?? Date.now();
  const byId = new Map((input.checks ?? []).map((/** @type {any} */ item) => [item.id, item]));
  /** @type {Array<{ obligationId: string, reasons: string[] }>} */
  const stale = [];
  for (const obligation of input.obligations ?? []) {
    if (obligation.status !== "pass") continue;
    /** @type {string[]} */
    const reasons = [];
    const closing = (obligation.checkIds ?? [])
      .map((/** @type {any} */ id) => byId.get(id))
      .filter((/** @type {any} */ item) => item !== undefined)
      .at(-1);
    if (!closing) {
      reasons.push("missing-check");
    } else {
      if (
        input.implementationDigest != null &&
        closing.implementationDigest !== input.implementationDigest
      ) {
        reasons.push("implementation-changed");
      }
      if (input.originalDigest != null && closing.originalDigest !== input.originalDigest) {
        reasons.push("original-changed");
      }
      const age = now - Date.parse(closing.evidenceFetchedAt ?? 0);
      if (!Number.isFinite(age) || age > maxAgeMs) reasons.push("check-stale");
    }
    if (reasons.length > 0) stale.push({ obligationId: obligation.id, reasons });
  }
  return stale;
}

/**
 * 运行摘要（工作台/工具输出用）。
 * @param {{ builds: Array<Record<string, any>>, checks: Array<Record<string, any>>, obligations: Array<Record<string, any>> }} input
 * @returns {Record<string, any>}
 */
export function summarizeRuns(input) {
  const builds = input.builds ?? [];
  const checks = input.checks ?? [];
  const obligations = input.obligations ?? [];
  const last = latestBuild(builds);
  return {
    builds: builds.length,
    lastBuild: last
      ? {
          id: last.id,
          round: last.round,
          status: last.status,
          exitCode: last.exitCode,
          implementationDigest: shortDigest(last.implementationDigest),
          endedAt: last.endedAt,
        }
      : null,
    checks: checks.length,
    verdicts: {
      pass: checks.filter((item) => item.verdict === "pass").length,
      fail: checks.filter((item) => item.verdict === "fail").length,
      unknown: checks.filter((item) => item.verdict === "unknown").length,
    },
    obligations: {
      total: obligations.length,
      open: obligations.filter((item) => item.status === "open").length,
      pass: obligations.filter((item) => item.status === "pass").length,
    },
  };
}
