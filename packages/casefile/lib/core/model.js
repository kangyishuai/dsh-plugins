// @ts-check
// core/model.js：实体构造、校验与常量。纯 Node，不 import 任何宿主包（可脱离 DSH 单测）。
//
// 设计口径（见 notes/rea-craft/spec/02-architecture.md）：
//   - 证据（Evidence）只投影 REA 的结论，不重算 confidence/authority；
//   - 结论（Claim）是「可引用、可选、可导出」的单位，带稳定 id；
//   - 功能（Feature）是「选中功能复刻」的范围单位；
//   - 未知项（Unknown）是一等公民，必须随规格包导出。

import { randomBytes } from "node:crypto";

/** 项目文件 schema 版本。只增不删；读到更高版本一律只读。 */
export const SCHEMA_VERSION = 1;

/** 授权档：决定 builder 能否看原件、导出是否强制脱敏。 */
export const AUTH_TIERS = /** @type {const} */ (["owned", "authorized", "research"]);

/** REA 的 confidence 三档（原样保留，不重新定义）。 */
export const CONFIDENCE = /** @type {const} */ (["observed", "derived", "inferred"]);

/** REA 的 authority 四档（关闭义务时要求「权威性相当」）。 */
export const AUTHORITY = /** @type {const} */ ([
  "shipped-artifact",
  "controlled-replay",
  "live-observation",
  "external",
]);

/** 义务种类（spec/03-acceptance.md §1.2）。 */
export const OBLIGATION_KINDS = /** @type {const} */ ([
  "existence",
  "structure",
  "behavior",
  "visual",
  "coverage",
  "regression",
]);

/** 义务状态。 */
export const OBLIGATION_STATUSES = /** @type {const} */ ([
  "open",
  "pass",
  "fail",
  "blocked",
  "out_of_scope",
]);

/** 检查结论。 */
export const CHECK_VERDICTS = /** @type {const} */ (["pass", "fail", "unknown"]);

/** 结论种类：覆盖 REA 的观察面。 */
export const CLAIM_KINDS = /** @type {const} */ ([
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
]);

/** 项目状态机（M0 只用前三个，M1+ 才进入复刻态）。 */
export const PROJECT_STATES = /** @type {const} */ ([
  "new",
  "surveying",
  "investigating",
  "reconstructing",
  "verifying",
  "closed",
]);

/** 项目 id：小写字母数字与连字符，1–64。 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 输入错误：带稳定 code，供工具层映射成错误码与文案。 */
export class CasefileInputError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "CasefileInputError";
    this.code = code;
  }
}

/** @returns {string} ISO 时间 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 生成带前缀的稳定 id。
 * @param {string} prefix
 * @returns {string}
 */
export function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${prefix}-${stamp}-${rand}`;
}

/**
 * 从标题生成项目 id（kebab-case）。
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? `project-${Date.now().toString(36)}` : slug;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} field
 * @returns {string}
 */
function oneOf(value, allowed, field) {
  const text = String(value ?? "");
  if (!allowed.includes(text)) {
    throw new CasefileInputError(
      "invalid-input",
      `${field} 必须是 ${allowed.join(" | ")} 之一，收到 ${JSON.stringify(value)}`,
    );
  }
  return text;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ max?: number, allowEmpty?: boolean }} [options]
 * @returns {string}
 */
function text(value, field, options = {}) {
  const { max = 4000, allowEmpty = false } = options;
  const out = String(value ?? "").trim();
  if (!allowEmpty && out === "") {
    throw new CasefileInputError("invalid-input", `${field} 不能为空`);
  }
  if (out.length > max) {
    throw new CasefileInputError("invalid-input", `${field} 超过 ${max} 字符`);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function textList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new CasefileInputError("invalid-input", `${field} 必须是字符串数组`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, { max: 2000 }));
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function idList(value, field) {
  const list = textList(value, field);
  for (const id of list) {
    if (!ID_RE.test(id)) {
      throw new CasefileInputError("invalid-input", `${field} 含非法 id：${id}`);
    }
  }
  return list;
}

/**
 * 规范化「打开项目」输入。
 * @param {Record<string, any>} input
 * @returns {{ id: string, title: string, target: Record<string, any>, authTier: string, scope: string, reaVersion: string | null, capabilityHash: string | null }}
 */
export function normalizeProjectInput(input) {
  const title = text(input?.title, "title", { max: 200 });
  const id = input?.id == null ? slugify(title) : text(input.id, "id", { max: 64 });
  if (!ID_RE.test(id)) {
    throw new CasefileInputError("invalid-input", `id 必须是 kebab-case：${id}`);
  }
  const targetInput = input?.target ?? {};
  const target = {
    kind: oneOf(
      targetInput.kind ?? "other",
      ["binary", "web", "app", "game", "artifact", "other"],
      "target.kind",
    ),
    ref: text(targetInput.ref ?? title, "target.ref", { max: 2000 }),
    note: targetInput.note == null ? null : text(targetInput.note, "target.note", { max: 2000 }),
  };
  return {
    id,
    title,
    target,
    authTier: oneOf(input?.authTier ?? "research", AUTH_TIERS, "authTier"),
    scope: oneOf(input?.scope ?? "all", ["all", "selected"], "scope"),
    reaVersion:
      input?.reaVersion == null ? null : text(input.reaVersion, "reaVersion", { max: 64 }),
    capabilityHash:
      input?.capabilityHash == null
        ? null
        : text(input.capabilityHash, "capabilityHash", { max: 128 }),
  };
}

/**
 * 规范化一条证据（只投影 REA 的结论）。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeEvidence(input) {
  return {
    id: newId("ev"),
    kind: oneOf(input?.kind ?? "other", CLAIM_KINDS, "kind"),
    sourceTool: text(input?.sourceTool ?? "unknown", "sourceTool", { max: 200 }),
    sessionId: input?.sessionId == null ? null : text(input.sessionId, "sessionId", { max: 200 }),
    observedAt:
      input?.observedAt == null ? nowIso() : text(input.observedAt, "observedAt", { max: 64 }),
    confidence: oneOf(input?.confidence ?? "observed", CONFIDENCE, "confidence"),
    authority: oneOf(input?.authority ?? "shipped-artifact", AUTHORITY, "authority"),
    limitations: textList(input?.limitations, "limitations"),
    integrity: input?.integrity == null ? null : text(input.integrity, "integrity", { max: 256 }),
    summary: text(input?.summary, "summary", { max: 4000 }),
    refs: textList(input?.refs, "refs"),
    claimIds: idList(input?.claimIds, "claimIds"),
  };
}

/**
 * 规范化一条结论。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeClaim(input) {
  return {
    id: newId("claim"),
    text: text(input?.text, "text", { max: 4000 }),
    kind: oneOf(input?.kind ?? "other", CLAIM_KINDS, "kind"),
    status: oneOf(input?.status ?? "observed", CONFIDENCE, "status"),
    limitations: textList(input?.limitations, "limitations"),
    evidenceIds: idList(input?.evidenceIds, "evidenceIds"),
    featureIds: idList(input?.featureIds, "featureIds"),
    selected: input?.selected === true,
  };
}

/**
 * 规范化一个功能分组。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeFeature(input) {
  return {
    id: newId("feat"),
    name: text(input?.name, "name", { max: 200 }),
    summary:
      input?.summary == null ? "" : text(input.summary, "summary", { max: 2000, allowEmpty: true }),
    claimIds: idList(input?.claimIds, "claimIds"),
    boundaries: textList(input?.boundaries, "boundaries"),
    nonGoals: textList(input?.nonGoals, "nonGoals"),
    status: oneOf(input?.status ?? "draft", ["draft", "ready", "building", "verified"], "status"),
  };
}

/**
 * 规范化一个未知项。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeUnknown(input) {
  return {
    id: newId("unk"),
    text: text(input?.text, "text", { max: 2000 }),
    severity: oneOf(input?.severity ?? "medium", ["low", "medium", "high"], "severity"),
    status: oneOf(input?.status ?? "open", ["open", "resolved", "blocked"], "status"),
    note: input?.note == null ? "" : text(input.note, "note", { max: 2000, allowEmpty: true }),
  };
}

/**
 * 规范化一条义务。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function normalizeObligation(input) {
  const statement = text(input?.statement, "statement", { max: 2000 });
  /** @type {Record<string, any> | null} */
  let check = null;
  if (input?.check != null) {
    const raw = input.check;
    const checker = oneOf(raw?.checker ?? "cli", ["build", "cli", "web"], "check.checker");
    if (checker === "web") {
      check = {
        checker,
        command: "",
        reference: text(raw?.reference, "check.reference", { max: 2000 }),
        candidate: text(raw?.candidate, "check.candidate", { max: 2000 }),
      };
      if (raw?.minSimilarity != null) check.minSimilarity = Number(raw.minSimilarity);
      if (raw?.allowSizeMismatch != null) check.allowSizeMismatch = raw.allowSizeMismatch === true;
    } else {
      check = { checker, command: text(raw?.command, "check.command", { max: 2000 }) };
    }
    if (raw?.expect != null) {
      if (typeof raw.expect !== "object" || Array.isArray(raw.expect)) {
        throw new CasefileInputError("invalid-input", "check.expect 必须是对象");
      }
      check.expect = raw.expect;
    }
    if (raw?.cwd != null) check.cwd = text(raw.cwd, "check.cwd", { max: 2000 });
    if (raw?.timeoutMs != null) check.timeoutMs = Number(raw.timeoutMs);
  }
  return {
    id: newId("obl"),
    source: input?.source == null ? "manual" : text(input.source, "source", { max: 200 }),
    kind: oneOf(input?.kind ?? "behavior", OBLIGATION_KINDS, "kind"),
    statement,
    authorityRequired: oneOf(
      input?.authorityRequired ?? "controlled-replay",
      ["controlled-replay", "live-observation", "external"],
      "authorityRequired",
    ),
    status: "open",
    checkIds: idList(input?.checkIds, "checkIds"),
    evidenceIds: idList(input?.evidenceIds, "evidenceIds"),
    ownerDigest:
      input?.ownerDigest == null ? null : text(input.ownerDigest, "ownerDigest", { max: 128 }),
    check,
    version: 1,
  };
}

/**
 * 项目统计（列表/状态用）。
 * @param {Record<string, any>} project
 * @param {{ evidence: any[], claims: any[], features: any[], unknowns: any[], obligations?: any[] }} data
 * @returns {Record<string, any>}
 */
export function projectStats(project, data) {
  const openUnknowns = data.unknowns.filter((item) => item.status !== "resolved").length;
  const obligations = data.obligations ?? [];
  const openObligations = obligations.filter(
    (/** @type {any} */ item) => item.status === "open",
  ).length;
  const passedObligations = obligations.filter(
    (/** @type {any} */ item) => item.status === "pass",
  ).length;
  return {
    id: project.id,
    title: project.title,
    state: project.state,
    authTier: project.authTier,
    scope: project.scope,
    target: project.target,
    reaVersion: project.reaVersion,
    evidence: data.evidence.length,
    claims: data.claims.length,
    selectedClaims: data.claims.filter((item) => item.selected).length,
    features: data.features.length,
    openUnknowns,
    obligations: obligations.length,
    openObligations,
    passedObligations,
    updatedAt: project.updatedAt,
  };
}
