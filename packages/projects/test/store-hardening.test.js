// @ts-check
// 写入口校验：RPC 输入不能无上限 / 不能把路径分隔符带进数据根（审查 P1/P2）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { assertSafeDirs, isSafeRecordKey, ProjectStore } from "../lib/store.js";

/** @type {string} */
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-store-hard-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("写入口上限与路径校验", () => {
  it("项目名超过 200 字符直接拒绝（不再让 projects.json 被撑爆）", () => {
    const store = new ProjectStore({ root }).load();
    assert.throws(() => store.createProject("x".repeat(201)), /exceeds 200/u);
    assert.equal(store.createProject("x".repeat(200)).name.length, 200);
  });

  it("dirs 必须是绝对路径且不含 '..'；更新入口同口径", () => {
    const store = new ProjectStore({ root }).load();
    assert.throws(() => store.createProject("rel", { dirs: ["../relative"] }), /absolute/u);
    assert.throws(() => store.createProject("dotdot", { dirs: ["/a/../b"] }), /'\.\.'/u);
    assertSafeDirs(["/tmp/ok"]); // 合法路径不抛
    const project = store.createProject("ok", { dirs: ["/tmp/ok"] });
    assert.throws(() => store.updateProject(project.id, { dirs: ["relative"] }), /absolute/u);
  });

  it("审批 args 超过 8k 字符拒绝；reason 截断到 2k", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("approvals");
    assert.throws(
      () =>
        store.appendApproval({
          projectId: project.id,
          action: "merge",
          args: { blob: "x".repeat(9000) },
          reason: "too big",
        }),
      /approval args exceed/u,
    );
    const { requestId } = store.appendApproval({
      projectId: project.id,
      action: "merge",
      args: { prNumber: 1 },
      reason: "r".repeat(5000),
    });
    const row = store.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === requestId,
    );
    assert.equal(row.reason.length, 2000);
  });

  it("损坏的 id 在 load 时被跳过（不会拼进数据根路径）", () => {
    const store = new ProjectStore({ root }).load();
    store.state.projects = {
      "../victim": { id: "../victim", name: "evil" },
      prj_ok: { id: "prj_ok", name: "ok" },
    };
    store.state.threads = { "evil/session": { projectId: "prj_ok" } };
    store.save();
    const reloaded = new ProjectStore({ root }).load();
    assert.equal(Object.keys(reloaded.state.projects).includes("../victim"), false);
    assert.deepEqual(Object.keys(reloaded.state.projects), ["prj_ok"]);
    assert.deepEqual(Object.keys(reloaded.state.threads), []);
  });

  it("isSafeRecordKey 拒绝分隔符/控制字符/超长", () => {
    assert.equal(isSafeRecordKey("prj_ok-1"), true);
    assert.equal(isSafeRecordKey("a/b"), false);
    assert.equal(isSafeRecordKey("a\\b"), false);
    assert.equal(isSafeRecordKey("a\nb"), false);
    assert.equal(isSafeRecordKey("x".repeat(121)), false);
    assert.equal(isSafeRecordKey(""), false);
    // `join(dataRoot, ".")` 就是数据根本身：这类 key 会绕过"记录只能落在自己目录下"的前提
    assert.equal(isSafeRecordKey("."), false);
    assert.equal(isSafeRecordKey(".."), false);
  });
});

// —— 本批修复（2026-11-28 审计）——
import { BUDGET_FIELDS, DEFAULT_BUDGET, normalizeBudgetPatch } from "../lib/budget.js";
import { APPROVAL_CLAIM_TTL_MS, localDateKey, MAX_APPROVALS, utcDateKey } from "../lib/store.js";

describe("AUD-PROJ-03：repoGrants 撤销必须生效（空对象要能落盘）", () => {
  it("单条撤销 + 最后一条删空都生效（以前回落旧值 → 永远收不回授权）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("grants", { dirs: ["/tmp/grants"] });
    const base = store.getProject(project.id);
    // 授予两个仓库
    store.updateProject(project.id, {
      policy: { ...base.policy, repoGrants: { "o/r1": true, "o/r2": true } },
    });
    store.save();
    assert.deepEqual(Object.keys(store.getProject(project.id).policy.repoGrants).sort(), [
      "o/r1",
      "o/r2",
    ]);

    // 撤销单条（客户端就是「按剩余列表重建 map」）
    const afterOne = store.getProject(project.id);
    store.updateProject(project.id, {
      policy: { ...afterOne.policy, repoGrants: { "o/r2": true } },
    });
    store.save();
    assert.deepEqual(Object.keys(store.getProject(project.id).policy.repoGrants), ["o/r2"]);

    // 撤销最后一条：显式空对象必须落盘，而不是回落上一份授权
    const afterTwo = store.getProject(project.id);
    store.updateProject(project.id, { policy: { ...afterTwo.policy, repoGrants: {} } });
    store.save();
    assert.deepEqual(store.getProject(project.id).policy.repoGrants, {});
    // 读盘后也一样（不是只在内存里对）
    const reloaded = new ProjectStore({ root }).load().getProject(project.id);
    assert.deepEqual(reloaded?.policy?.repoGrants, {});
  });

  it("完全没提供该字段时仍继承旧授权（部分 patch 不能误清空）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("grants2", { dirs: ["/tmp/grants2"] });
    const base = store.getProject(project.id);
    store.updateProject(project.id, {
      policy: { ...base.policy, repoGrants: { "o/r1": true } },
    });
    // 只改自治等级：policy 里没有 repoGrants 键
    store.updateProject(project.id, { policy: { autonomy: "L2" } });
    assert.deepEqual(store.getProject(project.id).policy.repoGrants, { "o/r1": true });
  });
});

describe("AUD-PROJ-04：weeklyTokens 是正经预算字段（不再读盘即丢）", () => {
  it("在 BUDGET_FIELDS / 默认值里，normalizeBudgetPatch 接受它", () => {
    assert.ok(BUDGET_FIELDS.includes("weeklyTokens"));
    assert.equal(DEFAULT_BUDGET.weeklyTokens, null);
    assert.deepEqual(normalizeBudgetPatch({ weeklyTokens: "5000" }), {
      ok: true,
      budget: { weeklyTokens: 5000 },
    });
    assert.deepEqual(normalizeBudgetPatch({ weeklyTokens: null }), {
      ok: true,
      budget: { weeklyTokens: null },
    });
    assert.equal(normalizeBudgetPatch({ weeklyTokens: -1 }).ok, false);
  });

  it("写→落盘→读盘 round-trip 保留 weeklyTokens（以前 load 就丢）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("weekly", { dirs: ["/tmp/weekly"] });
    store.updateProject(project.id, { budget: { ...project.budget, weeklyTokens: 12345 } });
    store.save();
    const reloaded = new ProjectStore({ root }).load().getProject(project.id);
    assert.equal(reloaded?.budget?.weeklyTokens, 12345);
    assert.equal(reloaded?.budget?.dailyTokens, null);
    assert.equal(reloaded?.budget?.maxConcurrent, project.budget.maxConcurrent);
  });

  it("手改 projects.json 写入的 weeklyTokens 也不会被下一次 save 抹掉", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("handedited", { dirs: ["/tmp/hand"] });
    store.save();
    const file = join(root, "projects.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.projects[project.id].budget.weeklyTokens = 999;
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const reloaded = new ProjectStore({ root }).load();
    assert.equal(reloaded.getProject(project.id)?.budget?.weeklyTokens, 999);
    reloaded.save();
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.projects[project.id].budget.weeklyTokens, 999, "save 之后仍在文件里");
  });

  it("未知预算字段保留（硬性约定 1：不认识的不丢）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("unknown-budget", { dirs: ["/tmp/unk"] });
    store.save();
    const file = join(root, "projects.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.projects[project.id].budget.futureField = 7;
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const reloaded = new ProjectStore({ root }).load();
    assert.equal(reloaded.getProject(project.id)?.budget?.futureField, 7);
  });
});

describe("AUD-PROJ-09：审批队列上限 + 分页", () => {
  it("满了先淘汰已了结的，全是 pending 时拒绝新申请（不静默丢可执行申请）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("approvals", { dirs: ["/tmp/apr"] });
    for (let index = 0; index < MAX_APPROVALS; index += 1) {
      store.appendApproval({
        projectId: project.id,
        action: "merge",
        args: {},
        reason: `r${index}`,
      });
    }
    // 全部还是 pending：再申请必须被拒
    assert.throws(
      () => store.appendApproval({ projectId: project.id, action: "merge", args: {}, reason: "x" }),
      /approval queue is full/u,
    );
    // 了结一半 → 淘汰后能再收
    for (const item of store.listApprovals(project.id).slice(0, 10)) {
      store.resolveApproval(item.requestId, "approved");
    }
    const created = store.appendApproval({
      projectId: project.id,
      action: "merge",
      args: {},
      reason: "after-settle",
    });
    assert.ok(created.requestId);
    // 淘汰了 10 条已了结的，再加 1 条 = 491
    assert.equal(store.listApprovals(project.id).length, MAX_APPROVALS - 10 + 1);
    assert.ok(
      store.state.audit.some((/** @type {any} */ item) => item.action === "approval/queue-pruned"),
    );
  });

  it("listApprovals 支持 limit/offset 分页（RPC 全量序列化是大文件的主要来源）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("paging", { dirs: ["/tmp/pg"] });
    for (let index = 0; index < 5; index += 1) {
      store.appendApproval({
        projectId: project.id,
        action: "merge",
        args: {},
        reason: `p${index}`,
      });
    }
    assert.equal(store.listApprovals(project.id).length, 5);
    assert.equal(store.listApprovals(project.id, { limit: 2 }).length, 2);
    assert.deepEqual(
      store
        .listApprovals(project.id, { offset: 3, limit: 2 })
        .map((/** @type {any} */ i) => i.reason),
      ["p3", "p4"],
    );
    // 不传 options 时行为不变（老调用点不受影响）
    assert.equal(store.listApprovals().length, 5);
  });
});

describe("AUD-PROJ-08：审批占位过期可接管 / 启动回收", () => {
  it("claim 超过 TTL 可以被接管，且留审计", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("claim", { dirs: ["/tmp/claim"] });
    const created = store.appendApproval({
      projectId: project.id,
      action: "merge",
      args: { prNumber: 1 },
      reason: "r",
    });
    store.resolveApproval(created.requestId, "approved");
    store.claimApproval(created.requestId);
    // 刚占上：不能接管
    assert.throws(() => store.claimApproval(created.requestId), /already claimed/u);
    // 人为把占位时间往前拨到 TTL 之外
    const row = store.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === created.requestId,
    );
    row.claimedAt = new Date(Date.now() - APPROVAL_CLAIM_TTL_MS - 1000).toISOString();
    const again = store.claimApproval(created.requestId);
    assert.equal(again.recovered, true);
    assert.ok(
      store.state.audit.some(
        (/** @type {any} */ item) => item.action === "approval/claim-recovered",
      ),
    );
  });

  it("releaseStaleApprovals 只回收超时的（新鲜的占位保持不动）", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("claim2", { dirs: ["/tmp/claim2"] });
    const fresh = store.appendApproval({
      projectId: project.id,
      action: "merge",
      args: { prNumber: 1 },
      reason: "fresh",
    });
    const stale = store.appendApproval({
      projectId: project.id,
      action: "merge",
      args: { prNumber: 2 },
      reason: "stale",
    });
    for (const id of [fresh.requestId, stale.requestId]) {
      store.resolveApproval(id, "approved");
      store.claimApproval(id);
    }
    const staleRow = store.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === stale.requestId,
    );
    staleRow.claimedAt = new Date(Date.now() - APPROVAL_CLAIM_TTL_MS - 5000).toISOString();
    const released = store.releaseStaleApprovals({ ttlMs: APPROVAL_CLAIM_TTL_MS });
    assert.deepEqual(
      released.map((/** @type {any} */ item) => item.requestId),
      [stale.requestId],
    );
    const freshRow = store.state.approvals.find(
      (/** @type {any} */ item) => item.requestId === fresh.requestId,
    );
    assert.ok(freshRow.claimedAt, "新鲜占位不能被动");
  });
});

describe("AUD-PROJ-10：删除项目清用量桶，恢复时放回", () => {
  it("removeProject 删掉 usage 桶并把桶返回给调用方", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("usage", { dirs: ["/tmp/usage"] });
    store.addTokenUsage(project.id, 100);
    store.addTokenUsage(project.id, 50);
    assert.equal(store.tokenUsageToday(project.id), 150);
    const removed = store.removeProject(project.id);
    assert.equal(store.state.usage[project.id], undefined, "桶必须随项目一起清掉");
    assert.equal(removed.usage.days[localDateKey(Date.now())], 150);
  });

  it("restoreProject 接受 manifest 里的 usage 并放回", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("usage2", { dirs: ["/tmp/usage2"] });
    store.addTokenUsage(project.id, 42);
    const removed = store.removeProject(project.id);
    store.restoreProject({
      project: removed.project,
      threads: removed.threads,
      usage: removed.usage,
    });
    assert.equal(store.tokenUsageToday(project.id), 42);
  });
});

describe("AUD-PROJ-11：restoreProject 不信任 manifest 里的 project.id", () => {
  it("路径逃逸形态的 id 直接拒绝（以前只判 id !== ''）", () => {
    const store = new ProjectStore({ root }).load();
    for (const bad of ["../../etc/passwd", "a/b", "..", "x".repeat(200)]) {
      assert.throws(
        () =>
          store.restoreProject({
            project: { id: bad, name: "evil" },
            threads: [],
          }),
        /unsafe project id/u,
        `应当拒绝 ${bad}`,
      );
    }
  });

  it("正常 id 仍可恢复；不安全的 thread sessionId 被跳过", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("restore-ok", { dirs: ["/tmp/restore"] });
    const removed = store.removeProject(project.id);
    const restored = store.restoreProject({
      project: removed.project,
      threads: [
        { sessionId: "good-session", projectId: project.id },
        { sessionId: "../evil", projectId: project.id },
      ],
    });
    assert.equal(restored.threadCount, 2);
    assert.ok(store.state.threads["good-session"]);
    assert.equal(store.state.threads["../evil"], undefined);
  });
});

describe("AUD-PROJ-17：token 桶键统一用本地日期（与日/周闸同口径）", () => {
  it("写入用本地日期，读旧 UTC 键仍能兜住升级当天的花费", () => {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("tz", { dirs: ["/tmp/tz"] });
    // 选一个本地日期与 UTC 日期**不同**的时刻（UTC+8 的凌晨；UTC-5 的深夜同理）
    const now = new Date();
    now.setHours(1, 30, 0, 0);
    store.addTokenUsage(project.id, 10, now.getTime());
    assert.equal(store.tokenUsageOn(project.id, now.getTime()), 10);
    if (localDateKey(now.getTime()) !== utcDateKey(now.getTime())) {
      // 旧数据：桶键是 UTC 日期
      const legacyStore = new ProjectStore({ root: join(root, "legacy") }).load();
      const legacyProject = legacyStore.createProject("legacy", { dirs: ["/tmp/tz2"] });
      legacyStore.state.usage = legacyStore.state.usage ?? {};
      legacyStore.state.usage[legacyProject.id] = {
        days: { [utcDateKey(now.getTime())]: 33 },
      };
      assert.equal(legacyStore.tokenUsageOn(legacyProject.id, now.getTime()), 33);
      // 新写入不产生 UTC 键
      legacyStore.addTokenUsage(legacyProject.id, 1, now.getTime());
      assert.ok(
        Object.hasOwn(legacyStore.state.usage[legacyProject.id].days, localDateKey(now.getTime())),
      );
    }
  });
});
