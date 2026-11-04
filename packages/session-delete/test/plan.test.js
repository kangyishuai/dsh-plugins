// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlan,
  digestOf,
  formatBytes,
  planExecutable,
  planStillValid,
  stableStringify,
} from "../lib/plan.js";

/** @type {import("../lib/plan.js").PlanInput} */
const base = {
  sessionId: "session-1",
  title: "t",
  cwd: "/w",
  sizeBytes: 1024,
  live: false,
  activity: [],
  children: [],
  location: { path: "/data/sessions/--w--/session-1", tier: "scan" },
  trashPath: null,
  removes: [{ id: "workspace-archive", label: "归档标记", tier: "api" }],
  blockers: [],
};

test("digest 对同一输入稳定，对关键字段敏感", () => {
  const a = buildPlan(base);
  const b = buildPlan(base);
  assert.equal(a.digest, b.digest);
  const changed = buildPlan({ ...base, sizeBytes: 2048 });
  assert.notEqual(a.digest, changed.digest);
  const live = buildPlan({ ...base, live: true });
  assert.notEqual(a.digest, live.digest);
});

test("标题不参与摘要（改名不需要重新确认）", () => {
  const a = buildPlan(base);
  const b = buildPlan({ ...base, title: "另一个名字" });
  assert.equal(a.digest, b.digest);
});

test("缺少位置会产生阻断原因，且不可执行", () => {
  const plan = buildPlan({ ...base, location: null });
  assert.equal(planExecutable(plan), false);
  assert.ok(plan.blockers.some((b) => b.code === "session-delete/location-unknown"));
  assert.equal(planStillValid(plan), true);
});

test("planStillValid 能发现事实漂移", () => {
  const plan = buildPlan(base);
  const drifted = { ...plan, sizeBytes: 999999 };
  assert.equal(planStillValid(drifted), false);
  assert.equal(planStillValid({ ...plan, children: [{ id: "child", title: null }] }), false);
  assert.equal(digestOf(plan), plan.digest);
});

test("stableStringify 键排序且忽略 undefined", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
});

test("formatBytes 人类可读", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
});
