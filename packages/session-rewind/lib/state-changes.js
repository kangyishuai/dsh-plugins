// @ts-check
// 「被撤回区间里改过哪些会话状态」的提示。
//
// 为什么需要：回溯只替换**模型可见的 surface**，日志与会话状态投影不动。所以区间里的
// `plan/mode`、`goal/change`、`todo/write` 这类状态事件在回溯后仍然生效——用户很容易误以为
// 「退回去就等于那些设置也退回去了」。这里只做事实提示，不做任何回滚。
//
// 未知事件类型一律忽略（AGENTS.md 约定 1：不写死内部实现，遇到不认识的保留）。

/** 已知的会话状态事件 → 文案键。 */
export const STATE_EVENT_LABELS = Object.freeze({
  "plan/mode": "state.planMode",
  "goal/change": "state.goal",
  "todo/write": "state.todo",
  "model/selection": "state.model",
  "permission/preset": "state.permission",
  "sandbox/mode": "state.sandbox",
  "agent-preset/selected": "state.agentPreset",
  "schedule/change": "state.schedule",
  "working-directory/change": "state.workingDirectory",
});

/**
 * @typedef {object} StateChange
 * @property {string} type 事件类型
 * @property {string} labelKey 文案键（`state.*`）
 * @property {number} count 次数
 * @property {number} firstSeq 第一次出现的 seq
 */

/**
 * 扫描 [fromSeq, toSeq] 区间里的会话状态事件，按出现顺序聚合。
 * @param {any[]} events
 * @param {number} fromSeq 含
 * @param {number} toSeq 含；传 `Number.MAX_SAFE_INTEGER` 表示到日志末尾
 * @returns {StateChange[]}
 */
export function collectStateChanges(events, fromSeq, toSeq) {
  const source = Array.isArray(events) ? events : [];
  const start = typeof fromSeq === "number" ? fromSeq : 0;
  const end = typeof toSeq === "number" ? toSeq : Number.MAX_SAFE_INTEGER;
  /** @type {Map<string, StateChange>} */
  const groups = new Map();
  for (const event of source) {
    if (!event || typeof event.seq !== "number") continue;
    if (event.seq < start || event.seq > end) continue;
    const type = event.type;
    if (typeof type !== "string") continue;
    const labelKey = /** @type {Record<string, string>} */ (STATE_EVENT_LABELS)[type];
    if (labelKey === undefined) continue;
    const existing = groups.get(type);
    if (existing) existing.count += 1;
    else groups.set(type, { type, labelKey, count: 1, firstSeq: event.seq });
  }
  return [...groups.values()].sort((left, right) => left.firstSeq - right.firstSeq);
}

/**
 * 给提示用的简短摘要（不含本地化文案，只出 key 与次数）。
 * @param {any[]} events
 * @param {number} fromSeq
 * @param {number} toSeq
 * @returns {Array<{type: string, labelKey: string, count: number}>}
 */
export function stateChangeSummary(events, fromSeq, toSeq) {
  return collectStateChanges(events, fromSeq, toSeq).map((item) => ({
    type: item.type,
    labelKey: item.labelKey,
    count: item.count,
  }));
}
