// @ts-check
// 本地事件日志：`<dataRoot>/next-step/events.jsonl`，一行一个事件，append-only，2 MB 滚动。
//
// 为什么单独一个文件、不写进会话日志：
// - 会话日志是**对话的一部分**（会随 fork 复制、会被投影折叠、用户看得到）；逐轮分析数据
//   （闸门、耗时、token、曝光、结局）不是对话内容，混进去会污染 fork 并放大体积。
// - 落盘约定沿用 advisor 的 `decisions.jsonl`：一轮一行、append-only、超过上限改名保留一份历史。
//
// 隐私边界（硬性）：**不写用户原文**。用户消息只留长度、延迟、与胶囊重合的具体对象个数；
// 胶囊文案（我们自己生成的 ≤20 字 × 1–2 条）要写，因为复盘按钮文案必须看它；
// 摘要/提问只写长度（全文在会话日志里）。
//
// 可靠性：所有写入都是「尽力而为」——失败只 warn 一次，绝不抛进回合流程。

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { PROMPT_VERSION, SCHEME } from "./scheme.js";

/** 事件目录名（位于数据根下）。 */
export const EVENTS_DIR = "next-step";
/** 事件文件名。 */
export const EVENTS_FILE = "events.jsonl";
/** 滚动阈值：超过就改名 `.1`（旧的 `.1` 丢弃）。 */
export const EVENTS_MAX_BYTES = 2 * 1024 * 1024;
/** 事件结构版本。 */
export const EVENTS_VERSION = 1;

/**
 * 事件目录。
 * @param {string} home 数据根
 * @returns {string}
 */
export function eventsDirOf(home) {
  return join(home, EVENTS_DIR);
}

/**
 * 事件文件路径。
 * @param {string} home 数据根
 * @returns {string}
 */
export function eventsPathOf(home) {
  return join(eventsDirOf(home), EVENTS_FILE);
}

/**
 * 会话 id → 稳定的 8 位短哈希（跨会话统计用，不必把完整 id 落盘）。
 * @param {string} sessionId
 * @returns {string}
 */
export function sidOf(sessionId) {
  const text = typeof sessionId === "string" ? sessionId : "";
  if (text === "") return "unknown";
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * @param {{ at: number, sid: string, turn: number, tier: string, feat: { answerChars: number, toolCalls: number }, gate: string, cand?: any }} input
 * @returns {any}
 */
export function turnEvent(input) {
  return {
    t: "turn",
    at: input.at,
    sid: input.sid,
    turn: input.turn,
    tier: input.tier,
    feat: { answerChars: input.feat.answerChars, toolCalls: input.feat.toolCalls },
    gate: input.gate,
    ...(input.cand === undefined ? {} : { cand: input.cand }),
  };
}

/**
 * @param {{ at: number, sid: string, turn: number, kind: "clicked" | "dismissed", index?: number, stance?: string, labelLen?: number, msSinceShown?: number }} input
 * @returns {any}
 */
export function actionEvent(input) {
  return {
    t: "action",
    at: input.at,
    sid: input.sid,
    turn: input.turn,
    kind: input.kind,
    ...(input.index === undefined ? {} : { index: input.index }),
    ...(input.stance === undefined ? {} : { stance: input.stance }),
    ...(input.labelLen === undefined ? {} : { labelLen: input.labelLen }),
    ...(input.msSinceShown === undefined ? {} : { msSinceShown: input.msSinceShown }),
  };
}

/**
 * @param {{ at: number, sid: string, turn: number, typed: boolean, delayMs: number, textChars: number, overlap: number }} input
 * @returns {any}
 */
export function followupEvent(input) {
  return {
    t: "followup",
    at: input.at,
    sid: input.sid,
    turn: input.turn,
    typed: input.typed,
    delayMs: Math.max(0, Math.round(input.delayMs) || 0),
    textChars: Math.max(0, Math.round(input.textChars) || 0),
    overlap: Math.max(0, Math.round(input.overlap) || 0),
  };
}

/**
 * @param {{ at: number, sid: string, turn: number, visibleMs: number, ratio: number }} input
 * @returns {any}
 */
export function impressionEvent(input) {
  return {
    t: "impression",
    at: input.at,
    sid: input.sid,
    turn: input.turn,
    visibleMs: Math.max(0, Math.round(input.visibleMs) || 0),
    // ratio < 0 表示宿主没有 IntersectionObserver：报表把它单列「未知」，不进曝光率分母
    ratio: Number.isFinite(input.ratio) ? input.ratio : -1,
  };
}

/**
 * @param {{ at: number, sid: string, turn: number, found: boolean, value?: string }} input
 * @returns {any}
 */
export function promoteEvent(input) {
  return {
    t: "promote",
    at: input.at,
    sid: input.sid,
    turn: input.turn,
    found: input.found === true,
    ...(input.value === undefined ? {} : { value: input.value }),
  };
}

/**
 * @param {{ at: number, sid: string, turn: number, kind: "schema" | "timeout" | "cancelled" | "llm" | "route", detail?: string }} input
 * @returns {any}
 */
export function errorEvent(input) {
  const detail = typeof input.detail === "string" ? input.detail.slice(0, 200) : "";
  return {
    t: "error",
    at: input.at,
    sid: input.sid,
    turn: input.turn,
    kind: input.kind,
    ...(detail === "" ? {} : { detail }),
  };
}

/**
 * @param {{ at: number, tier: string }} input
 * @returns {any}
 */
export function metaEvent(input) {
  return { t: "meta", at: input.at, tier: input.tier, since: input.at };
}

/**
 * 创建一个事件日志写入器。
 *
 * - 所有写入串行（内部 promise 链），避免滚动与追加交错；
 * - 超过上限时把 `events.jsonl` 改名成 `events.jsonl.1`（旧 `.1` 被覆盖）；
 * - 任何失败只 warn 一次，返回 false，不抛错。
 * @param {{ home: string, pkg?: string, logger?: { warn?: (message: string) => void }, now?: () => number }} options
 * @returns {{
 *   path: string,
 *   append: (event: any) => Promise<boolean>,
 *   ensureMeta: (input: { tier: string }) => Promise<boolean>,
 *   stats: () => Promise<{ path: string, bytes: number, lines: number }>,
 * }}
 */
export function createEventLog({ home, pkg, logger, now }) {
  const path = eventsPathOf(home);
  const dir = eventsDirOf(home);
  const clock = typeof now === "function" ? now : () => Date.now();
  const packageVersion = typeof pkg === "string" ? pkg : "";
  let chain = Promise.resolve();
  let warned = false;
  /** 统计缓存：避免每次设置页刷新都读整个文件。 */
  let statsCache = { at: 0, bytes: 0, lines: 0 };

  /**
   * @param {string} message
   * @param {unknown} [error]
   * @returns {void}
   */
  function warnOnce(message, error) {
    if (warned) return;
    warned = true;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    logger?.warn?.(`next-step: ${message}${detail}`);
  }

  /**
   * @param {any} event
   * @returns {Promise<boolean>}
   */
  async function write(event) {
    const row = {
      v: EVENTS_VERSION,
      scheme: SCHEME,
      pv: PROMPT_VERSION,
      ...(packageVersion === "" ? {} : { pkg: packageVersion }),
      ...event,
    };
    const line = `${JSON.stringify(row)}\n`;
    try {
      await mkdir(dir, { recursive: true });
      const info = await stat(path).catch(() => null);
      if (info !== null && info.size + line.length > EVENTS_MAX_BYTES) {
        // 滚动：改名保留一份历史（旧的 .1 自然被覆盖）
        await rename(path, `${path}.1`).catch(() => undefined);
      }
      await appendFile(path, line, "utf8");
      statsCache.at = 0;
      return true;
    } catch (error) {
      warnOnce("cannot write events log", error);
      return false;
    }
  }

  return {
    path,
    /**
     * 追加一条事件（写入串行化）。
     * @param {any} event
     * @returns {Promise<boolean>}
     */
    append(event) {
      const next = chain.then(() => write(event));
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    /**
     * 首次运行时写一条 meta（记录采集起算点与当时档位）。已有事件时不写。
     *
     * 幂等性放在**串行链内部**判：并发调用时若在外面 stat，两次都会看到「空文件」，
     * 于是写出两条 meta（桌面实测踩到：两个 diagnostics 并发就把起算点写了两遍）。
     * @param {{ tier: string }} input
     * @returns {Promise<boolean>}
     */
    ensureMeta(input) {
      const run = async () => {
        const info = await stat(path).catch(() => null);
        if (info !== null && info.size > 0) return false;
        return write(metaEvent({ at: clock(), tier: input.tier }));
      };
      const next = chain.then(run);
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    /**
     * 文件体积与行数（设置页「回顾」块用；行数是近似值，1 s 内复用缓存）。
     * @returns {Promise<{ path: string, bytes: number, lines: number }>}
     */
    async stats() {
      const at = clock();
      if (statsCache.at !== 0 && at - statsCache.at < 1000) {
        return { path, bytes: statsCache.bytes, lines: statsCache.lines };
      }
      try {
        const info = await stat(path);
        const text = await readFile(path, "utf8");
        const lines = text === "" ? 0 : text.split("\n").filter((row) => row !== "").length;
        statsCache = { at, bytes: info.size, lines };
        return { path, bytes: info.size, lines };
      } catch (_error) {
        return { path, bytes: 0, lines: 0 };
      }
    },
  };
}
