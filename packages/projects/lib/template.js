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
