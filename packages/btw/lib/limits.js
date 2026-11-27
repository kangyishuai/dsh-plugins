// @ts-check
// 所有上限集中一处，便于测试与调参。

export const LIMITS = {
  /** 单个父会话保留的旁问条数 */
  perSessionRecords: 50,
  /** 回放给模型的历史条数（对应 Claude 的 20 条） */
  replayRecords: 20,
  /** 问题最大字符数 */
  questionChars: 4000,
  /** 答案最大字符数（超出截断并标记 truncated） */
  answerChars: 8000,
  /** 流式缓冲的最大字符数（面板展示用；答案本身另有 answerChars 上限） */
  liveTextChars: 12_000,
  /** 旁问总超时（含排队与模型时间） */
  totalMs: 120_000,
  /** 允许的只读工具白名单上限（默认空 = 全拒） */
  allowedToolsMax: 8,
  /** 单条线程最多追问几轮（超过提示开新线程） */
  threadTurns: 10,
  /**
   * 转正草稿的最大字符数。实测 4000 字会把 composer 撑满整屏（用户原话
   * 「输入框把对话都挤没了」），收到 1200 字：够保留结论与要点。
   */
  promoteChars: 1200,
  /**
   * 旁问成本提示的阈值（父会话上下文 tokens）。
   *
   * 依据 2026-11-20 探针（notes/btw/fork-cost.md §5）：fork 子代理的 prompt 约为
   * 父会话 contextPressure 的 0.75–1.2 倍；空会话固定开销 ~114K。250K 是「再问一次
   * 可能真按几十万 tokens 计费」的保守线，只提示不阻断。
   */
  pressureWarnTokens: 250_000,
  /** bounded-context 的触发阈值（父会话 contextPressure）；比警告线更高，默认 400K。 */
  boundedTriggerTokens: 400_000,
  /** bounded digest 最多保留多少条消息（user/assistant 文本）。 */
  boundedMessages: 12,
  /** bounded digest 单条消息最多多少字符。 */
  boundedMessageChars: 700,
  /** bounded digest 总字符上限（决定 spawn prompt 的成本上限）。 */
  boundedTotalChars: 4_000,
  /**
   * bounded 模式从父会话尾部取多少条事件。
   * 只为凑够 `boundedMessages` 条消息服务（一条消息 = 一个事件，工具事件可能更多），
   * 取 80 足够 12 条消息，又避免把数万条事件的会话整棵物化（AUD-BTW-07）。
   */
  boundedTailEvents: 80,
  /**
   * `llm/stream` 用量表最多记多少个会话。
   * 旁问只用自己子会话的条目（结束时删除），这里兜住「宿主里其它会话流过」的增长（AUD-BTW-08）。
   */
  usageSessions: 64,
  /** 待处理追问队列最多保留多少个会话槽（正常同时只有 1 个）。 */
  followUpSlots: 64,
};

/**
 * 截断字符串并标注。
 * @param {unknown} value
 * @param {number} max
 * @returns {{ text: string, truncated: boolean }}
 */
export function clip(value, max) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
