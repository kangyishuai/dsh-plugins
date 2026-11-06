// @ts-check
// 幽灵历史：把每次回溯遮蔽掉的消息还原成可读列表（只读，不改任何状态）。
//
// 数据来源是 append-only 的会话日志：每条 marker 的 [targetSeq, markerSeq) 区间里，
// 仍保留着被 replace 遮蔽的 append-origin 消息事件。service 负责把事件投影成
// {kind, text, messageId}；本模块只做分组、搜索与分页，保持纯函数、可单测。
import { cutsOf } from "./plan.js";

/** 单条消息文本在幽灵列表里的截断长度。 */
export const GHOST_TEXT_LIMIT = 500;

/** 默认每页回溯组数。 */
export const GHOST_CUT_LIMIT = 20;

/**
 * 把一条事件描述成幽灵列表项；不产生消息的事件返回 null。
 * @typedef {(event: any) => ({kind: "user" | "assistant" | "tool" | "other", text: string, messageId?: string} | null)} DescribeEvent
 */

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function truncate(text, limit = GHOST_TEXT_LIMIT) {
  if (typeof text !== "string") return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * 列出被撤回的消息，按回溯分组（最新回溯在前）。
 * @param {any} events 会话事件日志（按 seq 连续）
 * @param {DescribeEvent} describe 事件 → 消息摘要；返回 null 表示不是消息
 * @param {{q?: string, cursor?: number, limit?: number, modeByMarker?: Map<number, string>}} [options]
 * @returns {{cuts: any[], nextCursor: number | null}}
 */
export function collectGhost(events, describe, options = {}) {
  const source = Array.isArray(events) ? events : [];
  const cuts = cutsOf(source);
  const rawLimit = typeof options.limit === "number" ? options.limit : GHOST_CUT_LIMIT;
  const limit =
    Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : GHOST_CUT_LIMIT;
  const cursor =
    typeof options.cursor === "number" && Number.isSafeInteger(options.cursor) && options.cursor > 0
      ? options.cursor
      : null;
  const needle = typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
  const modeByMarker = options.modeByMarker instanceof Map ? options.modeByMarker : new Map();

  /** @type {any[]} */
  const groups = [];
  let nextCursor = null;
  for (let index = cuts.length - 1; index >= 0; index -= 1) {
    const cut = cuts[index];
    if (cursor !== null && cut.markerSeq >= cursor) continue;
    if (groups.length >= limit) {
      // 下一页从「本页最后一组的 marker」之前继续。
      nextCursor = groups[groups.length - 1].markerSeq;
      break;
    }
    const markerEvent = source[cut.markerSeq];
    /** @type {any[]} */
    const items = [];
    for (let seq = Math.max(0, cut.targetSeq); seq < cut.markerSeq; seq += 1) {
      const event = source[seq];
      if (event === undefined) continue;
      const described = describe(event);
      if (described === null) continue;
      const text = truncate(described.text);
      if (needle !== "" && !text.toLowerCase().includes(needle)) continue;
      items.push({
        seq,
        kind: described.kind,
        time: event.time,
        text,
        ...(typeof described.messageId === "string" ? { messageId: described.messageId } : {}),
      });
    }
    if (needle !== "" && items.length === 0) continue;
    groups.push({
      targetSeq: cut.targetSeq,
      markerSeq: cut.markerSeq,
      time: markerEvent && typeof markerEvent.time === "number" ? markerEvent.time : 0,
      mode: modeByMarker.get(cut.markerSeq) ?? null,
      removedCount: items.length,
      items,
    });
  }
  return { cuts: groups, nextCursor };
}
