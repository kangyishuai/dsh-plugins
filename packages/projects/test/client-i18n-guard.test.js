// @ts-check
// AUD-projects-ui-02：`locale-parity.test.js` 只锁「字典 ↔ locale/*.json」这一层，
// 渲染代码里的**硬编码中文**完全不经过字典，所以那条测试一直是绿的（假信心）。
// 这里补一条机械守卫：client.js 的**字符串/模板字面量**里不允许出现 CJK 字符，
// 字典区（ZH/EN 两个对象字面量）与注释除外——所有用户可见文案都必须走 `text(t, "key")`。
//
// 守卫的适用范围：渲染代码（字典之外的整份 client.js）。发现新增中文文案时，
// 正确做法是往 ZH/EN/locale 三处加键，而不是往这里加豁免。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const CLIENT_URL = new URL("../lib/client.js", import.meta.url);

/** CJK 汉字 + CJK 标点 + 全角标点（`＋` `（）` `：` 这类同样会漏进英文界面）。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff60]/u;

/**
 * 从 `var <name> = {` 开始按花括号配对找字典区（字符串内的括号不计数）。
 * @param {string} source @param {"ZH"|"EN"} name
 * @returns {{start: number, end: number}}
 */
function dictionaryRange(source, name) {
  const marker = `var ${name} = {`;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `client.js 里找不到 ${marker}`);
  const start = source.indexOf("{", at);
  let depth = 0;
  /** @type {string|null} */
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index };
    }
  }
  throw new Error(`字典 ${name} 没有闭合`);
}

/**
 * 扫出「代码模式」下字符串/模板字面量里的 CJK 命中，行号 1 起。
 * 注释、正则字面量、字典区不参与；模板的 `${...}` 按代码继续扫（支持嵌套模板）。
 * @param {string} source
 * @returns {{line: number, literal: string}[]}
 */
function cjkLiterals(source) {
  const ranges = [dictionaryRange(source, "ZH"), dictionaryRange(source, "EN")];
  /** @param {number} at */
  const inDictionary = (at) => ranges.some((range) => at >= range.start && at <= range.end);
  /** @type {{line: number, literal: string}[]} */
  const hits = [];
  let line = 1;
  let index = 0;
  /**
   * 状态机：code 里嵌 template，template 里嵌 code（`${`），code 里再嵌 template …
   * 只保留最近一层字面量的起点，用于命中时回标题。
   * @type {{kind: "code"|"template"|"single"|"double"|"regex"|"lineComment"|"blockComment", braces: number, start: number, startLine: number}[]}
   */
  const stack = [{ kind: "code", braces: 0, start: 0, startLine: 1 }];
  const top = () => stack[stack.length - 1];
  /** @param {number} start @param {number} startLine @param {number} endAt */
  const record = (start, startLine, endAt) => {
    const literal = source.slice(start, endAt);
    if (!inDictionary(start) && CJK.test(literal)) {
      hits.push({ line: startLine, literal: literal.replace(/\s+/gu, " ").slice(0, 120) });
    }
  };
  // 代码模式里 `/` 处于这些前导字符/关键字之后时按正则字面量解析，否则按除法。
  const regexPreceded = () => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/u.test(source[cursor])) cursor -= 1;
    if (cursor < 0) return true;
    const prev = source[cursor];
    if ("=(!,:;{[&|?+-*%<>~^".includes(prev)) return true;
    return /(?:^|[^\w$])(return|typeof|case|in|of|new|delete|void|throw|instanceof)$/u.test(
      source.slice(Math.max(0, cursor - 12), cursor + 1),
    );
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    const state = top();
    if (char === "\n") line += 1;
    if (state.kind === "lineComment") {
      if (char === "\n") stack.pop();
      index += 1;
      continue;
    }
    if (state.kind === "blockComment") {
      if (char === "*" && next === "/") {
        stack.pop();
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (state.kind === "single" || state.kind === "double") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if ((state.kind === "single" && char === "'") || (state.kind === "double" && char === '"')) {
        record(state.start, state.startLine, index);
        stack.pop();
      }
      index += 1;
      continue;
    }
    if (state.kind === "regex") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "/") {
        stack.pop();
        index += 1;
        while (index < source.length && /[a-z]/u.test(source[index])) index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (state.kind === "template") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        record(state.start, state.startLine, index);
        stack.pop();
        index += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        stack.push({ kind: "code", braces: 1, start: index + 2, startLine: line });
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    // code
    if (char === "/" && next === "/") {
      stack.push({ kind: "lineComment", braces: 0, start: index, startLine: line });
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      stack.push({ kind: "blockComment", braces: 0, start: index, startLine: line });
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      stack.push({
        kind: char === '"' ? "double" : "single",
        braces: 0,
        start: index + 1,
        startLine: line,
      });
      index += 1;
      continue;
    }
    if (char === "`") {
      stack.push({ kind: "template", braces: 0, start: index + 1, startLine: line });
      index += 1;
      continue;
    }
    if (char === "/" && regexPreceded()) {
      stack.push({ kind: "regex", braces: 0, start: index, startLine: line });
      index += 1;
      continue;
    }
    if (char === "{") state.braces += 1;
    if (char === "}") {
      state.braces -= 1;
      if (state.braces === 0 && stack.length > 1) {
        stack.pop();
        index += 1;
        continue;
      }
    }
    index += 1;
  }
  return hits;
}

test("AUD-projects-ui-02：渲染代码的字符串字面量里没有硬编码 CJK", async () => {
  const source = await readFile(CLIENT_URL, "utf8");
  const hits = cjkLiterals(source);
  assert.deepEqual(
    hits,
    [],
    `client.js 还有 ${hits.length} 处硬编码 CJK 字面量（应进 ZH/EN/locale）：\n` +
      hits.map((hit) => `  :${hit.line} ${hit.literal}`).join("\n"),
  );
});

test("CJK 守卫能抓住故意注入的中文文案（自检，防守卫本身失效）", () => {
  const injected = `${readFixture()}\nvar leak = "这是硬编码中文";\n`;
  const hits = cjkLiterals(injected);
  assert.equal(hits.length, 1, "守卫必须能抓住新增硬编码");
  assert.match(hits[0].literal, /硬编码中文/u);
  assert.equal(hits[0].line, readFixture().split("\n").length + 1);
});

test("CJK 守卫不误报字典区/注释/纯 ASCII（自检）", () => {
  const fixture = readFixture();
  assert.deepEqual(cjkLiterals(fixture), []);
});

function readFixture() {
  // 小样本：字典区里是合法中文；注释里中文合法；代码字符串必须是 ASCII。
  return [
    "var ZH = {",
    '  "a": "中文",',
    "};",
    'var ok = "ascii only";',
    "// 注释里的中文不是界面文案",
    "/* 块注释里的中文也不是 */",
    "var EN = {",
    '  "a": "English",',
    "};",
    "",
  ].join("\n");
}
