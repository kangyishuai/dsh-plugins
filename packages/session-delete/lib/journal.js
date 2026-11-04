// @ts-check
// 两阶段提交日志：先写 intent（打算做什么），执行，最后标记 done。
// 启动时扫未完成的条目，决定补做还是回滚 —— 没有它，「安全删除」在断电面前不成立（ADR 0004 §3）。
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { journalDir, requireInside } from "./paths.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * @typedef {object} JournalRecord
 * @property {string} id
 * @property {"intent" | "done" | "failed"} state
 * @property {string} action trash / restore / purge
 * @property {string} startedAt
 * @property {string} [sessionId]
 * @property {string} [entryId]
 * @property {string} [digest]
 * @property {string} [detail]
 * @property {Record<string, unknown>} [extra]
 */

/** @param {string} file @param {unknown} value @returns {Promise<void>} */
async function writeAtomic(file, value) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}

/**
 * @param {string} dataRoot
 * @param {string} id
 * @returns {string}
 */
function recordPath(dataRoot, id) {
  if (!ID_RE.test(id)) throw new Error("invalid journal id");
  const path = join(journalDir(dataRoot), id + ".json");
  requireInside(dataRoot, path);
  return path;
}

/**
 * 开始一次可恢复操作。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.action
 * @param {Record<string, unknown>} [options.extra]
 * @returns {Promise<JournalRecord>}
 */
export async function beginOperation({ dataRoot, action, extra = {} }) {
  await mkdir(journalDir(dataRoot), { recursive: true });
  /** @type {JournalRecord} */
  const record = {
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    state: "intent",
    action,
    startedAt: new Date().toISOString(),
    ...extra,
  };
  await writeAtomic(recordPath(dataRoot, record.id), record);
  return record;
}

/**
 * 更新一条操作记录。
 * @param {string} dataRoot
 * @param {string} id
 * @param {Partial<JournalRecord>} patch
 * @returns {Promise<JournalRecord>}
 */
export async function updateOperation(dataRoot, id, patch) {
  const current = await readOperation(dataRoot, id);
  if (!current) throw new Error(`journal record not found: ${id}`);
  const next = { ...current, ...patch };
  await writeAtomic(recordPath(dataRoot, id), next);
  return next;
}

/**
 * 结束一次操作。成功则删除记录（历史留在 audit.log），失败则保留现场。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.id
 * @param {"done" | "failed"} options.state
 * @param {string} [options.detail]
 * @returns {Promise<void>}
 */
export async function finishOperation({ dataRoot, id, state, detail }) {
  if (state === "done") {
    await unlink(recordPath(dataRoot, id)).catch(() => undefined);
    return;
  }
  await updateOperation(dataRoot, id, { state: "failed", detail });
}

/**
 * @param {string} dataRoot
 * @param {string} id
 * @returns {Promise<JournalRecord | null>}
 */
export async function readOperation(dataRoot, id) {
  try {
    return JSON.parse(await readFile(recordPath(dataRoot, id), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 列出未完成的操作（启动时自愈入口）。
 * @param {string} dataRoot
 * @returns {Promise<JournalRecord[]>}
 */
export async function listPending(dataRoot) {
  /** @type {string[]} */
  let names = [];
  try {
    names = await readdir(journalDir(dataRoot));
  } catch {
    return [];
  }
  /** @type {JournalRecord[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(journalDir(dataRoot), name), "utf8"));
      if (record?.state && record.state !== "done") out.push(record);
    } catch {
      // 损坏的记录跳过；不因为一条坏文件阻止插件加载。
    }
  }
  out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return out;
}
