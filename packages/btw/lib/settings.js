// @ts-check
// 插件设置：落在数据根下一个 JSON 文件，host 每次使用前重读。
// **纯模块**（不 import 宿主包），便于单测直接引用——service.js 会 import 宿主 RPC 协议，
// 在 node --test 里解析不到。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LIMITS } from "./limits.js";

/** 设置文件名（位于 <dataRoot>/btw/ 下）。 */
export const SETTINGS_FILE = "settings.json";
export const SETTINGS_SCHEMA_VERSION = 1;

/** 默认设置：只读（零工具）、每会话 50 条历史。 */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  /** 允许旁问使用的工具名；空数组 = 完全只读。 */
  allowedTools: Object.freeze([]),
  /** 每会话保留的旁问条数。 */
  historyLimit: LIMITS.perSessionRecords,
  /** 主对话里是否还回显完整答案；false = 只在旁问面板展示。 */
  echoAnswer: true,
});

/** @param {string} dataRoot @returns {string} */
export function settingsPath(dataRoot) {
  return join(dataRoot, "btw", SETTINGS_FILE);
}

/**
 * 把任意输入夹紧成合法设置。
 * @param {any} raw
 * @returns {{ schemaVersion: number, allowedTools: string[], historyLimit: number, echoAnswer: boolean }}
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
  const limitRaw = Number(input.historyLimit);
  const historyLimit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
    : LIMITS.perSessionRecords;
  // 只有显式 false 关闭；缺省/other 值保持 true（旧设置文件与向后兼容）。
  const echoAnswer = input.echoAnswer === false ? false : true;
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, allowedTools, historyLimit, echoAnswer };
}

/**
 * 读设置；文件缺失、坏 JSON、坏字段一律静默回落到默认值。
 * @param {string} dataRoot
 * @returns {Promise<{ schemaVersion: number, allowedTools: string[], historyLimit: number, echoAnswer: boolean }>}
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
 * 原子写设置（先写临时文件再 rename）。
 * @param {string} dataRoot
 * @param {any} patch 只合并已知字段
 * @returns {Promise<{ schemaVersion: number, allowedTools: string[], historyLimit: number, echoAnswer: boolean }>}
 */
export async function saveSettings(dataRoot, patch) {
  const current = await loadSettings(dataRoot);
  const merged = sanitizeSettings({ ...current, ...(patch ?? {}) });
  const file = settingsPath(dataRoot);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return merged;
}
