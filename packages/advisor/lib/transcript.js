// @ts-check
// 把会话历史渲染成顾问能读的纯文本。
//
// 与 next-step 的 renderTranscript 的关键区别：**必须包含工具调用与工具结果**。
// Claude 的 advisor 拿到的是「含每次工具调用与结果」的完整对话；只发文本会丢掉一半信息。
// 本文件不 import 宿主包，方便单测直接喂假消息。
import { redact } from "./redact.js";

/** 我们自己的工具名：绝不喂回顾问（自观察排除）。 */
export const SELF_TOOL_NAMES = Object.freeze(new Set(["advisor"]));

/**
 * 每个块的裁剪上限，按隐私档位取值（字符）。
 * - off：只发人说的话，不发工具往来；
 * - summary：工具参数与结果都摘要（默认）；
 * - full：工具结果放宽 5 倍。
 */
export const SCOPE_LIMITS = Object.freeze({
  off: Object.freeze({ toolArgs: 0, toolResult: 0, text: 1200, context: 0 }),
  summary: Object.freeze({ toolArgs: 300, toolResult: 700, text: 2000, context: 300 }),
  full: Object.freeze({ toolArgs: 1200, toolResult: 3500, text: 4000, context: 2000 }),
});

/**
 * 真人输入 / 用户 RPC 之外的消息来源都算「宿主注入的上下文」（技能目录、AGENTS.md、
 * 运行时事实、模型选择记录…）。它们动辄上万 token，整段发给顾问会让一次徵询贵得离谱，
 * 而这些内容对「这次改动对不对」几乎没有增量信息 —— 默认只留一个带长度的标记。
 * @param {any} message
 * @returns {boolean}
 */
export function isInjectedContext(message) {
  if (message?.role !== "user") return false;
  const kind = message?.source?.kind;
  return kind !== undefined && kind !== "user" && kind !== "user-rpc";
}

/**
 * 裁剪一段文本并留下可核对的痕迹。
 * @param {string} text
 * @param {number} limit 0 表示整段丢弃
 * @returns {string}
 */
export function clip(text, limit) {
  const value = typeof text === "string" ? text : "";
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…（已截断，原长 ${value.length} 字符）`;
}

/**
 * 取一条消息里所有文本块的纯文本（忽略 reasoning / 图片 / 文件）。
 * @param {any} message
 * @returns {string}
 */
export function textOf(message) {
  if (!message || !Array.isArray(message.content)) return "";
  let out = "";
  for (const block of message.content) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out.trim();
}

/**
 * 取 assistant 消息里的工具调用（name + 参数 + callId）。
 * @param {any} message
 * @returns {Array<{ id: string, name: string, args: string }>}
 */
export function toolCallsOf(message) {
  if (!message || !Array.isArray(message.content)) return [];
  /** @type {Array<{ id: string, name: string, args: string }>} */
  const out = [];
  for (const block of message.content) {
    if (block && block.type === "tool-call") {
      out.push({
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "tool",
        args: typeof block.arguments === "string" ? block.arguments : "",
      });
    }
  }
  return out;
}

/**
 * 用户消息的「来源」标签：区分真人输入、插件注入的上下文、运行时事实。
 * 顾问需要知道哪些是用户亲口说的，哪些是宿主塞进去的。
 * @param {any} message
 * @returns {string}
 */
export function speakerOf(message) {
  const role = message?.role;
  const kind = message?.source?.kind;
  if (role === "tool") return "工具结果";
  if (role === "assistant") return "助手";
  if (role === "user") {
    if (kind === undefined || kind === "user" || kind === "user-rpc") return "用户";
    return `上下文(${String(kind)})`;
  }
  return String(role ?? "未知");
}

/**
 * @typedef {object} TranscriptOptions
 * @property {"off"|"summary"|"full"} [scope]
 * @property {boolean} [redactSecrets]
 * @property {number} [maxChars] 总字符预算
 */

/**
 * 渲染会话历史。返回文本 + 统计（供工具卡与诊断显示「发了多少、截了多少」）。
 * @param {any[]} messages `session.deriveMessages()` 的结果
 * @param {TranscriptOptions} [options]
 * @returns {{ text: string, stats: { messages: number, toolCalls: number, toolResults: number, contextOmitted: number, truncated: number, redactions: string[] } }}
 */
export function buildTranscript(messages, options = {}) {
  const scope = options.scope === "full" ? "full" : options.scope === "off" ? "off" : "summary";
  const limits = SCOPE_LIMITS[scope];
  const maxChars = Number.isFinite(options.maxChars) ? Number(options.maxChars) : 60000;
  const shouldRedact = options.redactSecrets !== false;
  /** 被排除的工具调用 id（顾问自己的调用）：它们的结果也不能回喂。 */
  const excludedCalls = new Set();
  const toolFlowEnabled = limits.toolArgs > 0 || limits.toolResult > 0;

  /** @type {string[]} */
  const redactions = [];
  /** @type {string[]} */
  const blocks = [];
  let messageCount = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let contextOmitted = 0;
  let truncated = 0;

  /**
   * @param {string} raw
   * @param {number} limit
   * @param {boolean} [applyRedaction]
   * @returns {string}
   */
  const prepare = (raw, limit, applyRedaction = true) => {
    if (limit <= 0) return "";
    let value = raw;
    if (shouldRedact && applyRedaction) {
      const result = redact(value);
      value = result.text;
      for (const hit of result.hits) if (!redactions.includes(hit)) redactions.push(hit);
    }
    const clipped = clip(value, limit);
    if (clipped !== value) truncated += 1;
    return clipped;
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role === "system" || role === "developer") continue;
    messageCount += 1;

    if (role === "tool") {
      if (limits.toolResult <= 0) continue;
      if (excludedCalls.has(String(message?.toolCallId ?? ""))) continue;
      toolResults += 1;
      const body = prepare(textOf(message), limits.toolResult);
      if (body === "") continue;
      const flag = message?.isError === true ? "（失败）" : "";
      blocks.push(`[工具结果${flag}] ${body}`);
      continue;
    }

    // 宿主注入的上下文：留长度标记，正文默认不发（见 isInjectedContext 的注释）。
    if (isInjectedContext(message)) {
      const raw = textOf(message);
      if (raw === "") continue;
      const kept = prepare(raw, limits.context);
      contextOmitted += Math.max(0, raw.length - kept.length);
      blocks.push(
        `[上下文(${String(message?.source?.kind)})] ${kept === "" ? `已省略 ${raw.length} 字符` : kept}`,
      );
      continue;
    }

    const texts = prepare(textOf(message), limits.text);
    if (texts !== "") blocks.push(`[${speakerOf(message)}] ${texts}`);

    if (role === "assistant" && toolFlowEnabled) {
      for (const call of toolCallsOf(message)) {
        if (SELF_TOOL_NAMES.has(call.name)) {
          if (call.id !== "") excludedCalls.add(call.id);
          continue;
        }
        toolCalls += 1;
        const args = prepare(call.args, limits.toolArgs);
        blocks.push(`[工具调用] ${call.name}(${args})`);
      }
    }
  }

  let text = blocks.join("\n\n");
  if (text.length > maxChars) {
    // 保留开头（任务与约束）与结尾（最近的进展），中间折叠。
    const headSize = Math.floor(maxChars * 0.3);
    const tailSize = maxChars - headSize;
    const head = text.slice(0, headSize);
    const tail = text.slice(text.length - tailSize);
    text = `${head}\n\n…（中间省略 ${text.length - maxChars} 字符）…\n\n${tail}`;
    truncated += 1;
  }

  return {
    text,
    stats: {
      messages: messageCount,
      toolCalls,
      toolResults,
      contextOmitted,
      truncated,
      redactions,
    },
  };
}
