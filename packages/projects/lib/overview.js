// @ts-check
// Overview 状态机：纯函数、零 I/O。
// 设计依据见 notes/projects/m2-design.md §2：
//   优先级 waiting-user > failed > working > done > idle
//   全部从持久事件推导，不自己计时、不看模型自报。
// 已知坑（docs/runtime/0.2.2-rc.3.md §4）：turn/start 先于 user/message，
// 所以「这一轮是否失败」只能在 turn/end 收尾，不能在 turn/start 清理。

/** 线程在面板上的状态。M4 会再加 ready-for-review / landing。 */
export const THREAD_STATES = Object.freeze(["waiting-user", "failed", "working", "done", "idle"]);

/**
 * 面板排序权重：数字越小越靠上。
 * @type {Readonly<Record<string, number>>}
 */
export const STATE_RANK = Object.freeze({
  "waiting-user": 0,
  failed: 1,
  working: 2,
  done: 3,
  idle: 4,
});

/**
 * @typedef {object} ThreadView
 * @property {string} state
 * @property {number} turn 最近一次看到的 turn 号（0 表示还没跑过）
 * @property {boolean} awaitingUser 是否有待处理的交互（审批/提问/计划审阅）
 * @property {boolean} lastTurnFailed 最近一轮是否以错误结束
 * @property {number} lastActivityAt 最近一次活动时间（毫秒时间戳，0 表示未知）
 * @property {boolean} unread 是否有未读完成
 */

/** @returns {ThreadView} */
export function initialView() {
  return {
    state: "idle",
    turn: 0,
    awaitingUser: false,
    lastTurnFailed: false,
    lastActivityAt: 0,
    unread: false,
  };
}

/**
 * 由「当前已知的原始事实」推导状态。纯函数：同样的输入永远同样的输出。
 * 这样重启后只要把持久事件重放一遍就能重建，不依赖内存里的中间态。
 * @param {ThreadView} view
 * @returns {string}
 */
export function deriveState(view) {
  if (view.awaitingUser) return "waiting-user";
  if (view.lastTurnFailed) return "failed";
  if (view.state === "working") return "working";
  if (view.unread) return "done";
  return "idle";
}

/**
 * 归约一个事件。不认识的事件原样返回（前向兼容，硬性约定 1）。
 * @param {ThreadView} view
 * @param {{ type?: string, at?: number, data?: any }} event
 * @returns {ThreadView}
 */
export function reduce(view, event) {
  const type = String(event?.type ?? "");
  const at = Number.isFinite(event?.at) ? Number(event.at) : view.lastActivityAt;
  /** @type {ThreadView} */
  let next = { ...view, lastActivityAt: at };

  switch (type) {
    case "turn/start": {
      const turn = Number(event?.data?.turn);
      next = {
        ...next,
        turn: Number.isFinite(turn) ? turn : view.turn,
        state: "working",
        lastTurnFailed: false,
        unread: false,
      };
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
      const failed = isFailureEnd(event);
      next = {
        ...next,
        awaitingUser: false,
        lastTurnFailed: failed,
        state: failed ? "failed" : "done",
        unread: failed ? false : true,
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

  return { ...next, state: deriveState(next) };
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
