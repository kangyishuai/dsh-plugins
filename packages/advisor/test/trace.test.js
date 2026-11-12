// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTracePreview, TRACE_PREVIEW_EDGE } from "../lib/trace.js";

test("短文本原样返回，不标记截断", () => {
  const out = buildTracePreview("hello", 2000);
  assert.equal(out.preview, "hello");
  assert.equal(out.chars, 5);
  assert.equal(out.truncated, false);
});

test("等于 2 * edge 仍原样返回（边界）", () => {
  const text = "x".repeat(4000);
  const out = buildTracePreview(text, 2000);
  assert.equal(out.preview, text);
  assert.equal(out.chars, 4000);
  assert.equal(out.truncated, false);
});

test("超过 2 * edge 保留首尾各 edge 字符，中间用省略标记", () => {
  const text = `${"H".repeat(2000)}${"M".repeat(1000)}${"T".repeat(2000)}`;
  const out = buildTracePreview(text, 2000);
  assert.equal(out.chars, 5000);
  assert.equal(out.truncated, true);
  assert.equal(out.preview, `${"H".repeat(2000)}\n\n…\n\n${"T".repeat(2000)}`);
});

test("默认 edge 是 2,000", () => {
  assert.equal(TRACE_PREVIEW_EDGE, 2000);
  const text = "a".repeat(TRACE_PREVIEW_EDGE * 2 + 1);
  const out = buildTracePreview(text);
  assert.equal(out.truncated, true);
  assert.equal(out.preview.includes("\n\n…\n\n"), true);
});

test("非字符串/空值不抛错", () => {
  assert.deepEqual(buildTracePreview(null), { preview: "", chars: 0, truncated: false });
  assert.deepEqual(buildTracePreview(123), {
    preview: "123",
    chars: 3,
    truncated: false,
  });
});
