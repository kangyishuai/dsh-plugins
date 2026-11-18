// @ts-check
// 旁问线程与「一键转正」的**纯逻辑**：不 import 任何宿主包，便于 node --test 直接引用
// （service.js 会 import 宿主 RPC 协议，在单测环境里解析不到）。
import { LIMITS } from "./limits.js";
import { parseMarkdown, truncateMarkdown } from "./markdown.js";

/** 转正草稿的四节模板（Markdown 标题；落进输入框是未渲染源码，发送后由 DSH 渲染）。 */
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
  // 短 id：抽屉发问要走 composer，命令文本（`/btw --thread <id> ...`）会短暂出现在
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
 * 把一条记录变成面板可渲染的轮次。
 *
 * `blocks` 是 host 半解析好的 Markdown 树：client 只做 React 元素映射，
 * 既不用在 classic script 里重复写解析器，也不会把模型输出当 HTML 执行。
 * @param {any} record
 * @returns {{
 *   id: string,
 *   question: string,
 *   chars: number,
 *   blocks: any[],
 *   cost: any,
 *   ms: number,
 *   at: number,
 *   status: string,
 * }}
 */
export function threadTurn(record) {
  const answer = String(record?.answer ?? "");
  return {
    id: String(record?.id ?? ""),
    question: String(record?.question ?? ""),
    chars: answer.length,
    blocks: parseMarkdown(answer).blocks,
    cost: record?.cost ?? null,
    ms: Number(record?.ms ?? 0),
    at: Number(record?.at ?? 0),
    status: String(record?.status ?? ""),
  };
}

/**
 * 线程列表（给面板展示）：**旧→新**排序，每项带完整轮次。
 *
 * 为什么改成正序：面板是聊天式界面，最新一条应该落在最下面；
 * 反序会让「刚问的问题」出现在最上面，与自己/常聊天应用的心智相反。
 * @param {any[]} records
 * @returns {{
 *   threadId: string,
 *   turns: number,
 *   question: string,
 *   at: number,
 *   lastId: string,
 *   cost: any,
 *   ms: number,
 *   items: ReturnType<typeof threadTurn>[],
 * }[]}
 */
export function listThreads(records) {
  return groupThreads(records)
    .map((thread) => {
      const items = thread.items.map((record) => threadTurn(record));
      return {
        threadId: thread.threadId,
        turns: items.length,
        question: String(thread.items[0]?.question ?? ""),
        at: thread.at,
        lastId: String(thread.last?.id ?? ""),
        cost: thread.last?.cost ?? null,
        ms: Number(thread.last?.ms ?? 0),
        items,
      };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * 线程级转正：用**首问**当「我问了什么」，用**最后一轮答案**当「结论」。
 *
 * 为什么不是只取最后一轮：线程追问两次后，用户说「转正」通常指整条旁问线索，
 * 只把最后一次追问塞进草稿会丢掉原始问题（2026-11-18 可用性测试发现）。
 * @param {any[]} records 该会话的历史记录
 * @param {string} threadId
 * @returns {any | undefined}
 */
export function promoteRecordForThread(records, threadId) {
  const wanted = String(threadId ?? "");
  if (wanted === "") return undefined;
  const thread = groupThreads(records).find((entry) => entry.threadId === wanted);
  if (thread === undefined) return undefined;
  const first = thread.items[0];
  const last = thread.items[thread.items.length - 1];
  return { ...last, question: String(first?.question ?? last?.question ?? "") };
}

/**
 * 线程追问的问答明细（转正草稿的「关键细节」节）。
 *
 * 只用首问 + 末答会语义错位：首问问 A，最后一轮追问问 B，结论回答的是 B。
 * 把每一轮追问的 Q/A 追加进草稿，读者能看到上下文（2026-11-18 复测发现）。
 * @param {any[]} records
 * @param {string} threadId
 * @param {string} [lang]
 * @returns {string}
 */
export function renderThreadDetails(records, threadId, lang = "zh") {
  const wanted = String(threadId ?? "");
  if (wanted === "") return "";
  const thread = groupThreads(records).find((entry) => entry.threadId === wanted);
  if (thread === undefined || thread.items.length <= 1) return "";
  const en = lang === "en";
  const heading = en ? "Follow-up" : "追问";
  const qLabel = en ? "Q" : "问";
  const aLabel = en ? "A" : "答";
  return thread.items
    .slice(1)
    .map((item, index) => {
      const question = String(item?.question ?? "").trim();
      const answer = String(item?.answer ?? "").trim();
      return `### ${heading} ${index + 1}\n\n**${qLabel}**：${question}\n\n**${aLabel}**：${answer}`;
    })
    .join("\n\n");
}

/**
 * 把一条旁问渲染成可插入草稿的文本（**只生成文本，绝不发送**）。
 *
 * 语义（2026-11-17 与用户确认）：转正保留 **Markdown 源码** —— 四节用 `##` 标题，
 * 落进输入框是未渲染的原文，发送后由 DSH 正常渲染；不再剥掉 `**`/表格/围栏。
 * @param {any} record
 * @param {{ lang?: string, details?: string, unresolved?: string, maxChars?: number }} [options]
 * @returns {string}
 */
export function renderPromoteDraft(record, options = {}) {
  const lang = options.lang === "en" ? "en" : "zh";
  const maxChars = Math.min(
    Math.max(Number(options.maxChars) || LIMITS.promoteChars, 200),
    LIMITS.promoteChars,
  );
  const section = (/** @type {string} */ key) => {
    const found = PROMOTE_SECTIONS.find((entry) => entry.key === key);
    return found === undefined ? key : lang === "en" ? found.en : found.zh;
  };
  const question = String(record?.question ?? "").trim();
  const answer = String(record?.answer ?? "").trim();
  /** @type {string[]} */
  const lines = [
    `## ${section("question")}`,
    "",
    question === "" ? "—" : question,
    "",
    `## ${section("answer")}`,
    "",
    answer === "" ? "—" : answer,
  ];
  const details = String(options.details ?? "").trim();
  if (details !== "") {
    lines.push("", `## ${section("details")}`, "", details);
  }
  const unresolved = String(options.unresolved ?? "").trim();
  if (unresolved !== "") {
    lines.push("", `## ${section("unresolved")}`, "", unresolved);
  }
  const text = lines.join("\n").trim();
  if (text.length <= maxChars) return text;
  // 截断点可能落在代码围栏里：先补闭合，补不下就退到围栏之前，避免输入框里留半段代码。
  return `${truncateMarkdown(text, maxChars - 1)}…`;
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
 * 为什么用「命令行标记」而不是 Remote：抽屉发问必须走 composer 提交，因为真实 Agent
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
