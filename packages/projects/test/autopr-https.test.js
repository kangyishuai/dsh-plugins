// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planHttpsPush } from "../lib/autopr.js";

describe("兜底 https push 计划（宿主凭据不可用时的回退）", () => {
  it("生成 gh credential helper 的 push 参数", () => {
    const planned = planHttpsPush({
      url: "https://github.com/o/r.git",
      branch: "dsh/proj-1",
    });
    assert.deepEqual(planned, {
      argv: [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "-u",
        "https://github.com/o/r.git",
        "dsh/proj-1",
      ],
    });
  });

  it("非 https URL / 空分支一律拒绝，不编命令", () => {
    assert.deepEqual(planHttpsPush({ url: "git@github.com:o/r.git", branch: "dsh/x" }), {
      error: "url-not-https",
    });
    assert.deepEqual(planHttpsPush({ url: "https://github.com/o/r.git" }), {
      error: "branch-required",
    });
  });
});
