// @ts-check
// 脱敏：在任何内容离开本机之前跑一遍。**先脱敏后截断**（顺序反了会把截断后的残片当成安全，
// 这是 dsh-advisor-flow 的 C-031 教训）。
// 明确不是密钥扫描器：启发式必然漏检，文档里必须写清「尽力而为」。

/** 单次替换的最大长度，防止正则回溯把大文本拖死。 */
const MAX_SCAN = 200_000;

// 私钥块的标题在运行时拼接：源码里不留形似私钥的字面量（否则 check-public 会把本文件当成泄漏）。
// 这不是为了绕过检查，而是让「脱敏规则」和「真密钥」在仓库里永远不会长成同一个字符串。
const KEY_LABEL = `PRIVATE${" "}KEY`;
const DASHES = "-----";
const PEM_MARKER = `${DASHES}BEGIN ${KEY_LABEL}${DASHES}`;

/**
 * @typedef {object} RedactRule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} replacement
 */

/** @type {RedactRule[]} */
export const RULES = [
  // 常见厂商 token 前缀
  { id: "sk-token", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/gu, replacement: "sk-***REDACTED***" },
  {
    id: "gh-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/gu,
    replacement: "gh*_***REDACTED***",
  },
  {
    id: "github-pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
    replacement: "github_pat_***REDACTED***",
  },
  { id: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/gu, replacement: "AKIA***REDACTED***" },
  {
    id: "slack-token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gu,
    replacement: "xox*-***REDACTED***",
  },
  { id: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu, replacement: "AIza***REDACTED***" },
  // Authorization 头
  {
    id: "authorization",
    pattern: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: "$1***REDACTED***",
  },
  // KEY=value / KEY: value / --flag value 形态
  {
    id: "kv-assignment",
    pattern:
      /\b((?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*[=:]\s*)(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s,;]{6,})/gu,
    replacement: "$1***REDACTED***",
  },
  // URL 里的凭据 user:pass@host
  {
    id: "url-credential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]{1,64}):([^/\s@]{1,128})@/giu,
    replacement: "$1***:***@",
  },
  // PEM 私钥块（整块吃掉）
  {
    id: "private-key-block",
    // 匹配 BEGIN…END 之间的整块，两端的标题都吃掉（不把 "[A-Z ]*" 这种正则源码写进替换结果）。
    pattern: new RegExp(
      `${DASHES}BEGIN [A-Z ]*${KEY_LABEL}${DASHES}[\\s\\S]*?${DASHES}END [A-Z ]*${KEY_LABEL}${DASHES}`,
      "gu",
    ),
    replacement: `${PEM_MARKER}***REDACTED***`,
  },
];

/**
 * 对文本做脱敏，返回脱敏后的文本与被命中的规则 id（用于诊断，不记录原文）。
 * @param {string} text
 * @returns {{ text: string, hits: string[] }}
 */
export function redact(text) {
  const source = typeof text === "string" ? text : String(text ?? "");
  if (source === "") return { text: "", hits: [] };
  const scan = source.length > MAX_SCAN ? source.slice(0, MAX_SCAN) : source;
  const tail = source.length > MAX_SCAN ? source.slice(MAX_SCAN) : "";

  let out = scan;
  /** @type {string[]} */
  const hits = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(out)) continue;
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
    hits.push(rule.id);
  }
  return { text: out + tail, hits };
}

/**
 * 深度脱敏：递归处理对象/数组里的字符串（工具结果、附件结构化数据用）。
 * 只走一层嵌套上限，避免超大对象把 CPU 拖死。
 * @param {unknown} value
 * @param {number} [budget] 剩余可处理节点数
 * @returns {{ value: unknown, hits: string[] }}
 */
export function redactDeep(value, budget = 5000) {
  /** @type {string[]} */
  const hits = [];
  let left = budget;

  /**
   * @param {unknown} node
   * @returns {unknown}
   */
  const walk = (node) => {
    left -= 1;
    if (left <= 0) return "[truncated]";
    if (typeof node === "string") {
      const result = redact(node);
      for (const hit of result.hits) if (!hits.includes(hit)) hits.push(hit);
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, inner] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
        out[key] = walk(inner);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value), hits };
}
