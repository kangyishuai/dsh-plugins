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
//
// 落地不变量（见 docs/adr/0023-next-step-grounded-cards.md）：
// - **任何一次要产出卡片内容的调用，都必须带同一段对话**。修复调用原来不带，于是模型只能把
//   「上一次输出为空」写成一张卡（「这一轮没有拿到任何对话内容…把对话贴进来？」）；
// - **空输出不是格式问题**：重发原请求，不拿空字符串去「修格式」；
// - **结构合法不等于有用**：卡片里至少要有一个对象能在对话里原样找到（`isGroundedIn`），否则丢弃；
// - **对话本身是空的就不调模型**：那是接线故障（`deriveMessages` 没接上），不是模型的问题。

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
/**
 * 能做「落地校验」的对话材料上限（每行字符数）。
 *
 * 校验用的是「模型看到的那段对话」的**未裁剪**版本：卡片摘要里的数字/文件名常常出现在
 * 回答的后半段，而喂给模型的 transcript 每条只留 800 字。这里放宽到 4000 字，只用于机械比对，
 * 不发给模型。实测 909 张正常卡里 908 张通过（唯一不过的那张，对象全部是中文虚指）。
 */
export const MATERIAL_CLIP = 4000;
/**
 * 判定「这段对话有没有可依据的内容」的最小字符数。
 *
 * 不是质量阈值，而是**接线检查**：`deriveMessages()` 没接上、或被宿主改名时 transcript 为空，
 * 此时无论模型多强都只能编——历史事故里出现的正是这种卡（「这一轮没有拿到任何对话内容」）。
 * 实测本机 909 张正常卡的 transcript 最短 935 字，离 40 很远，所以这个阈值不会误伤真实回合。
 */
export const MIN_CONTEXT_CHARS = 40;
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
 * 这些词只说明「是哪一类东西」，指认不了「是哪一件事」——对话里出现也不算落地证据。
 * 前一组是**生成过程自己的词**：模型一旦自述生成过程（「上一次输出为空」「JSON 解析失败」），
 * 卡片就会出现这些词；后一组是泛化名词，任何一轮的对话里都能找到。
 */
const NOT_IDENTITY = new Set([
  // 生成过程 / 协议字段
  "json",
  "summary",
  "question",
  "value",
  "options",
  "option",
  "stance",
  "label",
  "nextprompt",
  "diff",
  "pr",
  "api",
  "md",
  "e2e",
  // 泛化名词
  "文件名",
  "命令",
  "目录",
  "文件",
  "代码",
  "测试",
  "结果",
  "数值",
  "版本",
  "分支",
  "仓库",
  "提交",
  "修复",
  "实现",
  "功能",
  "问题",
  "改动",
  "更新",
  "文档",
  "卡片",
  "对话",
  "原文",
  "消息",
  "请求",
  "输出",
  "输入",
  "回复",
  "内容",
  "字段",
  "解析",
  "报错",
  "错误",
  "任务",
  "步骤",
  "流程",
  "结论",
  "摘要",
  "提问",
  "建议",
  "决策卡",
  "上一轮",
  "上一次",
  "上一条",
  "这一轮",
  "这一步",
  "下一步",
  "继续",
  "可以",
  "需要",
  "以下",
  "这段",
]);

/**
 * 从文本里抽「能指认是哪一件事」的对象：版本号、文件名、命令、PR 号、带数字/下划线的标识符，
 * 以及 ≥4 字、不像泛化名词的中文片段。
 * 与 `concreteTokens` 的区别：后者用于**按钮文案**（宁松勿严，只要沾上具体对象就放行），
 * 这里用于**落地校验**（宁严勿松：泛化名词和生成过程自己的词都不算对象）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function identityTokens(text) {
  const source = typeof text === "string" ? text : "";
  const found = new Set();
  for (const match of source.matchAll(/[A-Za-z0-9_./#-]{3,}/gu)) {
    const token = match[0].replace(/^[./#-]+|[./#-]+$/gu, "").toLowerCase();
    if (token.length < 3 || NOT_IDENTITY.has(token)) continue;
    // 有数字 / 带路径分隔符 / 足够长的英文标识符：都能指认具体对象
    if (/[0-9]/u.test(token) || /[./_#-]/u.test(token) || token.length >= 4) found.add(token);
  }
  for (const match of source.matchAll(/[\u4e00-\u9fa5]{4,}/gu)) {
    const run = match[0];
    // 中文动词/介词常粘在名词前面（「把二分查找」），去掉最多两个前导字再比对
    for (let cut = 0; cut <= 2; cut += 1) {
      const token = run.slice(cut);
      if (token.length < 4) break;
      if (!NOT_IDENTITY.has(token)) found.add(token);
    }
  }
  return found;
}

/**
 * 落地校验：卡片里至少有一个对象，能在**模型看到的那段对话**里原样找到。
 *
 * 这是「卡片必须在讲这一段对话」的机械判据，补的是提示词管不到的那一半：
 * 结构合法、文案漂亮，但整段都在讲生成过程或者凭空想象的卡片，一律不落地。
 *
 * 两条通道，命中一条即落地：
 * 1. **具体对象原样出现**（`identityTokens`）：文件名、命令、版本号、PR 号这类硬证据；
 * 2. **共享 ≥2 条中文 4 字片段**：短回答（一句话解释一个概念）里，卡片通常是在**改写**答案而不是
 *    引用文件名，一个具体对象都没有。这条通道按「有没有在讲同一件事」判，而不是按「有没有抄到 ID」。
 *    中文 4-gram 能扛住前后粘着的动词（「用一句话把二分查找定义为」里含「二分查找」）。
 *
 * 实测（本机 1038 条历史卡片，其中 119 条自述式）：只有通道 1 时正常卡 918/919、拦下自述卡 98/119；
 * 加上通道 2 之后正常卡 919/919、仍然拦下 98/119 —— 只赚不亏。没有它，一句话回答的回合会被误杀
 * （2026-11-21 桌面 --deep 实测：卡片共享 12 条 4 字片段、0 个具体对象，被误判成「与对话无关」）。
 * @param {string} text 卡片正文（summary + question + options + nextPrompt）
 * @param {string} material 模型看到的对话材料（可以未裁剪）
 * @returns {boolean}
 */
export function isGroundedIn(text, material) {
  const haystack = typeof material === "string" ? material.toLowerCase() : "";
  if (haystack.trim() === "") return false;
  for (const token of identityTokens(text)) {
    if (haystack.includes(token)) return true;
  }
  return sharedChineseGramCount(text, haystack) >= CN_GRAM_MIN;
}

/** 中文 4-gram 的窗口大小。 */
const CN_GRAM = 4;
/** 卡片与对话至少共享这么多条 4 字片段才算在讲同一件事。 */
const CN_GRAM_MIN = 2;

/**
 * 卡片与对话共享多少条不同的中文 4 字片段（只看卡片侧，逐条在对话里找）。
 * @param {string} text 卡片正文
 * @param {string} haystack 已小写的对话材料
 * @returns {number}
 */
export function sharedChineseGramCount(text, haystack) {
  const source = typeof text === "string" ? text : "";
  const hay = typeof haystack === "string" ? haystack : "";
  if (hay === "") return 0;
  const seen = new Set();
  for (const match of source.matchAll(/[\u4e00-\u9fa5]{4,}/gu)) {
    const run = match[0];
    for (let index = 0; index + CN_GRAM <= run.length; index += 1) {
      const gram = run.slice(index, index + CN_GRAM);
      if (!seen.has(gram) && hay.includes(gram)) seen.add(gram);
    }
  }
  return seen.size;
}

/**
 * 卡片正文：落地校验要看全部展示文本，不只是按钮文案。
 * @param {{ summary?: string, question?: string, options?: { label?: string }[], nextPrompt?: string }} suggestion
 * @returns {string}
 */
export function groundableText(suggestion) {
  if (!suggestion || typeof suggestion !== "object") return "";
  const parts = [suggestion.summary, suggestion.question, suggestion.nextPrompt];
  for (const option of Array.isArray(suggestion.options) ? suggestion.options : []) {
    parts.push(option?.label);
  }
  return parts.filter((part) => typeof part === "string" && part !== "").join("\n");
}

/**
 * 这段对话是否够长到能作为判断依据（接线检查，不是质量阈值）。
 * @param {string} transcript
 * @returns {boolean}
 */
export function hasContext(transcript) {
  const text = typeof transcript === "string" ? transcript.trim() : "";
  return text.length >= MIN_CONTEXT_CHARS;
}

/**
 * 解析失败后走哪条恢复路径：
 * - `retry`：首次输出**是空的**。空输出不是格式问题，拿它去「修格式」只会让模型对着
 *   「（空）」编一张卡片（历史上 95 条垃圾卡就是这么来的）；正确做法是把**同一个请求**
 *   原样再发一次。
 * - `repair`：有内容但格式不对（不是 JSON / 缺字段 / 按钮文案超长）。这时确实该修格式，
 *   且修复请求必须带上同一段对话。
 * @param {{ raw?: unknown, problem?: unknown }} input
 * @returns {"retry" | "repair"}
 */
export function recoveryPlan(input = {}) {
  const raw = typeof input.raw === "string" ? input.raw.trim() : "";
  return raw === "" ? "retry" : "repair";
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
    "9. **这段对话就是你手上的全部材料，它不缺东西**：绝不要要求用户「把对话/原文/改动/回复贴过来」，",
    '   也不要把「信息不足」当成一个方向。对话里确实没有能写进 label 的具体对象时：value 判 "no"，',
    "   summary 只写这段对话里唯一可核查的事实，只给 1 条 label —— 宁可不给建议，也不要写一张要材料的卡。",
    "10. **不要描述你自己这次生成的过程**：不要出现「上一次输出」「JSON」「解析失败」「summary / question 字段」",
    "   「决策卡内容」「本次请求」这类字样 —— 它们不是对话里的事实，写出来只会让用户看到一张自言自语的空卡。",
    "11. 拿不准就不要编：任何一条 label 找不到对话里的具体对象时，直接减少 options 数量（最少 1 条）。",
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
 * @param {unknown} [detail] `parseSuggestion` 的 problem.detail（用来给出可执行的收紧信息）
 * @returns {string}
 */
export function problemText(kind, detail) {
  if (kind === "value") {
    return 'value 必须是 "must" / "could" / "no" 三者之一（不要用 needed 之类的旧字段代替）';
  }
  if (kind === "options") {
    const base = `options 里没有一条可用的建议：需要 1–${OPTIONS_MAX} 条，label 为 ${LABEL_MIN}–${LABEL_MAX} 字、必须是「动词 + 对话里的具体对象」，不能是「检查定义是否准确」这类放到哪一轮都成立的空话`;
    // 把「你上一次到底写了多少字」直接写进修复请求：模型数不准自己的字数（实测 20 字上限
    // 被写成 21–22 字，只提示「2–20 字」修不回来），给出实际数字才知道要压多少。
    const overshoot = overlongLabelHint(detail);
    return overshoot === "" ? base : `${base}。${overshoot}`;
  }
  return "不是合法 JSON，或缺少 summary / question 这两个必填文本字段";
}

/**
 * 从解析失败的 detail 里读「上一次 label 到底几字」，生成一句可执行的收紧提示。
 * @param {unknown} detail `parseSuggestion` 的 problem.detail（如 `dropped-option:0:label-length:22`）
 * @returns {string} 没有长度问题时返回空串
 */
export function overlongLabelHint(detail) {
  const text = typeof detail === "string" ? detail : "";
  /** @type {number[]} */
  const lengths = [];
  for (const match of text.matchAll(/label-length:(\d+)/gu)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) lengths.push(value);
  }
  if (lengths.length === 0) return "";
  const longest = Math.max(...lengths);
  return `你上一次的 label 有 ${lengths.join(" / ")} 字，上限是 ${LABEL_MAX} 字（最长那条超了 ${longest - LABEL_MAX} 字）——请压到 ${LABEL_MAX} 字以内，并保留同一个具体对象`;
}

/**
 * 构造「修复」调用：**把同一段对话再带上**，然后回贴上次原文与具体问题，只要求它修格式。
 *
 * 为什么必须带对话（否则就是历史事故的根因）：修复只回贴「上一次输出 + 报错」，模型手里就只剩
 * 「上一次输出为空、缺少 summary / question」这一条信息；它的唯一出路是把这条信息写成一张卡：
 * 「这一轮没有拿到任何对话内容……把对话贴进来？」。这张卡结构合法、能过校验、还能显示出来 ——
 * 于是「没有对话内容」的卡反复出现在用户面前。一次修复不能凭空修内容，它必须看得见原料。
 *
 * 刻意只用一条 user 消息、不伪造 assistant 轮次（宿主 adapter 对 assistant 消息有额外要求，
 * 伪造容易在 provider 侧被拒）。
 * @param {{ transcript?: string, raw: unknown, problem: "json" | "value" | "options", detail?: unknown }} input
 * @returns {{ role: "user", content: { type: "text", text: string }[] }[]}
 */
export function buildRepairMessage(input) {
  const transcript = typeof input.transcript === "string" ? input.transcript.trim() : "";
  const raw = typeof input.raw === "string" ? input.raw : String(input.raw ?? "");
  const echoed = raw.length > REPAIR_ECHO_MAX ? `${raw.slice(0, REPAIR_ECHO_MAX)}…` : raw;
  const text = [
    "以下是最近的对话（与上一次请求相同），请据此修正你上一次的决策卡输出。",
    "",
    "对话：",
    transcript === "" ? "（没有可用的对话内容）" : transcript,
    "",
    "你上一次的输出：",
    '"""',
    echoed === "" ? "（空）" : echoed,
    '"""',
    "",
    `问题：${problemText(input.problem, input.detail)}。`,
    "",
    "请只输出修正后的 JSON 对象，结构如下（字段含义与之前的要求完全相同）：",
    '{ "value": "must" | "could" | "no", "reason": "…", "summary": "…", "question": "…", "options": [ { "stance": "…", "label": "…" } ], "nextPrompt": "…" }',
    "不要输出任何解释、不要用代码围栏。",
    "summary / question / options 的内容必须仍然来自上面这段对话；不要描述这次修正本身，" +
      "也不要要求用户补充对话内容 —— 对话就在上面。",
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
