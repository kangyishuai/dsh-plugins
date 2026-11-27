// @ts-check
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { encodeSegment, projectKey } from "../lib/paths.js";
import {
  entryDataDir,
  entryDir,
  listEntries,
  moveDirectory,
  moveIntoTrash,
  purgeEntry,
  readEntry,
  restoreEntry,
  verifyDirectoryCopy,
} from "../lib/trash.js";

/** @returns {Promise<{ root: string, sessionDir: string, sessionId: string }>} */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sdel-"));
  const sessionId = "session-abc";
  const sessionDir = join(root, "sessions", projectKey("/w"), encodeSegment(sessionId));
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "x".repeat(2048));
  await writeFile(join(sessionDir, "session.lock"), "");
  return { root, sessionDir, sessionId };
}

test("移入回收站后原目录消失、meta 可读、可列出", async () => {
  const { root, sessionDir, sessionId } = await fixture();
  const moved = await moveIntoTrash({
    dataRoot: root,
    sessionId,
    sourceDir: sessionDir,
    meta: {
      title: "hello",
      cwd: "/w",
      bytes: 2048,
      live: false,
      children: [],
      workspaceIds: ["ws1"],
    },
  });
  await assert.rejects(stat(sessionDir));
  const meta = await readEntry(root, moved.entryId);
  assert.equal(meta.sessionId, sessionId);
  assert.equal(meta.title, "hello");
  assert.deepEqual(meta.workspaceIds, ["ws1"]);
  const listed = await listEntries(root);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].entryId, moved.entryId);
  assert.deepEqual(listed.unknown, []);
  await rm(root, { recursive: true, force: true });
});

test("恢复把目录移回原路径，并清理回收站条目", async () => {
  const { root, sessionDir, sessionId } = await fixture();
  const moved = await moveIntoTrash({
    dataRoot: root,
    sessionId,
    sourceDir: sessionDir,
    meta: { title: null, cwd: "/w", bytes: 2048, live: false, children: [], workspaceIds: [] },
  });
  const restored = await restoreEntry({ dataRoot: root, entryId: moved.entryId });
  assert.equal(restored.restoredTo, sessionDir);
  assert.ok((await stat(join(sessionDir, "session.v4.jsonl.zstd"))).isFile());
  await assert.rejects(stat(entryDir(root, moved.entryId)));
  const listed = await listEntries(root);
  assert.equal(listed.entries.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("恢复冲突时不覆盖已存在的目录", async () => {
  const { root, sessionDir, sessionId } = await fixture();
  const moved = await moveIntoTrash({
    dataRoot: root,
    sessionId,
    sourceDir: sessionDir,
    meta: { title: null, cwd: "/w", bytes: 1, live: false, children: [], workspaceIds: [] },
  });
  await mkdir(sessionDir, { recursive: true });
  await assert.rejects(restoreEntry({ dataRoot: root, entryId: moved.entryId }), /already exists/);
  await rm(root, { recursive: true, force: true });
});

test("彻底删除只删本插件创建的条目", async () => {
  const { root, sessionDir, sessionId } = await fixture();
  const moved = await moveIntoTrash({
    dataRoot: root,
    sessionId,
    sourceDir: sessionDir,
    meta: { title: null, cwd: "/w", bytes: 1, live: false, children: [], workspaceIds: [] },
  });
  const result = await purgeEntry({ dataRoot: root, entryId: moved.entryId });
  assert.equal(result.bytes, 1);
  await assert.rejects(stat(entryDataDir(root, moved.entryId)));

  // 陌生目录：没有 meta.json 时不删、不列，只报告
  await mkdir(join(root, "session-trash", "someone-elses"), { recursive: true });
  const listed = await listEntries(root);
  assert.deepEqual(listed.unknown, ["someone-elses"]);
  await assert.rejects(purgeEntry({ dataRoot: root, entryId: "someone-elses" }));
  await rm(root, { recursive: true, force: true });
});

test("meta.json 写在条目目录里且带插件标记", async () => {
  const { root, sessionDir, sessionId } = await fixture();
  const moved = await moveIntoTrash({
    dataRoot: root,
    sessionId,
    sourceDir: sessionDir,
    meta: { title: "t", cwd: "/w", bytes: 1, live: false, children: [], workspaceIds: [] },
  });
  const raw = JSON.parse(await readFile(join(entryDir(root, moved.entryId), "meta.json"), "utf8"));
  assert.equal(raw.plugin, "@kangyishuai/dsh-session-delete");
  assert.equal(raw.schema, 1);
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AUD-SD-05：跨卷回退的「cp → 校验 → 删源」必须真的校验内容。
// 本机构造不了 EXDEV，所以把 rename/cp 注入成假的：rename 一律报 EXDEV，
// cp 可以被替换成「拷一半」。断言的重点是**源永远不被删**。
// ---------------------------------------------------------------------------
/** @returns {Promise<string>} */
async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sdel-exdev-"));
  const source = join(root, "source");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "a.txt"), "0123456789");
  await writeFile(join(source, "nested", "b.bin"), "x".repeat(20));
  return source;
}

const exdev = async () => {
  throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
};

test("跨卷校验：完整副本通过（条目、大小、总字节都一致）", async () => {
  const source = await makeTree();
  const target = `${source}-copy`;
  await cp(source, target, { recursive: true });
  const verified = await verifyDirectoryCopy(source, target);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.sourceFiles, 2);
  assert.equal(verified.targetFiles, 2);
  assert.equal(verified.sourceBytes, 30);
  assert.equal(verified.targetBytes, 30);
  await rm(dirname(source), { recursive: true, force: true });
});

test("跨卷校验：缺条目 / 大小不符 / 多出条目都会失败并指出是哪一个", async () => {
  const source = await makeTree();
  const root = dirname(source);

  const missingTarget = join(root, "missing-target");
  await cp(source, missingTarget, { recursive: true });
  await rm(join(missingTarget, "nested"), { recursive: true });
  const missing = await verifyDirectoryCopy(source, missingTarget);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["nested/b.bin"]);
  assert.ok(missing.sourceFiles > missing.targetFiles);

  const sizedTarget = join(root, "sized-target");
  await cp(source, sizedTarget, { recursive: true });
  await writeFile(join(sizedTarget, "a.txt"), "0123456789EXTRA");
  const differing = await verifyDirectoryCopy(source, sizedTarget);
  assert.equal(differing.ok, false);
  assert.deepEqual(differing.differing, ["a.txt"]);

  const extraTarget = join(root, "extra-target");
  await cp(source, extraTarget, { recursive: true });
  await writeFile(join(extraTarget, "ghost.txt"), "ghost");
  const extra = await verifyDirectoryCopy(source, extraTarget);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ["ghost.txt"]);

  await rm(root, { recursive: true, force: true });
});

test("跨卷回退：副本不完整时拒绝删源，并清掉不完整的目标", async () => {
  const source = await makeTree();
  const root = dirname(source);
  const target = join(root, "partial-target");
  /** 只拷一半的 cp：这是「cp 返回成功但内容不完整」的模拟。 */
  const halfCopy = async (/** @type {string} */ from, /** @type {string} */ to) => {
    void from;
    await mkdir(to, { recursive: true });
    await writeFile(join(to, "a.txt"), "0123456789");
  };
  await assert.rejects(
    moveDirectory(source, target, { renameImpl: exdev, cpImpl: halfCopy }),
    (error) => /** @type {any} */ (error).code === "session-delete/copy-verify-failed",
  );
  // 数据安全的核心断言：源必须原封不动，目标副本被清掉（不留下半份「回收站副本」）。
  assert.ok((await stat(join(source, "a.txt"))).isFile());
  assert.ok((await stat(join(source, "nested", "b.bin"))).isFile());
  await assert.rejects(stat(target));
  await rm(root, { recursive: true, force: true });
});

test("跨卷回退：副本完整时才删源并完成移动", async () => {
  const source = await makeTree();
  const root = dirname(source);
  const target = join(root, "moved");
  await moveDirectory(source, target, { renameImpl: exdev });
  await assert.rejects(stat(source), "源应当被删掉");
  assert.ok((await stat(join(target, "a.txt"))).isFile());
  assert.ok((await stat(join(target, "nested", "b.bin"))).isFile());
  await rm(root, { recursive: true, force: true });
});
