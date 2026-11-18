// @ts-check
// core/brief.js：规格包（SpecPack）生成、脱敏与 Markdown 渲染。纯 Node，可单测。
//
// 产物①（证据结论）的交付物就是它：给另一个 agent / 另一个人的「去原始化」输入。
// 硬要求（spec/01-product.md §5、spec/03-acceptance.md §4）：
//   - 每条 claim 带 provenance / confidence / limitations；
//   - 未知项必须随包导出，不能"整理"掉；
//   - 默认脱敏：本机绝对路径、home、常见 token 形态。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Text } from "./digest.js";

/** 规格包版本。 */
export const SPEC_VERSION = 1;

/** 常见 token 形态（宁可多遮，不可漏）。 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
];

/**
 * 脱敏一段文本。
 * @param {string} text
 * @param {{ home?: string, cwd?: string, extraPaths?: readonly string[] }} [options]
 * @returns {string}
 */
export function redactText(text, options = {}) {
  let out = String(text);
  const { home, cwd, extraPaths = [] } = options;
  // 顺序很重要：先按「绝对路径整段」抹掉，再按已知根目录兜底替换。
  // 反过来会先替换前缀，留下 `<path>/x.bin` 这种半截路径。
  out = out.replace(/(?:\/Users|\/home|\/var|\/tmp|\/private)\/[^\s"'`)]+/g, "<path>");
  out = out.replace(/[A-Za-z]:\\[^\s"'`)]+/g, "<path>");
  /** @param {string | undefined} item @returns {item is string} */
  const isPath = (item) => typeof item === "string" && item.length > 1;
  const paths = [home, cwd, ...extraPaths].filter(isPath);
  for (const path of paths.sort((a, b) => b.length - a.length)) {
    out = out.split(path).join("<path>");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/**
 * 深拷贝并脱敏（只处理字符串值）。
 * @param {any} value
 * @param {{ home?: string, cwd?: string, extraPaths?: readonly string[] }} [options]
 * @returns {any}
 */
export function redactPack(value, options = {}) {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactPack(item, options));
  if (value && typeof value === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactPack(item, options);
    return out;
  }
  return value;
}

/**
 * 组装规格包。只包含「被选中的结论」及其证据、功能、未知项。
 * @param {{
 *   project: Record<string, any>,
 *   evidence: Record<string, any>[],
 *   claims: Record<string, any>[],
 *   features: Record<string, any>[],
 *   unknowns: Record<string, any>[],
 *   generatedAt?: string,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildSpecPack(input) {
  const { project } = input;
  const selectedClaims = input.claims.filter((claim) => claim.selected === true);
  const evidenceIds = new Set(selectedClaims.flatMap((claim) => claim.evidenceIds ?? []));
  const featureIds = new Set(selectedClaims.flatMap((claim) => claim.featureIds ?? []));
  const features = input.features.filter((feature) => featureIds.has(feature.id));
  const openUnknowns = input.unknowns.filter((unknown) => unknown.status !== "resolved");

  const pack = {
    version: SPEC_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    project: {
      id: project.id,
      title: project.title,
      target: project.target,
      authTier: project.authTier,
      scope: project.scope,
      reaVersion: project.reaVersion,
      capabilityHash: project.capabilityHash,
    },
    claims: selectedClaims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      kind: claim.kind,
      status: claim.status,
      limitations: claim.limitations ?? [],
      evidenceIds: claim.evidenceIds ?? [],
      featureIds: claim.featureIds ?? [],
    })),
    evidence: input.evidence
      .filter((item) => evidenceIds.has(item.id))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        sourceTool: item.sourceTool,
        observedAt: item.observedAt,
        confidence: item.confidence,
        authority: item.authority,
        limitations: item.limitations ?? [],
        integrity: item.integrity,
        summary: item.summary,
        refs: item.refs ?? [],
      })),
    features: features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      summary: feature.summary,
      boundaries: feature.boundaries ?? [],
      nonGoals: feature.nonGoals ?? [],
      status: feature.status,
    })),
    unknowns: openUnknowns.map((unknown) => ({
      id: unknown.id,
      text: unknown.text,
      severity: unknown.severity,
      status: unknown.status,
    })),
    coverage: {
      selectedClaims: selectedClaims.length,
      totalClaims: input.claims.length,
      evidence: evidenceIds.size,
      features: features.length,
      openUnknowns: openUnknowns.length,
    },
  };
  /** @type {any} */
  const withIntegrity = pack;
  withIntegrity.integrity = sha256Text(JSON.stringify({ ...pack, integrity: undefined }));
  return withIntegrity;
}

/**
 * 渲染成人/agent 都能读的 Markdown。
 * @param {Record<string, any>} pack
 * @returns {string}
 */
export function renderSpecMarkdown(pack) {
  const lines = [];
  lines.push(`# 规格包：${pack.project.title}`);
  lines.push("");
  lines.push(`- 项目：\`${pack.project.id}\``);
  lines.push(`- 目标：${pack.project.target.kind} · ${pack.project.target.ref}`);
  lines.push(`- 授权档：${pack.project.authTier}`);
  lines.push(`- 范围：${pack.project.scope === "selected" ? "仅选中功能" : "全量"}`);
  lines.push(`- 生成时间：${pack.generatedAt}`);
  lines.push(`- 完整性：\`${String(pack.integrity).slice(0, 16)}\``);
  lines.push(`- REA 版本：${pack.project.reaVersion ?? "未记录"}`);
  lines.push("");
  lines.push("## 选中的功能");
  if (pack.features.length === 0) {
    lines.push("");
    lines.push("_没有功能分组：结论是散点，建议先在 casefile 里把它们归到功能。_");
  }
  for (const feature of pack.features) {
    lines.push("");
    lines.push(`### ${feature.name}`);
    lines.push("");
    if (feature.summary) lines.push(feature.summary, "");
    if (feature.boundaries?.length) {
      lines.push("**边界**：");
      for (const item of feature.boundaries) lines.push(`- ${item}`);
      lines.push("");
    }
    if (feature.nonGoals?.length) {
      lines.push("**明确不做**：");
      for (const item of feature.nonGoals) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## 结论（每条带出处与局限）");
  for (const claim of pack.claims) {
    lines.push("");
    lines.push(`### ${claim.text}`);
    lines.push("");
    lines.push(`- 种类：${claim.kind}`);
    lines.push(`- 可信度：${claim.status}`);
    lines.push(`- 证据：${claim.evidenceIds.length === 0 ? "无" : claim.evidenceIds.join("、")}`);
    if (claim.limitations.length > 0) {
      lines.push("- 局限：");
      for (const item of claim.limitations) lines.push(`  - ${item}`);
    }
  }
  lines.push("");
  lines.push("## 证据");
  for (const item of pack.evidence) {
    lines.push("");
    lines.push(`- \`${item.id}\` · ${item.kind} · ${item.confidence} / ${item.authority}`);
    if (item.summary) lines.push(`  - ${item.summary}`);
    if (item.limitations.length > 0) lines.push(`  - 局限：${item.limitations.join("；")}`);
    if (item.refs.length > 0) lines.push(`  - 引用：${item.refs.join("、")}`);
  }
  lines.push("");
  lines.push("## 未知项（必须随包交付）");
  if (pack.unknowns.length === 0) {
    lines.push("");
    lines.push("_没有未解决的未知项。_");
  } else {
    for (const unknown of pack.unknowns) {
      lines.push(`- [${unknown.severity}] ${unknown.text}`);
    }
  }
  lines.push("");
  lines.push("## 验收清单（交给 builder 前先补全）");
  lines.push("");
  lines.push("- [ ] 每条结论的行为/状态/异常/依赖/资源/界面六维已展开（缺项标 UNKNOWN）");
  lines.push("- [ ] 每个功能有可判的验收断言");
  lines.push("- [ ] 未解决的未知项已确认或显式接受");
  lines.push("");
  return lines.join("\n");
}

/**
 * 写规格包到项目目录：`spec/<timestamp>/{spec.json,brief.md}`。
 * @param {{
 *   projectDir: string,
 *   pack: Record<string, any>,
 *   redact?: boolean,
 *   redactOptions?: { home?: string, cwd?: string, extraPaths?: readonly string[] },
 * }} input
 * @returns {{ dir: string, files: string[] }}
 */
export function writeSpecPack(input) {
  const stamp = String(input.pack.generatedAt).replace(/[:.]/g, "-");
  const dir = join(input.projectDir, "spec", stamp);
  mkdirSync(dir, { recursive: true });
  const pack = input.redact === false ? input.pack : redactPack(input.pack, input.redactOptions);
  const specFile = join(dir, "spec.json");
  const briefFile = join(dir, "brief.md");
  writeFileSync(specFile, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(briefFile, `${renderSpecMarkdown(pack)}\n`, "utf8");
  return { dir, files: [specFile, briefFile] };
}
