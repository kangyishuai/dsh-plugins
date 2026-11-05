#!/usr/bin/env node
// @ts-check
// 用法：pnpm check:public
// 公开边界检查（规则见 AGENTS.md「公开边界」）。只检查会进入公开仓库的文件：
// git 已跟踪 + 已暂存的文件，不看被 .gitignore 忽略的 notes/、node_modules 等。
// 某一行确属误报时，在同一行写 `check-public: allow` 跳过。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMain, REPO_ROOT } from "./lib/repo.mjs";

/** @typedef {{ file: string, line: number, rule: string, message: string }} Finding */

/** 示例里允许出现的占位用户名 */
const PLACEHOLDER_USERS = new Set([
  "me",
  "u",
  "x",
  "test",
  "foo",
  "you",
  "user",
  "username",
  "name",
  "runner",
  "example",
  "alice",
  "bob",
  "shared",
  "public",
]);

/** 不做内容检查的文件（生成物或二进制） */
const SKIP_CONTENT = [/(^|\/)pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|webp|ico|zst|tgz|zip|woff2?)$/i];

const ALLOW = "check-public: allow";

/**
 * 每条规则对单行文本给出命中的片段；返回 null 表示没问题。
 * @type {{ rule: string, message: string, test: (line: string) => string | null }[]}
 */
const LINE_RULES = [
  {
    rule: "notes-link",
    message: "链接指向私有的 notes/ 目录，公开后会是死链；请把结论写进 docs/",
    test: (line) => line.match(/\]\((?:\.{1,2}\/)*notes\/[^)]*\)/)?.[0] ?? null,
  },
  {
    rule: "home-path",
    message: "出现带真实用户名的本机绝对路径；示例请用占位用户名（me / user / <name>）",
    test: (line) => {
      const re = /(?:\/Users\/|\/home\/|[A-Za-z]:\\\\?Users\\\\?)([A-Za-z0-9._-]+)/g;
      for (const m of line.matchAll(re)) {
        if (!PLACEHOLDER_USERS.has(m[1].toLowerCase())) return m[0];
      }
      return null;
    },
  },
  {
    rule: "secret",
    message: "疑似 token 或私钥；密钥不能进任何 git 仓库",
    test: (line) =>
      line.match(
        /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      )?.[0] ?? null,
  },
];

/**
 * @param {string} root
 * @param {string[]} files 相对 root 的路径
 * @returns {Finding[]}
 */
export function checkFiles(root, files) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    if (/^notes(\/|$)/.test(file)) {
      findings.push({
        file,
        line: 0,
        rule: "notes-tracked",
        message: "notes/ 是私有笔记，不能被提交",
      });
      continue;
    }
    if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) {
      findings.push({ file, line: 0, rule: "env-file", message: ".env 文件不能被提交" });
      continue;
    }
    if (SKIP_CONTENT.some((re) => re.test(file))) continue;

    const path = join(root, file);
    let text;
    try {
      if (!statSync(path).isFile()) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue; // 已暂存删除等情况
    }
    if (text.includes("\u0000")) continue; // 二进制

    text.split("\n").forEach((content, index) => {
      if (content.includes(ALLOW)) return;
      for (const { rule, message, test } of LINE_RULES) {
        const hit = test(content);
        if (hit) findings.push({ file, line: index + 1, rule, message: `${message}（${hit}）` });
      }
    });
  }
  return findings;
}

/** @param {string} root */
export function listPublicFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

if (isMain(import.meta.url)) {
  const files = listPublicFiles(REPO_ROOT);
  const findings = checkFiles(REPO_ROOT, files);
  for (const f of findings) {
    console.log(
      `\x1b[31merror\x1b[0m ${f.file}${f.line ? `:${f.line}` : ""} [${f.rule}] ${f.message}`,
    );
  }
  console.log(`公开边界检查：${files.length} 个文件，${findings.length} 个问题`);
  process.exit(findings.length > 0 ? 1 : 0);
}
