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
 * F38：注入包裹标签。宿主 `dsh-agent-instructions` 注入 AGENTS.md 时也会带自己的边界，
 * 这里给项目上下文一个明确边界，模型能分清「哪段是项目注入的」。
 */
export const PROJECT_CONTEXT_OPEN = "<project-context>";
export const PROJECT_CONTEXT_CLOSE = "</project-context>";

/** 去重时忽略过短的行（一句话的巧合相同不代表重复，别把有用规则吃掉）。 */
export const DEDUPE_MIN_CHARS = 24;

/** 使用约定（F40：明确「这是项目记忆，不是 AGENTS.md」）。 */
export const USAGE_CONVENTIONS = [
  "- 上面的规则与记忆属于这个项目，不是 AGENTS.md 或 CLAUDE.md；后者已由宿主单独加载，不要重复引用。",
  "- 与当前任务无关时不要复述它们；需要细节时用文件工具读取对应文件，不要凭索引猜测内容。",
].join("\n");

/**
 * F38：把项目规则里「宿主已经注入过的 AGENTS.md 内容」去掉。
 * 宿主 `dsh-agent-instructions` 会把 AGENTS.md/CLAUDE.md 从 cwd 上溯到 .git 注入成 user message，
 * 我们在 systemPrompt 里再抄一遍就是双份上下文（既贵又容易让模型以为有两份规则）。
 *
 * 规则：按空行切块；块（或块里的某一整行）在宿主文本里出现过、且长度 ≥ DEDUPE_MIN_CHARS，
 * 就丢掉；标题行（# 开头）单独比对。返回可读的丢弃计数，UI/审计能解释「为什么规则变短了」。
 * @param {string} rules
 * @param {string} [hostText] 宿主已注入的 AGENTS.md/CLAUDE.md 正文
 * @returns {{ text: string, dropped: number }}
 */
export function dedupeAgainstHostInstructions(rules, hostText) {
  const source = String(rules ?? "").trim();
  const host = String(hostText ?? "").replace(/\r\n/gu, "\n");
  if (source === "" || host.trim() === "") return { text: source, dropped: 0 };
  const hostNormalized = host.replace(/[ \t]+/gu, " ").trim();
  let dropped = 0;
  const keptBlocks = source.split(/\n{2,}/u).filter((block) => {
    const normalized = block.replace(/\s+/gu, " ").trim();
    if (normalized.length < DEDUPE_MIN_CHARS) return true;
    if (hostNormalized.includes(normalized)) {
      dropped += 1;
      return false;
    }
    // 段落被宿主按行注入时（markdown 折叠），逐行比对长行
    const lines = block
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter((line) => line.length >= DEDUPE_MIN_CHARS);
    if (lines.length > 0 && lines.every((line) => hostNormalized.includes(line))) {
      dropped += 1;
      return false;
    }
    return true;
  });
  return { text: keptBlocks.join("\n\n").trim(), dropped };
}

/**
 * @typedef {object} RenderInput
 * @property {{name: string, goal?: string, dirs?: readonly string[]}} project
 * @property {string} [instructions] 项目常设规则（用户写的）
 * @property {string} [memoryIndex] MEMORY.md 的内容
 * @property {string} [hostInstructions] 宿主已注入的 AGENTS.md/CLAUDE.md 正文（F38 去重用）
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
  const deduped = dedupeAgainstHostInstructions(
    String(input.instructions ?? ""),
    String(input.hostInstructions ?? ""),
  );
  const rules = deduped.text;
  const memory = clipIndex(String(input.memoryIndex ?? ""));

  if (name === "" && goal === "" && rules === "" && memory === "") return "";

  const head = [`# 当前项目：${name || "(未命名)"}`];
  if (goal !== "") head.push(`目标：${goal}`);
  if (dirs.length > 0) head.push(`工作目录：${dirs.join("、")}`);

  /** @type {string[]} */
  const blocks = [head.join("\n")];
  if (rules !== "") blocks.push(`## 常设规则\n${rules}`);
  if (memory !== "") blocks.push(`## 项目记忆索引（MEMORY.md）\n${memory}`);
  blocks.push(`## 使用约定\n${USAGE_CONVENTIONS}`);

  // F38：包裹标签也吃预算，先扣掉它再判断「是否超预算」
  const wrap = (/** @type {string} */ text) =>
    text === "" ? "" : `${PROJECT_CONTEXT_OPEN}\n${text}\n${PROJECT_CONTEXT_CLOSE}`;
  const cap = Math.max(
    0,
    budget - (PROJECT_CONTEXT_OPEN.length + PROJECT_CONTEXT_CLOSE.length + 2),
  );
  const suffix =
    deduped.dropped > 0 ? `\n\n（已省略 ${deduped.dropped} 段与 AGENTS.md 重复的规则。）` : "";

  const full = blocks.join("\n\n");
  if (full.length + suffix.length <= cap) return wrap(`${full}${suffix}`);

  // 超预算：先砍记忆（它最可裁），再砍规则，最后保留身份与约定
  const identity = blocks[0];
  const usage = blocks[blocks.length - 1];
  const rulesBlock = rules !== "" ? `## 常设规则\n${rules}` : "";
  const note =
    "\n\n（项目上下文已按字符预算截断：记忆索引与常设规则可能不完整，需要时请直接读取项目文件。）";

  /** @param {...string} parts */
  const join = (...parts) => parts.filter((p) => p !== "").join("\n\n");
  const withoutMemory = join(identity, rulesBlock, usage) + note;
  if (withoutMemory.length <= cap) return wrap(withoutMemory);
  const withoutRules = join(identity, usage) + note;
  if (withoutRules.length <= cap) return wrap(withoutRules);
  // 连身份都超了：硬截断（极端情况，仍保留截断说明）
  return wrap(`${identity.slice(0, Math.max(0, cap - note.length))}${note}`);
}

/**
 * 稳定排序的注入顺序（供 systemPrompt 使用）。
 * @returns {number}
 */
export function projectContextOrder() {
  return PROJECT_CONTEXT_ORDER;
}
