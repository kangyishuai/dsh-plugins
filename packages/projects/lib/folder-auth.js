// @ts-check
// F55 / U20：本地文件夹授权卡的三键语义。
// 宿主只提供 `allowed-once`（见 scope-confirmed §12.3-4：ApprovalOutcome 没有"始终允许"），
// 所以：
//   Deny            → 记录 denied，插件执行器据此不再为这个目录发起请求
//   Set as default  → 落到**我们自己的 store**（project.policy.folderAuth[path].mode='default'）
//   Allow once      → 记一张一次性凭据（mode='once'，used=false），用掉即失效；
//                     语义对齐宿主的 allowed-once，只对当前项目的一次动作有效
// 纯函数，写盘在 service。

/** 三键的决策词表。 */
export const FOLDER_DECISIONS = Object.freeze(["deny", "default", "once"]);

/** 三键的中文标签（UI 与审计共用一份）。 */
export const FOLDER_DECISION_LABELS = Object.freeze({
  deny: "不给权限",
  default: "设为默认目录",
  once: "只允许一次",
});

/**
 * @param {unknown} value
 * @returns {"deny"|"default"|"once"|""}
 */
export function normalizeFolderDecision(value) {
  const text = String(value ?? "").trim();
  return FOLDER_DECISIONS.includes(text) ? /** @type {any} */ (text) : "";
}

/**
 * 把一次决策写进 policy（返回新 policy，不改原对象）。
 * @param {any} policy
 * @param {string} path
 * @param {unknown} decision
 * @param {number} [now]
 * @returns {{ ok: true, policy: any, record: any } | { ok: false, reason: string }}
 */
export function applyFolderDecision(policy, path, decision, now) {
  const target = String(path ?? "").trim();
  const mode = normalizeFolderDecision(decision);
  if (target === "") return { ok: false, reason: "folder/empty-path" };
  if (mode === "") return { ok: false, reason: "folder/unknown-decision" };
  const current = policy && typeof policy === "object" ? policy : {};
  const folderAuth = {
    ...(current.folderAuth && typeof current.folderAuth === "object" ? current.folderAuth : {}),
  };
  const record = {
    mode,
    at: new Date(Number.isFinite(now) ? Number(now) : Date.now()).toISOString(),
    used: false,
  };
  folderAuth[target] = record;
  return { ok: true, policy: { ...current, folderAuth }, record: { path: target, ...record } };
}

/**
 * 目录的授权摘要（UI 卡片最上面那行）。
 * @param {any} policy
 * @param {string} path
 * @returns {{ mode: string, label: string, allowed: boolean, at: string }}
 */
export function folderAuthSummary(policy, path) {
  const target = String(path ?? "").trim();
  const record = policy?.folderAuth?.[target];
  const mode = normalizeFolderDecision(record?.mode);
  if (mode === "") return { mode: "unset", label: "还没授权", allowed: false, at: "" };
  const allowed = mode === "default" || (mode === "once" && record?.used !== true);
  return {
    mode,
    label: FOLDER_DECISION_LABELS[mode],
    allowed,
    at: typeof record?.at === "string" ? record.at : "",
  };
}

/**
 * 消费一张一次性凭据（Allow once 用掉即失效）。没有未用的一次性凭据就返回 ok:false。
 * @param {any} policy @param {string} path
 * @returns {{ ok: boolean, policy: any, reason: string }}
 */
export function consumeOnceFolderGrant(policy, path) {
  const target = String(path ?? "").trim();
  const record = policy?.folderAuth?.[target];
  if (record?.mode !== "once" || record.used === true) {
    return { ok: false, policy, reason: "folder/no-once-grant" };
  }
  return {
    ok: true,
    policy: {
      ...(policy ?? {}),
      folderAuth: {
        ...(policy?.folderAuth ?? {}),
        [target]: { ...record, used: true, usedAt: new Date().toISOString() },
      },
    },
    reason: "",
  };
}
