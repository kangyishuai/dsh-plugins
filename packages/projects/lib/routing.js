// @ts-check
// 路由：规则优先、模型兜底。纯函数、零 I/O。
// 设计依据 notes/projects/m3-design.md §2：
//   规则命中即确定性执行（不调模型判断），未命中才走兜底；每条决策都要能审计。

/** 规则能被放行的动作（模型只能在兜底时选这些）。 */
export const ROUTE_ACTIONS = Object.freeze([
  "answer-inline",
  "new-thread",
  "reuse-thread",
  "propose",
]);

/**
 * 自治级别允许的动作矩阵（级别不改变危险开关默认值，见 spec §7.4）。
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const AUTONOMY_ALLOWED = Object.freeze({
  L0: ["answer-inline", "propose"],
  L1: ["answer-inline", "propose"],
  L2: ["answer-inline", "propose", "new-thread", "reuse-thread"],
  L3: ["answer-inline", "propose", "new-thread", "reuse-thread"],
});

/**
 * 一条规则是否命中。
 * 不支持的条件一律视为「不命中」——宁可落到兜底或问用户，也不瞎猜。
 * @param {any} rule
 * @param {{ text?: string, threadState?: string, isQuestion?: boolean }} context
 * @returns {boolean}
 */
export function matchRule(rule, context) {
  const when = rule?.when;
  if (!when || typeof when !== "object") return false;
  const text = String(context?.text ?? "");

  if (typeof when.textMatches === "string" && when.textMatches !== "") {
    let regex;
    try {
      regex = new RegExp(when.textMatches, "iu");
    } catch {
      return false; // 用户写坏的正则不能让整个路由崩掉
    }
    if (!regex.test(text)) return false;
  }
  if (Number.isFinite(when.textMaxChars) && text.length > Number(when.textMaxChars)) return false;
  if (typeof when.isQuestion === "boolean" && Boolean(context?.isQuestion) !== when.isQuestion)
    return false;
  if (
    typeof when.threadState === "string" &&
    String(context?.threadState ?? "") !== when.threadState
  ) {
    return false;
  }
  return true;
}

/**
 * 按顺序找第一条命中的规则。
 * @param {any[]} rules
 * @param {{ text?: string, threadState?: string, isQuestion?: boolean }} context
 * @returns {{ ruleId: string, action: string, titleTemplate?: string } | null}
 */
export function matchRules(rules, context) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!matchRule(rule, context)) continue;
    // 规则是扁平结构：{ id, when, action, titleTemplate? }
    const action = String(rule?.action ?? "");
    if (!ROUTE_ACTIONS.includes(action)) continue;
    return {
      ruleId: String(rule?.id ?? ""),
      action,
      ...(typeof rule?.titleTemplate === "string" ? { titleTemplate: rule.titleTemplate } : {}),
    };
  }
  return null;
}

/**
 * 决定怎么处理一条输入。
 * @param {object} input
 * @param {string} input.text
 * @param {any[]} [input.rules]
 * @param {string} [input.autonomy]
 * @param {boolean} [input.isQuestion]
 * @param {string} [input.threadState]
 * @param {{ action: string, titleTemplate?: string } | null} [input.fallback] 模型给的候选（可空）
 * @returns {{
 *   by: "rule"|"fallback"|"blocked",
 *   action: string,
 *   ruleId?: string,
 *   blockedReason?: string,
 *   titleTemplate?: string,
 * }}
 */
export function decideRoute(input) {
  const autonomy = String(input?.autonomy ?? "L1");
  const allowed = AUTONOMY_ALLOWED[autonomy] ?? AUTONOMY_ALLOWED.L1;
  const context = {
    text: String(input?.text ?? ""),
    isQuestion: input?.isQuestion,
    threadState: input?.threadState,
  };

  const hit = matchRules(input?.rules ?? [], context);
  if (hit) {
    if (!allowed.includes(hit.action)) {
      return {
        by: "blocked",
        action: hit.action,
        ruleId: hit.ruleId,
        blockedReason: `autonomy/${autonomy}`,
      };
    }
    return {
      by: "rule",
      action: hit.action,
      ruleId: hit.ruleId,
      ...(hit.titleTemplate ? { titleTemplate: hit.titleTemplate } : {}),
    };
  }

  const fallbackAction = String(input?.fallback?.action ?? "");
  if (fallbackAction === "")
    return { by: "blocked", action: "propose", blockedReason: "no-rule-no-fallback" };
  if (!ROUTE_ACTIONS.includes(fallbackAction)) {
    return { by: "blocked", action: "propose", blockedReason: "invalid-fallback" };
  }
  if (!allowed.includes(fallbackAction)) {
    return { by: "blocked", action: fallbackAction, blockedReason: `autonomy/${autonomy}` };
  }
  return {
    by: "fallback",
    action: fallbackAction,
    ...(typeof input?.fallback?.titleTemplate === "string"
      ? { titleTemplate: input.fallback.titleTemplate }
      : {}),
  };
}

/**
 * 默认规则集合（用户可编辑；这里只给最常见的三条）。
 * @returns {any[]}
 */
export function defaultRules() {
  return [
    { id: "question", when: { isQuestion: true, textMaxChars: 200 }, action: "answer-inline" },
    {
      id: "long-task",
      when: { textMaxChars: 2000 },
      action: "new-thread",
      titleTemplate: "{{firstLine}}",
    },
  ];
}
