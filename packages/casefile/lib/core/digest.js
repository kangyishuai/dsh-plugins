// @ts-check
// core/digest.js：内容寻址。纯 Node，可单测。
//
// 用途（spec/03-acceptance.md §4）：
//   - implementationDigest：产物目录的稳定哈希；
//   - originalDigest：原件快照的稳定哈希；
//   - 两者变化时，依赖它们的 PASS 一律 stale。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 默认跳过：版本库、依赖、缓存、日志。 */
export const DEFAULT_IGNORES = /** @type {const} */ ([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "coverage",
  ".next",
  "logs",
  "__pycache__",
  ".venv",
]);

/**
 * 文本哈希。
 * @param {string} text
 * @returns {string}
 */
export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 单文件哈希。
 * @param {string} file
 * @returns {string}
 */
export function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 把路径规范成 `/` 分隔的相对路径（跨平台稳定）。
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
function relPosix(root, path) {
  return relative(root, path).split(sep).join("/");
}

/**
 * 递归列出文件（不跟随符号链接；忽略目录按名字匹配）。
 * @param {string} root
 * @param {{ ignore?: readonly string[], maxFiles?: number }} [options]
 * @returns {string[]} 相对路径，已排序
 */
export function listFiles(root, options = {}) {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORES);
  const maxFiles = options.maxFiles ?? 5000;
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(relPosix(root, join(dir, entry.name)));
    }
  };
  if (statSync(root).isFile()) return [relPosix(root, root)];
  walk(root);
  return out.sort();
}

/**
 * 目录（或单文件）的稳定哈希：`sha256(sorted("relpath\0sha256\n"))`。
 * @param {string} root
 * @param {{ ignore?: readonly string[], maxFiles?: number }} [options]
 * @returns {{ digest: string, files: number, bytes: number }}
 */
export function hashTree(root, options = {}) {
  const files = listFiles(root, options);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    const size = statSync(abs).size;
    bytes += size;
    hash.update(rel).update("\0").update(hashFile(abs)).update("\n");
  }
  return { digest: hash.digest("hex"), files: files.length, bytes };
}

/**
 * 摘要展示：前 12 位。
 * @param {string | null | undefined} digest
 * @returns {string}
 */
export function shortDigest(digest) {
  if (typeof digest !== "string" || digest === "") return "—";
  return digest.slice(0, 12);
}

/**
 * 两个摘要是否同一实现/原件。
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function sameDigest(a, b) {
  return typeof a === "string" && typeof b === "string" && a !== "" && a === b;
}
