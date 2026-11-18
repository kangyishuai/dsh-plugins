// @ts-check
// 跨项目总览（只读聚合）的单元测试。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { buildOverview, summarizeOverview } from "../lib/core/overview.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {ReturnType<typeof createActions>} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-overview-"));
  dirs.push(root);
  return createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root });
}

const BUILD_OK = 'node -e "0"';

test("buildOverview：按目标类型/状态聚合，义务与未知项求和", () => {
  const overview = buildOverview(
    [
      { id: "a", title: "A", target: { kind: "web" }, state: "investigating", updatedAt: "2" },
      { id: "b", title: "B", target: { kind: "web" }, state: "closed", updatedAt: "1" },
      { id: "c", title: "C", target: { kind: "binary" }, state: "investigating", updatedAt: "3" },
    ],
    {
      a: { obligations: [{ status: "pass" }, { status: "open" }], unknowns: [{ status: "open" }] },
      b: { obligations: [{ status: "pass" }], unknowns: [{ status: "resolved" }] },
      c: { obligations: [], unknowns: [{ status: "blocked" }] },
    },
  );
  assert.equal(overview.projects, 3);
  assert.deepEqual(overview.byKind, { web: 2, binary: 1 });
  assert.deepEqual(overview.byState, { investigating: 2, closed: 1 });
  assert.deepEqual(overview.obligations, { total: 3, open: 1, pass: 2 });
  assert.equal(overview.openUnknowns, 2);
  // 按 updatedAt 倒序
  assert.deepEqual(
    overview.rows.map((/** @type {any} */ row) => row.id),
    ["c", "a", "b"],
  );
  assert.equal(overview.rows.find((/** @type {any} */ row) => row.id === "a")?.coverage, 0.5);
});

test("summarizeOverview 生成一行摘要", () => {
  const summary = summarizeOverview(
    buildOverview(
      [{ id: "a", title: "A", target: { kind: "web" }, state: "investigating", updatedAt: "1" }],
      { a: { obligations: [{ status: "pass" }], unknowns: [] } },
    ),
  );
  assert.match(summary, /1 个项目/u);
  assert.match(summary, /web×1/u);
  assert.match(summary, /义务 1\/1/u);
});

test("actions.overview：跨项目统计真实数据", async () => {
  const actions = makeActions();
  const first = await actions.openProject({ title: "One", target: { kind: "web" } });
  await actions.openProject({ title: "Two", target: { kind: "binary" } });
  await actions.addObligation(first.id, {
    statement: "构建成功",
    check: { checker: "build", command: BUILD_OK },
  });
  await actions.advanceLoop(first.id, { command: BUILD_OK });
  await actions.addUnknown("two", { text: "未知" });
  const overview = await actions.overview();
  assert.equal(overview.projects, 2);
  assert.deepEqual(overview.byKind, { web: 1, binary: 1 });
  assert.deepEqual(overview.obligations, { total: 1, open: 0, pass: 1 });
  assert.equal(overview.openUnknowns, 1);
  assert.ok(overview.summary.includes("2 个项目"));
});
