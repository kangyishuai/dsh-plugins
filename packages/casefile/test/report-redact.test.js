// @ts-check
// 报告的脱敏口径（AUD-CASEFILE-04）：与 spec pack / bundle 共用 redactPack，默认脱敏。
//
// 背景：工具描述把 html 报成「单文件、可外发归档」，但 report 完全没有 redact 选项，
// 报告正文直接写 project.target.ref（通常是本机绝对路径），与外发承诺相反。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {{ actions: ReturnType<typeof createActions>, root: string }} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-report-redact-"));
  dirs.push(root);
  return {
    actions: createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root }),
    root,
  };
}

const TARGET = "/Applications/SecretApp.app";
// 运行时拼接：源码里不出现完整 token 字面量（gitleaks 扫 PR 全部 commit）。
const TOKEN = ["AIza", "SyD-example-0123456789abcdefghij"].join("");

/** @returns {Promise<{ actions: ReturnType<typeof createActions>, id: string }>} */
async function projectWithArtifacts() {
  const { actions } = makeActions();
  const project = await actions.openProject({
    title: "Report Redact",
    target: { kind: "app", ref: TARGET },
  });
  await actions.addEvidence(project.id, {
    summary: `应用包摘要，key=${TOKEN}`,
    kind: "structure",
    refs: [TARGET],
  });
  return { actions, id: project.id };
}

test("exportReport 默认脱敏：md/html/json 都不含本机路径与 token", async () => {
  const { actions, id } = await projectWithArtifacts();
  const exported = await actions.exportReport(id, { format: "both" });
  assert.equal(exported.redacted, true);
  const files = ["report.md", "report.html", "report.json"];
  for (const file of files) {
    const text = readFileSync(join(exported.path, file), "utf8");
    assert.equal(text.includes(TARGET), false, `${file} 仍含目标绝对路径`);
    assert.equal(text.includes(TOKEN), false, `${file} 仍含 token`);
    assert.match(text, /<path>|&lt;path&gt;|\[redacted\]/u, `${file} 应有脱敏占位`);
  }
  const json = JSON.parse(readFileSync(join(exported.path, "report.json"), "utf8"));
  assert.equal(json.project.target.ref, "<path>");
  assert.equal(json.redaction.redacted, true);
});

test("报告 foot 标注是否已脱敏（md 与 html 都要有）", async () => {
  const { actions, id } = await projectWithArtifacts();
  const exported = await actions.exportReport(id, { format: "both" });
  const md = readFileSync(join(exported.path, "report.md"), "utf8");
  const html = readFileSync(join(exported.path, "report.html"), "utf8");
  assert.match(md, /脱敏：已脱敏/u);
  assert.match(html, /已脱敏/u);
});

test("redact:false 时显式关闭脱敏，并如实标注未脱敏", async () => {
  const { actions, id } = await projectWithArtifacts();
  const exported = await actions.exportReport(id, { format: "both", redact: false });
  assert.equal(exported.redacted, false);
  const md = readFileSync(join(exported.path, "report.md"), "utf8");
  assert.match(md, /\/Applications\/SecretApp\.app/u);
  assert.match(md, /脱敏：未脱敏/u);
  const json = JSON.parse(readFileSync(join(exported.path, "report.json"), "utf8"));
  assert.equal(json.project.target.ref, TARGET);
  assert.equal(json.redaction.redacted, false);
});

test("exportReport 写审计时记录脱敏状态", async () => {
  const { actions, id } = await projectWithArtifacts();
  await actions.exportReport(id);
  const audit = await actions.readAudit(id);
  const entry = audit.find((row) => row.action === "report/export");
  assert.ok(entry);
  assert.equal(entry.detail.redacted, true);
});
