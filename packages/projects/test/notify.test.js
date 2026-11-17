// @ts-check
// 通知判定单测：只提醒"新出现"的失败/等待，不重复弹。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffAttention, summarize } from "../lib/notify.js";

describe("diffAttention", () => {
  it("新出现的 failed 产出提醒", () => {
    const items = diffAttention(
      { threads: { a: { state: "working", projectId: "p1" } }, projects: ["p1"] },
      { threads: { a: { state: "failed", projectId: "p1" } }, projects: ["p1"] },
    );
    assert.deepEqual(items, [{ kind: "failed", projectId: "p1", sessionId: "a" }]);
  });

  it("已经是 failed 的不重复提醒", () => {
    const items = diffAttention(
      { threads: { a: { state: "failed", projectId: "p1" } }, projects: ["p1"] },
      { threads: { a: { state: "failed", projectId: "p1" } }, projects: ["p1"] },
    );
    assert.deepEqual(items, []);
  });

  it("waiting-user 也是提醒，且与 failed 分开计数", () => {
    const items = diffAttention(
      { threads: {}, projects: ["p1"] },
      {
        threads: {
          a: { state: "failed", projectId: "p1" },
          b: { state: "waiting-user", projectId: "p1" },
        },
        projects: ["p1"],
      },
    );
    assert.equal(items.length, 2);
    assert.deepEqual(summarize(items), {
      failed: 1,
      waiting: 1,
      text: "1 个线程失败 · 1 个线程在等你",
    });
  });

  it("线程消失（归档/删除）不提醒", () => {
    const items = diffAttention(
      { threads: { a: { state: "failed", projectId: "p1" } }, projects: ["p1"] },
      { threads: {}, projects: [] },
    );
    assert.deepEqual(items, []);
  });

  it("空输入安全", () => {
    // @ts-expect-error 故意传 undefined
    assert.deepEqual(diffAttention(undefined, undefined), []);
    assert.deepEqual(
      diffAttention({ threads: {}, projects: [] }, { threads: {}, projects: [] }),
      [],
    );
  });
});

describe("summarize", () => {
  it("单类型文案", () => {
    assert.equal(summarize([{ kind: "failed" }, { kind: "failed" }]).text, "2 个线程失败");
    assert.equal(summarize([{ kind: "waiting-user" }]).text, "1 个线程在等你");
  });

  it("空集合给空串（不弹空通知）", () => {
    assert.deepEqual(summarize([]), { failed: 0, waiting: 0, text: "" });
    // @ts-expect-error 故意传 undefined
    assert.equal(summarize(undefined).text, "");
  });
});
