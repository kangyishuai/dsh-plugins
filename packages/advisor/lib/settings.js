// @ts-check
// 插件设置：落在 DSH 数据根下的一个 JSON 文件，host 每次徵询前重读（1s 缓存）。
// 单独成文件的理由与 next-step 相同：冒烟脚本改文件即可验证行为，不需要重启宿主。
// 数据根必须可注入（config.dataRoot > $DSH_HOME > ~/.dsh），见 docs/plugin-conventions.md §2。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fromUsd, normalizeCurrency } from "./money.js";

/** 设置文件名（位于数据根下）。 */
export const SETTINGS_FILE = "advisor.settings.json";

/** 三种模式：关闭 / 影子（只记账不回灌）/ 顾问（正常徵询）。 */
export const MODES = Object.freeze(/** @type {const} */ (["off", "shadow", "advisory"]));

/** 「记录发送内容」的取值：首尾预览 / 不记录。 */
export const TRACE_PROMPT_MODES = Object.freeze(/** @type {const} */ (["preview", "off"]));

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
  currency: "USD",
  usdToCny: 7.2,
  maxCostPerDay: 0,
  priceInputPerMTok: 0,
  priceOutputPerMTok: 0,
  privacyScope: "summary",
  redact: true,
  immuneTurns: 3,
  dedupe: true,
  sessionCap: 24,
  tiers: Object.freeze({}),
  allowedModels: Object.freeze([]),
  confirmedHosts: Object.freeze([]),
  pairingEnforcement: "warn",
  workspaceMaxCallsPerDay: 200,
  workspaceMaxCostPerDay: 0,
  postAnswer: "off",
  advisorTools: false,
  tracePrompt: "preview",
  timeoutMs: 90000,
  maxInputChars: 60000,
});

/** 整数类数值字段的夹紧区间。`0` 在预算类字段里表示「不限」。 */
const INT_LIMITS = Object.freeze({
  maxTokens: [256, 32000],
  maxCallsPerTurn: [0, 8],
  maxCallsPerSession: [0, 1000],
  maxCallsPerHour: [0, 500],
  immuneTurns: [0, 20],
  sessionCap: [0, 200],
  workspaceMaxCallsPerDay: [0, 100000],
  timeoutMs: [5000, 600000],
  maxInputChars: [4000, 400000],
});

/**
 * 金额类字段：区间 + 小数位。预算按分（2 位），单价按万分之一（4 位）。
 * 金额不能走整数夹紧——0.5 会被取整成 1，0.15 会变成 0。
 */
const MONEY_LIMITS = Object.freeze({
  maxCostPerDay: { min: 0, max: 10000, digits: 2 },
  workspaceMaxCostPerDay: { min: 0, max: 10000, digits: 2 },
  priceInputPerMTok: { min: 0, max: 1000, digits: 4 },
  priceOutputPerMTok: { min: 0, max: 1000, digits: 4 },
});

/** 汇率区间：1 USD = 0.1–100 CNY，保留 4 位小数。 */
const RATE_LIMIT = Object.freeze({ min: 0.1, max: 100, digits: 4 });

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
 * 把数字夹紧到区间并取整（计数字段用）。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 把金额夹紧到区间并按固定小数位收口（金额字段用）。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {number} digits
 * @returns {number}
 */
function clampMoney(value, fallback, min, max, digits) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.min(max, Math.max(min, n));
  const factor = 10 ** digits;
  return Math.round(bounded * factor) / factor;
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
 * 规整字符串数组：去空、去重、截断、限制条数。
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string[]}
 */
export function normalizeStringList(raw, max = 50) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim().slice(0, MAX_STRING);
    if (value === "" || out.includes(value)) continue;
    out.push(value);
    if (out.length >= max) break;
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

  out.currency = normalizeCurrency(input.currency);
  const rawRate = Number(input.usdToCny);
  out.usdToCny =
    Number.isFinite(rawRate) && rawRate > 0
      ? clampMoney(
          rawRate,
          DEFAULT_SETTINGS.usdToCny,
          RATE_LIMIT.min,
          RATE_LIMIT.max,
          RATE_LIMIT.digits,
        )
      : DEFAULT_SETTINGS.usdToCny;

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

  for (const key of /** @type {(keyof typeof INT_LIMITS)[]} */ (Object.keys(INT_LIMITS))) {
    const [min, max] = INT_LIMITS[key];
    out[key] = clampInt(input[key], DEFAULT_SETTINGS[key], min, max);
  }
  for (const key of /** @type {(keyof typeof MONEY_LIMITS)[]} */ (Object.keys(MONEY_LIMITS))) {
    if (key === "maxCostPerDay" || key === "workspaceMaxCostPerDay") continue;
    const spec = MONEY_LIMITS[key];
    out[key] = clampMoney(input[key], DEFAULT_SETTINGS[key], spec.min, spec.max, spec.digits);
  }
  // 旧版 *Usd 键按 USD 迁移到当前币种；新键存在时优先。
  /** @type {Array<[keyof typeof MONEY_LIMITS, string]>} */
  const MIGRATE_MONEY = [
    ["maxCostPerDay", "maxCostPerDayUsd"],
    ["workspaceMaxCostPerDay", "workspaceMaxCostPerDayUsd"],
  ];
  for (const [key, oldKey] of MIGRATE_MONEY) {
    const spec = MONEY_LIMITS[key];
    const raw =
      input[key] !== undefined
        ? input[key]
        : input[oldKey] === undefined
          ? undefined
          : fromUsd(Number(input[oldKey]) || 0, out.currency, out.usdToCny);
    out[key] = clampMoney(raw, DEFAULT_SETTINGS[key], spec.min, spec.max, spec.digits);
  }
  out.temperature = nullableNumber(input.temperature, 0, 2);
  out.tiers = normalizeTiers(input.tiers);
  out.allowedModels = normalizeStringList(input.allowedModels);
  out.confirmedHosts = normalizeStringList(input.confirmedHosts);
  if (typeof input.postAnswer === "string" && ["off", "card"].includes(input.postAnswer)) {
    out.postAnswer = input.postAnswer;
  }
  if (typeof input.advisorTools === "boolean") out.advisorTools = input.advisorTools;
  if (typeof input.tracePrompt === "string" && TRACE_PROMPT_MODES.includes(input.tracePrompt)) {
    out.tracePrompt = input.tracePrompt;
  }

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
