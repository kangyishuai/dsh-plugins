// @ts-check
// 采纳归因：顾问给了建议之后，主模型到底有没有照做？
//
// 不依赖模型自觉回写（那样覆盖率注定很低）。做法是**启发式追踪信号**：从建议里抽出
// 可追踪的东西（路径、反引号里的命令、证据 ref），看之后的会话事件里有没有出现。
// 宁可判「未判定」，也不要把「碰巧提到同一个文件」算成采纳。
import { extractPaths } from "./anchors.js";

/**
 * 从一条建议里抽可追踪信号。
 * @param {{ advice?: string, evidence?: Array<{ ref?: string }> }} data
 * @returns {string[]}
 */
export function signalsOf(data) {
  const adviceText = typeof data?.advice === "string" ? data.advice : "";
  /** @type {Set<string>} */
  const signals = new Set(extractPaths(adviceText));
  for (const match of adviceText.matchAll(/`([^`]{3,120})`/gu)) signals.add(match[1].trim());
  for (const item of Array.isArray(data?.evidence) ? data.evidence : []) {
    if (typeof item?.ref === "string" && item.ref.trim() !== "") signals.add(item.ref.trim());
  }
  // 太短的信号（"a"、"ok"）没有区分度，丢掉。
  return [...signals].filter((signal) => signal.length >= 3);
}

/**
 * 判一条建议是否被采纳。
 * @param {any[]} events 会话全量事件
 * @param {number} fromIndex 建议记录所在的事件下标
 * @param {any} data 建议记录的数据
 * @returns {{ verdict: "adopted"|"unknown", why: string }}
 */
export function attributeAdoption(events, fromIndex, data) {
  const signals = signalsOf(data);
  if (signals.length === 0) return { verdict: "unknown", why: "建议里没有可追踪的信号" };
  const list = Array.isArray(events) ? events : [];
  for (let index = fromIndex + 1; index < list.length; index += 1) {
    const haystack = JSON.stringify(list[index]?.data ?? "");
    for (const signal of signals) {
      if (haystack.includes(signal)) return { verdict: "adopted", why: signal };
    }
  }
  return { verdict: "unknown", why: "后续没有出现建议里的信号" };
}

/**
 * 汇总一批建议记录（供 `/advisor report` 与未来的设置页使用）。
 * @param {any[]} events
 * @param {Array<{ index: number, data: any }>} records
 * @returns {{ total: number, adopted: number, unknown: number, anchorsChecked: number, anchorsVerified: number, items: Array<{ severity: string, summary: string, verdict: string, why: string, adviceId: string }> }}
 */
export function summarizeAdoption(events, records) {
  let adopted = 0;
  let anchorsChecked = 0;
  let anchorsVerified = 0;
  /** @type {Array<{ severity: string, summary: string, verdict: string, why: string, adviceId: string }>} */
  const items = [];
  for (const { index, data } of Array.isArray(records) ? records : []) {
    const outcome = attributeAdoption(events, index, data);
    if (outcome.verdict === "adopted") adopted += 1;
    anchorsChecked += Number(data?.anchors?.checked ?? 0) || 0;
    anchorsVerified += Number(data?.anchors?.verified ?? 0) || 0;
    items.push({
      severity: String(data?.severity ?? "nit"),
      summary: String(data?.summary ?? data?.advice ?? "")
        .replace(/\s+/gu, " ")
        .slice(0, 80),
      verdict: outcome.verdict,
      why: outcome.why,
      adviceId: String(data?.adviceId ?? ""),
    });
  }
  return {
    total: items.length,
    adopted,
    unknown: items.length - adopted,
    anchorsChecked,
    anchorsVerified,
    items,
  };
}
