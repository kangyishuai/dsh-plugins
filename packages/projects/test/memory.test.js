// @ts-check
// 项目记忆写入单测：规范化、去重（幂等）、上限拒绝、时间戳注释。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendEntry,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_MAX_CHARS,
  normalizeEntry,
} from "../lib/memory.js";

describe("normalizeEntry", () => {
  it("压掉多余空行、去首尾空白", () => {
    assert.equal(normalizeEntry("  a\n\n\n\nb  "), "a\n\nb");
    assert.equal(normalizeEntry("\r\nx\r\n"), "x");
  });

  it("空内容返回空串", () => {
    assert.equal(normalizeEntry(""), "");
    assert.equal(normalizeEntry("   \n\n "), "");
    assert.equal(normalizeEntry(undefined), "");
  });

  it("单条超长被截断并标注", () => {
    const long = "x".repeat(MEMORY_ENTRY_MAX_CHARS + 50);
    const normalized = normalizeEntry(long);
    assert.ok(normalized.includes("已截断"));
    assert.ok(normalized.length <= MEMORY_ENTRY_MAX_CHARS + 20);
  });
});

describe("appendEntry", () => {
  it("空索引 → 追加第一条", () => {
    const result = appendEntry("", "commit messages use conventional commits");
    assert.equal(result.ok, true);
    assert.equal(result.added, true);
    assert.match(result.text, /commit messages use conventional commits/u);
  });

  it("幂等：同一条不重复追加", () => {
    const first = appendEntry("", "rule A");
    const second = appendEntry(first.text, "rule A");
    assert.equal(second.ok, true);
    assert.equal(second.added, false);
    assert.equal(second.reason, "duplicate");
    assert.equal(second.text, first.text.trimEnd());
  });

  it("多条按顺序追加，用空行分隔", () => {
    let text = "";
    for (const entry of ["a", "b", "c"]) text = appendEntry(text, entry).text;
    assert.match(text, /a\n\nb\n\nc/u);
  });

  it("超过上限 → 拒绝且不改内容", () => {
    const existing = "x".repeat(MEMORY_MAX_CHARS - 2); // 再加分隔行与条目必然超限
    const result = appendEntry(existing, "new rule");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "memory-full");
    assert.equal(result.text, existing.trimEnd());
  });

  it("空条目被拒", () => {
    assert.equal(appendEntry("x", "   ").reason, "empty-entry");
    assert.equal(appendEntry("x", "").reason, "empty-entry");
  });

  it("带时间戳时写成可读注释", () => {
    const result = appendEntry("", "learned: tests need env", { at: "2026-11-17T00:20:00Z" });
    assert.match(result.text, /<!-- 2026-11-17T00:20:00Z -->/u);
  });
});
