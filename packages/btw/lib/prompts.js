// @ts-check
// 旁问提示词与非可信内容的消毒。文案取向参考 Claude Code 的 /btw 提示词（见 notes 调研）。

import { renderScopeInstruction } from "./badge.js";

/** 单轮只读旁问的系统约束。刻意保持祈使、简短、禁止承诺类措辞。 */
const REMINDER = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Do NOT write tool calls or tool output as text (for example invoke or function_calls XML blocks) - nothing you write here is executed; if answering would need reading files, running commands, or searching, say that can't be checked from a side question and suggest asking in the main conversation
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

/** 上一轮坏答案的替代文案（避免模型把文字工具调用当成范例继续模仿）。 */
const OMITTED_TOOLCALLS =
  "(That answer wrote tool calls as text. Nothing was executed, so it is omitted here.)";
/** 上一轮被截断的替代文案。 */
const OMITTED_CUT = "(That answer was cut off before it finished, so it is omitted here.)";

/**
 * 判断答案是否像「把工具调用写成了文字」。
 * @param {unknown} response
 * @returns {boolean}
 */
export function looksLikeToolCalls(response) {
  const text = typeof response === "string" ? response : "";
  if (text === "") return false;
  return /<\/?invoke\b|<function_calls>|<function_call\b|"tool_use_id"|\btool_calls\b/i.test(text);
}

/**
 * 消毒一条历史答案：坏内容替换成一句说明。
 * @param {{ answer?: unknown, status?: unknown }} record
 * @returns {string}
 */
export function sanitizeReplayAnswer(record) {
  const answer = typeof record?.answer === "string" ? record.answer : "";
  if (looksLikeToolCalls(answer)) return OMITTED_TOOLCALLS;
  if (record?.status === "truncated") return OMITTED_CUT;
  return answer;
}

/**
 * 拼一次旁问的 prompt。历史在前、当前问题在后，问题永远在末尾（利于前缀缓存）。
 * @param {string} question
 * @param {Array<{ question?: unknown, answer?: unknown, status?: unknown }>} [history]
 * @returns {{ type: 'text', text: string }[]}
 */
export function buildSideQuestionPrompt(question, history = [], scope = "") {
  /** @type {string[]} */
  const parts = [REMINDER];
  if (history.length > 0) {
    const lines = history.map((record, index) => {
      const q = typeof record.question === "string" ? record.question : "";
      return `Previous side question ${index + 1}: ${q}\nPrevious answer ${index + 1}: ${sanitizeReplayAnswer(record)}`;
    });
    parts.push(
      `Earlier side questions in this session (for your reference only):\n\n${lines.join("\n\n")}`,
    );
  }
  // 范围只作为**建议**写进提示词：fork 继承全部已完成轮次，插件无法裁剪上下文（ADR 0016）。
  const scopeText = renderScopeInstruction(scope);
  if (scopeText !== "") parts.push(scopeText);
  parts.push(`The user's side question now:\n\n${question}`);
  return [{ type: "text", text: parts.join("\n\n") }];
}

/** 导出给测试用（不参与公开 API）。 */
export const INTERNALS = { REMINDER, OMITTED_TOOLCALLS, OMITTED_CUT };
