// @ts-check
// 单元测试：core/runs.js 与 core/checks.js（不跑真命令，注入假 runner）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareCli,
  createBuildChecker,
  createCheckers,
  createCliChecker,
} from "../lib/core/checks.js";
import {
  evaluateStop,
  findStaleObligations,
  latestBuild,
  nextRound,
  normalizeBuildRun,
  summarizeRuns,
} from "../lib/core/runs.js";

/**
 * 假 runner：按 command 返回预设结果。
 * @param {Record<string, any>} table
 */
function fakeRunner(table) {
  return async (/** @type {string} */ command) => {
    const hit = table[command];
    if (!hit) return { exitCode: 127, stdout: "", stderr: `not found: ${command}` };
    return hit;
  };
}

test("normalizeBuildRun 拒绝空命令与非法状态", () => {
  assert.throws(() => normalizeBuildRun({ command: "  " }), /command/u);
  assert.throws(() => normalizeBuildRun({ command: "x", status: "weird" }), /status/u);
  const run = normalizeBuildRun({ command: "npm run build", round: 2, implementationDigest: "d1" });
  assert.equal(run.round, 2);
  assert.equal(run.status, "running");
  assert.match(run.id, /^build-/u);
});

test("nextRound / latestBuild", () => {
  assert.equal(nextRound([{ round: 1 }, { round: 3 }]), 4);
  assert.equal(nextRound([]), 1);
  assert.equal(
    latestBuild([
      { round: 1, id: "a" },
      { round: 2, id: "b" },
    ])?.id,
    "b",
  );
});

test("build checker：成功 → pass；非零退出 → fail；超时 → unknown", async () => {
  const checker = createBuildChecker({
    runner: fakeRunner({
      ok: { exitCode: 0, stdout: "built", stderr: "" },
      bad: { exitCode: 2, stdout: "", stderr: "tsc error" },
      slow: { exitCode: null, stdout: "", stderr: "", killed: true },
    }),
  });
  assert.equal((await checker.run({ command: "ok" })).verdict, "pass");
  const fail = await checker.run({ command: "bad" });
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.exitCode, 2);
  const unknown = await checker.run({ command: "slow" });
  assert.equal(unknown.verdict, "unknown");
  assert.equal(unknown.detail.reason, "timeout-or-killed");
});

test("compareCli：退出码/包含/相等三种判据", () => {
  const ok = compareCli(
    { exitCode: 0, stdout: "hello world\n" },
    { exitCode: 0, stdoutIncludes: ["hello"] },
  );
  assert.equal(ok.verdict, "pass");
  const badExit = compareCli({ exitCode: 1, stdout: "" }, { exitCode: 0 });
  assert.equal(badExit.verdict, "fail");
  assert.match(badExit.reasons[0], /exit-code/u);
  const badText = compareCli({ exitCode: 0, stdout: "hi" }, { stdoutEquals: "hello" });
  assert.equal(badText.verdict, "fail");
  const unknown = compareCli({ exitCode: null, killed: true }, {});
  assert.equal(unknown.verdict, "unknown");
});

test("cli checker 走注入 runner 并按期望判定", async () => {
  const checker = createCliChecker({
    runner: fakeRunner({ "run --help": { exitCode: 0, stdout: "Usage: run", stderr: "" } }),
  });
  const pass = await checker.run({ command: "run --help", expect: { stdoutIncludes: ["Usage"] } });
  assert.equal(pass.verdict, "pass");
  const fail = await checker.run({ command: "run --help", expect: { stdoutIncludes: ["Nope"] } });
  assert.equal(fail.verdict, "fail");
  assert.match(fail.detail.reasons[0], /stdout-missing/u);
});

test("createCheckers 暴露 build 与 cli", () => {
  const checkers = createCheckers({ runner: fakeRunner({}) });
  assert.deepEqual([...checkers.keys()], ["build", "cli"]);
  assert.equal(checkers.get("build")?.version, "1");
});

test("evaluateStop：轮次 / 失败数 / 无进展 / checker unknown", () => {
  const quiet = evaluateStop({ builds: [], checks: [], openObligations: 1 });
  assert.equal(quiet.stop, false);

  const maxRounds = evaluateStop({
    builds: [1, 2, 3, 4, 5].map((round) => ({
      round,
      status: "pass",
      implementationDigest: `d${round}`,
    })),
    checks: [],
    openObligations: 0,
  });
  assert.equal(maxRounds.stop, true);
  assert.equal(maxRounds.reason, "max-rounds");

  const maxFailures = evaluateStop({
    builds: [
      { round: 1, status: "fail", implementationDigest: "a" },
      { round: 2, status: "error", implementationDigest: "b" },
      { round: 3, status: "fail", implementationDigest: "c" },
    ],
    checks: [],
    openObligations: 0,
  });
  assert.equal(maxFailures.reason, "max-failures");

  const noProgress = evaluateStop({
    builds: [
      { round: 1, status: "pass", implementationDigest: "same" },
      { round: 2, status: "pass", implementationDigest: "same" },
      { round: 3, status: "pass", implementationDigest: "same" },
    ],
    checks: [],
    openObligations: 1,
  });
  assert.equal(noProgress.reason, "no-progress");

  const unknownChecker = evaluateStop({
    builds: [{ round: 1, status: "pass", implementationDigest: "x" }],
    checks: [{ verdict: "unknown" }],
    openObligations: 1,
  });
  assert.equal(unknownChecker.reason, "checker-unknown");
});

test("findStaleObligations：实现变化 / 原件变化 / 检查过期 / 缺检查", () => {
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const fresh = new Date(now - 60 * 1000).toISOString();
  const old = new Date(now - 48 * 3600 * 1000).toISOString();
  const checks = [
    {
      id: "c1",
      verdict: "pass",
      implementationDigest: "impl-old",
      originalDigest: "orig-1",
      evidenceFetchedAt: fresh,
    },
    {
      id: "c2",
      verdict: "pass",
      implementationDigest: "impl-new",
      originalDigest: "orig-1",
      evidenceFetchedAt: fresh,
    },
    {
      id: "c3",
      verdict: "pass",
      implementationDigest: "impl-new",
      originalDigest: "orig-1",
      evidenceFetchedAt: old,
    },
  ];
  const obligations = [
    { id: "o1", status: "pass", checkIds: ["c1"] },
    { id: "o2", status: "pass", checkIds: ["c2"] },
    { id: "o3", status: "pass", checkIds: ["c3"] },
    { id: "o4", status: "pass", checkIds: [] },
    { id: "o5", status: "open", checkIds: ["c1"] },
  ];
  const stale = findStaleObligations({
    obligations,
    checks,
    implementationDigest: "impl-new",
    originalDigest: "orig-1",
    now,
  });
  const byId = new Map(stale.map((item) => [item.obligationId, item.reasons]));
  assert.deepEqual(byId.get("o1"), ["implementation-changed"]);
  assert.equal(byId.has("o2"), false);
  assert.deepEqual(byId.get("o3"), ["check-stale"]);
  assert.deepEqual(byId.get("o4"), ["missing-check"]);
  assert.equal(byId.has("o5"), false, "未关闭的义务不算 stale");
});

test("summarizeRuns 汇总构建/检查/义务", () => {
  const summary = summarizeRuns({
    builds: [
      { id: "b1", round: 2, status: "pass", exitCode: 0, implementationDigest: "abcdef123456" },
    ],
    checks: [{ verdict: "pass" }, { verdict: "fail" }, { verdict: "unknown" }],
    obligations: [{ status: "open" }, { status: "pass" }],
  });
  assert.equal(summary.builds, 1);
  assert.equal(summary.lastBuild?.round, 2);
  assert.equal(summary.lastBuild?.implementationDigest, "abcdef123456".slice(0, 12));
  assert.deepEqual(summary.verdicts, { pass: 1, fail: 1, unknown: 1 });
  assert.deepEqual(summary.obligations, { total: 2, open: 1, pass: 1 });
});
