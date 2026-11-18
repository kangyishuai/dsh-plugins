// @ts-check
// core/overview.js：跨项目总览（只读聚合）。纯 Node，可单测。
//
// 用途：多目标调查时，一眼看到「我手上有哪些目标、各自卡在哪」。
// 只做聚合，不改变任何项目状态。

import { computeCoverage } from "./report.js";

/**
 * @param {Array<Record<string, any>>} projects
 * @param {Record<string, { obligations?: any[], unknowns?: any[], checks?: any[], builds?: any[] }>} dataById
 * @returns {Record<string, any>}
 */
export function buildOverview(projects, dataById) {
  /** @type {Record<string, number>} */
  const byKind = {};
  /** @type {Record<string, number>} */
  const byState = {};
  let obligations = 0;
  let openObligations = 0;
  let passedObligations = 0;
  let openUnknowns = 0;
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  for (const project of projects) {
    const data = dataById[project.id] ?? {};
    const coverage = computeCoverage(data.obligations ?? []);
    const unknownCount = (data.unknowns ?? []).filter(
      (/** @type {any} */ item) => item.status !== "resolved",
    ).length;
    const kind = String(project.target?.kind ?? "other");
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const state = String(project.state ?? "unknown");
    byState[state] = (byState[state] ?? 0) + 1;
    obligations += coverage.total;
    openObligations += coverage.open + coverage.fail + coverage.blocked;
    passedObligations += coverage.pass;
    openUnknowns += unknownCount;
    rows.push({
      id: project.id,
      title: project.title,
      kind,
      state,
      coverage: coverage.ratio,
      obligations: coverage.total,
      openObligations: coverage.open + coverage.fail + coverage.blocked,
      openUnknowns: unknownCount,
      updatedAt: project.updatedAt,
    });
  }
  rows.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return {
    projects: projects.length,
    byKind,
    byState,
    obligations: { total: obligations, open: openObligations, pass: passedObligations },
    openUnknowns,
    rows,
  };
}

/**
 * 一行摘要（工作台/工具输出用）。
 * @param {ReturnType<typeof buildOverview>} overview
 * @returns {string}
 */
export function summarizeOverview(overview) {
  const kinds = Object.entries(overview.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}×${count}`)
    .join(" ");
  return [
    `${overview.projects} 个项目`,
    kinds === "" ? "" : `（${kinds}）`,
    `· 义务 ${overview.obligations.pass}/${overview.obligations.total} 已关闭`,
    `· 未解决未知项 ${overview.openUnknowns}`,
  ]
    .filter(Boolean)
    .join(" ");
}
