// @ts-check
// 覆盖率硬门与报告导出（M3 收尾）。
// 重点：没有义务 / 有 open 义务 / 有未知项 / 检查过期 / 实现不一致 —— 都必须拒绝关闭。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { computeCoverage, evaluateClose } from "../lib/core/report.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {ReturnType<typeof createActions>} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-report-"));
  dirs.push(root);
  return createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root });
}

const BUILD_OK = 'node -e "0"';

/** 建项目 + 一条带配方义务，跑一轮让它关闭。 */
async function projectWithClosedObligation(/** @type {any} */ actions) {
  const project = await actions.openProject({ title: "Ready" });
  await actions.addObligation(project.id, {
    statement: "构建成功",
    kind: "existence",
    check: { checker: "build", command: BUILD_OK },
  });
  await actions.advanceLoop(project.id, { command: BUILD_OK });
  return project.id;
}

test("computeCoverage：只统计有效状态", () => {
  const coverage = computeCoverage([
    { status: "pass" },
    { status: "pass" },
    { status: "open" },
    { status: "out_of_scope" },
  ]);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.pass, 2);
  assert.equal(coverage.open, 1);
  assert.equal(coverage.outOfScope, 1);
  assert.ok(Math.abs(coverage.ratio - 2 / 3) < 1e-9);
});

test("evaluateClose：没有义务 → no-obligations", () => {
  const verdict = evaluateClose({ obligations: [], unknowns: [], checks: [] });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.includes("no-obligations"));
});

test("evaluateClose：有 open 义务/未知项/无检查 → 拒绝", () => {
  const verdict = evaluateClose({
    obligations: [{ status: "open" }],
    unknowns: [{ status: "open" }],
    checks: [],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((item) => item.startsWith("open-obligations")));
  assert.ok(verdict.blockers.some((item) => item.startsWith("open-unknowns")));
  assert.ok(verdict.blockers.includes("no-checks"));
});

test("evaluateClose：检查过期 / 实现不一致 → 拒绝", () => {
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const stale = evaluateClose({
    obligations: [{ status: "pass" }],
    unknowns: [],
    checks: [
      { verdict: "pass", evidenceFetchedAt: old, implementationDigest: "impl-old", at: old },
    ],
    implementationDigest: "impl-new",
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.blockers.includes("stale-checks"));
  assert.ok(stale.blockers.includes("implementation-mismatch"));
});

test("closeProject：条件齐了才允许关闭并写状态", async () => {
  const actions = makeActions();
  const id = await projectWithClosedObligation(actions);
  const preview = await actions.closePreview(id);
  assert.equal(preview.ok, true, JSON.stringify(preview.blockers));
  const closed = await actions.closeProject(id);
  assert.equal(closed.project.state, "closed");
  assert.match(String(closed.project.closedAt), /^\d{4}-/u);
  const again = await actions.closeProject(id);
  assert.equal(again.alreadyClosed, true);
});

test("closeProject：有未解决未知项时拒绝并给出 code", async () => {
  const actions = makeActions();
  const id = await projectWithClosedObligation(actions);
  await actions.addUnknown(id, { text: "并发上限未知", severity: "high" });
  await assert.rejects(
    () => actions.closeProject(id),
    (error) => /** @type {any} */ (error).code === "coverage-not-met",
  );
  const project = await actions.detail(id);
  assert.equal(project.project.state, "investigating");
});

test("closeProject：实现变了（stale）时拒绝关闭", async () => {
  const root = mkdtempSync(join(tmpdir(), "casefile-report-stale-"));
  dirs.push(root);
  const actions2 = createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    runner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });
  const project = await actions2.openProject({ title: "Stale" });
  await actions2.addObligation(project.id, {
    statement: "构建成功",
    check: { checker: "build", command: "build" },
  });
  await actions2.advanceLoop(project.id, { command: "build" });
  // 用不同 digest 再构建一次，让旧检查失配
  await actions2.startBuild(project.id, {
    command: "build",
    cwd: mkdtempSync(join(tmpdir(), "casefile-impl-")),
  });
  const preview = await actions2.closePreview(project.id);
  assert.equal(preview.ok, false);
  assert.ok(
    preview.blockers.some(
      (/** @type {string} */ item) =>
        item.includes("implementation-mismatch") || item.includes("open-obligations"),
    ),
  );
});

test("exportReport：写出 report.md / report.json，含覆盖率与声明", async () => {
  const actions = makeActions();
  const id = await projectWithClosedObligation(actions);
  await actions.closeProject(id);
  const exported = await actions.exportReport(id);
  assert.equal(existsSync(join(exported.path, "report.md")), true);
  assert.equal(existsSync(join(exported.path, "report.json")), true);
  const md = readFileSync(join(exported.path, "report.md"), "utf8");
  assert.match(md, /# 验收报告/u);
  assert.match(md, /覆盖率：\*\*100%\*\*/u);
  assert.match(md, /## 声明/u);
  assert.match(md, /unknown.*不等于通过/u);
  const json = JSON.parse(readFileSync(join(exported.path, "report.json"), "utf8"));
  assert.equal(json.coverage.ratio, 1);
  assert.equal(json.counts.obligations, 1);
  assert.ok(json.latestBuild);
});
