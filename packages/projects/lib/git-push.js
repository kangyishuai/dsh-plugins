// @ts-check
// 推送类危险动作的纯逻辑：命令形状 + 硬前提判定（规格 §7.5 行 1 / 行 2）。
// 不碰 I/O：gh/git 的查询结果由调用方拿到后传进来，便于单测。

/** 插件自建分支的前缀（与 worktree.js 的 BRANCH_PREFIX 保持一致）。 */
export const OWN_BRANCH_PREFIX = "dsh/";

/**
 * 强推自己分支的命令：**必须**用 `--force-with-lease` 并绑定期望的旧 SHA。
 * 裸 `--force` 会覆盖别人在这期间推上去的提交，规格明确不提供那种能力。
 * @param {{ branch: string, expectedSha: string }} input
 * @returns {{ argv: string[] } | { error: string }}
 */
export function planForcePush(input) {
  const branch = String(input?.branch ?? "").trim();
  const expectedSha = String(input?.expectedSha ?? "").trim();
  if (!new RegExp(`^${OWN_BRANCH_PREFIX}[A-Za-z0-9._/-]+$`, "u").test(branch)) {
    return { error: "force-push/branch-not-ours" };
  }
  if (!/^[0-9a-f]{7,40}$/u.test(expectedSha)) return { error: "force-push/sha-required" };
  return {
    argv: ["git", "push", `--force-with-lease=${branch}:${expectedSha}`, "origin", branch],
  };
}

/**
 * 强推的硬前提（四条全部满足才放行）：
 * ① 分支由插件创建并有记录（thread.branch === branch 且带 dsh/ 前缀）
 * ② 无他人提交 —— 用「远端 HEAD 是否还等于我们上次推上去的 SHA」判定：
 *    不相等说明期间有别的提交（人或别的工具）上去了，强推会覆盖它
 * ③ 非默认 / 非保护分支
 * ④ 期望旧 SHA 已知（用于 --force-with-lease 与审计）
 * @param {{ branch?: string|null, threadBranch?: string|null, expectedSha?: string, remoteHeadSha?: string, lastPushedSha?: string|null, protectedBranch?: boolean }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkForcePushPrereqs(input) {
  const branch = String(input?.branch ?? "").trim();
  const threadBranch = String(input?.threadBranch ?? "").trim();
  if (threadBranch === "" || threadBranch !== branch) {
    return { ok: false, reason: "force-push/branch-not-recorded" };
  }
  if (!branch.startsWith(OWN_BRANCH_PREFIX)) {
    return { ok: false, reason: "force-push/branch-not-ours" };
  }
  if (input?.protectedBranch === true) return { ok: false, reason: "force-push/branch-protected" };
  const expectedSha = String(input?.expectedSha ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/u.test(expectedSha)) {
    return { ok: false, reason: "force-push/sha-required" };
  }
  // ② 无他人提交：远端 HEAD 必须仍是我们记录过的那个 SHA
  const lastPushed = String(input?.lastPushedSha ?? "").trim();
  const remoteHead = String(input?.remoteHeadSha ?? "").trim();
  if (lastPushed !== "" && remoteHead !== "" && !remoteHead.startsWith(lastPushed.slice(0, 7))) {
    return { ok: false, reason: "force-push/remote-moved" };
  }
  return { ok: true };
}

/**
 * 直推保护/默认分支的硬前提（规格 §7.5 行 2 ①）：服务端必须允许直接推。
 * GitHub 的保护配置里 `required_pull_request_reviews` 存在 = 必须走 PR，直接推会被拒；
 * rulesets 里针对该分支的 `pull_request` 规则同理。
 * @param {{ protection?: any, rulesets?: any[], branch?: string }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkProtectedPushPrereqs(input) {
  const protection = input?.protection;
  if (protection && typeof protection === "object") {
    if (protection.required_pull_request_reviews) {
      return { ok: false, reason: "protected-push/requires-pull-request" };
    }
    if (protection.lock_branch?.enabled === true) {
      return { ok: false, reason: "protected-push/branch-locked" };
    }
  }
  const rulesets = Array.isArray(input?.rulesets) ? input.rulesets : [];
  for (const ruleset of rulesets) {
    if (ruleset?.target !== "branch") continue;
    const conditions = ruleset?.conditions?.ref_name;
    const includes = Array.isArray(conditions?.include) ? conditions.include : [];
    const targetsDefault =
      includes.includes("~DEFAULT_BRANCH") ||
      includes.some((/** @type {string} */ pattern) => pattern === "~ALL");
    if (!targetsDefault) continue;
    if (ruleset?.enforcement !== "active") continue;
    const types = (Array.isArray(ruleset?.rules) ? ruleset.rules : []).map(
      (/** @type {any} */ rule) => String(rule?.type ?? ""),
    );
    if (types.includes("pull_request")) {
      return { ok: false, reason: "protected-push/ruleset-requires-pull-request" };
    }
  }
  return { ok: true };
}

/**
 * 多人协作判定：最近提交里出现多个不同作者就认为「有别人在这个仓库干活」。
 * 规格 §7.5 行 2 ③ 要求在检测到多人协作时强警告（不禁止，但要让人看见）。
 * @param {any[]|null} commits `gh api repos/{owner}/{repo}/commits` 的结果
 * @returns {{ collaborators: number, multi: boolean, sample: string[] }}
 */
export function countCollaborators(commits) {
  const list = Array.isArray(commits) ? commits : [];
  /** @type {Set<string>} */
  const authors = new Set();
  for (const commit of list) {
    const login = String(commit?.author?.login ?? "").trim();
    const name = String(commit?.commit?.author?.name ?? "").trim();
    const key = login !== "" ? login : name;
    if (key !== "") authors.add(key);
  }
  const sample = [...authors].slice(0, 5);
  return { collaborators: authors.size, multi: authors.size > 1, sample };
}
