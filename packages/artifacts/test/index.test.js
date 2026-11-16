// @ts-check
// 存储层单测：只在 mkdtemp 出来的临时目录里跑（仓库硬性约定 7）。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createArtifactStore, MAX_BYTES, resolveDataRoot, slugify } from "../lib/store.js";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createArtifactStore>} */
let store;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-artifacts-store-"));
  store = createArtifactStore({ root });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("create 写入 v1，并返回可读的最新版本", async () => {
  const meta = await store.create({ title: "Q3 report", html: "<h1>one</h1>" });
  assert.equal(meta.latest, 1);
  assert.equal(meta.versions.length, 1);
  assert.match(meta.id, /^q3-report-[0-9a-f]{6}$/u);

  const found = await store.read(meta.id);
  assert.equal(found?.version, 1);
  assert.equal(found?.html, "<h1>one</h1>");
});

test("append 递增版本，旧版本仍可读", async () => {
  const meta = await store.create({ title: "Deck", html: "<h1>v1</h1>" });
  const second = await store.append(meta.id, { html: "<h1>v2</h1>" });
  assert.equal(second.latest, 2);
  assert.equal((await store.read(meta.id, 1))?.html, "<h1>v1</h1>");
  assert.equal((await store.read(meta.id))?.html, "<h1>v2</h1>");
});

test("append 未知 id 报错，read 未知版本返回 undefined", async () => {
  await assert.rejects(
    () => store.append("missing-000000", { html: "<p>x</p>" }),
    /unknown artifact/u,
  );
  const meta = await store.create({ title: "Small", html: "<p>a</p>" });
  assert.equal(await store.read(meta.id, 9), undefined);
  assert.equal(await store.read(meta.id, 0), undefined);
});

test("空 HTML 与超限 HTML 都被拒绝", async () => {
  await assert.rejects(() => store.create({ title: "Empty", html: "" }), /empty/u);
  const huge = "x".repeat(MAX_BYTES + 1);
  await assert.rejects(() => store.create({ title: "Huge", html: huge }), /over the/u);
});

test("list 按更新时间倒序，且只含目录型 artifact", async () => {
  const first = await store.create({ title: "Older", html: "<p>1</p>" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.create({ title: "Newer", html: "<p>2</p>" });
  const rows = await store.list();
  const ids = rows.map((row) => row.id);
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id), "newer artifact should come first");
});

test("remove 删掉目录，再读为 undefined", async () => {
  const meta = await store.create({ title: "Temp", html: "<p>t</p>" });
  assert.equal(await store.remove(meta.id), true);
  assert.equal(await store.read(meta.id), undefined);
  assert.equal(await store.remove(meta.id), false);
});

test("元数据落盘为可读 JSON，版本文件按 vN.html 命名", async () => {
  const meta = await store.create({ title: "Disk", html: "<p>d</p>" });
  const metaText = await readFile(join(store.root, meta.id, "meta.json"), "utf8");
  assert.equal(JSON.parse(metaText).latest, 1);
  const html = await readFile(join(store.root, meta.id, "v1.html"), "utf8");
  assert.equal(html, "<p>d</p>");
});

test("slugify 处理中文、空白与路径分隔符", () => {
  assert.equal(slugify("Q3 报告 / 2026"), "q3-报告-2026");
  assert.equal(slugify("   "), "artifact");
  assert.ok(slugify("a".repeat(80)).length <= 40);
});

test("resolveDataRoot 优先级：config > DSH_HOME > HOME", () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = "/tmp/dsh-home-test";
    assert.equal(resolveDataRoot({ dataRoot: "/tmp/custom" }), "/tmp/custom");
    assert.equal(resolveDataRoot({}), "/tmp/dsh-home-test");
    delete process.env.DSH_HOME;
    assert.ok(resolveDataRoot({}).endsWith("/.dsh"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
