// @ts-check
// 工作区级共享预算池：多个会话共用一份「今天已经花掉多少」的账。
//
// 为什么需要：会话级上限挡不住「开十个会话各花满一次」，而日报表又要跨会话累计。
// 落盘 `<dataRoot>/advisor/budget.json`，按本地日键滚动；写入走临时文件 + rename。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { toUsd } from "./money.js";

/** 预算池文件名（位于数据根下的 advisor/ 目录）。 */
export const BUDGET_FILE = "budget.json";

/**
 * 本地日键 YYYY-MM-DD。
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
 * 规整预算池内容：跨日自动清零。
 * @param {unknown} raw
 * @param {string} today
 * @returns {{ day: string, calls: number, costUsd: number }}
 */
export function normalizePool(raw, today) {
  const input = raw !== null && typeof raw === "object" ? /** @type {any} */ (raw) : {};
  if (input.day !== today) return { day: today, calls: 0, costUsd: 0 };
  return {
    day: today,
    calls: Math.max(0, Math.round(Number(input.calls ?? 0) || 0)),
    costUsd: Math.max(0, Number(input.costUsd ?? 0) || 0),
  };
}

/**
 * 池子是否还能容纳一次调用。
 * @param {{ calls: number, costUsd: number }} pool
 * @param {{ workspaceMaxCallsPerDay: number, workspaceMaxCostPerDay: number, currency?: string, usdToCny?: number }} settings
 * @param {number} [estimatedCostUsd]
 * @returns {{ ok: true } | { ok: false, code: "workspace_calls"|"workspace_budget", used: number, limit: number }}
 */
export function checkPool(pool, settings, estimatedCostUsd = 0) {
  const maxCalls = Number(settings?.workspaceMaxCallsPerDay ?? 0) || 0;
  if (maxCalls > 0 && pool.calls >= maxCalls) {
    return { ok: false, code: "workspace_calls", used: pool.calls, limit: maxCalls };
  }
  const maxCostUsd = toUsd(
    settings?.workspaceMaxCostPerDay,
    settings?.currency,
    settings?.usdToCny,
  );
  if (maxCostUsd > 0 && pool.costUsd + estimatedCostUsd >= maxCostUsd) {
    return { ok: false, code: "workspace_budget", used: pool.costUsd, limit: maxCostUsd };
  }
  return { ok: true };
}

/**
 * @param {{ home: string, logger?: DSH.Logger }} options
 * @returns {{ read: () => Promise<{ day: string, calls: number, costUsd: number }>, add: (input: { calls?: number, costUsd?: number }) => Promise<{ day: string, calls: number, costUsd: number }>, path: string }}
 */
export function createBudgetPool(options) {
  const dir = join(options.home, "advisor");
  const path = join(dir, BUDGET_FILE);

  /** @returns {Promise<{ day: string, calls: number, costUsd: number }>} */
  const read = async () => {
    const today = dayKey();
    try {
      const text = await readFile(path, "utf8");
      return normalizePool(JSON.parse(text), today);
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== "ENOENT") options.logger?.warn?.(`[advisor] 读取预算池失败：${String(error)}`);
      return { day: today, calls: 0, costUsd: 0 };
    }
  };

  /** @param {{ calls?: number, costUsd?: number }} input */
  const add = async (input) => {
    const current = await read();
    const next = {
      day: current.day,
      calls: current.calls + Math.max(0, Math.round(Number(input?.calls ?? 0) || 0)),
      costUsd: current.costUsd + Math.max(0, Number(input?.costUsd ?? 0) || 0),
    };
    try {
      await mkdir(dir, { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temp, path);
    } catch (error) {
      options.logger?.warn?.(`[advisor] 写预算池失败：${String(error)}`);
    }
    return next;
  };

  return { read, add, path };
}
