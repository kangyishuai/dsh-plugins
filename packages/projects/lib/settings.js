// @ts-check
// 规格 §7.5 行 5a：模型可以申请「改本插件自己的配置」，但**不能**改安全约束本身。
// 这条白名单就是「自己的配置」与「自我提权」的分界线，纯函数便于单测。

/** 允许通过审批修改的项目策略键（都是非安全面）。 */
export const EDITABLE_KEYS = Object.freeze(["persona", "routing", "goal"]);

/**
 * 明确禁止的键（规格 §7.5 行 5b：改审批/预算/审计开关本身 = 自我提权）。
 * 命中就拒绝，且要给出可读理由。
 */
export const FORBIDDEN_KEYS = Object.freeze([
  "danger",
  "autonomy",
  "preapprove",
  "budget",
  "repoGrants",
  "coordinatorSessionId",
  "state",
  "id",
]);

/**
 * 校验一个「改配置」补丁。
 * @param {any} patch
 * @returns {{ ok: true, patch: Record<string, any>, keys: string[] } | { ok: false, reason: string }}
 */
export function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, reason: "settings/patch-required" };
  }
  const entries = Object.entries(patch);
  if (entries.length === 0) return { ok: false, reason: "settings/patch-empty" };
  /** @type {Record<string, any>} */
  const clean = {};
  for (const [key, value] of entries) {
    if (FORBIDDEN_KEYS.includes(key)) return { ok: false, reason: `settings/forbidden:${key}` };
    if (!EDITABLE_KEYS.includes(key)) return { ok: false, reason: `settings/not-editable:${key}` };
    if (key === "persona" && typeof value !== "string") {
      return { ok: false, reason: "settings/persona-must-be-string" };
    }
    if (key === "goal" && typeof value !== "string") {
      return { ok: false, reason: "settings/goal-must-be-string" };
    }
    if (key === "routing") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, reason: "settings/routing-must-be-object" };
      }
      const rules = Array.isArray(value.rules) ? value.rules : [];
      for (const rule of rules) {
        const shape = rule && typeof rule === "object" ? rule : {};
        if (typeof shape.id !== "string" || typeof shape.when !== "string") {
          return { ok: false, reason: "settings/routing-rule-shape" };
        }
        if (typeof shape.action !== "string") {
          return { ok: false, reason: "settings/routing-rule-shape" };
        }
      }
      clean.routing = { rules, fallback: value.fallback !== false };
      continue;
    }
    clean[key] = value;
  }
  return { ok: true, patch: clean, keys: Object.keys(clean) };
}

/**
 * 把补丁应用到策略上（只覆盖白名单键，其余原样保留）。
 * @param {any} policy
 * @param {Record<string, any>} patch
 * @returns {any}
 */
export function applySettingsPatch(policy, patch) {
  const next = { ...(policy ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    next[key] = value;
  }
  return next;
}
