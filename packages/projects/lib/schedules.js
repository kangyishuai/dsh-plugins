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
 * 暂停/恢复宿主条目时的 **SchedulePatch**（shipped contract，别凭想象写）。
 *
 * `@deepseek-ai/dsh-schedule@0.2.2-rc.5` 的 `SchedulePatch` 只有
 * `{title?, prompt?, timing?, target?, active?: boolean}`；宿主 `revisedTask()` 只读
 * `patch.active`（`false` → paused，`true` → active），**没有 `patch.status`**——
 * 复审实测：插件以前发 `{status:"paused"}` 被静默忽略，pause/archive/resume 全是假成功。
 * 所有「改宿主启停」的路径都必须经过这里，别再手写 patch 字面量。
 * @param {string} op `"pause"` 之外的任何值都按「恢复」处理
 * @returns {{ active: boolean }}
 */
export function hostActivePatch(op) {
  return { active: String(op) !== "pause" };
}

/**
 * 这个宿主错误是不是**终止态**（复审 N3）。
 *
 * 对「规则已耗尽的一次性任务」发 `active:true` 恢复，宿主会抛
 * `ScheduleInputError('not_future', "The scheduled time must be strictly in the future.")`
 * （`src/update.ts` 的重算路径）——它没有未来发生时点，不可能再投递。
 * 这不是失败，是「已终结」：恢复对账应跳过并如实标注，不写 failure 审计。
 * @param {any} error
 * @returns {boolean}
 */
export function isTerminalScheduleError(error) {
  const code = String(error?.code ?? "");
  if (code === "not_future") return true;
  const details = String(error?.details?.code ?? "");
  if (details === "not_future") return true;
  const message = String(error?.message ?? error ?? "");
  return /not_future|strictly in the future/u.test(message);
}

/**
 * 分类宿主 `schedule.edit()` 的返回（shipped contract）。
 *
 * 契约（`ScheduleEditResult`）：成功 → 任务条目（含 `id`/`status`）；删除成功 →
 * `{id, deleted:true}`；查不到 → `{id, code:'schedule_not_found'}`；版本冲突 →
 * `{id, code:'schedule_conflict'}`。**不会**用 `{ok:false}` 表达失败（失败是抛错），
 * 所以以前 `edited.ok === false` 的分支永远不成立。
 * @param {any} result
 * @returns {{ kind: "task"|"deleted"|"not-found"|"conflict"|"unknown", code: string, status: string }}
 */
export function classifyHostScheduleResult(result) {
  const code = String(result?.code ?? "");
  if (code === "schedule_not_found") return { kind: "not-found", code, status: "" };
  if (code === "schedule_conflict") return { kind: "conflict", code, status: "" };
  if (code !== "") return { kind: "unknown", code, status: "" };
  if (result?.deleted === true) return { kind: "deleted", code: "", status: "" };
  if (result && typeof result === "object" && typeof result.id === "string") {
    return { kind: "task", code: "", status: String(result.status ?? "") };
  }
  return { kind: "unknown", code: "", status: "" };
}

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
 *  - `pause` / `archive`：宿主动作是 `update {active:false}`（可逆：取消暂停/取消归档时 `{active:true}`）。
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
 * @returns {Promise<{ ok: boolean, planned: string, handled: any[], failures: any[], skipped: string[], unavailable?: number }>}
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
    // 没有宿主 schedule 服务 = 这台部署里**不存在投递机制**（不是"暂时读不到"：
    // `ctx.get("schedule")` 拿到的是同进程服务实例，缺失只可能是部署里没装载）。
    // 既然条目不可能被触发，就不能因此把项目卡成不可删（复审 F6a/F7）。
    // 如实返回 skipped + 条目数，由调用方写一条审计说明「这些记录停不了、也不会跑」。
    return {
      ok: true,
      planned,
      handled,
      failures,
      skipped: ["schedule-unavailable"],
      unavailable: entries.length,
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
      const result =
        planned === "delete"
          ? await schedule.edit({ id: entry.scheduleId, action: "delete" })
          : await schedule.edit({
              id: entry.scheduleId,
              action: "update",
              // 宿主契约：只有 `active` 能改启停（写 `status` 会被静默忽略 → 假成功）。
              patch: hostActivePatch(planned === "pause" ? "pause" : "resume"),
            });
      const outcome = classifyHostScheduleResult(result);
      if (outcome.kind === "conflict") {
        // 理论分支：本插件从不发 `expectedUpdatedAt`，所以当前不会真的收到 conflict；
        // 保留判定是为了「将来加了乐观锁」时不会静默当成功（复审 N2）。
        failures.push({ ...entry, reason: "schedule_conflict" });
        input?.onAudit?.({
          action: `${entry.kind}/reconcile-failed`,
          ...entry,
          op: planned,
          reason: "schedule_conflict",
        });
        continue;
      }
      if (outcome.kind === "not-found") {
        // 宿主里已经没有这条任务 → 不可能再投递，目标状态已达成（不阻塞删除）。
        handled.push({ ...entry, op: planned, missing: true });
        input?.onAudit?.({
          action: `${entry.kind}/reconciled`,
          ...entry,
          op: planned,
          missing: true,
        });
        continue;
      }
      handled.push({
        ...entry,
        op: planned,
        verified: outcome.kind === "task" ? outcome.status : "",
      });
      input?.onAudit?.({ action: `${entry.kind}/reconciled`, ...entry, op: planned });
    } catch (error) {
      // N3：已耗尽的一次性任务无法恢复（宿主 not_future）→ 「已终结」，跳过且不记 failure。
      if (planned === "resume" && isTerminalScheduleError(error)) {
        handled.push({ ...entry, op: planned, terminal: true });
        input?.onAudit?.({ action: `${entry.kind}/terminal`, ...entry, op: planned });
        continue;
      }
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
