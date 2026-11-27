// @ts-check
// 一键建项目模板（规格 §7.7.6）：决定"要写哪些文件、写什么"，写盘由 service 做。
// 纯函数便于单测；重点是不覆盖用户已有内容。

/** instructions.md 的骨架（用户之后自己改）。 */
export const INSTRUCTIONS_SKELETON = `# 项目常设规则

<!-- 这个文件会在每次请求前注入到本项目的所有会话。写短、写稳。 -->

## 约定
- 

## 禁区
- 
`;

/**
 * 规划模板要创建的内容。
 * @param {{ dir?: string, exists?: { dirExists?: boolean, agentsMd?: boolean, instructionsMd?: boolean } }} input
 * @returns {{ mkdirs: string[], files: { path: string, content: string }[], skipped: { path: string, reason: string }[] }}
 */
export function planTemplate(input) {
  const dir = String(input?.dir ?? "");
  const exists = input?.exists ?? {};
  /** @type {string[]} */
  const mkdirs = [];
  /** @type {{path: string, content: string}[]} */
  const files = [];
  /** @type {{path: string, reason: string}[]} */
  const skipped = [];

  if (dir !== "" && exists.dirExists !== true) mkdirs.push(dir);

  const instructions =
    dir === "" ? "instructions.md" : `${dir.replace(/\/+$/u, "")}/instructions.md`;
  if (exists.instructionsMd === true) {
    skipped.push({ path: instructions, reason: "exists" });
  } else {
    // 已有 AGENTS.md 时不复制它的内容，只在骨架里指过去（与 spec §3.3 的去重口径一致）
    const content =
      exists.agentsMd === true
        ? INSTRUCTIONS_SKELETON.replace(
            "## 约定",
            "## 约定\n\n> 本目录已有 AGENTS.md，两者都会注入；请避免写重复内容。\n",
          )
        : INSTRUCTIONS_SKELETON;
    files.push({ path: instructions, content });
  }

  return { mkdirs, files, skipped };
}

// —— F5：项目模板补全 ——
// AGENTS.md 里写一个**受管区块**：dsh-projects 的默认值（分支前缀/预算/巡检节奏）落在这里，
// 用户可以在区块外随便写自己的规则；重复应用模板时只替换区块本身，幂等且不覆盖用户内容。

/** AGENTS.md 受管区块的起止标记（用户可见、可整块删除）。 */
export const MANAGED_BEGIN =
  "<!-- dsh-projects:begin（此区块由 dsh-projects 维护，可整块删除） -->";
export const MANAGED_END = "<!-- dsh-projects:end -->";

/** 模板默认值：分支前缀 / 巡检节奏（预算默认值来自 budget.js 的 DEFAULT_BUDGET）。 */
export const TEMPLATE_DEFAULTS = Object.freeze({
  branchPrefix: "feat/",
  inspectCadence: "daily",
});

/**
 * 渲染受管区块正文。
 * @param {{ name?: string, budget?: { maxThreadsPerDay?: number|null, maxConcurrent?: number|null, maxStepsPerThread?: number|null, dailyTokens?: number|null }, defaults?: { branchPrefix?: string, inspectCadence?: string } }} [input]
 * @returns {string}
 */
export function renderManagedAgentsBlock(input = {}) {
  const defaults = { ...TEMPLATE_DEFAULTS, ...(input.defaults ?? {}) };
  const budget = input.budget ?? {};
  const show = (/** @type {any} */ value) => (Number.isFinite(value) ? String(value) : "不限");
  const name = String(input.name ?? "").trim();
  const lines = [
    MANAGED_BEGIN,
    "## 项目默认值（dsh-projects 维护）",
    "",
    name === "" ? "" : `- 项目：${name}`,
    `- 线程分支前缀：\`${defaults.branchPrefix}\``,
    `- 预算：日线程 ${show(budget.maxThreadsPerDay)} · 并发 ${show(budget.maxConcurrent)} · 步数 ${show(budget.maxStepsPerThread)} · token ${show(budget.dailyTokens)}`,
    `- 巡检：${defaults.inspectCadence === "daily" ? "每天一次（打开项目面板时汇总）" : String(defaults.inspectCadence)}`,
    MANAGED_END,
  ].filter((line, index) => !(line === "" && index === 2 && name === ""));
  return lines.join("\n");
}

/**
 * 把受管区块合并进已有 AGENTS.md：有标记就替换，没有就追加；结果幂等。
 * 绝不删改标记之外的用户内容。
 * @param {string} existing
 * @param {string} block
 * @returns {{ text: string, created: boolean, replaced: boolean }}
 */
export function mergeManagedBlock(existing, block) {
  const source = String(existing ?? "").replace(/\r\n/gu, "\n");
  const managed = String(block ?? "").trim();
  if (source.trim() === "") return { text: `${managed}\n`, created: true, replaced: false };
  const begin = source.indexOf(MANAGED_BEGIN);
  const end = source.indexOf(MANAGED_END);
  if (begin >= 0 && end > begin) {
    const before = source.slice(0, begin);
    const after = source.slice(end + MANAGED_END.length);
    return { text: `${before}${managed}${after}`, created: false, replaced: true };
  }
  const separator = source.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${source}${separator}${managed}\n`, created: false, replaced: false };
}
