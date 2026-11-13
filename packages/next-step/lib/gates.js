// @ts-check
// 便宜闸：在做那次模型调用**之前**就能判断出「这一轮不该出卡」的条件。
// 每一条都对应一种「此刻打扰是负价值」的场景，参考 Claude 的建议生成门控：
// 出错的时候不要打扰用户、回答太短没有上下文可依、用户已经在排队等回复。
//
// 抽成纯函数是为了能单测：service.js 依赖 @deepseek-ai/*，在单测环境里导入不了。

/** 回答短于这个字符数就不出卡：没有足够上下文，生成的建议必然是空话。 */
export const MIN_ANSWER_CHARS = 80;

/**
 * 判定这一轮是否应当跳过（不调用模型）。
 * @param {{
 *   enabled: boolean, cardEnabled: boolean, pauseUntil: number, now: number,
 *   queued: number, cardsForTurn: boolean, cardsInSession: number, maxCards: number,
 *   endKind?: string, answerChars?: number,
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
  if (input.cardsInSession >= input.maxCards) {
    return { reason: "budget", detail: "per-session card budget reached" };
  }
  // 上一轮报错/被中断：先让用户看错误、决定怎么修，别在错误旁边推销下一步。
  if (typeof input.endKind === "string" && input.endKind !== "completed") {
    return { reason: "turn-error", detail: `turn ended as ${input.endKind}` };
  }
  if (typeof input.answerChars === "number" && input.answerChars < MIN_ANSWER_CHARS) {
    return { reason: "short-answer", detail: `answer has ${input.answerChars} chars` };
  }
  return null;
}
