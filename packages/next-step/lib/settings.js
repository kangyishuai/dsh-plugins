// @ts-check
// 插件设置：落在 DSH 数据根下一个 JSON 文件，host 每次生成前重读（1s 缓存）。
// 单独成文件是为了让「关闭 = 不再发起请求」可被冒烟脚本直接验证：改文件即可，不需要重启宿主。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 设置文件名（位于数据根下，与 dsh-input-prediction 的落盘方式一致）。 */
export const SETTINGS_FILE = "next-step.settings.json";

/** 默认设置：卡片开、幽灵关、每会话最多 30 张卡。 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  card: true,
  ghost: false,
  maxCardsPerSession: 30,
  pauseUntil: 0,
  timeoutMs: 20000,
  maxTokens: 500,
  provider: "",
  model: "",
  contextMessages: 12,
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
  for (const key of ["enabled", "card", "ghost"]) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  for (const key of /** @type {(keyof typeof LIMITS)[]} */ (Object.keys(LIMITS))) {
    const [min, max] = LIMITS[key];
    out[key] = clampNumber(input[key], DEFAULT_SETTINGS[key], min, max);
  }
  out.pauseUntil = clampNumber(input.pauseUntil, 0, 0, Number.MAX_SAFE_INTEGER);
  for (const key of ["provider", "model"]) {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    out[key] = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }
  return /** @type {typeof DEFAULT_SETTINGS} */ (out);
}

/**
 * 读取设置文件；不存在或损坏时返回默认值（绝不抛错，避免拖垮插件加载）。
 * @param {{ home: string, logger?: { warn?: (message: string) => void } }} options
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function loadSettings({ home, logger }) {
  const file = settingsPath(home);
  try {
    const text = await readFile(file, "utf8");
    return normalizeSettings(JSON.parse(text));
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`next-step: cannot read ${file}: ${message}`);
    }
    return { ...DEFAULT_SETTINGS };
  }
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
