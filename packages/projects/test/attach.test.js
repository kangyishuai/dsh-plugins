// @ts-check
// 项目上下文挂载与内容文件读取的单测：不依赖 Cordis，用假 agent/store。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { attachProjectContext } from "../lib/attach.js";
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

/** 造一个最小的假 agent：只要 id 与 ctx.systemPrompt.context。 */
function fakeAgent(/** @type {string} */ id) {
  /** @type {any[]} */
  const registered = [];
  return {
    agent: {
      id,
      ctx: {
        systemPrompt: {
          /** @param {any} definition */
          context: (definition) => {
            registered.push(definition);
            return () => registered.splice(0, registered.length);
          },
        },
      },
    },
    registered,
  };
}

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

describe("attachProjectContext", () => {
  it("归属该项目的会话会被注入上下文", () => {
    store.attachThread("session-a", project.id);
    const { agent, registered } = fakeAgent("session-a");
    const result = attachProjectContext(store, root, agent);
    assert.ok(result);
    assert.match(result.text, /当前项目：payments/u);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "projects");
    assert.equal(registered[0].required, true);
    assert.equal(registered[0].interpolate, false);
  });

  it("未归属任何项目的会话不注入（零开销）", () => {
    const { agent, registered } = fakeAgent("session-b");
    assert.equal(attachProjectContext(store, root, agent), undefined);
    assert.equal(registered.length, 0);
  });

  it("归档项目的会话不注入", () => {
    store.attachThread("session-c", project.id);
    store.archiveProject(project.id);
    const { agent, registered } = fakeAgent("session-c");
    assert.equal(attachProjectContext(store, root, agent), undefined);
    assert.equal(registered.length, 0);
  });

  it("release 后 disposer 可用（不抛错）", () => {
    store.attachThread("session-d", project.id);
    const { agent } = fakeAgent("session-d");
    const result = attachProjectContext(store, root, agent);
    assert.ok(result);
    assert.doesNotThrow(() => result.dispose());
  });

  it("agent 没有 systemPrompt 时降级：返回文本但不注册", () => {
    store.attachThread("session-e", project.id);
    const result = attachProjectContext(store, root, { id: "session-e", ctx: {} });
    assert.ok(result);
    assert.match(result.text, /当前项目：payments/u);
    assert.doesNotThrow(() => result.dispose());
  });

  it("项目有规则与记忆时，两者都进文本", () => {
    store.attachThread("session-f", project.id);
    mkdirSync(join(root, project.id, "memory"), { recursive: true });
    writeFileSync(join(root, project.id, "instructions.md"), "只改 tests/", "utf8");
    writeFileSync(join(root, project.id, "memory", "MEMORY.md"), "- 已知坑：时区", "utf8");
    const { agent } = fakeAgent("session-f");
    const result = attachProjectContext(store, root, agent);
    assert.ok(result);
    assert.match(result.text, /只改 tests\//u);
    assert.match(result.text, /已知坑：时区/u);
  });
});
