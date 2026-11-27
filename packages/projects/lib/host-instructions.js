// @ts-check
// F38：读取宿主 `dsh-agent-instructions` **也会注入**的 AGENTS.md / CLAUDE.md 正文。
//
// 为什么需要这一层：宿主的 `dsh-agent-instructions` 会从会话 cwd 上溯到 git 根，
// 把 AGENTS.md / CLAUDE.md 注入成 user message（外加全局 `$DSH_HOME/AGENTS.md`）。
// 项目上下文如果再抄一遍同样的规则，模型会看到两份规则（既贵又容易误判优先级）。
// 这里按同样的「cwd → git 根」规则把文件读出来，交给 `dedupeAgainstHostInstructions` 去重。
//
// 只读、可注入根目录：`$DSH_HOME` 与目录链都可传，测试不碰真实 home。

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 宿主会加载的文件名（顺序即优先级，只影响拼接顺序）。 */
export const HOST_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/** 单个文件读取上限（与 project-files.js 一致：防手滑把大文件塞进每一步）。 */
export const MAX_HOST_INSTRUCTION_CHARS = 64 * 1024;

/** 向上找 git 根的最大层数（防符号链接环 / 极深目录）。 */
export const MAX_UPWARD_DEPTH = 32;

/**
 * 读一个文件；不存在/读失败返回空串，超上限截断并注明。
 * @param {string} file
 * @returns {string}
 */
function readCapped(file) {
  try {
    if (!existsSync(file)) return "";
    const info = statSync(file);
    if (!info.isFile()) return "";
    const text = readFileSync(file, "utf8");
    return text.length <= MAX_HOST_INSTRUCTION_CHARS
      ? text
      : `${text.slice(0, MAX_HOST_INSTRUCTION_CHARS)}\n…（文件过大，已截断）`;
  } catch {
    return "";
  }
}

/**
 * 从目录上溯到 git 根（含 git 根本身），返回目录链（近 → 远）。
 * 找不到 git 根时退化为「到文件系统根为止」，但最多 MAX_UPWARD_DEPTH 层。
 * @param {string} start
 * @returns {string[]}
 */
export function instructionDirChain(start) {
  /** @type {string[]} */
  const chain = [];
  if (typeof start !== "string" || start.trim() === "") return chain;
  let current = resolve(start);
  const seen = new Set();
  for (let depth = 0; depth < MAX_UPWARD_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

/**
 * 收集宿主会注入的指令正文（全局 + 每个项目目录的 cwd 链）。
 * 重复文件路径只读一次；结果顺序固定（全局在前，然后按目录近 → 远）。
 * @param {readonly string[]} [dirs] 项目目录（会话 cwd 通常在其中）
 * @param {{ dshHome?: string, home?: string }} [options]
 * @returns {{ text: string, files: string[] }}
 */
export function readHostInstructions(dirs, options) {
  /** @type {string[]} */
  const files = [];
  const seen = new Set();
  /** @param {string} file */
  const collect = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };
  // 1) 全局：$DSH_HOME/AGENTS.md（宿主 AGENTS.md 的全局层）
  const configured =
    typeof options?.dshHome === "string" && options.dshHome !== ""
      ? options.dshHome
      : typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
        ? process.env.DSH_HOME
        : join(
            typeof options?.home === "string" && options.home !== "" ? options.home : homedir(),
            ".dsh",
          );
  for (const name of HOST_INSTRUCTION_FILES) collect(join(configured, name));
  // 2) 每个项目目录向上的 cwd 链
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    for (const base of instructionDirChain(dir)) {
      for (const name of HOST_INSTRUCTION_FILES) collect(join(base, name));
    }
  }
  const parts = [];
  const readable = [];
  for (const file of files) {
    const text = readCapped(file).trim();
    if (text === "") continue;
    readable.push(file);
    parts.push(`<!-- host-instructions: ${file} -->\n${text}`);
  }
  return { text: parts.join("\n\n"), files: readable };
}
