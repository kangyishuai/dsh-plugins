// @ts-check
// 插件设置：落在 DSH 数据根下一个 JSON 文件，host 每次生成前重读（1s 缓存）。
// 单独成文件是为了让「关闭 = 不再发起请求」可被冒烟脚本直接验证：改文件即可，不需要重启宿主。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isCardTier } from "./scheme.js";

/** 设置文件名（位于数据根下，与 dsh-input-prediction 的落盘方式一致）。 */
export const SETTINGS_FILE = "next-step.settings.json";

/** 当前设置结构版本：v2 起有 schemaVersion / cardThreshold / telemetry。 */
export const SETTINGS_SCHEMA_VERSION = 2;

/** v1 时代的 `maxCardsPerSession` 默认值（迁移时只动这个值，见 migrateSettings）。 */
export const LEGACY_MAX_CARDS = 30;

/** 默认设置：卡片开、幽灵关、出卡档位 balanced、每会话最多 120 张卡、采集开。 */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  enabled: true,
  card: true,
  ghost: false,
  cardThreshold: "could",
  maxCardsPerSession: 120,
  pauseUntil: 0,
  timeoutMs: 20000,
  maxTokens: 500,
  provider: "",
  model: "",
  contextMessages: 12,
  telemetry: true,
});

/** 数值字段的夹紧区间。 */
const LIMITS = Object.freeze({
  maxCardsPerSession: [0, 1000],
  timeoutMs: [3000, 120000],
  maxTokens: [128, 4000],
  contextMessages: [4, 40],
});

/** 字符串字段的最大长度（防止配置里塞进一整段 prompt）。 */
const MAX_STRING = 200;

/**
 * 数据根下的设置文件路径。
 * @param {string} home 数据根（DSH_HOME 或 profile 数据目录）
 * @returns {string}
 */
export function settingsPath(home) {
  return join(home, SETTINGS_FILE);
}

/**
 * 把一个数字字段夹紧到合法区间并取整。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 规整任意输入为合法设置：未知键丢弃、类型不符回落默认、数字夹紧、字符串截断。
 * @param {unknown} raw 原始设置（文件内容或 RPC patch 的合并结果）
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === "object" ? /** @type {any} */ (raw) : {};
  /** @type {any} */
  const out = { ...DEFAULT_SETTINGS };
  for (const key of ["enabled", "card", "ghost", "telemetry"]) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  // 档位是枚举：非法值回落默认档位（而不是"永不出卡"或"每轮都出"）
  if (isCardTier(input.cardThreshold)) out.cardThreshold = input.cardThreshold;
  for (const key of /** @type {(keyof typeof LIMITS)[]} */ (Object.keys(LIMITS))) {
    const [min, max] = LIMITS[key];
    out[key] = clampNumber(input[key], DEFAULT_SETTINGS[key], min, max);
  }
  out.pauseUntil = clampNumber(input.pauseUntil, 0, 0, Number.MAX_SAFE_INTEGER);
  for (const key of ["provider", "model"]) {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    out[key] = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }
  out.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return /** @type {typeof DEFAULT_SETTINGS} */ (out);
}

/**
 * v1 → v2 迁移（纯函数，便于单测）。
 *
 * 只做两件事，且都不覆盖用户的显式选择：
 * 1. 文件没有 `schemaVersion` 时补上版本号（一次性写回，之后不再判断）；
 * 2. `maxCardsPerSession` **恰好等于 v1 默认值 30** 时抬到新的默认 120。
 *    显式写过 `schemaVersion: 2` 的文件即使值是 30 也不动——那说明是用户自己设的。
 * @param {unknown} raw 文件内容
 * @returns {{ settings: typeof DEFAULT_SETTINGS, migrated: boolean }}
 */
export function migrateSettings(raw) {
  const input = raw !== null && typeof raw === "object" ? /** @type {any} */ (raw) : null;
  if (input === null) return { settings: { ...DEFAULT_SETTINGS }, migrated: false };
  if (input.schemaVersion === SETTINGS_SCHEMA_VERSION) {
    return { settings: normalizeSettings(input), migrated: false };
  }
  /** @type {any} */
  const patched = { ...input };
  if (patched.maxCardsPerSession === LEGACY_MAX_CARDS) {
    patched.maxCardsPerSession = DEFAULT_SETTINGS.maxCardsPerSession;
  }
  return { settings: normalizeSettings(patched), migrated: true };
}

/**
 * 读设置文件原文；不存在或损坏时返回 `{ raw: null }`（绝不抛错，避免拖垮插件加载）。
 * @param {{ home: string, logger?: { warn?: (message: string) => void } }} options
 * @returns {Promise<{ raw: any | null, exists: boolean }>}
 */
export async function readSettingsFile({ home, logger }) {
  const file = settingsPath(home);
  try {
    const text = await readFile(file, "utf8");
    return { raw: JSON.parse(text), exists: true };
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`next-step: cannot read ${file}: ${message}`);
    }
    return { raw: null, exists: code !== "ENOENT" };
  }
}

/**
 * 读取设置并附带「是否需要写回迁移结果」的标记（service 用这个）。
 * @param {{ home: string, logger?: { warn?: (message: string) => void } }} options
 * @returns {Promise<{ settings: typeof DEFAULT_SETTINGS, migrated: boolean, exists: boolean }>}
 */
export async function loadSettingsWithMeta({ home, logger }) {
  const { raw, exists } = await readSettingsFile({ home, logger });
  if (raw === null) return { settings: { ...DEFAULT_SETTINGS }, migrated: false, exists };
  const { settings, migrated } = migrateSettings(raw);
  return { settings, migrated, exists };
}

/**
 * 读取设置文件；不存在或损坏时返回默认值。
 * @param {{ home: string, logger?: { warn?: (message: string) => void } }} options
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function loadSettings({ home, logger }) {
  const { settings } = await loadSettingsWithMeta({ home, logger });
  return settings;
}

/**
 * 合并并原子写入设置（tmp + rename），返回写入后的完整设置。
 * @param {{ home: string, patch: unknown, logger?: { warn?: (message: string) => void } }} options
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function saveSettings({ home, patch, logger }) {
  const current = await loadSettings({ home, logger });
  const merged = normalizeSettings({ ...current, .../** @type {any} */ (patch ?? {}) });
  const file = settingsPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(home, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`next-step: cannot write ${file}: ${message}`);
  }
  return merged;
}
