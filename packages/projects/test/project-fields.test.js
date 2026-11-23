// @ts-check
// B1 数据模型单测：icon / archivedAt / autoResolveDays / repos / 多目录上限（F1/F2/F29/F35）
// 与线程六态持久字段：resolvedAt / unread / todos / subtitle（F16/F27/F31）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  MAX_DIRS,
  MAX_REPOS,
  normalizeDirs,
  normalizeIcon,
  normalizeRepos,
  ProjectStore,
} from "../lib/store.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-fields-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("项目实体新字段（F1）", () => {
  it("新建项目默认 icon 空串、archivedAt null、autoResolveDays null（不是缺字段）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    assert.equal(project.icon, "");
    assert.equal(project.archivedAt, null);
    assert.equal(project.autoResolveDays, null);
    assert.deepEqual(project.repos, []);
    store.save();
    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    assert.equal(raw.projects[project.id].icon, "");
    assert.equal(raw.projects[project.id].archivedAt, null);
  });

  it("归档写入 archivedAt，取消归档清掉（可逆动作不留假时间）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    const archived = store.archiveProject(project.id);
    assert.equal(archived.state, "archived");
    assert.equal(typeof archived.archivedAt, "string");
    const restored = store.updateProject(project.id, { state: "active" });
    assert.equal(restored.archivedAt, null);
    const paused = store.updateProject(project.id, { state: "paused" });
    assert.equal(paused.archivedAt, null);
  });

  it("图标截断到短标记，autoResolveDays 只接受 1..365 的整数", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha", { icon: " 🚀🚀🚀🚀🚀🚀🚀 " });
    assert.equal(project.icon.length <= 8, true);
    assert.equal(store.updateProject(project.id, { autoResolveDays: 7 }).autoResolveDays, 7);
    assert.equal(store.updateProject(project.id, { autoResolveDays: 0 }).autoResolveDays, null);
    assert.equal(store.updateProject(project.id, { autoResolveDays: 400 }).autoResolveDays, null);
    assert.equal(store.updateProject(project.id, { autoResolveDays: null }).autoResolveDays, null);
  });

  it("旧数据没有 icon/archivedAt/repos 也能读入（前向/后向兼容，不 bump format）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.save();
    const legacy = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    delete legacy.projects[project.id].icon;
    delete legacy.projects[project.id].archivedAt;
    delete legacy.projects[project.id].repos;
    delete legacy.projects[project.id].autoResolveDays;
    legacy.projects[project.id].state = "archived";
    writeFileSync(join(root, "projects.json"), JSON.stringify(legacy));
    const reloaded = new ProjectStore({ root }).load();
    const read = reloaded.getProject(project.id);
    assert.equal(read?.icon, "");
    assert.equal(read?.archivedAt, null, "老数据没有时间就补 null，不伪造");
    assert.deepEqual(read?.repos, []);
    assert.equal(read?.autoResolveDays, null);
    assert.equal(reloaded.state.format, 1);
  });
});

describe("Context 多选上限（F2/F35）", () => {
  it("目录去重、去空、最多 10 个；超过上限时 updateProject 明确拒绝", () => {
    assert.deepEqual(normalizeDirs(["/a", "/a", " ", "/b"]), ["/a", "/b"]);
    assert.equal(normalizeDirs(Array.from({ length: 20 }, (_, i) => `/d${i}`)).length, 10);
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha", {
      dirs: Array.from({ length: 20 }, (_, i) => `/d${i}`),
    });
    assert.equal(project.dirs.length, MAX_DIRS, "新建时按上限截断（不静默写爆）");
    assert.throws(
      () =>
        store.updateProject(project.id, {
          dirs: Array.from({ length: MAX_DIRS + 1 }, (_, i) => `/x${i}`),
        }),
      /at most 10 project dirs/u,
    );
    // 正好 10 个是允许的
    const exact = Array.from({ length: MAX_DIRS }, (_, i) => `/x${i}`);
    assert.deepEqual(store.updateProject(project.id, { dirs: exact }).dirs, exact);
  });

  it("仓库只认 owner/repo 形状，去重、截断到上限", () => {
    assert.deepEqual(
      normalizeRepos(["acme/api", "acme/api", "https://github.com/acme/web/", "not a repo", ""]),
      ["acme/api", "acme/web"],
    );
    assert.equal(normalizeRepos(Array.from({ length: 20 }, (_, i) => `o/r${i}`)).length, MAX_REPOS);
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha", { repos: ["acme/api"] });
    assert.deepEqual(project.repos, ["acme/api"]);
    assert.throws(
      () =>
        store.updateProject(project.id, {
          repos: Array.from({ length: MAX_REPOS + 1 }, (_, i) => `o/r${i}`),
        }),
      /at most 10 repos/u,
    );
    assert.equal(normalizeIcon("   "), "");
  });
});

describe("线程持久字段（F16/F27/F29/F31）", () => {
  it("事件回写的状态只有变了才 changed；resolve 写 resolvedAt，重开清掉", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    assert.equal(store.listThreads(project.id)[0].state, "idle");
    assert.equal(store.setThreadState("session-1", "working").changed, true);
    assert.equal(store.setThreadState("session-1", "working").changed, false);
    const failed = store.setThreadState("session-1", "failed");
    assert.equal(failed.state, "failed");

    const resolved = store.setThreadResolved("session-1", true);
    assert.equal(resolved.state, "resolved");
    assert.equal(typeof resolved.resolvedAt, "string");
    const reopened = store.setThreadResolved("session-1", false);
    assert.equal(reopened.state, "idle");
    assert.equal(reopened.resolvedAt, null);
  });

  it("todos / subtitle / unread / lastActivityAt 落盘并可读回", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    store.setThreadTodos("session-1", { total: 6, done: 4 });
    store.setThreadSubtitle("session-1", "pnpm test");
    store.setThreadUnread("session-1", true);
    store.setThreadActivity("session-1", 1_700_000_000_000);
    store.setThreadDir("session-1", "/repo");
    store.save();

    const reloaded = new ProjectStore({ root }).load();
    const thread = reloaded.listThreads(project.id)[0];
    assert.deepEqual(thread.todos, { total: 6, done: 4 });
    assert.equal(thread.subtitle, "pnpm test");
    assert.equal(thread.unread, true);
    assert.equal(thread.lastActivityAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(thread.dir, "/repo");
    assert.equal(thread.resolvedAt, null);
  });

  it("旧线程记录缺新字段时按默认值读入（不丢数据、不迁移）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    store.save();
    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    for (const key of ["resolvedAt", "unread", "todos", "subtitle", "lastActivityAt", "dir"]) {
      delete raw.threads["session-1"][key];
    }
    writeFileSync(join(root, "projects.json"), JSON.stringify(raw));
    const reloaded = new ProjectStore({ root }).load();
    const thread = reloaded.listThreads(project.id)[0];
    assert.equal(thread.resolvedAt, null);
    assert.equal(thread.unread, false);
    assert.equal(thread.todos, null);
    assert.equal(thread.subtitle, "");
    assert.equal(thread.lastActivityAt, null);
    assert.equal(thread.dir, null);
  });
});

describe("B1 审查 P0-2：六态词表两端一致（写进去要读得回来）", () => {
  it("waiting-user 能写进记录，并在重新 load 之后仍是 waiting-user", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    // 旧白名单写的是 "waiting"，而 deriveState() 产出 "waiting-user" → 写被静默丢弃。
    const written = store.setThreadState("session-1", "waiting-user");
    assert.equal(written.changed, true);
    assert.equal(written.state, "waiting-user");
    store.save();
    const reloaded = new ProjectStore({ root }).load();
    assert.equal(
      reloaded.listThreads(project.id)[0].state,
      "waiting-user",
      "重启后仍是 waiting-user（不是 idle）",
    );
  });

  it("failed / working 也能跨重启读回（不是只有 resolved/archived）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("failed-1", project.id);
    store.attachThread("working-1", project.id);
    store.setThreadState("failed-1", "failed");
    store.setThreadState("working-1", "working");
    store.save();
    const reloaded = new ProjectStore({ root }).load();
    const byId = new Map(
      reloaded
        .listThreads(project.id)
        .map((/** @type {any} */ thread) => [thread.sessionId, thread.state]),
    );
    assert.equal(byId.get("failed-1"), "failed");
    assert.equal(byId.get("working-1"), "working");
  });

  it("不认识的 state 仍然落回 idle（前向兼容不认识的条目，但不伪造状态）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha");
    store.attachThread("session-1", project.id);
    assert.equal(store.setThreadState("session-1", "bogus").state, "idle");
  });
});

describe("B1 审查 P0-3：load 只做类型过滤、不截断目录", () => {
  it("旧 projects.json 里第 11+ 个目录不会被下一次 save 丢掉", () => {
    const dirs = Array.from({ length: MAX_DIRS + 5 }, (_, i) => `/legacy/dir-${i}`);
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify({
        format: 1,
        projects: { p1: { id: "p1", name: "legacy", dirs } },
        threads: {},
      }),
    );
    const store = new ProjectStore({ root }).load();
    // load：全留着（只过滤类型/去重）
    assert.deepEqual(store.getProject("p1")?.dirs, dirs);
    store.save();
    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    assert.deepEqual(raw.projects.p1.dirs, dirs, "save 之后一个都没少");
    // 但写入口仍然拒绝超过上限（那里能给用户报错）
    assert.throws(() => store.updateProject("p1", { dirs }), /at most 10/u);
  });

  it("load 仍然过滤非字符串与重复项（不截断不等于不收敛）", () => {
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify({
        format: 1,
        projects: { p1: { id: "p1", name: "legacy", dirs: ["/a", "/a", " ", 42, "/b"] } },
        threads: {},
      }),
    );
    const store = new ProjectStore({ root }).load();
    assert.deepEqual(store.getProject("p1")?.dirs, ["/a", "/b"]);
  });
});
