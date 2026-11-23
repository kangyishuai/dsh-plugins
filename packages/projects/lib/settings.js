// @ts-check
// 规格 §7.5 行 5a：模型可以申请「改本插件自己的配置」，但**不能**改安全约束本身。
// 这条白名单就是「自己的配置」与「自我提权」的分界线，纯函数便于单测。

/** 允许通过审批修改的项目策略键（都是非安全面）。 */
export const EDITABLE_KEYS = Object.freeze(["persona", "routing", "goal"]);

/**
 * 路由规则 `when` 的合法形状（审计 G15/N23 的契约统一）。
 * `routing.js` 的匹配器只认**对象**条件（`{textMatches,textMaxChars,isQuestion,threadState}`）；
 * B1 时这里却要求字符串，于是真实规则（含 `defaultRules()` 自己）永远进不了审批写路径。
 * 白名单化后判据只有一份：`matchRule` 读哪些键，这里就允许哪些键。
 */
export const ROUTE_WHEN_KEYS = Object.freeze([
  "textMatches",
  "textMaxChars",
  "isQuestion",
  "threadState",
]);

/**
 * 校验并收敛一条规则的 `when` 条件。
 * @param {any} when
 * @returns {{ ok: true, when: Record<string, any> } | { ok: false, reason: string }}
 */
export function normalizeRoutingWhen(when) {
  if (!when || typeof when !== "object" || Array.isArray(when)) {
    return { ok: false, reason: "settings/routing-when-must-be-object" };
  }
  /** @type {Record<string, any>} */
  const clean = {};
  for (const [key, value] of Object.entries(when)) {
    if (!ROUTE_WHEN_KEYS.includes(key)) {
      return { ok: false, reason: `settings/routing-when-unknown:${key}` };
    }
    if (key === "textMatches" || key === "threadState") {
      if (typeof value !== "string") {
        return { ok: false, reason: `settings/routing-when-bad-type:${key}` };
      }
      clean[key] = value;
      continue;
    }
    if (key === "textMaxChars") {
      if (!Number.isFinite(value) || Number(value) < 0) {
        return { ok: false, reason: `settings/routing-when-bad-type:${key}` };
      }
      clean[key] = Number(value);
      continue;
    }
    if (typeof value !== "boolean") {
      return { ok: false, reason: `settings/routing-when-bad-type:${key}` };
    }
    clean[key] = value;
  }
  return { ok: true, when: clean };
}

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
      /** @type {any[]} */
      const normalized = [];
      for (const rule of rules) {
        const shape = rule && typeof rule === "object" ? rule : {};
        if (typeof shape.id !== "string" || shape.id === "") {
          return { ok: false, reason: "settings/routing-rule-shape" };
        }
        if (typeof shape.action !== "string") {
          return { ok: false, reason: "settings/routing-rule-shape" };
        }
        const checked = normalizeRoutingWhen(shape.when);
        if (!checked.ok) return { ok: false, reason: checked.reason };
        normalized.push({
          id: shape.id,
          when: checked.when,
          action: shape.action,
          ...(typeof shape.titleTemplate === "string"
            ? { titleTemplate: shape.titleTemplate }
            : {}),
        });
      }
      clean.routing = { rules: normalized, fallback: value.fallback !== false };
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
