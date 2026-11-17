// @ts-check
// 项目上下文挂载与内容文件读取的单测：不依赖 Cordis，用假 agent/store。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { registerProjectContext } from "../lib/attach.js";
import { MAX_FILE_CHARS, readProjectFiles } from "../lib/project-files.js";
import { ProjectStore } from "../lib/store.js";

/** @type {string} */
let root;
/** @type {ProjectStore} */
let store;
/** @type {ReturnType<typeof ProjectStore.prototype.createProject>} */
let project;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-ctx-"));
  store = new ProjectStore({ root }).load();
  project = store.createProject("payments", { goal: "p95 < 200ms" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readProjectFiles", () => {
  it("文件缺失时返回空串，不抛错", () => {
    const files = readProjectFiles(root, "prj_missing");
    assert.equal(files.instructions, "");
    assert.equal(files.memoryIndex, "");
  });

  it("读到 instructions.md 与 memory/MEMORY.md", () => {
    mkdirSync(join(root, project.id, "memory"), { recursive: true });
    writeFileSync(join(root, project.id, "instructions.md"), "从 main 起分支\n", "utf8");
    writeFileSync(
      join(root, project.id, "memory", "MEMORY.md"),
      "- 缓存层在 src/cache.ts\n",
      "utf8",
    );
    const files = readProjectFiles(root, project.id);
    assert.equal(files.instructions, "从 main 起分支");
    assert.equal(files.memoryIndex, "- 缓存层在 src/cache.ts");
  });

  it("超大文件被截断而不是整段塞进提示词", () => {
    mkdirSync(join(root, project.id), { recursive: true });
    writeFileSync(
      join(root, project.id, "instructions.md"),
      "a".repeat(MAX_FILE_CHARS + 100),
      "utf8",
    );
    const files = readProjectFiles(root, project.id);
    assert.match(files.instructions, /已截断/u);
    assert.ok(files.instructions.length <= MAX_FILE_CHARS + 40);
  });
});

describe("registerProjectContext（全局注册 + 按会话求值）", () => {
  it("只对归属且 active 的会话渲染；其它会话返回空串", () => {
    store.attachThread("session-in", project.id);
    /** @type {any} */
    let entry = null;
    registerProjectContext({
      getStore: () => store,
      getDataRoot: () => root,
      register: (definition) => {
        entry = definition;
        return () => {};
      },
    });
    assert.equal(typeof entry.text, "function");
    assert.equal(entry.name, "projects");
    assert.equal(entry.required, false);
    assert.equal(entry.interpolate, false);

    // 未归属的会话 → 空串
    assert.equal(entry.text({ agent: { session: { id: "session-other" } } }), "");
    // 归属会话 → 渲染内容（含项目名）
    const rendered = entry.text({ agent: { session: { id: "session-in" } } });
    assert.ok(rendered.includes("payments"));
  });

  it("归档项目不渲染", () => {
    store.attachThread("session-arch", project.id);
    store.archiveProject(project.id);
    /** @type {any} */
    let entry = null;
    registerProjectContext({
      getStore: () => store,
      getDataRoot: () => root,
      register: (definition) => {
        entry = definition;
        return () => {};
      },
    });
    assert.equal(entry.text({ agent: { session: { id: "session-arch" } } }), "");
  });

  it("渲染抛错时返回空串而不是让请求失败", () => {
    /** @type {any} */
    let entry = null;
    registerProjectContext({
      getStore: () => {
        throw new Error("boom");
      },
      getDataRoot: () => root,
      register: (definition) => {
        entry = definition;
        return () => {};
      },
    });
    assert.equal(entry.text({ agent: { session: { id: "x" } } }), "");
  });

  it("每次求值都重新读盘（记忆写入后立即可见）", () => {
    store.attachThread("session-live", project.id);
    /** @type {any} */
    let entry = null;
    registerProjectContext({
      getStore: () => store,
      getDataRoot: () => root,
      register: (definition) => {
        entry = definition;
        return () => {};
      },
    });
    const ctx = { agent: { session: { id: "session-live" } } };
    assert.ok(!entry.text(ctx).includes("缓存层"));
    mkdirSync(join(root, project.id, "memory"), { recursive: true });
    writeFileSync(
      join(root, project.id, "memory", "MEMORY.md"),
      "- 缓存层在 src/cache.ts\n",
      "utf8",
    );
    assert.ok(entry.text(ctx).includes("缓存层"));
  });
});
