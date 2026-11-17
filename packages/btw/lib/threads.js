// @ts-check
// 旁问线程与「一键转正」的**纯逻辑**：不 import 任何宿主包，便于 node --test 直接引用
// （service.js 会 import 宿主 RPC 协议，在单测环境里解析不到）。
import { LIMITS } from "./limits.js";

/** 转正草稿的四节模板（用户可在插入前编辑）。 */
export const PROMOTE_SECTIONS = [
  { key: "question", zh: "我问了什么", en: "What I asked" },
  { key: "answer", zh: "结论", en: "Conclusion" },
  { key: "details", zh: "关键细节", en: "Key details" },
  { key: "unresolved", zh: "仍未解决", en: "Still unresolved" },
];

/**
 * 新线程 id。用时间 + 随机后缀，够本地唯一，不引入 uuid 依赖。
 * @param {number} [now]
 * @param {() => number} [rand]
 * @returns {string}
 */
export function newThreadId(now = Date.now(), rand = Math.random) {
  // 短 id：浮层发问要走 composer，命令文本（`/btw --thread <id> ...`）会短暂出现在
  // 用户输入框里，id 越短越不刺眼。实测 16 字符的 `t_mwkfmjk1_qrb3` 太显眼。
  // 单机单会话内冲突概率可忽略（时间 36 进制 + 2 位随机）。
  const suffix = Math.floor(rand() * 36 ** 2)
    .toString(36)
    .padStart(2, "0");
  return `t_${now.toString(36)}${suffix}`;
}

/**
 * 取记录所属线程 id：兼容没有 threadId 的老记录（用记录自身 id 当单条线程）。
 * @param {any} record
 * @returns {string}
 */
export function threadOf(record) {
  if (record !== null && typeof record === "object") {
    if (typeof record.threadId === "string" && record.threadId !== "") return record.threadId;
    if (typeof record.id === "string" && record.id !== "") return record.id;
  }
  return "t_unknown";
}

/**
 * 按线程分组，线程内按时间正序。
 * @param {any[]} records 时间正序的记录
 * @returns {{ threadId: string, items: any[], at: number, last: any }[]} 按线程最后一条时间正序
 */
export function groupThreads(records) {
  /** @type {Map<string, any[]>} */
  const buckets = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = threadOf(record);
    const bucket = buckets.get(id);
    if (bucket === undefined) buckets.set(id, [record]);
    else bucket.push(record);
  }
  /** @type {{ threadId: string, items: any[], at: number, last: any }[]} */
  const out = [];
  for (const [threadId, items] of buckets) {
    const last = items[items.length - 1];
    out.push({ threadId, items, at: Number(last?.at ?? 0), last });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * 某线程的历史（供追问时回放给模型）。
 * @param {any[]} records
 * @param {string} threadId
 * @param {number} [maxTurns]
 * @returns {any[]}
 */
export function threadHistory(records, threadId, maxTurns = LIMITS.threadTurns) {
  const thread = groupThreads(records).find((entry) => entry.threadId === threadId);
  if (thread === undefined) return [];
  return thread.items.slice(-maxTurns);
}

/**
 * 把一条旁问渲染成可插入草稿的文本（**只生成文本，绝不发送**）。
 *
 * 语义取舍（已与用户确认）：转正只插入 composer 草稿，由用户自己决定发不发。
 * @param {any} record
 * @param {{ lang?: string, details?: string, unresolved?: string, maxChars?: number }} [options]
 * @returns {string}
 */
export function renderPromoteDraft(record, options = {}) {
  const lang = options.lang === "en" ? "en" : "zh";
  const maxChars = Math.min(
    Math.max(Number(options.maxChars) || LIMITS.answerChars, 200),
    LIMITS.answerChars,
  );
  const section = (/** @type {string} */ key) => {
    const found = PROMOTE_SECTIONS.find((entry) => entry.key === key);
    return found === undefined ? key : lang === "en" ? found.en : found.zh;
  };
  const question = stripMarkdown(String(record?.question ?? ""));
  const answer = stripMarkdown(String(record?.answer ?? ""));
  /** @type {string[]} */
  const lines = [
    `【${section("question")}】`,
    question === "" ? "—" : question,
    "",
    `【${section("answer")}】`,
    answer === "" ? "—" : answer,
  ];
  const details = stripMarkdown(String(options.details ?? ""));
  if (details !== "") lines.push("", `【${section("details")}】`, details);
  const unresolved = stripMarkdown(String(options.unresolved ?? ""));
  if (unresolved !== "") lines.push("", `【${section("unresolved")}】`, unresolved);
  const text = lines.join("\n").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * 去掉常见 Markdown 标记，让文本适合直接放进输入框。
 *
 * 为什么必须做：实测用户点「转正」后，输入框里塞进来的是 `## 我问了什么`、
 * `**每个 PR 上实际出现的检查是 8 个**`、`|---|` 这类源码，用户原话是
 * 「为什么给我一堆井号和竖线？」。我们没有 Markdown 渲染器（ADR 0001 不引入构建），
 * 所以草稿必须自己变成纯文本。
 * @param {string} text
 * @returns {string}
 */
/**
 * 去掉常见 Markdown 标记，让文本适合直接阅读/放进输入框。
 *
 * @param {string} text
 * @param {{ keepCode?: boolean }} [options] keepCode 默认 true：``` 围栏内的内容原样保留
 *   （代码缩进有意义，清掉会毁掉可读性）。
 * @returns {string}
 */
export function stripMarkdown(text, options = {}) {
  const raw = String(text ?? "");
  if (options.keepCode === false) return stripAllMarkdown(raw);
  // 先把围栏块抽出占位，避免下面的标记清理破坏代码内容。
  /** @type {string[]} */
  const fences = [];
  const parked = raw.replace(
    /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gu,
    (/** @type {string} */ _m, /** @type {string} */ body) => {
      fences.push(body.replace(/\n+$/u, ""));
      return `@@BTWFENCE${fences.length - 1}@@`;
    },
  );
  const cleaned = stripAllMarkdown(parked).replace(
    /@@BTWFENCE(\d+)@@/gu,
    (/** @type {string} */ _m, /** @type {string} */ i) => `\n${fences[Number(i)] ?? ""}\n`,
  );
  return cleaned.replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * 纯标记清理（条目级，不含代码块保护）。
 * @param {string} text
 * @returns {string}
 */
function stripAllMarkdown(text) {
  return (
    String(text ?? "")
      .replace(/^\s{0,3}#{1,6}\s+/gmu, "") // 标题井号
      .replace(/^[ \t]*\|?[\s:|\t-]+\|[\s:|\t-]*$/gmu, "") // 表格分隔行 |---|---|
      // 表格数据行 | a | b | → "a — b"（竖线对普通用户就是噪音）
      .replace(
        /^[ \t]*\|(.+)\|[ \t]*$/gmu,
        (/** @type {string} */ _m, /** @type {string} */ body) =>
          body
            .split("|")
            .map((cell) => cell.trim())
            .filter((cell) => cell !== "")
            .join(" — "),
      )
      .replace(/\*\*([^*\n]+)\*\*/gu, "$1") // **粗体**
      .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/gu, "$1") // *斜体*
      .replace(/`{3,}[a-z]*\n?/giu, "") // ``` 代码围栏
      .replace(/`([^`\n]+)`/gu, "$1") // `行内代码`
      .replace(/^\s*[-*+]\s+/gmu, "· ") // 列表符号
      .replace(/^\s*>\s?/gmu, "") // 引用
      .replace(/\n{3,}/gu, "\n\n") // 压掉多余空行
      .trim()
  );
}

/**
 * 从答案里猜「关键细节」候选（列表项/代码片段），给转正确认层做默认值。
 * @param {string} answer
 * @param {number} [max]
 * @returns {string[]}
 */
export function extractDetails(answer, max = 5) {
  const lines = String(answer ?? "").split("\n");
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^([-*+]|\d+\.)\s+/.test(trimmed) || trimmed.startsWith("```")) {
      out.push(trimmed);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** 追问时夹带的线程标记：`/btw --thread <id> <问题>`。 */
export const THREAD_FLAG = "--thread";

/**
 * 解析命令参数里的线程标记。
 *
 * 为什么用「命令行标记」而不是 Remote：浮层发问必须走 composer 提交，因为真实 Agent
 * 只能从命令上下文拿到（见 ADR 0016）。所以线程 id 只能随这行文本一起传进来。
 * @param {string} raw
 * @returns {{ threadId: string, question: string }}
 */
export function parseThreadFlag(raw) {
  const text = String(raw ?? "").trim();
  if (!text.startsWith(THREAD_FLAG)) return { threadId: "", question: text };
  const rest = text.slice(THREAD_FLAG.length).trimStart();
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (match === null) return { threadId: "", question: text };
  return { threadId: match[1], question: match[2].trim() };
}

/**
 * 线程列表（给浮层展示）：按最后一条时间倒序，每项带条数与首问。
 * @param {any[]} records
 * @returns {{ threadId: string, turns: number, question: string, answer: string, answerPlain: string, lastId: string, cost: any, ms: number, at: number }[]}
 */
export function listThreads(records) {
  return groupThreads(records)
    .map((thread) => ({
      threadId: thread.threadId,
      turns: thread.items.length,
      question: String(thread.items[0]?.question ?? ""),
      answer: String(thread.last?.answer ?? ""),
      // 展示用：去掉 Markdown 噪音但保留代码块（列表里显示原文的话，用户看到的是
      // `**粗体**`、`|表|格|`、`|---|`，实测被抱怨「为什么给我一堆井号和竖线」）。
      answerPlain: stripMarkdown(String(thread.last?.answer ?? "")),
      lastId: String(thread.last?.id ?? ""),
      cost: thread.last?.cost ?? null,
      ms: Number(thread.last?.ms ?? 0),
      at: thread.at,
    }))
    .sort((a, b) => b.at - a.at);
}

/** 范围档位（枚举，避免自由文本带来的歧义）。 */
export const SCOPES = ["session", "recent", "selection"];

/**
 * 解析命令参数里的全部标记：`--thread <id>` 与 `--scope <档位>`。
 * 两者都只吃一个 token，剩下的整段是问题（问题里可以有空格）。
 * @param {string} raw
 * @returns {{ threadId: string, scope: string, question: string }}
 */
export function parseCommandArgs(raw) {
  let rest = String(raw ?? "").trim();
  let threadId = "";
  let scope = "";
  for (;;) {
    const threadMatch = /^--thread\s+(\S+)\s*/.exec(rest);
    if (threadMatch !== null && threadId === "") {
      threadId = threadMatch[1];
      rest = rest.slice(threadMatch[0].length);
      continue;
    }
    const scopeMatch = /^--scope\s+(\S+)\s*/.exec(rest);
    if (scopeMatch !== null && scope === "") {
      const candidate = scopeMatch[1].toLowerCase();
      if (SCOPES.includes(candidate)) scope = candidate;
      rest = rest.slice(scopeMatch[0].length);
      continue;
    }
    break;
  }
  return { threadId, scope, question: rest.trim() };
}
