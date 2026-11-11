// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAdvice } from "../lib/prompt.js";
import { runEvidencePass } from "../lib/twopass.js";

const SECOND_OK = {
  ok: true,
  text: JSON.stringify({
    verdict: "reviewed",
    severity: "nit",
    advice: "版本号是 0.1.0，先发 0.2.0 再改",
  }),
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
};

test("没有 needs：原样返回，不发起第二轮", async () => {
  let called = 0;
  const result = await runEvidencePass({
    advice: { verdict: "reviewed", severity: "concern", advice: "x", needs: [] },
    root: "/tmp",
    callSecond: async () => {
      called += 1;
      return SECOND_OK;
    },
    parseAdvice,
  });
  assert.equal(called, 0);
  assert.equal(result.verification, null);
  assert.equal(result.advice.advice, "x");
});

test("有 needs 且能读到文件：第二轮生效并记录 read / pass2", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-twopass-"));
  await writeFile(join(root, "package.json"), '{"version":"0.1.0"}', "utf8");
  /** @type {string[]} */
  const blocks = [];
  const result = await runEvidencePass({
    advice: {
      verdict: "reviewed",
      severity: "concern",
      advice: "该发 0.2.0",
      needs: [{ kind: "file", ref: "package.json" }],
    },
    root,
    callSecond: async (block) => {
      blocks.push(block);
      return SECOND_OK;
    },
    parseAdvice,
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /package\.json/u);
  assert.match(blocks[0], /0\.1\.0/u);
  assert.equal(result.verification?.pass2, true);
  assert.deepEqual(result.verification?.read, ["package.json"]);
  assert.equal(result.advice.advice, "版本号是 0.1.0，先发 0.2.0 再改");
  assert.equal(result.extraUsage?.inputTokens, 10);
});

test("文件读不到：保留第一轮结论，second 不发起", async () => {
  let called = 0;
  const result = await runEvidencePass({
    advice: {
      verdict: "reviewed",
      severity: "concern",
      advice: "原结论",
      needs: [{ kind: "file", ref: "../etc/passwd" }],
    },
    root: "/tmp",
    callSecond: async () => {
      called += 1;
      return SECOND_OK;
    },
    parseAdvice,
  });
  // 越界文件被拒 → 仍有「Could not read」块 → 会发起第二轮（这是设计：让顾问知道读不到）
  assert.equal(called, 1);
  assert.equal(result.verification?.pass2, true);
  assert.match(String(result.verification?.refused), /不在会话工作目录内/u);
});

test("第二轮失败或解析失败：保留第一轮结论", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-twopass-fail-"));
  await writeFile(join(root, "a.txt"), "hi", "utf8");
  const base = {
    verdict: "reviewed",
    severity: "concern",
    advice: "原结论",
    needs: [{ kind: "file", ref: "a.txt" }],
  };

  const failed = await runEvidencePass({
    advice: { ...base },
    root,
    callSecond: async () => ({ ok: false }),
    parseAdvice,
  });
  assert.equal(failed.verification?.pass2, false);
  assert.equal(failed.advice.advice, "原结论");

  const garbage = await runEvidencePass({
    advice: { ...base },
    root,
    callSecond: async () => ({ ok: true, text: "不是 JSON" }),
    parseAdvice,
  });
  assert.equal(garbage.verification?.pass2, false);
  assert.equal(garbage.advice.advice, "原结论");
});
