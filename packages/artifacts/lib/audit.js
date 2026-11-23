// @ts-check
// 审计日志的**纯函数**：把一次破坏性调用的结果折成一条记录。ADR 0002 §4 要求破坏性操作留痕，
// 但"留痕"必须并发安全——共用 `this.lastAudit` 这类字段会让两个并发调用串号
// （慢调用抛错、快调用成功时，慢调用的 finally 读到快调用的结果；见
// notes/artifacts/audit-concurrency-harness.mjs 的复现）。所以这里不碰任何实例状态。

/**
 * @typedef {{
 *   level: "info" | "warn",
 *   action: string,
 *   code: string | null,
 *   fields: { dryRun: boolean, count: number, bytes: number, processed: string[], message?: string },
 * }} AuditRecord
 */

/** @param {unknown} value @returns {number} */
function countOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 成功时记哪些 id：remove→removed，restore→restored，purge→purged，
 * archive→ids（另外还认契约层的通用 `processed`）。
 * @param {any} result
 * @returns {string[]}
 */
function processedOf(result) {
  const list =
    result?.removed ?? result?.restored ?? result?.purged ?? result?.processed ?? result?.ids;
  return Array.isArray(list)
    ? list.filter((/** @type {unknown} */ item) => typeof item === "string")
    : [];
}

/**
 * @param {string} action
 * @param {any} result 契约层返回值；抛错时为 undefined
 * @param {unknown} [error] 契约层抛出的异常（正常路径没有）
 * @returns {AuditRecord}
 */
export function describeAudit(action, result, error) {
  const fields = {
    dryRun: result?.dryRun === true,
    count: countOf(result?.count),
    bytes: countOf(result?.bytes),
    processed: processedOf(result),
  };
  if (result?.ok === true) return { level: "info", action, code: null, fields };
  const code =
    (typeof result?.code === "string" && result.code !== "" ? result.code : undefined) ??
    (typeof (/** @type {any} */ (error)?.code) === "string"
      ? /** @type {any} */ (error).code
      : "artifacts/failed");
  const message =
    error === undefined ? undefined : error instanceof Error ? error.message : String(error);
  return {
    level: "warn",
    action,
    code,
    fields: message === undefined ? fields : { ...fields, message },
  };
}

/**
 * @param {AuditRecord} record
 * @returns {string}
 */
export function formatAudit(record) {
  return record.level === "warn"
    ? `[artifacts] ${record.action} failed (${record.code ?? "artifacts/failed"})`
    : `[artifacts] ${record.action}`;
}
