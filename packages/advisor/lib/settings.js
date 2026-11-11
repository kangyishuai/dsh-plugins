// @ts-check
// 插件设置：落在 DSH 数据根下的一个 JSON 文件，host 每次徵询前重读（1s 缓存）。
// 单独成文件的理由与 next-step 相同：冒烟脚本改文件即可验证行为，不需要重启宿主。
// 数据根必须可注入（config.dataRoot > $DSH_HOME > ~/.dsh），见 docs/plugin-conventions.md §2。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 设置文件名（位于数据根下）。 */
export const SETTINGS_FILE = "advisor.settings.json";

/** 三种模式：关闭 / 影子（只记账不回灌）/ 顾问（正常徵询）。 */
export const MODES = Object.freeze(/** @type {const} */ (["off", "shadow", "advisory"]));

/**
 * 默认设置：**默认关闭**。一个会花钱、会把会话内容发出去的插件必须显式 opt-in。
 * - provider/model 为空时永不发起调用（对齐 Claude「配置 advisor 才生效」）。
 * - privacyScope 默认 summary：只发摘要，不发文件全文。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  mode: "off",
  provider: "",
  model: "",
  reasoningEffort: "",
  maxTokens: 4096,
  temperature: null,
  maxCallsPerTurn: 1,
  maxCallsPerSession: 32,
  maxCallsPerHour: 12,
  maxCostPerDayUsd: 0,
  priceInputPerMTok: 0,
  priceOutputPerMTok: 0,
  privacyScope: "summary",
  redact: true,
  immuneTurns: 3,
  dedupe: true,
  sessionCap: 24,
  tiers: Object.freeze({}),
  pairingEnforcement: "warn",
  timeoutMs: 90000,
  maxInputChars: 60000,
});

/** 数值字段的夹紧区间。`0` 在预算类字段里表示「不限」。 */
const LIMITS = Object.freeze({
  maxTokens: [256, 32000],
  maxCallsPerTurn: [0, 8],
  maxCallsPerSession: [0, 1000],
  maxCallsPerHour: [0, 500],
  maxCostPerDayUsd: [0, 10000],
  priceInputPerMTok: [0, 1000],
  priceOutputPerMTok: [0, 1000],
  immuneTurns: [0, 20],
  sessionCap: [0, 200],
  timeoutMs: [5000, 600000],
  maxInputChars: [4000, 400000],
});

/** 字符串字段的最大长度，防止有人在设置里塞进一整段提示词。 */
const MAX_STRING = 300;

/**
 * 数据根下的设置文件路径。
 * @param {string} home 数据根（DSH_HOME 或 profile 数据目录）
 * @returns {string}
 */
export function settingsPath(home) {
  return join(home, SETTINGS_FILE);
}

/**
 * 把数字夹紧到区间并取整。
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
 * 夹紧一个可空的数字（`temperature` 用：`null` 表示「不传，让 adapter 决定」）。
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function nullableNumber(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * 规整档位表：只接受 `provider/model` → 正整数档位。非法项丢弃。
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
export function normalizeTiers(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const id = typeof key === "string" ? key.trim() : "";
    if (id === "" || id.length > MAX_STRING) continue;
    const rank = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(rank) || rank < 0) continue;
    out[id] = Math.round(rank);
  }
  return out;
}

/**
 * 把任意输入规整成合法设置：未知键丢弃、类型不符回落默认、数字夹紧、字符串截断。
 * @param {unknown} raw 文件内容或 RPC patch 合并后的值
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === "object" ? /** @type {any} */ (raw) : {};
  /** @type {any} */
  const out = { ...DEFAULT_SETTINGS };

  if (typeof input.mode === "string" && MODES.includes(input.mode)) out.mode = input.mode;

  for (const key of ["provider", "model", "reasoningEffort"]) {
    if (typeof input[key] === "string") out[key] = input[key].trim().slice(0, MAX_STRING);
  }

  if (
    typeof input.privacyScope === "string" &&
    ["full", "summary", "off"].includes(input.privacyScope)
  ) {
    out.privacyScope = input.privacyScope;
  }
  if (
    typeof input.pairingEnforcement === "string" &&
    ["warn", "block"].includes(input.pairingEnforcement)
  ) {
    out.pairingEnforcement = input.pairingEnforcement;
  }
  for (const key of ["redact", "dedupe"]) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }

  for (const key of /** @type {(keyof typeof LIMITS)[]} */ (Object.keys(LIMITS))) {
    const [min, max] = LIMITS[key];
    out[key] = clampNumber(input[key], DEFAULT_SETTINGS[key], min, max);
  }
  out.temperature = nullableNumber(input.temperature, 0, 2);
  out.tiers = normalizeTiers(input.tiers);

  return out;
}

/**
 * 覆盖合并：`patch` 里出现的键才改，其余保持当前值。
 * @param {typeof DEFAULT_SETTINGS} current
 * @param {unknown} patch
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function mergeSettings(current, patch) {
  const base = current !== null && typeof current === "object" ? current : DEFAULT_SETTINGS;
  const input = patch !== null && typeof patch === "object" ? /** @type {any} */ (patch) : {};
  /** @type {Record<string, unknown>} */
  const merged = { ...base };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(input, key)) merged[key] = input[key];
  }
  return normalizeSettings(merged);
}

/**
 * 读设置文件；不存在或损坏时返回默认值（绝不抛给调用方）。
 * @param {{ home: string, logger?: DSH.Logger }} options
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function loadSettings(options) {
  const path = settingsPath(options.home);
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    return normalizeSettings(parsed);
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "ENOENT" && options.logger) {
      options.logger.warn(`[advisor] 设置文件无法解析，已回落到默认值：${String(error)}`);
    }
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

/**
 * 原子写设置文件（先写临时文件再 rename），避免半截文件让后续读取回落默认值。
 * @param {{ home: string, settings: typeof DEFAULT_SETTINGS }} options
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function saveSettings(options) {
  const next = normalizeSettings(options.settings);
  const path = settingsPath(options.home);
  const temp = `${path}.tmp`;
  await mkdir(options.home, { recursive: true });
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, path);
  return next;
}

/**
 * 「已配置顾问」：provider 与 model 都非空。没配就永不发起调用。
 * @param {typeof DEFAULT_SETTINGS} [settings]
 * @returns {boolean}
 */
export function isConfigured(settings) {
  const s = settings ?? DEFAULT_SETTINGS;
  return (
    typeof s.provider === "string" &&
    s.provider !== "" &&
    typeof s.model === "string" &&
    s.model !== ""
  );
}
