// @ts-check
// 两阶段取证的**编排**部分（与宿主解耦，便于单测）。
//
// 流程：第一轮建议带 `needs` → 在会话工作目录内取证 → 把证据回灌 → 第二轮复核。
// 任何一步失败都保留第一轮结论（绝不能因为取证失败而丢掉已经付费拿到的建议）。
import { buildVerificationBlock, collectEvidence } from "./verifier.js";

/**
 * @typedef {object} EvidencePassResult
 * @property {any} advice 最终采用的建议（可能是第二轮，也可能是第一轮）
 * @property {any|null} verification 取证摘要；没触发取证时为 null
 * @property {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number }|null} extraUsage 第二轮新增的 token
 */

/**
 * @param {object} input
 * @param {any} input.advice 第一轮解析后的建议（需含 `needs`）
 * @param {string} input.root 会话工作目录
 * @param {{ advisorTools?: boolean, maxFiles?: number, maxBytes?: number }} [input.settings]
 * @param {(block: string) => Promise<{ ok: boolean, text?: string, usage?: any }>} input.callSecond 发起第二轮调用
 * @param {(raw: string) => { ok: boolean, advice?: any }} input.parseAdvice 重新解析
 * @param {typeof collectEvidence} [input.collect] 取证实现（测试可注入）
 * @returns {Promise<EvidencePassResult>}
 */
export async function runEvidencePass(input) {
  const { advice, root, callSecond, parseAdvice } = input;
  const collect = input.collect ?? collectEvidence;
  const needs = Array.isArray(advice?.needs) ? advice.needs : [];
  if (needs.length === 0) {
    return { advice, verification: null, extraUsage: null };
  }

  const evidence = await collect({
    root,
    needs,
    maxFiles: Number.isFinite(input.settings?.maxFiles) ? Number(input.settings?.maxFiles) : 5,
    maxBytes: Number.isFinite(input.settings?.maxBytes)
      ? Number(input.settings?.maxBytes)
      : undefined,
  });
  /** @type {{ requested: number, read: string[], refused: string[], pass2: boolean }} */
  const verification = {
    requested: needs.length,
    read: evidence.sections.map((section) => section.ref),
    refused: evidence.refused,
    pass2: false,
  };

  const block = buildVerificationBlock(evidence);
  if (block === "") return { advice, verification, extraUsage: null };

  const second = await callSecond(block);
  if (!second?.ok) return { advice, verification, extraUsage: null };

  const reparsed = parseAdvice(second.text ?? "");
  if (!reparsed?.ok) return { advice, verification, extraUsage: null };

  verification.pass2 = true;
  return { advice: reparsed.advice, verification, extraUsage: second.usage ?? null };
}
