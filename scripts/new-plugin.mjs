#!/usr/bin/env node
// @ts-check
// 用法：pnpm new <name> [description]
// 从 templates/plugin 生成 packages/<name>，并替换占位符。
import {
  copyFileSync,
  cpSync,
  existsSync,
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
  return target;
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
    console.log("下一步：pnpm install && pnpm check");
    console.log(`本地安装：dsh plugin --profile desktop add "link:${target}"`);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
