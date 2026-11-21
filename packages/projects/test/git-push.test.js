// @ts-check
// 推送类危险动作的纯逻辑单测：强推只走 --force-with-lease、直推保护分支要先查服务端。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkForcePushPrereqs,
  checkProtectedPushPrereqs,
  countCollaborators,
  planForcePush,
} from "../lib/git-push.js";

const reasonOf = (/** @type {any} */ result) => (result?.ok === false ? result.reason : "ok");

describe("planForcePush", () => {
  it("只接受插件自建分支，且必须是 force-with-lease", () => {
    const planned = planForcePush({ branch: "dsh/p-1", expectedSha: "abc1234" });
    assert.ok("argv" in planned);
    const argv = "argv" in planned ? planned.argv : [];
    assert.deepEqual(argv, [
      "git",
      "push",
      "--force-with-lease=dsh/p-1:abc1234",
      "origin",
      "dsh/p-1",
    ]);
    assert.ok(!argv.includes("--force"), "绝不能用裸 --force");
    assert.ok(!argv.includes("-f"), "绝不能用 -f");
  });

  it("别人的分支一律拒绝（规格行 1b：不提供）", () => {
    assert.deepEqual(planForcePush({ branch: "main", expectedSha: "abc1234" }), {
      error: "force-push/branch-not-ours",
    });
    assert.deepEqual(planForcePush({ branch: "feature/x", expectedSha: "abc1234" }), {
      error: "force-push/branch-not-ours",
    });
  });

  it("没有旧 SHA 就拒绝（否则审计与 lease 都无从谈起）", () => {
    assert.deepEqual(planForcePush({ branch: "dsh/p-1", expectedSha: "" }), {
      error: "force-push/sha-required",
    });
    assert.deepEqual(planForcePush({ branch: "dsh/p-1", expectedSha: "xyz" }), {
      error: "force-push/sha-required",
    });
  });
});

describe("checkForcePushPrereqs（四条硬前提）", () => {
  const base = {
    branch: "dsh/p-1",
    threadBranch: "dsh/p-1",
    expectedSha: "abc1234",
    lastPushedSha: "1111111",
    remoteHeadSha: "1111111",
  };

  it("全部满足才放行", () => {
    assert.deepEqual(checkForcePushPrereqs(base), { ok: true });
  });

  it("分支没被记录 → 拒绝", () => {
    assert.equal(
      reasonOf(checkForcePushPrereqs({ ...base, threadBranch: null })),
      "force-push/branch-not-recorded",
    );
    assert.equal(
      reasonOf(checkForcePushPrereqs({ ...base, threadBranch: "dsh/other" })),
      "force-push/branch-not-recorded",
    );
  });

  it("不是 dsh/ 前缀 → 拒绝", () => {
    assert.equal(
      reasonOf(checkForcePushPrereqs({ ...base, branch: "x/y", threadBranch: "x/y" })),
      "force-push/branch-not-ours",
    );
  });

  it("保护分支 → 拒绝", () => {
    assert.equal(
      reasonOf(checkForcePushPrereqs({ ...base, protectedBranch: true })),
      "force-push/branch-protected",
    );
  });

  it("远端被别人动过 → 拒绝（关键：不覆盖他人提交）", () => {
    assert.equal(
      reasonOf(checkForcePushPrereqs({ ...base, remoteHeadSha: "2222222" })),
      "force-push/remote-moved",
    );
  });

  it("没记录过 lastPushedSha 时不做过期判断（首次强推允许）", () => {
    assert.deepEqual(checkForcePushPrereqs({ ...base, lastPushedSha: null }), { ok: true });
  });
});

describe("checkProtectedPushPrereqs（服务端必须允许直推）", () => {
  it("没有保护配置 → 允许", () => {
    assert.deepEqual(checkProtectedPushPrereqs({ protection: null, rulesets: [] }), { ok: true });
  });

  it("要求 PR 审核 → 拒绝", () => {
    assert.equal(
      reasonOf(checkProtectedPushPrereqs({ protection: { required_pull_request_reviews: {} } })),
      "protected-push/requires-pull-request",
    );
  });

  it("分支被锁定 → 拒绝", () => {
    assert.equal(
      reasonOf(checkProtectedPushPrereqs({ protection: { lock_branch: { enabled: true } } })),
      "protected-push/branch-locked",
    );
  });

  it("ruleset 要求 PR → 拒绝；非 active 或不针对默认分支则忽略", () => {
    const pr = {
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [{ type: "pull_request" }],
    };
    assert.equal(
      reasonOf(checkProtectedPushPrereqs({ rulesets: [pr] })),
      "protected-push/ruleset-requires-pull-request",
    );
    assert.deepEqual(
      checkProtectedPushPrereqs({ rulesets: [{ ...pr, enforcement: "disabled" }] }),
      { ok: true },
    );
    assert.deepEqual(
      checkProtectedPushPrereqs({
        rulesets: [{ ...pr, conditions: { ref_name: { include: ["refs/heads/other"] } } }],
      }),
      { ok: true },
    );
  });
});

describe("countCollaborators", () => {
  it("多人提交时给出警告信号", () => {
    const single = countCollaborators([{ author: { login: "a" } }, { author: { login: "a" } }]);
    assert.equal(single.multi, false);
    const multi = countCollaborators([{ author: { login: "a" } }, { author: { login: "b" } }]);
    assert.equal(multi.multi, true);
    assert.equal(multi.collaborators, 2);
  });

  it("空输入安全", () => {
    assert.deepEqual(countCollaborators(null), { collaborators: 0, multi: false, sample: [] });
  });
});
