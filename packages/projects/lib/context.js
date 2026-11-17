// @ts-check
// 项目级上下文的渲染：纯函数，便于单测。
// 设计要点：
// 1) 只渲染「项目自己的东西」（常设规则 + 记忆索引 + 目标），**不重复渲染 AGENTS.md**——
//    宿主 dsh-agent-instructions 已经按 cwd 链加载过它。
// 2) 字符预算是硬约束（默认 16,000，对齐 Claude Projects 的上限），超了先裁记忆再裁规则，
//    始终保留一行「已截断」提示，让模型知道有东西没看到。
// 3) 文本里不出现时间戳等易变内容（缓存友好）；易变信息由 wake 信封单独承载。

/** 项目指令的字符预算。 */
export const INSTRUCTION_BUDGET = 16_000;

/** 记忆索引最多带多少行（防止把整个 MEMORY.md 塞进每一步）。 */
export const MEMORY_INDEX_MAX_LINES = 200;

/** 渲染顺序：项目身份 → 常设规则 → 记忆索引 → 使用约定。 */
export const PROJECT_CONTEXT_ORDER = 120;

/**
 * @typedef {object} RenderInput
 * @property {{name: string, goal?: string, dirs?: readonly string[]}} project
 * @property {string} [instructions] 项目常设规则（用户写的）
 * @property {string} [memoryIndex] MEMORY.md 的内容
 * @property {number} [budget]
 */

/**
 * 把记忆索引裁成「前 N 行 + 截断提示」。
 * @param {string} text
 * @param {number} maxLines
 */
export function clipIndex(text, maxLines = MEMORY_INDEX_MAX_LINES) {
  const lines = String(text ?? "")
    .split("\n")
    .filter((line, index, all) => line.trim() !== "" || index < all.length - 1);
  if (lines.length <= maxLines) return lines.join("\n").trimEnd();
  const kept = lines.slice(0, maxLines).join("\n").trimEnd();
  return `${kept}\n…（记忆索引还有 ${lines.length - maxLines} 行未展示，需要时用文件工具读取）`;
}

/**
 * 组装注入文本。
 * @param {RenderInput} input
 * @returns {string} 空字符串表示这个项目没有可注入的内容
 */
export function renderProjectContext(input) {
  const budget = Number.isFinite(input.budget) ? Number(input.budget) : INSTRUCTION_BUDGET;
  const name = String(input.project?.name ?? "").trim();
  const goal = String(input.project?.goal ?? "").trim();
  const dirs = Array.isArray(input.project?.dirs)
    ? input.project.dirs.filter((d) => typeof d === "string")
    : [];
  const rules = String(input.instructions ?? "").trim();
  const memory = clipIndex(String(input.memoryIndex ?? ""));

  if (name === "" && goal === "" && rules === "" && memory === "") return "";

  const head = [`# 当前项目：${name || "(未命名)"}`];
  if (goal !== "") head.push(`目标：${goal}`);
  if (dirs.length > 0) head.push(`工作目录：${dirs.join("、")}`);

  /** @type {string[]} */
  const blocks = [head.join("\n")];
  if (rules !== "") blocks.push(`## 常设规则\n${rules}`);
  if (memory !== "") blocks.push(`## 项目记忆索引（MEMORY.md）\n${memory}`);
  blocks.push(
    "## 使用约定\n" +
      "- 上面的规则与记忆属于这个项目；与当前任务无关时不要复述它们。\n" +
      "- 记忆索引只是目录：需要细节时用文件工具读取对应文件，不要凭索引猜测内容。\n" +
      "- 仓库自带的 AGENTS.md / CLAUDE.md 已由宿主单独加载，不要重复引用。",
  );

  const full = blocks.join("\n\n");
  if (full.length <= budget) return full;

  // 超预算：先砍记忆（它最可裁），再砍规则，最后保留身份与约定
  const identity = blocks[0];
  const usage = blocks[blocks.length - 1];
  const rulesBlock = rules !== "" ? `## 常设规则\n${rules}` : "";
  const note =
    "\n\n（项目上下文已按字符预算截断：记忆索引与常设规则可能不完整，需要时请直接读取项目文件。）";

  /** @param {...string} parts */
  const join = (...parts) => parts.filter((p) => p !== "").join("\n\n");
  const withoutMemory = join(identity, rulesBlock, usage) + note;
  if (withoutMemory.length <= budget) return withoutMemory;
  const withoutRules = join(identity, usage) + note;
  if (withoutRules.length <= budget) return withoutRules;
  // 连身份都超了：硬截断（极端情况，仍保留截断说明）
  return `${identity.slice(0, Math.max(0, budget - note.length))}${note}`;
}

/**
 * 稳定排序的注入顺序（供 systemPrompt 使用）。
 * @returns {number}
 */
export function projectContextOrder() {
  return PROJECT_CONTEXT_ORDER;
}
