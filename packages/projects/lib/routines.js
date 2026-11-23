// @ts-check
// F36 Routines：把「六档频率」翻译成宿主 `schedule` 的 timing。
// 纯函数、零 I/O：频率 → timing 的映射是本功能唯一容易写错的地方，
// 单独拆出来便于单测（宿主侧的时间格式必须是 `HH:mm:ss`，见 docs/runtime/0.2.2-rc.5.md §14）。
//
// 关键事实（探针实测，写进代码别再踩）：
// - `HH:mm:ss` 是硬要求：`09:30` / `09:00` 会被 `ScheduleInputError` 拒；
// - cron 的时区由宿主换算，我们只传 IANA 名字；
// - `target.kind:'new'` 的投递间隔下限是 60s（`deliveryLimits().newSessionIntervalSeconds`），
//   所以「每小时/每天」这类档位不会触发下限，「每分钟」不在六档里（本来也不该有）。

/** 六档频率（顺序即 UI 顺序）。`manual` = 不建 schedule，只有 Run now。 */
export const ROUTINE_FREQUENCIES = Object.freeze([
  "manual",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
]);

/** 频率的中文标签（UI 与审计共用；英文走 locale）。 */
export const FREQUENCY_LABELS = Object.freeze({
  manual: "手动",
  hourly: "每小时",
  daily: "每天",
  weekdays: "工作日（周一至周五）",
  weekly: "每周",
  monthly: "每月",
});

/** 一次投递 = 一次模型调用的成本提示（F36 强制在 UI 上写明）。 */
export const ROUTINE_COST_HINT =
  "每次到点投递都会跑一次模型（= 一次模型调用，会花 token）；新建会话的两次投递至少间隔 60 秒。";

/** 手动档的额外说明（不自动跑，也就不会自己花钱）。 */
export const MANUAL_COST_HINT = "手动档不会自动投递，只有点「Run now」才会跑一次模型。";

/**
 * 频率是否会自动投递（manual = 不建 schedule）。
 * @param {unknown} frequency
 * @returns {boolean}
 */
export function frequencyRunsAutomatically(frequency) {
  return normalizeFrequency(frequency) !== "manual";
}

/** @param {unknown} value @returns {string} */
export function normalizeFrequency(value) {
  const text = String(value ?? "").trim();
  return ROUTINE_FREQUENCIES.includes(text) ? text : "";
}

/**
 * 时间收敛成宿主要求的 `HH:mm:ss`。
 * 接受 `9:5` / `09:05` / `09:05:00` / `09:05:07.123`；非法返回空串（由调用方拒绝，不猜）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTime(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  const match = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d{1,3})?$/u);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "";
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return "";
  if (!Number.isInteger(second) || second < 0 || second > 59) return "";
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** 默认时间：早上 9 点（Claude Routines 的默认观感）。 */
export const DEFAULT_ROUTINE_TIME = "09:00:00";

/**
 * 把时间拆成 cron 需要的分钟/小时。
 * @param {string} time `HH:mm:ss`
 * @returns {{ minute: number, hour: number, second: number }}
 */
export function timeParts(time) {
  const normalized = normalizeTime(time);
  if (normalized === "") return { minute: 0, hour: 0, second: 0 };
  const [hour, minute, second] = normalized.split(":").map((part) => Number(part));
  return { minute, hour, second };
}

/**
 * 构造宿主 timing。
 *
 * | 频率 | 宿主 timing |
 * |---|---|
 * | manual | `null`（不建 schedule） |
 * | hourly | cron `M * * * *`（每小时的 M 分） |
 * | daily | `{kind:'daily', daily:{time, time_zone}}` |
 * | weekdays | cron `M H * * 1-5` |
 * | weekly | cron `M H * * D`（D：周日=0，周日也可以写 7 → 收敛成 0） |
 * | monthly | cron `M H D * *`（D 限 1–28，避开「2 月没有 30 号」这类空档） |
 *
 * @param {unknown} frequency
 * @param {{ time?: unknown, weekday?: unknown, dayOfMonth?: unknown, timeZone?: unknown }} [options]
 * @returns {{ ok: true, timing: any, expression: string } | { ok: false, reason: string }}
 */
export function buildRoutineTiming(frequency, options = {}) {
  const kind = normalizeFrequency(frequency);
  if (kind === "") return { ok: false, reason: "routine/unknown-frequency" };
  const timeZone =
    typeof options.timeZone === "string" && options.timeZone.trim() !== ""
      ? options.timeZone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const time = normalizeTime(options.time) || DEFAULT_ROUTINE_TIME;
  const { minute, hour } = timeParts(time);
  if (kind === "manual") return { ok: true, timing: null, expression: "" };
  if (kind === "hourly") {
    const expression = `${minute} * * * *`;
    return {
      ok: true,
      timing: { kind: "cron", cron: { expression, time_zone: timeZone } },
      expression,
    };
  }
  if (kind === "daily") {
    return {
      ok: true,
      timing: { kind: "daily", daily: { time, time_zone: timeZone } },
      expression: "",
    };
  }
  if (kind === "weekdays") {
    const expression = `${minute} ${hour} * * 1-5`;
    return {
      ok: true,
      timing: { kind: "cron", cron: { expression, time_zone: timeZone } },
      expression,
    };
  }
  if (kind === "weekly") {
    const raw = Number(options.weekday);
    const weekday = Number.isInteger(raw) && raw >= 0 && raw <= 7 ? raw % 7 : 1;
    const expression = `${minute} ${hour} * * ${weekday}`;
    return {
      ok: true,
      timing: { kind: "cron", cron: { expression, time_zone: timeZone } },
      expression,
    };
  }
  // monthly：1–28（29–31 会在部分月份静默跳过一整月，宁可在 UI 上收窄）
  const rawDay = Number(options.dayOfMonth);
  const dayOfMonth = Number.isInteger(rawDay) && rawDay >= 1 && rawDay <= 28 ? rawDay : 1;
  const expression = `${minute} ${hour} ${dayOfMonth} * *`;
  return {
    ok: true,
    timing: { kind: "cron", cron: { expression, time_zone: timeZone } },
    expression,
  };
}

/**
 * 人类可读的频率描述（列表行左侧那行）。
 * @param {any} routine
 * @returns {string}
 */
export function describeRoutineFrequency(routine) {
  const kind = normalizeFrequency(routine?.frequency);
  if (kind === "") return "频率未知";
  const time = normalizeTime(routine?.time) || DEFAULT_ROUTINE_TIME;
  if (kind === "manual") return "手动：只有点 Run now 才跑";
  if (kind === "hourly") return `每小时的第 ${timeParts(time).minute} 分`;
  if (kind === "daily") return `每天 ${time.slice(0, 5)}`;
  if (kind === "weekdays") return `工作日 ${time.slice(0, 5)}`;
  if (kind === "weekly") {
    const weekday = Number(routine?.weekday);
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const index = Number.isInteger(weekday) && weekday >= 0 && weekday <= 7 ? weekday % 7 : 1;
    return `每${names[index]} ${time.slice(0, 5)}`;
  }
  const day = Number(routine?.dayOfMonth);
  return `每月 ${Number.isInteger(day) && day >= 1 && day <= 28 ? day : 1} 号 ${time.slice(0, 5)}`;
}

/** Routine 记录的最大条数（防误点刷爆本地 store）。 */
export const MAX_ROUTINES = 32;
/** 每个 routine 在本地保留的历史条数（宿主那边另有 30 天/200 条保留）。 */
export const ROUTINE_HISTORY_CAP = 20;

/**
 * 收敛一条 routine（读盘与写入口共用）。
 * @param {any} raw
 * @returns {any|null}
 */
export function normalizeRoutine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "") return null;
  const frequency = normalizeFrequency(raw.frequency);
  if (frequency === "") return null;
  const weekdayRaw = Number(raw.weekday);
  const dayRaw = Number(raw.dayOfMonth);
  const history = Array.isArray(raw.history)
    ? raw.history.filter((/** @type {any} */ item) => item && typeof item === "object")
    : [];
  return {
    // 不认识的字段保留（前向兼容，同 store.normalize 的口径）：未来版本加的字段
    // 不会被旧版本读一次就抹掉。
    ...raw,
    id,
    name: String(raw.name ?? "").slice(0, 120),
    instructions: String(raw.instructions ?? "").slice(0, 8_000),
    frequency,
    time: normalizeTime(raw.time) || DEFAULT_ROUTINE_TIME,
    weekday:
      Number.isInteger(weekdayRaw) && weekdayRaw >= 0 && weekdayRaw <= 7 ? weekdayRaw % 7 : 1,
    dayOfMonth: Number.isInteger(dayRaw) && dayRaw >= 1 && dayRaw <= 28 ? dayRaw : 1,
    timeZone: typeof raw.timeZone === "string" ? raw.timeZone : "",
    cron: typeof raw.cron === "string" ? raw.cron : "",
    enabled: raw.enabled !== false,
    spaceId: typeof raw.spaceId === "string" ? raw.spaceId : "",
    scheduleId: typeof raw.scheduleId === "string" ? raw.scheduleId : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : "",
    history: history.slice(-ROUTINE_HISTORY_CAP),
  };
}

/**
 * 追加一条历史（同一条 routine 的「最近投递与状态」）。
 * @param {any} routine
 * @param {{ at?: string, status?: string, message?: string, source?: string }} entry
 * @returns {any[]}
 */
export function appendRoutineHistory(routine, entry) {
  const history = Array.isArray(routine?.history) ? routine.history : [];
  const record = {
    at: typeof entry?.at === "string" ? entry.at : new Date().toISOString(),
    status: typeof entry?.status === "string" ? entry.status : "unknown",
    message: String(entry?.message ?? "").slice(0, 300),
    source: typeof entry?.source === "string" ? entry.source : "",
  };
  return [...history, record].slice(-ROUTINE_HISTORY_CAP);
}

/**
 * 宿主 `schedule.history()` 的记录 → 我们的历史条目（字段名不同，别硬套）。
 * @param {any} record
 * @returns {{ at: string, status: string, message: string, source: string }}
 */
export function historyFromDelivery(record) {
  const at =
    typeof record?.deliveredAt === "string"
      ? record.deliveredAt
      : typeof record?.scheduledAt === "string"
        ? record.scheduledAt
        : "";
  const scheduled = typeof record?.scheduledAt === "string" ? record.scheduledAt : "";
  const messageId = String(record?.messageId ?? "");
  return {
    at,
    status: at === "" ? "scheduled" : "delivered",
    message: [
      scheduled ? `scheduledAt=${scheduled}` : "",
      messageId ? `message=${messageId.slice(0, 16)}` : "",
    ]
      .filter((part) => part !== "")
      .join(" · "),
    source: String(record?.targetSessionId ?? ""),
  };
}

/**
 * 宿主 `schedule` 的条目 → 列表行右侧的状态摘要。
 * @param {any} entry `ScheduleCatalogEntry` 或 undefined
 * @param {boolean} enabled 本地记录的开关
 * @returns {{ status: string, label: string, nextAt: string }}
 */
export function describeScheduleStatus(entry, enabled) {
  if (!entry) {
    return enabled
      ? { status: "missing", label: "宿主里没有这条任务（可能在宿主侧被删了）", nextAt: "" }
      : { status: "off", label: "已停用", nextAt: "" };
  }
  const status = String(entry.status ?? "");
  const nextAt = typeof entry.scheduledAt === "string" ? entry.scheduledAt : "";
  if (status === "paused") return { status: "paused", label: "已暂停（宿主侧）", nextAt };
  if (status === "ended") return { status: "ended", label: "已结束（宿主侧）", nextAt };
  if (!enabled) return { status: "off", label: "已停用", nextAt };
  const last = entry.lastDelivery?.deliveredAt;
  return {
    status: "active",
    label: typeof last === "string" ? `已投递过（最近 ${last}）` : "等待首次投递",
    nextAt,
  };
}

/**
 * 校验创建 routine 的入参（RPC 边界；错误给可读原因，不静默修补）。
 * @param {any} input
 * @returns {{ ok: true, value: any } | { ok: false, reason: string }}
 */
export function validateRoutineInput(input) {
  const name = String(input?.name ?? "").trim();
  if (name === "") return { ok: false, reason: "routine/name-required" };
  if (name.length > 120) return { ok: false, reason: "routine/name-too-long" };
  const instructions = String(input?.instructions ?? "").trim();
  if (instructions === "") return { ok: false, reason: "routine/instructions-required" };
  if (instructions.length > 8_000) return { ok: false, reason: "routine/instructions-too-long" };
  const frequency = normalizeFrequency(input?.frequency);
  if (frequency === "") return { ok: false, reason: "routine/unknown-frequency" };
  if (frequency === "manual") {
    return { ok: true, value: { name, instructions, frequency } };
  }
  const time = normalizeTime(input?.time) || DEFAULT_ROUTINE_TIME;
  if (normalizeTime(time) === "") return { ok: false, reason: "routine/invalid-time" };
  return {
    ok: true,
    value: {
      name,
      instructions,
      frequency,
      time,
      weekday: input?.weekday,
      dayOfMonth: input?.dayOfMonth,
      timeZone: input?.timeZone,
    },
  };
}

/**
 * 生成 routine id（`rt_` 前缀便于在审计/日志里认出来）。
 * @param {number} [now]
 * @returns {string}
 */
export function newRoutineId(now = Date.now()) {
  const stamp = Number(now).toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `rt_${stamp}_${rand}`;
}
