// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAudit } from "../lib/audit.js";

test("并发追加不产生交错的半行，read 按时间顺序返回", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-audit-"));
  const audit = createAudit(root);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      audit.append({ action: "trash", result: "ok", sessionId: "s" + i, operator: "ui" }),
    ),
  );
  const entries = await audit.read(100);
  assert.equal(entries.length, 20);
  for (const entry of entries) {
    assert.ok(typeof entry.ts === "string");
    assert.ok(typeof entry.sessionId === "string");
  }
  const tail = await audit.read(5);
  assert.equal(tail.length, 5);
  assert.equal(tail[4].sessionId, "s19");
  await rm(root, { recursive: true, force: true });
});

test("超长 detail 会被截断，保证单行写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-audit-"));
  const audit = createAudit(root);
  await audit.append({
    action: "trash",
    result: "failed",
    sessionId: "s1",
    detail: "x".repeat(5000),
  });
  const entries = await audit.read(10);
  assert.equal(entries.length, 1);
  assert.ok((entries[0]?.detail ?? "").length <= 200);
  await rm(root, { recursive: true, force: true });
});
