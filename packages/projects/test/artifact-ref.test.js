// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactRefFromToolResult } from "../lib/artifact-ref.js";

test("artifact ref：publish 成功结果被解析成引用（含来源）", () => {
  const ref = artifactRefFromToolResult(
    JSON.stringify({
      ok: true,
      action: "publish",
      id: "abc123",
      title: "Q4 计划",
      kind: "html",
      version: 2,
      bytes: 42,
    }),
    { sessionId: "s1", toolCallId: "c1", at: "2026-11-24T00:00:00.000Z" },
  );
  assert.deepEqual(ref, {
    id: "abc123",
    title: "Q4 计划",
    kind: "html",
    version: 2,
    bytes: 42,
    at: "2026-11-24T00:00:00.000Z",
    source: { sessionId: "s1", toolCallId: "c1" },
  });
});

test("artifact ref：非 JSON / ok=false / 缺 id 一律返回 null（不制造假引用）", () => {
  assert.equal(artifactRefFromToolResult("not json", {}), null);
  assert.equal(artifactRefFromToolResult(JSON.stringify({ ok: false, id: "x" }), {}), null);
  assert.equal(artifactRefFromToolResult(JSON.stringify({ ok: true, title: "no id" }), {}), null);
  assert.equal(artifactRefFromToolResult("", {}), null);
  assert.equal(artifactRefFromToolResult(undefined, {}), null);
});
