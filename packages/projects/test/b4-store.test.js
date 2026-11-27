// @ts-check
// B4 落盘单测：F52 preset / F36 routines / F30 reminders 三个字段的读写往返与上限。
// 仓储是「写→回读」的证据链起点：UI 上看到的东西必须能从磁盘再读回来。
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MAX_ROUTINES } from "../lib/routines.js";
import { ProjectStore } from "../lib/store.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-b4-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** @returns {{ store: ProjectStore, projectId: string }} */
function freshProject() {
  const store = new ProjectStore({ root });
  store.load();
  const project = store.createProject("alpha");
  store.save();
  return { store, projectId: project.id };
}

describe("B4 项目字段默认值", () => {
  it("新项目：preset=null（继承宿主）、reminderDefault=timer、routines/reminders 空数组", () => {
    const { store, projectId } = freshProject();
    const project = store.getProject(projectId);
    assert.equal(project.preset, null);
    assert.equal(project.reminderDefault, "timer");
    assert.deepEqual(project.routines, []);
    assert.deepEqual(project.reminders, []);
  });

  it("老数据没有这些字段也能读（不 bump formatVersion）", () => {
    const store = new ProjectStore({ root });
    store.load();
    const project = store.createProject("legacy");
    // 模拟 B4 之前的存档：删掉新字段
    const record = store.state.projects[project.id];
    delete record.preset;
    delete record.reminderDefault;
    delete record.routines;
    delete record.reminders;
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    const back = reloaded.getProject(project.id);
    assert.equal(back.preset, null);
    assert.equal(back.reminderDefault, "timer");
    assert.deepEqual(back.routines, []);
    assert.deepEqual(back.reminders, []);
  });
});

describe("F52 preset 落盘", () => {
  it("setProjectPreset 空串 = 继承（null），非空原样保留", () => {
    const { store, projectId } = freshProject();
    const set = store.setProjectPreset(projectId, "read-only");
    assert.equal(set.preset, "read-only");
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    assert.equal(reloaded.getProject(projectId).preset, "read-only");
    // 空串 = 回到继承
    assert.equal(store.setProjectPreset(projectId, "").preset, null);
    store.save();
    const again = new ProjectStore({ root });
    again.load();
    assert.equal(again.getProject(projectId).preset, null);
  });
});

describe("F30 reminderDefault 落盘", () => {
  it("只接受 timer/schedule，其余回落 timer", () => {
    const { store, projectId } = freshProject();
    assert.equal(store.setReminderDefault(projectId, "schedule").reminderDefault, "schedule");
    assert.equal(store.setReminderDefault(projectId, "nope").reminderDefault, "timer");
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    assert.equal(reloaded.getProject(projectId).reminderDefault, "timer");
  });
});

describe("F36 routines 落盘", () => {
  const routine = {
    id: "rt_test_1",
    name: "每日日报",
    instructions: "总结昨天合并的 PR",
    frequency: "daily",
    time: "09:30:00",
    cron: "",
    enabled: true,
    spaceId: "p1",
    scheduleId: "sched-1",
    createdAt: "2026-12-01T00:00:00.000Z",
    lastRunAt: "",
    history: [],
  };

  it("新增 → 落盘 → 冷启动读回（含 scheduleId 与 history）", () => {
    const { store, projectId } = freshProject();
    const added = store.addRoutine(projectId, routine);
    assert.equal(added.routine.id, "rt_test_1");
    store.patchRoutine(projectId, "rt_test_1", {
      history: [
        { at: "2026-12-01T01:00:00.000Z", status: "delivered", message: "m", source: "host" },
      ],
      lastRunAt: "2026-12-01T01:00:00.000Z",
    });
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    const back = reloaded.listRoutines(projectId);
    assert.equal(back.length, 1);
    assert.equal(back[0].scheduleId, "sched-1");
    assert.equal(back[0].time, "09:30:00");
    assert.equal(back[0].history.length, 1);
    assert.equal(back[0].lastRunAt, "2026-12-01T01:00:00.000Z");
  });

  it("上限是 MAX_ROUTINES，超了明确拒绝（不静默截断）", () => {
    const { store, projectId } = freshProject();
    for (let index = 0; index < MAX_ROUTINES; index += 1) {
      store.addRoutine(projectId, { ...routine, id: `rt_${index}` });
    }
    assert.throws(() => store.addRoutine(projectId, { ...routine, id: "rt_over" }), /at most/u);
  });

  it("patch/remove 都有回读；删不存在的返回 removed:false", () => {
    const { store, projectId } = freshProject();
    store.addRoutine(projectId, routine);
    assert.equal(
      store.patchRoutine(projectId, "rt_test_1", { enabled: false }).routine.enabled,
      false,
    );
    assert.equal(store.removeRoutine(projectId, "rt_test_1").removed, true);
    assert.deepEqual(store.listRoutines(projectId), []);
    assert.equal(store.removeRoutine(projectId, "rt_test_1").removed, false);
  });

  it("读盘保留未知字段（前向兼容）：未来版本加的字段不会在旧版本存一次后消失", () => {
    const { store, projectId } = freshProject();
    store.addRoutine(projectId, { ...routine, futureField: "keep-me" });
    store.save();
    const file = join(root, "projects.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.projects[projectId].routines[0].futureField, "keep-me");
  });
});

describe("F30 reminders 落盘", () => {
  const base = {
    id: "rm_test_1",
    at: "2026-12-01T09:00:00.000Z",
    text: "看构建结果",
    mode: "timer",
    state: "pending",
    createdAt: "2026-12-01T08:00:00.000Z",
  };

  it("新增 → 落盘 → 冷启动读回；listAllReminders 带 projectId（arm 用）", () => {
    const { store, projectId } = freshProject();
    store.addReminder(projectId, base);
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    const back = reloaded.listReminders(projectId);
    assert.equal(back.length, 1);
    assert.equal(back[0].text, "看构建结果");
    assert.equal(back[0].state, "pending");
    const all = reloaded.listAllReminders();
    assert.equal(all.length, 1);
    assert.equal(all[0].projectId, projectId);
  });

  it("fired 状态与 unread 标记能回读（重启后不再重复响）", () => {
    const { store, projectId } = freshProject();
    store.addReminder(projectId, base);
    store.patchReminder(projectId, "rm_test_1", {
      state: "fired",
      firedAt: "2026-12-01T09:00:01.000Z",
      unread: true,
      notified: false,
    });
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    const back = reloaded.listReminders(projectId)[0];
    assert.equal(back.state, "fired");
    assert.equal(back.unread, true);
    assert.equal(back.notified, false);
  });

  it("删除提醒后不再出现在列表里", () => {
    const { store, projectId } = freshProject();
    store.addReminder(projectId, base);
    assert.equal(store.removeReminder(projectId, "rm_test_1").removed, true);
    assert.deepEqual(store.listReminders(projectId), []);
  });
});

// B3 复审 P0：effort 白名单把本部署的 max/xhigh/off 静默清空（UI 还提示已保存）。
// 修法：删白名单，非空即收（合法性由调用方按 modelCatalog.reasoning.efforts 校验）。
describe("F42 线程默认 effort：部署枚举（max/xhigh/off）不被白名单吃掉", () => {
  it("coordinatorDefaults 与 threadDefaults 分开存：互不影响、冷启动可读、默认继承", () => {
    const store = new ProjectStore({ root });
    store.load();
    const project = store.createProject("协调者默认");
    // 新建项目两者都是空（继承宿主）
    const fresh = store.getProject(project.id);
    assert.deepEqual(fresh.threadDefaults, { provider: "", model: "", reasoningEffort: "" });
    assert.deepEqual(fresh.coordinatorDefaults, { provider: "", model: "", reasoningEffort: "" });
    // 只写协调者，线程默认不受影响
    store.setCoordinatorDefaults(project.id, {
      provider: "zhinao",
      model: "deepseek/x",
      reasoningEffort: "high",
    });
    store.setThreadDefaults(project.id, { provider: "official", model: "flash" });
    const after = store.getProject(project.id);
    assert.equal(after.coordinatorDefaults.model, "deepseek/x");
    assert.equal(after.coordinatorDefaults.reasoningEffort, "high");
    assert.equal(after.threadDefaults.model, "flash");
    store.save();
    // 冷启动回读
    const reloaded = new ProjectStore({ root }).load();
    const back = reloaded.getProject(project.id);
    assert.equal(back.coordinatorDefaults.provider, "zhinao");
    assert.equal(back.threadDefaults.provider, "official");
    // 清空 = 回到继承
    assert.deepEqual(
      reloaded.setCoordinatorDefaults(project.id, { provider: "", model: "", reasoningEffort: "" })
        .defaults,
      { provider: "", model: "", reasoningEffort: "" },
    );
  });

  it("setThreadDefaults 收 max/xhigh/off，落盘冷启动后还在；空串仍表示继承", () => {
    const { store, projectId } = freshProject();
    for (const effort of ["max", "xhigh", "off"]) {
      const written = store.setThreadDefaults(projectId, {
        provider: "smoke-provider",
        model: "smoke-model",
        reasoningEffort: effort,
      });
      assert.equal(written.defaults.reasoningEffort, effort, `${effort} 不能在内核层被清空`);
      assert.equal(written.defaults.provider, "smoke-provider");
      store.save();
      const reloaded = new ProjectStore({ root });
      reloaded.load();
      assert.equal(
        reloaded.getProject(projectId).threadDefaults.reasoningEffort,
        effort,
        `${effort} 必须能从 projects.json 冷启动读回`,
      );
    }
    // 空串 = 继承宿主默认（这条语义没变）
    const cleared = store.setThreadDefaults(projectId, { reasoningEffort: "" });
    assert.equal(cleared.defaults.reasoningEffort, "");
    // 超长脏值只截断，不会把整条记录变成不可读
    const long = store.setThreadDefaults(projectId, { reasoningEffort: "x".repeat(200) });
    assert.equal(long.defaults.reasoningEffort.length, 40);
  });
});

describe("attachThread 幂等（重复 attach 不能丢字段）", () => {
  it("重复 attach 保留 prNumber / mergedAt / autoRetryCount / title", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-attach-"));
    try {
      const store = new ProjectStore({ root }).load();
      const project = store.createProject("keep-fields");
      store.attachThread("session-keep-1", project.id);
      store.setThreadWorktree("session-keep-1", { prNumber: 42, mergedAt: "2026-11-27T00:00:00Z" });
      const thread = store.state.threads["session-keep-1"];
      thread.title = "带标题的线程";
      thread.autoRetryCount = 1;
      const again = store.attachThread("session-keep-1", project.id);
      assert.equal(again.prNumber, 42);
      assert.equal(again.mergedAt, "2026-11-27T00:00:00Z");
      assert.equal(again.autoRetryCount, 1);
      assert.equal(again.title, "带标题的线程");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectOfSession 契约（自动重试依赖）", () => {
  it("返回项目对象（含 id），不是 projectId 字符串", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-pos-"));
    try {
      const store = new ProjectStore({ root }).load();
      const project = store.createProject("pos");
      const thread = { sessionId: "session-pos-1" };
      store.attachThread(thread.sessionId, project.id);
      const found = store.projectOfSession(thread.sessionId);
      assert.equal(found?.id, project.id);
      assert.equal(typeof store.projectOfSession("missing"), "undefined");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("saveSoon：合并写盘", () => {
  it("连续多次 saveSoon 只写一次；flush 立即落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-save-soon-"));
    try {
      const store = new ProjectStore({ root }).load();
      store.createProject("coalesce");
      store.saveSoon(40);
      store.saveSoon(40);
      store.saveSoon(40);
      // 300ms 内文件应已出现（紧凑 JSON：只有一行、无缩进）
      await new Promise((resolve) => setTimeout(resolve, 120));
      const raw = readFileSync(join(root, "projects.json"), "utf8");
      assert.ok(raw.includes('"coalesce"'), "文件应已落盘");
      assert.ok(!raw.includes("\n  "), "应为紧凑 JSON（不含两空格缩进）");
      // flush 之后再改一次并立即 flush
      store.createProject("flushed");
      store.saveSoon(10_000);
      store.flush();
      const raw2 = readFileSync(join(root, "projects.json"), "utf8");
      assert.ok(raw2.includes('"flushed"'), "flush 必须立即落盘");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("setThreadTask：行标题的原始任务", () => {
  it("写回并压缩空白、截断 200 字；未知线程返回 null", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-thread-task-"));
    try {
      const store = new ProjectStore({ root }).load();
      const project = store.createProject("task-title");
      store.attachThread("s-task-1", project.id);
      const updated = store.setThreadTask("s-task-1", "  读一遍 README，\n\n用三点总结  ");
      assert.equal(updated.task, "读一遍 README， 用三点总结");
      const long = store.setThreadTask("s-task-1", "x".repeat(500));
      assert.equal(long.task.length, 200);
      assert.equal(store.setThreadTask("missing", "x"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("saveSoon：写盘失败不再静默", () => {
  it("目录不可写时 lastSaveError 与 onSaveError 都会给出", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 用户下权限无效
    const root = mkdtempSync(join(tmpdir(), "dsh-save-error-"));
    try {
      const store = new ProjectStore({ root }).load();
      store.createProject("will-fail");
      /** @type {string[]} */
      const seen = [];
      store.onSaveError = (/** @type {any} */ error) => seen.push(String(error?.message ?? error));
      chmodSync(root, 0o500);
      store.saveSoon(10);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.notEqual(store.lastSaveError, "");
      assert.equal(seen.length > 0, true);
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
