// @ts-check
// 界面偏好的持久化：目前只有一项 —— 删除确认框里「同时删除子会话」的初值。
// 为什么落在宿主侧而不是 localStorage：DSH Web 以 127.0.0.1:<随机端口> 作为 origin，
// 端口一变 localStorage 就是另一份，用户会看到「明明上次勾了却又没勾」。
// 放的规则：坏文件、坏字段一律静默回落到默认值 —— 偏好永远不该阻断一次删除。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireInside, trashRoot } from "./paths.js";

/** 偏好文件版本号。加字段是兼容的；改语义必须递增，读到不认识的版本直接回落默认值。 */
export const PREFERENCES_VERSION = 1;

/**
 * 默认偏好。级联删除默认关闭：ADR 0003 要求「删不删子会话由用户决定」，
 * 记忆只是把用户上一次的决定带过来，不能凭空把默认值改成 true。
 * @type {{ version: number, cascadeChildren: boolean }}
 */
export const DEFAULT_PREFERENCES = Object.freeze({
  version: PREFERENCES_VERSION,
  cascadeChildren: false,
});

/**
 * 偏好文件路径（就在回收站根下，跟审计日志、回执放一起）。
 * @param {string} dataRoot
 * @returns {string}
 */
export function preferencesPath(dataRoot) {
  return requireInside(dataRoot, join(trashRoot(dataRoot), "preferences.json"));
}

/**
 * 把任意输入收敛成一份合法偏好。只认显式 `true`，其余一切（缺失、类型错、老版本）都算 false。
 * @param {unknown} value
 * @returns {{ version: number, cascadeChildren: boolean }}
 */
export function normalizePreferences(value) {
  const record = value && typeof value === "object" ? /** @type {any} */ (value) : {};
  const version = Number.isInteger(record.version) ? record.version : PREFERENCES_VERSION;
  const known = version === PREFERENCES_VERSION;
  return {
    version: PREFERENCES_VERSION,
    cascadeChildren: known && record.cascadeChildren === true,
  };
}

/**
 * 读取偏好。文件不存在是正常情况（首次使用）；损坏时告警并回落默认值。
 * @param {string} dataRoot
 * @param {{ warn?: (message: string) => void }} [logger]
 * @returns {Promise<{ version: number, cascadeChildren: boolean }>}
 */
export async function readPreferences(dataRoot, logger) {
  const file = preferencesPath(dataRoot);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "ENOENT") {
      logger?.warn?.(`session-delete: cannot read ${file}: ${String(error)}`);
    }
    return { ...DEFAULT_PREFERENCES };
  }
  try {
    return normalizePreferences(JSON.parse(raw));
  } catch (error) {
    logger?.warn?.(`session-delete: ignoring malformed ${file}: ${String(error)}`);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * 写入偏好：合并补丁 → 校验 → 原子写（临时文件 + rename）。
 * 原子写是必要的：半写文件会让下一次读取回落到默认值，等于用户的选择被静默丢弃。
 * @param {string} dataRoot
 * @param {Record<string, unknown>} patch
 * @param {{ warn?: (message: string) => void }} [logger]
 * @returns {Promise<{ version: number, cascadeChildren: boolean }>}
 */
export async function writePreferences(dataRoot, patch, logger) {
  const current = await readPreferences(dataRoot, logger);
  const next = normalizePreferences({ ...current, ...(patch ?? {}) });
  const file = preferencesPath(dataRoot);
  await mkdir(trashRoot(dataRoot), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return next;
}
