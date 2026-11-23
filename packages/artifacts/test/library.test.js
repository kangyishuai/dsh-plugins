// @ts-check
// 跨插件契约层单测：artifacts 0.2 的 9 条需求里，凡是"会被别的插件依赖"的行为都在这里断言。
// 一律 mkdtemp（仓库硬性约定 7），每个 test 一个独立根目录，互不干扰。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONTRACT,
  createArtifactLibrary,
  LIBRARY_METHODS,
  publicArtifact,
} from "../lib/library.js";
import {
  ARTIFACT_CONTRACT,
  ARTIFACT_KINDS,
  createArtifactStore,
  latestBytes,
  MAX_BYTES,
  slugify,
  summarizeArtifacts,
} from "../lib/store.js";

/** 1x1 透明 PNG：十进制 67 字节，用来验证二进制往返不被 UTF-8 破坏。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");

/** @param {Buffer | string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeLibrary() {
  const root = await mkdtemp(join(tmpdir(), "dsh-artifacts-library-"));
  const store = createArtifactStore({ root });
  return {
    root,
    store,
    library: createArtifactLibrary({ store }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("契约探针：version() 报出 contract / 类型 / 上限 / 方法集", async () => {
  const lib = await makeLibrary();
  try {
    const info = await lib.library.version();
    assert.equal(info.ok, true);
    assert.equal(info.contract, ARTIFACT_CONTRACT);
    assert.equal(info.contract, CONTRACT);
    assert.equal(info.service, "artifacts");
    assert.deepEqual(info.kinds, [...ARTIFACT_KINDS]);
    assert.equal(info.maxBytes, MAX_BYTES);
    assert.deepEqual(info.methods, [...LIBRARY_METHODS]);
    assert.equal(typeof info.packageVersion, "string");
    assert.equal(info.plugin, "@kangyishuai/dsh-artifacts");
  } finally {
    await lib.cleanup();
  }
});

test("list() 不传参数 = 全量（0.1.0 行为），行形状稳定且带 URL", async () => {
  const lib = await makeLibrary();
  try {
    const created = await lib.store.create({ title: "Hello", html: "<h1>hi</h1>" });
    const page = await lib.library.list();
    assert.equal(page.ok, true);
    assert.equal(page.contract, CONTRACT);
    assert.equal(page.artifacts.length, 1);
    const row = page.artifacts[0];
    assert.equal(row.id, created.id);
    assert.equal(row.kind, "html");
    assert.equal(row.projectId, null);
    assert.equal(row.sessionId, null);
    assert.equal(row.source, null);
    assert.equal(row.archived, false);
    assert.equal(row.coverUrl, `/artifacts/${created.id}/cover.svg`);
    assert.equal(row.previewUrl, `/artifacts/${created.id}`);
    assert.equal(row.downloadUrl, `/artifacts/${created.id}?download=1`);
    assert.deepEqual(page.summary.byProject, [
      { projectId: null, count: 1, bytes: "<h1>hi</h1>".length },
    ]);
  } finally {
    await lib.cleanup();
  }
});

test("latest：缺 id 与未知 id 分别给 artifacts/invalid 与 artifacts/not-found", async () => {
  const lib = await makeLibrary();
  try {
    const missing = await lib.library.latest({});
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "artifacts/invalid");
    const unknown = await lib.library.latest({ id: "nope-000000" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "artifacts/not-found");
  } finally {
    await lib.cleanup();
  }
});

test("latest：版本没变时 changed:false 仍带 kind（客户端不用再猜类型）", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({ title: "Poll", kind: "markdown", content: "# hi" });
    const first = await lib.library.latest({ id: meta.id });
    assert.equal(first.changed, true);
    assert.equal(first.kind, "markdown");
    assert.equal(first.text, "# hi");
    assert.equal(first.html, undefined);
    const again = await lib.library.latest({ id: meta.id, since: first.version });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(again.kind, "markdown");
    assert.equal(again.version, 1);
  } finally {
    await lib.cleanup();
  }
});

test("latest：图片不把二进制搬进 RPC，只给 URL 与 kind", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({ title: "Chart", kind: "image", data: PNG });
    const page = await lib.library.latest({ id: meta.id });
    assert.equal(page.ok, true);
    assert.equal(page.kind, "image");
    assert.equal(page.mime, "image/png");
    assert.equal(page.html, undefined);
    assert.equal(page.text, undefined);
    assert.equal(page.previewUrl, `/artifacts/${meta.id}`);
  } finally {
    await lib.cleanup();
  }
});

test("按 projectId 过滤：只返回本项目；空项目返回空（不是全量）", async () => {
  const lib = await makeLibrary();
  try {
    await lib.store.create({ title: "A one", html: "<p>a1</p>", projectId: "proj-a" });
    await lib.store.create({
      title: "A two",
      kind: "json",
      content: '{"a":2}',
      projectId: "proj-a",
    });
    await lib.store.create({ title: "B one", html: "<p>b1</p>", projectId: "proj-b" });
    const a = await lib.library.list({ projectId: "proj-a" });
    assert.equal(a.artifacts.length, 2);
    assert.ok(a.artifacts.every((/** @type {any} */ row) => row.projectId === "proj-a"));
    assert.equal(a.summary.count, 2);
    const b = await lib.library.list({ projectId: "proj-b" });
    assert.equal(b.artifacts.length, 1);
    const empty = await lib.library.list({ projectId: "proj-missing" });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.artifacts, []);
    assert.deepEqual(empty.summary, { count: 0, bytes: 0, byProject: [] });
    const all = await lib.library.list();
    assert.equal(all.artifacts.length, 3);
  } finally {
    await lib.cleanup();
  }
});

test("组合过滤：projectId + kind + title + 时间窗 + limit", async () => {
  const lib = await makeLibrary();
  try {
    const old = await lib.store.create({
      title: "Quarterly Report v1",
      kind: "csv",
      content: "a,b\n1,2\n",
      projectId: "proj-a",
    });
    await wait(6);
    const fresh = await lib.store.create({
      title: "Quarterly Report v2",
      kind: "markdown",
      content: "# q\n",
      projectId: "proj-a",
    });
    await wait(6);
    await lib.store.create({
      title: "Quarterly Report other",
      kind: "markdown",
      content: "# other\n",
      projectId: "proj-b",
    });
    /** @type {any} */
    const combined = await lib.library.list({
      projectId: "proj-a",
      kind: "markdown",
      title: "quarterly",
    });
    assert.deepEqual(
      combined.artifacts.map((/** @type {any} */ row) => row.id),
      [fresh.id],
    );

    const window = await lib.library.list({
      projectId: "proj-a",
      since: fresh.updatedAt,
    });
    assert.deepEqual(
      window.artifacts.map((/** @type {any} */ row) => row.id),
      [fresh.id],
    );

    const until = await lib.library.list({ projectId: "proj-a", until: old.updatedAt });
    assert.deepEqual(
      until.artifacts.map((/** @type {any} */ row) => row.id),
      [old.id],
    );

    const limited = await lib.library.list({ limit: 1 });
    assert.equal(limited.artifacts.length, 1);
    assert.equal(limited.summary.count, 1);
  } finally {
    await lib.cleanup();
  }
});

test("kind 支持数组过滤；未知 kind 报 artifacts/invalid", async () => {
  const lib = await makeLibrary();
  try {
    await lib.store.create({ title: "Page", html: "<p>1</p>" });
    await lib.store.create({ title: "Doc", kind: "markdown", content: "# d" });
    await lib.store.create({ title: "Table", kind: "csv", content: "a\n1\n" });
    const both = await lib.library.list({ kind: ["markdown", "csv"] });
    assert.equal(both.artifacts.length, 2);
    const bad = await lib.library.list({ kind: "xls" });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "artifacts/invalid");
  } finally {
    await lib.cleanup();
  }
});

test("按 sessionId / threadId 过滤，以及 projectId:null 只列无归属", async () => {
  const lib = await makeLibrary();
  try {
    await lib.store.create({
      title: "with session",
      html: "<p>s</p>",
      projectId: "proj-x",
      sessionId: "sess-1",
    });
    await lib.store.create({
      title: "with thread",
      html: "<p>t</p>",
      projectId: "proj-y",
      sessionId: "sess-2",
      threadId: "thread-9",
    });
    await lib.store.create({ title: "no owner", html: "<p>n</p>" });
    const bySession = await lib.library.list({ sessionId: "sess-1" });
    assert.deepEqual(
      bySession.artifacts.map((/** @type {any} */ row) => row.title),
      ["with session"],
    );
    const byThread = await lib.library.list({ threadId: "thread-9" });
    assert.deepEqual(
      byThread.artifacts.map((/** @type {any} */ row) => row.title),
      ["with thread"],
    );
    const orphans = await lib.library.list({ projectId: null });
    assert.deepEqual(
      orphans.artifacts.map((/** @type {any} */ row) => row.title),
      ["no owner"],
    );
  } finally {
    await lib.cleanup();
  }
});

test("汇总口径：bytes 是最新版本之和，totalBytes 含所有历史版本", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({
      title: "Growing",
      html: "<h1>v1</h1>",
      projectId: "proj-a",
    });
    await lib.store.append(meta.id, { html: "<h1>v2!</h1>" });
    const page = await lib.library.list({ projectId: "proj-a" });
    const row = page.artifacts[0];
    assert.equal(row.bytes, Buffer.byteLength("<h1>v2!</h1>"));
    assert.equal(
      row.totalBytes,
      Buffer.byteLength("<h1>v1</h1>") + Buffer.byteLength("<h1>v2!</h1>"),
    );
    assert.equal(page.summary.bytes, row.bytes);
    assert.deepEqual(page.summary.byProject, [{ projectId: "proj-a", count: 1, bytes: row.bytes }]);
  } finally {
    await lib.cleanup();
  }
});

test("多项目汇总：byProject 分开计数与字节", async () => {
  const lib = await makeLibrary();
  try {
    await lib.store.create({ title: "A", html: "<p>aaa</p>", projectId: "proj-a" });
    await lib.store.create({ title: "A2", html: "<p>aa</p>", projectId: "proj-a" });
    await lib.store.create({ title: "B", html: "<p>b</p>", projectId: "proj-b" });
    const page = await lib.library.list();
    const byProject = page.summary.byProject;
    const a = byProject.find((/** @type {any} */ item) => item.projectId === "proj-a");
    const b = byProject.find((/** @type {any} */ item) => item.projectId === "proj-b");
    assert.equal(a.count, 2);
    assert.equal(a.bytes, "<p>aaa</p>".length + "<p>aa</p>".length);
    assert.equal(b.count, 1);
    assert.equal(page.summary.count, 3);
  } finally {
    await lib.cleanup();
  }
});

test("归档：默认隐藏、includeArchived 可见、归档后只读、可取消", async () => {
  const lib = await makeLibrary();
  try {
    const archived = await lib.store.create({
      title: "Frozen",
      html: "<p>f</p>",
      projectId: "proj-a",
    });
    const live = await lib.store.create({ title: "Live", html: "<p>l</p>", projectId: "proj-a" });
    const applied = await lib.library.archive({ projectId: "proj-a", ids: [archived.id] });
    assert.equal(applied.ok, true);
    assert.equal(applied.count, 1);
    assert.equal(applied.archived, true);

    const hidden = await lib.library.list({ projectId: "proj-a" });
    assert.deepEqual(
      hidden.artifacts.map((/** @type {any} */ row) => row.id),
      [live.id],
    );
    const shown = await lib.library.list({ projectId: "proj-a", includeArchived: true });
    assert.equal(shown.artifacts.length, 2);
    const only = await lib.library.list({ projectId: "proj-a", onlyArchived: true });
    assert.deepEqual(
      only.artifacts.map((/** @type {any} */ row) => row.id),
      [archived.id],
    );
    assert.equal(only.artifacts[0].archived, true);
    assert.ok(only.artifacts[0].archivedAt > 0);

    // 只读：归档后不能 append；但预览/最新版本仍可读。
    await assert.rejects(
      () => lib.store.append(archived.id, { html: "<p>nope</p>" }),
      (/** @type {any} */ error) => error.code === "artifacts/archived",
    );
    const preview = await lib.library.latest({ id: archived.id });
    assert.equal(preview.ok, true);
    assert.equal(preview.archived, true);

    await lib.library.archive({ ids: [archived.id], archived: false });
    const writable = await lib.store.append(archived.id, { html: "<p>back</p>" });
    assert.equal(writable.latest, 2);
  } finally {
    await lib.cleanup();
  }
});

test("级联清理（dry-run）：只报影响面，不动文件", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({
      title: "Keep me",
      html: "<p>k</p>",
      projectId: "proj-a",
    });
    const preview = await lib.library.remove({ projectId: "proj-a", dryRun: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.count, 1);
    assert.equal(preview.bytes, "<p>k</p>".length);
    assert.deepEqual(preview.ids, [meta.id]);
    assert.equal(preview.restorable, true);
    assert.deepEqual(preview.removed, []);
    // 文件、回收站、列表都没动。
    assert.equal((await lib.library.list({ projectId: "proj-a" })).artifacts.length, 1);
    assert.deepEqual((await lib.library.trash()).artifacts, []);
  } finally {
    await lib.cleanup();
  }
});

test("级联清理只删本项目：别的项目原样保留", async () => {
  const lib = await makeLibrary();
  try {
    const a1 = await lib.store.create({ title: "A1", html: "<p>a1</p>", projectId: "proj-a" });
    const a2 = await lib.store.create({ title: "A2", html: "<p>a2</p>", projectId: "proj-a" });
    const b1 = await lib.store.create({ title: "B1", html: "<p>b1</p>", projectId: "proj-b" });
    const removed = await lib.library.remove({ projectId: "proj-a" });
    assert.equal(removed.ok, true);
    assert.equal(removed.count, 2);
    assert.deepEqual([...removed.ids].sort(), [a1.id, a2.id].sort());
    assert.equal(removed.unknown.length, 0);

    const remaining = await lib.library.list();
    assert.deepEqual(
      remaining.artifacts.map((/** @type {any} */ row) => row.id),
      [b1.id],
    );
    const trashed = await lib.library.trash();
    assert.deepEqual(
      [...trashed.artifacts.map((/** @type {any} */ row) => row.id)].sort(),
      [a1.id, a2.id].sort(),
    );
    // 字节真的离开了 artifacts 目录（只删本项目）。
    const dirs = await readdir(join(lib.root, "artifacts"));
    assert.deepEqual(dirs, [b1.id]);
  } finally {
    await lib.cleanup();
  }
});

test("恢复与清空回收站：restore 回到列表，purge 之后彻底消失", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({ title: "Round trip", html: "<p>r</p>", projectId: "p" });
    await lib.library.remove({ projectId: "p" });
    const restored = await lib.library.restore({ ids: [meta.id] });
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.restored, [meta.id]);
    assert.equal((await lib.library.list({ projectId: "p" })).artifacts.length, 1);
    assert.deepEqual((await lib.library.trash()).artifacts, []);

    await lib.library.remove({ ids: [meta.id] });
    const trashed = await lib.library.trash();
    assert.equal(trashed.artifacts.length, 1);
    assert.ok(trashed.artifacts[0].trashedAt > 0);

    const purged = await lib.library.purge({ ids: [meta.id] });
    assert.equal(purged.ok, true);
    assert.equal(purged.restorable, false);
    assert.deepEqual(purged.purged, [meta.id]);
    assert.deepEqual((await lib.library.trash()).artifacts, []);
    const again = await lib.library.restore({ ids: [meta.id] });
    assert.deepEqual(again.unknown, [meta.id]);
    assert.equal(again.count, 0);
  } finally {
    await lib.cleanup();
  }
});

test("清理/恢复的参数校验与 unknown 上报", async () => {
  const lib = await makeLibrary();
  try {
    const noTarget = await lib.library.remove({});
    assert.equal(noTarget.ok, false);
    assert.equal(noTarget.code, "artifacts/invalid");
    const noPurgeTarget = await lib.library.purge({});
    assert.equal(noPurgeTarget.ok, false);
    assert.equal(noPurgeTarget.code, "artifacts/invalid");
    const noRestore = await lib.library.restore({});
    assert.equal(noRestore.ok, false);
    assert.equal(noRestore.code, "artifacts/invalid");
    const unknown = await lib.library.remove({ ids: ["ghost-000000"] });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.count, 0);
    assert.deepEqual(unknown.unknown, ["ghost-000000"]);
    const partial = await lib.store.create({ title: "Real", html: "<p>x</p>", projectId: "p" });
    const mixed = await lib.library.remove({ ids: [partial.id, "ghost-000001"] });
    assert.equal(mixed.count, 1);
    assert.deepEqual(mixed.unknown, ["ghost-000001"]);
    // 空项目不是"非法请求"：返回 0 条而不是报错（项目页会拿它做空态）。
    const emptyProject = await lib.library.remove({ projectId: "proj-empty" });
    assert.equal(emptyProject.ok, true);
    assert.equal(emptyProject.count, 0);
    const emptyArchive = await lib.library.archive({ projectId: "proj-empty" });
    assert.equal(emptyArchive.ok, true);
    assert.equal(emptyArchive.count, 0);
  } finally {
    await lib.cleanup();
  }
});

test("多类型：markdown / json / csv 落成对应扩展名，读回文本一致", async () => {
  const lib = await makeLibrary();
  try {
    const cases = [
      { kind: "markdown", content: "# 标题\n\n正文", ext: "md" },
      { kind: "json", content: '{"a":1}', ext: "json" },
      { kind: "csv", content: "a,b\n1,2\n", ext: "csv" },
    ];
    for (const item of cases) {
      const meta = await lib.store.create({
        title: `Kind ${item.kind}`,
        kind: item.kind,
        content: item.content,
      });
      assert.equal(meta.kind, item.kind);
      assert.equal(meta.ext, item.ext);
      const onDisk = await readFile(join(lib.root, "artifacts", meta.id, `v1.${item.ext}`), "utf8");
      assert.equal(onDisk, item.content);
      const found = await lib.store.read(meta.id);
      assert.equal(found?.text, item.content);
      assert.equal(found?.kind, item.kind);
      const page = await lib.library.latest({ id: meta.id });
      assert.equal(page.kind, item.kind);
      assert.equal(page.text, item.content);
    }
    const listed = await lib.library.list();
    assert.deepEqual([...listed.artifacts.map((/** @type {any} */ row) => row.kind)].sort(), [
      "csv",
      "json",
      "markdown",
    ]);
  } finally {
    await lib.cleanup();
  }
});

test("图片：PNG 二进制往返 sha256 一致（不经 UTF-8 转换）", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({ title: "Pixel", kind: "image", data: PNG });
    assert.equal(meta.kind, "image");
    assert.equal(meta.mime, "image/png");
    assert.equal(meta.ext, "png");
    const onDisk = await readFile(join(lib.root, "artifacts", meta.id, "v1.png"));
    assert.equal(onDisk.length, PNG.length);
    assert.equal(sha256(onDisk), sha256(PNG));
    const found = await lib.store.read(meta.id);
    assert.ok(Buffer.isBuffer(found?.data));
    assert.equal(sha256(/** @type {Buffer} */ (found?.data)), sha256(PNG));
    assert.equal(found?.text, "");
    assert.equal(found?.bytes, PNG.length);
  } finally {
    await lib.cleanup();
  }
});

test("图片：超过 2 MiB、空数据、不认识的格式分别被拒绝", async () => {
  const lib = await makeLibrary();
  try {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]);
    await assert.rejects(
      () => lib.store.create({ title: "Huge", kind: "image", data: huge }),
      (/** @type {any} */ error) => error.code === "artifacts/too-large",
    );
    await assert.rejects(
      () =>
        lib.store.create({
          title: "Empty",
          kind: "image",
          data: Buffer.alloc(0),
          mime: "image/png",
        }),
      /empty/u,
    );
    await assert.rejects(
      () =>
        lib.store.create({
          title: "Bmp",
          kind: "image",
          data: Buffer.from("BM random bytes"),
          mime: "image/bmp",
        }),
      (/** @type {any} */ error) => error.code === "artifacts/unsupported-kind",
    );
  } finally {
    await lib.cleanup();
  }
});

test("append 换类型被拒绝（同一 id 只扩展名一致）", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({ title: "Html only", html: "<p>x</p>" });
    await assert.rejects(
      () => lib.store.append(meta.id, { kind: "markdown", content: "# x" }),
      (/** @type {any} */ error) => error.code === "artifacts/kind-mismatch",
    );
    const appended = await lib.store.append(meta.id, { content: "<p>y</p>" });
    assert.equal(appended.latest, 2);
    assert.equal(appended.kind, "html");
  } finally {
    await lib.cleanup();
  }
});

test("来源可追溯：meta 与每个版本都记 sessionId + toolCallId", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({
      title: "Traced",
      html: "<p>v1</p>",
      projectId: "proj-a",
      sessionId: "sess-1",
      threadId: "thread-1",
      source: { sessionId: "sess-1", toolCallId: "call-1", via: "tool" },
    });
    await lib.store.append(meta.id, {
      html: "<p>v2</p>",
      source: { sessionId: "sess-2", toolCallId: "call-2", via: "tool" },
    });
    const raw = JSON.parse(
      await readFile(join(lib.root, "artifacts", meta.id, "meta.json"), "utf8"),
    );
    assert.equal(raw.projectId, "proj-a");
    assert.equal(raw.sessionId, "sess-1");
    assert.equal(raw.threadId, "thread-1");
    assert.deepEqual(raw.source, { sessionId: "sess-1", toolCallId: "call-1", via: "tool" });
    assert.deepEqual(raw.versions[0].source, {
      sessionId: "sess-1",
      toolCallId: "call-1",
      via: "tool",
    });
    assert.deepEqual(raw.versions[1].source, {
      sessionId: "sess-2",
      toolCallId: "call-2",
      via: "tool",
    });
    const page = await lib.library.list({ projectId: "proj-a" });
    assert.deepEqual(page.artifacts[0].source, {
      sessionId: "sess-1",
      toolCallId: "call-1",
      via: "tool",
    });
    // 版本级来源：latest 能反查"这一版是哪次调用产出的"。
    const latest = await lib.library.latest({ id: meta.id });
    assert.deepEqual(latest.versionSource, {
      sessionId: "sess-2",
      toolCallId: "call-2",
      via: "tool",
    });
    // 没有 tmp 残留。
    const files = await readdir(join(lib.root, "artifacts", meta.id));
    assert.equal(
      files.some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await lib.cleanup();
  }
});

test("旧 meta 兼容：缺 kind / ext / 归属字段照样能读，视为 html + 无归属", async () => {
  const lib = await makeLibrary();
  try {
    const legacyId = "legacy-report-abc123";
    const dir = join(lib.root, "artifacts", legacyId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({
        id: legacyId,
        title: "Legacy report",
        latest: 2,
        createdAt: 1000,
        updatedAt: 2000,
        versions: [
          { version: 1, bytes: 11, sha256: "old", at: 1000 },
          { version: 2, bytes: 4, sha256: "new", at: 2000 },
        ],
      }),
      "utf8",
    );
    await writeFile(join(dir, "v2.html"), "<h1>x</h1>", "utf8");

    const meta = await lib.store.readMeta(legacyId);
    assert.equal(meta?.kind, "html");
    assert.equal(meta?.ext, "html");
    assert.equal(meta?.mime, "text/html; charset=utf-8");
    assert.equal(meta?.projectId, undefined);

    const found = await lib.store.read(legacyId);
    assert.equal(found?.version, 2);
    assert.equal(found?.html, "<h1>x</h1>");

    const page = await lib.library.list({ projectId: null });
    const row = page.artifacts.find((/** @type {any} */ item) => item.id === legacyId);
    assert.ok(row, "legacy artifact should be listed");
    assert.equal(row.kind, "html");
    assert.equal(row.projectId, null);
    assert.equal(row.bytes, 4);

    // 旧 artifact 仍可追加版本：写在 v3.html，不迁移旧文件。
    const appended = await lib.store.append(legacyId, { html: "<h1>y</h1>" });
    assert.equal(appended.latest, 3);
    assert.equal(await readFile(join(dir, "v3.html"), "utf8"), "<h1>y</h1>");
  } finally {
    await lib.cleanup();
  }
});

test("publicArtifact 与 summarizeArtifacts 是纯函数（可直接给别的插件复用）", async () => {
  const lib = await makeLibrary();
  try {
    const meta = await lib.store.create({
      title: "Pure",
      kind: "json",
      content: '{"a":1}',
      projectId: "proj-a",
    });
    const row = publicArtifact(meta, "/custom");
    assert.equal(row.previewUrl, `/custom/${meta.id}`);
    assert.equal(row.coverUrl, `/custom/${meta.id}/cover.svg`);
    assert.equal(row.kind, "json");
    assert.equal(latestBytes(meta), '{"a":1}'.length);
    const summary = summarizeArtifacts([meta]);
    assert.deepEqual(summary, {
      count: 1,
      bytes: '{"a":1}'.length,
      byProject: [{ projectId: "proj-a", count: 1, bytes: '{"a":1}'.length }],
    });
  } finally {
    await lib.cleanup();
  }
});

test("路径穿越：id 带 ../ 或分隔符被拒绝，根外文件不受影响", async () => {
  const lib = await makeLibrary();
  try {
    // 造一个"数据根之外"的工件：id ../outside 落在 <root>/outside
    const outside = join(lib.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(outside, "meta.json"),
      JSON.stringify({
        id: "outside",
        title: "SECRET",
        latest: 1,
        createdAt: 1,
        updatedAt: 1,
        versions: [{ version: 1, bytes: 7, sha256: "x", at: 1 }],
      }),
      "utf8",
    );
    await writeFile(join(outside, "v1.html"), "SECRET!");

    for (const id of ["../outside", "..", ".", "a/b", "a\\b", "/etc/passwd", ".hidden"]) {
      await assert.rejects(
        () => lib.store.read(id),
        (/** @type {any} */ error) => error.code === "artifacts/invalid",
        `store.read should reject ${id}`,
      );
      const latest = await lib.library.latest({ id });
      assert.equal(latest.ok, false, `latest should reject ${id}`);
      assert.equal(latest.code, "artifacts/invalid");
    }
    // 破坏性方法也不许顺着 id 跑出去。
    const removed = await lib.library.remove({ ids: ["../outside"] });
    assert.equal(removed.ok, false);
    assert.equal(removed.code, "artifacts/invalid");
    assert.equal(await readFile(join(outside, "v1.html"), "utf8"), "SECRET!");
    assert.equal((await lib.library.trash()).artifacts.length, 0);
  } finally {
    await lib.cleanup();
  }
});

test("破坏性方法：文件系统异常也返回信封（不 reject），并带上已处理的 id", async () => {
  const lib = await makeLibrary();
  try {
    const first = await lib.store.create({ title: "First", html: "<p>1</p>", projectId: "p" });
    await wait(4);
    const second = await lib.store.create({ title: "Second", html: "<p>2</p>", projectId: "p" });

    // 第一条"成功"、第二条抛 ENOSPC：失败信封里必须能看到已经处理过谁。
    // 注意 list 按 updatedAt 倒序，所以"第一条"不一定是创建顺序的第一个——按回调顺序断言。
    let calls = 0;
    /** @type {string[]} */
    const handled = [];
    /** @type {any} */
    const flaky = {
      ...lib.store,
      remove: async (/** @type {string} */ id) => {
        calls += 1;
        if (calls === 2) throw new Error("ENOSPC: no space left on device");
        handled.push(id);
        return true;
      },
    };
    const flib = createArtifactLibrary({ store: flaky });
    const removed = await flib.remove({ projectId: "p" });
    assert.equal(removed.ok, false);
    assert.equal(removed.code, "artifacts/failed");
    assert.match(removed.message, /ENOSPC/u);
    assert.equal(removed.dryRun, false);
    assert.equal(handled.length, 1);
    assert.deepEqual(removed.processed, [handled[0]]);
    assert.deepEqual(removed.ids, [handled[0]]);
    assert.ok([first.id, second.id].includes(handled[0]));

    /** @type {any} */
    const broken = {
      ...lib.store,
      archive: async () => {
        throw new Error("EACCES: permission denied");
      },
      listTrash: async () => {
        throw new Error("EIO: io error");
      },
    };
    const blib = createArtifactLibrary({ store: broken });
    const archived = await blib.archive({ projectId: "p" });
    assert.equal(archived.ok, false);
    assert.equal(archived.code, "artifacts/failed");
    assert.match(archived.message, /EACCES/u);
    assert.deepEqual(archived.processed, []);
    const restored = await blib.restore({ ids: [first.id] });
    assert.equal(restored.ok, false);
    assert.match(restored.message, /EIO/u);
    const trash = await blib.trash();
    assert.equal(trash.ok, false);
    assert.equal((await blib.purge({ ids: [first.id] })).ok, false);
    // 契约层内部异常不会漏成裸 reject（上面每个 assert 都拿到了对象）。
    assert.equal(typeof blib.version, "function");
  } finally {
    await lib.cleanup();
  }
});

test("参数校验：limit<=0、非字符串 projectId、非数组 ids、非布尔 dryRun 都报 invalid", async () => {
  const lib = await makeLibrary();
  try {
    await lib.store.create({ title: "One", html: "<p>1</p>", projectId: "p" });
    for (const limit of [0, -1, 1.5, "10", Number.NaN]) {
      const page = await lib.library.list({ limit });
      assert.equal(page.ok, false, `limit ${String(limit)} should be rejected`);
      assert.equal(page.code, "artifacts/invalid");
    }
    for (const projectId of [123, ["p"], { id: "p" }, true]) {
      const page = await lib.library.list({ projectId });
      assert.equal(page.ok, false, `projectId ${JSON.stringify(projectId)} should be rejected`);
      assert.equal(page.code, "artifacts/invalid");
    }
    assert.equal((await lib.library.list({ projectId: "" })).code, "artifacts/invalid");
    assert.equal((await lib.library.list({ kind: 3 })).code, "artifacts/invalid");
    assert.equal((await lib.library.list({ since: "yesterday" })).code, "artifacts/invalid");

    assert.equal((await lib.library.remove({ ids: "one" })).code, "artifacts/invalid");
    assert.equal((await lib.library.remove({ ids: [1] })).code, "artifacts/invalid");
    assert.equal(
      (await lib.library.remove({ projectId: "p", dryRun: "yes" })).code,
      "artifacts/invalid",
    );
    assert.equal((await lib.library.archive({ projectId: 7 })).code, "artifacts/invalid");
    // 合法参数照常工作。
    const ok = await lib.library.list({ projectId: null, limit: 1 });
    assert.equal(ok.ok, true);
  } finally {
    await lib.cleanup();
  }
});

test("回收站同名 id：目录名（trashKey）是权威键，恢复不了的要进 unknown 而不是静默留字节", async () => {
  const lib = await makeLibrary();
  try {
    const original = await lib.store.create({ title: "Dup", html: "<p>v1</p>", projectId: "p" });
    assert.equal((await lib.library.remove({ ids: [original.id] })).count, 1);
    // 再造一个同 id 的活工件目录（模拟"删掉后同名又出现"），再删一次 → 回收站里两条同名。
    const dir = join(lib.root, "artifacts", original.id);
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({
        id: original.id,
        title: "Dup again",
        kind: "html",
        latest: 1,
        createdAt: now,
        updatedAt: now,
        projectId: "p",
        versions: [{ version: 1, bytes: 3, sha256: "y", at: now }],
      }),
      "utf8",
    );
    await writeFile(join(dir, "v1.html"), "<p>2</p>", "utf8");
    const second = await lib.library.remove({ ids: [original.id] });
    assert.equal(second.ok, true);
    assert.equal(second.count, 1);

    const trash = await lib.library.trash();
    assert.equal(trash.artifacts.length, 2);
    const keys = trash.artifacts.map((/** @type {any} */ row) => row.trashKey);
    assert.equal(new Set(keys).size, 2, "two trashed copies must have distinct trashKey");
    assert.ok(keys.every((/** @type {string} */ key) => key.startsWith(original.id)));
    assert.ok(trash.artifacts.every((/** @type {any} */ row) => row.id === original.id));

    // 按 trashKey 恢复第一条；第二条的目标 id 已被占用 → 进 unknown（不静默丢字节）。
    const one = await lib.library.restore({ ids: [keys[0]] });
    assert.equal(one.ok, true);
    assert.equal(one.count, 1);
    assert.deepEqual(one.restored, [keys[0]]);
    const two = await lib.library.restore({ ids: [keys[1]] });
    assert.equal(two.ok, true);
    assert.equal(two.count, 1);
    assert.deepEqual(two.restored, []);
    assert.deepEqual(two.unknown, [keys[1]]);

    // 剩下的那条仍可 purge（硬删），回收站清空。
    const purged = await lib.library.purge({ ids: [keys[1]] });
    assert.equal(purged.ok, true);
    assert.deepEqual(purged.purged, [keys[1]]);
    assert.deepEqual((await lib.library.trash()).artifacts, []);
  } finally {
    await lib.cleanup();
  }
});

test("点开头的标题（.env audit / .gitignore）能发布，id 不含前导点", async () => {
  const lib = await makeLibrary();
  try {
    for (const title of [".env audit", ".gitignore report", "..hidden notes", "..."]) {
      const meta = await lib.store.create({ title, html: "<p>dot</p>" });
      assert.equal(meta.title, title);
      assert.equal(meta.id.startsWith("."), false, `${title} → unsafe id ${meta.id}`);
      assert.equal(meta.id.includes("/"), false);
      const latest = await lib.library.latest({ id: meta.id });
      assert.equal(latest.ok, true, `${title} should be previewable`);
      assert.equal(latest.html, "<p>dot</p>");
    }
    assert.equal(slugify(".env audit"), "env-audit");
    assert.equal(slugify("..."), "artifact");
  } finally {
    await lib.cleanup();
  }
});
