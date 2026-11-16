// @ts-check
// 单元测试：core/store.js（全部在 mkdtemp 临时目录里跑）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CaseStore, CaseStoreError } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {string} */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "casefile-store-"));
  dirs.push(dir);
  return dir;
}

/** @returns {CaseStore} */
function makeStore() {
  return new CaseStore({ dataRoot: tempRoot() });
}

test("createProject 建目录并写 project.json", () => {
  const store = makeStore();
  const project = store.createProject({
    title: "Payments API",
    target: { kind: "web", ref: "https://x" },
  });
  assert.equal(project.id, "payments-api");
  assert.equal(project.version, 1);
  const raw = JSON.parse(
    readFileSync(join(store.rootDir, "projects/payments-api/project.json"), "utf8"),
  );
  assert.equal(raw.title, "Payments API");
  assert.equal(raw.target.kind, "web");
});

test("重复 id 抛 project-exists", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  assert.throws(
    () => store.createProject({ title: "A", id: "a" }),
    (error) => error instanceof CaseStoreError && error.code === "project-exists",
  );
});

test("append/read 记录按 id 后者胜（append-only 更新）", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  store.appendRecord("a", "claims", { id: "c1", text: "old", selected: false });
  store.appendRecord("a", "claims", { id: "c1", text: "new", selected: true });
  const rows = store.readRecords("a", "claims");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "new");
  assert.equal(rows[0].selected, true);
});

test("读高版本项目文件抛 read-only-newer，不静默改", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  const file = join(store.rootDir, "projects/a/project.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  value.version = 99;
  writeFileSync(file, JSON.stringify(value), "utf8");
  assert.throws(
    () => store.getProject("a"),
    (error) => error instanceof CaseStoreError && error.code === "read-only-newer",
  );
  assert.match(readFileSync(file, "utf8"), /"version":\s*99/);
});

test("坏文件改名 .broken 并返回 null", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  const file = join(store.rootDir, "projects/a/project.json");
  writeFileSync(file, "{not json", "utf8");
  assert.equal(store.getProject("a"), null);
  assert.match(readFileSync(`${file}.broken`, "utf8"), /not json/);
});

test("非法项目 id 拒绝（防路径穿越）", () => {
  const store = makeStore();
  assert.throws(
    () => store.projectDir("../etc"),
    (error) => error instanceof CaseStoreError && error.code === "bad-project-id",
  );
});

test("listProjects 跳过坏项目并返回可用项目", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  store.createProject({ title: "B" });
  const brokenDir = join(store.rootDir, "projects", "broken");
  writeFileSync(join(store.rootDir, "projects", "broken"), "", "utf8");
  // broken/ 不是目录，listProjectIds 会跳过它
  assert.equal(store.listProjectIds().includes("broken"), false);
  const projects = store.listProjects();
  assert.equal(projects.length, 2);
  assert.ok(brokenDir.startsWith(store.rootDir));
});

test("audit 追加且可读", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  store.audit("a", { actor: "user", action: "test/one" });
  const rows = store.readAudit("a");
  assert.ok(rows.some((row) => row.action === "test/one"));
});
