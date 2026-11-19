// @ts-check
// core/bundle.js：机器可读的「证据包」——给另一个 agent 读，也给自己复盘。
//
// 与 spec pack 的区别：
//   - spec pack（brief.js）只含**被选中的结论**，面向"交给编码 agent 去复刻"；
//   - bundle 含**全量账本**（证据/结论/义务/检查/未知项/产物），面向"把这段调查
//     完整交接出去，或过几个月自己回看"。
//
// 硬要求：**确定性**。同一份数据导出两次必须字节一致，否则"可复算"就是空话。
// 所以 generatedAt 不由 Date.now() 决定，而是取数据自身的最大时间戳。

import { createHash } from "node:crypto";

import { redactPack } from "./brief.js";

export const BUNDLE_SCHEMA = "casefile.bundle/1";

/**
 * 递归排序对象键，得到可复现的 JSON 形状。
 * @param {any} value
 * @returns {any}
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * 对任意值算完整性摘要（先规范化，再 sha256）。
 * @param {any} value
 * @returns {string}
 */
export function digestOf(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/**
 * 从记录里找最大的时间戳，作为确定性 generatedAt。
 * 找不到就退回项目 updatedAt；两者都没有才用传入的 fallback。
 * @param {Record<string, any>[]} records
 * @returns {string | null}
 */
function latestTimestamp(records) {
  /** @type {string | null} */
  let latest = null;
  for (const record of records) {
    for (const key of ["observedAt", "createdAt", "updatedAt", "endedAt", "generatedAt"]) {
      const value = record?.[key];
      if (typeof value !== "string") continue;
      if (latest == null || value > latest) latest = value;
    }
  }
  return latest;
}

/**
 * 组装 bundle。
 * @param {{
 *   project: Record<string, any>,
 *   evidence: Record<string, any>[],
 *   claims: Record<string, any>[],
 *   obligations: Record<string, any>[],
 *   checks: Record<string, any>[],
 *   unknowns: Record<string, any>[],
 *   coverage?: Record<string, any>,
 *   counts?: Record<string, any>,
 *   redact?: boolean,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildBundle(input) {
  const all = [
    ...input.evidence,
    ...input.claims,
    ...input.obligations,
    ...input.checks,
    ...input.unknowns,
  ];
  const generatedAt =
    latestTimestamp(all) ?? input.project?.updatedAt ?? "1970-01-01T00:00:00.000Z";

  const artifacts = input.evidence
    .map((item) => item.artifact)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      sha256: item.sha256,
      file: item.file,
      bytes: item.bytes,
      originalName: item.originalName ?? null,
    }))
    .sort((a, b) => String(a.sha256).localeCompare(String(b.sha256)));

  /** @type {Record<string, any>} */
  const body = {
    schema: BUNDLE_SCHEMA,
    generatedAt,
    project: {
      id: input.project.id,
      title: input.project.title,
      target: input.project.target ?? null,
      authTier: input.project.authTier,
      scope: input.project.scope,
      state: input.project.state,
      reaVersion: input.project.reaVersion ?? null,
      capabilityHash: input.project.capabilityHash ?? null,
      closedAt: input.project.closedAt ?? null,
    },
    counts: input.counts ?? null,
    coverage: input.coverage ?? null,
    claims: input.claims,
    evidence: input.evidence,
    obligations: input.obligations,
    checks: input.checks,
    unknowns: input.unknowns,
    artifacts,
  };

  const redacted = input.redact === false ? body : redactPack(body);
  // integrity 覆盖「除 integrity 自身以外」的全部内容，便于接收方校验。
  return {
    ...redacted,
    integrity: {
      algorithm: "sha256",
      canonical: "json-sorted-keys-v1",
      digest: digestOf(redacted),
    },
  };
}
