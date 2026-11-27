// @ts-check
// auto PR：档位决策与幂等。纯函数、零 I/O。
// 依据 m4-design.md §2：四档默认关；同一线程只开一次 PR；失败降级不重试到天荒地老。

/** 四档（默认 off）。 */
export const PR_TIERS = Object.freeze(["off", "draft", "ready", "auto-merge"]);

/** 失败最多重试次数（超过就停在人手里）。 */
export const MAX_PR_ATTEMPTS = 2;

/**
 * 线程进入 done 之后，下一步对 PR 做什么。
 * @param {object} input
 * @param {string} [input.tier]
 * @param {{ branch?: string|null, prNumber?: number|null, commits?: number, attempts?: number, ciState?: string }} input.thread
 * @returns {{ action: "none"|"open-draft"|"open-ready"|"update"|"merge"|"wait-ci"|"give-up", reason: string }}
 */
export function nextPrAction(input) {
  const tier = PR_TIERS.includes(String(input?.tier ?? "")) ? String(input.tier) : "off";
  const thread = input?.thread ?? {};
  const branch = typeof thread.branch === "string" ? thread.branch : "";
  const attempts = Number.isFinite(thread.attempts) ? Number(thread.attempts) : 0;
  const hasPr = Number.isInteger(thread.prNumber) && Number(thread.prNumber) > 0;

  if (tier === "off") return { action: "none", reason: "tier-off" };
  if (branch === "") return { action: "none", reason: "no-branch" };
  if (!/^dsh\//u.test(branch)) return { action: "none", reason: "branch-not-ours" };
  if (attempts >= MAX_PR_ATTEMPTS) return { action: "give-up", reason: "too-many-attempts" };

  const commits = Number.isFinite(thread.commits) ? Number(thread.commits) : 0;
  if (!hasPr && commits <= 0) return { action: "none", reason: "no-commits" };

  if (tier === "auto-merge") {
    if (!hasPr) return { action: "open-ready", reason: "auto-merge-first-open" };
    const ci = String(thread.ciState ?? "");
    if (ci === "passing") return { action: "merge", reason: "ci-passing" };
    if (ci === "failing") return { action: "give-up", reason: "ci-failing" };
    return { action: "wait-ci", reason: "ci-pending" };
  }

  if (hasPr) return { action: "update", reason: "pr-exists" };
  if (tier === "draft") return { action: "open-draft", reason: "tier-draft" };
  return { action: "open-ready", reason: "tier-ready" };
}

/**
 * 生成 PR 标题与正文骨架（正文里必须写明"这是自动开的"，以及恢复方式）。
 * @param {{ projectName?: string, task?: string, sessionId?: string, branch?: string }} input
 * @returns {{ title: string, body: string }}
 */
export function buildPrText(input) {
  const task = String(input?.task ?? "").trim() || "project thread";
  const firstLine = task.split("\n")[0].slice(0, 80);
  const projectName = String(input?.projectName ?? "").trim() || "project";
  const sessionId = String(input?.sessionId ?? "");
  const body = [
    `Automated by the **projects** plugin (project: ${projectName}).`,
    "",
    "**Task**",
    task.length > 800 ? `${task.slice(0, 800)}\n…(truncated)` : task,
    "",
    "**How to undo**",
    "- Close this PR without merging; the branch and worktree are kept until you archive the thread.",
    "- Nothing is merged automatically unless the project's `auto-merge` tier and the `merge` danger switch are both on.",
    "",
    `<sub>thread: ${sessionId}</sub>`,
  ].join("\n");
  return { title: `dsh: ${firstLine}`, body };
}

/**
 * 生成 `gh pr create` 的 argv（不做 shell 插值）。
 * @param {{ title: string, body: string, base?: string, draft?: boolean, branch: string, repo?: string }} input
 * @returns {{ argv: string[] } | { error: string }}
 */
export function planPrCreate(input) {
  const title = String(input?.title ?? "").trim();
  const body = String(input?.body ?? "").trim();
  const branch = String(input?.branch ?? "").trim();
  if (title === "") return { error: "title-required" };
  if (body === "") return { error: "body-required" };
  if (!/^dsh\/[A-Za-z0-9._/-]+$/u.test(branch)) return { error: "branch-not-ours" };

  const argv = ["pr", "create", "--head", branch, "--title", title, "--body", body];
  if (typeof input?.base === "string" && input.base !== "") argv.push("--base", input.base);
  if (typeof input?.repo === "string" && input.repo !== "") argv.push("--repo", input.repo);
  if (input?.draft === true) argv.push("--draft");
  return { argv };
}

/**
 * 从 `gh pr create` 的输出里取出 PR 号（输出形如 https://github.com/o/r/pull/123）。
 * @param {string} stdout
 * @returns {number|null}
 */
export function parsePrNumber(stdout) {
  const match = String(stdout ?? "").match(/\/pull\/(\d+)/u);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 兜底 push 计划：宿主进程拿不到 ssh/keychain 凭据时，用 gh 的 credential helper 走 https。
 * 只做参数组装（纯函数），是否执行、失败如何记录由调用方决定。
 * @param {{ url?: string, branch?: string }} input
 * @returns {{ argv: string[] } | { error: string }}
 */
export function planHttpsPush(input) {
  const url = String(input?.url ?? "").trim();
  const branch = String(input?.branch ?? "").trim();
  if (!/^https:\/\/[^\s]+$/u.test(url)) return { error: "url-not-https" };
  if (branch === "") return { error: "branch-required" };
  return {
    argv: [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "-u",
      url,
      branch,
    ],
  };
}

/**
 * 「能不能合并这个 PR」的判定（纯函数）：**默认拒绝**，必须同时满足
 * ① 有 PR 号 ② 用户二次确认 ③ 项目危险开关 autoMerge 打开。
 * 合并是不可逆动作，任何一环缺失都如实给出原因（不假装成功）。
 * @param {{ prNumber?: number, confirmed?: boolean, dangerAutoMerge?: boolean }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canMergePr(input) {
  const prNumber = Number(input?.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, reason: "no-pr" };
  if (input?.confirmed !== true) return { ok: false, reason: "need-confirm" };
  if (input?.dangerAutoMerge !== true) return { ok: false, reason: "danger-off" };
  return { ok: true };
}

/**
 * 合并前的步骤计划（纯函数）：草稿 PR 不能直接 merge（GitHub 会拒），先 `pr ready`。
 * @param {{ prNumber?: number, isDraft?: boolean }} input
 * @returns {{ error: string } | { steps: string[][] }}
 */
export function planMergeSteps(input) {
  const prNumber = Number(input?.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { error: "no-pr" };
  const merge = ["pr", "merge", String(prNumber), "--squash", "--delete-branch"];
  if (input?.isDraft === true) {
    return { steps: [["pr", "ready", String(prNumber)], merge] };
  }
  return { steps: [merge] };
}

/**
 * 选 PR 相关命令的工作目录（纯函数）。
 *
 * 以前 `prOverview`/`mergePr` 一律用 `project.dirs[0]`：多目录项目里第 0 个目录
 * 可能不是线程所在仓库，`gh pr view <n>` 会去**另一个仓库**查同号 PR（不可逆操作尤其危险）。
 * 线程有 worktree 就优先用它，其次项目目录。
 * @param {{ worktree?: string|null, dir?: string|null, dirs?: string[] }} input
 * @returns {string}
 */
export function pickRepoRoot(input) {
  const worktree = String(input?.worktree ?? "").trim();
  if (worktree !== "") return worktree;
  // 线程记录里的 `dir` 是**创建时**实际所在的仓库（多目录项目里可能不是 dirs[0]）。
  // worktree 被回收/归档后只剩它，以前直接回落 dirs[0] → 合并/查 PR 会跑到错仓库（复审 P1）。
  const threadDir = String(input?.dir ?? "").trim();
  if (threadDir !== "") return threadDir;
  const dirs = Array.isArray(input?.dirs) ? input.dirs : [];
  for (const dir of dirs) {
    const value = String(dir ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}
