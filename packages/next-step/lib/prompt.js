// @ts-check
// 提示词与输出解析：纯函数，不 import 宿主包（单测可以直接跑）。
// 一次调用同时产出三样东西：摘要 + 提问、两条互斥动作、一条给输入框的幽灵提示。

/** 摘要最大字符数（1–3 句，超出视为模型跑偏）。 */
export const SUMMARY_MAX = 400;
/** 提问最大字符数。 */
export const QUESTION_MAX = 200;
/** 按钮文案最大字符数（胶囊必须放得下）。 */
export const LABEL_MAX = 20;
/** 动作文本最大字符数（点击后原样发出，太长说明它不自足）。 */
export const TEXT_MAX = 240;
/** 幽灵提示最大字符数。 */
export const NEXT_PROMPT_MAX = 120;
/** stance 最大字符数。 */
export const STANCE_MAX = 40;

/**
 * 取一条消息里的纯文本（忽略 reasoning / 工具块）。
 * @param {any} message DSH Message
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
 * 把最近若干条对话渲染成一段纯文本，供提示词使用。
 * 只保留 user / assistant 的文本，逐条裁剪，避免把整段历史塞进一次短调用。
 * @param {any[]} messages deriveMessages() 的结果
 * @param {{ limit?: number, clip?: number }} [options]
 * @returns {string}
 */
export function renderTranscript(messages, options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? Number(options.limit) : 12;
  const clip = Number.isSafeInteger(options.clip) ? Number(options.clip) : 800;
  const kept = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(message);
    if (text === "") continue;
    const clipped = text.length > clip ? `${text.slice(0, clip)}…` : text;
    kept.push(`${role === "user" ? "用户" : "助手"}：${clipped}`);
  }
  return kept.slice(-Math.max(1, limit)).join("\n\n");
}

/**
 * 系统提示词：只做一件事——把最近对话压成一张决策卡，严格 JSON。
 * @param {{ locale?: string }} [options]
 * @returns {string}
 */
export function buildSystemPrompt(options = {}) {
  const locale =
    typeof options.locale === "string" && options.locale !== "" ? options.locale : "auto";
  return [
    "你是一个「下一步决策卡」生成器。读下面这段对话，判断用户读完最后一条回复后最可能需要做的两个方向。",
    "只输出一个 JSON 对象，不要输出任何解释、不要用代码围栏。",
    "",
    "JSON 结构：",
    '{ "summary": "…", "question": "…", "options": [ { "stance": "…", "label": "…", "text": "…" }, { "stance": "…", "label": "…", "text": "…" } ], "nextPrompt": "…" }',
    "",
    "要求：",
    "1. summary：1–3 句，客观陈述当前状态（做到哪、卡在哪、还差什么），不评价、不客套。",
    "2. question：一句向用户确认方向的问题，必须以问号结尾。",
    `3. options：恰好 2 条，方向互斥（例如「按方案 A 改」vs「先补测试」），不能是同一件事的两种说法。`,
    `   - stance：英文小写短语标识立场，两条必须不同（如 verify / proceed / harder / alternative）。`,
    `   - label：按钮文案，${LABEL_MAX} 字以内，动词开头。`,
    `   - text：用户口吻、可独立执行的完整指令，${TEXT_MAX} 字以内；单独发出去就能干活，不要用「继续」「好的」这类悬空短语，不要问「需要我…吗」。`,
    `4. nextPrompt：一句用户口吻的下一句输入建议，${NEXT_PROMPT_MAX} 字以内；关键信息放前 40 字内。`,
    `5. 语言：跟随对话中用户使用的语言（当前界面语言 ${locale}，仅供参考）。`,
    "6. 信息不足时，两个方向应当是「先补信息」与「按现有信息推进」，不要编造事实。",
  ].join("\n");
}

/**
 * 构造一次补全的 messages（纯对象；由 service 转成宿主 Message）。
 * @param {{ transcript?: string, locale?: string }} [input]
 * @returns {{ role: "user", content: { type: "text", text: string }[] }[]}
 */
export function buildMessages(input = {}) {
  const transcript = typeof input.transcript === "string" ? input.transcript.trim() : "";
  const body = transcript === "" ? "（没有可用的对话内容）" : transcript;
  return [
    {
      role: "user",
      content: [{ type: "text", text: `以下是最近的对话，请生成决策卡。\n\n${body}` }],
    },
  ];
}

/**
 * 从模型输出里抠出 JSON 并校验；任何一处不合法就返回 null（整条丢弃，绝不截断）。
 * @param {unknown} raw
 * @returns {{ summary: string, question: string, options: { stance: string, label: string, text: string }[], nextPrompt?: string } | null}
 */
export function parseSuggestion(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text === "") return null;
  // 去掉 ```json … ``` / ``` … ``` 围栏
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/u.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  // 容忍前后多余文字：取第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  text = text.slice(start, end + 1);

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  if (summary === "" || summary.length > SUMMARY_MAX) return null;
  if (question === "" || question.length > QUESTION_MAX) return null;

  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  if (rawOptions.length !== 2) return null;
  /** @type {{ stance: string, label: string, text: string }[]} */
  const options = [];
  for (const option of rawOptions) {
    if (option === null || typeof option !== "object") return null;
    const stance = typeof option.stance === "string" ? option.stance.trim().toLowerCase() : "";
    const label = typeof option.label === "string" ? option.label.trim().replace(/\s+/gu, " ") : "";
    const actionText = typeof option.text === "string" ? option.text.trim() : "";
    if (stance === "" || stance.length > STANCE_MAX) return null;
    if (label === "" || label.length > LABEL_MAX) return null;
    if (actionText.length < 4 || actionText.length > TEXT_MAX) return null;
    options.push({ stance, label, text: actionText });
  }
  if (options[0].stance === options[1].stance) return null;

  /** @type {{ summary: string, question: string, options: { stance: string, label: string, text: string }[], nextPrompt?: string }} */
  const result = { summary, question, options };
  if (parsed.nextPrompt !== undefined) {
    const nextPrompt = typeof parsed.nextPrompt === "string" ? parsed.nextPrompt.trim() : "";
    if (nextPrompt.length > NEXT_PROMPT_MAX) return null;
    if (nextPrompt !== "") result.nextPrompt = nextPrompt;
  }
  return result;
}
