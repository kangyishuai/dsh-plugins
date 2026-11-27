// @ts-check
// 单元测试：core/store.js（全部在 mkdtemp 临时目录里跑）。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("writeJson 写完不留 .tmp 残骸（实现用 pid+随机后缀，跨进程写同一文件不会互相截断）", () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  const file = join(store.rootDir, "projects", "a", "project.json");
  for (let index = 0; index < 8; index += 1) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.note = `round-${index}`;
    store.writeJson(file, value);
  }
  const leftovers = readdirSync(join(store.rootDir, "projects", "a")).filter((name) =>
    name.includes(".tmp-"),
  );
  assert.deepEqual(leftovers, [], "写完后不应留下临时文件");
});

test("updateJson 串行化「读 → await → 写」：撤掉锁会丢更新（F9）", async () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  const file = join(store.rootDir, "projects", "a", "project.json");
  // mutate 里 await 一个 tick：这是单线程下唯一可能让读-改-写交错的情形。
  // 没有锁时 6 个回调会读到同一个旧值、互相覆盖；有锁时依次完成。
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      store.updateJson(file, async (current) => {
        await tick();
        return { ...current, notes: [...(current.notes ?? []), `n${index}`] };
      }),
    ),
  );
  const value = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(value.notes.length, 6, "6 次更新都必须在最终文件里");
  assert.deepEqual([...value.notes].sort(), ["n0", "n1", "n2", "n3", "n4", "n5"]);
});

test("touch 只更新 updatedAt；并发调用不会写坏 project.json（同步 IO 下本就不会交错，防回归）", async () => {
  const store = makeStore();
  store.createProject({ title: "A" });
  const file = join(store.rootDir, "projects", "a", "project.json");
  const before = JSON.parse(readFileSync(file, "utf8"));
  await Promise.all([store.touch("a"), store.touch("a"), store.touch("a")]);
  const value = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(value.title, before.title);
  assert.equal(value.createdAt, before.createdAt);
  assert.match(String(value.updatedAt), /^\d{4}-/u);
});
