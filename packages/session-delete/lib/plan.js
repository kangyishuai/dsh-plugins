// @ts-check
// plan 是纯函数：输入一份事实快照，输出可展示、可比对的影响面对象。
// 执行阶段会用同一个函数重算 digest，不一致就中止 —— 预演与执行永不漂移（ADR 0004 §1）。
import { createHash } from "node:crypto";

/**
 * @typedef {object} ActivityGroup
 * @property {string} kind 活动类型（turn / subagent / job / schedule / other）。
 * @property {number} count 条目数。
 * @property {string[]} labels 人类可读标签（标题或 id）。
 */

/**
 * @typedef {object} PlanBlocker
 * @property {string} code 稳定的机器可读原因码。
 * @property {string} message 给用户看的原因。
 */

/**
 * @typedef {object} PlanInput
 * @property {string} sessionId
 * @property {string | null} [title]
 * @property {string | null} [cwd]
 * @property {number | null} [sizeBytes]
 * @property {boolean} [live]
 * @property {ActivityGroup[]} [activity]
 * @property {{ id: string, title: string | null }[]} [children]
 * @property {{ path: string, tier: "locate" | "scan" } | null} [location]
 * @property {string | null} [trashPath]
 * @property {{ id: string, label: string, tier: string }[]} [removes]
 * @property {PlanBlocker[]} [blockers]
 */

/**
 * @typedef {object} Plan
 * @property {number} version
 * @property {string} sessionId
 * @property {string | null} title
 * @property {string | null} cwd
 * @property {number | null} sizeBytes
 * @property {boolean} live
 * @property {ActivityGroup[]} activity
 * @property {{ id: string, title: string | null }[]} children
 * @property {{ path: string, tier: "locate" | "scan" } | null} location
 * @property {string | null} trashPath
 * @property {{ id: string, label: string, tier: string }[]} removes
 * @property {PlanBlocker[]} blockers
 * @property {string} digest
 */

/**
 * 确定性序列化：键排序、丢弃 undefined，保证同一份事实永远得到同一摘要。
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",") +
    "}"
  );
}

/** @param {string} text @returns {string} */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 摘要只覆盖「影响删除后果」的字段：目标、定位、体积、活体、活动、子会话、引用清单、阻断原因。
 * 标题与时间戳不参与，避免因为改名导致用户需要重新确认。
 * @param {Omit<Plan, "digest" | "version">} plan
 * @returns {string}
 */
export function digestOf(plan) {
  const canonical = {
    sessionId: plan.sessionId,
    cwd: plan.cwd,
    sizeBytes: plan.sizeBytes,
    live: plan.live,
    location: plan.location?.path ?? null,
    trashPath: plan.trashPath,
    activity: plan.activity.map((g) => ({ kind: g.kind, count: g.count })),
    children: plan.children.map((c) => c.id).sort(),
    removes: plan.removes.map((r) => r.id).sort(),
    blockers: plan.blockers.map((b) => b.code).sort(),
  };
  return sha256(stableStringify(canonical)).slice(0, 32);
}

/**
 * 生成 Plan。纯函数：不读盘、不调宿主服务。
 * @param {PlanInput} input
 * @returns {Plan}
 */
export function buildPlan(input) {
  const activity = [...(input.activity ?? [])].sort((a, b) => a.kind.localeCompare(b.kind));
  const children = [...(input.children ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const removes = [...(input.removes ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  /** @type {PlanBlocker[]} */
  const blockers = [];
  if (!input.location) {
    blockers.push({
      code: "session-delete/location-unknown",
      message: "找不到这个会话在磁盘上的位置（可能是新版本换了目录布局）。",
    });
  }
  for (const blocker of input.blockers ?? []) {
    if (!blockers.some((b) => b.code === blocker.code)) blockers.push(blocker);
  }

  /** @type {Omit<Plan, "digest">} */
  const base = {
    version: 1,
    sessionId: input.sessionId,
    title: input.title ?? null,
    cwd: input.cwd ?? null,
    sizeBytes: typeof input.sizeBytes === "number" ? input.sizeBytes : null,
    live: Boolean(input.live),
    activity,
    children,
    location: input.location ?? null,
    trashPath: input.trashPath ?? null,
    removes,
    blockers,
  };
  return { ...base, digest: digestOf(base) };
}

/**
 * 执行前重新计算摘要，用于拦截「确认框打开期间事实发生变化」。
 * @param {Plan} plan
 * @returns {boolean} 摘要是否仍然一致。
 */
export function planStillValid(plan) {
  return digestOf(plan) === plan.digest;
}

/**
 * 是否允许执行删除（没有阻断原因）。
 * @param {Plan} plan
 * @returns {boolean}
 */
export function planExecutable(plan) {
  return plan.blockers.length === 0;
}

/**
 * 影响面的一句话摘要（确认框与审计共用）。
 * @param {Plan} plan
 * @returns {string}
 */
export function summarizePlan(plan) {
  const parts = [];
  parts.push(plan.sizeBytes === null ? "体积未知" : `${formatBytes(plan.sizeBytes)}`);
  if (plan.live) parts.push("会话正在本机打开");
  if (plan.children.length > 0) parts.push(`${plan.children.length} 个子代理会话`);
  if (plan.activity.length > 0)
    parts.push(plan.activity.map((a) => `${a.count} 个${a.kind}`).join("、"));
  return parts.join(" · ");
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
