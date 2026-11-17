// @ts-check
// auto-fix 单测：轮数上限、无进展即停、同错两次即停、**不碰测试断言**。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFixTask,
  errorSignature,
  MAX_FIX_ROUNDS,
  shouldContinueFix,
  touchedTestFiles,
} from "../lib/autofix.js";

describe("shouldContinueFix", () => {
  it("正常情况继续", () => {
    assert.deepEqual(shouldContinueFix({ round: 0, changedFiles: ["src/a.ts"] }), {
      continue: true,
      reason: "",
    });
  });

  it("到轮数上限就停（默认 3 轮）", () => {
    assert.equal(
      shouldContinueFix({ round: MAX_FIX_ROUNDS, changedFiles: ["src/a.ts"] }).reason,
      "max-rounds",
    );
    assert.equal(
      shouldContinueFix({ round: 1, maxRounds: 1, changedFiles: ["src/a.ts"] }).reason,
      "max-rounds",
    );
  });

  it("上一轮没有任何改动 → 无进展，停", () => {
    assert.equal(shouldContinueFix({ round: 1, changedFiles: [] }).reason, "no-progress");
  });

  it("同错 + 零改动时，报「同错两次」而不是更含糊的「无进展」", () => {
    const result = shouldContinueFix({
      round: 1,
      changedFiles: [],
      previousSignature: "boom",
      currentSignature: "boom",
    });
    assert.equal(result.reason, "same-error-twice");
  });

  it("碰到了测试文件 → 停（防止改测试让它绿）", () => {
    assert.equal(
      shouldContinueFix({ round: 0, changedFiles: ["src/a.ts", "test/b.test.js"] }).reason,
      "test-touched",
    );
  });

  it("错误签名没变（同一错误两次）→ 停", () => {
    assert.equal(
      shouldContinueFix({
        round: 1,
        changedFiles: ["src/a.ts"],
        previousSignature: "boom",
        currentSignature: "boom",
      }).reason,
      "same-error-twice",
    );
    assert.equal(
      shouldContinueFix({ round: 1, changedFiles: ["src/a.ts"], sameSignatureTwice: true }).reason,
      "same-error-twice",
    );
  });

  it("签名变了继续", () => {
    assert.equal(
      shouldContinueFix({
        round: 1,
        changedFiles: ["src/a.ts"],
        previousSignature: "boom",
        currentSignature: "bang",
      }).continue,
      true,
    );
  });
});

describe("touchedTestFiles", () => {
  it("认得多种测试路径形态", () => {
    const files = [
      "src/index.js",
      "test/store.test.js",
      "packages/p/src/a.spec.ts",
      "apps/web/__tests__/x.js",
      "pkg/tests/integration.go",
      "pkg/testdata/seed.json",
      "pkg/fixtures/a.yaml",
    ];
    const hit = touchedTestFiles(files);
    assert.deepEqual(hit, [
      "test/store.test.js",
      "packages/p/src/a.spec.ts",
      "apps/web/__tests__/x.js",
      "pkg/tests/integration.go",
      "pkg/testdata/seed.json",
      "pkg/fixtures/a.yaml",
    ]);
  });

  it("空输入安全", () => {
    assert.deepEqual(touchedTestFiles([]), []);
    // @ts-expect-error 故意传 undefined
    assert.deepEqual(touchedTestFiles(undefined), []);
  });
});

describe("errorSignature", () => {
  it("抹掉时间戳/耗时/行号/sha，同一错误得到同一签名", () => {
    const a = "2026-11-16T10:00:00Z ERROR src/a.ts:12:5 failed after 123 ms sha=abc1234";
    const b = "2026-11-17T11:22:33Z ERROR src/a.ts:99:1 failed after 7 ms sha=def5678";
    assert.equal(errorSignature(a), errorSignature(b));
  });

  it("只保留像错误的行，且长度受控", () => {
    const text = ["ok", "done", "TypeError: Cannot read properties of undefined", "note"].join(
      "\n",
    );
    const signature = errorSignature(text);
    assert.match(signature, /TypeError/u);
    assert.ok(!signature.includes("ok\n"));
    assert.ok(errorSignature("x".repeat(5000)).length <= 1200);
  });

  it("空输入给空串", () => {
    assert.equal(errorSignature(""), "");
    // @ts-expect-error 故意传 undefined
    assert.equal(errorSignature(undefined), "");
  });
});

describe("buildFixTask", () => {
  it("提示词写明禁区：不改测试、不 push、不开 PR", () => {
    const task = buildFixTask({ round: 0, signature: "TypeError: boom", projectName: "payments" });
    assert.match(task, /第 1 轮/u);
    assert.match(task, /不要修改测试文件或断言/u);
    assert.match(task, /不要 push/u);
    assert.match(task, /不要开 PR/u);
    assert.match(task, /TypeError: boom/u);
  });

  it("没有签名时明确要求先复现", () => {
    assert.match(buildFixTask({ round: 1, signature: "" }), /先自己复现/u);
  });
});
