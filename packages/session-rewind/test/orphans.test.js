// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findOrphans, pruneOrphans } from "../lib/orphans.js";

/** @param {string} root @param {string[]} parts */
async function touch(root, parts) {
  const file = join(root, ...parts);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "x");
  return file;
}

test("findOrphans 只把已不存在的会话算作孤儿", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", "ws-a", "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    await touch(plugin, ["trash", "session-dead", "op", "files", "a.txt"]);
    await touch(plugin, ["rescues", "session-dead", "r1", "manifest.json"]);
    await touch(plugin, ["blobs", "aa", "hash"]);
    const report = await findOrphans({ dataRoot });
    assert.deepEqual(report.sessionIds, ["session-dead"]);
    assert.deepEqual(report.trashIds, ["session-dead"]);
    assert.deepEqual(report.rescueIds, ["session-dead"]);
    assert.ok(report.bytes > 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans 删除孤儿但保留存活会话与 audit", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", "ws-a", "session-alive"), { recursive: true });
    await mkdir(join(dataRoot, "sessions", "ws-b", "session-other"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    await touch(plugin, ["trash", "session-dead", "op", "files", "a.txt"]);
    await touch(plugin, ["rescues", "session-dead", "r1", "manifest.json"]);
    await writeFile(join(plugin, "audit.jsonl"), '{"id":"old"}\n');
    const result = await pruneOrphans({ dataRoot });
    assert.deepEqual(result.removed.sessions, ["session-dead"]);
    assert.deepEqual(result.removed.trash, ["session-dead"]);
    assert.deepEqual(result.removed.rescues, ["session-dead"]);
    assert.equal(result.failed.length, 0);
    await assert.rejects(readFile(join(plugin, "sessions", "session-dead", "entries.jsonl")));
    await readFile(join(plugin, "sessions", "session-alive", "entries.jsonl"));
    assert.equal(await readFile(join(plugin, "audit.jsonl"), "utf8"), '{"id":"old"}\n');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans dryRun 只报告不删除", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    const result = await pruneOrphans({ dataRoot, dryRun: true });
    assert.deepEqual(result.report.sessionIds, ["session-dead"]);
    assert.deepEqual(result.removed.sessions, []);
    await readFile(join(plugin, "sessions", "session-dead", "entries.jsonl"));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
