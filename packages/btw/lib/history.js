// @ts-check
// 旁问历史的持久化：一个父会话一个 JSONL 文件。只存旁问本身，绝不 dump 主会话内容。
// 直接操作文件系统的原因：ctx.storageDomain 的精确契约尚未验证（见 notes/btw/spec.md §5），
// 先按「可注入 dataRoot + 纯文件」实现，后续可整体替换成宿主存储。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LIMITS } from "./limits.js";

/**
 * 每个文件一条写队列：把「读全量 → push → 整体重写」串行化。
 *
 * 之前两个并发的 `/btw`（同一父会话）会各自读到同一份旧内容、各自 rename，
 * 后写覆盖前写 → 丢记录（AUD-BTW-05）。队列只覆盖本进程：宿主是单进程，
 * 同一 profile 不会被两个进程同时写同一个会话文件（临时文件用唯一名兜住撞名）。
 * @type {Map<string, Promise<unknown>>}
 */
const writeQueues = new Map();

/**
 * 在文件的写队列里排队执行，返回操作本身的结果。
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function enqueueWrite(file, operation) {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  // previous 永远是一条「已吞掉错误」的尾链，因此这里不会因为前一次失败而短路。
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(file, tail);
  void tail.then(() => {
    // 队列清空后回收，避免按文件数只增不删。
    if (writeQueues.get(file) === tail) writeQueues.delete(file);
  });
  return result;
}

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
 * 追加一条记录并按上限裁剪。原子写 + 同文件串行化（先写临时文件再 rename）。
 * @param {string | undefined} file
 * @param {any} record
 * @param {number} [limit] 每会话保留条数（服务端传设置里的 historyLimit，默认 50）
 * @returns {Promise<any[]>} 落盘后的记录列表
 */
export async function appendRecord(file, record, limit = LIMITS.perSessionRecords) {
  if (file === undefined) return [];
  const keep = Math.max(1, Math.trunc(Number(limit) || LIMITS.perSessionRecords));
  return enqueueWrite(file, async () => {
    const existing = await readRecords(file);
    existing.push(record);
    const kept = existing.slice(-keep);
    await mkdir(dirname(file), { recursive: true });
    // 临时名带随机后缀：同进程/同毫秒的两次写入不会撞同一个临时文件（AUD-BTW-05）。
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}.tmp`;
    const body = `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(temp, body, "utf8");
    await rename(temp, file);
    return kept;
  });
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
