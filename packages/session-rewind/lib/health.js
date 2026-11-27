// @ts-check
// 诊断（doctor）检查项构造：把宿主/文件引擎的事实拼成 checks，**不 import 任何 @deepseek-ai/***，
// 便于用假 store / 假 orphans / 假 session 单测（AUD-REW-16 / USIM-U3-06）。
//
// 消费方（service.js）只负责提供宿主能力（当前会话的 marker/cwd 事实）。每项同时返回
// `name`（英文兜底）与 `nameKey`（客户端 locale 键）+ 可选 `detailKey`/`detailParams`，
// 避免在 host 半拼中文（ctx.locale 只在 client 半）。
import { cutsOf } from "./plan.js";

/** 审计日志检查最多读多少条（足够覆盖真实使用；不是「只读 1 条」）。 */
export const HEALTH_AUDIT_READ_LIMIT = 1000;

/**
 * @typedef {object} HealthCheck
 * @property {string} name 英文兜底名
 * @property {string} nameKey 客户端 locale 键
 * @property {boolean} ok
 * @property {string} detail 纯数据兜底
 * @property {string} [detailKey]
 * @property {Record<string, any>} [detailParams]
 */

/**
 * @typedef {object} HealthInput
 * @property {string} dataRoot 插件数据根
 * @property {boolean} trackingEnabled 文件追踪开关
 * @property {any} store 文件引擎（usage / readAudit）
 * @property {(input: {dataRoot: string}) => Promise<any>} findOrphans 孤儿枚举（纯读）
 * @property {any} [config] 插件配置
 * @property {boolean} [readOnlyToolInstalled] 只读工具是否注册成功
 * @property {string} [sessionId] 需要附加会话检查时传入
 * @property {(sessionId: string) => { markerShaped: boolean, cutCount: number, cwd: string | undefined }} [sessionCheck]
 *   由 service 提供的当前会话事实（避免本模块 import 宿主包）
 */

/**
 * 构造健康检查结果。
 * @param {HealthInput} input
 * @returns {Promise<{ok: boolean, version: number, dataRoot: string, checks: HealthCheck[], usage: any}>}
 */
export async function buildHealth(input) {
  /** @type {HealthCheck[]} */
  const checks = [];
  /**
   * @param {string} name
   * @param {string} nameKey
   * @param {boolean} ok
   * @param {Partial<HealthCheck>} [extra]
   * @returns {void}
   */
  const push = (name, nameKey, ok, extra = {}) => {
    checks.push({ name, nameKey, ok, detail: "", ...extra });
  };
  push(
    "data root",
    "health.dataRoot",
    typeof input.dataRoot === "string" && input.dataRoot !== "",
    { detail: input.dataRoot },
  );
  push(
    "file tracking",
    "health.tracking",
    input.trackingEnabled === true,
    input.trackingEnabled === true
      ? { detail: "enabled", detailKey: "health.enabled" }
      : { detail: "disabled in config", detailKey: "health.disabled" },
  );
  /** @type {any} */
  let usage = null;
  try {
    usage = await input.store.usage();
    push("file storage", "health.storage", true, {
      detail: `${usage.bytes} bytes / ${usage.entries} entries / ${usage.sessions} sessions`,
      detailKey: "health.storageLine",
      detailParams: { bytes: usage.bytes, entries: usage.entries, sessions: usage.sessions },
    });
  } catch (error) {
    push("file storage", "health.storage", false, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    // USIM-U3-06：旧实现用 `readAudit({ limit: 1 })` 再把长度当成条数，永远显示 1 条。
    // 这里按真实行数统计（上限 1000，足够覆盖使用；超出时如实说「至少 N 条」）。
    const audits = await input.store.readAudit({ limit: HEALTH_AUDIT_READ_LIMIT });
    const count = Array.isArray(audits) ? audits.length : 0;
    const saturated = count >= HEALTH_AUDIT_READ_LIMIT;
    push("audit log", "health.audit", true, {
      detail: `${count}${saturated ? "+" : ""} record(s) readable`,
      detailKey: saturated ? "health.auditRecordsAtLeast" : "health.auditRecords",
      detailParams: { count },
    });
  } catch (error) {
    push("audit log", "health.audit", false, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  push(
    "read-only tool",
    "health.readOnlyTool",
    input.config?.readOnlyTool === false ? true : input.readOnlyToolInstalled === true,
    input.config?.readOnlyTool === false
      ? { detail: "disabled by config", detailKey: "health.disabledByConfig" }
      : input.readOnlyToolInstalled === true
        ? { detail: "enabled", detailKey: "health.enabled" }
        : { detail: "not registered", detailKey: "health.notRegistered" },
  );
  try {
    const orphans = await input.findOrphans({ dataRoot: input.dataRoot });
    const unknownCount = Array.isArray(orphans.unknownIds) ? orphans.unknownIds.length : 0;
    if (orphans.enumerationFailed) {
      const unknownWorkspaces = Array.isArray(orphans.unknownWorkspaces)
        ? orphans.unknownWorkspaces.length
        : 0;
      push("orphan data", "health.orphans", false, {
        detail: `cannot enumerate live sessions (unreadable workspaces: ${orphans.unreadableWorkspaces}, unknown layout: ${unknownWorkspaces}, kept unknown items: ${unknownCount}); orphan cleanup was skipped`,
        detailKey: "health.orphansSkipped",
        detailParams: {
          workspaces: orphans.unreadableWorkspaces,
          unknownLayout: unknownWorkspaces,
          kept: unknownCount,
        },
      });
    } else {
      const count = orphans.sessionIds.length + orphans.trashIds.length + orphans.rescueIds.length;
      push("orphan data", "health.orphans", count === 0, {
        detail:
          count === 0
            ? `none (kept unknown items: ${unknownCount})`
            : `${count} dir(s), ${orphans.bytes} bytes (kept unknown items: ${unknownCount})`,
        detailKey: count === 0 ? "health.orphansNone" : "health.orphansCount",
        detailParams: { count, bytes: orphans.bytes, kept: unknownCount },
      });
    }
  } catch (error) {
    push("orphan data", "health.orphans", false, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof input.sessionId === "string" && input.sessionId !== "") {
    try {
      if (typeof input.sessionCheck !== "function") throw new Error("session check is unavailable");
      const session = input.sessionCheck(input.sessionId);
      push("session marker shape", "health.markerShape", session.markerShaped === true, {
        detail: `${session.cutCount} cut(s)`,
        detailKey: "health.markerCuts",
        detailParams: { count: session.cutCount },
      });
      push(
        "session cwd",
        "health.sessionCwd",
        session.cwd !== undefined,
        session.cwd === undefined
          ? { detail: "missing", detailKey: "health.cwdMissing" }
          : { detail: session.cwd },
      );
    } catch (error) {
      push("session check", "health.session", false, {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: checks.every((check) => check.ok),
    version: 1,
    dataRoot: input.dataRoot,
    checks,
    usage: usage ?? { bytes: 0, entries: 0, sessions: 0, blobs: 0 },
  };
}

/**
 * 当前会话的 marker 形状检查（service 侧把 events/session 传进来，避免本模块 import 宿主包）。
 * @param {any[]} events
 * @param {string | undefined} cwd
 * @returns {{markerShaped: boolean, cutCount: number, cwd: string | undefined}}
 */
export function sessionHealthFacts(events, cwd) {
  const cuts = cutsOf(events);
  return {
    markerShaped: cuts.every((cut) => cut.targetSeq < cut.markerSeq),
    cutCount: cuts.length,
    cwd,
  };
}
