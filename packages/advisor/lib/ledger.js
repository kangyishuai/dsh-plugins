// @ts-check
// 账本：宿主**不**给额外模型调用记 usage（只有主循环写 assistant/message 的 usage），
// 所以顾问花了多少 token 必须由我们自己记账。这里同时是四级预算的计数器来源。
//
// 落盘：`<dataRoot>/advisor/usage.jsonl`，一次徵询一行；文件只追加，超过上限时滚动重命名。
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 * 本地日键，用于「每日预算」跨重启续算。
 * @param {Date} [date]
 * @returns {string}
 */
export function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @param {{ home: string, logger?: DSH.Logger }} options
 * @returns {{
 *   record: (entry: LedgerEntry) => Promise<void>,
 *   counters: (sessionId: string, now?: number) => SessionCounters,
 *   noteCall: (sessionId: string, input: { turn: number, costUsd: number, at: number }) => void,
 *   resetTurn: (sessionId: string, turn: number) => void,
 *   totals: () => { calls: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, byTrigger: Record<string, number> },
 *   recent: (limit?: number) => LedgerEntry[],
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
  /** @type {LedgerEntry[]} */
  const recent = [];
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

  /** 读历史账本，恢复「今日花费」与累计数（只读尾部 2MB，避免大文件拖慢启动）。 */
  const ensureLoaded = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const info = await stat(path);
      const start = Math.max(0, info.size - LEDGER_MAX_BYTES);
      const text = await readFile(path, "utf8");
      const tail = start > 0 ? text.slice(text.lastIndexOf("\n", start) + 1) : text;
      const today = dayKey();
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
        if (recent.length < 50) recent.push(entry);
        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "";
        if (sessionId === "") continue;
        const day = typeof entry.at === "string" ? entry.at.slice(0, 10) : "";
        if (day !== today) continue;
        const counters = countersBySession.get(sessionId) ?? {
          turn: 0,
          turnCalls: 0,
          sessionCalls: 0,
          hourStamps: [],
          dayCostUsd: 0,
          dayKey: today,
        };
        counters.dayCostUsd += cost;
        countersBySession.set(sessionId, counters);
      }
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== "ENOENT") options.logger?.warn?.(`[advisor] 读取账本失败：${String(error)}`);
    }
  };

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

  const advicePath = join(dir, ADVICE_FILE);

  return {
    path,
    advicePath,

    /**
     * 记录一次徵询（先落盘再更新内存；落盘失败不让调用失败）。
     * @param {LedgerEntry} entry
     * @returns {Promise<void>}
     */
    async record(entry) {
      recent.unshift(entry);
      if (recent.length > 50) recent.pop();
      totals.calls += 1;
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
      totals.costUsd += entry.costUsd;
      totals.byTrigger[entry.trigger] = (totals.byTrigger[entry.trigger] ?? 0) + 1;

      try {
        await mkdir(dir, { recursive: true });
        const info = await stat(path).catch(() => undefined);
        if (info && info.size > LEDGER_MAX_BYTES) {
          await rename(path, `${path}.1`).catch(() => undefined);
        }
        const line = `${JSON.stringify(entry)}\n`;
        const existing =
          info && info.size <= LEDGER_MAX_BYTES ? await readFile(path, "utf8").catch(() => "") : "";
        const next = `${existing}${line}`;
        // 一次性重写而不是 append：保证写入原子性（账本比吞吐重要）。
        await writeFile(path, next, "utf8");
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
     * 最近若干条（新→旧）。
     * @param {number} [limit]
     * @returns {LedgerEntry[]}
     */
    recent(limit = 10) {
      return recent.slice(0, Math.max(0, limit));
    },

    /**
     * 追加一条建议到跨会话账本（失败只告警，不影响徵询）。
     * @param {any} entry
     * @returns {Promise<void>}
     */
    async recordAdvice(entry) {
      try {
        await mkdir(dir, { recursive: true });
        const line = `${JSON.stringify(entry)}\n`;
        const existing = await readFile(advicePath, "utf8").catch(() => "");
        await writeFile(advicePath, `${existing}${line}`, "utf8");
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
          const day = typeof entry?.at === "string" ? entry.at.slice(0, 10) : "unknown";
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
