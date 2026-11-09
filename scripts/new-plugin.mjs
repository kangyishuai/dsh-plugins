#!/usr/bin/env node
// @ts-check
// 用法：pnpm new <name> [description]
// 从 templates/plugin 生成 packages/<name>，并替换占位符。
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { isMain, NAME_RE, REPO_ROOT, toCamel } from "./lib/repo.mjs";

/**
 * @param {{ root?: string, name: string, description?: string }} options
 * @returns {string} 生成的目录
 */
export function scaffold({ root = REPO_ROOT, name, description = "TODO: one-line description" }) {
  if (!NAME_RE.test(name)) throw new Error(`插件名必须是 kebab-case：${name}`);
  if (name.startsWith("dsh-")) throw new Error("目录名不要带 dsh- 前缀（包名会自动加）");
  const target = join(root, "packages", name);
  if (existsSync(target)) throw new Error(`已存在：${relative(root, target)}`);

  cpSync(join(REPO_ROOT, "templates", "plugin"), target, { recursive: true });
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(target, "LICENSE"));

  const vars = { __NAME__: name, __CAMEL__: toCamel(name), __DESCRIPTION__: description };
  for (const file of walk(target)) {
    const text = readFileSync(file, "utf8");
    const out = text.replace(
      /__(NAME|CAMEL|DESCRIPTION)__/g,
      (m) => vars[/** @type {keyof typeof vars} */ (m)],
    );
    if (out !== text) writeFileSync(file, out);
  }
  scaffoldDesktopSmoke(root, name);
  registerInRepo(root, name);
  return target;
}

/**
 * 给新插件生成桌面端冒烟骨架并登记根脚本。
 * 有 client 半就必须有桌面套件（docs/plugin-conventions.md §6.1），否则 `pnpm check` 报错。
 * @param {string} root
 * @param {string} name
 */
export function scaffoldDesktopSmoke(root, name) {
  const template = join(REPO_ROOT, "templates", "plugin-desktop-smoke", "smoke.js");
  if (!existsSync(template)) return;
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const target = join(scriptsDir, `smoke-${name}-desktop.mjs`);
  if (!existsSync(target)) {
    writeFileSync(target, readFileSync(template, "utf8").replace(/__NAME__/g, name));
  }
  const pkgPath = join(root, "package.json");
  // 极简仓库（比如测试用的临时目录）可能没有根 package.json：补一个，保证脚本能登记上。
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      `${JSON.stringify({ name: "dsh-plugins", private: true, scripts: {} }, null, 2)}\n`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts = pkg.scripts ?? {};
  const scriptName = `smoke:${name}-desktop`;
  if (pkg.scripts[scriptName] === undefined) {
    pkg.scripts[scriptName] = `node scripts/smoke-${name}-desktop.mjs`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

/**
 * 把新插件登记到仓库级配置：PR 自动打标签、bug 报告的插件下拉。
 * 文件不存在（比如测试用的临时仓库）就跳过；`pnpm check` 会提示缺失的登记。
 * @param {string} root
 * @param {string} name
 */
export function registerInRepo(root, name) {
  const labeler = join(root, ".github", "labeler.yml");
  if (existsSync(labeler)) {
    const text = readFileSync(labeler, "utf8");
    if (!text.includes(`"plugin:${name}"`)) {
      const block = `\n"plugin:${name}":\n  - changed-files:\n      - any-glob-to-any-file: "packages/${name}/**"\n`;
      writeFileSync(labeler, text.replace(/\n*$/, "\n") + block);
    }
  }
  const bug = join(root, ".github", "ISSUE_TEMPLATE", "bug_report.yml");
  if (existsSync(bug)) {
    const text = readFileSync(bug, "utf8");
    const pkg = `"@kangyishuai/dsh-${name}"`;
    if (!text.includes(pkg)) {
      writeFileSync(bug, text.replace(/^(\s*)- other$/m, `$1- ${pkg}\n$1- other`));
    }
  }
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (isMain(import.meta.url)) {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [name, ...rest] = positionals;
  if (!name) {
    console.error("用法：pnpm new <name> [description]");
    process.exit(1);
  }
  try {
    const target = scaffold({ name, description: rest.join(" ") || undefined });
    console.log(`已生成 ${relative(REPO_ROOT, target)}`);
    console.log("已登记到 .github/labeler.yml 与 bug_report.yml；记得在 GitHub 上建标签：");
    console.log(`  gh label create "plugin:${name}" --color 7057ff`);
    console.log(
      `已生成 scripts/smoke-${name}-desktop.mjs（桌面端冒烟骨架，去把 TODO 换成真实断言）`,
    );
    console.log("下一步：pnpm install && pnpm check");
    console.log(`本地安装：dsh plugin --profile desktop add "link:${target}"`);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
