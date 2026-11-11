// @ts-check
// 提示词与输出解析：纯函数，不 import 宿主包（单测可以直接跑）。
// 一次调用同时产出四样东西：是否需要继续、判断依据、摘要 + 提问 + 两条动作、一条给输入框的幽灵提示。
//
// 设计要点（v0.2，见 ADR 0009 的增补）：
// - `needed` 由模型自评：只有这一轮结束后**真的值得继续**时才出卡；否则只返回判断与理由。
//   没有这一步时，每轮都硬出一张卡，答得越完整越吵。
// - `label` 就是点击后原样发送的用户消息（WYSIWYG），不再有隐藏的 `text` 字段：
//   用户看到什么、发出去的就是什么，日志、回显、消息三者一致。

/** 摘要最大字符数（1–3 句，超出视为模型跑偏）。 */
export const SUMMARY_MAX = 400;
/** 提问最大字符数。 */
export const QUESTION_MAX = 200;
/** 按钮文案最大字符数（它同时是要发送的消息，允许两行）。 */
export const LABEL_MAX = 60;
/** 按钮文案最少字符数（太短多半是「继续」这种悬空指令）。 */
export const LABEL_MIN = 4;
/** 判断依据最大字符数（会显示在诊断里）。 */
export const REASON_MAX = 160;
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
 * 系统提示词：只做一件事——判断这一轮是否值得继续，并把对话压成一张决策卡，严格 JSON。
 * @param {{ locale?: string }} [options]
 * @returns {string}
 */
export function buildSystemPrompt(options = {}) {
  const locale =
    typeof options.locale === "string" && options.locale !== "" ? options.locale : "auto";
  return [
    "你是一个「下一步决策卡」生成器。读下面这段对话，先判断用户读完最后一条回复后是否真的需要继续，再给出判断依据与卡片内容。",
    "只输出一个 JSON 对象，不要输出任何解释、不要用代码围栏。",
    "",
    "JSON 结构：",
    '{ "needed": true|false, "reason": "…", "summary": "…", "question": "…", "options": [ { "stance": "…", "label": "…" }, { "stance": "…", "label": "…" } ], "nextPrompt": "…" }',
    "",
    "要求：",
    "1. needed：布尔值，表示「这一轮结束后，用户是否真的值得继续」。",
    "   - false：任务已完整收尾、没有自然的下一步；最后的回答已经向用户提出了明确的问题或请求；用户已表示结束（如「不用了」「谢谢」）；继续只会重复劳动。",
    "   - true：存在需要用户拍板的方向，或存在明显值得继续做下去的下一步。",
    `2. reason：一句话说明 needed 的判断依据，${REASON_MAX} 字以内，直接说事实，不要客套。`,
    "3. summary：1–3 句客观陈述当前状态（做到哪、卡在哪、还差什么），不评价、不客套。",
    "4. question：一句向用户确认方向的问题，必须以问号结尾。",
    `5. options：恰好 2 条，方向互斥（例如「按方案 A 改」vs「先补测试」），不能是同一件事的两种说法。`,
    "   - stance：英文小写短语标识立场，两条必须不同（如 verify / proceed / harder / alternative）。",
    `   - label：按钮文案，也就是用户点一下后**原样发送**给助手的用户消息；${LABEL_MIN}–${LABEL_MAX} 字，动词开头，单独发出去就能干活。`,
    "     不要用「继续」「好的」这类悬空短语，不要写成问句，不要把解释塞进 label。",
    `6. nextPrompt：一句用户口吻的下一句输入建议，${NEXT_PROMPT_MAX} 字以内；关键信息放前 40 字内。`,
    `7. 语言：跟随对话中用户使用的语言（当前界面语言 ${locale}，仅供参考）。`,
    "8. needed 为 false 时也要按上面的结构给出 summary / question / options —— 用户可能手动请求这张卡。",
    "9. 信息不足时，两个方向应当是「先补信息」与「按现有信息推进」，不要编造事实。",
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
 * @returns {{ needed: boolean, reason: string, summary: string, question: string, options: { stance: string, label: string }[], nextPrompt?: string } | null}
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

  if (typeof parsed.needed !== "boolean") return null;
  const needed = parsed.needed;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (reason === "" || reason.length > REASON_MAX) return null;

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  if (summary === "" || summary.length > SUMMARY_MAX) return null;
  if (question === "" || question.length > QUESTION_MAX) return null;

  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  if (rawOptions.length !== 2) return null;
  /** @type {{ stance: string, label: string }[]} */
  const options = [];
  for (const option of rawOptions) {
    if (option === null || typeof option !== "object") return null;
    const stance = typeof option.stance === "string" ? option.stance.trim().toLowerCase() : "";
    const label = typeof option.label === "string" ? option.label.trim().replace(/\s+/gu, " ") : "";
    if (stance === "" || stance.length > STANCE_MAX) return null;
    if (label.length < LABEL_MIN || label.length > LABEL_MAX) return null;
    options.push({ stance, label });
  }
  if (options[0].stance === options[1].stance) return null;

  /** @type {{ needed: boolean, reason: string, summary: string, question: string, options: { stance: string, label: string }[], nextPrompt?: string }} */
  const result = { needed, reason, summary, question, options };
  if (parsed.nextPrompt !== undefined) {
    const nextPrompt = typeof parsed.nextPrompt === "string" ? parsed.nextPrompt.trim() : "";
    if (nextPrompt.length > NEXT_PROMPT_MAX) return null;
    if (nextPrompt !== "") result.nextPrompt = nextPrompt;
  }
  return result;
}
