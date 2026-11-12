// @ts-check
// 内置模型目录：**兜底用的能力档位与价格表**。
//
// DSH 的 `LlmModelInfo` 没有 rank、没有价格（见 docs/runtime §9.15），所以配对与金额只能靠元数据。
// 这里给一张很小的、刻意保守的表：
// - 只覆盖确定了解的型号；**认不出就返回 undefined**，绝不猜（猜错比不知道更糟）；
// - 用户可以在设置里用 `tiers` / 单价覆盖这里的值（覆盖优先）；
// - 表里的价格是「量级参考」，不是报价；设置页会标「估算」。
//
// 纯数据 + 纯函数，不 import 宿主包。

/**
 * 能力档位（越大越强）。同一族按代际与规格排序；跨族只保证「明显更强/更弱」的关系。
 * 键是模型 id 的小写匹配片段，按**从长到短**匹配，避免 `deepseek-v4` 抢走 `deepseek-v4.1-flash`。
 * @type {ReadonlyArray<{ match: string, rank: number }>}
 */
export const MODEL_RANKS = Object.freeze([
  { match: "deepseek-v4.1-flash", rank: 3 },
  { match: "deepseek-v4.1", rank: 5 },
  { match: "deepseek-v4-pro", rank: 6 },
  { match: "deepseek-v3.2", rank: 3 },
  { match: "deepseek-reasoner", rank: 5 },
  { match: "deepseek-chat", rank: 3 },
  { match: "claude-opus-4", rank: 7 },
  { match: "claude-sonnet-4", rank: 5 },
  { match: "claude-haiku-4", rank: 2 },
  { match: "gpt-5", rank: 6 },
  { match: "gpt-4.1", rank: 4 },
  { match: "o3", rank: 6 },
  { match: "o4-mini", rank: 4 },
  { match: "kimi-k3", rank: 5 },
  { match: "qwen3.8-max", rank: 6 },
  { match: "qwen3.8-flash", rank: 3 },
  { match: "glm-5.3", rank: 4 },
  { match: "glm-5.3-flash", rank: 3 },
]);

/**
 * 价格（USD / 百万 token），只用于「估算」。缺失即未知。
 * @type {ReadonlyArray<{ match: string, input: number, output: number }>}
 */
export const MODEL_PRICES = Object.freeze([
  { match: "deepseek-v4.1-flash", input: 0.1, output: 0.3 },
  { match: "deepseek-v4-pro", input: 0.6, output: 2.4 },
  { match: "deepseek-v4.1", input: 0.3, output: 1.2 },
  { match: "deepseek-reasoner", input: 0.6, output: 2.4 },
  { match: "deepseek-chat", input: 0.3, output: 1.2 },
  { match: "claude-haiku-4", input: 1, output: 5 },
  { match: "claude-sonnet-4", input: 3, output: 15 },
  { match: "claude-opus-4", input: 15, output: 75 },
  { match: "kimi-k3", input: 0.6, output: 2.4 },
  { match: "qwen3.8-flash", input: 0.1, output: 0.3 },
]);

/**
 * 在表里按「最长匹配优先」找一行。
 * @template T
 * @param {readonly T[]} table
 * @param {string} id
 * @param {(row: T) => string} key
 * @returns {T|undefined}
 */
function lookup(table, id, key) {
  const model = String(id ?? "").toLowerCase();
  if (model === "") return undefined;
  /** @type {T|undefined} */
  let best;
  let bestLength = 0;
  for (const row of table) {
    const needle = key(row);
    if (!model.includes(needle)) continue;
    if (needle.length > bestLength) {
      best = row;
      bestLength = needle.length;
    }
  }
  return best;
}

/**
 * 内置档位；认不出返回 undefined。
 * @param {string} modelId
 * @returns {number|undefined}
 */
export function builtinRank(modelId) {
  const row = lookup(MODEL_RANKS, modelId, (item) => item.match);
  return row === undefined ? undefined : row.rank;
}

/**
 * 内置价格；认不出返回 undefined。
 * @param {string} modelId
 * @returns {{ input: number, output: number }|undefined}
 */
export function builtinPrice(modelId) {
  const row = lookup(MODEL_PRICES, modelId, (item) => item.match);
  return row === undefined ? undefined : { input: row.input, output: row.output };
}

/**
 * 有效档位：用户声明 > 内置；都没有返回 undefined（= 未校验）。
 * @param {Record<string, number>} tiers
 * @param {{ provider: string, model: string }} route
 * @returns {number|undefined}
 */
export function effectiveRank(tiers, route) {
  const key = `${route.provider}/${route.model}`;
  const declared = tiers !== null && typeof tiers === "object" ? tiers[key] : undefined;
  if (typeof declared === "number" && Number.isFinite(declared)) return declared;
  return builtinRank(route.model);
}

/**
 * 有效单价：用户声明 > 内置；都没有返回 `{ input: 0, output: 0 }`（= 不算钱）。
 * @param {{ priceInputPerMTok: number, priceOutputPerMTok: number }} settings
 * @param {string} modelId
 * @returns {{ input: number, output: number, source: "settings"|"builtin"|"none" }}
 */
export function effectivePrice(settings, modelId) {
  const input = Number(settings?.priceInputPerMTok ?? 0) || 0;
  const output = Number(settings?.priceOutputPerMTok ?? 0) || 0;
  if (input > 0 || output > 0) return { input, output, source: "settings" };
  const builtin = builtinPrice(modelId);
  if (builtin !== undefined) return { ...builtin, source: "builtin" };
  return { input: 0, output: 0, source: "none" };
}

/**
 * 用户白名单：`allowedModels` 为空表示不限制；否则只允许列出的 `provider/model` 或裸 model id。
 * @param {string[]} allowedModels
 * @param {{ provider: string, model: string }} route
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkAllowlist(allowedModels, route) {
  const list = Array.isArray(allowedModels)
    ? allowedModels.filter((item) => typeof item === "string" && item !== "")
    : [];
  if (list.length === 0) return { allowed: true, reason: "未设置白名单" };
  const full = `${route.provider}/${route.model}`;
  if (list.includes(full) || list.includes(route.model))
    return { allowed: true, reason: "在白名单内" };
  return { allowed: false, reason: `不在 allowedModels 白名单内（${list.length} 条）` };
}
