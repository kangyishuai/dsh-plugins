// @ts-check
// 会话日志 → 卡片 / 决策 / 揭示三张表（纯逻辑）。
//
// 背景（AUD-NS-06）：`service.js` 的 `scanSession()` 是预算闸、去重闸、act/dismiss 守卫的
// 数据来源，但它依赖宿主的 `pluginRecordOf`，于是这段「哪些记录算数、同回合多条记录取哪条」
// 的逻辑一直没有单测。把「事件数组 + 取记录函数」作为入参之后，这里可以像 events/gates
// 一样被 `node --test` 覆盖；service 只负责把宿主的 session 适配成事件数组。
//
// 口径（三张表都是**每回合第一条赢**，与投影的折叠规则保持一致，避免「服务端算的和界面看到的」不一致）：
// - card：`plugin:next-step/card`，结构不合法的记录直接忽略（旧版本/半条记录不能参与预算与去重）；
// - decision：`plugin:next-step/decision`，只认带整数 turn 的记录（phase/index 的形状由写侧校验，
//   这里与旧实现的宽容度一致）；
// - reveal：`plugin:next-step/reveal`，只认带整数 turn 的记录。

import { CARD_RECORD, DECISION_RECORD, isCardData, REVEAL_RECORD, readCard } from "./card-data.js";

/**
 * @typedef {{ type?: string, data?: any } | undefined} PluginRecord
 * @typedef {{
 *   cards: Map<number, any>,
 *   decisions: Map<number, any>,
 *   reveals: Map<number, true>,
 * }} SessionRecords
 */

/**
 * 把一条会话事件的宿主记录入口注入进来，折叠成三张表。
 * @param {any[]} events 会话事件数组（`session.snapshotEvents()` / `session.log`）
 * @param {(event: any) => PluginRecord} recordOf 宿主的 `pluginRecordOf`（抽成参数才可单测）
 * @returns {SessionRecords}
 */
export function foldSessionRecords(events, recordOf) {
  /** @type {Map<number, any>} */
  const cards = new Map();
  /** @type {Map<number, any>} */
  const decisions = new Map();
  /** @type {Map<number, true>} */
  const reveals = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    try {
      const record = recordOf(event);
      if (record === undefined || record === null) continue;
      if (record.type === CARD_RECORD && isCardData(record.data)) {
        if (!cards.has(record.data.turn)) cards.set(record.data.turn, readCard(record.data));
      } else if (record.type === DECISION_RECORD && Number.isSafeInteger(record.data?.turn)) {
        if (!decisions.has(record.data.turn)) decisions.set(record.data.turn, record.data);
      } else if (record.type === REVEAL_RECORD && Number.isSafeInteger(record.data?.turn)) {
        reveals.set(record.data.turn, true);
      }
    } catch (_error) {}
  }
  return { cards, decisions, reveals };
}
