// @ts-check
// 仓储单测：一切文件操作都在 mkdtemp 临时目录里跑（硬性约定 7）。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_DANGER,
  defaultPolicy,
  FORMAT_VERSION,
  newProjectId,
  ProjectStore,
} from "../lib/store.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProjectStore", () => {
  it("拒绝空数据根（不允许写死 ~/.dsh）", () => {
    assert.throws(() => new ProjectStore({ root: "" }), /injectable data root/u);
    // @ts-expect-error 故意不传
    assert.throws(() => new ProjectStore({}), /injectable data root/u);
  });

  it("首次 load 不创建文件，create/save 才落盘", () => {
    const store = new ProjectStore({ root });
    store.load();
    assert.deepEqual(store.listProjects(), []);
    const project = store.createProject("alpha");
    store.save();
    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    assert.equal(raw.format, FORMAT_VERSION);
    assert.equal(raw.projects[project.id].name, "alpha");
  });

  it("新项目默认：L1 自治、危险开关全关、无预算", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    assert.equal(project.policy.autonomy, "L1");
    assert.deepEqual(project.policy.danger, DEFAULT_DANGER);
    assert.deepEqual(Object.keys(project.policy.danger).sort(), Object.keys(DEFAULT_DANGER).sort());
    assert.equal(project.budget.dailyTokens, null);
    assert.equal(project.state, "active");
  });

  it("项目名必填且去空白", () => {
    const store = new ProjectStore({ root }).load();
    assert.throws(() => store.createProject("   "), /name is required/u);
    assert.equal(store.createProject("  alpha  ").name, "alpha");
  });

  it("重启后状态一致（round-trip）", () => {
    const first = new ProjectStore({ root }).load();
    const project = first.createProject("alpha", { goal: "keep p95 low", dirs: ["/tmp/x"] });
    first.attachThread("session-1", project.id);
    first.save();

    const second = new ProjectStore({ root }).load();
    assert.equal(second.getProject(project.id)?.goal, "keep p95 low");
    assert.deepEqual(second.getProject(project.id)?.dirs, ["/tmp/x"]);
    assert.equal(second.projectOfSession("session-1")?.id, project.id);
  });

  it("未知项目的写操作全部拒绝", () => {
    const store = new ProjectStore({ root }).load();
    assert.throws(() => store.updateProject("nope", { name: "x" }), /unknown project/u);
    assert.throws(() => store.attachThread("session-1", "nope"), /unknown project/u);
    assert.equal(store.getProject("nope"), undefined);
  });

  it("归档保留数据、可逆", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    store.archiveProject(project.id);
    assert.equal(store.getProject(project.id)?.state, "archived");
    assert.equal(store.projectOfSession("session-1")?.state, "archived");
    store.updateProject(project.id, { state: "active" });
    assert.equal(store.getProject(project.id)?.state, "active");
  });

  it("会话归属可解绑，不会动日志", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    assert.equal(store.detachThread("session-1"), true);
    assert.equal(store.detachThread("session-1"), false);
    assert.equal(store.projectOfSession("session-1"), undefined);
    assert.equal(store.getProject(project.id)?.state, "active");
  });

  it("损坏的元数据：隔离改名后报错，不删除、不静默清零", () => {
    writeFileSync(join(root, "projects.json"), "{not json", "utf8");
    const store = new ProjectStore({ root });
    assert.throws(() => store.load(), /not valid JSON/u);
    const quarantined = readdirSync(root).filter((name) =>
      name.startsWith("projects.json.corrupt-"),
    );
    assert.equal(quarantined.length, 1, "损坏文件应被改名保留");
  });

  it("未来版本的元数据拒绝读取（不猜测）", () => {
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify({ format: FORMAT_VERSION + 1 }),
      "utf8",
    );
    const store = new ProjectStore({ root });
    assert.throws(() => store.load(), /newer than supported/u);
  });

  it("旧/缺字段的元数据被补齐而不是丢掉项目", () => {
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify({ projects: { prj_x: { name: "old" } }, unknownTop: 1 }),
      "utf8",
    );
    const store = new ProjectStore({ root }).load();
    const project = store.getProject("prj_x");
    assert.equal(project?.name, "old");
    assert.equal(project?.policy.autonomy, "L1");
    assert.deepEqual(project?.policy.danger, DEFAULT_DANGER);
  });

  it("audit 追加且带上时间戳", () => {
    const store = new ProjectStore({ root, now: () => 1_700_000_000_000 }).load();
    store.appendAudit({ action: "route", reason: "rule:docs" });
    assert.equal(store.state.audit.length, 1);
    assert.equal(store.state.audit[0].action, "route");
    assert.equal(store.state.audit[0].at, new Date(1_700_000_000_000).toISOString());
  });

  it("id 稳定可辨识、不同项目不重复", () => {
    const a = newProjectId(1_700_000_000_000);
    const b = newProjectId(1_700_000_000_000);
    assert.match(a, /^prj_[0-9a-z]+$/u);
    assert.notEqual(a, b);
  });

  it("defaultPolicy 每次返回新对象（避免共享引用被改写）", () => {
    const a = defaultPolicy();
    const b = defaultPolicy();
    assert.notEqual(a.danger, b.danger);
    a.danger.autoMerge = true;
    assert.equal(b.danger.autoMerge, false);
  });
});
