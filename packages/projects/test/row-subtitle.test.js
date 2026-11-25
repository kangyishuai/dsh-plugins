// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSubtitle, deriveToolState } from "../lib/row-subtitle.js";

describe("行副标题状态语义（M2.1）", () => {
  it("working → 显示当前动作（没有就留空，由 UI 用通用词）", () => {
    assert.deepEqual(deriveSubtitle({ state: "working", subtitle: "Running a command" }), {
      kind: "action",
      detail: "Running a command",
    });
    assert.deepEqual(deriveSubtitle({ state: "working" }), { kind: "action", detail: "" });
  });

  it("等待回复 → 显示要你回答的问题（优先于其它状态文案）", () => {
    assert.deepEqual(deriveSubtitle({ state: "working", pendingInput: ["Which branch?", "  "] }), {
      kind: "question",
      detail: "Which branch?",
    });
  });

  it("failed / review / archived / 其它 → 各自一类，result 不再重复状态词", () => {
    assert.deepEqual(deriveSubtitle({ state: "failed", subtitle: "boom" }), {
      kind: "failed",
      detail: "",
    });
    assert.deepEqual(deriveSubtitle({ state: "review", subtitle: "PR #12" }), {
      kind: "review",
      detail: "PR #12",
    });
    assert.deepEqual(deriveSubtitle({ state: "archived", subtitle: "x" }), {
      kind: "archived",
      detail: "",
    });
    assert.deepEqual(deriveSubtitle({ state: "idle", subtitle: "done" }), {
      kind: "result",
      detail: "done",
    });
    assert.deepEqual(deriveSubtitle({ state: "resolved" }), { kind: "result", detail: "" });
  });
});

describe("工具态（M3：✓✓✓ Using X）", () => {
  it("只有 working + 有工具名才算工具态；其它状态/空名不编", () => {
    assert.deepEqual(deriveToolState({ state: "working", tool: "bash" }), {
      kind: "using",
      tool: "bash",
    });
    assert.deepEqual(deriveToolState({ state: "idle", tool: "bash" }), { kind: "none", tool: "" });
    assert.deepEqual(deriveToolState({ state: "working", tool: "  " }), { kind: "none", tool: "" });
    assert.deepEqual(deriveToolState({}), { kind: "none", tool: "" });
  });
});
