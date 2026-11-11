// @ts-check
// 选路与配对校验。纯函数，不 import 宿主包。
//
// DSH 没有厂商那种「模型能力目录」，所以档位只能来自用户声明（settings.tiers）。
// 拿不到档位时**不阻断**、也不假装通过：返回 kind:"unknown"，由 UI 明示「未校验」。

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} Route
 */

/**
 * 档位表的键。
 * @param {{ provider: string, model: string }} route
 * @returns {string}
 */
export function modelKey(route) {
  return `${route.provider}/${route.model}`;
}

/**
 * 取一个模型的档位；没有声明返回 undefined。
 * @param {Record<string, number>} tiers
 * @param {{ provider: string, model: string }} route
 * @returns {number|undefined}
 */
export function tierOf(tiers, route) {
  if (tiers === null || typeof tiers !== "object") return undefined;
  const value = tiers[modelKey(route)];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 选路：设置里显式配置 > 回落到会话当前模型（并标记 sameAsMain，供 UI 告警）。
 * @param {{ settings: { provider: string, model: string, reasoningEffort: string }, mainModel?: Route }} input
 * @returns {{ route: Route, source: "settings"|"main-model", sameAsMain: boolean }}
 */
export function resolveRoute(input) {
  const { settings, mainModel } = input;
  const provider = typeof settings.provider === "string" ? settings.provider.trim() : "";
  const model = typeof settings.model === "string" ? settings.model.trim() : "";
  const effort =
    typeof settings.reasoningEffort === "string" ? settings.reasoningEffort.trim() : "";

  if (provider !== "" && model !== "") {
    /** @type {Route} */
    const route = { provider, model };
    if (effort !== "") route.reasoningEffort = effort;
    const sameAsMain =
      mainModel !== undefined && mainModel.provider === provider && mainModel.model === model;
    return { route, source: "settings", sameAsMain };
  }

  if (mainModel && mainModel.provider !== "" && mainModel.model !== "") {
    /** @type {Route} */
    const route = { provider: mainModel.provider, model: mainModel.model };
    if (effort !== "") route.reasoningEffort = effort;
    return { route, source: "main-model", sameAsMain: true };
  }

  return { route: { provider: "", model: "" }, source: "settings", sameAsMain: false };
}

/**
 * @typedef {{ kind: "ok"|"weaker"|"unknown", mainRank?: number, advisorRank?: number, message: string }} PairingResult
 */

/**
 * 配对校验：顾问档位必须 >= 主模型档位（等强可互当）。
 * 任一侧没有声明档位 → unknown（不阻断，只提示）。
 * @param {{ tiers: Record<string, number>, main: Route, advisor: Route, enforcement?: "warn"|"block" }} input
 * @returns {PairingResult & { allowed: boolean }}
 */
export function pairingCheck(input) {
  const { tiers, main, advisor } = input;
  const enforcement = input.enforcement === "block" ? "block" : "warn";

  const mainRank = tierOf(tiers, main);
  const advisorRank = tierOf(tiers, advisor);

  if (mainRank === undefined || advisorRank === undefined) {
    return {
      kind: "unknown",
      mainRank,
      advisorRank,
      message: "未校验：没有这两个模型的能力档位（可在设置里声明 tiers）",
      allowed: true,
    };
  }
  if (advisorRank >= mainRank) {
    return {
      kind: "ok",
      mainRank,
      advisorRank,
      message: `顾问档位 ${advisorRank} ≥ 主模型 ${mainRank}`,
      allowed: true,
    };
  }
  return {
    kind: "weaker",
    mainRank,
    advisorRank,
    message: `顾问档位 ${advisorRank} 低于主模型 ${mainRank}，可能给出更弱的建议`,
    allowed: enforcement === "warn",
  };
}

/**
 * 规范化思考档：空串表示「自动（用模型默认）」，交给 prepareCall 的 configure 回调决定。
 * @param {string} value
 * @returns {string}
 */
export function normalizeEffort(value) {
  return typeof value === "string" ? value.trim() : "";
}
