// @ts-check
// 存储完整性回归（2026-11-28 体检的真实问题）：
//   - AUD-ARTIFACTS-02：同 id 并发 append 不能静默损坏（tmp 唯一 + O_EXCL 抢占版本号 + read 校验）；
//   - AUD-ARTIFACTS-07：create 崩溃留下的 latest=0 残骸不进列表；
//   - AUD-ARTIFACTS-08 的存储侧前提：totalBytes 是所有版本之和（契约层断在 library.test.js）。
// 一律 mkdtemp（仓库硬性约定 7）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createArtifactLibrary } from "../lib/library.js";
import { ArtifactError, createArtifactStore } from "../lib/store.js";

/** @param {Buffer | string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} [prefix] */
async function makeStore(prefix = "dsh-artifacts-integrity-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    store: createArtifactStore({ root }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("AUD-ARTIFACTS-02：同 id 25 路并发 append 全部成功，版本唯一且每版字节/sha 与 meta 一致", async () => {
  const lib = await makeStore();
  try {
    const created = await lib.store.create({ title: "Concurrent", html: "<h1>v1</h1>" });
    const payloads = Array.from(
      { length: 25 },
      (_, index) => `<p>version-${index}-${"x".repeat(80)}</p>`,
    );
    // 25 路并发：修复前固定 `.tmp` 名 + 无锁 `latest+1` 会让其中一路 ENOENT、内容互相覆盖。
    const metas = await Promise.all(payloads.map((html) => lib.store.append(created.id, { html })));
    assert.equal(metas.length, 25, "all 25 concurrent appends must resolve");

    const dir = join(lib.root, "artifacts", created.id);
    const metaOnDisk = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    assert.equal(metaOnDisk.latest, 26);
    assert.deepEqual(
      metaOnDisk.versions.map((/** @type {any} */ item) => item.version),
      Array.from({ length: 26 }, (_, index) => index + 1),
      "version numbers must be unique and contiguous",
    );
    assert.equal(
      new Set(metaOnDisk.versions.map((/** @type {any} */ item) => item.sha256)).size,
      26,
      "every version must keep a distinct sha256",
    );

    // 每个版本文件都必须完整、且与 meta 声明的 bytes/sha256 一致。
    for (const record of metaOnDisk.versions) {
      const bytes = await readFile(join(dir, `v${record.version}.html`));
      assert.equal(bytes.length, record.bytes, `v${record.version} declared bytes`);
      assert.equal(sha256(bytes), record.sha256, `v${record.version} declared sha256`);
    }
    // read() 能读到 1..26 每一版，且内容属于某个真实 payload。
    for (let version = 1; version <= 26; version += 1) {
      const found = await lib.store.read(created.id, version);
      assert.equal(found?.version, version, `v${version} must be readable`);
      if (version > 1) assert.ok(payloads.includes(String(found?.html)), `v${version} content`);
    }
    // 不残留临时文件（固定 `.tmp` 时代的残骸）。
    const files = await readdir(dir);
    assert.equal(
      files.filter((name) => name.endsWith(".tmp")).length,
      0,
      `no tmp leftovers: ${files.join(", ")}`,
    );
  } finally {
    await lib.cleanup();
  }
});

test("AUD-ARTIFACTS-02：已有未登记的 vN 文件（别的写者抢到的版本号）→ 重算版本，不覆盖", async () => {
  const lib = await makeStore();
  try {
    const meta = await lib.store.create({ title: "Claimed", html: "<h1>v1</h1>" });
    const dir = join(lib.root, "artifacts", meta.id);
    // 模拟另一个写者已经用 O_EXCL 抢到 v2、但 meta 还没落盘（崩溃/并发窗口）。
    await writeFile(join(dir, "v2.html"), "<h1>other writer</h1>", "utf8");
    const appended = await lib.store.append(meta.id, {
      html: "<h1>mine</h1>",
      source: { sessionId: "sess-jump", toolCallId: "call-jump", via: "tool" },
    });
    assert.equal(appended.latest, 3, "must skip the claimed v2 instead of overwriting it");
    assert.equal(await readFile(join(dir, "v2.html"), "utf8"), "<h1>other writer</h1>");
    assert.equal(await readFile(join(dir, "v3.html"), "utf8"), "<h1>mine</h1>");
    assert.deepEqual(
      appended.versions.map((item) => item.version),
      [1, 3],
    );
    // F6：跳号后 `latest` 的来源仍按 version 查得到（不能用 versions[latest-1]，那是 v2 的占位）。
    const latest = await createArtifactLibrary({ store: lib.store }).latest({ id: meta.id });
    assert.equal(latest.version, 3);
    assert.deepEqual(latest.versionSource, {
      sessionId: "sess-jump",
      toolCallId: "call-jump",
      via: "tool",
    });
  } finally {
    await lib.cleanup();
  }
});

test("AUD-ARTIFACTS-02：read 校验 sha256/bytes，篡改或缺失的版本报 corrupt 而不是静默返回坏内容", async () => {
  const lib = await makeStore();
  try {
    const meta = await lib.store.create({ title: "Tamper", html: "<h1>v1</h1>" });
    await lib.store.append(meta.id, { html: "<h1>v2</h1>" });
    const dir = join(lib.root, "artifacts", meta.id);

    // 有人改了落盘字节（长度也变了）→ 默认读最新版必须明确报错。
    await writeFile(join(dir, "v2.html"), "<h1>tampered!</h1>", "utf8");
    await assert.rejects(
      () => lib.store.read(meta.id),
      (/** @type {any} */ error) =>
        error instanceof ArtifactError &&
        error.code === "artifacts/failed" &&
        error.reason === "corrupt-version",
      "tampered bytes must surface as corrupt-version",
    );

    // 旧版本没被动过：仍能读。
    const first = await lib.store.read(meta.id, 1);
    assert.equal(first?.html, "<h1>v1</h1>");

    // 契约层同样是失败信封（面板/工具不会把坏内容当最新版展示）。
    const latest = await createArtifactLibrary({ store: lib.store }).latest({ id: meta.id });
    assert.equal(latest.ok, false);
    assert.equal(latest.code, "artifacts/failed");
    assert.equal(latest.reason, "corrupt-version");

    // meta 声明了某版但文件消失，也算损坏（不是 404：meta 与磁盘不一致）。
    await rm(join(dir, "v1.html"));
    await assert.rejects(
      () => lib.store.read(meta.id, 1),
      (/** @type {any} */ error) => error.reason === "corrupt-version",
    );
  } finally {
    await lib.cleanup();
  }
});

test("AUD-ARTIFACTS-07：latest=0 且没有版本的残骸目录不进列表，并留下告警", async () => {
  const lib = await makeStore();
  const warnings = /** @type {string[]} */ ([]);
  const originalWarn = console.warn;
  console.warn = (/** @type {any[]} */ ...args) => {
    warnings.push(args.map((item) => String(item)).join(" "));
  };
  try {
    const phantom = "phantom-crash-abc123";
    await mkdir(join(lib.root, "artifacts", phantom), { recursive: true });
    await writeFile(
      join(lib.root, "artifacts", phantom, "meta.json"),
      JSON.stringify({
        id: phantom,
        title: "Crash remains",
        kind: "html",
        latest: 0,
        createdAt: 1,
        updatedAt: 1,
        versions: [],
      }),
      "utf8",
    );

    const rows = await lib.store.list();
    assert.deepEqual(rows, [], "a latest=0 artifact with no versions must not be listed");
    assert.ok(
      warnings.some((line) => line.includes(phantom)),
      `scan should warn about the phantom entry: ${warnings.join(" | ")}`,
    );
    assert.equal(await lib.store.read(phantom), undefined);
    const page = await createArtifactLibrary({ store: lib.store }).list();
    assert.deepEqual(page.artifacts, []);

    // 正常工件不受影响，且列表里只有它。
    const real = await lib.store.create({ title: "Real", html: "<h1>ok</h1>" });
    assert.deepEqual(
      (await lib.store.list()).map((item) => item.id),
      [real.id],
    );
  } finally {
    console.warn = originalWarn;
    await lib.cleanup();
  }
});

test("F7：同一 trashKey 的 restore / purge 并发被同一把锁串行（不双成功、不 ENOENT）", async () => {
  const lib = await makeStore();
  try {
    const meta = await lib.store.create({ title: "Trash race", html: "<p>race</p>" });
    assert.equal(await lib.store.remove(meta.id), true);
    const trash = await lib.store.listTrash();
    assert.equal(trash.length, 1);
    const key = trash[0].trashKey;
    // 并发「恢复 + 清空」同一个回收站条目：结果必须是二者之一，不能都成功/都失败。
    const [restored, purged] = await Promise.all([lib.store.restore(key), lib.store.purge(key)]);
    assert.equal(Number(restored) + Number(purged), 1, "exactly one of restore/purge wins");
    const live = (await lib.store.list()).length;
    const remain = (await lib.store.listTrash()).length;
    assert.equal(live + remain, 1, "the artifact ends up either live or purged, never both");
  } finally {
    await lib.cleanup();
  }
});
