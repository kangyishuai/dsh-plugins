// @ts-check
// 插件设置：落在数据根下一个 JSON 文件，host 每次使用前重读。
// **纯模块**（不 import 宿主包），便于单测直接引用——service.js 会 import 宿主 RPC 协议，
// 在 node --test 里解析不到。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LIMITS } from "./limits.js";

/** 设置文件名（位于 <dataRoot>/btw/ 下）。 */
export const SETTINGS_FILE = "settings.json";
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * `historyLimit` 的对外边界（设置页可改、服务端按它裁剪历史）。
 * 上限 200 是「设置能表达的范围」，与 `LIMITS.perSessionRecords`（默认 50）是两个概念：
 * 默认值可以按产品取舍变，用户能调的范围在这里统一。
 */
export const HISTORY_LIMIT_MIN = 1;
export const HISTORY_LIMIT_MAX = 200;

/** 默认设置：只读（零工具）、每会话 50 条历史。 */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  /** 允许旁问使用的工具名；空数组 = 完全只读。 */
  allowedTools: Object.freeze([]),
  /** 每会话保留的旁问条数。 */
  historyLimit: LIMITS.perSessionRecords,
  /** 主对话里是否还回显完整答案；false = 只在旁问面板展示。 */
  echoAnswer: true,
  /** 大会话里是否允许用 bounded（spawn + 最近 N 条）代替 full fork；默认关。 */
  boundedContext: false,
});

/** @param {string} dataRoot @returns {string} */
export function settingsPath(dataRoot) {
  return join(dataRoot, "btw", SETTINGS_FILE);
}

/**
 * 把「每会话保留条数」夹紧到 1–200；非法值回落默认。
 *
 * **单独抽出来**是因为服务端（`history.js` 的裁剪、`service.js` 的 5 条读写路径）
 * 和设置页必须用同一个边界：2026-11 审计发现设置页能改能存、服务端却硬编码 50，
 * 任何值都不生效（AUD-BTW-01）。
 * @param {{ historyLimit?: unknown } | null | undefined} stored
 * @returns {number}
 */
export function historyLimitOf(stored) {
  const limit = Number(stored?.historyLimit);
  if (!Number.isFinite(limit)) return LIMITS.perSessionRecords;
  return Math.min(Math.max(Math.trunc(limit), HISTORY_LIMIT_MIN), HISTORY_LIMIT_MAX);
}

/**
 * 把任意输入夹紧成合法设置。
 * @param {any} raw
 * @returns {{ schemaVersion: number, allowedTools: string[], historyLimit: number, echoAnswer: boolean, boundedContext: boolean }}
 */
export function sanitizeSettings(raw) {
  const input = raw !== null && typeof raw === "object" ? raw : {};
  const rawTools = Array.isArray(input.allowedTools)
    ? input.allowedTools
    : typeof input.allowedTools === "string"
      ? String(input.allowedTools).split(",")
      : [];
  /** @type {string[]} */
  const allowedTools = [];
  for (const entry of rawTools) {
    const name = String(entry ?? "").trim();
    if (name === "" || name === "send_message") continue;
    if (allowedTools.includes(name)) continue;
    allowedTools.push(name);
    if (allowedTools.length >= LIMITS.allowedToolsMax) break;
  }
  const historyLimit = historyLimitOf(input);
  // 只有显式 false 关闭；缺省/other 值保持 true（旧设置文件与向后兼容）。
  const echoAnswer = input.echoAnswer !== false;
  // bounded 是 opt-in：只有显式 true 才开，缺省/旧设置保持关闭。
  const boundedContext = input.boundedContext === true;
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    allowedTools,
    historyLimit,
    echoAnswer,
    boundedContext,
  };
}

/**
 * 把 updateSettings 的入参收敛成「只含已知字段」的补丁。
 * **单独抽出来**是为了单测能直接断言 `echoAnswer` 没被漏掉（2026-11-18 真机踩到：
 * updateSettings 手写 spread 时漏了这个新字段，设置保存后又被默认值覆盖）。
 * @param {any} input
 * @returns {Record<string, unknown>}
 */
export function buildSettingsPatch(input) {
  const source = input !== null && typeof input === "object" ? input : {};
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (source.allowedTools !== undefined) patch.allowedTools = source.allowedTools;
  if (source.historyLimit !== undefined) patch.historyLimit = source.historyLimit;
  if (source.echoAnswer !== undefined) patch.echoAnswer = source.echoAnswer;
  if (source.boundedContext !== undefined) patch.boundedContext = source.boundedContext;
  return patch;
}

/**
 * 读设置；文件缺失、坏 JSON、坏字段一律静默回落到默认值。
 * @param {string} dataRoot
 * @returns {Promise<{ schemaVersion: number, allowedTools: string[], historyLimit: number, echoAnswer: boolean, boundedContext: boolean }>}
 */
export async function loadSettings(dataRoot) {
  let text;
  try {
    text = await readFile(settingsPath(dataRoot), "utf8");
  } catch {
    return sanitizeSettings(DEFAULT_SETTINGS);
  }
  try {
    return sanitizeSettings(JSON.parse(text));
  } catch {
    return sanitizeSettings(DEFAULT_SETTINGS);
  }
}

/**
 * 读设置并返回**生效的**每会话历史保留条数（1–200）。
 *
 * 服务端每条历史读写路径都走这里，保证设置页的改动立刻生效（AUD-BTW-01）。
 * @param {string} dataRoot
 * @returns {Promise<number>}
 */
export async function readHistoryLimit(dataRoot) {
  const stored = await loadSettings(dataRoot).catch(() => undefined);
  return historyLimitOf(stored);
}

/**
 * 原子写设置（先写临时文件再 rename）。
 * @param {string} dataRoot
 * @param {any} patch 只合并已知字段
 * @returns {Promise<{ schemaVersion: number, allowedTools: string[], historyLimit: number, echoAnswer: boolean, boundedContext: boolean }>}
 */
export async function saveSettings(dataRoot, patch) {
  const current = await loadSettings(dataRoot);
  const merged = sanitizeSettings({ ...current, ...(patch ?? {}) });
  const file = settingsPath(dataRoot);
  await mkdir(dirname(file), { recursive: true });
  // 临时名带随机后缀：同进程/同毫秒的两次保存不会撞同一个临时文件（AUD-BTW-05 同源问题）。
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return merged;
}
