#!/usr/bin/env node
// @ts-check
// 用法：pnpm release（只在 CI 的 Release 工作流里运行）
//       node scripts/publish.mjs --dry-run（本地预演：只看会发布什么，不加 provenance、不打 tag）
//
// 为什么不用 `changeset publish`：它在 pnpm 仓库里调用 `pnpm publish`，而 pnpm 不支持 npm provenance，
// NPM_CONFIG_PROVENANCE 会被忽略。这里改用 `npm publish --provenance`，发布成功后再跑
// `changeset git-tag`：它会读 CHANGESETS_OUTPUT 环境变量，把打的 tag 写成事件，
// changesets/action 据此推送 tag、创建 GitHub Release。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isMain, listPluginDirs, REPO_ROOT, readJson } from "./lib/repo.mjs";

/** @typedef {{ dir: string, name: string, version: string }} PublishTarget */

/**
 * @param {string} root
 * @returns {PublishTarget[]}
 */
export function listPublishable(root) {
  return listPluginDirs(root)
    .map((dir) => ({ dir, pkg: readJson(join(root, "packages", dir, "package.json")) }))
    .filter(({ pkg }) => !pkg.private)
    .map(({ dir, pkg }) => ({ dir, name: pkg.name, version: pkg.version }));
}

/**
 * 查询某个版本是否已经在 registry 上。
 * 直接读完整的包文档并禁用缓存：`npm view` 走的精简元数据有 CDN 缓存，刚发布的版本会被误判为没发布。
 * 404（包从没发布过）返回 false；其他错误直接抛出，绝不在不确定时去发布。
 * @param {string} name
 * @param {string} version
 */
export async function isPublished(name, version) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`查询 ${name} 失败：HTTP ${res.status}`);
  const doc = /** @type {{ versions?: Record<string, unknown> }} */ (await res.json());
  return Boolean(doc.versions && version in doc.versions);
}

/**
 * @param {PublishTarget[]} targets
 * @param {(name: string, version: string) => boolean | Promise<boolean>} published
 */
export async function selectUnpublished(targets, published) {
  /** @type {PublishTarget[]} */
  const pending = [];
  for (const t of targets) if (!(await published(t.name, t.version))) pending.push(t);
  return pending;
}

/** @param {string} cmd @param {string[]} args @param {string} cwd */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} 失败（退出码 ${result.status}）`);
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    if (!dryRun && process.env.GITHUB_ACTIONS !== "true") {
      throw new Error(
        "只能在 CI 的 Release 工作流里发布（AGENTS.md：不要在本地 npm publish）。本地预演用 --dry-run",
      );
    }
    const pending = await selectUnpublished(listPublishable(REPO_ROOT), isPublished);
    if (pending.length === 0) {
      console.log("没有需要发布的包");
      process.exit(0);
    }
    for (const target of pending) {
      console.log(`\n==> 发布 ${target.name}@${target.version}${dryRun ? "（dry-run）" : ""}`);
      const args = ["publish", "--access", "public", dryRun ? "--dry-run" : "--provenance"];
      run("npm", args, join(REPO_ROOT, "packages", target.dir));
    }
    // 全部发布成功后才打 tag：中途失败时不留下「有 tag 没包」的状态
    if (!dryRun) run("pnpm", ["exec", "changeset", "git-tag"], REPO_ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
