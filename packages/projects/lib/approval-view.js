// @ts-check
// 危险动作审批卡片要展示的「影响面」投影（审计 AUD-PROJ-07）。
//
// 背景：审批行以前只渲染 `${action} · ${reason}`——PR 号、仓库、分支、目录、变更键全都
// 不显示，而「批准/执行」按钮就在同一行。ADR 0002 要求破坏性操作必须明示影响面。
//
// 为什么是**服务端投影**而不是把 args 整块丢给 UI：
//  - args 由模型可控（`project_request_action`），形状不稳定，UI 直接渲染只能泼 JSON；
//  - 只投影白名单字段，天然避免把未来新增的敏感字段带到界面上；
//  - UI 只渲染**纯文本**（React 文本节点），不做 HTML 注入。
//
// 纯函数、零 I/O：service 在 `listApprovals` 里把结果附在每一行上。

/** 单个值的展示长度上限（再长就不是「影响面」而是内容了）。 */
const MAX_VALUE_CHARS = 120;

/**
 * 把任意值压成单行可读文本。
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  if (typeof value === "string") {
    const single = value.replace(/\s+/gu, " ").trim();
    return single.length > MAX_VALUE_CHARS ? `${single.slice(0, MAX_VALUE_CHARS)}…` : single;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * 一个动作的影响面行（key 是稳定的 `data-*` 锚点用的键名）。
 * @typedef {{ key: string, label: string, value: string }} ImpactRow
 */

/**
 * 投影一条审批申请的影响面。
 *
 * 每条都附 `summary`（单行，界面上一眼看完），敏感/超长值一律截断而不是原样透出。
 * @param {{ action?: string, args?: any }} approval
 * @returns {{ summary: string, rows: ImpactRow[], redacted: string[] }}
 */
export function describeApprovalImpact(approval) {
  const action = String(approval?.action ?? "");
  const args = approval?.args && typeof approval.args === "object" ? approval.args : {};
  /** @type {ImpactRow[]} */
  const rows = [];
  /** @type {string[]} */
  const redacted = [];
  const push = (
    /** @type {string} */ key,
    /** @type {string} */ label,
    /** @type {unknown} */ value,
  ) => {
    const text = asText(value);
    if (text === "") return;
    rows.push({ key, label, value: text });
  };

  if (action === "merge") {
    push("prNumber", "PR", args.prNumber);
    push("repo", "repo", args.repo);
    push("method", "method", args.method);
  } else if (action === "push-branch" || action === "push-protected-branch") {
    push("branch", "branch", args.branch);
    if (action === "push-protected-branch") push("repo", "repo", args.repo);
    if (args.force === true) rows.push({ key: "force", label: "force", value: "true" });
    push(
      "expectedSha",
      "expectedSha",
      typeof args.expectedSha === "string" ? args.expectedSha.slice(0, 12) : "",
    );
  } else if (action === "delete-thread") {
    push("sessionId", "session", args.sessionId ?? args.threadSessionId);
    push("branch", "branch", args.branch);
    push("worktree", "worktree", args.worktree);
  } else if (action === "delete-project") {
    push("projectId", "project", args.projectId);
    push("dirs", "dirs", Array.isArray(args.dirs) ? args.dirs.join(", ") : "");
  } else if (action === "purge-trash") {
    push("projectId", "project", args.projectId);
    push("retentionDays", "retentionDays", args.retentionDays);
  } else if (action === "change-settings") {
    // 只显示**改了哪些键**：值可能很长（persona）或与安全面相邻，界面上不需要全文。
    const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
    const keys = Object.keys(patch);
    push("keys", "keys", keys.join(", "));
  } else {
    // 未知动作：只透出标量白名单，其余计数（不认识的东西不原样泼出去）
    for (const key of ["prNumber", "repo", "branch", "sessionId", "projectId", "path", "dir"]) {
      push(key, key, args[key]);
    }
  }

  // `args.impact` 是被审对象自己写的「影响面」，不参与展示（只标出来它被忽略了）。
  if (Object.hasOwn(args, "impact")) redacted.push("impact");
  const summary = rows
    .map((row) => `${row.label}=${row.value}`)
    .join(" · ")
    .slice(0, 400);
  return { summary, rows, redacted };
}

/**
 * 一批申请的展示投影（service.listApprovals 用）。
 * @param {any[]} approvals
 * @returns {any[]}
 */
export function withApprovalImpact(approvals) {
  return (Array.isArray(approvals) ? approvals : []).map((item) => ({
    ...item,
    impact: describeApprovalImpact(item),
  }));
}
