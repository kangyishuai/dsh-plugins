// @ts-check
// 自主性阶梯：L3 的硬条件、预算判定、降级开关、审计。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import {
  AUTONOMY_DEFAULT_BUDGET,
  evaluateBudget,
  evaluateUnlock,
  normalizeAutonomy,
  normalizeBudget,
} from "../lib/core/autonomy.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-autonomy-"));
  dirs.push(root);
  return {
    actions: createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root }),
    root,
  };
}

const CHECK = { checker: "cli", command: "true", expect: { exitCode: 0 } };

test("evaluateUnlock：scope=all 被拒", () => {
  const result = evaluateUnlock({
    project: { scope: "all", state: "investigating" },
    obligations: [{ kind: "existence", check: CHECK }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("scope-not-selected"));
});

test("evaluateUnlock：scope=selected + 义务都有检查配方 → 可解锁", () => {
  const result = evaluateUnlock({
    project: { scope: "selected", state: "investigating" },
    obligations: [
      { kind: "existence", check: CHECK },
      { kind: "behavior", check: CHECK },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.budget, AUTONOMY_DEFAULT_BUDGET);
});

test("evaluateUnlock：coverage 类义务永不允许 L3", () => {
  const result = evaluateUnlock({
    project: { scope: "selected", state: "investigating" },
    obligations: [{ kind: "coverage", check: CHECK }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((item) => item.startsWith("kind-not-allowed")));
});

test("evaluateUnlock：义务缺检查配方 → 拒绝（否则没人验会被自动刷绿）", () => {
  const result = evaluateUnlock({
    project: { scope: "selected", state: "investigating" },
    obligations: [{ kind: "existence", check: null }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((item) => item.startsWith("obligation-without-check")));
});

test("evaluateUnlock：没有义务 → 拒绝", () => {
  const result = evaluateUnlock({ project: { scope: "selected" }, obligations: [] });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("no-obligations"));
});

test("normalizeBudget：缺项用默认，非法值报 invalid-input", () => {
  assert.deepEqual(normalizeBudget(null), AUTONOMY_DEFAULT_BUDGET);
  assert.deepEqual(normalizeBudget({ maxRounds: 3 }), {
    maxRounds: 3,
    maxBuilds: AUTONOMY_DEFAULT_BUDGET.maxBuilds,
    maxWallClockMs: AUTONOMY_DEFAULT_BUDGET.maxWallClockMs,
  });
  assert.throws(
    () => normalizeBudget({ maxRounds: -1 }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("evaluateBudget：任一轮 fail → 立即停（不刷灯）", () => {
  const result = evaluateBudget({
    builds: [{ round: 1 }],
    startedAt: null,
    budget: AUTONOMY_DEFAULT_BUDGET,
    lastVerdict: "fail",
  });
  assert.equal(result.stop, true);
  assert.equal(result.reason, "l3-fail");
});

test("evaluateBudget：build 数或墙钟超限都会停", () => {
  const byBuilds = evaluateBudget({
    builds: new Array(20).fill({ round: 1 }),
    startedAt: null,
    budget: { maxRounds: 5, maxBuilds: 20, maxWallClockMs: 600000 },
  });
  assert.equal(byBuilds.reason, "l3-budget-builds");
  const byTime = evaluateBudget({
    builds: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    nowMs: Date.parse("2026-01-01T01:00:00.000Z"),
    budget: { maxRounds: 5, maxBuilds: 20, maxWallClockMs: 600000 },
  });
  assert.equal(byTime.reason, "l3-budget-time");
});

test("normalizeAutonomy：缺省是 L2", () => {
  assert.equal(normalizeAutonomy(undefined).level, "L2");
  assert.equal(normalizeAutonomy({ level: "L3" }).level, "L3");
});

test("setAutonomy：scope=all 拒绝升 L3，且项目状态不变", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "P", scope: "all" });
  await assert.rejects(
    () => actions.setAutonomy(project.id, { level: "L3" }),
    (error) => /** @type {any} */ (error).code === "autonomy-blocked",
  );
  const after1 = await actions.detail(project.id);
  assert.equal(after1.autonomy.level, "L2");
});

test("setAutonomy：合格项目可升 L3 并写审计；降级永远允许", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "P", scope: "selected" });
  await actions.addObligation(project.id, { statement: "S", kind: "existence", check: CHECK });
  const unlocked = await actions.setAutonomy(project.id, { level: "L3", budget: { maxRounds: 2 } });
  assert.equal(unlocked.autonomy.level, "L3");
  assert.equal(unlocked.autonomy.budget.maxRounds, 2);
  assert.match(String(unlocked.autonomy.unlockedAt), /^\d{4}-/u);

  const audit = await actions.readAudit(project.id);
  assert.ok(audit.some((entry) => entry.action === "autonomy/unlock"));

  const locked = await actions.setAutonomy(project.id, { level: "L2" });
  assert.equal(locked.autonomy.level, "L2");
  const audit2 = await actions.readAudit(project.id);
  assert.ok(audit2.some((entry) => entry.action === "autonomy/lock"));
});

test("runCycle 在 L3 且预算已耗尽时直接停，并写 autonomy/stop 审计", async () => {
  const { actions } = makeActions();
  const project = await actions.openProject({ title: "P", scope: "selected" });
  await actions.addObligation(project.id, { statement: "S", kind: "existence", check: CHECK });
  await actions.setAutonomy(project.id, {
    level: "L3",
    // 墙钟预算 1 毫秒：解锁后必然已超
    budget: { maxRounds: 5, maxBuilds: 20, maxWallClockMs: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    () => actions.runCycle(project.id, { command: "true", cwd: "/tmp" }),
    (error) => /** @type {any} */ (error).code === "autonomy-stop",
  );
  const audit = await actions.readAudit(project.id);
  assert.ok(audit.some((entry) => entry.action === "autonomy/stop"));
});
