// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldAutoRetry } from "../lib/auto-retry.js";

describe("失败自动重试判定", () => {
  it("开关关 → 不重试；非失败状态 → 不重试", () => {
    assert.deepEqual(shouldAutoRetry({ enabled: false, state: "failed" }), {
      retry: false,
      reason: "disabled",
    });
    assert.deepEqual(shouldAutoRetry({ enabled: true, state: "idle" }), {
      retry: false,
      reason: "not-failed",
    });
  });

  it("刚变成失败 → 重试；已失败过 → 不重试；超过上限 → 不重试", () => {
    assert.deepEqual(
      shouldAutoRetry({ enabled: true, state: "failed", previousState: "working", attempts: 0 }),
      { retry: true, reason: "first-failure" },
    );
    assert.deepEqual(
      shouldAutoRetry({ enabled: true, state: "failed", previousState: "failed", attempts: 1 }),
      { retry: false, reason: "already-failed" },
    );
    assert.deepEqual(
      shouldAutoRetry({ enabled: true, state: "failed", previousState: "working", attempts: 2 }),
      { retry: false, reason: "limit" },
    );
    assert.deepEqual(
      shouldAutoRetry({ enabled: true, state: "failed", previousState: "failed", attempts: 1 }),
      { retry: false, reason: "already-failed" },
    );
  });
});
