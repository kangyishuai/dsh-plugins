// @ts-check
// 恢复之后的校验（AUD-SD-02）：光把目录搬回来不算「恢复成功」——
// 还要确认会话目录真的在原处、工作区归属与置顶状态（如果原本有）真的回来了。
// 这些结论进回执与界面，失败必须说出来，而不是一律报成功。
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/**
 * @typedef {object} RestoreCheck
 * @property {string} id
 * @property {string} label
 * @property {"ok" | "failed" | "skipped"} status
 * @property {string} detail
 */

/**
 * @param {object} options
 * @param {import("./refs.js").RefAdapter[]} options.refs
 * @param {string} options.sessionId
 * @param {string} options.restoredTo
 * @param {{ workspaceIds?: string[], pinned?: boolean | null }} options.meta
 * @returns {Promise<RestoreCheck[]>}
 */
export async function verifyRestored({ refs, sessionId, restoredTo, meta }) {
  /** @type {RestoreCheck[]} */
  const checks = [];

  const dirOk = await stat(restoredTo)
    .then((value) => value.isDirectory())
    .catch(() => false);
  checks.push({
    id: "session-dir",
    label: "会话目录",
    status: dirOk ? "ok" : "failed",
    detail: dirOk ? `已回到 ${restoredTo}` : `没有回到 ${restoredTo}`,
  });

  const workspaceIds = Array.isArray(meta.workspaceIds) ? meta.workspaceIds : [];
  const slot = refs.find((ref) => ref.id === "workspace-slot");
  if (workspaceIds.length === 0) {
    checks.push({
      id: "workspace-slot",
      label: "工作区记账",
      status: "skipped",
      detail: "原本不在任何工作区",
    });
  } else if (typeof slot?.snapshot !== "function") {
    checks.push({
      id: "workspace-slot",
      label: "工作区记账",
      status: "skipped",
      detail: "当前宿主无法读取工作区记账",
    });
  } else {
    try {
      const snapshot = await slot.snapshot(sessionId);
      const present = new Set(snapshot?.workspaceIds ?? []);
      const missing = workspaceIds.filter((workspaceId) => !present.has(workspaceId));
      checks.push({
        id: "workspace-slot",
        label: "工作区记账",
        status: missing.length === 0 ? "ok" : "failed",
        detail: missing.length === 0 ? "已挂回原工作区" : `未挂回：${missing.join("、")}`,
      });
    } catch (error) {
      checks.push({
        id: "workspace-slot",
        label: "工作区记账",
        status: "skipped",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const pin = refs.find((ref) => ref.id === "workspace-pin");
  if (meta.pinned !== true) {
    checks.push({
      id: "workspace-pin",
      label: "置顶标记",
      status: "skipped",
      detail: meta.pinned === false ? "原本未置顶" : "置顶状态未知",
    });
  } else if (typeof pin?.snapshot !== "function") {
    checks.push({
      id: "workspace-pin",
      label: "置顶标记",
      status: "skipped",
      detail: "当前宿主无法读取置顶集合",
    });
  } else {
    // 置顶集合只能读 storages/workspace.json，而宿主是写后落盘：刚 pin() 完就读可能还是旧值。
    // 读两次（间隔一小会儿）再判定，避免把「尚未 flush」误报成「没恢复」。
    /** @type {boolean | null} */
    let pinnedState = false;
    /** @type {string | null} */
    let pinError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(60);
      try {
        const snapshot = await pin.snapshot(sessionId);
        if (snapshot?.pinned === true) {
          pinnedState = true;
          break;
        }
        pinnedState = snapshot?.pinned === null || snapshot?.pinned === undefined ? null : false;
        if (pinnedState === null) break;
      } catch (error) {
        pinError = error instanceof Error ? error.message : String(error);
        pinnedState = null;
        break;
      }
    }
    checks.push({
      id: "workspace-pin",
      label: "置顶标记",
      status: pinnedState === true ? "ok" : pinnedState === null ? "skipped" : "failed",
      detail:
        pinnedState === true
          ? "已恢复置顶"
          : pinnedState === null
            ? (pinError ?? "无法读取置顶集合（状态未知）")
            : "置顶没有恢复",
    });
  }

  return checks;
}

/**
 * 一次恢复里「有没有没做到的」：引用失败或校验失败都算不完整。
 * @param {{ status: string }[]} refResults
 * @param {RestoreCheck[]} checks
 */
export function restoreSummary(refResults, checks) {
  const failedRefs = refResults.filter((item) => item.status === "failed");
  const failedChecks = checks.filter((item) => item.status === "failed");
  return {
    refs: refResults.length,
    failedRefs: failedRefs.length,
    failedChecks: failedChecks.length,
    partial: failedRefs.length > 0 || failedChecks.length > 0,
  };
}
