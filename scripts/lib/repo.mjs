// @ts-check
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCOPE = "@kangyishuai";
export const PREFIX = `${SCOPE}/dsh-`;
export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** kebab-case 目录名：小写字母开头，字母数字和连字符 */
export const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** @param {string} kebab */
export function toCamel(kebab) {
  return kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 列出 packages/ 下的插件目录（跳过以 . 或 _ 开头的）
 * @param {string} root
 */
export function listPluginDirs(root) {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/^[._]/.test(d.name))
    .map((d) => d.name)
    .sort();
}

/** @param {string} file */
export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 是否作为入口脚本运行（不依赖 import.meta.main，兼容 Node 22.19）
 * @param {string} metaUrl
 */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
