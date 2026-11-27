// @ts-check
// AUD-PROJ-07：危险动作审批卡片的影响面投影（ADR 0002 第 2 条）。
//
// 以前审批行只渲染 `${action} · ${reason}`，PR 号/仓库/分支/目录全不显示，
// 而「批准/执行」按钮就在同一行。这里锁住投影：白名单、截断、不把整块 args 泼出去。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeApprovalImpact, withApprovalImpact } from "../lib/approval-view.js";

const labels = (/** @type {any} */ impact) =>
  impact.rows.map((/** @type {any} */ row) => `${row.key}=${row.value}`);

describe("describeApprovalImpact：影响面白名单投影", () => {
  it("merge → PR 号 + 仓库（人不用点开 JSON 才知道要合哪个）", () => {
    const impact = describeApprovalImpact({
      action: "merge",
      args: { prNumber: 42, repo: "acme/payments", impact: { diffFiles: 1000 }, extra: "x" },
    });
    assert.deepEqual(labels(impact), ["prNumber=42", "repo=acme/payments"]);
    // 模型可控的 impact 不进展示（那是被审对象自己写的话）
    assert.ok(impact.redacted.includes("impact"));
    assert.equal(impact.summary, "PR=42 · repo=acme/payments");
    assert.doesNotMatch(JSON.stringify(impact), /extra/u);
  });

  it("push 类 → 分支/仓库，强推标出来，SHA 只露前 12 位", () => {
    const impact = describeApprovalImpact({
      action: "push-protected-branch",
      args: { branch: "main", repo: "acme/payments", force: true, expectedSha: "a".repeat(40) },
    });
    assert.deepEqual(labels(impact), [
      "branch=main",
      "repo=acme/payments",
      "force=true",
      "expectedSha=aaaaaaaaaaaa",
    ]);
  });

  it("delete-thread / delete-project / purge-trash / change-settings 各自显示对象", () => {
    assert.deepEqual(
      labels(describeApprovalImpact({ action: "delete-thread", args: { sessionId: "s-1" } })),
      ["sessionId=s-1"],
    );
    assert.deepEqual(
      labels(describeApprovalImpact({ action: "delete-project", args: { projectId: "prj_9" } })),
      ["projectId=prj_9"],
    );
    assert.deepEqual(
      labels(describeApprovalImpact({ action: "purge-trash", args: { retentionDays: 30 } })),
      ["retentionDays=30"],
    );
    // 改配置只显示「改了哪些键」，不显示值（persona 可能很长）
    const settings = describeApprovalImpact({
      action: "change-settings",
      args: { patch: { persona: "x".repeat(500), goal: "g" } },
    });
    assert.deepEqual(labels(settings), ["keys=persona, goal"]);
    assert.doesNotMatch(settings.summary, /x{20}/u);
  });

  it("未知动作只透出标量白名单，不原样输出去", () => {
    const impact = describeApprovalImpact({
      action: "mystery",
      args: { prNumber: 7, token: "secret-value", nested: { a: 1 } },
    });
    assert.deepEqual(labels(impact), ["prNumber=7"]);
    assert.doesNotMatch(JSON.stringify(impact), /secret-value/u);
  });

  it("超长值截断、换行压成单行（卡片是一行文本块）", () => {
    const impact = describeApprovalImpact({
      action: "push-branch",
      args: { branch: `feature/${"x".repeat(300)}` },
    });
    assert.equal(impact.rows.length, 1);
    assert.ok(impact.rows[0].value.length <= 121);
    assert.ok(impact.rows[0].value.endsWith("…"));
    const multiline = describeApprovalImpact({
      action: "delete-project",
      args: { projectId: "prj_1\n\n<b>", dirs: ["/a", "/b"] },
    });
    assert.equal(multiline.rows[0].value, "prj_1 <b>");
    assert.equal(multiline.rows[1].value, "/a, /b");
  });

  it("withApprovalImpact 保留原始字段，只多一个 impact", () => {
    const rows = withApprovalImpact([
      { requestId: "apr_1", action: "merge", args: { prNumber: 5 }, reason: "r" },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requestId, "apr_1");
    assert.equal(rows[0].reason, "r");
    assert.equal(rows[0].impact.summary, "PR=5");
    assert.deepEqual(withApprovalImpact(/** @type {any} */ (null)), []);
  });
});
