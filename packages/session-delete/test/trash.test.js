// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeSegment, projectKey } from "../lib/paths.js";
import {
  entryDataDir,
  entryDir,
  listEntries,
  moveIntoTrash,
  purgeEntry,
  readEntry,
  restoreEntry,
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
