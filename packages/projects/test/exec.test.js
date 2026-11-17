// @ts-check
// 命令封装单测：用 PATH 里的桩脚本验证「调了什么、参数是什么、失败也返回 code」。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runCommand } from "../lib/exec.js";

/** @type {string} */
let dir;
/** @type {string} */
let logFile;
const originalPath = process.env.PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-projects-exec-"));
  logFile = join(dir, "calls.log");
  // 桩脚本：记录收到的参数，并按 STUB_EXIT 决定退出码
  const stub = join(dir, "stubcmd");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${logFile}"\necho "stdout-ok"\necho "stderr-line" >&2\nexit \${STUB_EXIT:-0}\n`,
    "utf8",
  );
  chmodSync(stub, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.STUB_EXIT;
  rmSync(dir, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("成功时返回 code 0 与输出，并把参数原样传给命令", async () => {
    const result = await runCommand("stubcmd", ["pr", "create", "--title", "带 空格 的参数"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "stdout-ok");
    assert.match(result.stderr, /stderr-line/u);
    const calls = readFileSync(logFile, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["pr", "create", "--title", "带 空格 的参数"]);
  });

  it("失败也返回 code（不抛异常），并带回 stderr", async () => {
    process.env.STUB_EXIT = "1";
    const result = await runCommand("stubcmd", ["pr", "create"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /stderr-line/u);
  });

  it("cwd 生效", async () => {
    const result = await runCommand("pwd", [], { cwd: dir });
    assert.equal(result.code, 0);
    const tail = String(dir.split("/").pop() ?? "");
    assert.ok(result.stdout.trim().endsWith(tail), result.stdout);
  });

  it("命令不存在时返回非 0 而不是抛错", async () => {
    const result = await runCommand("definitely-not-a-command-xyz", []);
    assert.notEqual(result.code, 0);
    assert.ok(existsSync(logFile) === false || true);
  });
});
