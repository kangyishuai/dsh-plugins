// @ts-check
// 证据锚点校验：顾问必须为它的判断指出「在对话里的哪一处」，我们回头核对那个 ref 是否真的存在。
//
// 动机（真机踩过）：顾问会用「你刚才那次失败」「这个文件」这种模糊引用，甚至编一个不存在的
// call id。把 ref 拿去和会话里的工具调用 id / 消息 id / 路径对一遍，能立刻分出「有据」和「无据」。
//
// 纯函数，不 import 宿主包：输入是已经渲染好的 transcript 索引，输出是逐条校验结果。

/** 严重度降级链（校验失败时往下退一档，不直接归零）。 */
const DOWNGRADE = Object.freeze({ blocker: "concern", concern: "nit", nit: "nit" });

/**
 * 从会话消息里建索引：工具调用 id、消息 id、出现过的路径。
 * @param {any[]} messages `session.deriveMessages()` 的结果
 * @returns {{ callIds: Set<string>, messageIds: Set<string>, paths: Set<string>, toolNames: Set<string> }}
 */
export function buildIndex(messages) {
  /** @type {Set<string>} */
  const callIds = new Set();
  /** @type {Set<string>} */
  const messageIds = new Set();
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {Set<string>} */
  const toolNames = new Set();

  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.id === "string" && message.id !== "") messageIds.add(message.id);
    if (typeof message?.toolCallId === "string" && message.toolCallId !== "") {
      callIds.add(message.toolCallId);
    }
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool-call") {
        if (typeof block.id === "string" && block.id !== "") callIds.add(block.id);
        if (typeof block.name === "string" && block.name !== "") toolNames.add(block.name);
      }
      if (block?.type === "text" && typeof block.text === "string") {
        for (const path of extractPaths(block.text)) paths.add(path);
      }
    }
  }
  return { callIds, messageIds, paths, toolNames };
}

/**
 * 从一段文本里抽路径（尽量保守：只认带分隔符的、带扩展名的、或 ./ 开头的）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractPaths(text) {
  const out = [];
  const pattern = /(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,12}\b/gu;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const value = match[0].replace(/^\.\//u, "");
    if (value.length <= 200) out.push(value);
  }
  return out;
}

/**
 * @typedef {object} AnchorCheck
 * @property {string} kind
 * @property {string} ref
 * @property {boolean} verified
 * @property {string} reason
 */

/**
 * 逐条校验锚点。
 *
 * 判定：
 * - `tool_result` / `tool_call`：ref 必须是会话里出现过的工具调用 id；
 * - `message`：ref 必须是会话里出现过的消息 id；
 * - `file` / `path`：ref 必须出现在 transcript 的文本里（去重后按 basename 或后缀匹配）；
 * - 其它 kind：只能按「ref 是否在 transcript 文本中出现」宽松校验。
 *
 * @param {Array<{ kind: string, ref: string }>} evidence
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} [transcriptText]
 * @returns {{ checks: AnchorCheck[], verified: number, unverified: number }}
 */
export function verifyAnchors(evidence, index, transcriptText = "") {
  /** @type {AnchorCheck[]} */
  const checks = [];
  const haystack = typeof transcriptText === "string" ? transcriptText : "";

  for (const anchor of Array.isArray(evidence) ? evidence : []) {
    const kind = String(anchor?.kind ?? "").toLowerCase();
    const ref = String(anchor?.ref ?? "").trim();
    if (ref === "") continue;

    /** @type {boolean} */
    let verified = false;
    /** @type {string} */
    let reason = "";

    if (kind === "tool_result" || kind === "tool_call" || kind === "tool") {
      verified = index.callIds.has(ref);
      reason = verified ? "工具调用 id 存在" : "会话里没有这个工具调用 id";
    } else if (kind === "message") {
      verified = index.messageIds.has(ref);
      reason = verified ? "消息 id 存在" : "会话里没有这个消息 id";
    } else if (kind === "file" || kind === "path") {
      const normalized = ref.replace(/^\.\//u, "");
      const byExact = index.paths.has(normalized);
      const base = normalized.split("/").pop() ?? normalized;
      const byBase = [...index.paths].some(
        (path) => path === normalized || path.endsWith(`/${base}`),
      );
      verified = byExact || byBase || haystack.includes(normalized);
      reason = verified ? "路径在对话里出现过" : "对话里没有这个路径";
    } else {
      verified = haystack.includes(ref);
      reason = verified ? "对话文本里出现过该引用" : "对话文本里没有该引用";
    }

    checks.push({ kind: kind || "unknown", ref, verified, reason });
  }

  const verified = checks.filter((check) => check.verified).length;
  return { checks, verified, unverified: checks.length - verified };
}

/**
 * 根据锚点校验结果调整严重度：**一个锚点都没对上**（且有锚点）时降一档，并在建议末尾追加一句提示。
 * 没有提供锚点时不动（顾问可能只是没引用；这由提示词去管，不该由守卫惩罚）。
 * @param {{ severity: "nit"|"concern"|"blocker", advice: string }} advice
 * @param {{ checks: AnchorCheck[], verified: number, unverified: number }} result
 * @returns {{ severity: "nit"|"concern"|"blocker", advice: string, downgraded: boolean }}
 */
export function applyAnchorVerdict(advice, result) {
  if (result.checks.length === 0 || result.verified > 0) {
    return { severity: advice.severity, advice: advice.advice, downgraded: false };
  }
  const severity = /** @type {"nit"|"concern"|"blocker"} */ (
    DOWNGRADE[/** @type {"nit"|"concern"|"blocker"} */ (advice.severity)] ?? "nit"
  );
  const note = `（证据锚点未对上：${result.checks.length} 条引用在对话里都找不到，严重度已降为 ${severity}）`;
  return { severity, advice: `${advice.advice}\n${note}`, downgraded: true };
}
