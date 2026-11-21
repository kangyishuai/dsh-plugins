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

describe("路由与人格配置", () => {
  it("默认策略带 routing（两条默认规则 + 允许兜底）与空人格", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    assert.deepEqual(project.policy.routing.fallback, true);
    assert.equal(
      project.policy.routing.rules.length,
      2,
      "开箱有「问句内联 / 长任务派线程」两条规则",
    );
    assert.equal(project.policy.persona, "");
  });

  it("规则与 fallback 能被写入并保真读回", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    const rules = [{ id: "docs", when: { textMatches: "README" }, action: "reuse-thread" }];
    store.updateProject(project.id, {
      policy: { ...project.policy, routing: { rules, fallback: false } },
    });
    const saved = store.getProject(project.id);
    assert.deepEqual(saved.policy.routing.rules, rules);
    assert.equal(saved.policy.routing.fallback, false);
  });

  it("重新加载后仍保真（落盘 + normalize 不破坏）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    store.updateProject(project.id, {
      policy: {
        ...project.policy,
        routing: { rules: [{ id: "x", when: {}, action: "propose" }], fallback: true },
      },
      persona: "be terse",
    });
    store.save();
    const reloaded = new ProjectStore({ root }).load();
    const saved = reloaded.getProject(project.id);
    assert.equal(saved.policy.routing.rules.length, 1);
    assert.equal(saved.policy.persona, "be terse");
  });

  it("坏输入被收敛：routing 不是对象、rules 不是数组、fallback 非布尔", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    store.updateProject(project.id, {
      policy: { ...project.policy, routing: { rules: "nope", fallback: "no" }, persona: 123 },
    });
    const saved = store.getProject(project.id);
    assert.deepEqual(saved.policy.routing.rules, []);
    assert.equal(saved.policy.routing.fallback, true);
    assert.equal(saved.policy.persona, "");
  });
});

describe("token 用量分桶", () => {
  it("同一天累加，跨天自动归零", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    const day1 = Date.parse("2026-11-16T10:00:00+08:00");
    const day2 = Date.parse("2026-11-17T10:00:00+08:00");

    store.addTokenUsage(project.id, 100, day1);
    store.addTokenUsage(project.id, 50, day1);
    assert.equal(store.tokenUsageToday(project.id, day1), 150);

    assert.equal(store.tokenUsageToday(project.id, day2), 0, "新的一天从 0 开始");
    store.addTokenUsage(project.id, 30, day2);
    assert.equal(store.tokenUsageToday(project.id, day2), 30);
  });

  it("非法 token 数按 0，不产生 NaN", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    const now = Date.parse("2026-11-16T10:00:00+08:00");
    store.addTokenUsage(project.id, Number.NaN, now);
    store.addTokenUsage(project.id, -10, now);
    assert.equal(store.tokenUsageToday(project.id, now), 0);
  });

  it("重启后保留", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("p");
    const now = Date.parse("2026-11-16T10:00:00+08:00");
    store.addTokenUsage(project.id, 42, now);
    store.save();
    const reloaded = new ProjectStore({ root }).load();
    assert.equal(reloaded.tokenUsageToday(project.id, now), 42);
  });
});

describe("审批执行的幂等保护", () => {
  const makeApproval = (/** @type {any} */ store) => {
    const project = store.createProject("p");
    const { requestId } = store.appendApproval({
      projectId: project.id,
      action: "merge",
      reason: "ok",
    });
    return { projectId: project.id, requestId };
  };

  it("第一次标记执行成功，第二次报错（不会重复执行）", () => {
    const store = new ProjectStore({ root }).load();
    const { requestId } = makeApproval(store);
    store.resolveApproval(requestId, "approved");
    const marked = store.markApprovalExecuted(requestId, { evidence: "x" });
    assert.ok(typeof marked.executedAt === "string");
    assert.throws(() => store.markApprovalExecuted(requestId), /already executed/u);
    assert.equal(store.listApprovals()[0].executedAt, marked.executedAt);
  });

  it("已执行的申请不能再被改决议（防止事后改写状态）", () => {
    const store = new ProjectStore({ root }).load();
    const { requestId } = makeApproval(store);
    store.resolveApproval(requestId, "approved");
    store.markApprovalExecuted(requestId);
    assert.throws(() => store.resolveApproval(requestId, "rejected"), /already executed/u);
  });

  it("未执行的申请仍可正常决议", () => {
    const store = new ProjectStore({ root }).load();
    const { requestId } = makeApproval(store);
    assert.equal(store.resolveApproval(requestId, "rejected").status, "rejected");
  });
});

describe("审批的 claim / release（占用 ≠ 执行）", () => {
  /** @returns {{ store: any, requestId: string, project: any }} */
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-store-claim-"));
    const store = new ProjectStore({ root: dir });
    store.load();
    const project = store.createProject("claim-demo");
    const item = store.appendApproval({
      projectId: project.id,
      action: "merge",
      reason: "x",
      args: { prNumber: 1 },
    });
    return { store, requestId: item.requestId, project };
  };

  it("占位成功 → 再占位抛 already claimed", () => {
    const { store, requestId } = setup();
    store.claimApproval(requestId);
    assert.throws(() => store.claimApproval(requestId), /already claimed/u);
  });

  it("释放后可再次占位（被拒绝的申请能重试）", () => {
    const { store, requestId } = setup();
    store.claimApproval(requestId);
    assert.equal(store.releaseApproval(requestId), true);
    assert.equal(store.claimApproval(requestId).requestId, requestId);
  });

  it("已执行的申请不能占位、也不会被释放", () => {
    const { store, requestId } = setup();
    store.claimApproval(requestId);
    store.markApprovalExecuted(requestId, { any: "evidence" });
    assert.throws(() => store.claimApproval(requestId), /already executed/u);
    assert.equal(store.releaseApproval(requestId), false);
  });

  it("markApprovalExecuted 会清掉占位（不会卡住已执行记录）", () => {
    const { store, requestId } = setup();
    store.claimApproval(requestId);
    store.markApprovalExecuted(requestId, null);
    const item = store.listApprovals().find((/** @type {any} */ a) => a.requestId === requestId);
    assert.equal(item.claimedAt, null);
    assert.ok(typeof item.executedAt === "string" && item.executedAt !== "");
  });

  it("未知申请：claim 抛错、release 返回 false（不炸）", () => {
    const { store } = setup();
    assert.throws(() => store.claimApproval("nope"), /unknown approval/u);
    assert.equal(store.releaseApproval("nope"), false);
  });
});
