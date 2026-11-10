// @ts-check
// 「用户已经在排队，就别再塞建议」的闸——纯函数，方便单测。
//
// 依据：官方 `dsh-action-cards` 的 `queuedMessageLimit = 2`（用户已排 ≥2 条消息时不再出卡），
// 避免「你已经排了两条，它还弹一张卡让你再点一条」这种噪音。宿主的排队消息可读面是
// `agent.inbox.nextStep` / `agent.inbox.nextTurn`（见 docs/runtime/0.2.2-rc.1.md §9.6）。

/** 用户已排队多少条消息时就不再出卡（0 = 关闭该闸）。 */
export const QUEUED_MESSAGE_LIMIT = 2;

/**
 * 该不该因为「用户已在排队」而跳过生成。
 * @param {number} queued 当前排队（next-turn + next-step）的消息条数
 * @param {number} [limit] 闸值；0 表示不启用
 * @returns {boolean} true = 跳过
 */
export function shouldSkipForQueue(queued, limit = QUEUED_MESSAGE_LIMIT) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  if (!Number.isFinite(queued) || queued <= 0) return false;
  return queued >= limit;
}
