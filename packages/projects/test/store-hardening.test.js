// @ts-check
// 写入口校验：RPC 输入不能无上限 / 不能把路径分隔符带进数据根（审查 P1/P2）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  });
});
