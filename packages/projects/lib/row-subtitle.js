// @ts-check
/**
 * 行副标题的**状态语义**（不含文案）：Claude 的行副标题会随状态改写——
 * Working 显示当前动作、Waiting 显示要你回答的问题、Idle 显示结果摘要。
 * 文案在 client 侧按 kind 取 i18n 键，这里只决定"该显示哪一类信息"。
 *
 * @param {{ state?: string, pendingInput?: string[], subtitle?: string }} input
 * @returns {{ kind: "action" | "question" | "failed" | "review" | "archived" | "result", detail: string }}
 */
export function deriveSubtitle(input) {
  const state = String(input?.state ?? "");
  const subtitle = String(input?.subtitle ?? "").trim();
  const pending = Array.isArray(input?.pendingInput)
    ? input.pendingInput.map((item) => String(item ?? "").trim()).filter((item) => item !== "")
    : [];
  // 有未回答的提问时优先显示问题：线程即使还在跑，用户要看的也是"它在等我说什么"
  if (pending.length > 0) return { kind: "question", detail: pending[0] };
  if (state === "working") return { kind: "action", detail: subtitle };
  if (state === "failed") return { kind: "failed", detail: "" };
  if (state === "review") return { kind: "review", detail: subtitle };
  if (state === "archived") return { kind: "archived", detail: "" };
  return { kind: "result", detail: subtitle };
}
