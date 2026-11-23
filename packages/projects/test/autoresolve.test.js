// @ts-check
// F29 自动 resolve 的单测：边界（刚好 N 天 / 超过 / 关闭）、不误伤、幂等、写审计契约。
// service.js 顶层 import 宿主的 typert 包（测试进程里没有），所以服务接线用源码契约断言，
// 行为用纯函数 + 真实 ProjectStore 钉住；端到端写入由 pnpm smoke:projects 覆盖。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { autoResolveDaysOf, autoResolveDue, DAY_MS, planAutoResolve } from "../lib/autoresolve.js";
import { ProjectStore } from "../lib/store.js";

const PKG_DIR = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-11-23T12:00:00.000Z");

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-autoresolve-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 一条「N 天前还有活动」的线程记录。
 * @param {number} ageMs @param {Record<string, any>} [patch]
 */
function threadIdleFor(ageMs, patch = {}) {
  return {
    projectId: "prj_1",
    state: "idle",
    resolvedAt: null,
    lastActivityAt: new Date(NOW - ageMs).toISOString(),
    createdAt: new Date(NOW - ageMs - 1000).toISOString(),
    ...patch,
  };
}

describe("autoResolveDue：阈值边界", () => {
  it("刚好 N 天 → 命中（>= 是明确的边界口径，不是碰巧）", () => {
    const verdict = autoResolveDue(threadIdleFor(7 * DAY_MS), 7, NOW);
    assert.equal(verdict.due, true);
    assert.equal(verdict.reason, "inactive");
    assert.equal(verdict.ageMs, 7 * DAY_MS);
  });

  it("差 1ms 不到 N 天 → 不命中（边界另一侧也必须红/绿分明）", () => {
    const verdict = autoResolveDue(threadIdleFor(7 * DAY_MS - 1), 7, NOW);
    assert.equal(verdict.due, false);
    assert.equal(verdict.reason, "not-yet");
  });

  it("超过 N 天 → 命中（含 30 天这种大间隔）", () => {
    assert.equal(autoResolveDue(threadIdleFor(7 * DAY_MS + 1), 7, NOW).due, true);
    assert.equal(autoResolveDue(threadIdleFor(30 * DAY_MS), 14, NOW).due, true);
  });

  it("关闭（null / 非法值）→ 永远不命中", () => {
    for (const days of /** @type {any[]} */ ([null, undefined, 0, -3, 400, "x", Number.NaN])) {
      const verdict = autoResolveDue(threadIdleFor(365 * DAY_MS), days, NOW);
      assert.equal(verdict.due, false, `days=${String(days)} 不该命中`);
      assert.equal(verdict.reason, "off");
    }
    assert.equal(autoResolveDaysOf(7), 7);
    assert.equal(autoResolveDaysOf(365), 365);
    assert.equal(autoResolveDaysOf(366), null);
  });

  it("已 resolved / archived / 没有时间事实 → 不动（不重复写、不猜）", () => {
    assert.equal(
      autoResolveDue(threadIdleFor(30 * DAY_MS, { state: "archived" }), 7, NOW).reason,
      "archived",
    );
    assert.equal(
      autoResolveDue(
        threadIdleFor(30 * DAY_MS, { state: "resolved", resolvedAt: "2026-01-01T00:00:00.000Z" }),
        7,
        NOW,
      ).reason,
      "already-resolved",
    );
    assert.equal(
      autoResolveDue({ projectId: "p", state: "idle" }, 7, NOW).reason,
      "no-activity",
      "没有 lastActivityAt/createdAt 时不能把「不知道」当「很久没动」",
    );
  });
});

describe("planAutoResolve：按项目口径挑线程", () => {
  it("只挑开着 autoResolveDays 的项目，且只挑本项目线程", () => {
    const projects = [
      { id: "on", autoResolveDays: 7 },
      { id: "off", autoResolveDays: null },
    ];
    const threads = {
      "s-on": threadIdleFor(8 * DAY_MS, { projectId: "on" }),
      "s-fresh": threadIdleFor(DAY_MS, { projectId: "on" }),
      "s-off": threadIdleFor(99 * DAY_MS, { projectId: "off" }),
    };
    const plan = planAutoResolve(projects, threads, NOW);
    assert.deepEqual(
      plan.targets.map((target) => target.sessionId),
      ["s-on"],
    );
    assert.equal(plan.targets[0].days, 7);
    assert.equal(plan.targets[0].idleDays, 8);
    // 关掉的项目不参与检查（0 开销、也不会被误写）
    assert.equal(plan.checked, 2);
  });

  it("没有项目开自动 resolve → checked=0、targets 空（默认行为就是不做任何事）", () => {
    const plan = planAutoResolve(
      [{ id: "a", autoResolveDays: null }],
      { s: threadIdleFor(99 * DAY_MS, { projectId: "a" }) },
      NOW,
    );
    assert.deepEqual(plan.targets, []);
    assert.equal(plan.checked, 0);
  });
});

describe("真实 store 的自动 resolve 闭环（服务层同一套写入）", () => {
  it("盘上的老线程会被 resolve：resolvedAt 写入、审计可追溯、重复跑不重写", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("alpha", { autoResolveDays: 7 });
    store.attachThread("s-old", project.id);
    store.attachThread("s-new", project.id);
    store.setThreadActivity("s-old", NOW - 8 * DAY_MS);

    const plan = planAutoResolve(store.listProjects(), store.state.threads, NOW);
    assert.deepEqual(
      plan.targets.map((target) => target.sessionId),
      ["s-old"],
    );
    // 服务层对每个 target 做的就是这两步（这里照着跑一遍，锁住落盘效果）
    for (const target of plan.targets) {
      store.setThreadResolved(target.sessionId, true);
      store.appendAudit({
        action: "thread/auto-resolved",
        projectId: target.projectId,
        sessionId: target.sessionId,
        days: target.days,
        idleDays: target.idleDays,
      });
    }
    store.save();

    const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    const saved = raw.threads["s-old"];
    assert.equal(saved.state, "resolved");
    assert.equal(typeof saved.resolvedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(saved.resolvedAt)));
    assert.equal(raw.threads["s-new"].state, "idle", "近期有活动的线程不能被误伤");
    const audit = raw.audit.filter(
      (/** @type {any} */ entry) => entry.action === "thread/auto-resolved",
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].days, 7);
    assert.equal(audit[0].idleDays, 8);

    // 幂等：再跑一趟不会重复 resolve/重复写审计
    const again = planAutoResolve(store.listProjects(), store.state.threads, NOW);
    assert.deepEqual(again.targets, []);
  });

  it("关闭项目（autoResolveDays=null）时一个线程都不动", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("beta");
    store.attachThread("s-1", project.id);
    store.setThreadActivity("s-1", NOW - 365 * DAY_MS);
    const plan = planAutoResolve(store.listProjects(), store.state.threads, NOW);
    assert.deepEqual(plan.targets, []);
    assert.equal(store.listThreads(project.id)[0].state, "idle");
  });
});

describe("service 接线契约（源码断言：测试进程不能 import 宿主包）", () => {
  it("启动路径调用自动 resolve，且审计动作名/RPC 都在", async () => {
    const source = await readFileSafe(join(PKG_DIR, "lib", "service.js"));
    assert.match(source, /this\.runAutoResolve\(Date\.now\(\)\)/u, "启动路径必须跑一次");
    assert.match(source, /this\.startAutoResolveTimer\(\)/u, "必须有每日一次的 timer");
    assert.match(source, /action: "thread\/auto-resolved"/u, "必须写审计");
    assert.match(source, /declareRemote\(ProjectsService, "checkAutoResolve"\)/u);
    assert.match(source, /declareRemote\(ProjectsService, "setAutoResolveDays"\)/u);
    assert.match(source, /24 \* 60 \* 60 \* 1000/u, "每日一次的间隔");
    // 关闭时必须零动作（默认 null=关）：服务层把挑选交给纯函数 planAutoResolve
    assert.match(source, /planAutoResolve\(projects, store\.state\?\.threads/u);
    assert.match(source, /if \(!project\) throw new Error\(`projects: unknown project/u);
  });
});

/** @param {string} path */
async function readFileSafe(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
