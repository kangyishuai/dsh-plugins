// @ts-check
// 会话投影：把插件记录折叠成客户端可读的视图。
// 这是「状态属于会话数据」的落点——刷新、切会话、fork 后都能从日志重建。
//
// v0.4 起视图多一个 `reveals`（用户要求显示被档位抑制的候选），
// 校验与归一化搬到 ./card-data.js（纯函数，可单测）；本文件只负责折叠事件。
import { pluginRecordOf } from "@deepseek-ai/dsh-session";

import {
  CARD_RECORD,
  DECISION_RECORD,
  isCardData,
  isDecisionData,
  isRevealData,
  REVEAL_RECORD,
} from "./card-data.js";

export { CARD_RECORD, DECISION_RECORD, REVEAL_RECORD };

/** 投影键，客户端用 useProjection(PROJECTION_KEY) 读。 */
export const PROJECTION_KEY = "nextStep";

/**
 * 最小 schema 桩：`SessionProjectionRegistry` 在**读取**时会无条件调用
 * `stateSchema.parse(...)` 与 `wire.viewSchema.parse(...)`（缺字段会在会话加载时抛
 * `Cannot read properties of undefined (reading 'parse')`，整条历史都加载失败）。
 * 插件不能 import zod，也不需要对自有数据再做一次 schema 校验（写入侧已逐条校验），
 * 所以这里给一个恒等 `parse`。
 */
const PASSTHROUGH_SCHEMA = Object.freeze({ parse: (/** @type {any} */ value) => value });

/**
 * 投影定义。`cards` / `decisions` / `reveals` 都以 `String(turn)` 为键。
 * @returns {any}
 */
export function nextStepProjection() {
  return {
    key: PROJECTION_KEY,
    // v2：视图新增 reveals（客户端对缺失的 reveals 做了容错，缓存失效也不会白屏）
    stateVersion: 2,
    stateSchema: PASSTHROUGH_SCHEMA,
    init: () => ({ view: { cards: {}, decisions: {}, reveals: {} } }),
    /**
     * @param {any} state
     * @param {any} event
     * @returns {any}
     */
    apply: (state, event) => {
      const record = pluginRecordOf(event);
      if (record === undefined) return state;
      const view = state.view;
      if (record.type === CARD_RECORD) {
        if (!isCardData(record.data)) return state;
        const key = String(record.data.turn);
        if (view.cards[key] !== undefined) return state;
        return {
          ...state,
          view: { ...view, cards: { ...view.cards, [key]: record.data } },
        };
      }
      if (record.type === DECISION_RECORD) {
        if (!isDecisionData(record.data)) return state;
        const key = String(record.data.turn);
        if (view.decisions[key] !== undefined) return state;
        return {
          ...state,
          view: { ...view, decisions: { ...view.decisions, [key]: record.data } },
        };
      }
      if (record.type === REVEAL_RECORD) {
        if (!isRevealData(record.data)) return state;
        const key = String(record.data.turn);
        if (view.reveals[key] === true) return state;
        return {
          ...state,
          view: { ...view, reveals: { ...view.reveals, [key]: true } },
        };
      }
      return state;
    },
    // summary: false —— 投影不进会话摘要（它只是 UI 状态，不是模型可见内容）。
    // viewSchema 同样是必需字段（注册表读的时候无条件 parse）；view 必须同步返回。
    wire: {
      summary: false,
      view: (/** @type {any} */ state) => state.view,
      viewSchema: PASSTHROUGH_SCHEMA,
    },
  };
}
