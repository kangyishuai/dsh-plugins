// @ts-check
// bounded-context 的**纯逻辑**：从父会话事件里截取最近若干条 user/assistant 文本，
// 拼成 spawn 子代理的 prompt。不 import 宿主包，便于 node --test 直接引用。
//
// 背景（ADR-0022）：大会话里 fork 整个父会话可能一次花掉几十万 tokens；opt-in 的
// bounded 模式改用 spawn（fresh context）+「最近 N 条消息 + 本次问题」，把成本封顶。
// spawn 不继承父会话、不复用前缀缓存，所以 digest 必须显式、可解释、可测。
import { LIMITS } from "./limits.js";
import { sanitizeReplayAnswer } from "./prompts.js";

/** bounded prompt 的约束说明（英文，与 prompts.js 的 REMINDER 风格一致）。 */
const BOUNDED_REMINDER = `<system-reminder>This is a side question from the user. You are a separate, lightweight agent spawned to answer this one question.

IMPORTANT CONTEXT:
- The main conversation is very large, so you receive ONLY a trimmed excerpt of the most recent messages, not the full conversation.
- The main agent is NOT interrupted - it continues working independently in the background.
- Tool outputs, older turns, and possibly attachments are omitted from the excerpt.

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions.
- Do NOT write tool calls or tool output as text - nothing you write here is executed.
- If answering needs earlier context that is not in the excerpt, say explicitly what is missing; do not guess.
- This is a one-off response - there will be no follow-up turns.

Simply answer the question with the trimmed context you have.</system-reminder>`;

/**
 * 从消息内容块里取纯文本（忽略 reasoning / tool-call 等非回复块）。
 * @param {any} content
 * @returns {string}
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((/** @type {any} */ block) => block?.type === "text" && typeof block.text === "string")
    .map((/** @type {any} */ block) => String(block.text).trim())
    .filter((/** @type {string} */ text) => text !== "")
    .join("\n")
    .trim();
}

/**
 * 抽出可进 digest 的消息（只保留真实用户消息与 assistant 的文本回复）。
 * 过滤：非 user 来源的控制消息、System-reminder 注入、只有工具调用的 assistant 消息。
 * @param {any[]} events
 * @returns {{ role: "User" | "Assistant", text: string }[]}
 */
export function extractBoundedMessages(events) {
  /** @type {{ role: "User" | "Assistant", text: string }[]} */
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "user/message") {
      if (event?.data?.source?.kind !== "user") continue;
      const text = textOfContent(event?.data?.content);
      if (text === "" || text.startsWith("<system-reminder>")) continue;
      out.push({ role: "User", text });
    } else if (event?.type === "assistant/message") {
      const text = textOfContent(event?.data?.message?.content);
      if (text === "") continue;
      out.push({ role: "Assistant", text });
    }
  }
  return out;
}

/**
 * 截取最近 N 条消息并压到总字符预算内（从旧到新保留）。
 * @param {any[]} events
 * @param {{ maxMessages?: number, maxCharsPerMessage?: number, maxTotalChars?: number }} [options]
 * @returns {{ text: string, messages: number, chars: number, truncated: boolean }}
 */
export function buildBoundedDigest(events, options = {}) {
  const maxMessages = Math.max(
    1,
    Math.trunc(Number(options.maxMessages) || LIMITS.boundedMessages),
  );
  const maxCharsPerMessage = Math.max(
    1,
    Math.trunc(Number(options.maxCharsPerMessage) || LIMITS.boundedMessageChars),
  );
  const maxTotalChars = Math.max(
    1,
    Math.trunc(Number(options.maxTotalChars) || LIMITS.boundedTotalChars),
  );
  const all = extractBoundedMessages(events);
  /** @type {{ role: string, text: string }[]} */
  const picked = [];
  let chars = 0;
  for (let index = all.length - 1; index >= 0 && picked.length < maxMessages; index -= 1) {
    const message = all[index];
    const text =
      [...message.text].length > maxCharsPerMessage
        ? `${[...message.text].slice(0, maxCharsPerMessage).join("")}…`
        : message.text;
    if (picked.length > 0 && chars + text.length > maxTotalChars) break;
    picked.unshift({ role: message.role, text });
    chars += text.length;
  }
  return {
    text: picked.map((message) => `${message.role}: ${message.text}`).join("\n\n"),
    messages: picked.length,
    chars,
    truncated: picked.length < all.length,
  };
}

/**
 * 拼 bounded 旁问的 prompt：约束说明 + trimmed excerpt + （可选）线程历史 + 当前问题。
 * 问题永远在末尾（与 fork prompt 一样利于阅读；spawn 无前缀缓存，不涉及缓存）。
 * @param {string} question
 * @param {{ text: string }} digest
 * @param {{ history?: Array<{ question?: unknown, answer?: unknown, status?: unknown }> }} [options]
 * @returns {{ type: "text", text: string }[]}
 */
export function buildBoundedPrompt(question, digest, options = {}) {
  /** @type {string[]} */
  const parts = [BOUNDED_REMINDER];
  parts.push(
    digest.text === ""
      ? "Trimmed conversation excerpt: (no recent messages available)"
      : `Trimmed conversation excerpt (most recent messages, tool outputs omitted):\n\n${digest.text}`,
  );
  const history = Array.isArray(options.history) ? options.history : [];
  if (history.length > 0) {
    const lines = history.map((record, index) => {
      const q = typeof record?.question === "string" ? record.question : "";
      return `Earlier side question ${index + 1}: ${q}\nEarlier answer ${index + 1}: ${sanitizeReplayAnswer(record)}`;
    });
    parts.push(
      `Earlier side questions in this session (for reference only):\n\n${lines.join("\n\n")}`,
    );
  }
  parts.push(`The user's side question now:\n\n${question}`);
  return [{ type: "text", text: parts.join("\n\n") }];
}

/** 导出给测试用（不参与公开 API）。 */
export const INTERNALS = { BOUNDED_REMINDER, textOfContent };
