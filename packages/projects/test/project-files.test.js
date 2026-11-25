// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { INSTRUCTION_CHAR_LIMIT, listMemoryFiles, readProjectFiles } from "../lib/project-files.js";

describe("Memory 两层（M5）", () => {
  it("缺文件时 stat 为 null（没有 ≠ 空文件），limits 有默认值", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-proj-files-"));
    try {
      const files = readProjectFiles(root, "p1");
      assert.equal(files.instructions, "");
      assert.equal(files.memoryIndex, "");
      assert.equal(files.instructionsStat, null);
      assert.equal(files.memoryStat, null);
      assert.equal(INSTRUCTION_CHAR_LIMIT, 16_000);
      assert.deepEqual(listMemoryFiles(root, "p1"), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("有文件时给出 bytes/updatedAt；Memory files 列表按名字排序", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-proj-files-"));
    try {
      const dir = join(root, "p1");
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(dir, "instructions.md"), "# 规则\n- 用中文回答\n");
      writeFileSync(join(memoryDir, "MEMORY.md"), "# 索引\n- 甲\n- 乙\n");
      writeFileSync(join(memoryDir, "b-notes.md"), "乙");
      writeFileSync(join(memoryDir, "a-notes.md"), "甲");
      const past = new Date("2026-01-01T00:00:00.000Z");
      utimesSync(join(memoryDir, "a-notes.md"), past, past);
      const files = readProjectFiles(root, "p1");
      assert.ok(files.instructionsStat && files.instructionsStat.bytes > 0);
      assert.ok(files.instructionsStat.updatedAt.length > 10);
      assert.ok(files.memoryStat && files.memoryStat.bytes > 0);
      const listed = listMemoryFiles(root, "p1");
      assert.deepEqual(
        listed.map((item) => item.name),
        ["MEMORY.md", "a-notes.md", "b-notes.md"],
      );
      assert.equal(listed[1].updatedAt.startsWith("2026-01-01"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
