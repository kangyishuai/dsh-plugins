// @ts-check
// 「最近一次生成尝试」的会话级记录（USIM-U2-04）。
//
// 为什么需要这个模块：生成失败原来只在诊断面板 / `<dataRoot>/next-step/events.jsonl` 里可见。
// 自动生成（`turn/end` 之后那次调用）失败**不写会话日志**，客户端也没有任何通道知道它失败了——
// 于是补生成入口一直写「生成下一步建议」，用户看不出刚才失败过；手动补生成撞上在途生成时又只回
// 一句静态「正在生成，请稍候」，永远不消失（真实用户报告：卡了 2 分钟；刷新后再点，失败又静默）。
//
// 现在宿主为每个会话留一条「最近一次结束的生成」记录，客户端用 `nextStep/generateState` 查询它：
// - 自动生成失败 → 按钮直接变「重试」+ 一行原因摘要（详情可展开）；
// - 在途生成（`inflight`）→ 客户端进入等待态并轮询这条记录，后台结束后再决定「出卡 / 重试」，
//   不再把一次 `inflight` 回执当成永久状态；
// - 客户端超时 → 取消服务端在途生成后，用合成 reason `timeout` 进入可重试的错误态。
//
// 纯逻辑、不 import 宿主包：`node --test` 直接覆盖（service.js 依赖 @deepseek-ai/*，加载不了）。
// 记录的生命周期是「一次生成调用结束」：成功、schema / llm / ungrounded / 超时 / 取消都写；
// 「没开始生成」（档位跳过、预算、暂停）不写——客户端要区分的是「刚才失败了」与「压根没生成」。

/** 每会话记录的默认上限（只留最近一条，过剩按写入顺序 FIFO 淘汰）。 */
export const GENERATE_STATUS_LIMIT = 64;

/** detail 的展示上限（超长截断；不把一整段模型/宿主错误原样塞进 UI）。 */
export const GENERATE_DETAIL_CLIP = 240;

/**
 * 归一化 detail：非字符串 / 空白 → ""；超长截断并加省略号。
 * @param {unknown} value
 * @returns {string}
 */
export function clipGenerateDetail(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "";
  return text.length > GENERATE_DETAIL_CLIP ? `${text.slice(0, GENERATE_DETAIL_CLIP - 1)}…` : text;
}

/**
 * 把 `writeCardFor` 的返回归一成一条可序列化的记录。
 * @param {any} outcome `{ ok: true, card } | { ok: false, reason, detail? }`
 * @param {{ turn?: unknown, at?: unknown }} [meta]
 * @returns {{ turn: number, ok: boolean, reason: string, detail: string, at: number }}
 */
export function generateRecordOf(outcome, meta) {
  const ok = outcome !== null && typeof outcome === "object" && outcome.ok === true;
  const reason =
    ok === true
      ? "ok"
      : typeof outcome?.reason === "string" && outcome.reason !== ""
        ? outcome.reason
        : "failed";
  const rawTurn = meta?.turn;
  const rawAt = meta?.at;
  const turn = Number.isSafeInteger(rawTurn) ? Number(rawTurn) : -1;
  const at = Number.isFinite(rawAt) ? Number(rawAt) : 0;
  return { turn, ok, reason, detail: clipGenerateDetail(outcome?.detail), at };
}

/**
 * 建一个「每会话最近一次生成」的记录表。
 * @param {{ limit?: number, now?: () => number }} [options]
 * @returns {{
 *   size: number,
 *   record: (sessionId: string, outcome: any, turn: number) => any,
 *   last: (sessionId: string) => any,
 * }}
 */
export function createGenerateStatus(options) {
  const limit =
    Number.isSafeInteger(options?.limit) && Number(options?.limit) >= 1
      ? Number(options?.limit)
      : GENERATE_STATUS_LIMIT;
  const now = typeof options?.now === "function" ? options.now : () => Date.now();
  /** @type {Map<string, any>} */
  const entries = new Map();

  return {
    get size() {
      return entries.size;
    },
    /**
     * 记录一次已结束的生成。成功也记（客户端据此把「刚才的失败」清掉）。
     * @param {string} sessionId
     * @param {any} outcome
     * @param {number} turn
     * @returns {any} 归一化后的记录；空 sessionId 返回 null
     */
    record(sessionId, outcome, turn) {
      if (typeof sessionId !== "string" || sessionId === "") return null;
      const record = generateRecordOf(outcome, { turn, at: now() });
      // 先删再插：同一会话的记录永远在 map 尾部，FIFO 淘汰的只是「最久没更新的会话」。
      if (entries.has(sessionId)) entries.delete(sessionId);
      entries.set(sessionId, record);
      if (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (typeof oldest === "string") entries.delete(oldest);
      }
      return record;
    },
    /**
     * 该会话最近一次结束的生成（没有则 null）。
     * @param {string} sessionId
     * @returns {any}
     */
    last(sessionId) {
      return entries.get(sessionId) ?? null;
    },
  };
}
