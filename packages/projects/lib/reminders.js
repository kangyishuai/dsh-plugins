// @ts-check
// F30 提醒（双模式）：timer（本机计时，免费）与 schedule（宿主定时任务，会跑模型）。
// 纯函数、零 I/O：到期判断、重启恢复计划、状态迁移都在这里，宿主侧只负责 setTimeout 与落盘。
//
// 为什么必须两种：
// - 宿主 `schedule` 的「投递」就是往会话注入一条 prompt（docs/runtime §14），**一定花 token**；
// - 纯提醒只能自建定时器（`setTimeout` + 持久化到期时间），代价是「DSH 没开就不响」。
// 所以 UI 必须把「成本 / 关机是否生效」写清楚，由用户每条自选（默认取项目设置）。

/** 提醒的两种模式。 */
export const REMINDER_MODES = Object.freeze(["timer", "schedule"]);

/** 默认模式：免费的本机计时。 */
export const DEFAULT_REMINDER_MODE = "timer";

/** 提醒记录的状态词表。 */
export const REMINDER_STATES = Object.freeze(["pending", "fired", "cancelled", "done"]);

/** timer 模式的成本与生效条件（UI 原文）。 */
export const TIMER_MODE_NOTE =
  "免费：本机计时，不花模型调用；DSH 关着的时候不会响（重新打开后补一次）。";

/** schedule 模式的成本提示（UI 原文）。 */
export const SCHEDULE_MODE_NOTE = "计费：到点会跑一次模型（= 一次模型调用）；DSH 关着也会跑。";

/** 两种模式的并排差异（对话框里并排列出，避免用户只看到默认项）。 */
export const REMINDER_MODE_OPTIONS = Object.freeze([
  {
    mode: "timer",
    label: "免费（本机计时）",
    cost: "不花模型调用",
    offline: "DSH 关着不响",
    note: TIMER_MODE_NOTE,
  },
  {
    mode: "schedule",
    label: "定时任务（会跑模型）",
    cost: "每次到点跑一次模型",
    offline: "DSH 关着也会跑",
    note: SCHEDULE_MODE_NOTE,
  },
]);

/** 提前完成/取消后，提醒还会在列表里留多久（毫秒）。 */
export const REMINDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 提醒文本上限。 */
export const MAX_REMINDER_TEXT = 300;

/** @param {unknown} value @returns {"timer"|"schedule"|""} */
export function normalizeReminderMode(value) {
  const text = String(value ?? "").trim();
  return REMINDER_MODES.includes(text) ? /** @type {any} */ (text) : "";
}

/**
 * 项目默认值 + 本条的选择 → 最终模式。本条显式选择优先（用户每条自选）。
 * @param {unknown} projectDefault
 * @param {unknown} chosen
 * @returns {"timer"|"schedule"}
 */
export function resolveReminderMode(projectDefault, chosen) {
  return (
    normalizeReminderMode(chosen) || normalizeReminderMode(projectDefault) || DEFAULT_REMINDER_MODE
  );
}

/**
 * 到期时间收敛：接受 ISO 字符串 / Date / 毫秒数。
 * 过去的时间**照样接受**（调用方语义：已经到期 → 立即补一次，这正是重启恢复要的路径）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeReminderAt(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return "";
}

/**
 * 收敛一条提醒记录（读盘与写入口共用）。
 * @param {any} raw
 * @returns {any|null}
 */
export function normalizeReminder(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "") return null;
  const at = normalizeReminderAt(raw.at);
  if (at === "") return null;
  const state = REMINDER_STATES.includes(raw.state) ? raw.state : "pending";
  return {
    // 未知字段保留（同 store.normalize 的前向兼容口径）
    ...raw,
    id,
    projectId: typeof raw.projectId === "string" ? raw.projectId : "",
    at,
    text: String(raw.text ?? "").slice(0, MAX_REMINDER_TEXT),
    mode: normalizeReminderMode(raw.mode) || DEFAULT_REMINDER_MODE,
    state,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    firedAt: typeof raw.firedAt === "string" ? raw.firedAt : "",
    doneAt: typeof raw.doneAt === "string" ? raw.doneAt : "",
    scheduleId: typeof raw.scheduleId === "string" ? raw.scheduleId : "",
    unread: state === "fired" ? raw.unread !== false : false,
    notified: raw.notified === true,
    label: typeof raw.label === "string" ? raw.label.slice(0, 120) : "",
  };
}

/**
 * 是否还该被 arm（待触发）。
 * @param {any} reminder
 * @returns {boolean}
 */
export function isPending(reminder) {
  return reminder?.state === "pending";
}

/**
 * 到期分组：`due` 是已经到点但还没触发的，`pending` 是还没到点的。
 * 重启恢复就是「把盘上的 pending 过一遍这个函数」。
 * @param {any[]} reminders
 * @param {number} now
 * @returns {{ due: any[], pending: any[] }}
 */
export function splitByDue(reminders, now) {
  const list = Array.isArray(reminders) ? reminders : [];
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  /** @type {any[]} */
  const due = [];
  /** @type {any[]} */
  const pending = [];
  for (const reminder of list) {
    if (!isPending(reminder)) continue;
    const dueAt = Date.parse(String(reminder.at));
    if (!Number.isFinite(dueAt)) continue;
    if (dueAt <= at) due.push(reminder);
    else pending.push(reminder);
  }
  return { due, pending };
}

/**
 * 重启恢复计划：启动时把每条 pending 换算成「延迟多少毫秒触发」（到期/过期的给 0）。
 * 纯函数，单测直接喂时间即可覆盖「关机期间到点」的场景。
 * @param {any[]} reminders
 * @param {number} now
 * @returns {{ arm: Array<{ id: string, delayMs: number }>, overdue: string[], pending: string[] }}
 */
export function planReminderRecovery(reminders, now) {
  const list = Array.isArray(reminders) ? reminders.filter(isPending) : [];
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  /** @type {Array<{ id: string, delayMs: number }>} */
  const arm = [];
  /** @type {string[]} */
  const overdue = [];
  /** @type {string[]} */
  const pending = [];
  for (const reminder of list) {
    const dueAt = Date.parse(String(reminder.at));
    if (!Number.isFinite(dueAt)) continue;
    const delayMs = Math.max(0, dueAt - at);
    arm.push({ id: String(reminder.id), delayMs });
    if (delayMs === 0) overdue.push(String(reminder.id));
    else pending.push(String(reminder.id));
  }
  // 先到期的先 arm（宿主 setTimeout 的精度是毫秒，顺序只影响同刻的先后）
  arm.sort((left, right) => left.delayMs - right.delayMs);
  return { arm, overdue, pending };
}

/**
 * 触发：pending → fired（写回盘上，重启后不会再响第二次）。
 * @param {any} reminder @param {number} now
 * @returns {any}
 */
export function markFired(reminder, now) {
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  return {
    ...reminder,
    state: "fired",
    firedAt: new Date(at).toISOString(),
    unread: true,
    notified: false,
  };
}

/**
 * 取消（用户主动取消，或在宿主侧没建成功时回滚）。
 * @param {any} reminder @param {number} now
 * @returns {any}
 */
export function markCancelled(reminder, now) {
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  return { ...reminder, state: "cancelled", doneAt: new Date(at).toISOString(), unread: false };
}

/**
 * 提前完成（还没响就被用户做完/标记完成）。
 * @param {any} reminder @param {number} now
 * @returns {any}
 */
export function markDone(reminder, now) {
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  return { ...reminder, state: "done", doneAt: new Date(at).toISOString(), unread: false };
}

/**
 * 过期清理：只清 `fired/cancelled/done` 且超过保留期的；pending 永远不动。
 * @param {any[]} reminders
 * @param {number} now
 * @param {number} [keepMs]
 * @returns {{ kept: any[], dropped: string[] }}
 */
export function purgeExpiredReminders(reminders, now, keepMs = REMINDER_RETENTION_MS) {
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  const keep = Number.isFinite(keepMs) ? Number(keepMs) : REMINDER_RETENTION_MS;
  /** @type {any[]} */
  const kept = [];
  /** @type {string[]} */
  const dropped = [];
  for (const reminder of Array.isArray(reminders) ? reminders : []) {
    if (isPending(reminder) || reminder?.state === "pending") {
      kept.push(reminder);
      continue;
    }
    const stamp = Date.parse(String(reminder?.doneAt || reminder?.firedAt || reminder?.at || ""));
    if (!Number.isFinite(stamp) || at - stamp <= keep) {
      kept.push(reminder);
      continue;
    }
    dropped.push(String(reminder?.id ?? ""));
  }
  return { kept, dropped };
}

/**
 * 宿主 `schedule` 的 timing：离得近用 `after_seconds`（实测最稳、精度到秒），
 * 远的用 `at`（宿主要 `YYYY-MM-DD` + `HH:mm:ss` + IANA 时区）。
 * @param {string} atIso
 * @param {number} now
 * @param {string} timeZone
 * @returns {{ kind: 'after', after_seconds: number } | { kind: 'at', at: { date: string, time: string, time_zone: string } }}
 */
export function scheduleTimingFor(atIso, now, timeZone) {
  const dueAt = Date.parse(String(atIso));
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  const seconds = Number.isFinite(dueAt) ? Math.max(0, Math.ceil((dueAt - at) / 1000)) : 0;
  // 60s 内一律用 after：宿主的 at 只有秒级精度，且 after 已实测能真投递。
  if (seconds <= 60) return { kind: "after", after_seconds: Math.max(1, seconds) };
  const date = new Date(dueAt);
  // 宿主要求「本地墙钟时间 + IANA 时区」；用 Intl 按目标时区格式化，避免自己算偏移。
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  /** @type {Record<string, string>} */
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  const hour = values.hour === "24" ? "00" : values.hour;
  return {
    kind: "at",
    at: {
      date: `${values.year}-${values.month}-${values.day}`,
      time: `${hour}:${values.minute}:${values.second}`,
      time_zone: timeZone,
    },
  };
}

/**
 * 校验创建提醒的入参。
 * @param {any} input
 * @returns {{ ok: true, value: any } | { ok: false, reason: string }}
 */
export function validateReminderInput(input) {
  const at = normalizeReminderAt(input?.at);
  if (at === "") return { ok: false, reason: "reminder/invalid-at" };
  const text = String(input?.text ?? "").trim();
  if (text === "") return { ok: false, reason: "reminder/text-required" };
  if (text.length > MAX_REMINDER_TEXT) return { ok: false, reason: "reminder/text-too-long" };
  const mode = normalizeReminderMode(input?.mode);
  if (mode === "") return { ok: false, reason: "reminder/unknown-mode" };
  return { ok: true, value: { at, text, mode } };
}

/**
 * 生成提醒 id。
 * @param {number} [now]
 * @returns {string}
 */
export function newReminderId(now = Date.now()) {
  const stamp = Number(now).toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `rm_${stamp}_${rand}`;
}

/**
 * 给 UI 的「还剩多久」文案（英文单位走 locale，这里只给数字）。
 * @param {string} atIso @param {number} now
 * @returns {{ ms: number, minutes: number, text: string }}
 */
export function remainingTime(atIso, now) {
  const dueAt = Date.parse(String(atIso));
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  const ms = Number.isFinite(dueAt) ? dueAt - at : 0;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (ms <= 0) return { ms: 0, minutes: 0, text: "已到期" };
  if (minutes < 60) return { ms, minutes, text: `${minutes} 分钟后` };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { ms, minutes, text: `${hours} 小时后` };
  return { ms, minutes, text: `${Math.round(hours / 24)} 天后` };
}
