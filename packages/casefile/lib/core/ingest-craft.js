// @ts-check
// core/ingest-craft.js：把 Craft Anything 的报告映射成 casefile 的通用摄入契约。
//
// 依据：Craft 的 `craft-anything-evidence` 公开文档——每条工具结果是一条 Evidence
// 记录，字段为 subject / operation / params / result / confidence / authority /
// limitations(coverage) / locations，另有独立的 Unknown 记录（开放问题）。
// 我们只做**字段搬运**，不解释它的语义，也不替它提升置信度。
//
// ⚠️ 未用真实样例验证：本机没有装 Craft，映射按公开文档的字段名写，
//    首次拿到真实报告时需要复核（字段名变了会报 invalid-input，而不是静默丢字段）。

const OPERATION_KINDS = [
  ["disasm", "structure"],
  ["analy", "structure"],
  ["triage", "structure"],
  ["dossier", "structure"],
  ["parse", "structure"],
  ["string", "string"],
  ["js", "behavior"],
  ["network", "network"],
  ["capture", "network"],
  ["screenshot", "screen"],
  ["plist", "structure"],
  ["signature", "structure"],
  ["entitle", "structure"],
];

/**
 * 判断一份 JSON 是否像 Craft 的报告。
 * @param {any} raw
 * @returns {boolean}
 */
export function looksLikeCraftReport(raw) {
  if (raw == null || typeof raw !== "object") return false;
  const records = Array.isArray(raw) ? raw : (raw.evidence ?? raw.records);
  if (!Array.isArray(records) || records.length === 0) return false;
  return records.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.operation === "string" &&
      item.subject !== undefined,
  );
}

/** @param {string} operation */
function kindForOperation(operation) {
  const lower = String(operation).toLowerCase();
  for (const [needle, kind] of OPERATION_KINDS) if (lower.includes(needle)) return kind;
  return "other";
}

/**
 * 把 Craft 报告映射成通用契约 payload。
 * @param {any} raw
 * @returns {Record<string, any>}
 */
export function mapCraftReport(raw) {
  const records = Array.isArray(raw) ? raw : (raw.evidence ?? raw.records);
  /** @type {Record<string, any>[]} */
  const evidence = records.map((/** @type {any} */ record) => {
    const subject = record.subject ?? {};
    const subjectName =
      typeof subject === "string"
        ? subject
        : (subject.name ?? subject.path ?? subject.id ?? "未知对象");
    const result = record.result ?? record.normalized_result ?? null;
    const resultHint =
      result == null
        ? "（无可读结果）"
        : typeof result === "string"
          ? result.slice(0, 160)
          : Array.isArray(result)
            ? `数组 ${result.length} 项`
            : `字段 ${Object.keys(result).slice(0, 6).join("/")}`;
    const locations = Array.isArray(record.locations) ? record.locations : [];
    return {
      summary: `Craft ${record.operation} on ${String(subjectName)}：${resultHint}`,
      kind: kindForOperation(record.operation),
      limitations: [
        ...(Array.isArray(record.limitations) ? record.limitations.map(String) : []),
        "本条目由 Craft 产出，经映射写入；casefile 未复核其内容",
      ],
      refs: locations
        .map((/** @type {any} */ loc) => (loc && (loc.path ?? loc.file)) ?? null)
        .filter((/** @type {any} */ item) => item != null)
        .map(String),
    };
  });

  const unknownsRaw = Array.isArray(raw?.unknowns) ? raw.unknowns : [];
  /** @type {Record<string, any>[]} */
  const unknowns = unknownsRaw.map((/** @type {any} */ item) => ({
    text: String(item?.text ?? item?.question ?? "（外部未知项）").slice(0, 500),
    severity: ["low", "medium", "high"].includes(item?.severity) ? item.severity : "low",
  }));

  return {
    version: 1,
    source: {
      tool: "craft-anything",
      version: typeof raw?.version === "string" ? raw.version : null,
      mode: "archive",
      producedAt: typeof raw?.generatedAt === "string" ? raw.generatedAt : null,
      reportPath: null,
    },
    evidence,
    claims: [],
    unknowns,
  };
}
