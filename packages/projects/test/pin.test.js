// @ts-check
// 「收藏（pinned）」的单测：默认值 / 旧数据兼容 / 只改一个字段 / 持久化 / 拒绝未知项目。
//
// 为什么不做 service 层直测：`lib/service.js` 顶层 import 了宿主的
// `@deepseek-ai/dsh-typert-protocol`，仓库里没有这个包（运行时由宿主注入），
// Node 测试进程 import 会直接失败。所以 service 的接线（RPC 注册 + 审计动作名）
// 用源码契约断言钉住，行为用真实的 ProjectStore 钉住；端到端写入由
// `pnpm smoke:projects`（真宿主 + 读 projects.json）覆盖。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ProjectStore } from "../lib/store.js";

const PKG_DIR = join(import.meta.dirname, "..");

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-pin-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("收藏 pinned：仓储行为", () => {
  it("新建项目默认未收藏，且字段真的落盘", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    assert.equal(project.pinned, false);
    store.save();
    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    assert.equal(raw.projects[project.id].pinned, false);
  });

  it("旧数据没有 pinned 字段时按 false 读入（不做迁移也不丢数据）", () => {
    writeFileSync(
      join(root, "projects.json"),
      `${JSON.stringify({
        projects: { prj_legacy: { id: "prj_legacy", name: "old", state: "active" } },
        threads: {},
        audit: [],
      })}\n`,
      "utf8",
    );
    const store = new ProjectStore({ root }).load();
    assert.equal(store.getProject("prj_legacy")?.pinned, false);
    // 旧记录其它字段仍然可读（不是把整条记录重置掉）
    assert.equal(store.getProject("prj_legacy")?.name, "old");
  });

  it("setPinned 只改 pinned，不动 state / dirs / name / policy", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha", { goal: "g", dirs: ["/tmp/x"] });
    store.updateProject(project.id, { state: "paused" });
    const before = store.getProject(project.id);
    const after = store.setPinned(project.id, true);
    assert.equal(after.pinned, true);
    assert.equal(after.state, "paused");
    assert.equal(after.name, "alpha");
    assert.equal(after.goal, "g");
    assert.deepEqual(after.dirs, ["/tmp/x"]);
    assert.deepEqual(after.policy, before?.policy);
  });

  it("setPinned 幂等：重复置同值不改变结果", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.setPinned(project.id, true);
    const once = store.getProject(project.id);
    store.setPinned(project.id, true);
    const twice = store.getProject(project.id);
    assert.equal(twice?.pinned, true);
    assert.equal(twice?.name, once?.name);
  });

  it("setPinned 拒绝未知项目（不静默创建）", () => {
    const store = new ProjectStore({ root }).load();
    assert.throws(() => store.setPinned("prj_missing", true), /unknown project/u);
    assert.deepEqual(store.listProjects(), []);
  });

  it("收藏状态跨 load/save 往返（重启后仍在）", () => {
    const first = new ProjectStore({ root }).load();
    const project = first.createProject("alpha");
    first.setPinned(project.id, true);
    first.save();
    const second = new ProjectStore({ root }).load();
    assert.equal(second.getProject(project.id)?.pinned, true);
  });

  it("updateProject 也接受 pinned（单向兼容），但不是唯一入口", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.updateProject(project.id, { pinned: true });
    assert.equal(store.getProject(project.id)?.pinned, true);
  });
});

describe("收藏 pinned：service 接线契约", () => {
  it("service 注册了 setProjectPinned 这个 RPC", () => {
    const source = readFileSync(join(PKG_DIR, "lib/service.js"), "utf8");
    assert.match(source, /declareRemote\(ProjectsService, "setProjectPinned"\);/u);
    // RPC 具名参数必须是 projectId / pinned（网关按形参名匹配）
    assert.match(source, /setProjectPinned\(projectId, pinned\)/u);
  });

  it("收藏/取消收藏各写一条审计动作（可回读）", () => {
    const source = readFileSync(join(PKG_DIR, "lib/service.js"), "utf8");
    assert.match(source, /action: pinned === true \? "project\/pinned" : "project\/unpinned"/u);
    assert.match(source, /store\.appendAudit\(/u);
    assert.match(source, /store\.save\(\);/u);
  });
});
