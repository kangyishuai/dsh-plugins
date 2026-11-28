// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beginOperation,
  finishOperation,
  listPending,
  listUnreadable,
  readOperation,
  updateOperation,
} from "../lib/journal.js";

test("intent → done：成功后记录被删除", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-journal-"));
  const record = await beginOperation({
    dataRoot: root,
    action: "trash",
    extra: { sessionId: "s1" },
  });
  assert.equal(record.state, "intent");
  assert.ok(await readOperation(root, record.id));
  await finishOperation({ dataRoot: root, id: record.id, state: "done" });
  assert.equal(await readOperation(root, record.id), null);
  assert.deepEqual(await listPending(root), []);
  await rm(root, { recursive: true, force: true });
});

test("失败保留现场，列出 pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-journal-"));
  const record = await beginOperation({
    dataRoot: root,
    action: "restore",
    extra: { entryId: "e1" },
  });
  await updateOperation(root, record.id, { digest: "abc" });
  await finishOperation({ dataRoot: root, id: record.id, state: "failed", detail: "boom" });
  const pending = await listPending(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, "failed");
  assert.equal(pending[0].detail, "boom");
  const raw = await readFile(join(root, "session-trash", "journal", `${record.id}.json`), "utf8");
  assert.match(raw, /"digest": "abc"/);
  await rm(root, { recursive: true, force: true });
});

test("损坏记录不会让 listPending 抛错", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-journal-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "session-trash", "journal"), { recursive: true });
  await writeFile(join(root, "session-trash", "journal", "bad.json"), "{not json");
  assert.deepEqual(await listPending(root), []);
  await rm(root, { recursive: true, force: true });
});

test("体检可见：损坏的记录与 .tmp 残留都会被列出（只报告，不删）", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-journal-"));
  // 一条正常 pending（必须仍能被 listPending 读到）
  const record = await beginOperation({ dataRoot: root, action: "trash" });
  await finishOperation({ dataRoot: root, id: record.id, state: "failed", detail: "boom" });
  const journal = join(root, "session-trash", "journal");
  // 坏 JSON（截断）与 not-an-object（合法 JSON、形状不对）
  await writeFile(join(journal, "truncated.json"), '{"id":"trunc', "utf8");
  await writeFile(join(journal, "not-record.json"), "42", "utf8");
  // writeAtomic 在 rename 前崩溃会留下 `<id>.json.tmp`
  await writeFile(join(journal, "crashed.json.tmp"), "{}", "utf8");
  // 不认识的文件名不是 journal 记录，不该被当成损坏
  await writeFile(join(journal, "notes.txt"), "x", "utf8");

  const unreadable = await listUnreadable(root);
  const names = unreadable.map((item) => item.name).sort();
  assert.deepEqual(names, ["crashed.json.tmp", "not-record.json", "truncated.json"]);
  const reasons = Object.fromEntries(unreadable.map((item) => [item.name, item.reason]));
  assert.equal(reasons["crashed.json.tmp"], "temp");
  assert.equal(reasons["truncated.json"], "corrupt");
  assert.equal(reasons["not-record.json"], "corrupt");

  // 只报告：坏文件不会被删，正常 pending 也不受影响。
  assert.equal((await listPending(root)).length, 1);
  assert.ok(existsSync(join(journal, "truncated.json")));
  assert.ok(existsSync(join(journal, "crashed.json.tmp")));
  await rm(root, { recursive: true, force: true });
});

test("体检可见：journal 目录不存在时没有损坏项", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-journal-"));
  assert.deepEqual(await listUnreadable(root), []);
  await rm(root, { recursive: true, force: true });
});
