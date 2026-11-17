// @ts-check
// wake 信封：纯函数、零 I/O。
// 设计依据 notes/projects/m3-design.md §1：
//   - 信封必须带线程结果摘要（M0 实测：不带时协调器说「读不到它的输出」）
//   - 一次 wake 只注入一次（M0 实测：agent/pre-step 每步都触发，同一封信被注入 3 次）
//   - 只有 trust: principal 算授权；模型/外部内容/peer 都不算

import { wrapUntrusted } from "./untrusted.js";

/** 只有这个信任级别能构成授权。 */
export const AUTHORIZING_TRUST = "principal";

/** 允许的唤醒原因。 */
export const WAKE_REASONS = Object.freeze([
  "mention",
  "thread-activity",
  "settled",
  "reminder",
  "budget",
]);

/** 信封里报告的最大字符数（太长会白烧上下文）。 */
export const REPORT_MAX_CHARS = 800;

/**
 * 信封里「项目上下文摘要」的最大字符数。
 * 用途：协调器会话拿不到宿主的 runtime context（runtime §11.24），
 * 所以项目规则与记忆摘要随信封一起送达——信封这条路已被证明能到达协调器（§11.8）。
 */
export const CONTEXT_MAX_CHARS = 2000;

/** 人格段落上限（人格本应短小；过长会挤占任务信息）。 */
export const PERSONA_MAX_CHARS = 1200;

/**
 * 信任级别是否构成授权。
 * 模型输出、外部网页内容、另一个 agent 的消息都不能授权——它们只能是 peer/relay。
 * @param {unknown} trust
 * @returns {boolean}
 */
export function isAuthorizingTrust(trust) {
  return String(trust ?? "") === AUTHORIZING_TRUST;
}

/**
 * 截断报告文本（先按行保留头部，避免把一句话截半）。
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipReport(text, max = REPORT_MAX_CHARS) {
  const value = String(text ?? "").trim();
  if (value === "") return "";
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const lastBreak = head.lastIndexOf("\n");
  const cut = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}\n…(truncated, ${value.length} chars total)`;
}

/**
 * 构造一封 wake 信封。
 * @param {object} input
 * @param {string} input.reason
 * @param {string} [input.trust]
 * @param {{id: string, name: string}} input.project
 * @param {{sessionId: string, state?: string, turn?: number, branch?: string|null}} input.thread
 * @param {string} input.report
 * @param {string} [input.context] 项目规则/记忆摘要（随信封送达协调器）
 * @param {string} [input.persona] 协调器人格（同样随信封送达）
 * @param {string} input.next
 * @param {string} [input.wakeId]
 * @returns {{ wakeId: string, text: string, sections: {name: string, text: string}[], trust: string, authorized: boolean }}
 */
export function buildEnvelope(input) {
  const reason = WAKE_REASONS.includes(String(input?.reason))
    ? String(input.reason)
    : "thread-activity";
  const trust = String(input?.trust ?? AUTHORIZING_TRUST);
  const project = input?.project ?? { id: "", name: "" };
  const thread = input?.thread ?? { sessionId: "" };
  // 非 principal 来源的报告一律当作**数据**包装（不可信输入隔离，见 m4-design.md §4）
  const rawReport = input?.report;
  const report = isAuthorizingTrust(trust)
    ? clipReport(rawReport)
    : wrapUntrusted(clipReport(rawReport), { source: trust, maxChars: REPORT_MAX_CHARS });
  const next = String(input?.next ?? "").trim() || "summarize what changed for the user";
  const wakeId = String(input?.wakeId ?? `${reason}:${thread.sessionId}:${thread.turn ?? 0}`);

  const head = [
    "[project-wake v1]",
    `wake: ${wakeId}`,
    `reason: ${reason}`,
    `trust: ${trust}`,
    `project: ${project.id} (${project.name})`,
    `thread: ${thread.sessionId} (state=${thread.state ?? "unknown"}, turn=${thread.turn ?? 0}${
      thread.branch ? `, branch=${thread.branch}` : ""
    })`,
  ].join("\n");

  const context = clipReport(input?.context, CONTEXT_MAX_CHARS);
  const persona = clipReport(input?.persona, PERSONA_MAX_CHARS);
  const sections = [
    { name: "wake", text: head },
    ...(context === "" ? [] : [{ name: "project", text: `project-context:\n${context}` }]),
    ...(persona === "" ? [] : [{ name: "persona", text: `persona:\n${persona}` }]),
    ...(report === "" ? [] : [{ name: "report", text: `report:\n${report}` }]),
    { name: "next", text: `next: ${next}` },
  ];

  return {
    wakeId,
    text: sections.map((section) => section.text).join("\n\n"),
    sections,
    trust,
    authorized: isAuthorizingTrust(trust),
  };
}

/**
 * 一次 turn 内的注入去重器。
 * agent/pre-step 每个 step 都会触发，所以「这封信注入过没有」必须记在这里。
 * @returns {{ shouldInject: (wakeId: string) => boolean, reset: () => void, size: () => number }}
 */
export function createInjectionGuard() {
  /** @type {Set<string>} */
  let seen = new Set();
  return {
    shouldInject: (wakeId) => {
      const key = String(wakeId ?? "");
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    reset: () => {
      seen = new Set();
    },
    size: () => seen.size,
  };
}

/**
 * 序列化给持久 UserMessage 用的 source（宿主要求 form: "snapshot" + sections）。
 * @param {{ sections: {name: string, text: string}[] }} envelope
 * @returns {{ kind: string, form: string, sections: {name: string, text: string}[] }}
 */
export function toMessageSource(envelope) {
  return {
    kind: "projects-wake",
    form: "snapshot",
    sections: envelope.sections.map((section) => ({ name: section.name, text: section.text })),
  };
}

/**
 * 决定这次线程活动要不要给协调器发信封。三条分支都有明确理由，纯函数便于单测：
 *  - `skip-turn`：这一轮之前已经通知过（水位），最常见的正常重复；
 *  - `skip-dedupe`：两个 turn/end 并发到达，水位还没写回，靠同步 guard 挡第二个；
 *  - `send`：真正要发。
 * @param {{ turn: number, lastWakeTurn: number, wakeId: string, guard: { shouldInject: (wakeId: string) => boolean } }} input
 * @returns {"send"|"skip-turn"|"skip-dedupe"}
 */
export function decideWake(input) {
  const turn = Number(input?.turn ?? 0);
  const last = Number(input?.lastWakeTurn ?? 0);
  if (turn <= last) return "skip-turn";
  if (!input?.guard?.shouldInject(String(input?.wakeId ?? ""))) return "skip-dedupe";
  return "send";
}

/**
 * 冷会话唤醒：应用关着时线程可能已经跑完（或失败），协调器却从没收到信封。
 * 启动时用这个纯函数算出「欠了哪些唤醒」——只算需要人关注的终态，避免把 idle 也算进来。
 * @param {Array<{ sessionId: string, lastWakeTurn?: number }>|null|undefined} threads
 * @param {Map<string, { turn?: number, state?: string }>} views
 * @returns {Array<{ sessionId: string, turn: number, state: string }>}
 */
export function pendingWakes(threads, views) {
  const list = Array.isArray(threads) ? threads : [];
  /** @type {Array<{ sessionId: string, turn: number, state: string }>} */
  const out = [];
  for (const thread of list) {
    const sessionId = String(thread?.sessionId ?? "");
    if (sessionId === "") continue;
    const view = views?.get?.(sessionId);
    if (!view) continue;
    const state = String(view.state ?? "");
    // 只有需要人看的终态才补唤醒：working/idle 补了也没信息量
    if (state !== "done" && state !== "failed" && state !== "waiting-user") continue;
    const turn = Number(view.turn ?? 0);
    if (turn <= Number(thread?.lastWakeTurn ?? 0)) continue;
    out.push({ sessionId, turn, state });
  }
  return out;
}
