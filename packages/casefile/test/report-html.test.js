// @ts-check
// HTML 报告：单文件、转义、三格式行为。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { escapeHtml, renderReportHtml } from "../lib/core/report.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-htmlreport-"));
  dirs.push(root);
  return {
    actions: createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root }),
    root,
  };
}

test("escapeHtml 转义五个危险字符", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("renderReportHtml：单文件、无外部资源、标题被转义", () => {
  const html = renderReportHtml({
    project: { id: "p", title: "标题 <script>alert(1)</script>" },
    counts: { claims: 1 },
    coverage: { ratio: 1, total: 1, pass: 1 },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(html, /^<!doctype html>/u);
  assert.equal(html.includes("<script"), false, "不得引入脚本（含未转义输入）");
  assert.equal(html.includes("&lt;script&gt;"), true);
  // 零外部资源：不应出现 http(s) 的 src/href
  assert.equal(/(?:src|href)="https?:\/\//u.test(html), false);
  assert.equal(html.includes("<style>"), true);
});

test("exportReport format=md 保持旧行为（不产出 html）", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const result = await actions.exportReport("p", {});
  assert.deepEqual(result.files, ["report.md", "report.json"]);
  assert.equal(existsSync(join(result.path, "report.html")), false);
});

test("exportReport format=html 产出可离线打开的 html", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const result = await actions.exportReport("p", { format: "html" });
  assert.deepEqual(result.files, ["report.html", "report.json"]);
  const html = readFileSync(join(result.path, "report.html"), "utf8");
  assert.match(html, /案卷报告/u);
  assert.equal(html.includes('src="http'), false);
});

test("exportReport format=both 产出三份", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const result = await actions.exportReport("p", { format: "both" });
  assert.deepEqual(result.files, ["report.md", "report.html", "report.json"]);
});

test("非法 format 报 invalid-input", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  await assert.rejects(
    () => actions.exportReport("p", { format: /** @type {any} */ ("pdf") }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});
