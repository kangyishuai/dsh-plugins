// @ts-check
// 删除回执：每次破坏性操作落一份 JSON，供界面展示与事后核对。
// 位于 <data-root>/session-trash/receipts/，与回收站条目分开，条目被彻底删除也不影响回执。
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireInside, trashRoot } from "./paths.js";

export const RECEIPT_SCHEMA = 1;

/** @param {string} dataRoot @returns {string} */
export function receiptsDir(dataRoot) {
  return join(trashRoot(dataRoot), "receipts");
}

/**
 * 写入一份回执，返回回执 id。
 * @param {string} dataRoot
 * @param {Record<string, unknown>} record
 * @returns {Promise<string>}
 */
export async function writeReceipt(dataRoot, record) {
  const dir = receiptsDir(dataRoot);
  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const file = join(dir, `${id}.json`);
  requireInside(dataRoot, file);
  await mkdir(dir, { recursive: true });
  await writeFile(
    `${file}.tmp`,
    JSON.stringify({ ...record, schema: RECEIPT_SCHEMA, id }, null, 2),
  );
  await rename(`${file}.tmp`, file);
  return id;
}

/**
 * 最近的回执（新的在前）。
 * @param {string} dataRoot
 * @param {number} [limit]
 * @returns {Promise<any[]>}
 */
export async function listReceipts(dataRoot, limit = 50) {
  const dir = receiptsDir(dataRoot);
  /** @type {string[]} */
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort((a, b) => b.localeCompare(a));
  /** @type {any[]} */
  const out = [];
  for (const name of names.slice(0, Math.max(1, limit))) {
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // 单份回执损坏不影响列表
    }
  }
  return out;
}
