// @ts-check
// F4：GitHub 连接检查。宿主没有 GitHub App 授权面，所以「连接检查」只能做**只读**的
// `gh auth status` / `gh repo list`，并把失败翻译成可操作的一句话（装什么、跑什么命令）。
// 纯函数在这里，子进程在 service 里跑——这样解析逻辑能单测，也不用 mock 网络。

/** 没有 gh CLI 时的提示（ENOENT 会落到这条）。 */
export const GH_MISSING_HINT =
  "未找到 gh CLI：安装 GitHub CLI（https://cli.github.com）后运行 gh auth login";

/** 有 gh 但没登录时的提示。 */
export const GH_LOGIN_HINT = "gh 已安装但未登录：运行 gh auth login 完成一次浏览器授权";

/** 登录了但 scope 不够时的提示。 */
export const GH_SCOPE_HINT = "当前 token 缺少 repo scope：运行 gh auth refresh -s repo,read:org";

/**
 * 解析 `gh auth status` 的输出（成功与失败都解析：失败时 gh 把信息写到 stderr）。
 * @param {{ stdout?: string, stderr?: string, code?: number }} input
 * @returns {{ installed: boolean, authenticated: boolean, account: string, scopes: string[], missingRepoScope: boolean, hint: string }}
 */
export function parseGhAuthStatus(input) {
  const stdout = String(input?.stdout ?? "");
  const stderr = String(input?.stderr ?? "");
  const output = `${stdout}\n${stderr}`;
  const missing = input?.code === 127 || /command not found|ENOENT|not found/iu.test(stderr);
  if (missing && !/Logged in to/iu.test(output)) {
    return {
      installed: false,
      authenticated: false,
      account: "",
      scopes: [],
      missingRepoScope: true,
      hint: GH_MISSING_HINT,
    };
  }
  const accountMatch = output.match(/Logged in to \S+ account (?<account>[\w.-]+)/iu);
  const account = String(accountMatch?.groups?.account ?? "").trim();
  const scopeMatch = output.match(/Token scopes:\s*(?<scopes>[^\n]+)/iu);
  const scopes = scopeMatch?.groups?.scopes
    ? scopeMatch.groups.scopes
        .split(",")
        .map((item) => item.trim().replace(/^'|'$/gu, ""))
        .filter((item) => item !== "" && item !== "undefined")
    : [];
  const authenticated = account !== "" || /Logged in to/iu.test(output);
  const missingRepoScope = authenticated && scopes.length > 0 && !scopes.includes("repo");
  return {
    installed: !missing || authenticated,
    authenticated,
    account,
    scopes,
    missingRepoScope,
    hint: !authenticated ? GH_LOGIN_HINT : missingRepoScope ? GH_SCOPE_HINT : "",
  };
}

/**
 * 解析 `gh repo list --limit N` 的纯文本输出（每行第一列是 owner/repo）。
 * @param {{ stdout?: string, code?: number }} input
 * @returns {{ count: number, repos: string[], hint: string }}
 */
export function parseGhRepoList(input) {
  const lines = String(input?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  /** @type {string[]} */
  const repos = [];
  for (const line of lines) {
    const first = line.split(/\s+/u)[0] ?? "";
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(first) && !repos.includes(first)) {
      repos.push(first);
    }
  }
  if (input?.code === 127) return { count: 0, repos: [], hint: GH_MISSING_HINT };
  if (repos.length === 0 && input?.code !== 0) {
    return { count: 0, repos: [], hint: GH_LOGIN_HINT };
  }
  return { count: repos.length, repos, hint: "" };
}

/**
 * 把两段结果合成 RPC 回执：`level` 决定 UI 用哪种颜色，`actions` 是能直接点的命令。
 * @param {ReturnType<typeof parseGhAuthStatus>} auth
 * @param {{ count: number, repos: string[], hint: string }} [repos]
 * @returns {{ level: "ok"|"warn"|"error", ok: boolean, account: string, repoCount: number, message: string, actions: string[], hint: string }}
 */
export function githubCheckResult(auth, repos) {
  const repoCount = Number(repos?.count ?? 0) || 0;
  if (auth.installed !== true) {
    return {
      level: "error",
      ok: false,
      account: "",
      repoCount,
      message: "没有可用的 GitHub 连接",
      actions: ["安装 GitHub CLI", "gh auth login"],
      hint: GH_MISSING_HINT,
    };
  }
  if (auth.authenticated !== true) {
    return {
      level: "error",
      ok: false,
      account: "",
      repoCount,
      message: "gh 已安装，但没有登录",
      actions: ["gh auth login"],
      hint: GH_LOGIN_HINT,
    };
  }
  if (auth.missingRepoScope === true) {
    return {
      level: "warn",
      ok: true,
      account: auth.account,
      repoCount,
      message: `已连接 ${auth.account || "GitHub"}，但 token 缺 repo scope`,
      actions: ["gh auth refresh -s repo,read:org"],
      hint: GH_SCOPE_HINT,
    };
  }
  return {
    level: "ok",
    ok: true,
    account: auth.account,
    repoCount,
    message:
      repoCount > 0
        ? `已连接 ${auth.account || "GitHub"} · 可访问 ${repoCount} 个仓库`
        : `已连接 ${auth.account || "GitHub"}`,
    actions: [],
    hint: repos?.hint ?? "",
  };
}
