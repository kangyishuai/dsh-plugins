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
    "3. summary：写**这一轮实际发生了什么**的可核查事实，不许写「用户要求……助手已经……」这种旁白。",
    "   好例子：「改了 importer/csv.ts 的流式读取，内存峰值 1.8 GB → 90 MB；parseRow 补了 3 个边界用例。」",
    "   坏例子：「用户要求改导入脚本，助手已完成修改，无需补充信息。」",
    "   1–3 句，不评价、不客套；没有具体事实（文件名、命令、数值、PR 号、测试结果）就说明这轮不值得出卡。",
    "4. question：一句向用户确认方向的问题，必须以问号结尾，且要能从上一条 summary 里读懂。",
    `5. options：1–2 条，方向互斥（例如「按方案 A 改」vs「先补测试」），不能是同一件事的两种说法。`,
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
    "8. needed 为 false 时也要按上面的结构给出 summary / question / options —— 用户可能手动请求这张卡。",
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
  // 1–2 条：只给 1 条是「下一步很明确」，不是残缺；3 条以上是选择成本，不要。
  if (rawOptions.length < 1 || rawOptions.length > 2) return null;
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
  if (options.length === 2 && options[0].stance === options[1].stance) return null;
  // 泛化按钮：找不到对话里的具体对象、又只由空话动词构成的，直接丢掉这条。
  // 一条都不剩就整卡不出——「检查定义是否准确」这种套在任何一轮都成立的按钮，
  // 正是点击率低的直接原因。
  const kept = options.filter((option) => !isGenericLabel(option.label));
  if (kept.length === 0) return null;

  options.length = 0;
  options.push(...kept);

  /** @type {{ needed: boolean, reason: string, summary: string, question: string, options: { stance: string, label: string }[], nextPrompt?: string }} */
  const result = { needed, reason, summary, question, options };
  if (parsed.nextPrompt !== undefined) {
    let nextPrompt = typeof parsed.nextPrompt === "string" ? parsed.nextPrompt.trim() : "";
    // 超长只截断，不丢整张卡：前半段本来就要求放关键信息。
    if (nextPrompt.length > NEXT_PROMPT_MAX)
      nextPrompt = nextPrompt.slice(0, NEXT_PROMPT_MAX).trim();
    // 与推荐项不一致 → 退化成该按钮文案，保证「同一个建议的两种入口」。
    if (nextPrompt !== "" && !ghostAgreesWithLabel(nextPrompt, options[0].label)) {
      nextPrompt = options[0].label;
    }
    if (nextPrompt !== "") result.nextPrompt = nextPrompt;
  }
  return result;
}
