// @ts-check
// core/attestation.js：净室 attestation —— 记录「builder 到底收到了什么、被要求了什么」。
//
// 为什么需要：DSH 的 agent preset 目前无法用 bundle 组合（见 docs/runtime/0.2.2-rc.3.md §12.7），
// 所以 builder 的工具面**没有**白名单隔离。我们能做到的是信息流隔离 + 可核对的声明：
//   - 记录投喂给 builder 的 prompt 摘要（sha256）与规格包摘要；
//   - 记录「要求它不要读取原件」这条指令确实在 prompt 里；
//   - 把这些写进报告，让第三方能判断「这次复刻是净室做的吗」。
// 声明必须可验证，不能只是嘴上说说。

import { sha256Text, shortDigest } from "./digest.js";
import { nowIso } from "./model.js";

/** 净室指令的规范表述（prompt 里必须包含的片段）。 */
export const CLEAN_ROOM_CLAUSE = "不要读取或寻找原始目标";

/** 兼容英文表述（若有人用英文 prompt 覆盖）。 */
export const CLEAN_ROOM_CLAUSE_EN = "Do not read or look for the original target";

/**
 * 生成一条 attestation。
 * @param {{
 *   project: Record<string, any>,
 *   prompt: string,
 *   pack: Record<string, any>,
 *   sessionId: string,
 *   builderId: string,
 *   override?: boolean,
 *   reason?: string,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildAttestation(input) {
  const prompt = String(input.prompt ?? "");
  const claims = (input.pack?.claims ?? []).map((/** @type {any} */ item) => item.id);
  const evidence = (input.pack?.evidence ?? []).map((/** @type {any} */ item) => item.id);
  const hasClause = prompt.includes(CLEAN_ROOM_CLAUSE) || prompt.includes(CLEAN_ROOM_CLAUSE_EN);
  return {
    id: `att-${input.builderId}`,
    builderId: input.builderId,
    sessionId: input.sessionId,
    at: nowIso(),
    authTier: String(input.project?.authTier ?? "research"),
    researchOverride: input.override === true,
    overrideReason: input.reason == null ? "" : String(input.reason).slice(0, 500),
    // 可核对的事实
    promptDigest: sha256Text(prompt),
    specDigest: sha256Text(JSON.stringify(input.pack ?? {})),
    claimCount: claims.length,
    evidenceCount: evidence.length,
    // 声明：我们要求了什么
    cleanRoomInstruction: hasClause,
    // 诚实的能力边界：DSH 层没有工具白名单
    toolIsolation: "none: builder 使用宿主默认工具面；隔离靠只投喂规格包 + 本声明",
    statement:
      "本次构建只向 builder 投喂规格包（脱敏后的结论、证据摘要与未知项），未提供原件路径；" +
      "不能保证 builder 未通过其它工具接触原件，故本声明不构成净室证明。",
    shortPromptDigest: shortDigest(sha256Text(prompt)),
  };
}

/**
 * 从 attestation 列表里取最近一条。
 * @param {Array<Record<string, any>>} attestations
 * @returns {Record<string, any> | null}
 */
export function latestAttestation(attestations) {
  const list = [...(attestations ?? [])].sort((a, b) =>
    String(a.at ?? "").localeCompare(String(b.at ?? "")),
  );
  return list.at(-1) ?? null;
}

/**
 * 报告用的净室小结。
 * @param {Array<Record<string, any>>} attestations
 * @returns {Record<string, any> | null}
 */
export function attestationSummary(attestations) {
  const latest = latestAttestation(attestations);
  if (!latest) return null;
  return {
    at: latest.at,
    builderSession: latest.sessionId,
    authTier: latest.authTier,
    researchOverride: latest.researchOverride === true,
    promptDigest: latest.shortPromptDigest ?? shortDigest(latest.promptDigest),
    claimCount: latest.claimCount,
    evidenceCount: latest.evidenceCount,
    cleanRoomInstruction: latest.cleanRoomInstruction === true,
    toolIsolation: latest.toolIsolation,
    statement: latest.statement,
    count: (attestations ?? []).length,
  };
}
