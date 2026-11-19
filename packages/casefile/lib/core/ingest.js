// @ts-check
// core/ingest.js：外部 agent 产出报告的**通用摄入契约**。
//
// 为什么需要：Craft / 其他逆向 agent 会产出自己的报告。casefile 的立场是
// "只记录、不背书"——所以这里只接受**已经成形的结论与证据描述**，不解释对方语义，
// 也不把它的判断当成自己的判断（authority 固定 external、producer 记录来源）。
//
// 契约形状（版本 1）：
//   {
//     sources:  { tool, version?, mode?, producedAt?, reportPath? },
//     evidence: [ { summary, kind?, authority?, limitations?, refs?, artifactPath? } ],
//     claims:   [ { text, kind?, status?, evidenceIds?: number[] , limitations?, refs? } ],
//     unknowns: [ { text, severity? } ]
//   }
// claims.evidenceIds 用**数组下标**引用本次 payload 里的 evidence，摄入时映射成真实 id。
// 下标越界直接报错——宁可拒绝，也不能静默丢引用（那会让结论变成无出处）。

/** 摄入契约版本；形状变化时递增。 */
export const INGEST_VERSION = 1;

// 必须与 core/model.js 的 evidence kind 枚举**完全一致**，否则摄入会被模型层拒绝。
// （这个不一致是真机跑出来的：Craft 的 capture.network 被映射成 network → invalid-input）
const EVIDENCE_KINDS = [
  "pseudocode",
  "assembly",
  "string",
  "xref",
  "callgraph",
  "har",
  "process",
  "screen",
  "structure",
  "behavior",
  "other",
];
const CLAIM_KINDS = ["structure", "behavior", "string", "other"];
const CLAIM_STATUS = ["observed", "derived", "inferred"];
const SEVERITIES = ["low", "medium", "high"];
const PRODUCER_MODES = ["headful", "headless", "api", "archive", "manual", "stealth", "unknown"];

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function needText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw Object.assign(new Error(`${field} 必须是非空字符串`), { code: "invalid-input" });
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} field
 * @param {string} fallback
 * @returns {string}
 */
function oneOf(value, allowed, field, fallback) {
  if (value == null) return fallback;
  const text = String(value);
  if (!allowed.includes(text)) {
    throw Object.assign(new Error(`${field} 只能是 ${allowed.join(" / ")}：${text}`), {
      code: "invalid-input",
    });
  }
  return text;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function textList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${field} 必须是字符串数组`), { code: "invalid-input" });
  }
  return value.map((/** @type {any} */ item, /** @type {number} */ index) =>
    needText(item, `${field}[${index}]`),
  );
}

/**
 * 校验并归一化摄入 payload。
 * @param {any} raw
 * @returns {{
 *   version: number,
 *   source: { tool: string, version: string | null, mode: string, producedAt: string | null, reportPath: string | null },
 *   evidence: Array<Record<string, any>>,
 *   claims: Array<Record<string, any>>,
 *   unknowns: Array<Record<string, any>>,
 * }}
 */
export function validateIngestPayload(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("payload 必须是对象"), { code: "invalid-input" });
  }
  const version = raw.version == null ? INGEST_VERSION : Number(raw.version);
  if (version !== INGEST_VERSION) {
    throw Object.assign(
      new Error(`不支持的摄入契约版本：${String(raw.version)}（当前 ${INGEST_VERSION}）`),
      {
        code: "invalid-input",
      },
    );
  }

  const sourceRaw = raw.source ?? raw.sources ?? {};
  const source = {
    tool: needText(sourceRaw?.tool, "source.tool"),
    version: sourceRaw?.version == null ? null : needText(sourceRaw.version, "source.version"),
    mode: oneOf(sourceRaw?.mode, PRODUCER_MODES, "source.mode", "unknown"),
    producedAt:
      sourceRaw?.producedAt == null ? null : needText(sourceRaw.producedAt, "source.producedAt"),
    reportPath:
      sourceRaw?.reportPath == null ? null : needText(sourceRaw.reportPath, "source.reportPath"),
  };

  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence = evidenceRaw.map((/** @type {any} */ item, /** @type {number} */ index) => ({
    summary: needText(item?.summary, `evidence[${index}].summary`),
    kind: oneOf(item?.kind, EVIDENCE_KINDS, `evidence[${index}].kind`, "other"),
    authority: "external",
    limitations: textList(item?.limitations, `evidence[${index}].limitations`),
    refs: textList(item?.refs, `evidence[${index}].refs`),
    artifactPath:
      item?.artifactPath == null
        ? null
        : needText(item.artifactPath, `evidence[${index}].artifactPath`),
  }));

  const claimsRaw = Array.isArray(raw.claims) ? raw.claims : [];
  const claims = claimsRaw.map((/** @type {any} */ item, /** @type {number} */ index) => {
    /** @type {number[]} */
    let mapped = [];
    if (item?.evidenceIds != null) {
      if (!Array.isArray(item.evidenceIds)) {
        throw Object.assign(new Error(`claims[${index}].evidenceIds 必须是数组下标`), {
          code: "invalid-input",
        });
      }
      mapped = item.evidenceIds.map((/** @type {any} */ value, /** @type {number} */ at) => {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0 || num >= evidence.length) {
          throw Object.assign(
            new Error(
              `claims[${index}].evidenceIds[${at}] 越界：${String(value)}（本次只有 ${evidence.length} 条证据）`,
            ),
            { code: "invalid-input" },
          );
        }
        return num;
      });
    }
    return {
      text: needText(item?.text, `claims[${index}].text`),
      kind: oneOf(item?.kind, CLAIM_KINDS, `claims[${index}].kind`, "structure"),
      status: oneOf(item?.status, CLAIM_STATUS, `claims[${index}].status`, "observed"),
      limitations: textList(item?.limitations, `claims[${index}].limitations`),
      refs: textList(item?.refs, `claims[${index}].refs`),
      evidenceIndexes: [...new Set(mapped)],
    };
  });

  const unknownsRaw = Array.isArray(raw.unknowns) ? raw.unknowns : [];
  const unknowns = unknownsRaw.map((/** @type {any} */ item, /** @type {number} */ index) => ({
    text: needText(item?.text, `unknowns[${index}].text`),
    severity: oneOf(item?.severity, SEVERITIES, `unknowns[${index}].severity`, "low"),
  }));

  return { version, source, evidence, claims, unknowns };
}

/**
 * 契约说明（`case_ingest schema` 直接返回它，方便别的 agent 生成正确格式）。
 * @returns {Record<string, any>}
 */
export function describeIngestSchema() {
  return {
    version: INGEST_VERSION,
    shape: {
      source: {
        tool: "string (必填)",
        version: "string?",
        mode: PRODUCER_MODES,
        producedAt: "ISO string?",
        reportPath: "绝对路径?",
      },
      evidence: [
        {
          summary: "string (必填)",
          kind: EVIDENCE_KINDS,
          limitations: "string[]",
          refs: "string[]",
          artifactPath: "绝对路径?",
        },
      ],
      claims: [
        {
          text: "string (必填)",
          kind: CLAIM_KINDS,
          status: CLAIM_STATUS,
          evidenceIds: "数字下标数组（引用本次 evidence）",
          limitations: "string[]",
        },
      ],
      unknowns: [{ text: "string (必填)", severity: SEVERITIES }],
    },
    rules: [
      "authority 固定为 external：casefile 只记录、不背书",
      "claims.evidenceIds 用数组下标；越界直接报错，不静默丢引用",
      "source.reportPath 若给出，会归档进项目目录并记录 sha256（/tmp 会过期）",
      "所有 limitations 原样保留：对方没说的不确定性，casefile 不替它补",
    ],
  };
}
