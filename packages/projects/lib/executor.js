// @ts-check
// 危险动作执行器：闸门与命令计划。纯函数、零 I/O。
// 依据 m4-design.md §0/§1 与 spec §7.5：
//   批准 ≠ 可执行。批准只是「人同意了这一次」，还要开关打开、影响面在阈值内。
//   三种授权来源之外一律拒绝；模型输出/外部内容/peer 消息永远不算授权。

import { planForcePush } from "./git-push.js";
import { sanitizeSettingsPatch } from "./settings.js";

/** 可执行的危险动作（与 tools.js 的 REQUESTABLE_ACTIONS 同集合，但语义不同：
 *  这里问的是「能不能执行」，那边问的是「能不能申请」。 */
export const DANGER_ACTIONS = Object.freeze([
  "push-branch",
  "push-protected-branch",
  "purge-trash",
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
    case "push-protected-branch":
      return "pushProtectedBranch";
    case "purge-trash":
      return "purgeAfterRetention";
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
 * @param {{ diffFiles?: number, diffLines?: number, baseBranch?: string|null }} [input.impact]
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

  // AUD-PROJ-13：以前这里还有一道 `delete-thread` 的 `impact.worktreeClean === false` 闸，
  // 但 `impact` 来自**模型可控**的 `approval.args.impact`：不填就通过，填 false 才拒绝——
  // 等于一道由被审对象自己把关的死闸（同文件注释还写着「不信任模型可控的 args.impact」）。
  // 真正的保护在 `reclaimThread`（`thread.js` 里自己跑 git status，三重判据不满足就不删）。
  // 这里删掉假闸，避免有人误以为它有用。
  return { ok: true, reason: "" };
}

/**
 * 直推保护分支时的分支名校验（纵深防御：coordinator 提供的 args 是模型可控的）。
 * 允许普通分支名（含 `dsh/...` 与 `main`），拒绝会被 git 当成选项/refspec 的形态：
 * 前导 `-`、`:`（`src:dst` refspec）、`..`、`*`、`?`、`[`、`@{`、反斜杠、空白。
 * @param {unknown} value
 * @returns {{ ok: true, branch: string } | { ok: false, reason: string }}
 */
export function checkSafePushRef(value) {
  const branch = typeof value === "string" ? value.trim() : "";
  if (branch === "") return { ok: false, reason: "branch-required" };
  if (branch.length > 255) return { ok: false, reason: "branch-too-long" };
  if (/^[-\s]/u.test(branch)) return { ok: false, reason: "branch-leading-dash" };
  if (/[\s:\\*?[\]~^]/u.test(branch)) return { ok: false, reason: "branch-illegal-char" };
  if (branch.includes("..") || branch.includes("@{")) {
    return { ok: false, reason: "branch-illegal-range" };
  }
  if (branch.startsWith("refs/") && !branch.startsWith("refs/heads/")) {
    return { ok: false, reason: "branch-not-head-ref" };
  }
  return { ok: true, branch };
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

  if (action === "push-branch" && args?.force === true) {
    // 强推：走 git-push 的 --force-with-lease（绑定期望 SHA），不接受裸 --force
    return planForcePush({
      branch: String(args?.branch ?? ""),
      expectedSha: String(args?.expectedSha ?? ""),
    });
  }

  if (action === "push-branch") {
    const branch = String(args?.branch ?? "").trim();
    if (!nonEmpty(branch)) return { error: "branch-required" };
    // 只推自己建的分支，且名字必须落在我们的字符集内（纵深防御：argv 虽无注入，
    // 但分支名会被写进审计、URL 与 PR 描述，宽白名单没有好处）
    if (!/^dsh\/[A-Za-z0-9._/-]+$/u.test(branch)) return { error: "branch-not-ours" };
    return { argv: ["git", "push", "-u", "origin", branch] };
  }

  if (action === "push-protected-branch") {
    // 直推保护/默认分支：不带 -u（可能不是我们的分支），也**绝不**带 --force。
    // 分支名必须过 refname 校验：模型可以在 args 里塞 `--force` 或 `src:dst` refspec。
    const checked = checkSafePushRef(args?.branch);
    if (!checked.ok) return { error: checked.reason };
    return { argv: ["git", "push", "origin", checked.branch] };
  }

  if (action === "change-settings") {
    // 只为「改本插件自己的配置」：白名单在 settings.js 里，越界直接拒
    const checked = sanitizeSettingsPatch(args?.patch);
    if (!checked.ok) return { error: checked.reason };
    return { argv: ["update-settings", checked.keys.join(",")] };
  }

  if (action === "purge-trash") {
    // 真正的删除由 service 用 fs 做；这里只表达「这是内部动作」
    return { argv: ["purge-trash", String(args?.confirm ?? "")] };
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

/** CI 通过的结论集（GitHub CheckRun conclusion 与 StatusContext state 都覆盖）。 */
const CI_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** CI 明确失败的结论集。 */
const CI_FAIL = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STALE",
  "STARTUP_FAILURE",
]);

/**
 * 规格 §7.5 行 3 的 ①：CI 必须绿。
 * 空列表按「未配置检查」处理并**拒绝**——不猜、不放行（2026-11-21 定的口径）。
 * @param {any[]|null|undefined} rollup `gh pr view --json statusCheckRollup` 的结果
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkCiGreen(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  if (list.length === 0) return { ok: false, reason: "merge/ci-unknown" };
  for (const item of list) {
    const verdict = String(item?.conclusion ?? item?.state ?? "").toUpperCase();
    if (verdict === "") return { ok: false, reason: "merge/ci-unknown" }; // 还在跑（无结论）
    if (CI_FAIL.has(verdict)) return { ok: false, reason: "merge/ci-not-green" };
    if (!CI_PASS.has(verdict)) return { ok: false, reason: "merge/ci-pending" }; // PENDING 等
  }
  return { ok: true };
}

/**
 * 规格 §7.5 行 3 的 ④：人工批准数。按**不同作者**去重，只看 APPROVED。
 * @param {any[]|null|undefined} reviews `gh pr view --json reviews`
 * @returns {number}
 */
export function countApprovedReviews(reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  /** @type {Set<string>} */
  const authors = new Set();
  for (const review of list) {
    if (String(review?.state ?? "").toUpperCase() !== "APPROVED") continue;
    const who = String(review?.author?.login ?? review?.user?.login ?? "").trim();
    if (who !== "") authors.add(who);
  }
  return authors.size;
}

/**
 * 规格 §7.5 行 3 的 ⑥：只用仓库允许的合并方式。
 * 我们固定用 squash；仓库不允许就拒绝，**不改用** merge/rebase。
 * @param {string[]|null|undefined} allowed `gh api repos/{owner}/{repo}` 的 allowed_merge_methods
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkMergeMethod(allowed) {
  const list = Array.isArray(allowed) ? allowed.map((item) => String(item)) : [];
  if (list.length === 0) return { ok: false, reason: "merge/method-unknown" };
  if (!list.includes("squash")) return { ok: false, reason: "merge/method-not-allowed" };
  return { ok: true };
}

/**
 * 把一条 PR 的「可合并性」一次判完：draft / 冲突 / 状态 / CI / 批准数 / 合并方式。
 * @param {{ pr?: any, reviews?: any[], allowedMethods?: string[], minApprovals?: number }} input
 * @returns {{ ok: boolean, reason?: string, approvals?: number }}
 */
export function checkMergeReadiness(input) {
  const preflight = checkMergePreflight(input?.pr ?? null);
  if (!preflight.ok) return preflight;

  const ci = checkCiGreen(input?.pr?.statusCheckRollup);
  if (!ci.ok) return ci;

  const minApprovals = Number.isFinite(input?.minApprovals) ? Number(input?.minApprovals) : 1;
  const approvals = countApprovedReviews(input?.reviews ?? input?.pr?.reviews);
  if (minApprovals > 0 && approvals < minApprovals) {
    return { ok: false, reason: "merge/not-approved", approvals };
  }

  const method = checkMergeMethod(input?.allowedMethods);
  if (!method.ok) return method;

  return { ok: true, approvals };
}

/**
 * 「这个 PR 现在能不能合并」的统一判定：把 `checkMergeReadiness` 与项目策略里的
 * 改动量阈值（`policy.merge.maxDiffFiles / maxDiffLines`）合成一次判完。
 *
 * 为什么需要它：UI 的合并按钮（RPC `mergePr`）以前只查危险开关就 `gh pr merge`，
 * 而设置页文案承诺「仍然要求改动量在阈值内、CI 通过、人工批准数达标」——两套答案。
 * @param {{
 *   pr?: any,
 *   allowedMethods?: string[]|null,
 *   minApprovals?: number,
 *   maxDiffFiles?: number,
 *   maxDiffLines?: number,
 * }} input
 * @returns {{ ok: boolean, reason?: string, approvals?: number, changedFiles?: number, lines?: number, maxDiffFiles?: number, maxDiffLines?: number }}
 */
export function assessMergePr(input) {
  const readiness = checkMergeReadiness({
    pr: input?.pr,
    reviews: input?.pr?.reviews ?? [],
    allowedMethods: Array.isArray(input?.allowedMethods) ? input.allowedMethods : undefined,
    minApprovals: input?.minApprovals,
  });
  if (!readiness.ok) return readiness;
  const changedFiles = Number(input?.pr?.changedFiles ?? 0);
  const lines = Number(input?.pr?.additions ?? 0) + Number(input?.pr?.deletions ?? 0);
  const maxDiffFiles = Number.isFinite(input?.maxDiffFiles) ? Number(input.maxDiffFiles) : 20;
  const maxDiffLines = Number.isFinite(input?.maxDiffLines) ? Number(input.maxDiffLines) : 600;
  if (Number.isFinite(changedFiles) && changedFiles > maxDiffFiles) {
    return { ok: false, reason: "merge/diff-files", changedFiles, maxDiffFiles };
  }
  if (Number.isFinite(lines) && lines > maxDiffLines) {
    return { ok: false, reason: "merge/diff-lines", lines, maxDiffLines };
  }
  return { ok: true, approvals: readiness.approvals, changedFiles, lines };
}

/**
 * 授权来源是 `policy-grant` 的动作（规格 §7.5 表）。
 * 只有这些动作**可能**被 `policy.preapprove` 预授权放行——
 * `merge`（approval-event）与 `push-protected-branch`（per-incident）永远不行。
 */
export const POLICY_GRANT_ACTIONS = Object.freeze([
  "push-branch",
  "delete-thread",
  "delete-project",
  "purge-trash",
  "change-settings",
]);

/**
 * 预授权判定（规格 §7.7.2）。三条全满足才算命中：列在 preapprove 里、
 * 动作的授权来源是 policy-grant、对应危险开关已打开。
 * @param {{ action?: string, preapprove?: string[], danger?: any }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkPreapproval(input) {
  const action = String(input?.action ?? "");
  if (action === "") return { ok: false, reason: "preapprove/action-required" };
  if (!POLICY_GRANT_ACTIONS.includes(action)) {
    return { ok: false, reason: "preapprove/source-not-policy-grant" };
  }
  const list = Array.isArray(input?.preapprove) ? input.preapprove.map((item) => String(item)) : [];
  if (!list.includes(action)) return { ok: false, reason: "preapprove/not-listed" };
  const switchKey = switchForAction(action);
  if (switchKey === "" || input?.danger?.[switchKey] !== true) {
    return { ok: false, reason: "preapprove/switch-off" };
  }
  return { ok: true };
}

/**
 * 从 REST `GET /repos/{owner}/{repo}` 的响应推导"允许的合并方式"。
 *
 * REST 返回的是三个布尔（allow_squash_merge / allow_merge_commit / allow_rebase_merge），
 * **没有** allowed_merge_methods 这个字段——真实仓库验证时踩到：之前一直读后者，
 * 于是永远拿到空数组，真实仓库上的合并永远被拒（`merge/method-unknown`）。
 * 某些替身/GraphQL 形态确实给 allowed_merge_methods，所以两者都认。
 * @param {any} repoJson
 * @returns {string[]}
 */
export function allowedMergeMethodsFromRepo(repoJson) {
  if (repoJson === null || typeof repoJson !== "object") return [];
  if (Array.isArray(repoJson.allowed_merge_methods)) return [...repoJson.allowed_merge_methods];
  /** @type {string[]} */
  const derived = [];
  if (repoJson.allow_squash_merge === true) derived.push("squash");
  if (repoJson.allow_merge_commit === true) derived.push("merge");
  if (repoJson.allow_rebase_merge === true) derived.push("rebase");
  return derived;
}
