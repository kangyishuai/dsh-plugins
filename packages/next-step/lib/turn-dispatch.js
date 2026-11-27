// @ts-check
// 「这条 `session/event` 该不该进入出卡流程」的判定：纯函数，可直接单测。
//
// 背景（AUD-NS-05）：`service.js` 的 `handleSessionEvent` 原来在进入闸之前就
// `if (reason.kind !== "completed") return;` 直接返回，于是 `cheapSkipReason` 里的
// `turn-error` 分支**永远为假**——8 道闸里只有 `ok` / `short-answer` 两道会真的落盘。
// 真实数据 640 条 turn 事件里 `turn-error` 一次都没出现，维护者看闸门分布会误以为
// 「其它闸从不触发」，其实它们在事件层根本不可观测。
//
// 修法：completed 的过滤下移到闸之后——非 completed 的回合也走一次便宜闸（命中 `turn-error`
// 并落一条 turn 事件，仍然**不调模型**）。这个纯函数只负责「要不要进流程」，
// 不再关心 `reason.kind` 是什么；把「哪些原因该被统计」的决定留给 `cheapSkipReason`。

/**
 * 回合结束原因的归一化：`reason.kind` **缺失 / 非字符串 / 空串**一律当成 `"unknown"`。
 *
 * 为什么必须归一化（而不是靠 `cheapSkipReason` 里那句 `typeof endKind === "string"`）：
 * AUD-NS-05 把 completed 过滤下移之后，`turn/end` 缺 `reason` 的事件也会进流程。
 * 如果不归一化，`endKind === undefined` 会让 `cheapSkipReason` 的 `turn-error` 分支不成立，
 * 于是一个「不知道原因」的回合反而可能过闸并调模型——这违背「只有正常结束的回合才生成」。
 * 归一化成 `"unknown"` 之后，它必然命中 `turn-error`（不调模型、只落遥测）。
 * @param {unknown} reasonKind
 * @returns {string}
 */
export function endKindOf(reasonKind) {
  const text = typeof reasonKind === "string" ? reasonKind.trim() : "";
  return text === "" ? "unknown" : text;
}

/**
 * @param {{ subagent?: boolean, turn?: unknown, reasonKind?: unknown }} input
 * @returns {{ consider: boolean, turn: number, endKind: string, reason?: "subagent" | "no-turn" }}
 *   `consider === true` 时 `turn` 是安全的整数回合号，`endKind` 已归一化。
 */
export function turnEndDisposition(input) {
  // 子代理会话按设计不出卡，也不落事件（它们不是用户可见的对话）。
  if (input.subagent === true) {
    return { consider: false, turn: -1, endKind: endKindOf(input.reasonKind), reason: "subagent" };
  }
  const turn = input.turn;
  if (!Number.isSafeInteger(turn)) {
    return { consider: false, turn: -1, endKind: endKindOf(input.reasonKind), reason: "no-turn" };
  }
  return {
    consider: true,
    turn: /** @type {number} */ (turn),
    endKind: endKindOf(input.reasonKind),
  };
}
