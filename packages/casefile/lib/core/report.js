// @ts-check
// core/report.js：覆盖率、关闭闸门与报告渲染。纯 Node，可单测。
//
// 口径（spec/03-acceptance.md §1.3、§5.3）：
//   - 覆盖率 = 已关闭义务 /（已关闭 + 未关闭 + 失败 + 阻塞）；
//   - 关闭项目的硬门：没有 open / fail 义务、没有未解决未知项、覆盖率达标、检查不过期；
//   - 报告必须写清「这一版对应哪个实现 digest、什么时候采的证据」。

import { attestationSummary } from "./attestation.js";
import { shortDigest } from "./digest.js";
import { nowIso } from "./model.js";

const COUNTED = new Set(["open", "pass", "fail", "blocked"]);

/**
 * 算覆盖率。
 * @param {Array<Record<string, any>>} obligations
 * @returns {{ total: number, pass: number, open: number, fail: number, blocked: number, outOfScope: number, ratio: number }}
 */
export function computeCoverage(obligations) {
  const counted = obligations.filter((/** @type {any} */ item) => COUNTED.has(String(item.status)));
  const pass = counted.filter((/** @type {any} */ item) => item.status === "pass").length;
  const open = counted.filter((/** @type {any} */ item) => item.status === "open").length;
  const fail = counted.filter((/** @type {any} */ item) => item.status === "fail").length;
  const blocked = counted.filter((/** @type {any} */ item) => item.status === "blocked").length;
  const outOfScope = obligations.filter(
    (/** @type {any} */ item) => item.status === "out_of_scope",
  ).length;
  const total = counted.length;
  return {
    total,
    pass,
    open,
    fail,
    blocked,
    outOfScope,
    ratio: total === 0 ? 0 : pass / total,
  };
}

/**
 * 按功能算覆盖率：只统计「显式挂在某功能上的义务」，未挂功能的义务只计入全局。
 * @param {Array<Record<string, any>>} obligations
 * @param {Array<Record<string, any>>} features
 * @returns {Array<{ featureId: string, name: string, total: number, pass: number, open: number, ratio: number }>}
 */
export function computeCoverageByFeature(obligations, features) {
  return (features ?? []).map((/** @type {any} */ feature) => {
    const mine = (obligations ?? []).filter((/** @type {any} */ item) =>
      (item.featureIds ?? []).includes(feature.id),
    );
    const coverage = computeCoverage(mine);
    return {
      featureId: feature.id,
      name: feature.name,
      total: coverage.total,
      pass: coverage.pass,
      open: coverage.open,
      ratio: coverage.ratio,
    };
  });
}

/**
 * 关闭闸门：返回能不能关闭，以及卡在哪。
 * @param {{
 *   obligations: Array<Record<string, any>>,
 *   unknowns: Array<Record<string, any>>,
 *   checks: Array<Record<string, any>>,
 *   implementationDigest?: string | null,
 *   minCoverage?: number,
 *   maxCheckAgeMs?: number,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, blockers: string[], coverage: ReturnType<typeof computeCoverage> }}
 */
export function evaluateClose(input) {
  const now = input.now ?? Date.now();
  const maxAge = input.maxCheckAgeMs ?? 24 * 3600 * 1000;
  const minCoverage = input.minCoverage ?? 1;
  const coverage = computeCoverage(input.obligations ?? []);
  /** @type {string[]} */
  const blockers = [];
  if (coverage.total === 0) blockers.push("no-obligations");
  if (coverage.open > 0) blockers.push(`open-obligations:${coverage.open}`);
  if (coverage.fail > 0) blockers.push(`failed-obligations:${coverage.fail}`);
  if (coverage.blocked > 0) blockers.push(`blocked-obligations:${coverage.blocked}`);
  if (coverage.ratio < minCoverage) {
    blockers.push(`coverage-below:${coverage.ratio.toFixed(2)}<${minCoverage.toFixed(2)}`);
  }
  const openUnknowns = (input.unknowns ?? []).filter(
    (/** @type {any} */ item) => item.status !== "resolved",
  );
  if (openUnknowns.length > 0) blockers.push(`open-unknowns:${openUnknowns.length}`);
  // 检查新鲜度：最近一次完成检查不能超过时效
  const completed = (input.checks ?? []).filter(
    (/** @type {any} */ item) => item.verdict !== "unknown",
  );
  const latest = [...completed]
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
    .at(-1);
  if (!latest) {
    blockers.push("no-checks");
  } else {
    const age = now - Date.parse(latest.evidenceFetchedAt ?? latest.at ?? 0);
    if (!Number.isFinite(age) || age > maxAge) blockers.push("stale-checks");
    if (
      input.implementationDigest != null &&
      latest.implementationDigest != null &&
      latest.implementationDigest !== input.implementationDigest
    ) {
      blockers.push("implementation-mismatch");
    }
  }
  return { ok: blockers.length === 0, blockers, coverage };
}

/**
 * 汇总证据的生产者（去重，按工具+模式）。
 * @param {Array<Record<string, any>>} evidence
 * @returns {Array<Record<string, any>>}
 */
export function summarizeProducers(evidence) {
  /** @type {Map<string, Record<string, any>>} */
  const seen = new Map();
  for (const item of evidence) {
    const producer = item.producer;
    if (!producer || typeof producer !== "object") continue;
    const key = [producer.tool ?? "?", producer.mode ?? "?", producer.outputKind ?? "?"].join("|");
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (existing) existing.count += 1;
      continue;
    }
    seen.set(key, {
      tool: producer.tool ?? "?",
      version: producer.version ?? null,
      mode: producer.mode ?? null,
      outputKind: producer.outputKind ?? null,
      accessConfirmedByUser: producer.accessConfirmedByUser === true,
      count: 1,
    });
  }
  return [...seen.values()];
}

/**
 * 组装报告对象。
 * @param {{
 *   project: Record<string, any>,
 *   data: Record<string, any>,
 *   coverage?: ReturnType<typeof computeCoverage>,
 *   stop?: Record<string, any> | null,
 *   generatedAt?: string,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildReport(input) {
  const data = input.data ?? {};
  const builds = data.builds ?? [];
  const checks = data.checks ?? [];
  const obligations = data.obligations ?? [];
  const coverage = input.coverage ?? computeCoverage(obligations);
  const latestBuild = [...builds].sort(
    (a, b) => (Number(b.round) || 0) - (Number(a.round) || 0),
  )[0];
  return {
    version: 1,
    generatedAt: input.generatedAt ?? nowIso(),
    project: {
      id: input.project.id,
      title: input.project.title,
      state: input.project.state,
      target: input.project.target,
      authTier: input.project.authTier,
      scope: input.project.scope,
      reaVersion: input.project.reaVersion,
    },
    coverage,
    coverageByFeature: computeCoverageByFeature(obligations, data.features ?? []),
    cleanRoom: attestationSummary(data.attestations ?? []),
    producers: summarizeProducers(data.evidence ?? []),
    counts: {
      evidence: (data.evidence ?? []).length,
      claims: (data.claims ?? []).length,
      selectedClaims: (data.claims ?? []).filter(
        (/** @type {any} */ item) => item.selected === true,
      ).length,
      features: (data.features ?? []).length,
      unknowns: (data.unknowns ?? []).length,
      openUnknowns: (data.unknowns ?? []).filter(
        (/** @type {any} */ item) => item.status !== "resolved",
      ).length,
      obligations: obligations.length,
      checks: checks.length,
      builds: builds.length,
    },
    latestBuild: latestBuild
      ? {
          round: Number(latestBuild.round) || 0,
          status: latestBuild.status,
          command: latestBuild.command,
          implementationDigest: shortDigest(latestBuild.implementationDigest),
          endedAt: latestBuild.endedAt ?? null,
        }
      : null,
    obligations: obligations.map((/** @type {any} */ item) => ({
      id: item.id,
      statement: item.statement,
      kind: item.kind,
      status: item.status,
      provenance: item.source,
      checks: (item.checkIds ?? []).length,
    })),
    checks: checks.map((/** @type {any} */ item) => ({
      id: item.id,
      obligationId: item.obligationId,
      checker: item.checker,
      verdict: item.verdict,
      implementationDigest: shortDigest(item.implementationDigest),
      at: item.evidenceFetchedAt ?? item.at,
    })),
    unknowns: (data.unknowns ?? []).map((/** @type {any} */ item) => ({
      id: item.id,
      text: item.text,
      severity: item.severity,
      status: item.status,
    })),
    stop: input.stop ?? null,
  };
}

/**
 * 渲染成 Markdown。
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function renderReportMarkdown(report) {
  const lines = [];
  const percent = (report.coverage.ratio * 100).toFixed(0);
  lines.push(`# 验收报告：${report.project.title}`);
  lines.push("");
  lines.push(`- 项目：\`${report.project.id}\``);
  lines.push(`- 状态：${report.project.state}`);
  lines.push(
    `- 目标：${report.project.target?.kind ?? "?"} · ${report.project.target?.ref ?? "?"}`,
  );
  lines.push(`- 授权档：${report.project.authTier}`);
  lines.push(`- 覆盖率：**${percent}%**（${report.coverage.pass}/${report.coverage.total}）`);
  lines.push(`- 生成时间：${report.generatedAt}`);
  if (report.latestBuild) {
    lines.push(
      `- 最近构建：第 ${report.latestBuild.round} 轮 · ${report.latestBuild.status} · 实现 \`${report.latestBuild.implementationDigest}\``,
    );
  }
  lines.push("");
  lines.push("## 计数");
  lines.push("");
  lines.push("| 项 | 数量 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(report.counts ?? {})) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push("");
  if ((report.coverageByFeature ?? []).length > 0) {
    lines.push("## 按功能覆盖率");
    lines.push("");
    lines.push("| 功能 | 覆盖率 | 已关闭/总数 |");
    lines.push("| --- | --- | --- |");
    for (const item of report.coverageByFeature) {
      lines.push(
        `| ${item.name} | ${(item.ratio * 100).toFixed(0)}% | ${item.pass}/${item.total} |`,
      );
    }
    lines.push("");
  }
  lines.push("## 义务");
  lines.push("");
  if ((report.obligations ?? []).length === 0) {
    lines.push("_没有义务。_");
  } else {
    lines.push("| 状态 | 义务 | 种类 | 检查数 |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of report.obligations) {
      lines.push(`| ${item.status} | ${item.statement} | ${item.kind} | ${item.checks} |`);
    }
  }
  lines.push("");
  lines.push("## 检查");
  lines.push("");
  if ((report.checks ?? []).length === 0) {
    lines.push("_没有检查记录。_");
  } else {
    lines.push("| 结论 | checker | 实现 | 时间 |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of report.checks) {
      lines.push(
        `| ${item.verdict} | ${item.checker} | \`${item.implementationDigest}\` | ${item.at} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 未知项");
  lines.push("");
  if ((report.unknowns ?? []).length === 0) {
    lines.push("_没有未知项。_");
  } else {
    for (const item of report.unknowns) {
      lines.push(`- [${item.severity}] ${item.text}（${item.status}）`);
    }
  }
  if (report.stop) {
    lines.push("");
    lines.push("## 循环状态");
    lines.push("");
    lines.push(`- 停止条件：${report.stop.reason ?? "unknown"}`);
    const detail = report.stop.detail ?? {};
    lines.push(`- 轮次：${detail.rounds ?? "—"} / 失败：${detail.failures ?? "—"}`);
  }
  if ((report.producers ?? []).length > 0) {
    lines.push("");
    lines.push("## 证据生产者");
    lines.push("");
    lines.push("| 工具 | 版本 | 获取方式 | 产物 | 用户已确认 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of report.producers) {
      lines.push(
        `| ${item.tool} | ${item.version ?? "—"} | ${item.mode ?? "—"} | ${item.outputKind ?? "—"} | ${item.accessConfirmedByUser ? "是" : "否"} |`,
      );
    }
    lines.push("");
    lines.push("> casefile 不采集、不规避访问控制：以上生产者由操作者选择并执行，责任归操作者。");
  }
  if (report.cleanRoom) {
    lines.push("");
    lines.push("## 净室 attestation");
    lines.push("");
    const cr = report.cleanRoom;
    lines.push(`- 时间：${cr.at}`);
    lines.push(`- builder 会话：\`${cr.builderSession}\``);
    lines.push(
      `- 授权档：${cr.authTier}${cr.researchOverride ? "（research 档，已显式覆盖）" : ""}`,
    );
    lines.push(`- 投喂规格：${cr.claimCount} 条结论 / ${cr.evidenceCount} 条证据`);
    lines.push(
      `- 净室指令写入 prompt：${cr.cleanRoomInstruction ? "是" : "**否**（本次投喂未包含该要求）"}`,
    );
    lines.push(`- prompt 摘要：\`${cr.promptDigest}\``);
    lines.push(`- 工具面隔离：${cr.toolIsolation}`);
    lines.push("");
    lines.push(`> ${cr.statement}`);
  }
  lines.push("");
  lines.push("## 声明");
  lines.push("");
  lines.push("- 本报告对应上面「最近构建」的实现 digest；实现或原件变化后，旧结论不再有效。");
  lines.push("- 检查结论来自 casefile 的 checker，`unknown` 表示无法判定，不等于通过。");
  lines.push("");
  return lines.join("\n");
}

/**
 * HTML 转义。报告内容来自用户输入（标题、义务文本、路径），必须转义。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 把报告渲染成**单文件 HTML**（内联样式、零外部资源），用于外发与存档。
 * 样式刻意简单：归档件十年后打开也应该是这个样子，不依赖任何 CDN。
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function renderReportHtml(report) {
  const r = report ?? {};
  const project = r.project ?? {};
  const counts = r.counts ?? {};
  const coverage = r.coverage ?? {};
  const e = escapeHtml;
  /**
   * @param {unknown[]} cells
   * @param {string} [tag]
   * @returns {string}
   */
  const row = (cells, tag = "td") =>
    `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;
  /**
   * @param {string} title
   * @param {string} body
   * @returns {string}
   */
  const section = (title, body) =>
    body === "" ? "" : `<section><h2>${e(title)}</h2>${body}</section>`;

  const summary = `
    <dl>
      <dt>项目</dt><dd>${e(project.title ?? project.id)} <span class="muted">(${e(project.id)})</span></dd>
      <dt>目标</dt><dd>${e(project.target?.ref ?? "")} <span class="muted">${e(project.target?.kind ?? "")}</span></dd>
      <dt>授权档</dt><dd>${e(project.authTier ?? "")}</dd>
      <dt>状态</dt><dd>${e(project.state ?? "")}</dd>
      <dt>覆盖率</dt><dd><strong>${(Number(coverage.ratio ?? 0) * 100).toFixed(0)}%</strong> <span class="muted">(${e(coverage.pass ?? 0)}/${e(coverage.total ?? 0)})</span></dd>
      <dt>生成时间</dt><dd>${e(r.generatedAt ?? "")}</dd>
    </dl>`;

  const countsTable = `<table><thead><tr><th>项</th><th>数量</th></tr></thead><tbody>${Object.entries(
    counts,
  )
    .map(([key, value]) => row([e(key), e(value)]))
    .join("")}</tbody></table>`;

  const obligations = Array.isArray(r.obligations)
    ? `<table><thead><tr><th>状态</th><th>义务</th><th>种类</th><th>检查数</th></tr></thead><tbody>${r.obligations
        .map((item) =>
          row([e(item.status), e(item.statement), e(item.kind), e(item.checkIds?.length ?? 0)]),
        )
        .join("")}</tbody></table>`
    : "";

  const checks = Array.isArray(r.checks)
    ? `<table><thead><tr><th>结论</th><th>checker</th><th>实现</th><th>时间</th></tr></thead><tbody>${r.checks
        .map((item) =>
          row([e(item.verdict), e(item.checker), e(item.implementationDigest), e(item.createdAt)]),
        )
        .join("")}</tbody></table>`
    : "";

  const producers =
    Array.isArray(r.producers) && r.producers.length > 0
      ? `<table><thead><tr><th>工具</th><th>版本</th><th>获取方式</th><th>产物</th><th>用户已确认</th></tr></thead><tbody>${r.producers
          .map((item) =>
            row([
              e(item.tool ?? "未知"),
              e(item.version ?? "—"),
              e(item.mode ?? "—"),
              e(item.outputKind ?? "—"),
              e(item.accessConfirmedByUser === true ? "是" : "未记录"),
            ]),
          )
          .join(
            "",
          )}</tbody></table><p class="note">casefile 不采集、不规避访问控制：以上生产者由操作者选择并执行，责任归操作者。</p>`
      : "";

  const unknowns =
    Array.isArray(r.unknowns) && r.unknowns.length > 0
      ? `<ul>${r.unknowns.map((item) => `<li>${e(item.text ?? item)}</li>`).join("")}</ul>`
      : '<p class="muted">没有未解决的未知项。</p>';

  const stop = r.stop
    ? `<p>停止条件：<strong>${e(r.stop.reason ?? "")}</strong>${r.stop.stop === true ? "（已停止）" : ""}</p>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>案卷报告 · ${e(project.title ?? project.id ?? "")}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px 20px 64px; background: #faf9f6; color: #1c1c1e;
         font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e6e3dc; }
  .sub { color: #6b6b70; font-size: 12px; margin-bottom: 24px; }
  .muted { color: #6b6b70; font-size: 12px; }
  .note { color: #6b6b70; font-size: 12px; margin-top: 6px; }
  dl { display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; margin: 0; padding: 16px;
       background: #fff; border: 1px solid #e6e3dc; border-radius: 10px; }
  dt { color: #6b6b70; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e6e3dc;
          border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0ede7; vertical-align: top; }
  th { background: #f4f1ea; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  ul { margin: 0; padding-left: 20px; }
  footer { margin-top: 32px; color: #6b6b70; font-size: 12px; }
</style>
</head>
<body><div class="wrap">
  <h1>案卷报告 · ${e(project.title ?? project.id ?? "")}</h1>
  <p class="sub">casefile 生成的只读归档件；数据来自项目记录，不重新采集。</p>
  ${section("概览", summary)}
  ${section("计数", countsTable)}
  ${section("义务", obligations)}
  ${section("检查", checks)}
  ${section("证据生产者", producers)}
  ${section("未知项", unknowns)}
  ${section("循环状态", stop)}
  <footer>本报告不评估目标安全性；只陈述静态分析与验收记录。<br>生成器：@kangyishuai/dsh-casefile</footer>
</div></body></html>`;
}
