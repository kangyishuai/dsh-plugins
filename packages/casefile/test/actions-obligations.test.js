// @ts-check
// 单元测试：义务关闭硬门（spec/03-acceptance.md §1.3）。
// 关键口径：没有新鲜 PASS 检查就不许关；实现 digest 不一致不许关；静态证据关不掉运行时义务。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {ReturnType<typeof createActions>} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-obl-"));
  dirs.push(root);
  return createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root });
}

/**
 * @param {ReturnType<typeof createActions>} actions
 * @param {string} projectId
 * @param {Record<string, any>} [overrides]
 */
async function seedObligation(actions, projectId, overrides = {}) {
  return actions.addObligation(projectId, {
    statement: "新增待办在 390px 下不横向滚动",
    kind: "behavior",
    authorityRequired: "controlled-replay",
    ...overrides,
  });
}

/** 造一个「新鲜、PASS、digest 一致」的检查。 */
function passCheck(/** @type {any} */ obligation, implementationDigest = "impl-1") {
  return {
    obligationId: obligation.id,
    checker: "manual",
    verdict: "pass",
    implementationDigest,
    originalDigest: "orig-1",
    evidenceFetchedAt: new Date().toISOString(),
  };
}

test("新义务是 open；没有检查时拒绝关闭（no-fresh-check）", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p");
  assert.equal(obligation.status, "open");
  await assert.rejects(
    () => actions.closeObligation("p", obligation.id),
    (error) =>
      /** @type {any} */ (error).code === "obligationTooTall" &&
      /no-fresh-check/u.test(/** @type {any} */ (error).message),
  );
});

test("FAIL 的检查不能关闭义务", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p");
  await actions.addCheck("p", { ...passCheck(obligation), verdict: "fail" });
  await assert.rejects(
    () => actions.closeObligation("p", obligation.id),
    (error) => /check-fail/u.test(/** @type {any} */ (error).message),
  );
});

test("新鲜 PASS 且 digest 一致 → 关闭成功并留痕", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p", { ownerDigest: "impl-1" });
  await actions.addCheck("p", passCheck(obligation));
  const closed = await actions.closeObligation("p", obligation.id, { note: "人工复核过" });
  assert.equal(closed.status, "pass");
  assert.equal(closed.closedBy, "agent");
  assert.match(String(closed.closedAt), /^\d{4}-/u);
  assert.deepEqual(closed.checkIds.length, 1);
  const audit = await actions.detail("p").then(() => actions.listChecks("p", obligation.id));
  assert.equal(audit.filter((item) => item.verdict === "pass").length, 1);
});

test("实现 digest 不一致 → implementation-mismatch", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p", { ownerDigest: "impl-2" });
  await actions.addCheck("p", passCheck(obligation, "impl-1"));
  await assert.rejects(
    () => actions.closeObligation("p", obligation.id),
    (error) => /implementation-mismatch/u.test(/** @type {any} */ (error).message),
  );
});

test("过期检查（>24h）→ stale-check", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p");
  await actions.addCheck("p", {
    ...passCheck(obligation),
    evidenceFetchedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  });
  await assert.rejects(
    () => actions.closeObligation("p", obligation.id),
    (error) => /no-fresh-check|stale-check/u.test(/** @type {any} */ (error).message),
  );
});

test("reopen 把已关闭义务改回 open", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p", { ownerDigest: "impl-1" });
  await actions.addCheck("p", passCheck(obligation));
  await actions.closeObligation("p", obligation.id);
  const reopened = await actions.reopenObligation("p", obligation.id, "实现改了");
  assert.equal(reopened.status, "open");
  assert.equal(reopened.version, 3);
});

test("projectStats 统计义务", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "P" });
  const obligation = await seedObligation(actions, "p", { ownerDigest: "impl-1" });
  await seedObligation(actions, "p");
  await actions.addCheck("p", passCheck(obligation));
  await actions.closeObligation("p", obligation.id);
  const detail = await actions.detail("p");
  assert.equal(detail.stats.obligations, 2);
  assert.equal(detail.stats.openObligations, 1);
  assert.equal(detail.stats.passedObligations, 1);
});
