// @ts-check
// 旁问历史的持久化：一个父会话一个 JSONL 文件。只存旁问本身，绝不 dump 主会话内容。
// 直接操作文件系统的原因：ctx.storageDomain 的精确契约尚未验证（见 notes/btw/spec.md §5），
// 先按「可注入 dataRoot + 纯文件」实现，后续可整体替换成宿主存储。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LIMITS } from "./limits.js";

/**
 * 读全部记录；文件不存在或内容损坏的行一律跳过（不抛）。
 * @param {string | undefined} file
 * @returns {Promise<any[]>}
 */
export async function readRecords(file) {
  if (file === undefined) return [];
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
  /** @type {any[]} */
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") out.push(parsed);
    } catch {
      // 损坏行跳过：宁可少一条历史，也不要让整个功能不可用
    }
  }
  return out;
}

/**
 * 追加一条记录并按上限裁剪。原子写：先写临时文件再 rename。
 * @param {string | undefined} file
 * @param {any} record
 * @param {number} [limit]
 * @returns {Promise<any[]>} 落盘后的记录列表
 */
export async function appendRecord(file, record, limit = LIMITS.perSessionRecords) {
  if (file === undefined) return [];
  const existing = await readRecords(file);
  existing.push(record);
  const kept = existing.slice(-limit);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(temp, body, "utf8");
  await rename(temp, file);
  return kept;
}

/**
 * 取最近 n 条（按时间正序，供提示词回放）。
 * @param {string | undefined} file
 * @param {number} [n]
 * @returns {Promise<any[]>}
 */
export async function listRecent(file, n = LIMITS.replayRecords) {
  const all = await readRecords(file);
  return all.slice(-n);
}

/**
 * 取最后一条记录（裸 /btw 用来重开上一次问答）。
 * @param {string | undefined} file
 * @returns {Promise<any | undefined>}
 */
export async function lastRecord(file) {
  const all = await readRecords(file);
  return all[all.length - 1];
}
