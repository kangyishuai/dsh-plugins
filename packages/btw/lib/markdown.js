// @ts-check
// 轻量 Markdown → JSON 树（块 + 行内），供 client 用 React 元素渲染。
//
// 为什么不引依赖 / 不生成 HTML：
//   - 仓库约定不引入构建器（ADR 0001），client 半是 classic script；
//   - 生成 HTML 再塞 innerHTML 会把模型输出当代码执行；输出纯数据、client 只建
//     React 元素，文本永远是文本节点，天然转义。
//   - DSH 明确不允许插件加载宿主 UI 包（`dsh-client-ui-primitives` 等），所以
//     渲染器只能自己写；解析放在 host 半，既好单测，client 又只做薄映射。
//
// 支持：ATX 标题、段落、围栏代码（含未闭合的流式态）、有序/无序列表（单层）、
// 引用（可嵌套到 3 层）、表格、分隔线；行内：代码、粗体、斜体、删除线、链接、裸 URL。
// 刻意不支持：HTML 内嵌、图片、脚注、嵌套列表（旁问答案里极少出现，手写风险高）。
//
// 输出形状（JSON 可序列化，跨 RPC 传）：
//   block: {type:'paragraph',inlines} | {type:'heading',level,inlines}
//        | {type:'code',lang,code,streaming?,marker?} | {type:'list',ordered,start,items}
//        | {type:'quote',blocks} | {type:'table',align,header,rows} | {type:'hr'}
//   inline: {type:'text',text} | {type:'code',text}
//         | {type:'strong'|'em'|'del',children} | {type:'link',href,children}

const MAX_INLINE_DEPTH = 8;
const MAX_QUOTE_DEPTH = 3;
/** 反斜杠可转义的 ASCII 标点（CommonMark 的一个子集）。 */
const ESCAPABLE = new Set("\\`*_{}[]()#+-.!~|<>".split(""));
/** 裸 URL 截止字符：空白、尖括号、圆括号，以及中日韩标点/全角字符。 */
const URL_STOP = /[\s<>()\u3000-\u303f\uff00-\uffef]/u;

/**
 * 把任意输入整理成统一换行的字符串。
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "    ");
}

/**
 * 解析 Markdown。
 * @param {unknown} value
 * @returns {{ blocks: any[] }}
 */
export function parseMarkdown(value) {
  return { blocks: parseBlocks(normalize(value), 0) };
}

/**
 * 解析行内 Markdown（供测试与列表/表格单元格复用）。
 * @param {unknown} value
 * @returns {any[]}
 */
export function parseInline(value) {
  return parseInlineRuns(normalize(value).replace(/\n/gu, " "), 0);
}

/**
 * 把一段行内树拍平成纯文本（测试与兜底展示用）。
 * @param {any[]} runs
 * @returns {string}
 */
export function inlineText(runs) {
  let out = "";
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.type === "text" || run?.type === "code") out += String(run.text ?? "");
    else if (Array.isArray(run?.children)) out += inlineText(run.children);
  }
  return out;
}

/**
 * 若文本以未闭合的代码围栏结尾，补上闭合标记（转正草稿截断时用，避免输入框里
 * 留一段永远开着的代码块）。
 * @param {unknown} value
 * @returns {string}
 */
export function closeOpenFences(value) {
  const text = String(value ?? "");
  const { blocks } = parseMarkdown(text);
  const last = blocks[blocks.length - 1];
  if (last?.type !== "code" || last.streaming !== true) return text;
  const marker = typeof last.marker === "string" && last.marker !== "" ? last.marker : "```";
  return `${text.replace(/\s+$/u, "")}\n${marker}`;
}

/**
 * 在预算内截断 Markdown：尽量不在代码围栏中间截断。
 *
 * 截断点若落在未闭合围栏内，先尝试补上闭合标记；补完超过预算就退回到围栏开头，
 * 避免输入框里留半段代码块。调用方负责追加省略号（因此预算要留 1 个字符）。
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateMarkdown(value, maxChars) {
  const text = String(value ?? "");
  const budget = Math.max(1, Math.trunc(Number(maxChars) || 1));
  if (text.length <= budget) return text;
  let cut = text.slice(0, budget).replace(/\s+$/u, "");
  const closed = closeOpenFences(cut);
  if (closed.length <= budget) return closed;
  const { blocks } = parseMarkdown(cut);
  const last = blocks[blocks.length - 1];
  if (last?.type === "code" && last.streaming === true) {
    const marker = typeof last.marker === "string" && last.marker !== "" ? last.marker : "```";
    const start = cut.lastIndexOf(marker);
    if (start > 0) cut = cut.slice(0, start).replace(/\s+$/u, "");
  }
  return cut;
}

// --- blocks ----------------------------------------------------------------

/**
 * @param {string} text
 * @param {number} quoteDepth
 * @returns {any[]}
 */
function parseBlocks(text, quoteDepth) {
  const lines = text.split("\n");
  /** @type {any[]} */
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = matchFence(line);
    if (fence !== null) {
      const body = [];
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        if (isClosingFence(lines[cursor], fence.marker)) {
          closed = true;
          cursor += 1;
          break;
        }
        body.push(lines[cursor]);
        cursor += 1;
      }
      blocks.push({
        type: "code",
        lang: fence.lang,
        code: body.join("\n"),
        marker: fence.marker,
        streaming: !closed,
      });
      index = cursor;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/u.exec(line);
    if (heading !== null) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inlines: parseInlineRuns(heading[2].replace(/[ \t]+#+[ \t]*$/u, ""), 0),
      });
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const quote = /^ {0,3}>[ \t]?(.*)$/u.exec(line);
    if (quote !== null) {
      /** @type {string[]} */
      const inner = [];
      let cursor = index;
      while (cursor < lines.length) {
        const current = /^ {0,3}>[ \t]?(.*)$/u.exec(lines[cursor]);
        if (current !== null) {
          inner.push(current[1]);
          cursor += 1;
          continue;
        }
        // 引用里的空行：后面还有 `>` 才继续，否则引用结束。
        if (isBlank(lines[cursor]) && cursor + 1 < lines.length) {
          const next = /^ {0,3}>/u.test(lines[cursor + 1]);
          if (next) {
            inner.push("");
            cursor += 1;
            continue;
          }
        }
        break;
      }
      blocks.push({
        type: "quote",
        blocks:
          quoteDepth >= MAX_QUOTE_DEPTH
            ? [{ type: "paragraph", inlines: parseInlineRuns(inner.join("\n"), 0) }]
            : parseBlocks(inner.join("\n"), quoteDepth + 1),
      });
      index = cursor;
      continue;
    }

    const table = matchTable(lines, index);
    if (table !== null) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const list = matchList(lines, index);
    if (list !== null) {
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    // 段落：吃到空行或下一个块级开头。
    /** @type {string[]} */
    const paragraph = [line];
    let cursor = index + 1;
    while (cursor < lines.length && !isBlank(lines[cursor]) && !startsBlock(lines, cursor)) {
      paragraph.push(lines[cursor]);
      cursor += 1;
    }
    blocks.push({
      type: "paragraph",
      inlines: parseInlineRuns(
        paragraph
          .map((entry) => entry.replace(/[ \t]+$/u, ""))
          .join("\n")
          .trim(),
        0,
      ),
    });
    index = cursor;
  }
  return blocks;
}

/** @param {string} line */
function isBlank(line) {
  return /^[ \t]*$/u.test(line);
}

/**
 * @param {string} line
 * @returns {{ marker: string, lang: string } | null}
 */
function matchFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/u.exec(line);
  if (match === null) return null;
  const marker = match[1];
  // 反引号围栏的 info string 里不能再出现反引号（CommonMark），出现就不当围栏。
  if (marker[0] === "`" && match[2].includes("`")) return null;
  return { marker, lang: (match[2].trim().split(/\s+/u)[0] ?? "").slice(0, 32) };
}

/**
 * @param {string} line
 * @param {string} marker
 * @returns {boolean}
 */
function isClosingFence(line, marker) {
  const trimmed = line.trim();
  if (trimmed.length < marker.length) return false;
  if (!/^[`~]+$/u.test(trimmed)) return false;
  return trimmed[0] === marker[0];
}

/** @param {string} line */
function isHorizontalRule(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(line);
}

/**
 * 当前行是否会开启一个新块（段落收集时的停止条件）。
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function startsBlock(lines, index) {
  const line = lines[index];
  if (matchFence(line) !== null) return true;
  if (/^ {0,3}#{1,6}[ \t]+/u.test(line)) return true;
  if (isHorizontalRule(line)) return true;
  if (/^ {0,3}>/u.test(line)) return true;
  if (/^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+/u.test(line)) return true;
  return matchTable(lines, index) !== null;
}

/**
 * 表格：表头行 + 分隔行（`|---|:--:|`）。
 * @param {string[]} lines
 * @param {number} index
 * @returns {{ block: any, next: number } | null}
 */
function matchTable(lines, index) {
  const headerLine = lines[index];
  if (headerLine === undefined || !headerLine.includes("|")) return null;
  const separatorLine = lines[index + 1];
  if (separatorLine === undefined || !separatorLine.includes("|")) return null;
  const header = splitTableRow(headerLine);
  const separator = splitTableRow(separatorLine);
  if (header === null || separator === null || separator.length === 0) return null;
  if (!separator.every((cell) => /^:?-{1,}:?$/u.test(cell))) return null;

  const align = separator.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
  /** @type {any[][]} */
  const rows = [];
  let cursor = index + 2;
  while (cursor < lines.length && !isBlank(lines[cursor]) && lines[cursor].includes("|")) {
    const cells = splitTableRow(lines[cursor]);
    if (cells === null) break;
    rows.push(align.map((_, column) => parseInlineRuns(String(cells[column] ?? ""), 0)));
    cursor += 1;
  }
  return {
    block: {
      type: "table",
      align,
      header: align.map((_, column) => parseInlineRuns(String(header[column] ?? ""), 0)),
      rows,
    },
    next: cursor,
  };
}

/**
 * @param {string} line
 * @returns {string[] | null}
 */
function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let body = trimmed;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  // `\\|` 是单元格里的转义竖线：逐字符切，避免占位符出现在用户内容里。
  /** @type {string[]} */
  const cells = [];
  let buffer = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\" && body[index + 1] === "|") {
      buffer += "|";
      index += 1;
      continue;
    }
    if (body[index] === "|") {
      cells.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += body[index];
  }
  cells.push(buffer.trim());
  return cells;
}

/**
 * 列表：连续同类型的条目。缩进续行并入上一条目（单层列表）。
 * @param {string[]} lines
 * @param {number} index
 * @returns {{ block: any, next: number } | null}
 */
function matchList(lines, index) {
  const first = matchListItem(lines[index]);
  if (first === null) return null;
  const ordered = first.ordered;
  const start = first.start;
  /** @type {{ inlines: any[] }[]} */
  const items = [];
  let cursor = index;
  while (cursor < lines.length) {
    const item = matchListItem(lines[cursor]);
    if (item === null || item.ordered !== ordered) break;
    /** @type {string[]} */
    const parts = [item.text];
    cursor += 1;
    while (cursor < lines.length) {
      if (isBlank(lines[cursor])) break;
      if (matchListItem(lines[cursor]) !== null) break;
      if (!/^ {2,}\S/u.test(lines[cursor])) break;
      parts.push(lines[cursor].replace(/^ {2,}/u, ""));
      cursor += 1;
    }
    items.push({ inlines: parseInlineRuns(parts.join("\n"), 0) });
  }
  return { block: { type: "list", ordered, start, items }, next: cursor };
}

/**
 * @param {string} line
 * @returns {{ ordered: boolean, start: number, text: string } | null}
 */
function matchListItem(line) {
  const match = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+(.*)$/u.exec(line);
  if (match === null) return null;
  const marker = match[1];
  const ordered = /^\d/u.test(marker);
  return {
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    text: match[2],
  };
}

// --- inline ----------------------------------------------------------------

/**
 * @param {string} text
 * @param {number} depth
 * @returns {any[]}
 */
function parseInlineRuns(text, depth) {
  if (depth > MAX_INLINE_DEPTH) return [{ type: "text", text }];
  /** @type {any[]} */
  const runs = [];
  let buffer = "";
  let index = 0;
  /** @param {string} piece */
  const pushText = (piece) => {
    buffer += piece;
  };
  const flush = () => {
    if (buffer !== "") {
      runs.push({ type: "text", text: buffer });
      buffer = "";
    }
  };
  /** @param {any} run */
  const push = (run) => {
    flush();
    runs.push(run);
  };

  while (index < text.length) {
    const char = text[index];

    if (char === "\\" && index + 1 < text.length && ESCAPABLE.has(text[index + 1])) {
      pushText(text[index + 1]);
      index += 2;
      continue;
    }

    if (char === "`") {
      const span = matchCodeSpan(text, index);
      if (span !== null) {
        push({ type: "code", text: span.text });
        index = span.next;
        continue;
      }
    }

    if (char === "[") {
      const link = matchLink(text, index, depth);
      if (link !== null) {
        push(link.run);
        index = link.next;
        continue;
      }
    }

    if (char === "<") {
      const autolink = matchAutolink(text, index);
      if (autolink !== null) {
        push(autolink.run);
        index = autolink.next;
        continue;
      }
    }

    if ((char === "h" || char === "H") && isBareUrlStart(text, index)) {
      const url = matchBareUrl(text, index);
      if (url !== null) {
        push({ type: "link", href: url.href, children: [{ type: "text", text: url.href }] });
        index = url.next;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const emphasis = matchEmphasis(text, index, depth);
      if (emphasis !== null) {
        push(emphasis.run);
        index = emphasis.next;
        continue;
      }
    }

    pushText(char);
    index += 1;
  }
  flush();
  return runs;
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {{ text: string, next: number } | null}
 */
function matchCodeSpan(text, start) {
  let length = 1;
  while (text[start + length] === "`") length += 1;
  const marker = "`".repeat(length);
  const close = text.indexOf(marker, start + length);
  if (close === -1) return null;
  let content = text.slice(start + length, close).replace(/\n/gu, " ");
  if (
    content.length > 2 &&
    content.startsWith(" ") &&
    content.endsWith(" ") &&
    content.trim() !== ""
  ) {
    content = content.slice(1, -1);
  }
  return { text: content, next: close + length };
}

/**
 * `[label](href "title")`：只接受 http(s)/mailto，其它一律当纯文本。
 * @param {string} text
 * @param {number} start
 * @param {number} depth
 * @returns {{ run: any, next: number } | null}
 */
function matchLink(text, start, depth) {
  const closeLabel = findClosing(text, start + 1, "[", "]");
  if (closeLabel === -1 || text[closeLabel + 1] !== "(") return null;
  const closeTarget = findClosing(text, closeLabel + 2, "(", ")");
  if (closeTarget === -1) return null;
  const label = text.slice(start + 1, closeLabel);
  const href = normalizeHref(text.slice(closeLabel + 2, closeTarget));
  if (href === "") return null;
  return {
    run: { type: "link", href, children: parseInlineRuns(label, depth + 1) },
    next: closeTarget + 1,
  };
}

/**
 * 找配对的结束符（允许嵌套与反斜杠转义）。
 * @param {string} text
 * @param {number} from
 * @param {string} open
 * @param {string} close
 * @returns {number}
 */
function findClosing(text, from, open, close) {
  let depth = 1;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeHref(raw) {
  let target = String(raw ?? "").trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  // 去掉可选的 title：`https://x "标题"`。
  const space = target.search(/[ \t]/u);
  if (space !== -1) target = target.slice(0, space);
  if (!/^(https?:\/\/|mailto:)/iu.test(target)) return "";
  // 控制字符不允许出现在链接里（等价于 /[\u0000-\u001f\u007f]/，但 Biome 禁止控制字符正则）。
  const control = [...target].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (control) return "";
  return target;
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {{ run: any, next: number } | null}
 */
function matchAutolink(text, start) {
  const close = text.indexOf(">", start + 1);
  if (close === -1) return null;
  const target = text.slice(start + 1, close).trim();
  if (!/^(https?:\/\/|mailto:)/iu.test(target)) return null;
  return {
    run: { type: "link", href: target, children: [{ type: "text", text: target }] },
    next: close + 1,
  };
}

/**
 * 裸 URL 只在词边界开始，避免把 `xhttps://` 当链接。
 * @param {string} text
 * @param {number} start
 * @returns {boolean}
 */
function isBareUrlStart(text, start) {
  if (!/^https?:\/\//iu.test(text.slice(start, start + 8))) return false;
  if (start === 0) return true;
  return /[\s(（[【"'“”‘’]/u.test(text[start - 1]);
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {{ href: string, next: number } | null}
 */
function matchBareUrl(text, start) {
  let end = start;
  while (end < text.length && !URL_STOP.test(text[end])) end += 1;
  if (end === start) return null;
  let href = text.slice(start, end);
  // 句末标点不属于 URL。
  href = href.replace(/[.,;:!?]+$/u, "");
  if (!/^https?:\/\/\S+$/iu.test(href)) return null;
  return { href, next: start + href.length };
}

/**
 * 强调：`**粗**`、`*斜*`、`__粗__`、`~~删~~`。匹配不到就按普通字符处理。
 * @param {string} text
 * @param {number} start
 * @param {number} depth
 * @returns {{ run: any, next: number } | null}
 */
function matchEmphasis(text, start, depth) {
  const marker = text[start];
  if (marker === "~") {
    if (!text.startsWith("~~", start)) return null;
    const close = text.indexOf("~~", start + 2);
    if (close === -1) return null;
    const inner = text.slice(start + 2, close);
    if (inner.trim() === "") return null;
    return {
      run: { type: "del", children: parseInlineRuns(inner, depth + 1) },
      next: close + 2,
    };
  }
  const doubled = text.slice(start, start + 2) === marker.repeat(2);
  if (doubled) {
    const close = text.indexOf(marker.repeat(2), start + 2);
    if (close === -1) return null;
    const inner = text.slice(start + 2, close);
    if (inner.trim() === "" || /^\s|\s$/u.test(inner)) return null;
    return {
      run: { type: "strong", children: parseInlineRuns(inner, depth + 1) },
      next: close + 2,
    };
  }
  if (marker === "_") {
    // 下划线强调要求词边界，避免把 file_name / snake_case 拆坏。
    const before = start === 0 ? "" : text[start - 1];
    if (before !== "" && /[A-Za-z0-9_]/u.test(before)) return null;
    const close = text.indexOf("_", start + 1);
    if (close === -1) return null;
    const after = text[close + 1] ?? "";
    if (after !== "" && /[A-Za-z0-9_]/u.test(after)) return null;
    const inner = text.slice(start + 1, close);
    if (inner.trim() === "") return null;
    return {
      run: { type: "em", children: parseInlineRuns(inner, depth + 1) },
      next: close + 1,
    };
  }
  const close = text.indexOf("*", start + 1);
  if (close === -1 || text[close + 1] === "*") return null;
  const inner = text.slice(start + 1, close);
  if (inner.trim() === "" || /^\s|\s$/u.test(inner) || inner.includes("\n")) return null;
  return {
    run: { type: "em", children: parseInlineRuns(inner, depth + 1) },
    next: close + 1,
  };
}
