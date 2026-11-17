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
