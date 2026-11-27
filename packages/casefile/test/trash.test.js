// @ts-check
// 破坏性操作（ADR 0002）：drop 的 dry-run / 影响面 / 数据根审计，回收站的查看 / 恢复 / 清空。
//
// 背景（AUD-CASEFILE-03 + AUD-XCT-07）：drop 把整个项目目录移进 trash，但
//   - 没有 dry-run、没有数量/体积；
//   - 全链路不写审计（项目内 audit.jsonl 也写不进去，必须在数据根级留痕）；
//   - 全仓没有 trash 的查看/恢复/清空入口 —— 移进去的项目只能靠 find 找、手 rm 清。
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** @returns {{ actions: ReturnType<typeof createActions>, store: CaseStore, root: string }} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-trash-"));
  dirs.push(root);
  const store = new CaseStore({ dataRoot: root });
  return { actions: createActions({ store, dataRoot: root }), store, root };
}

test("drop dry-run：给出项目数/字节/预览路径，但不移动目录、不写审计", async () => {
  const { actions, store, root } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  await actions.addEvidence(project.id, { summary: "一条证据" });
  const preview = await actions.dropProject(project.id, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.projectId, project.id);
  assert.equal(preview.projects, 1);
  assert.ok(preview.bytes > 0, "应给出项目目录字节数");
  assert.ok(preview.files > 0, "应给出文件数");
  assert.match(String(preview.previewTrashPath), /trash/u, "预览路径应指向 trash/");
  assert.match(String(preview.trashRoot), /trash/u);
  assert.equal(preview.trashPath, undefined, "字段名应明确是 previewTrashPath（F5）");
  assert.equal(existsSync(join(root, "projects", project.id)), true, "dry-run 不能移走目录");
  assert.equal(store.readAuditRoot().length, 0, "dry-run 不写审计");
});

test("drop confirm：移入 trash，并在数据根写审计（含目标与字节数）", async () => {
  const { actions, store, root } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  assert.equal(existsSync(dropped.trashedTo), true);
  assert.equal(existsSync(join(root, "projects", project.id)), false);
  const audit = store.readAuditRoot();
  const entry = audit.find((row) => row.action === "project/drop");
  assert.ok(entry, `数据根审计里应有 project/drop：${JSON.stringify(audit)}`);
  assert.equal(entry.target, project.id);
  assert.equal(entry.detail.trashedTo, dropped.trashedTo);
  assert.ok(entry.detail.bytes > 0);
});

test("drop confirm 缺 confirm 时拒绝，且报错写出影响面", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  await assert.rejects(
    () => actions.dropProject(project.id, {}),
    (error) =>
      /** @type {any} */ (error).code === "confirm-required" &&
      /文件/u.test(String(/** @type {any} */ (error).message)),
  );
});

test("trash 列出回收站条目（含项目 id / 体积 / 文件数）", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const entries = await actions.listTrash();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.projectId, project.id);
  assert.equal(entry.name, dropped.trashedTo.split("/").at(-1));
  assert.equal(entry.bytes > 0, true);
  assert.equal(entry.files > 0, true);
  assert.match(String(entry.path), /trash/u);
  assert.equal(entry.trashedAt == null, false, "应能从目录名解析出时间");
});

test("restore 把项目移回 projects/，清空该回收站条目并写审计", async () => {
  const { actions, store, root } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  assert.ok(name);
  const restored = await actions.restoreTrash(name);
  assert.equal(restored.project.id, project.id);
  assert.equal(existsSync(join(root, "projects", project.id)), true);
  assert.equal(existsSync(dropped.trashedTo), false);
  const audit = store.readAuditRoot();
  assert.ok(audit.some((row) => row.action === "project/restore"));
});

test("restore 撞到同名项目时拒绝（project-exists），不覆盖现有项目", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  await actions.openProject({ id: project.id, title: "New Same" });
  await assert.rejects(
    () => actions.restoreTrash(String(name)),
    (error) => /** @type {any} */ (error).code === "project-exists",
  );
});

test("purge dry-run：给出条数/字节，不删任何目录", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  await actions.dropProject(project.id, { confirm: true });
  const preview = await actions.purgeTrash({ dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.count, 1);
  assert.ok(preview.bytes > 0);
  assert.match(String(preview.trashRoot), /trash/u, "dry-run 应给回收站根目录（N9）");
  assert.equal(preview.trashPath, undefined, "purge 不应再暴露易与条目预览路径混淆的 trashPath");
  assert.equal((await actions.listTrash()).length, 1);
});

test("purge 必须显式 confirm，且清空后写数据根审计", async () => {
  const { actions, store } = makeActions();
  const project = await actions.openProject({ title: "Drop Me" });
  await actions.dropProject(project.id, { confirm: true });
  await assert.rejects(
    () => actions.purgeTrash({}),
    (error) => /** @type {any} */ (error).code === "confirm-required",
  );
  const result = await actions.purgeTrash({ confirm: true });
  assert.equal(result.purged, 1);
  assert.equal((await actions.listTrash()).length, 0);
  const audit = store.readAuditRoot();
  assert.ok(audit.some((row) => row.action === "trash/purge"));
});

test("purge 只清认识的条目：回收站里来历不明的目录保留并告警", async () => {
  const { actions, store, root } = makeActions();
  const foreign = join(root, "trash", "some-unknown-thing");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "data.txt"), "keep me", "utf8");
  const project = await actions.openProject({ title: "Drop Me" });
  await actions.dropProject(project.id, { confirm: true });
  const result = await actions.purgeTrash({ confirm: true });
  assert.equal(result.purged, 1);
  assert.equal(existsSync(foreign), true, "不认识的条目必须保留");
  assert.ok(result.skipped >= 1, "跳过的条目要计数（ADR 0002：遇到不认识的条目保留并告警）");
  assert.equal(
    store.readAuditRoot().some((row) => row.action === "trash/purge"),
    true,
  );
  assert.equal(readdirSync(join(root, "trash")).includes("some-unknown-thing"), true);
  // 未受影响的文件内容仍在
  assert.equal(readFileSync(join(foreign, "data.txt"), "utf8"), "keep me");
});

test("restore 先校验 manifest：坏 project.json 的条目留在回收站并写失败审计（F3）", async () => {
  const { actions, store, root } = makeActions();
  const project = await actions.openProject({ title: "Bad Manifest" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  writeFileSync(join(dropped.trashedTo, "project.json"), "{not json", "utf8");
  await assert.rejects(
    () => actions.restoreTrash(String(name)),
    (error) => /** @type {any} */ (error).code === "not-found",
  );
  assert.equal(existsSync(dropped.trashedTo), true, "坏条目必须留在回收站，不能被搬进 projects/");
  assert.equal(existsSync(join(root, "projects", project.id)), false);
  assert.ok(
    store.readAuditRoot().some((row) => row.action === "project/restore-failed"),
    "恢复失败也要写数据根审计",
  );
});

test("restore 拒绝缺 project.json 的条目，目录保留（F3）", async () => {
  const { actions, root } = makeActions();
  const name = "2026-11-28T00-00-00-000Z-ghost-a";
  const dir = join(root, "trash", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "evidence.jsonl"), "{}\n", "utf8");
  await assert.rejects(
    () => actions.restoreTrash(name),
    (error) => /** @type {any} */ (error).code === "not-found",
  );
  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(join(root, "projects", "ghost-a")), false);
});

test("restore 拒绝 project.json 的 id 与条目名不一致（F3）", async () => {
  const { actions, root } = makeActions();
  const project = await actions.openProject({ title: "Mismatch Me" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  writeFileSync(
    join(dropped.trashedTo, "project.json"),
    JSON.stringify({ version: 1, id: "somewhere-else" }),
    "utf8",
  );
  await assert.rejects(
    () => actions.restoreTrash(String(name)),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
  assert.equal(existsSync(dropped.trashedTo), true, "不一致条目必须留在回收站");
  assert.equal(existsSync(join(root, "projects", project.id)), false);
});

test("listTrash 对更高版本的条目降级为「元数据未知」，不整表报错（N2）", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "Future Version" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  writeFileSync(
    join(dropped.trashedTo, "project.json"),
    JSON.stringify({ version: 99, id: project.id, title: "来自未来" }),
    "utf8",
  );
  const entries = await actions.listTrash();
  const entry = entries.find((row) => row.name === name);
  assert.ok(entry, "更高版本条目仍应列出来（它还在 trash 里）");
  assert.equal(entry.metadataUnreadable, true, "元数据应标记为未知，而不是让整表抛错");
  assert.equal(entry.title, null);
  assert.equal(existsSync(dropped.trashedTo), true, "列出来不能动目录");
});

test("restore 更高版本条目：拒绝并留在回收站（N2/N7）", async () => {
  const { actions, root } = makeActions();
  const project = await actions.openProject({ title: "Future Version" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  writeFileSync(
    join(dropped.trashedTo, "project.json"),
    JSON.stringify({ version: 99, id: project.id, title: "来自未来" }),
    "utf8",
  );
  await assert.rejects(
    () => actions.restoreTrash(String(name)),
    (error) => /** @type {any} */ (error).code === "not-found",
  );
  assert.equal(existsSync(dropped.trashedTo), true, "更高版本条目必须留在回收站");
  assert.equal(existsSync(join(root, "projects", project.id)), false);
});

test("恢复失败时审计写不进去也不顶掉原始错误（N3）", async () => {
  const { actions, root } = makeActions();
  const project = await actions.openProject({ title: "Readonly Root" });
  const dropped = await actions.dropProject(project.id, { confirm: true });
  const name = dropped.trashedTo.split("/").at(-1);
  writeFileSync(join(dropped.trashedTo, "project.json"), "{not json", "utf8");
  chmodSync(root, 0o555);
  try {
    await assert.rejects(
      () => actions.restoreTrash(String(name)),
      (error) => /** @type {any} */ (error).code === "not-found",
      "数据根只读时仍应报原始 not-found，而不是 EACCES",
    );
  } finally {
    chmodSync(root, 0o755);
  }
  assert.equal(existsSync(dropped.trashedTo), true);
});
