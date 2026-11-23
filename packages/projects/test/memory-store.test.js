// @ts-check
// F37/F3：记忆碎片的**真实落盘**测试（根目录注入到 mkdtemp，不碰真实 home）。
// 覆盖：新增 → 索引/文件 → 列表（生产读路径）→ 忘掉（删文件 + 改写索引）。
// 以及 forget 的路径守卫：`../`、`..%2F`、绝对路径、反斜杠、未知 kind、非法块 id。

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { stableBlockId } from "../lib/memory.js";
import {
  addFragment,
  forgetMemoryItem,
  listFragmentFiles,
  listFragments,
  memoryIndexPath,
  readFragment,
} from "../lib/memory-store.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-memstore-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("F37 碎片落盘：新增 / 列表 / 预览 / 忘掉", () => {
  it("新增写文件 + 索引行，列表读回标题与预览", () => {
    const added = addFragment(root, "p1", "缓存层", "缓存层在 src/cache.ts\n第二行");
    assert.equal(added.ok, true);
    assert.equal(added.slug, "缓存层");
    assert.ok(existsSync(join(root, "p1", "memory", "fragments", "缓存层.md")));
    const index = readFileSync(memoryIndexPath(root, "p1"), "utf8");
    assert.match(index, /^- \[缓存层\]\(fragments\/缓存层\.md\) — 缓存层在 src\/cache\.ts$/mu);
    const listed = listFragments(root, "p1");
    assert.equal(listed.fragments.length, 1);
    assert.equal(listed.fragments[0].title, "缓存层");
    assert.match(listed.fragments[0].preview, /src\/cache\.ts/u);
    assert.equal(listed.totalChars, "缓存层在 src/cache.ts\n第二行\n".length);
  });

  it("同标题自动 slug 去重，第二条不会覆盖第一条", () => {
    assert.equal(addFragment(root, "p1", "Cache", "第一条").ok, true);
    const second = addFragment(root, "p1", "Cache", "第二条");
    assert.equal(second.ok, true);
    assert.equal(second.slug, "cache-2");
    assert.equal(listFragments(root, "p1").fragments.length, 2);
  });

  it("忘掉碎片：删文件 + 索引行；其它条目原样保留", () => {
    addFragment(root, "p1", "A", "甲");
    addFragment(root, "p1", "B", "乙");
    const forgotten = forgetMemoryItem(root, "p1", "fragment", "a");
    assert.equal(forgotten.ok, true);
    assert.equal(existsSync(join(root, "p1", "memory", "fragments", "a.md")), false);
    const index = readFileSync(memoryIndexPath(root, "p1"), "utf8");
    assert.doesNotMatch(index, /fragments\/a\.md/u);
    assert.match(index, /fragments\/b\.md/u);
  });

  it("忘掉普通索引条目：按稳定块 id 删一行，碎片文件不受影响", () => {
    addFragment(root, "p1", "A", "甲");
    const indexFile = memoryIndexPath(root, "p1");
    writeFileSync(indexFile, `${readFileSync(indexFile, "utf8")}\n- 普通记忆第一条\n`, "utf8");
    assert.equal(listFragments(root, "p1").fragments.length, 1);
    const id = stableBlockId("- 普通记忆第一条");
    const removed = forgetMemoryItem(root, "p1", "entry", id);
    assert.equal(removed.ok, true);
    const after = readFileSync(indexFile, "utf8");
    assert.doesNotMatch(after, /普通记忆第一条/u);
    assert.match(after, /fragments\/a\.md/u);
    assert.equal(listFragments(root, "p1").fragments.length, 1);
    assert.equal(existsSync(join(root, "p1", "memory", "fragments", "a.md")), true);
    const invalidId = forgetMemoryItem(root, "p1", "entry", "not-an-id");
    assert.equal(invalidId.ok, false);
    if (!invalidId.ok) assert.equal(invalidId.reason, "forget/invalid-id");
    const missingId = forgetMemoryItem(root, "p1", "entry", "deadbeef");
    assert.equal(missingId.ok, false);
    if (!missingId.ok) assert.equal(missingId.reason, "forget/not-found");
  });

  it("未知 kind 直接拒绝（不会静默当成 entry）", () => {
    const result = forgetMemoryItem(root, "p1", "everything", "a");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "forget/unknown-kind");
  });
});

describe("F37 forget 路径守卫（路径穿越必须拒绝）", () => {
  it("`../`、`..%2F`、绝对路径、反斜杠、空值都被拒，且不会写出目录外文件", () => {
    const fragmentsDir = join(root, "p1", "memory", "fragments");
    mkdirSync(fragmentsDir, { recursive: true });
    const outside = join(root, "p1", "memory", "MEMORY.md");
    writeFileSync(outside, "- [逃逸](../MEMORY.md) — x\n", "utf8");
    const attempts = [
      "../MEMORY",
      "..%2FMEMORY",
      "/etc/passwd",
      "..\\MEMORY",
      "a/../../b",
      "",
      "..",
    ];
    for (const attempt of attempts) {
      const result = forgetMemoryItem(root, "p1", "fragment", attempt);
      assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(attempt)}`);
      if (!result.ok) {
        assert.ok(
          result.reason === "fragment/invalid-slug" || result.reason === "forget/id-required",
          `${attempt} → ${result.reason}`,
        );
      }
    }
    // 目录外文件仍在，且碎片目录里没有新文件
    assert.ok(existsSync(outside));
    assert.deepEqual(readdirSync(fragmentsDir), []);
  });

  it("合法 slug 的 forget 只在碎片目录内操作", () => {
    addFragment(root, "p1", "safe", "内容");
    const result = forgetMemoryItem(root, "p1", "fragment", "safe");
    assert.equal(result.ok, true);
    assert.deepEqual(listFragmentFiles(join(root, "p1", "memory", "fragments")), []);
  });
});

describe("F3 记忆目录读取（生产代码真读盘，不是自己 filter 一个数组）", () => {
  it("listFragmentFiles 只认 .md、忽略隐藏文件/其它扩展名，且排序稳定", () => {
    const dir = join(root, "p2", "memory", "fragments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b.md"), "# b\n", "utf8");
    writeFileSync(join(dir, "a.md"), "# a\n", "utf8");
    writeFileSync(join(dir, ".DS_Store"), "x", "utf8");
    writeFileSync(join(dir, "c.txt"), "x", "utf8");
    assert.deepEqual(listFragmentFiles(dir), ["a.md", "b.md"]);
    // listFragments 走同一路径，且缺索引时标题退回 slug
    const listed = listFragments(root, "p2");
    assert.deepEqual(
      listed.fragments.map((item) => item.slug),
      ["a", "b"],
    );
    assert.deepEqual(
      listed.fragments.map((item) => item.title),
      ["a", "b"],
    );
  });

  it("readFragment 读全文；非法 slug 不读文件", () => {
    addFragment(root, "p3", "详情", "正文内容");
    const read = readFragment(root, "p3", "详情");
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.text, "正文内容\n");
    const badSlug = readFragment(root, "p3", "../MEMORY");
    assert.equal(badSlug.ok, false);
    if (!badSlug.ok) assert.equal(badSlug.reason, "fragment/invalid-slug");
  });
});
