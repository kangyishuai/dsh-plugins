// @ts-check
// `/btw` 的执行回执（**纯内存**，不落盘）：client 半轮询 `btw/notice` 用它给用户
// 立即可见的反馈。
//
// 为什么需要这一层（USIM-U2-06，2026-11-28 审计）：在**空白/首启会话**里，宿主把斜杠命令
// 当 log-only 追加到会话日志，但客户端 `conversationPhase` 仍是 `blank`、走 hero 空态，
// 一个命令卡片都不渲染（docs/runtime/0.2.2-rc.5.md §5.2 实测）。`/btw` 的答案虽然几秒就
// 就绪，用户却什么都看不到。插件不能改宿主，只能用自己的 UI 面（`shell.overlay` 的 toast +
// 右侧栏面板）给回执；而「命令什么时候开始/结束」只有 host 半知道，所以 host 记一条内存
// 通知，client 短轮询取。
//
// 这个模块**不 import 宿主包、不碰文件系统**，可以直接单测（service.js 才连宿主 RPC）。
import { clip } from "./limits.js";

/** toast 里展示的答案预览最多多少字符（不要把一个几万字的答案塞进 RPC）。 */
export const NOTICE_MAX_PREVIEW = 120;

/** 通知状态：进行中 / 成功 / 失败。 */
export const NOTICE_STATES = Object.freeze(["running", "done", "error"]);

/**
 * 把答案压成一行预览：折叠所有空白（换行在 toast 里没有意义）并截断。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function previewOf(value, max = NOTICE_MAX_PREVIEW) {
  const limit = Math.max(1, Math.trunc(Number(max) || NOTICE_MAX_PREVIEW));
  const text = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return "";
  const clipped = clip(text, limit);
  return clipped.truncated ? `${clipped.text}…` : clipped.text;
}

/**
 * 每会话最近一条 `/btw` 回执的跟踪器（内存态，按最近使用限界）。
 *
 * 结构：`{ seq, sessionId, state, threadId, at, ms?, preview?, text? }`。
 * `seq` 全局单调递增：客户端靠它去重，保证同一事件只弹一次（轮询会重复读到同一条）。
 * @param {{ maxSessions?: number, now?: () => number }} [options]
 * @returns {{
 *   begin: (sessionId: string, info?: { threadId?: string }) => any,
 *   done: (sessionId: string, info?: { threadId?: string, ms?: number, preview?: string, answerChars?: number }) => any,
 *   fail: (sessionId: string, info?: { threadId?: string, text?: string }) => any,
 *   latest: (sessionId: string) => any,
 *   size: () => number,
 * }}
 */
export function createNoticeTracker(options = {}) {
  const maxSessions = Math.max(1, Math.trunc(Number(options.maxSessions) || 64));
  const now = typeof options.now === "function" ? options.now : Date.now;
  /** @type {Map<string, any>} */
  const sessions = new Map();
  let seq = 0;

  /**
   * 写入一条通知（同一会话只保留最新一条）并返回它的快照。
   * @param {string} sessionId
   * @param {Record<string, unknown>} patch
   * @returns {any}
   */
  const put = (sessionId, patch) => {
    const id = String(sessionId ?? "");
    if (id === "") return null;
    seq += 1;
    const record = { seq, sessionId: id, at: now(), ...patch };
    // 先删再插：Map 的迭代顺序就是「最近使用」顺序，满了从最旧的一端淘汰。
    sessions.delete(id);
    sessions.set(id, record);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return { ...record };
  };

  return {
    /** @param {string} sessionId @param {{ threadId?: string }} [info] @returns {any} */
    begin(sessionId, info = {}) {
      return put(sessionId, {
        state: "running",
        threadId: String(info.threadId ?? ""),
      });
    },

    /** @param {string} sessionId @param {{ threadId?: string, ms?: number, preview?: string, answerChars?: number }} [info] @returns {any} */
    done(sessionId, info = {}) {
      return put(sessionId, {
        state: "done",
        threadId: String(info.threadId ?? ""),
        ms: Math.max(0, Math.trunc(Number(info.ms) || 0)),
        preview: previewOf(info.preview),
        answerChars: Math.max(0, Math.trunc(Number(info.answerChars) || 0)),
      });
    },

    /** @param {string} sessionId @param {{ threadId?: string, text?: string }} [info] @returns {any} */
    fail(sessionId, info = {}) {
      return put(sessionId, {
        state: "error",
        threadId: String(info.threadId ?? ""),
        text: String(info.text ?? "").trim(),
      });
    },

    /** @param {string} sessionId @returns {any} */
    latest(sessionId) {
      const record = sessions.get(String(sessionId ?? ""));
      return record === undefined ? null : { ...record };
    },

    size() {
      return sessions.size;
    },
  };
}
