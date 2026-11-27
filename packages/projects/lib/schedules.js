// @ts-check
// 宿主定时任务（`ctx.schedule`）与项目生命周期的**对账**（审计 AUD-PROJ-02）。
//
// 为什么需要这一层：routines 与 schedule 模式的提醒每次投递 = 一次模型调用（花 token）。
// 以前 pause/archive/delete 只改本地元数据，宿主条目照旧到点投递；而 pauseProject 在
// README/测试文档里的承诺是「暂停只停新建线程与定时任务」。这里把「项目状态 → 宿主条目
// 该处于什么状态」写成纯计划函数，再配一个注入 schedule 的对账执行器（可在单测里用
// 假 schedule 驱动，不需要宿主包）。
//
// 属于「不认识就保留」：只处理本插件自己记录的 `scheduleId`，不扫描宿主里别的条目。

/** 项目状态 → 宿主条目应有的处置。 */
export const SCHEDULE_ACTIONS = Object.freeze(["pause", "resume", "delete", "none"]);

/**
 * 项目状态对应的对账动作。
 * @param {string} action 本插件发起的生命周期动作：pause / resume / archive / delete
 * @returns {"pause"|"resume"|"delete"|"none"}
 */
export function plannedScheduleAction(action) {
  const value = String(action ?? "");
  if (value === "pause" || value === "archive") return "pause";
  if (value === "resume") return "resume";
  if (value === "delete") return "delete";
  return "none";
}

/**
 * 从项目记录里取出所有宿主定时条目（routines + schedule 模式的提醒）。
 *
 * 只收 `scheduleId` 非空的；manual 档 routine / timer 档提醒没有宿主条目，自然跳过。
 * @param {any} project
 * @returns {{ scheduleId: string, kind: "routine"|"reminder", id: string, title: string }[]}
 */
export function collectHostSchedules(project) {
  /** @type {{ scheduleId: string, kind: "routine"|"reminder", id: string, title: string }[]} */
  const out = [];
  const routines = Array.isArray(project?.routines) ? project.routines : [];
  for (const routine of routines) {
    const scheduleId = String(routine?.scheduleId ?? "");
    if (scheduleId === "") continue;
    out.push({
      scheduleId,
      kind: "routine",
      id: String(routine?.id ?? ""),
      title: String(routine?.name ?? ""),
    });
  }
  const reminders = Array.isArray(project?.reminders) ? project.reminders : [];
  for (const reminder of reminders) {
    const scheduleId = String(reminder?.scheduleId ?? "");
    if (scheduleId === "") continue;
    out.push({
      scheduleId,
      kind: "reminder",
      id: String(reminder?.id ?? ""),
      title: String(reminder?.text ?? "").slice(0, 80),
    });
  }
  return out;
}

/**
 * 对账：把项目当前状态对应的处置应用到宿主 schedule 上。
 *
 * 语义：
 *  - `pause` / `archive`：宿主动作是 `update status=paused`（可逆：取消暂停/取消归档时恢复）。
 *    已经有本地 `enabled:false` 的 routine 不重复改（它本来就是 paused）。
 *  - `delete`：宿主动作是 `edit action=delete`（项目没了，条目不该再存在）；
 *    且**只删除**——删不掉的如实记 failure，不静默吞。
 *  - `resume`：只恢复本地 `enabled !== false` 的 routine（用户显式停掉的保持停）。
 *
 * 提醒只有「一次性 timer」和「schedule」两种，pause/archive 时用 update 暂停；
 * 宿主对已过期的条目 update 可能失败——失败不阻断主流程（回执里如实列出 failures）。
 * @param {object} input
 * @param {any} input.project 项目记录
 * @param {string} input.action 生命周期动作
 * @param {{ edit?: (request: any) => Promise<any>, create?: any } | null} [input.schedule] 宿主 schedule 服务
 * @param {(entry: any) => void} [input.onAudit] 审计回调（每条处置一次）
 * @returns {Promise<{ ok: boolean, planned: string, handled: any[], failures: any[], skipped: string[] }>}
 */
export async function reconcileHostSchedules(input) {
  const planned = plannedScheduleAction(input?.action);
  /** @type {any[]} */
  const handled = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {string[]} */
  const skipped = [];
  const entries = collectHostSchedules(input?.project);
  if (planned === "none") return { ok: true, planned, handled, failures, skipped: ["no-action"] };
  if (entries.length === 0)
    return { ok: true, planned, handled, failures, skipped: ["no-host-schedules"] };

  const schedule = input?.schedule;
  if (!schedule || typeof schedule.edit !== "function") {
    // 宿主服务不可用：如实失败，让调用方决定是否阻断（删除项目时**必须**阻断，
    // 否则会留下无人值守继续烧 token 的孤儿条目）。
    return {
      ok: false,
      planned,
      handled,
      failures: entries.map((entry) => ({ ...entry, reason: "schedule-unavailable" })),
      skipped: ["schedule-unavailable"],
    };
  }

  for (const entry of entries) {
    // resume 时尊重用户显式停用的 routine：不擅自把它打开
    if (planned === "resume") {
      const routine = (Array.isArray(input?.project?.routines) ? input.project.routines : []).find(
        (/** @type {any} */ item) => String(item?.id ?? "") === entry.id,
      );
      if (entry.kind === "routine" && routine && routine.enabled === false) {
        skipped.push(entry.scheduleId);
        continue;
      }
    }
    if (planned === "pause") {
      const routine = (Array.isArray(input?.project?.routines) ? input.project.routines : []).find(
        (/** @type {any} */ item) => String(item?.id ?? "") === entry.id,
      );
      if (entry.kind === "routine" && routine && routine.enabled === false) {
        skipped.push(entry.scheduleId);
        continue;
      }
    }
    try {
      if (planned === "delete") {
        await schedule.edit({ id: entry.scheduleId, action: "delete" });
      } else {
        await schedule.edit({
          id: entry.scheduleId,
          action: "update",
          patch: { status: planned === "pause" ? "paused" : "active" },
        });
      }
      handled.push({ ...entry, op: planned });
      input?.onAudit?.({ action: `${entry.kind}/reconciled`, ...entry, op: planned });
    } catch (error) {
      const reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 160);
      failures.push({ ...entry, reason });
      input?.onAudit?.({ action: `${entry.kind}/reconcile-failed`, ...entry, op: planned, reason });
    }
  }
  return { ok: failures.length === 0, planned, handled, failures, skipped };
}

/**
 * 新建自动投递（routine / schedule 提醒）前的项目状态闸。
 *
 * 暂停/归档的项目不该还能新建「到点自动花 token」的定时任务——否则 pause 这个急停按钮
 * 只停内存里的东西，花钱的路径照旧（审计 AUD-PROJ-02）。
 * @param {{ state?: string } | null | undefined} project
 * @returns {{ ok: true, reason: "" } | { ok: false, reason: string }}
 */
export function checkProjectAcceptsAutomation(project) {
  const state = String(project?.state ?? "active");
  if (state === "paused") return { ok: false, reason: "project-paused" };
  if (state === "archived") return { ok: false, reason: "project-archived" };
  return { ok: true, reason: "" };
}
