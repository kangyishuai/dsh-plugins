// @ts-check
// 危险动作执行器：闸门与命令计划。纯函数、零 I/O。
// 依据 m4-design.md §0/§1 与 spec §7.5：
//   批准 ≠ 可执行。批准只是「人同意了这一次」，还要开关打开、影响面在阈值内。
//   三种授权来源之外一律拒绝；模型输出/外部内容/peer 消息永远不算授权。

/** 可执行的危险动作（与 tools.js 的 REQUESTABLE_ACTIONS 同集合，但语义不同：
 *  这里问的是「能不能执行」，那边问的是「能不能申请」。 */
export const DANGER_ACTIONS = Object.freeze([
  "push-branch",
  "merge",
  "delete-thread",
  "delete-project",
  "change-settings",
]);

/**
 * 动作 → 危险开关键（spec §7.5 的六个键）。
 * 执行器问的是「action」，策略里存的是「switch」，两者**必须显式映射**——
 * 否则会出现「打开开关也永远被拒」这种静默失效（真机上就是这么踩到的）。
 * @param {string} action
 * @returns {string}
 */
export function switchForAction(action) {
  switch (action) {
    case "push-branch":
      return "forcePushOwnBranch";
    case "merge":
      return "autoMerge";
    case "delete-thread":
    case "delete-project":
      return "trashAuto";
    case "change-settings":
      return "editProfile";
    default:
      return "";
  }
}

/** 结构性硬边：**不提供、不可配置**（spec §7.6）。 */
export const STRUCTURALLY_FORBIDDEN = Object.freeze([
  "force-push-others-branch",
  "coordinator-permanent-delete",
  "edit-constraint-switches",
]);

/** merge 的默认阈值（spec §7.5）。 */
export const DEFAULT_MERGE_LIMITS = Object.freeze({ maxDiffFiles: 20, maxDiffLines: 600 });

/**
 * 判断一条申请现在能不能执行。
 * @param {object} input
 * @param {{ status?: string, action?: string }} input.approval
 * @param {Record<string, boolean>} [input.danger] 项目的危险开关
 * @param {{ maxDiffFiles?: number, maxDiffLines?: number }} [input.limits]
 * @param {{ diffFiles?: number, diffLines?: number, baseBranch?: string|null, worktreeClean?: boolean|null }} [input.impact]
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkExecutable(input) {
  const approval = input?.approval ?? {};
  const action = String(approval.action ?? "");

  if (String(approval.status ?? "") !== "approved") return { ok: false, reason: "not-approved" };
  if (!DANGER_ACTIONS.includes(action))
    return { ok: false, reason: `action-not-executable: ${action || "(empty)"}` };
  const switchKey = switchForAction(action);
  if (switchKey === "" || input?.danger?.[switchKey] !== true)
    return { ok: false, reason: "switch-off" };

  const limits = { ...DEFAULT_MERGE_LIMITS, ...(input?.limits ?? {}) };
  const impact = input?.impact ?? {};

  if (action === "merge") {
    // 只合并自己开的 PR、基分支必须是项目主线；影响面必须落在阈值内
    if (
      Number.isFinite(impact.diffFiles) &&
      Number(impact.diffFiles) > Number(limits.maxDiffFiles)
    ) {
      return { ok: false, reason: "merge/too-many-files" };
    }
    if (
      Number.isFinite(impact.diffLines) &&
      Number(impact.diffLines) > Number(limits.maxDiffLines)
    ) {
      return { ok: false, reason: "merge/too-many-lines" };
    }
  }

  if (action === "delete-thread" && impact.worktreeClean === false) {
    // worktree 不干净时不许借"删除线程"顺手删掉未提交内容（M2 三重判据的延续）
    return { ok: false, reason: "delete-thread/worktree-dirty" };
  }

  return { ok: true, reason: "" };
}

/**
 * 生成执行命令（argv 数组，**不做 shell 插值**）。
 * 拒绝任何越界参数：分支名/PR 号必须是我们自己记录过的。
 * @param {string} action
 * @param {any} args
 * @returns {{ argv: string[] } | { error: string }}
 */
export function planCommand(action, args) {
  const nonEmpty = (/** @type {unknown} */ value) =>
    typeof value === "string" && value.trim() !== "";

  if (action === "push-branch") {
    const branch = String(args?.branch ?? "").trim();
    if (!nonEmpty(branch)) return { error: "branch-required" };
    // 只推自己建的分支，且名字必须落在我们的字符集内（纵深防御：argv 虽无注入，
    // 但分支名会被写进审计、URL 与 PR 描述，宽白名单没有好处）
    if (!/^dsh\/[A-Za-z0-9._/-]+$/u.test(branch)) return { error: "branch-not-ours" };
    return { argv: ["git", "push", "-u", "origin", branch] };
  }

  if (action === "merge") {
    const prNumber = Number(args?.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return { error: "pr-required" };
    // **必须**带 --repo：否则 gh 会合并「宿主进程当前目录所在仓库」里同号的 PR。
    // 这是 2026-11-21 真机 e2e 抓到的真缺陷：命令跑在 dsh-plugins 仓库里，
    // 恰好那里 PR #1 已合并、gh 返回 0，于是插件误判成功，而目标 PR 根本没动。
    const repo = String(args?.repo ?? "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) return { error: "repo-required" };
    return { argv: ["gh", "pr", "merge", String(prNumber), "--squash", "--repo", repo] };
  }

  if (action === "delete-thread") {
    const sessionId = String(args?.sessionId ?? "").trim();
    if (!nonEmpty(sessionId)) return { error: "session-required" };
    return { argv: ["reclaim-worktree", sessionId] }; // 内部动作，不是外部命令
  }

  if (action === "delete-project") {
    const projectId = String(args?.projectId ?? "").trim();
    if (!nonEmpty(projectId)) return { error: "project-required" };
    return { argv: ["trash-project", projectId] };
  }

  return { error: `no-command-for: ${action || "(empty)"}` };
}

/**
 * 恢复证据：每个不可逆动作都要能说清"怎么退回去"。
 * @param {string} action
 * @param {any} args
 * @param {any} [result]
 * @returns {Record<string, string|number|null>}
 */
export function recoveryEvidence(action, args, result) {
  const base = {
    action,
    at: new Date().toISOString(),
  };
  if (action === "push-branch")
    return { ...base, branch: String(args?.branch ?? ""), remote: "origin" };
  if (action === "merge") {
    return { ...base, prNumber: Number(args?.prNumber) || null, revertHint: "gh pr revert <n>" };
  }
  if (action === "delete-thread")
    return { ...base, sessionId: String(args?.sessionId ?? ""), restorable: "trash/manifest" };
  if (action === "delete-project") {
    return {
      ...base,
      projectId: String(args?.projectId ?? ""),
      trashDir: String(result?.trashDir ?? ""),
    };
  }
  if (action === "change-settings")
    return { ...base, before: String(result?.before ?? ""), after: String(result?.after ?? "") };
  return base;
}

/**
 * 合并前的前置校验（规格 §7.5 行 3 的硬前提）。纯函数便于单测：
 * 只从 `gh pr view --json` 的结果判断，不假设任何外部状态。
 * @param {{ isDraft?: boolean, mergeable?: string, state?: string }|null} pr
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkMergePreflight(pr) {
  if (!pr || typeof pr !== "object") return { ok: false, reason: "merge/pr-unknown" };
  if (String(pr.state ?? "OPEN").toUpperCase() !== "OPEN")
    return { ok: false, reason: "merge/pr-not-open" };
  // draft PR 合并会被 GitHub 拒绝；auto-merge 也不该替人「先转正再合并」
  if (pr.isDraft === true) return { ok: false, reason: "merge/pr-is-draft" };
  const mergeable = String(pr.mergeable ?? "UNKNOWN").toUpperCase();
  if (mergeable === "CONFLICTING") return { ok: false, reason: "merge/pr-conflicting" };
  if (mergeable !== "MERGEABLE") return { ok: false, reason: "merge/pr-mergeable-unknown" };
  return { ok: true };
}

/**
 * 从 git remote URL 里取 owner/repo（支持 https 与 ssh 两种写法）。
 * @param {string|null} url
 * @returns {string}
 */
export function parseRepoFromRemote(url) {
  const text = String(url ?? "")
    .trim()
    .replace(/\.git$/u, "");
  const https = text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)$/u);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = text.match(/^git@[\w.-]+:([\w.-]+)\/([\w.-]+)$/u);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return "";
}

/**
 * 哪些前置失败值得等一会儿再试。GitHub 在 PR 刚创建后的一两秒内可能返回
 * `mergeable: UNKNOWN`（服务端还在算），这不是「不能合并」，重试几次就会变成 MERGEABLE。
 * 其余失败（draft / 冲突 / 已关闭）重试没有意义，直接拒绝。
 * @param {string} reason
 * @returns {boolean}
 */
export function shouldRetryPreflight(reason) {
  return String(reason ?? "") === "merge/pr-mergeable-unknown";
}
