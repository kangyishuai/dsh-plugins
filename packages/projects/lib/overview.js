// @ts-check
// Overview 状态机：纯函数、零 I/O。
// 六态（对齐 Claude Projects，见 notes/projects/claude-borrow/spec-plan.md §4）：
//   waiting-user > failed > working > resolved > idle；archived 由宿主/插件的归档记录派生。
// 数据源（只用品格验证过的宿主事实，见 notes/projects/claude-borrow/scope-confirmed.md §12）：
//   等你  ← sessionController.state().pendingInput（权威；userQuestions 投影不跟）
//   在跑  ← state().running
//   失败  ← 会话日志 turn/end.reason.kind='error' / assistant/attempt finish reason
//   步进  ← todo/write 的整表快照（没有 todo 就是 null，UI 显示「—」，不编 0/0）
//   副标题 ← 最近一条 tool/call 的可读名（observability 同源），没有就留空
// 已知坑（docs/runtime/0.2.2-rc.3.md §4）：turn/start 先于 user/message，所以
// 「这一轮是否失败」只能在 turn/end 收尾，不能在 turn/start 清理。

import { toolSummaryOf } from "./observability.js";

/** 面板上的六态（排序与分组都用它）。 */
export const THREAD_STATES = Object.freeze([
  "waiting-user",
  "failed",
  "working",
  "resolved",
  "idle",
  "archived",
]);

/**
 * 面板排序权重：数字越小越靠上。
 * @type {Readonly<Record<string, number>>}
 */
export const STATE_RANK = Object.freeze({
  "waiting-user": 0,
  failed: 1,
  working: 2,
  resolved: 3,
  idle: 4,
  archived: 5,
});

/**
 * 分组（F25/U11）：Claude 的四组 + 已归档（有归档项时才渲染）。
 * 「等你」组把 failed 一起收进来——失败也需要你处理，单独成组会让两个都像次要项。
 */
export const STATE_GROUPS = Object.freeze([
  { id: "waiting-user", states: Object.freeze(["waiting-user", "failed"]) },
  { id: "working", states: Object.freeze(["working"]) },
  { id: "resolved", states: Object.freeze(["resolved"]) },
  { id: "idle", states: Object.freeze(["idle"]) },
  { id: "archived", states: Object.freeze(["archived"]) },
]);

/** 药丸条的五类计数（F26/U13）；archived 只在分组里，不占药丸位。 */
export const STATE_PILLS = Object.freeze(["waiting-user", "failed", "working", "resolved", "idle"]);

/**
 * @typedef {object} TodoSnapshot
 * @property {number} total 整表条数
 * @property {number} done 已完成条数（status==='completed'）
 */

/**
 * @typedef {object} ThreadView
 * @property {string} state 归约出来的原始状态（working/done/failed/idle）
 * @property {number} turn 最近一次看到的 turn 号（0 表示还没跑过）
 * @property {boolean} awaitingUser 是否有待处理的交互（审批/提问/计划审阅）
 * @property {boolean} lastTurnFailed 最近一轮是否以错误结束
 * @property {boolean} lastAttemptFailed 本轮里是否出现过带 error 的 assistant/attempt
 * @property {number} firstActivityAt 本视图第一次看到活动的时间（剩余时间估计的分母）
 * @property {number} lastActivityAt 最近一次活动时间（毫秒时间戳，0 表示未知）
 * @property {boolean} unread 是否有未读完成
 * @property {boolean} resolved 用户手动标记「已解决」（插件域，宿主无原语）
 * @property {boolean} archived 是否已归档（由线程记录派生）
 * @property {TodoSnapshot} todos 最近一次 todo/write 的整表快照（没有就是 0/0）
 * @property {Array<{content: string, status: string}>} todoItems 同一快照的逐项明细（F17 的 ✓/◌）
 * @property {string} subtitle 最近一条 tool/call 的可读摘要（没有就留空，不编）
 */

/** @returns {ThreadView} */
export function initialView() {
  return {
    state: "idle",
    turn: 0,
    awaitingUser: false,
    lastTurnFailed: false,
    lastAttemptFailed: false,
    firstActivityAt: 0,
    lastActivityAt: 0,
    unread: false,
    resolved: false,
    archived: false,
    todos: { total: 0, done: 0 },
    todoItems: [],
    subtitle: "",
  };
}

/**
 * todo/write 的逐项明细（F17）。只保留文案与状态，其余字段丢弃。
 * @param {any} data
 * @returns {Array<{content: string, status: string}>}
 */
export function todoItems(data) {
  const list = Array.isArray(data?.todos) ? data.todos : [];
  return list.slice(0, 200).map((/** @type {any} */ item) => ({
    content: String(item?.content ?? "").slice(0, 200),
    status: String(item?.status ?? ""),
  }));
}

/**
 * 由「当前已知的原始事实」推导六态。纯函数：同样的输入永远同样的输出。
 * 顺序与 spec-plan §4 一致：waiting-user > failed > working > resolved > idle；archived 最外层。
 * 注意：内部归约出来的 `done` 只是「这一轮正常跑完」，对外一律当 idle（F16 的 done→idle 映射）。
 * @param {ThreadView} view
 * @returns {string}
 */
export function deriveState(view) {
  if (view.archived === true) return "archived";
  if (view.awaitingUser) return "waiting-user";
  if (view.lastTurnFailed) return "failed";
  if (view.state === "working") return "working";
  if (view.resolved === true) return "resolved";
  return "idle";
}

/**
 * 把持久化的线程记录（插件域字段）叠进视图，再推导六态。
 * 重启后内存视图是空的，但 resolvedAt / state 还在 projects.json 里——必须能读回来。
 * @param {ThreadView|undefined} view
 * @param {any} record 线程记录（可空）
 * @returns {ThreadView}
 */
export function mergeRecord(view, record) {
  const base = view ?? initialView();
  const recordState = typeof record?.state === "string" ? record.state : "";
  const resolvedAt = typeof record?.resolvedAt === "string" && record.resolvedAt !== "";
  // B1 的 P0-2 残留（B2 复审 P2）：`waiting-user` 以前**没有**映射——盘上写进去的
  // "waiting-user" 读回来 `awaitingUser` 仍是 false，`deriveState` 于是把它当 idle。
  // 历史拼写 `waiting`（B1 之前）同样按「等你」读，不伪造别的状态。
  const awaitingUser = recordState === "waiting-user" || recordState === "waiting";
  // 六态持久化（B1 审查 P0-2）：冷启动时内存视图是空的，`failed` / `working` 只有记录里那份事实。
  // 以前这里只映射 resolved/archived，于是重启后 failed/working 一律落回 idle——写进去了却读不出来。
  return {
    ...base,
    // `working` 是**持久化事实**：宿主 `state().running` 在 settleState 里优先级更高，
    // 所以真在跑/真停了都以宿主为准，这里只是让「重启后仍读得到 working」成立。
    state: recordState === "working" ? "working" : base.state,
    lastTurnFailed: recordState === "failed" ? true : base.lastTurnFailed,
    awaitingUser: awaitingUser ? true : base.awaitingUser,
    resolved: resolvedAt || recordState === "resolved",
    archived: recordState === "archived",
  };
}

/**
 * @param {ThreadView|undefined} view @param {any} record
 * @returns {string}
 */
export function deriveThreadState(view, record) {
  return deriveState(mergeRecord(view, record));
}

/**
 * 结合宿主实时事实（running / pendingInput）算出面板态的最终值。
 * 优先级：archived（用户显式归档）> waiting-user（宿主权威）> working（宿主权威）> 事件推导。
 * @param {{ view?: ThreadView, record?: any, running?: boolean, pendingInput?: unknown[] }} input
 * @returns {string}
 */
export function settleState(input) {
  const record = input?.record;
  if (record?.state === "archived") return "archived";
  const pending = Array.isArray(input?.pendingInput) ? input.pendingInput : [];
  if (pending.length > 0) return "waiting-user";
  if (input?.running === true) return "working";
  return deriveThreadState(input?.view, record);
}

/**
 * 从 todo/write 的事件数据里取整表快照。形状：`{todos:[{content,status}]}`。
 * 不认识的形状返回 null（调用方据此保持旧快照，不要把坏数据当 0/0）。
 * @param {any} data
 * @returns {TodoSnapshot|null}
 */
export function todoSummary(data) {
  const list = Array.isArray(data?.todos) ? data.todos : null;
  if (list === null) return null;
  let done = 0;
  for (const item of list) {
    if (String(item?.status ?? "") === "completed") done += 1;
  }
  return { total: list.length, done };
}

/**
 * assistant 消息纯文本（副标题兜底用）。
 * @param {any} message
 * @returns {string}
 */
function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * 取一句话当副标题：按句号/换行切第一句，去掉 markdown 记号，最长 80 字符。
 * 没有文本就返回空串（UI 留空，不编）。
 * @param {string} value
 * @returns {string}
 */
export function firstSentence(value) {
  const cleaned = String(value ?? "")
    .replace(/[`*_~>#]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return "";
  const cut = cleaned.split(/(?<=[。！？.!?])\s*/u)[0] ?? cleaned;
  return cut
    .replace(/[。！？.!?]+$/u, "")
    .trim()
    .slice(0, 80);
}

/**
 * 归约一个事件。不认识的事件原样返回（前向兼容，硬性约定 1）。
 * @param {ThreadView} view
 * @param {{ type?: string, at?: number, time?: number, data?: any }} event
 * @returns {ThreadView}
 */
export function reduce(view, event) {
  const type = String(event?.type ?? "");
  const rawAt = Number.isFinite(event?.at) ? Number(event?.at) : Number(event?.time ?? 0);
  const at = rawAt > 0 ? rawAt : view.lastActivityAt;
  /** @type {ThreadView} */
  let next = {
    ...view,
    lastActivityAt: at,
    // 「第一次看到活动」的时间：首条事件取 at，之后取**更早**的那个（B1 审查 P1-4：
    // 原来写成 Math.max，恒等于 lastActivityAt，`estimateRemainingMs` 的 (last-first) 永远 0，
    // 于是 `~Nm` 永远不显示）。
    firstActivityAt: view.firstActivityAt > 0 ? Math.min(view.firstActivityAt, at) : at,
  };

  switch (type) {
    case "turn/start": {
      const turn = Number(event?.data?.turn);
      next = {
        ...next,
        turn: Number.isFinite(turn) ? turn : view.turn,
        state: "working",
        lastTurnFailed: false,
        lastAttemptFailed: false,
        unread: false,
        // 新一轮开始 = 用户没把它当「已解决」了；归档状态也随活动解除
        resolved: false,
        archived: false,
      };
      break;
    }
    case "assistant/attempt": {
      // 失败信息在这里，不在 turn/end：rc.3 实测 turn/end 只带 { turn }。
      if (hasErrorFinish(event?.data)) next = { ...next, lastAttemptFailed: true };
      break;
    }
    case "assistant/message": {
      // 副标题：tool/call 优先；还没有工具调用时用 assistant 第一句兜底
      if (next.subtitle === "") {
        const sentence = firstSentence(assistantText(event?.data?.message));
        if (sentence !== "") next = { ...next, subtitle: sentence };
      }
      break;
    }
    case "tool/call": {
      const summary = toolSummaryOf(event?.data);
      if (summary !== "") next = { ...next, subtitle: summary };
      break;
    }
    case "todo/write": {
      const snapshot = todoSummary(event?.data);
      if (snapshot !== null) next = { ...next, todos: snapshot, todoItems: todoItems(event?.data) };
      break;
    }
    case "interaction/pending": {
      // 审批 / 提问 / 计划审阅：宿主投影里出现待处理交互
      next = { ...next, awaitingUser: true };
      break;
    }
    case "interaction/cleared": {
      next = { ...next, awaitingUser: false };
      break;
    }
    case "turn/end": {
      const failed = isFailureEnd(event) || view.lastAttemptFailed === true;
      next = {
        ...next,
        awaitingUser: false,
        lastTurnFailed: failed,
        state: failed ? "failed" : "done",
        lastAttemptFailed: false,
        unread: !failed,
      };
      break;
    }
    case "session/opened": {
      // 用户正在看这个会话：清未读，但失败态保留（失败要人处理）
      next = { ...next, unread: false, state: view.lastTurnFailed ? "failed" : "idle" };
      break;
    }
    case "session/activity": {
      if (view.state !== "working") next = { ...next, state: "working" };
      break;
    }
    default:
      return view;
  }

  // 注意：这里保留**原始事实**（working/done/failed），不做六态收敛。
  // 收敛发生在 deriveState()（渲染/持久化前）；否则「一轮正常跑完」会被过早抹成 idle，
  // 而未读、resolve 这些判据都还要用它。
  return next;
}

/**
 * assistant/attempt 的 stream 里是否出现 error 结束。
 * 形状（rc.3 实测）：{ stream: [{ chunk: { type: "finish", reason: { kind: "error", failure } } }] }
 * @param {any} data
 * @returns {boolean}
 */
export function hasErrorFinish(data) {
  const stream = Array.isArray(data?.stream) ? data.stream : [];
  for (const entry of stream) {
    const chunk = entry?.chunk ?? entry;
    if (String(chunk?.type ?? "") !== "finish") continue;
    const reason = chunk?.reason;
    if (reason && typeof reason === "object" && String(reason.kind ?? "") === "error") return true;
    if (typeof reason === "string" && /error|fail/iu.test(reason)) return true;
  }
  return false;
}

/**
 * 一轮是否以错误结束。
 * 依据 rc.3 实测：失败信息在 assistant/attempt 的 finish reason 里，
 * 但 turn/end 也可能带 reason —— 两处都认，任一为 error 即失败。
 * @param {{ data?: any }} event
 * @returns {boolean}
 */
export function isFailureEnd(event) {
  const data = event?.data ?? {};
  const reason = data.reason ?? data.finishReason ?? data.outcome;
  if (reason && typeof reason === "object" && String(reason.kind ?? "") === "error") return true;
  if (typeof reason === "string" && /error|fail|cancel|abort/iu.test(reason)) return true;
  if (data.error) return true;
  return false;
}

/**
 * 重放一串持久事件，得到当前视图（重启重建用）。
 * @param {readonly { type?: string, at?: number, data?: any }[]} events
 * @returns {ThreadView}
 */
export function replay(events) {
  /** @type {ThreadView} */
  let view = initialView();
  for (const event of events ?? []) view = reduce(view, event);
  return view;
}

/**
 * 行级剩余时间估计（F26 的 `~Nm`）。
 * 口径：本线程已观测到的「每步耗时」× 剩余步数；只有 1 个样本时不给估计。
 * 它是**估计**，UI 必须写 `~`，没有数据就整段不显示（不编）。
 * @param {{ todos?: TodoSnapshot|null, firstActivityAt?: number, lastActivityAt?: number, steps?: number }} input
 * @returns {number|null} 毫秒；null 表示没有可靠估计
 */
export function estimateRemainingMs(input) {
  const todos = input?.todos ?? null;
  if (!todos || todos.total <= 0 || todos.done >= todos.total) return null;
  const steps = Number(input?.steps ?? 0);
  const first = Number(input?.firstActivityAt ?? 0);
  const last = Number(input?.lastActivityAt ?? 0);
  if (!(steps > 1) || !(first > 0) || !(last > first)) return null;
  const average = (last - first) / (steps - 1);
  if (!(average > 0)) return null;
  const remaining = (todos.total - todos.done) * average;
  // 圈定 30s ~ 60min：再短/再长都不像「~Nm」的可用信息，不如不给
  const floor = 30_000;
  const cap = 60 * 60_000;
  if (remaining < floor) return floor;
  if (remaining > cap) return cap;
  return remaining;
}

/**
 * 面板排序：先按状态权重，再按最近活动时间降序，最后按 id 稳定排序。
 * @param {{ sessionId: string, view: ThreadView }[]} rows
 * @returns {{ sessionId: string, view: ThreadView }[]}
 */
export function sortRows(rows) {
  return [...(rows ?? [])].sort((left, right) => {
    const rank = (STATE_RANK[left.view.state] ?? 99) - (STATE_RANK[right.view.state] ?? 99);
    if (rank !== 0) return rank;
    const byTime = (right.view.lastActivityAt ?? 0) - (left.view.lastActivityAt ?? 0);
    if (byTime !== 0) return byTime;
    return String(left.sessionId).localeCompare(String(right.sessionId));
  });
}

/**
 * 「需要我」的线程（waiting-user 或 failed）。
 * @param {{ sessionId: string, view: ThreadView }[]} rows
 * @returns {{ sessionId: string, view: ThreadView }[]}
 */
export function needsAttention(rows) {
  return sortRows(rows).filter(
    (row) => row.view.state === "waiting-user" || row.view.state === "failed",
  );
}

/**
 * 药丸条计数（F26）：五类各一个数；archived 不算（它在分组里）。
 * @param {{ view: ThreadView }[]} rows
 * @returns {Record<string, number>}
 */
export function pillCounts(rows) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const state of STATE_PILLS) counts[state] = 0;
  for (const row of rows ?? []) {
    const state = String(row?.view?.state ?? "");
    if (Object.hasOwn(counts, state)) counts[state] += 1;
  }
  return counts;
}

/**
 * 按六态分组（F25/U11）。分组顺序固定；空组仍然返回（UI 自己决定是否渲染）。
 * @param {{ view: ThreadView }[]} rows
 * @returns {{ id: string, states: readonly string[], count: number, rows: any[] }[]}
 */
export function groupRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return STATE_GROUPS.map((group) => {
    const members = list.filter((row) => group.states.includes(String(row?.view?.state ?? "")));
    return { id: group.id, states: group.states, count: members.length, rows: members };
  });
}

/**
 * 药丸/分组过滤：`filter` 为空表示全部；否则只留该状态（分组仍是原分组）。
 * @param {{ view: ThreadView }[]} rows @param {string} filter
 * @returns {{ view: ThreadView }[]}
 */
export function filterRows(rows, filter) {
  const list = Array.isArray(rows) ? rows : [];
  if (filter === "") return list;
  return list.filter((row) => String(row?.view?.state ?? "") === filter);
}
