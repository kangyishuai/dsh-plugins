// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beginOperation,
  finishOperation,
  listPending,
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
