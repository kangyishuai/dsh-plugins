// @ts-check
// auto PR 四档单测：默认关、只碰自己的分支、幂等、CI 条件、失败上限。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPrText,
  canAutoMerge,
  MAX_PR_ATTEMPTS,
  nextPrAction,
  PR_TIERS,
  parsePrNumber,
  planPrCreate,
} from "../lib/autopr.js";

const thread = (/** @type {any} */ patch) => ({ branch: "dsh/p-1", commits: 2, ...patch });

describe("档位与默认值", () => {
  it("默认 off：什么都不做", () => {
    assert.deepEqual(nextPrAction({ thread: thread({}) }), { action: "none", reason: "tier-off" });
    assert.deepEqual(nextPrAction({ tier: "off", thread: thread({}) }), {
      action: "none",
      reason: "tier-off",
    });
    assert.deepEqual(nextPrAction({ tier: "nonsense", thread: thread({}) }), {
      action: "none",
      reason: "tier-off",
    });
  });

  it("四档固定", () => {
    assert.deepEqual([...PR_TIERS], ["off", "draft", "ready", "auto-merge"]);
  });
});

describe("前提条件", () => {
  it("没有分支 / 不是自己的分支 → 不做", () => {
    assert.equal(nextPrAction({ tier: "draft", thread: { commits: 1 } }).reason, "no-branch");
    assert.equal(
      nextPrAction({ tier: "draft", thread: thread({ branch: "main" }) }).reason,
      "branch-not-ours",
    );
  });

  it("没有提交且没有 PR → 不做（空 PR 没意义）", () => {
    assert.equal(
      nextPrAction({ tier: "draft", thread: thread({ commits: 0 }) }).reason,
      "no-commits",
    );
  });

  it("重试超上限 → 放弃（停在人手里）", () => {
    assert.deepEqual(
      nextPrAction({ tier: "draft", thread: thread({ attempts: MAX_PR_ATTEMPTS }) }),
      {
        action: "give-up",
        reason: "too-many-attempts",
      },
    );
  });
});

describe("draft / ready", () => {
  it("首次开 PR 按档位决定 draft 还是 ready", () => {
    assert.deepEqual(nextPrAction({ tier: "draft", thread: thread({}) }), {
      action: "open-draft",
      reason: "tier-draft",
    });
    assert.deepEqual(nextPrAction({ tier: "ready", thread: thread({}) }), {
      action: "open-ready",
      reason: "tier-ready",
    });
  });

  it("已有 PR → 只更新，不重复开（幂等）", () => {
    assert.deepEqual(nextPrAction({ tier: "draft", thread: thread({ prNumber: 12 }) }), {
      action: "update",
      reason: "pr-exists",
    });
    assert.deepEqual(nextPrAction({ tier: "ready", thread: thread({ prNumber: 12 }) }), {
      action: "update",
      reason: "pr-exists",
    });
  });
});

describe("auto-merge", () => {
  it("还没 PR → 先开 ready", () => {
    assert.equal(nextPrAction({ tier: "auto-merge", thread: thread({}) }).action, "open-ready");
  });

  it("CI 绿 → merge；失败 → 放弃；未定 → 等", () => {
    assert.equal(
      nextPrAction({ tier: "auto-merge", thread: thread({ prNumber: 1, ciState: "passing" }) })
        .action,
      "merge",
    );
    assert.equal(
      nextPrAction({ tier: "auto-merge", thread: thread({ prNumber: 1, ciState: "failing" }) })
        .action,
      "give-up",
    );
    assert.equal(
      nextPrAction({ tier: "auto-merge", thread: thread({ prNumber: 1, ciState: "pending" }) })
        .action,
      "wait-ci",
    );
  });
});

describe("canAutoMerge（真正执行前的额外门槛）", () => {
  it("档位、开关、CI、可合并性四者都要满足", () => {
    assert.deepEqual(
      canAutoMerge({ tier: "auto-merge", dangerMerge: true, ciState: "passing", mergeable: true }),
      {
        ok: true,
        reason: "",
      },
    );
    assert.equal(
      canAutoMerge({ tier: "draft", dangerMerge: true, ciState: "passing" }).reason,
      "tier-not-auto-merge",
    );
    assert.equal(
      canAutoMerge({ tier: "auto-merge", dangerMerge: false, ciState: "passing" }).reason,
      "switch-off",
    );
    assert.equal(
      canAutoMerge({ tier: "auto-merge", dangerMerge: true, ciState: "pending" }).reason,
      "ci-not-passing",
    );
    assert.equal(
      canAutoMerge({ tier: "auto-merge", dangerMerge: true, ciState: "passing", mergeable: false })
        .reason,
      "not-mergeable",
    );
  });
});

describe("buildPrText", () => {
  it("标题取任务首行；正文说明是自动开的并给出撤销方式", () => {
    const pr = buildPrText({
      projectName: "payments",
      task: "fix flaky test\n\nmore",
      sessionId: "s1",
    });
    assert.equal(pr.title, "dsh: fix flaky test");
    assert.match(pr.body, /Automated by the \*\*projects\*\* plugin/u);
    assert.match(pr.body, /How to undo/u);
    assert.match(pr.body, /thread: s1/u);
    assert.ok(!/auto-merge/u.test(pr.title));
  });

  it("超长任务被截断但不丢关键信息", () => {
    const pr = buildPrText({ task: "x".repeat(2000) });
    assert.ok(pr.body.includes("truncated"));
    assert.ok(pr.title.length <= 88);
  });
});

describe("planPrCreate / parsePrNumber", () => {
  it("默认开 PR 的 argv，且只接受我们自己的分支", () => {
    const planned = planPrCreate({ title: "dsh: fix", body: "body", branch: "dsh/p-1" });
    assert.deepEqual(planned, {
      argv: ["pr", "create", "--head", "dsh/p-1", "--title", "dsh: fix", "--body", "body"],
    });
    assert.deepEqual(planPrCreate({ title: "t", body: "b", branch: "main" }), {
      error: "branch-not-ours",
    });
  });

  it("draft/base/repo 会被带上", () => {
    const planned = planPrCreate({
      title: "t",
      body: "b",
      branch: "dsh/p-1",
      base: "main",
      repo: "o/r",
      draft: true,
    });
    assert.deepEqual(planned, {
      argv: [
        "pr",
        "create",
        "--head",
        "dsh/p-1",
        "--title",
        "t",
        "--body",
        "b",
        "--base",
        "main",
        "--repo",
        "o/r",
        "--draft",
      ],
    });
  });

  it("缺标题/正文直接拒绝", () => {
    assert.deepEqual(planPrCreate({ title: "", body: "b", branch: "dsh/p-1" }), {
      error: "title-required",
    });
    assert.deepEqual(planPrCreate({ title: "t", body: "", branch: "dsh/p-1" }), {
      error: "body-required",
    });
  });

  it("从 gh 输出里解析 PR 号", () => {
    assert.equal(parsePrNumber("https://github.com/o/r/pull/123\n"), 123);
    assert.equal(
      parsePrNumber("Creating pull request for dsh/p-1 into main\nhttps://github.com/o/r/pull/7"),
      7,
    );
    assert.equal(parsePrNumber("no url here"), null);
    assert.equal(parsePrNumber(""), null);
  });
});
