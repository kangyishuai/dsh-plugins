// @ts-check
// 会话投影：把插件记录折叠成客户端可读的视图。
// 这是「状态属于会话数据」的落点——刷新、切会话、fork 后都能从日志重建。
import { pluginRecordOf } from "@deepseek-ai/dsh-session";

/** 卡片记录类型（一轮一张）。 */
export const CARD_RECORD = "plugin:next-step/card";
/** 决策记录类型（点了 / 关了）。 */
export const DECISION_RECORD = "plugin:next-step/decision";
/** 投影键，客户端用 useProjection(PROJECTION_KEY) 读。 */
export const PROJECTION_KEY = "nextStep";

/**
 * 一条 option 是否合法（label 是按钮文案，text 是点击后真正发出去的指令）。
 * @param {any} option
 * @returns {boolean}
 */
function isOption(option) {
  return (
    option !== null &&
    typeof option === "object" &&
    typeof option.stance === "string" &&
    option.stance.trim() !== "" &&
    typeof option.label === "string" &&
    option.label.trim() !== "" &&
    typeof option.text === "string" &&
    option.text.trim() !== ""
  );
}

/**
 * 卡片记录是否合法；不合法就整条丢弃（宁可不显示，也不显示半张卡）。
 * @param {any} data
 * @returns {boolean}
 */
export function isCardData(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Number.isSafeInteger(data.turn) &&
    typeof data.summary === "string" &&
    data.summary.trim() !== "" &&
    typeof data.question === "string" &&
    data.question.trim() !== "" &&
    Array.isArray(data.options) &&
    data.options.length === 2 &&
    data.options.every(isOption) &&
    data.options[0].stance !== data.options[1].stance &&
    (data.nextPrompt === undefined || typeof data.nextPrompt === "string")
  );
}

/**
 * 决策记录是否合法。
 * @param {any} data
 * @returns {boolean}
 */
export function isDecisionData(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Number.isSafeInteger(data.turn) &&
    (data.phase === "sent" || data.phase === "dismissed") &&
    (data.phase !== "sent" || Number.isSafeInteger(data.index))
  );
}

/**
 * 最小 schema 桩：`SessionProjectionRegistry` 在**读取**时会无条件调用
 * `stateSchema.parse(...)` 与 `wire.viewSchema.parse(...)`（缺字段会在会话加载时抛
 * `Cannot read properties of undefined (reading 'parse')`，整条历史都加载失败）。
 * 插件不能 import zod，也不需要对自有数据再做一次 schema 校验（写入侧已逐条校验），
 * 所以这里给一个恒等 `parse`。
 */
const PASSTHROUGH_SCHEMA = Object.freeze({ parse: (/** @type {any} */ value) => value });

/**
 * 投影定义。`cards` / `decisions` 以 `String(turn)` 为键。
 * @returns {any}
 */
export function nextStepProjection() {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: PASSTHROUGH_SCHEMA,
    init: () => ({ view: { cards: {}, decisions: {} } }),
    /**
     * @param {any} state
     * @param {any} event
     * @returns {any}
     */
    apply: (state, event) => {
      const record = pluginRecordOf(event);
      if (record === undefined) return state;
      if (record.type === CARD_RECORD) {
        if (!isCardData(record.data)) return state;
        const key = String(record.data.turn);
        if (state.view.cards[key] !== undefined) return state;
        return {
          ...state,
          view: {
            ...state.view,
            cards: { ...state.view.cards, [key]: record.data },
          },
        };
      }
      if (record.type === DECISION_RECORD) {
        if (!isDecisionData(record.data)) return state;
        const key = String(record.data.turn);
        if (state.view.decisions[key] !== undefined) return state;
        return {
          ...state,
          view: {
            ...state.view,
            decisions: { ...state.view.decisions, [key]: record.data },
          },
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
