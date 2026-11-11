// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildVerificationBlock, collectEvidence, isInside } from "../lib/verifier.js";

test("isInside：`../` 与绝对路径都被挡住", () => {
  assert.equal(isInside("/work", "src/a.ts"), true);
  assert.equal(isInside("/work", "/work/src/a.ts"), true);
  assert.equal(isInside("/work", "../etc/passwd"), false);
  assert.equal(isInside("/work", "/etc/passwd"), false);
  assert.equal(isInside("", "a.ts"), false);
});

test("collectEvidence：读工作目录内的文件，越界与缺失分别记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-verifier-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const x = 1;\n", "utf8");

  const result = await collectEvidence({
    root,
    needs: [
      { kind: "file", ref: "src/a.ts" },
      { kind: "file", ref: "../outside.txt" },
      { kind: "file", ref: "src/missing.ts" },
      { kind: "url", ref: "https://example.com" },
    ],
  });
  assert.equal(result.sections.length, 1);
  assert.match(result.sections[0].text, /export const x/u);
  assert.equal(result.refused.length, 3);
  assert.match(result.refused.join(" "), /不在会话工作目录内/u);
  assert.match(result.refused.join(" "), /读取失败/u);
  assert.match(result.refused.join(" "), /只支持 file\/path/u);
});

test("collectEvidence：超过上限就截断并留痕", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-verifier-big-"));
  await writeFile(join(root, "big.txt"), "x".repeat(200), "utf8");
  const result = await collectEvidence({
    root,
    needs: [{ kind: "file", ref: "big.txt" }],
    maxBytes: 50,
  });
  assert.equal(result.sections[0].text.includes("x".repeat(50)), true);
  assert.equal(result.sections[0].text.includes("已截断，原长 200 字节"), true);
});

test("collectEvidence：一次最多读 maxFiles 个", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-verifier-many-"));
  for (const name of ["a", "b", "c"]) await writeFile(join(root, name), "hi", "utf8");
  const result = await collectEvidence({
    root,
    needs: [
      { kind: "file", ref: "a" },
      { kind: "file", ref: "b" },
      { kind: "file", ref: "c" },
    ],
    maxFiles: 2,
  });
  assert.equal(result.sections.length, 2);
});

test("buildVerificationBlock：拼出证据与不可读清单", () => {
  const block = buildVerificationBlock({
    sections: [{ ref: "src/a.ts", text: "code" }],
    refused: ["../x (越界)"],
  });
  assert.match(block, /VERIFICATION PASS/u);
  assert.match(block, /--- src\/a\.ts ---/u);
  assert.match(block, /Could not read: \.\.\/x/u);
  assert.equal(buildVerificationBlock({ sections: [], refused: [] }), "");
});
