// @ts-check
// 工具结果对模型的暴露规则（纯函数，单测可直接导入）。
//
// 审计 USIM-U1-11：助手回复里出现了「Advisor 当前是关闭状态」——用户不认识 Advisor，
// 也不关心某个插件开没开。来源是 advisor 工具的 skip 结果把内部开关状态写进了 `code` /
// `reason`，而宿主把这些字段作为**工具结果的 JSON value** 交给模型
// （`@deepseek-ai/dsh-tools/src/pipeline.ts` 的 `createSuccessResult`：`value` 给模型，
// `output.render` 只给界面）。所以能从插件侧控制的就是这一份 value。
//
// 收敛规则：
// - 只在 `trigger === "tool"` 时改（其它触发的结果只进账本/面板，不会成为工具结果）；
// - 只收敛「内部开关状态」这一组 code，换成中性 code + 一句「不要播报」；
// - 需要用户动作的跳过（跨 provider 确认）、以及真实失败（超时/不可用）保持原样，
//   模型需要知道这些信息才能继续或提醒用户。

/** 属于「插件开关 / 配置状态」的跳过码：不构成任务结论，不该进对话。 */
export const INTERNAL_STATE_CODES = Object.freeze(["disabled", "not_configured", "shadow_mode"]);

/** 中性跳过码：语义是「这次没有建议」，不透露原因。 */
export const NO_ADVICE_CODE = "no_advice";

/**
 * 中性原因：既告诉模型怎么继续，也明确禁止把状态写进给用户的回复。
 * 中文与插件其它工具文案一致；这句话本身不是用户可见文案（只在模型上下文里）。
 */
export const NEUTRAL_SKIP_REASON =
  "顾问这次没有给出建议。按你自己的判断继续，不要把顾问的启用或配置状态写进给用户的回复。";

/**
 * 决定一次 skip 结果对模型暴露哪一份 code/reason。
 * @param {{ trigger?: unknown, code?: unknown, reason?: unknown } | null | undefined} input
 * @returns {{ status: "skipped", code: string, reason: string }}
 */
export function exposeSkip(input) {
  const trigger = typeof input?.trigger === "string" ? input.trigger : "";
  const code = typeof input?.code === "string" && input.code !== "" ? input.code : "skipped";
  const reason = typeof input?.reason === "string" ? input.reason : "";
  if (trigger === "tool" && INTERNAL_STATE_CODES.includes(code)) {
    return { status: "skipped", code: NO_ADVICE_CODE, reason: NEUTRAL_SKIP_REASON };
  }
  return { status: "skipped", code, reason };
}
