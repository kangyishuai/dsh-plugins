#!/usr/bin/env node
// @ts-check
// automerge 标签的白名单校验：CONTRIBUTING §自动合并分级 / ADR 0014 的机检实现。
//
// 设计：判定逻辑是纯函数（`evaluate`），单测覆盖；gh CLI 调用只在 CLI 入口里。
// workflow 见 .github/workflows/automerge-guard.yml —— 它只在 PR 带 `automerge` 标签时做事：
//   - 合规：什么都不改（武装 auto-merge 由人或 agent 用 `gh pr merge --auto` 做，
//     故意不由 workflow 代劳：用 GITHUB_TOKEN 武装的合并不会触发 push 工作流，会吞掉 Release）
//   - 不合规：摘标签 + 关掉已武装的 auto-merge + upsert 一条说明评论，并以非零退出码标红。
//
// CLI：node scripts/automerge-guard.mjs --repo <owner/name> --pr <number>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** 说明评论的幂等标记（同一 PR 只维护一条）。 */
export const COMMENT_MARKER = "<!-- automerge-guard -->";

/** 永远不允许自动合并的标签。 */
const BLOCKING_LABELS = ["needs-dsh-verify"];

/**
 * 硬黑名单：即使标题落在 A/B 档、路径白名单也会放行，这些目录仍然只能人工合并
 * （门禁自身 / 类型声明 / 决策记录）。release 档例外——版本清单本来就在这些文件里。
 */
const BLOCKED_PATHS = [/^\.github\//u, /^scripts\//u, /^types\//u, /^docs\/adr\//u];

/** @typedef {{ kind: "release" | "docs" | "code", tier: string }} Tier */

/**
 * 标题 → 档位。返回 null 表示不在 A/B 档（C 档：一律人工合并）。
 * @param {string} title
 * @param {string} headRef
 * @returns {Tier | null}
 */
export function tierOf(title, headRef) {
  if (title === "chore(release): version packages") {
    return headRef === "changeset-release/main" ? { kind: "release", tier: "A" } : null;
  }
  if (/^(docs:|test:|chore\(repo\):)/u.test(title)) return { kind: "docs", tier: "B · 文档" };
  const scoped = title.match(/^(fix|test)\(([^)]+)\):/u);
  if (scoped !== null && scoped[2] !== "") return { kind: "code", tier: "B · 单插件" };
  return null;
}

/**
 * 单个文件是否在档位的白名单内。
 * @param {Tier} tier
 * @param {string} file
 * @param {string} scope 单插件档位的插件名
 * @returns {boolean}
 */
export function fileAllowed(tier, file, scope) {
  switch (tier.kind) {
    case "release":
      return (
        /(^|\/)(CHANGELOG\.md|package\.json)$/u.test(file) ||
        file.startsWith(".changeset/") ||
        file === "pnpm-lock.yaml"
      );
    case "docs":
      return file.startsWith("docs/") || file.endsWith(".md") || file.startsWith(".changeset/");
    case "code":
      return file.startsWith(`packages/${scope}/`) || file.startsWith(".changeset/");
    default:
      return false;
  }
}

/**
 * 判定一个 PR 是否满足自动合并的分级条件。
 * @param {{
 *   repo: string,
 *   title: string,
 *   headRef: string,
 *   headRepo: string,
 *   labels: readonly string[],
 *   changesRequested: number,
 *   files: readonly string[],
 * }} pull
 * @returns {{ ok: boolean, tier: string | null, reason: string, offending: string[] }}
 */
export function evaluate(pull) {
  const fail = (/** @type {string} */ reason, /** @type {string[]} */ offending = []) => ({
    ok: false,
    tier: null,
    reason,
    offending,
  });

  if (pull.headRepo !== "" && pull.headRepo !== pull.repo) {
    return fail(`来自 fork 的 PR（${pull.headRepo}）不参与自动合并`);
  }
  for (const label of BLOCKING_LABELS) {
    if (pull.labels.includes(label)) return fail(`带 \`${label}\` 标签：需要人工核对真机行为`);
  }
  if (pull.changesRequested > 0) return fail("有未处理的 REQUEST_CHANGES 评审");

  const tier = tierOf(pull.title, pull.headRef);
  if (tier === null) {
    return fail(
      "标题不在 A/B 档：只有 `chore(release): version packages`、`docs:` / `test:` / `chore(repo):`、" +
        "`fix(<plugin>):` / `test(<plugin>):` 可以自动合并（C 档见 CONTRIBUTING §自动合并分级）",
    );
  }

  if (tier.kind !== "release") {
    const blocked = pull.files.filter((file) =>
      BLOCKED_PATHS.some((pattern) => pattern.test(file)),
    );
    if (blocked.length > 0) {
      return fail(`${tier.tier} 档里出现只能人工合并的路径（门禁自身 / 类型 / ADR）`, blocked);
    }
  }

  const scope =
    tier.kind === "code" ? (pull.title.match(/^(?:fix|test)\(([^)]+)\):/u)?.[1] ?? "") : "";
  const offending = pull.files.filter((file) => !fileAllowed(tier, file, scope));
  if (offending.length > 0) {
    return fail(`${tier.tier} 档的改动面越界：${offending.length} 个文件不在白名单里`, offending);
  }
  return { ok: true, tier: tier.tier, reason: "", offending: [] };
}

/**
 * gh 输出按行切分。
 * @param {string} args
 */
function gh(args) {
  return execFileSync("gh", args.split(" ").filter(Boolean), { encoding: "utf8" }).trim();
}

/** @param {string} repo @param {number} pr */
function readPull(repo, pr) {
  const raw = JSON.parse(gh(`api repos/${repo}/pulls/${pr}`));
  const files = gh(`api --paginate repos/${repo}/pulls/${pr}/files?per_page=100 --jq .[].filename`)
    .split("\n")
    .filter(Boolean);
  const changesRequested = Number(
    gh(
      `api --paginate repos/${repo}/pulls/${pr}/reviews?per_page=100 --jq [.[]|select(.state=="CHANGES_REQUESTED")]|length`,
    ),
  );
  return {
    repo,
    title: String(raw.title ?? ""),
    headRef: String(raw.head?.ref ?? ""),
    headRepo: String(raw.head?.repo?.full_name ?? ""),
    labels: /** @type {string[]} */ (
      (raw.labels ?? []).map((/** @type {any} */ label) => label.name)
    ),
    changesRequested,
    files,
  };
}

/** @param {string} repo @param {number} pr @param {string} body */
function upsertComment(repo, pr, body) {
  const existing = gh(
    `api --paginate repos/${repo}/issues/${pr}/comments?per_page=100 --jq [.[]|select(.body|contains("${COMMENT_MARKER}"))]|last|.id//empty`,
  );
  if (existing !== "") {
    execFileSync(
      "gh",
      ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing}`, "-f", `body=${body}`],
      {
        encoding: "utf8",
      },
    );
    return;
  }
  execFileSync("gh", ["pr", "comment", String(pr), "--repo", repo, "--body", body], {
    encoding: "utf8",
  });
}

/**
 * 评论正文。
 * @param {ReturnType<typeof evaluate>} verdict
 * @param {number} pr
 */
function commentBody(verdict, pr) {
  const lines = [COMMENT_MARKER, "### 🚫 自动合并条件不满足", "", verdict.reason, ""];
  if (verdict.offending.length > 0) {
    lines.push("越界文件：", "", ...verdict.offending.slice(0, 20).map((file) => `- \`${file}\``));
    if (verdict.offending.length > 20) lines.push(`- ……另有 ${verdict.offending.length - 20} 个`);
    lines.push("");
  }
  lines.push(
    "已摘掉 `automerge` 标签，并关闭了本 PR 上已武装的 auto-merge。",
    "",
    "处理方式：把越界改动拆到单独的 PR，或按 [CONTRIBUTING §自动合并分级](https://github.com/kangyishuai/dsh-plugins/blob/main/CONTRIBUTING.md#自动合并automerge分级)",
    "确认本 PR 属于 C 档（人工合并）后**不要**再加这个标签。",
    "",
    `> PR #${pr} · 由 \`.github/workflows/automerge-guard.yml\` 自动判定，规则见 [ADR 0014](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0014-automerge-tiers.md)。`,
  );
  return lines.join("\n");
}

function main() {
  const { values } = parseArgs({
    options: { repo: { type: "string" }, pr: { type: "string" } },
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  const pr = Number(values.pr ?? process.env.PR_NUMBER ?? "0");
  if (repo === "" || !Number.isSafeInteger(pr) || pr <= 0) {
    console.error("用法：node scripts/automerge-guard.mjs --repo <owner/name> --pr <number>");
    process.exitCode = 2;
    return;
  }

  const pull = readPull(repo, pr);
  if (!pull.labels.includes("automerge")) {
    console.log("没有 automerge 标签，跳过");
    return;
  }

  const verdict = evaluate(pull);
  if (verdict.ok) {
    console.log(`✅ 合规（${verdict.tier} 档）：${pull.files.length} 个文件都在白名单里`);
    return;
  }

  console.error(`🚫 不合规：${verdict.reason}`);
  for (const file of verdict.offending) console.error(`  - ${file}`);
  for (const args of [
    ["pr", "edit", String(pr), "--repo", repo, "--remove-label", "automerge"],
    ["pr", "merge", String(pr), "--repo", repo, "--disable-auto"],
  ]) {
    try {
      execFileSync("gh", args, { encoding: "utf8", stdio: "pipe" });
    } catch (_error) {
      // 标签已摘 / 本来没武装 auto-merge：都不影响结论
    }
  }
  upsertComment(repo, pr, commentBody(verdict, pr));
  console.log("已摘标签 + 关闭 auto-merge + 留评论");
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
