// @ts-check
// 审计日志：append-only JSONL，一次操作一行。进程内串行写入，单行保持在 4KB 内，
// 保证多窗口并发时不会出现交错的半行（POSIX 上 O_APPEND 的小写入是原子的）。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditPath } from "./paths.js";

/** 单行上限：超过就把自由文本字段截断，避免破坏原子写与可读性。 */
const MAX_LINE = 4096;

/**
 * @typedef {object} AuditEntry
 * @property {"plan" | "trash" | "restore" | "purge" | "reconcile" | "health"} action
 * @property {"ok" | "refused" | "failed"} result
 * @property {string} [sessionId]
 * @property {string} [entryId]
 * @property {string} [operator] ui / agent / system
 * @property {string} [detail]
 * @property {string} [ts]
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  if (typeof value !== "string") return "";
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

/**
 * @param {string} dataRoot
 * @returns {{ append: (entry: AuditEntry & Record<string, unknown>) => Promise<{ ok: boolean, error?: string }>, read: (limit?: number) => Promise<AuditEntry[]> }}
 */
export function createAudit(dataRoot) {
  const file = auditPath(dataRoot);
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  /**
   * @param {AuditEntry & Record<string, unknown>} entry
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  function append(entry) {
    const record = {
      ts: new Date().toISOString(),
      operator: "ui",
      ...entry,
      detail: clip(entry.detail),
    };
    let line = JSON.stringify(record);
    if (line.length > MAX_LINE)
      line = JSON.stringify({ ...record, detail: clip(record.detail).slice(0, 80) });
    const job = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      return { ok: true };
    });
    chain = job.catch(() => undefined);
    return job.catch((error) => ({
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    }));
  }

  /**
   * 读取最近的审计条目（新的在后）。
   * @param {number} [limit]
   * @returns {Promise<AuditEntry[]>}
   */
  async function read(limit = 100) {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const slice = lines.slice(Math.max(0, lines.length - Math.max(1, limit)));
    /** @type {AuditEntry[]} */
    const out = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // 坏行跳过，审计读取不应因为一行损坏而整体失败。
      }
    }
    return out;
  }

  return { append, read };
}
