// @ts-check
// process / selfTest checker 的单元测试：真实子进程（node -e）+ 临时目录里的文件副作用。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createProcessChecker, createSelfTestChecker } from "../lib/core/checks.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {string} */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "casefile-process-"));
  dirs.push(dir);
  return dir;
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ---------- process ----------

test("process：退出码 + stdout 命中 → pass", async () => {
  const checker = createProcessChecker();
  const result = await checker.run({
    command: `node -e "console.log('hello world')"`,
    expect: { exitCode: 0, stdoutIncludes: ["hello"] },
  });
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.detail.reasons, []);
});

test("process：退出码不符 → fail 并给出原因", async () => {
  const checker = createProcessChecker();
  const result = await checker.run({
    command: `node -e "process.exit(2)"`,
    expect: { exitCode: 0 },
  });
  assert.equal(result.verdict, "fail");
  assert.match(result.detail.reasons[0], /exit-code:2!==0/u);
});

test("process：文件副作用存在性 + 哈希", async () => {
  const dir = sandbox();
  const out = join(dir, "out.txt");
  const checker = createProcessChecker();
  const pass = await checker.run({
    command: `node -e "require('node:fs').writeFileSync('${out}','ok')"`,
    cwd: dir,
    expect: { exitCode: 0, files: [{ path: out, exists: true, sha256: sha256("ok") }] },
  });
  assert.equal(pass.verdict, "pass");

  const wrongHash = await checker.run({
    command: `node -e "require('node:fs').writeFileSync('${out}','changed')"`,
    cwd: dir,
    expect: { files: [{ path: out, sha256: sha256("ok") }] },
  });
  assert.equal(wrongHash.verdict, "fail");
  assert.match(wrongHash.detail.reasons.join(","), /file-hash/u);
});

test("process：期望不存在的文件却出现 → fail", async () => {
  const dir = sandbox();
  const stray = join(dir, "stray.log");
  writeFileSync(stray, "x");
  const checker = createProcessChecker();
  const result = await checker.run({
    command: `node -e "0"`,
    cwd: dir,
    expect: { files: [{ path: stray, exists: false }] },
  });
  assert.equal(result.verdict, "fail");
  assert.match(result.detail.reasons.join(","), /file-unexpected/u);
});

test("process：超时 → unknown（不是 fail 也不是 pass）", async () => {
  const checker = createProcessChecker();
  const result = await checker.run({
    command: `node -e "setTimeout(()=>{}, 5000)"`,
    timeoutMs: 300,
    expect: { exitCode: 0 },
  });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail.reason, "timeout-or-killed");
});

// ---------- selfTest ----------

test("selfTest：全绿报告 → pass", async () => {
  const checker = createSelfTestChecker();
  const result = await checker.run({
    command: `node -e "console.log(JSON.stringify({ok:true,checks:[{name:'a',ok:true},{name:'b',ok:true}]}))"`,
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.detail.checks, 2);
  assert.equal(result.detail.failed, 0);
});

test("selfTest：报告 declared false → fail", async () => {
  const checker = createSelfTestChecker();
  const result = await checker.run({
    command: `node -e "console.log(JSON.stringify({ok:false,checks:[{name:'a',ok:true}]}))"`,
  });
  assert.equal(result.verdict, "fail");
  assert.ok(result.detail.reasons.includes("report-not-ok"));
});

test("selfTest：单项失败会带出名字", async () => {
  const checker = createSelfTestChecker();
  const result = await checker.run({
    command: `node -e "console.log(JSON.stringify({passed:true,assertions:[{name:'mechanics',passed:false}]}))"`,
  });
  assert.equal(result.verdict, "fail");
  assert.ok(
    result.detail.reasons.some((/** @type {string} */ reason) => reason.includes("mechanics")),
  );
});

test("selfTest：非 JSON 输出 → unknown", async () => {
  const checker = createSelfTestChecker();
  const result = await checker.run({ command: `node -e "console.log('all good')"` });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail.reason, "self-test-report-invalid");
});

test("selfTest：形状不符（无 ok/passed/checks）→ unknown", async () => {
  const checker = createSelfTestChecker();
  const result = await checker.run({
    command: `node -e "console.log(JSON.stringify({foo:1}))"`,
  });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail.reason, "self-test-report-shape");
});

test("selfTest：可从 jsonPath 读报告而不是 stdout", async () => {
  const dir = sandbox();
  const report = join(dir, "report.json");
  writeFileSync(report, JSON.stringify({ ok: true, checks: [{ ok: true }] }));
  const checker = createSelfTestChecker();
  const result = await checker.run({
    command: `node -e "console.log('noise')"`,
    jsonPath: report,
  });
  assert.equal(result.verdict, "pass");
});
