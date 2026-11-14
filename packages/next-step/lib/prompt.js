// @ts-check
// 提示词与输出解析：纯函数，不 import 宿主包（单测可以直接跑）。
// 一次调用同时产出四样东西：三档判断、判断依据、摘要 + 提问 + 两条动作、一条给输入框的幽灵提示。
//
// 设计要点（v0.4，见 docs/adr/0013 与 ADR 0009 的增补）：
// - `value` 是三档（must / could / no），不是 boolean。原来的 boolean 把「确定没必要」和「说不准」
//   压进同一个 false，模型为了不出废话自然倾向判 false —— 这就是「必要的时候也不出卡」的机理。
//   现在要求「拿不准一律判 could」，由设置里的档位决定显示阈值（严格/平衡/积极）。
// - `label` 就是点击后原样发送的用户消息（WYSIWYG）；2–20 字、必须是「动词 + 具体对象」。
// - **宽容解析**：超长的展示文本截断、不合格的单条 option 丢掉，不再因为一个字段超长就整张卡作废。
//   只有「结构不可用 / 三档判定缺失 / 一条可用建议都不剩」这三种才算失败，交给 service 做一次修复调用。

import { PROMPT_VERSION } from "./scheme.js";

/** 摘要最大字符数（1–3 句，超出视为模型跑偏）。 */
export const SUMMARY_MAX = 400;
/** 提问最大字符数。 */
export const QUESTION_MAX = 200;
/**
 * 按钮文案最大字符数。参照 Claude 桌面端的建议卡：chip 都是「动词 + 具体对象」的短语
 * （「改成 %5」「写 v1.3」「出 v1.5 和 E2E-01c」都在 13 字以内），长到一整句就点不动了。
 */
export const LABEL_MAX = 20;
/** 按钮文案最少字符数（太短多半是「继续」这种悬空指令）。 */
export const LABEL_MIN = 2;
/** 判断依据最大字符数（会显示在诊断里）。 */
export const REASON_MAX = 160;
/**
 * 幽灵提示最大字符数。输入框里是一整行灰字，比 chip 能承载更长的句子；
 * 但超过一屏宽度只会被省略号截断，所以仍然给上限，并要求关键信息前置。
 */
export const NEXT_PROMPT_MAX = 150;
/** 幽灵提示里「关键信息必须出现」的前缀长度。 */
export const NEXT_PROMPT_HEAD = 60;
/** stance 最大字符数。 */
export const STANCE_MAX = 40;
/** 一次生成最多保留的建议条数（3 条以上是选择成本，不是信息量）。 */
export const OPTIONS_MAX = 2;
/** 修复调用里回贴模型原文的最大长度（避免把上次超长输出再喂回去撑爆上下文）。 */
export const REPAIR_ECHO_MAX = 4000;
/** 重新导出：提示词版本位，service 写卡片与事件时要用。 */
export { PROMPT_VERSION };

/**
 * @typedef {{ stance: string, label: string }} SuggestionOption
 * @typedef {{
 *   value: "must" | "could" | "no", reason: string, summary: string, question: string,
 *   options: SuggestionOption[], nextPrompt?: string,
 * }} Suggestion
 *
 * @typedef {{ kind: "json" | "value" | "options", detail: string }} ParseProblem
 * @typedef {{ suggestion: Suggestion | null, problem: ParseProblem | null, detail: string }} ParseResult
 */

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
 * 从一段文字里抽「具体对象」：版本号、文件名/路径、命令、带数字或下划线的标识符、
 * 英文单词与中文里成串的名词片段。用途只有一个——机械校验按钮文案/幽灵提示里
 * 到底有没有对话里的东西，而不是又一句可以套在任何一轮上的空话。
 * @param {string} text
 * @returns {Set<string>}
 */
export function concreteTokens(text) {
  const found = new Set();
  const source = typeof text === "string" ? text : "";
  // 带扩展名的文件、路径、命令、版本号、PR/issue 号、下划线标识符
  for (const match of source.matchAll(
    /[A-Za-z0-9_./-]*(?:\.[A-Za-z]{1,5}|\/[A-Za-z0-9_.-]+|#[0-9]+|v?\d+(?:\.\d+)+|[a-z]+_[a-z0-9_]+)/gu,
  )) {
    const token = match[0].replace(/^[./-]+|[./-]+$/gu, "");
    if (token.length >= 3) found.add(token.toLowerCase());
  }
  // 中文片段：2 字以上的连续汉字（去掉「继续」「下一步」这类无信息量的词）
  const stop = new Set(["继续", "下一步", "建议", "可以", "需要", "是否", "现在", "然后", "一下"]);
  for (const match of source.matchAll(/[\u4e00-\u9fa5]{2,8}/gu)) {
    const token = match[0];
    if (!stop.has(token)) found.add(token);
  }
  return found;
}

/** 只有空话动词、没有具体对象的按钮文案：一律不要（宁可这一轮不出卡）。 */
const GENERIC_VERBS =
  /^(?:检查|看看|确认|继续|优化|扩展|扩充|补充|完善|调整|处理|评估|梳理|整理|深入|展开|review|check|continue|expand|improve)/iu;

/**
 * 按钮文案是不是「套在任何一轮都成立」的空话。
 * 判据：以泛化动词开头，且不含任何具体对象（版本号/文件/命令/数字/英文标识符）。
 * @param {string} label
 * @returns {boolean}
 */
export function isGenericLabel(label) {
  const text = typeof label === "string" ? label.trim() : "";
  if (text === "") return true;
  if (!GENERIC_VERBS.test(text)) return false;
  const tokens = concreteTokens(text);
  // 只剩「定义」「实现细节」这类抽象名词时 tokens 可能非空，所以这里再要求
  // 出现过至少一个「像标识符/数字/路径」的 token 才算具体。
  for (const token of tokens) {
    if (/^[a-z0-9_./#-]+$/iu.test(token) || /\d/u.test(token)) return false;
  }
  return true;
}

/**
 * 幽灵提示与推荐按钮文案是否在说同一件事：至少共享一个具体对象。
 * 不共享时返回 false，调用方会把幽灵提示退化成按钮文案本身（宁可短，也不打脸）。
 * @param {string} ghost
 * @param {string} label
 * @returns {boolean}
 */
export function ghostAgreesWithLabel(ghost, label) {
  const ghostText = typeof ghost === "string" ? ghost : "";
  const labelText = typeof label === "string" ? label : "";
  const right = concreteTokens(labelText);
  if (right.size === 0) return true;
  const haystack = ghostText.toLowerCase();
  for (const token of right) {
    // 中文按「连续汉字串」切分时，包含关系比完全相同更可靠：
    // 「冒烟」与「冒烟和桌面回归」说的是同一件事。
    if (haystack.includes(token)) return true;
  }
  const left = concreteTokens(ghostText);
  for (const token of left) {
    if (labelText.toLowerCase().includes(token)) return true;
  }
  return false;
}

/**
 * 系统提示词：判断这一轮是否值得继续（三档），并把对话压成一张决策卡，严格 JSON。
 *
 * v3 的关键改动是**判定语言**：boolean → 三档，并明写「拿不准一律判 could」。
 * 不这么写，模型会把它当成"要不要打扰用户"的二选一，倾向于少出卡。
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
    '{ "value": "must" | "could" | "no", "reason": "…", "summary": "…", "question": "…", "options": [ { "stance": "…", "label": "…" } ], "nextPrompt": "…" }',
    "",
    "要求：",
    "1. value：三档判断，表示「这一轮结束后，用户是否真的值得继续」。",
    '   - "must"：存在非常明确的下一步或待办，几乎不需要再讨论（例如：刚改完代码要去跑验证、要看 diff、要合并 PR、要发版）。',
    '   - "could"：对话没有收尾，继续做下去是合理的，但不算非做不可。',
    '   - "no"：继续是负价值——任务已完整收尾；最后的回答已经把问题/选择抛回给用户；用户已表示结束（如「不用了」「谢谢」）；继续只会重复劳动。',
    '   **拿不准一律判 "could"，不要判 "no"**。判 "no" 必须能说清「为什么继续是负价值」，说不出就说明它其实是 "could"。',
    `2. reason：一句话说明判断依据，${REASON_MAX} 字以内，直接说事实，不要客套。`,
    "3. summary：写**这一轮实际发生了什么**的可核查事实，不许写「用户要求……助手已经……」这种旁白。",
    "   好例子：「改了 importer/csv.ts 的流式读取，内存峰值 1.8 GB → 90 MB；parseRow 补了 3 个边界用例。」",
    "   坏例子：「用户要求改导入脚本，助手已完成修改，无需补充信息。」",
    "   1–3 句，不评价、不客套；没有具体事实（文件名、命令、数值、PR 号、测试结果）就说明这轮不值得出卡。",
    "4. question：一句向用户确认方向的问题，必须以问号结尾，且要能从上一条 summary 里读懂。",
    `5. options：1–${OPTIONS_MAX} 条，方向互斥（例如「按方案 A 改」vs「先补测试」），不能是同一件事的两种说法。`,
    "   - 只给 1 条也可以：当下一步非常明确、没有第二条像样的路时，宁可不凑数。",
    "   - 两件事都要做、而且顺序固定时，把它们合并成**一条** label（如「出 v1.5 和 E2E-01c」），不要拆成两条。",
    "   - stance：英文小写短语标识立场，多条时必须互不相同（如 verify / proceed / harder / alternative）。",
    `   - label：按钮文案，也就是用户点一下后**原样发送**给助手的用户消息；${LABEL_MIN}–${LABEL_MAX} 字。`,
    "     必须是「动词 + 具体对象」：对象要来自这段对话（文件名、命令、参数值、版本号、PR/issue 号）。",
    "     反例：「检查定义是否准确」「扩展到实现细节」——没有具体对象，换成任何一轮都成立，一律不要。",
    "     不要用「继续」「好的」这类悬空短语，不要写成问句，不要把解释塞进 label。",
    `6. nextPrompt：输入框里的幽灵提示，一句用户口吻的下一句输入，${NEXT_PROMPT_MAX} 字以内；`,
    `   关键信息（对象或动作）放前 ${NEXT_PROMPT_HEAD} 字内，超出会被省略号截断。`,
    "   它和 options 必须是**同一个建议**的两种说法（可以更长、更口语），不许各说一件事。",
    `7. 语言：跟随对话中用户使用的语言（当前界面语言 ${locale}，仅供参考）。`,
    '8. **即使 value 判为 "no"，也要把 summary / question / options 写完整** —— 用户可能手动要这张卡。',
    "9. 信息不足时，两个方向应当是「先补信息」与「按现有信息推进」，不要编造事实。",
    "10. 拿不准就不要编：任何一条 label 找不到对话里的具体对象时，直接减少 options 数量（最少 1 条）。",
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
 * 失败原因 → 给修复调用的中文说明。
 * @param {"json" | "value" | "options"} kind
 * @returns {string}
 */
export function problemText(kind) {
  if (kind === "value") {
    return 'value 必须是 "must" / "could" / "no" 三者之一（不要用 needed 之类的旧字段代替）';
  }
  if (kind === "options") {
    return `options 里没有一条可用的建议：需要 1–${OPTIONS_MAX} 条，label 为 ${LABEL_MIN}–${LABEL_MAX} 字、必须是「动词 + 对话里的具体对象」，不能是「检查定义是否准确」这类放到哪一轮都成立的空话`;
  }
  return "不是合法 JSON，或缺少 summary / question 这两个必填文本字段";
}

/**
 * 构造「修复」调用：把模型上次的原文与具体问题回贴，只要求它修格式。
 *
 * 刻意只用一条 user 消息、不伪造 assistant 轮次（宿主 adapter 对 assistant 消息有额外要求，
 * 伪造容易在 provider 侧被拒）。
 * @param {{ raw: unknown, problem: "json" | "value" | "options" }} input
 * @returns {{ role: "user", content: { type: "text", text: string }[] }[]}
 */
export function buildRepairMessage(input) {
  const raw = typeof input.raw === "string" ? input.raw : String(input.raw ?? "");
  const echoed = raw.length > REPAIR_ECHO_MAX ? `${raw.slice(0, REPAIR_ECHO_MAX)}…` : raw;
  const text = [
    "你上一次的输出不能被解析成决策卡。",
    `问题：${problemText(input.problem)}。`,
    "",
    "上一次的原始输出：",
    '"""',
    echoed === "" ? "（空）" : echoed,
    '"""',
    "",
    "请只输出修正后的 JSON 对象，结构如下（字段含义与之前的要求完全相同）：",
    '{ "value": "must" | "could" | "no", "reason": "…", "summary": "…", "question": "…", "options": [ { "stance": "…", "label": "…" } ], "nextPrompt": "…" }',
    "不要输出任何解释、不要用代码围栏。",
  ].join("\n");
  return [{ role: "user", content: [{ type: "text", text }] }];
}

/**
 * 截断到上限（超长只截断，不丢整张卡）。
 * @param {string} text
 * @param {number} max
 * @param {string[]} notes 记录做过什么，供日志与事件使用
 * @param {string} key
 * @returns {string}
 */
function clipText(text, max, notes, key) {
  if (text.length <= max) return text;
  notes.push(`truncated:${key}`);
  return `${text.slice(0, max).replace(/[\s，。；,;:：]$/u, "")}…`;
}

/**
 * 解析一条 option；不合格返回 null（丢掉这一条，不废整张卡）。
 * @param {any} option
 * @param {string[]} notes
 * @param {number} index
 * @returns {SuggestionOption | null}
 */
function readOption(option, notes, index) {
  if (option === null || typeof option !== "object") {
    notes.push(`dropped-option:${index}:not-object`);
    return null;
  }
  const stanceRaw = typeof option.stance === "string" ? option.stance.trim().toLowerCase() : "";
  const stance = stanceRaw.length > STANCE_MAX ? stanceRaw.slice(0, STANCE_MAX) : stanceRaw;
  if (stance === "") {
    notes.push(`dropped-option:${index}:stance`);
    return null;
  }
  const label = typeof option.label === "string" ? option.label.trim().replace(/\s+/gu, " ") : "";
  if (label.length < LABEL_MIN || label.length > LABEL_MAX) {
    notes.push(`dropped-option:${index}:label-length:${label.length}`);
    return null;
  }
  if (isGenericLabel(label)) {
    // 「检查定义是否准确」这类按钮放到哪一轮都成立，正是点击率低的直接原因。
    notes.push(`dropped-option:${index}:generic`);
    return null;
  }
  return { stance, label };
}

/**
 * 从模型输出里抠出 JSON 并宽容校验。
 *
 * 返回结构（v0.4 起变化，v0.2/v0.3 是直接返回对象或 null）：
 * - 成功：`{ suggestion, problem: null, detail }`
 * - 失败：`{ suggestion: null, problem: { kind, detail }, detail }`，由调用方决定要不要修一次
 *
 * 只有三类失败：`json`（结构不可用）、`value`（三档判定缺失/非法）、`options`（一条可用建议都没有）。
 * 其余问题（超长、多余的 option、stance 重复）都在这里就地容忍。
 * @param {unknown} raw
 * @returns {ParseResult}
 */
export function parseSuggestion(raw) {
  if (typeof raw !== "string") {
    return { suggestion: null, problem: { kind: "json", detail: "not-text" }, detail: "not-text" };
  }
  let text = raw.trim();
  if (text === "") {
    return { suggestion: null, problem: { kind: "json", detail: "empty" }, detail: "empty" };
  }
  // 去掉 ```json … ``` / ``` … ``` 围栏
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/u.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  // 容忍前后多余文字：取第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      suggestion: null,
      problem: { kind: "json", detail: "no-object" },
      detail: "no-object",
    };
  }
  text = text.slice(start, end + 1);

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return {
      suggestion: null,
      problem: { kind: "json", detail: "unparsable" },
      detail: "unparsable",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      suggestion: null,
      problem: { kind: "json", detail: "not-object" },
      detail: "not-object",
    };
  }

  /** @type {string[]} */
  const notes = [];

  // ---- 三档判定：新字段优先，旧字段 needed 兼容映射（提示词漂移时不至于整张卡作废）
  /** @type {"must" | "could" | "no"} */
  let value;
  if (parsed.value === "must" || parsed.value === "could" || parsed.value === "no") {
    value = parsed.value;
  } else if (typeof parsed.needed === "boolean") {
    value = parsed.needed ? "must" : "no";
    notes.push("legacy-needed");
  } else {
    return {
      suggestion: null,
      problem: { kind: "value", detail: "value-missing" },
      detail: "value-missing",
    };
  }

  // ---- 展示文本：缺了就算结构不可用（修复调用能补），超长就截断
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const questionRaw = typeof parsed.question === "string" ? parsed.question.trim() : "";
  if (summaryRaw === "" || questionRaw === "") {
    return {
      suggestion: null,
      problem: { kind: "json", detail: "summary-question-missing" },
      detail: "summary-question-missing",
    };
  }
  const summary = clipText(summaryRaw, SUMMARY_MAX, notes, "summary");
  const question = clipText(questionRaw, QUESTION_MAX, notes, "question");
  const reasonRaw = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (reasonRaw === "") notes.push("reason-missing");
  const reason = clipText(reasonRaw, REASON_MAX, notes, "reason");

  // ---- 选项：逐条校验，丢掉不合格的，最多留 OPTIONS_MAX 条
  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  if (rawOptions.length === 0) notes.push("options-missing");
  /** @type {SuggestionOption[]} */
  let options = [];
  for (let index = 0; index < rawOptions.length; index += 1) {
    const option = readOption(rawOptions[index], notes, index);
    if (option !== null) options.push(option);
  }
  if (options.length > OPTIONS_MAX) {
    notes.push(`truncated:options:${options.length - OPTIONS_MAX}`);
    options = options.slice(0, OPTIONS_MAX);
  }
  // 两条同 stance：丢第二条（互斥是硬要求，但没必要因此废掉整张卡）
  if (options.length === 2 && options[0].stance === options[1].stance) {
    notes.push("dropped-option:1:stance-duplicate");
    options = [options[0]];
  }
  if (options.length === 0) {
    return {
      suggestion: null,
      problem: { kind: "options", detail: notes.join(",") || "none" },
      detail: notes.join(",") || "none",
    };
  }

  /** @type {Suggestion} */
  const suggestion = { value, reason, summary, question, options };
  if (parsed.nextPrompt !== undefined) {
    let nextPrompt = typeof parsed.nextPrompt === "string" ? parsed.nextPrompt.trim() : "";
    if (nextPrompt.length > NEXT_PROMPT_MAX) {
      notes.push("truncated:nextPrompt");
      nextPrompt = nextPrompt.slice(0, NEXT_PROMPT_MAX).trim();
    }
    // 与推荐项不一致 → 退化成该按钮文案，保证「同一个建议的两种入口」。
    if (nextPrompt !== "" && !ghostAgreesWithLabel(nextPrompt, options[0].label)) {
      notes.push("downgraded:nextPrompt");
      nextPrompt = options[0].label;
    }
    if (nextPrompt !== "") suggestion.nextPrompt = nextPrompt;
  }
  return { suggestion, problem: null, detail: notes.join(",") };
}
