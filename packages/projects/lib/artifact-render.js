// @ts-check
/**
 * 产物正文的最小 Markdown 解析（只做渲染需要的那几类块）：
 * 标题 / 段落 / 无序列表 / 勾选清单 / 表格 / 代码块。解析不了的保持原文，绝不吞内容。
 * 不做 HTML 渲染（产物可能是 HTML，客户端一律按纯文本/片段展示，避免注入）。
 *
 * @typedef {{ type: "heading", level: number, text: string }
 *   | { type: "paragraph", text: string }
 *   | { type: "list", ordered: boolean, items: string[], checked?: boolean[] }
 *   | { type: "table", header: string[], rows: string[][] }
 *   | { type: "code", text: string }} Block
 * @param {string} input
 * @returns {Block[]}
 */
export function parseArtifactMarkdown(input) {
  const lines = String(input ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let paragraph = [];
  /** @type {string[]} */
  let listItems = [];
  /** @type {boolean[]} */
  let listChecked = [];
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", ordered: false, items: listItems, checked: listChecked });
    listItems = [];
    listChecked = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        blocks.push({ type: "code", text: codeLines.join("\n") });
        inCode = false;
        codeLines = [];
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)/u.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    // 表格：本行以 | 开头，且下一行是 |---| 分隔行
    if (trimmed.startsWith("|") && index + 1 < lines.length) {
      const next = lines[index + 1].trim();
      if (/^\|?[\s:|-]+\|/u.test(next) && next.includes("---")) {
        flushParagraph();
        flushList();
        const split = (/** @type {string} */ row) =>
          row
            .trim()
            .replace(/^\|/u, "")
            .replace(/\|$/u, "")
            .split("|")
            .map((cell) => cell.trim());
        const header = split(trimmed);
        /** @type {string[][]} */
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim().startsWith("|")) {
          rows.push(split(lines[index]));
          index += 1;
        }
        index -= 1;
        blocks.push({ type: "table", header, rows });
        continue;
      }
    }

    const checklist = /^\s*-\s*\[(x|X| )\]\s*(.*)/u.exec(line);
    if (checklist) {
      flushParagraph();
      listItems.push(checklist[2].trim());
      listChecked.push(checklist[1] !== " ");
      continue;
    }

    const bullet = /^\s*-\s+(.*)/u.exec(line);
    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1].trim());
      listChecked.push(false);
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  if (inCode && codeLines.length > 0) blocks.push({ type: "code", text: codeLines.join("\n") });
  return blocks;
}
