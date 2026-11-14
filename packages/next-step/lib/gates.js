// @ts-check
// 便宜闸：在做那次模型调用**之前**就能判断出「这一轮不该出卡」的条件。
// 每一条都对应一种「此刻打扰是负价值」的场景，参考 Claude 的建议生成门控：
// 出错的时候不要打扰用户、回答太短没有上下文可依、用户已经在排队等回复。
//
// 抽成纯函数是为了能单测：service.js 依赖 @deepseek-ai/*，在单测环境里导入不了。
//
// v0.4 的两处口径调整（见 docs/adr/0013）：
// - 预算闸只统计**出过的**卡（`shown`）：它是"界面噪音阀门"，不是"生成次数阀门"；
//   被档位抑制的候选不占预算，否则严格档会把预算永远用不完、放松档位时又突然没了额度。
// - 短答闸不再只看最后一个回答的字数：工具密集型回合的收尾回答常常只有一句（「改好了」），
//   但上下文一点都不缺。判据改成「本轮回答总字数 < 80 **且** 本轮没有工具调用」。

/** 回答短于这个字符数、且本轮没有任何工具调用，就不出卡：没有足够上下文，生成的建议必然是空话。 */
export const MIN_ANSWER_CHARS = 80;

/**
 * 判定这一轮是否应当跳过（不调用模型）。
 * @param {{
 *   enabled: boolean, cardEnabled: boolean, pauseUntil: number, now: number,
 *   queued: number, cardsForTurn: boolean, shownCardsInSession: number, maxCards: number,
 *   endKind?: string, answerChars?: number, toolCalls?: number,
 * }} input
 * @returns {{ reason: string, detail: string } | null} 需要跳过时返回原因，否则 null
 */
export function cheapSkipReason(input) {
  if (!input.enabled) return { reason: "disabled", detail: "card generation is off" };
  if (!input.cardEnabled) return { reason: "disabled", detail: "cards are turned off" };
  if (input.pauseUntil > input.now) return { reason: "paused", detail: "generation is paused" };
  // 用户已经排了 ≥2 条消息：他马上要说的话比任何建议都准。
  if (input.queued >= 2)
    return { reason: "queued", detail: "the user already has queued messages" };
  if (input.cardsForTurn) return { reason: "duplicate", detail: "this turn already has a card" };
  if (input.shownCardsInSession >= input.maxCards) {
    return { reason: "budget", detail: "per-session card budget reached" };
  }
  // 上一轮报错/被中断：先让用户看错误、决定怎么修，别在错误旁边推销下一步。
  if (typeof input.endKind === "string" && input.endKind !== "completed") {
    return { reason: "turn-error", detail: `turn ended as ${input.endKind}` };
  }
  if (isShortAnswerWithoutTools(input)) {
    return {
      reason: "short-answer",
      detail: `answer has ${input.answerChars ?? 0} chars and no tool calls`,
    };
  }
  return null;
}

/**
 * 短答闸的判据本身：没有工具调用、且本轮回答总字数不足。
 * 单独导出是为了让 service 与单测用同一套口径（也便于将来在报表里解释这条闸的损益）。
 * @param {{ answerChars?: number, toolCalls?: number }} input
 * @returns {boolean}
 */
export function isShortAnswerWithoutTools(input) {
  const chars = typeof input.answerChars === "number" ? input.answerChars : 0;
  const tools = typeof input.toolCalls === "number" ? input.toolCalls : 0;
  return chars < MIN_ANSWER_CHARS && tools === 0;
}
