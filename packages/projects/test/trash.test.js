// @ts-check
// 删除安全性：回收站路径、影响面表述、体积格式化；以及 store.removeProject 的语义。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ProjectStore } from "../lib/store.js";
import { formatBytes, impactOf, TRASH_DIR, trashDirFor } from "../lib/trash.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-trash-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("trashDirFor", () => {
  it("落在数据根的 trash 下，名字含项目 id 与时间戳", () => {
    const dir = trashDirFor({
      dataRoot: root,
      projectId: "prj_abc",
      now: Date.parse("2026-11-16T12:00:00Z"),
    });
    assert.ok(dir.startsWith(`${root}/${TRASH_DIR}/`), dir);
    assert.match(dir, /prj_abc-/u);
    assert.ok(!dir.includes(":"), "时间戳里的冒号必须清掉（路径安全）");
  });

  it("缺参数直接报错（不猜路径）", () => {
    assert.throws(() => trashDirFor({ dataRoot: "", projectId: "p" }), /requires dataRoot/u);
    assert.throws(() => trashDirFor({ dataRoot: "/x", projectId: "" }), /requires projectId/u);
    assert.throws(() => trashDirFor({ dataRoot: "/x", projectId: "../.." }), /requires projectId/u);
  });
});

describe("impactOf", () => {
  it("四件事都说清楚：数量 · 体积 · 是否在跑 · 能否恢复", () => {
    const impact = impactOf({
      threads: [{ state: "working" }, { state: "done" }],
      contentBytes: 2048,
      hasContentDir: true,
      name: "payments",
    });
    assert.equal(impact.threadCount, 2);
    assert.equal(impact.liveThreadCount, 1);
    assert.equal(impact.restorable, true);
    assert.match(impact.summary, /2 个线程（1 个在跑）/u);
    assert.match(impact.summary, /2\.0 KB/u);
    assert.match(impact.summary, /可恢复/u);
    assert.match(impact.summary, /会话日志不受影响/u);
  });

  it("没有内容文件时明确说「无」，而不是 0 B", () => {
    const impact = impactOf({ threads: [], contentBytes: 0, hasContentDir: false, name: "x" });
    assert.match(impact.summary, /无项目内容文件/u);
    assert.equal(impact.hasContentDir, false);
  });

  it("非法字节数按 0 处理", () => {
    const impact = impactOf({
      threads: [],
      contentBytes: Number.NaN,
      hasContentDir: true,
      name: "x",
    });
    assert.equal(impact.contentBytes, 0);
  });
});

describe("formatBytes", () => {
  it("按量级给单位", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.00 GB");
  });
});

describe("ProjectStore.removeProject", () => {
  it("删记录、摘线程，但不动会话日志（store 从不写会话文件）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("payments");
    store.attachThread("session-a", project.id);
    store.attachThread("session-b", project.id);

    const removed = store.removeProject(project.id);
    assert.equal(removed.project.name, "payments");
    assert.deepEqual(removed.threads.map((t) => t.sessionId).sort(), ["session-a", "session-b"]);
    assert.equal(store.getProject(project.id), undefined);
    assert.deepEqual(store.listThreads(project.id), []);
    assert.equal(store.projectOfSession("session-a"), undefined);
  });

  it("未知项目报错；其它项目不受影响", () => {
    const store = new ProjectStore({ root }).load();
    const a = store.createProject("a");
    const b = store.createProject("b");
    store.attachThread("session-x", b.id);
    assert.throws(() => store.removeProject("nope"), /unknown project/u);
    store.removeProject(a.id);
    assert.ok(store.getProject(b.id));
    assert.equal(store.projectOfSession("session-x")?.id, b.id);
  });
});
