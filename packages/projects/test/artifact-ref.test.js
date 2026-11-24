// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactRefFromToolResult,
  bytesOf,
  parseArtifactRenderText,
} from "../lib/artifact-ref.js";

test("artifact ref：JSON 成功结果被解析成引用（含来源）", () => {
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

test("artifact ref：真机渲染文本（不是 JSON）也能解析", () => {
  const text = [
    "artifact 走查产物-c654b0 · 走查产物 · v1 · 14 B · html",
    "url: http://127.0.0.1:57655/artifacts/%E8%B5%B0%E6%9F%A5%E4%BA%A7%E7%89%A9-c654b0",
    "The preview panel shows the latest version; older rows stay linked to it.",
  ].join("\n");
  const ref = artifactRefFromToolResult(text, {
    sessionId: "s2",
    toolCallId: "c2",
    at: "2026-11-24T03:00:00.000Z",
  });
  assert.equal(ref?.id, "走查产物-c654b0");
  assert.equal(ref?.title, "走查产物");
  assert.equal(ref?.kind, "html");
  assert.equal(ref?.version, 1);
  assert.equal(ref?.bytes, 14);
  assert.deepEqual(ref?.source, { sessionId: "s2", toolCallId: "c2" });
});

test("artifact ref：标题里含「·」时仍能切对 id/kind；KB 体积换算正确", () => {
  const shape = parseArtifactRenderText("artifact abc · 报告 · 第二版 · v3 · 2.5 KB · markdown");
  assert.equal(shape?.id, "abc");
  assert.equal(shape?.title, "报告 · 第二版");
  assert.equal(shape?.kind, "markdown");
  assert.equal(shape?.bytes, 2560);
});

test("artifact ref：非 JSON / ok=false / 认不出的文本一律 null（不制造假引用）", () => {
  assert.equal(artifactRefFromToolResult("not json", {}), null);
  assert.equal(artifactRefFromToolResult(JSON.stringify({ ok: false, id: "x" }), {}), null);
  assert.equal(artifactRefFromToolResult(JSON.stringify({ ok: true, title: "no id" }), {}), null);
  assert.equal(artifactRefFromToolResult("failed: artifacts/invalid", {}), null);
  assert.equal(artifactRefFromToolResult("", {}), null);
  assert.equal(artifactRefFromToolResult(undefined, {}), null);
});

test("bytesOf：B/KB/MB/GB 与非法输入", () => {
  assert.equal(bytesOf("14 B"), 14);
  assert.equal(bytesOf("2 KB"), 2048);
  assert.equal(bytesOf("1.5 MB"), 1572864);
  assert.equal(bytesOf("1 GB"), 1073741824);
  assert.equal(bytesOf("n/a"), null);
  assert.equal(bytesOf(""), null);
});
