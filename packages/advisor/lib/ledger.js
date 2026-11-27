// @ts-check
// 账本：宿主**不**给额外模型调用记 usage（只有主循环写 assistant/message 的 usage），
// 所以顾问花了多少 token 必须由我们自己记账。这里同时是四级预算的计数器来源。
//
// 落盘：`<dataRoot>/advisor/usage.jsonl`，一次征询一行；文件只追加，超过上限时滚动重命名。
// 追加走 `appendJsonLine`（O_APPEND + 进程内单写队列），不再「读全文 + 覆盖」——
// 后者既不是原子写，并发回合结束时还会互相覆盖丢行（审计 AUD-ADV-01）。
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { dayKey, dayOfEntry } from "./day.js";
import { appendJsonLine } from "./fs-atomic.js";

/** 账本目录名（位于数据根下）。 */
export const LEDGER_DIR = "advisor";
/** 账本文件名。 */
export const LEDGER_FILE = "usage.jsonl";
/** 建议账本（跨会话汇总用，一行一条建议）。 */
export const ADVICE_FILE = "advice.jsonl";
/** 滚动阈值：超过这个字节数就把旧文件改名（保留一份历史，不做无界增长）。 */
export const LEDGER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {object} LedgerEntry
 * @property {string} at ISO 时间
 * @property {string} [day] 本地日键 YYYY-MM-DD（写入时补；旧数据没有，读取时从 at 折算）
 * @property {string} sessionId
 * @property {"tool"|"shadow"|"manual"|"post-answer"} trigger
 * @property {string} provider
 * @property {string} model
 * @property {string} effort
 * @property {"reviewed"|"declined"|"unavailable"} verdict
 * @property {string} [severity]
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} [cacheWriteTokens]
 * @property {number} costUsd
 * @property {number} ms
 * @property {string} [code]
 */

/**
 * @typedef {object} SessionCounters
 * @property {number} turn 最近一次记录的回合号（0 = 未知）
 * @property {number} turnCalls
 * @property {number} sessionCalls
 * @property {number[]} hourStamps
 * @property {number} dayCostUsd
 * @property {string} dayKey YYYY-MM-DD（本地时间）
 */

/**
 * 一条新账本行补上本地日键；已有 `day` 的记录原样返回。
 * @param {LedgerEntry} entry
 * @returns {LedgerEntry}
 */
function withDay(entry) {
  const day = dayOfEntry(entry) || dayKey();
  return day === entry.day ? entry : { ...entry, day };
}

/**
 * @param {{ home: string, logger?: DSH.Logger }} options
 * @returns {{
 *   record: (entry: LedgerEntry) => Promise<void>,
 *   counters: (sessionId: string, now?: number) => SessionCounters,
 *   noteCall: (sessionId: string, input: { turn: number, costUsd: number, at: number }) => void,
 *   resetTurn: (sessionId: string, turn: number) => void,
 *   totals: () => { calls: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, byTrigger: Record<string, number> },
 *   ready: () => Promise<void>,
 *   recordAdvice: (entry: any) => Promise<void>,
 *   adviceTotals: () => Promise<{ total: number, bySeverity: Record<string, number>, byModel: Record<string, number>, byDay: Record<string, number>, byConfidence: Record<string, number> }>,
 *   path: string,
 *   advicePath: string,
 * }}
 */
export function createLedger(options) {
  const dir = join(options.home, LEDGER_DIR);
  const path = join(dir, LEDGER_FILE);
  /** @type {Map<string, SessionCounters>} */
  const countersBySession = new Map();
  /** @type {{ calls: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, byTrigger: Record<string, number> }} */
  const totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    byTrigger: {},
  };
  let loaded = false;

  /**
   * 取某会话的计数器（惰性初始化；跨日自动清零当日花费）。
   * @param {string} sessionId
   * @param {number} [now]
   * @returns {SessionCounters}
   */
  const counters = (sessionId, now = Date.now()) => {
    const today = dayKey(new Date(now));
    let current = countersBySession.get(sessionId);
    if (current === undefined) {
      current = {
        turn: 0,
        turnCalls: 0,
        sessionCalls: 0,
        hourStamps: [],
        dayCostUsd: 0,
        dayKey: today,
      };
      countersBySession.set(sessionId, current);
    }
    if (current.dayKey !== today) {
      current.dayCostUsd = 0;
      current.dayKey = today;
    }
    const hourAgo = now - 60 * 60 * 1000;
    current.hourStamps = current.hourStamps.filter((at) => at > hourAgo);
    return current;
  };

  /**
   * 读历史账本，恢复累计数、**会话级调用数**、**最近一小时时间戳**与今日花费
   * （只读尾部 2MB，避免大文件拖慢启动；更早的历史不参与这几级计数器）。
   * 回合内计数（turnCalls）不恢复：它的生命周期就是一个回合，重启即新的回合。
   */
  const ensureLoaded = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const info = await stat(path);
      const start = Math.max(0, info.size - LEDGER_MAX_BYTES);
      const text = await readFile(path, "utf8");
      const tail = start > 0 ? text.slice(text.lastIndexOf("\n", start) + 1) : text;
      const today = dayKey();
      const hourAgo = Date.now() - 60 * 60 * 1000;
      for (const line of tail.split("\n")) {
        if (line.trim() === "") continue;
        /** @type {any} */
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const cost = Number(entry.costUsd ?? 0) || 0;
        const inputTokens = Number(entry.inputTokens ?? 0) || 0;
        const outputTokens = Number(entry.outputTokens ?? 0) || 0;
        const cacheReadTokens = Number(entry.cacheReadTokens ?? 0) || 0;
        const cacheWriteTokens = Number(entry.cacheWriteTokens ?? 0) || 0;
        totals.calls += 1;
        totals.inputTokens += inputTokens;
        totals.outputTokens += outputTokens;
        totals.cacheReadTokens += cacheReadTokens;
        totals.cacheWriteTokens += cacheWriteTokens;
        totals.costUsd += cost;
        const trigger = typeof entry.trigger === "string" ? entry.trigger : "tool";
        totals.byTrigger[trigger] = (totals.byTrigger[trigger] ?? 0) + 1;
        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "";
        if (sessionId === "") continue;
        const current = countersBySession.get(sessionId) ?? {
          turn: 0,
          turnCalls: 0,
          sessionCalls: 0,
          hourStamps: [],
          dayCostUsd: 0,
          dayKey: today,
        };
        current.sessionCalls += 1;
        const at = Date.parse(typeof entry.at === "string" ? entry.at : "");
        if (Number.isFinite(at) && at > hourAgo) current.hourStamps.push(at);
        // 日键优先用行里的 day（本地日），旧行回落到 at 的本地日期（审计 AUD-ADV-04）。
        if (dayOfEntry(entry) === today) current.dayCostUsd += cost;
        current.dayKey = today;
        countersBySession.set(sessionId, current);
      }
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== "ENOENT") options.logger?.warn?.(`[advisor] 读取账本失败：${String(error)}`);
    }
  };

  const advicePath = join(dir, ADVICE_FILE);

  return {
    path,
    advicePath,

    /**
     * 记录一次征询（先落盘再更新内存；落盘失败不让调用失败）。
     * @param {LedgerEntry} entry
     * @returns {Promise<void>}
     */
    async record(entry) {
      totals.calls += 1;
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
      totals.costUsd += entry.costUsd;
      totals.byTrigger[entry.trigger] = (totals.byTrigger[entry.trigger] ?? 0) + 1;

      try {
        await appendJsonLine(path, withDay(entry), {
          rotateBytes: LEDGER_MAX_BYTES,
          rotateTo: `${path}.1`,
        });
      } catch (error) {
        options.logger?.warn?.(`[advisor] 写账本失败：${String(error)}`);
      }
    },

    counters,

    /**
     * 记一次调用：更新会话/回合/小时/当日计数。
     * @param {string} sessionId
     * @param {{ turn: number, costUsd: number, at: number }} input
     * @returns {void}
     */
    noteCall(sessionId, input) {
      const current = counters(sessionId, input.at);
      if (input.turn > 0 && input.turn !== current.turn) {
        current.turn = input.turn;
        current.turnCalls = 0;
      }
      current.turnCalls += 1;
      current.sessionCalls += 1;
      current.hourStamps.push(input.at);
      current.dayCostUsd += input.costUsd;
    },

    /**
     * 换回合时清零「本回合」计数（工具调用处也会顺带调用）。
     * @param {string} sessionId
     * @param {number} turn
     * @returns {void}
     */
    resetTurn(sessionId, turn) {
      const current = counters(sessionId);
      if (turn !== current.turn) {
        current.turn = turn;
        current.turnCalls = 0;
      }
    },

    /** @returns {{ calls: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, byTrigger: Record<string, number> }} */
    totals() {
      return { ...totals, byTrigger: { ...totals.byTrigger } };
    },

    /**
     * 追加一条建议到跨会话账本（失败只告警，不影响征询）。
     * @param {any} entry
     * @returns {Promise<void>}
     */
    async recordAdvice(entry) {
      try {
        await mkdir(dir, { recursive: true });
        await appendJsonLine(advicePath, withDay(entry));
      } catch (error) {
        options.logger?.warn?.(`[advisor] 写建议账本失败：${String(error)}`);
      }
    },

    /**
     * 跨会话建议汇总（读整个 advice.jsonl；文件很小，一行一条）。
     * @returns {Promise<{ total: number, bySeverity: Record<string, number>, byModel: Record<string, number>, byDay: Record<string, number>, byConfidence: Record<string, number> }>}
     */
    async adviceTotals() {
      /** @type {Record<string, number>} */
      const bySeverity = {};
      /** @type {Record<string, number>} */
      const byModel = {};
      /** @type {Record<string, number>} */
      const byDay = {};
      /** @type {Record<string, number>} */
      const byConfidence = {};
      let total = 0;
      try {
        const text = await readFile(advicePath, "utf8");
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          total += 1;
          const severity = String(entry?.severity ?? "nit");
          const model = String(entry?.model ?? "unknown");
          const day = dayOfEntry(entry) || "unknown";
          const confidence = String(entry?.confidence ?? "low");
          bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
          byModel[model] = (byModel[model] ?? 0) + 1;
          byDay[day] = (byDay[day] ?? 0) + 1;
          byConfidence[confidence] = (byConfidence[confidence] ?? 0) + 1;
        }
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (code !== "ENOENT") options.logger?.warn?.(`[advisor] 读建议账本失败：${String(error)}`);
      }
      return { total, bySeverity, byModel, byDay, byConfidence };
    },

    /** 首次读取时恢复「今日花费」与累计数（调用方不必 await，失败静默）。 */
    ready() {
      return ensureLoaded();
    },
  };
}
