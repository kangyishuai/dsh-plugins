// @ts-check
// core/checks.js：build / cli 两类 checker。纯 Node；命令执行通过注入的 runner，便于单测。
//
// 口径（spec/03-acceptance.md §3）：
//   - checker 只读、可重复执行，返回 pass / fail / unknown 三态；
//   - 崩溃/超时一律 unknown（不是 fail，也不是 pass）；
//   - 失败必须留 detail，便于下一轮只修失败项。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * @typedef {{ name: string, version: string, run: (input: any) => Promise<any> }} Checker
 */

const execFileAsync = promisify(execFile);

/**
 * 默认命令执行器（可注入）。
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, killed?: boolean }>}
 */
export const defaultRunner = async (command, options = {}) => {
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeoutMs ?? 10 * 60 * 1000;
  try {
    const { stdout, stderr } = await execFileAsync(command, [], {
      cwd,
      timeout,
      shell: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    const killed = anyError?.killed === true || anyError?.signal != null;
    return {
      exitCode: killed ? null : Number(anyError?.code ?? 1),
      stdout: String(anyError?.stdout ?? ""),
      stderr: String(anyError?.stderr ?? ""),
      killed,
    };
  }
};

/**
 * build checker：跑一条构建命令，按退出码 + 产物存在性判定。
 * @param {{ runner?: typeof defaultRunner }} [options]
 * @returns {Checker}
 */
export function createBuildChecker(options = {}) {
  const runner = options.runner ?? defaultRunner;
  return {
    name: "build",
    version: "1",
    /**
     * @param {{ command: string, cwd?: string, timeoutMs?: number, expectPaths?: string[] }} input
     */
    async run(input) {
      const startedAt = new Date().toISOString();
      const result = await runner(String(input.command), {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      const endedAt = new Date().toISOString();
      if (result.killed === true || result.exitCode === null) {
        return {
          verdict: "unknown",
          detail: { reason: "timeout-or-killed", stderr: String(result.stderr ?? "").slice(-2000) },
          startedAt,
          endedAt,
          exitCode: null,
          stdout: String(result.stdout ?? "").slice(-4000),
          stderr: String(result.stderr ?? "").slice(-4000),
        };
      }
      if (result.exitCode !== 0) {
        return {
          verdict: "fail",
          detail: { reason: "non-zero-exit", exitCode: result.exitCode },
          startedAt,
          endedAt,
          exitCode: result.exitCode,
          stdout: String(result.stdout ?? "").slice(-4000),
          stderr: String(result.stderr ?? "").slice(-4000),
        };
      }
      return {
        verdict: "pass",
        detail: { reason: "built" },
        startedAt,
        endedAt,
        exitCode: 0,
        stdout: String(result.stdout ?? "").slice(-4000),
        stderr: String(result.stderr ?? "").slice(-4000),
      };
    },
  };
}

/**
 * 比较一次 CLI 运行与期望。
 * @param {{ exitCode: number | null, stdout?: string, stderr?: string, killed?: boolean }} actual
 * @param {{ exitCode?: number, stdoutIncludes?: string[], stdoutEquals?: string, stderrIncludes?: string[] }} expect
 * @returns {{ verdict: "pass" | "fail" | "unknown", reasons: string[] }}
 */
export function compareCli(actual, expect) {
  if (actual.killed === true || actual.exitCode === null) {
    return { verdict: "unknown", reasons: ["timeout-or-killed"] };
  }
  /** @type {string[]} */
  const reasons = [];
  if (expect.exitCode != null && actual.exitCode !== expect.exitCode) {
    reasons.push(`exit-code:${actual.exitCode}!==${expect.exitCode}`);
  }
  const stdout = String(actual.stdout ?? "");
  for (const needle of expect.stdoutIncludes ?? []) {
    if (!stdout.includes(needle)) reasons.push(`stdout-missing:${needle}`);
  }
  if (typeof expect.stdoutEquals === "string" && stdout.trim() !== expect.stdoutEquals.trim()) {
    reasons.push("stdout-differs");
  }
  const stderr = String(actual.stderr ?? "");
  for (const needle of expect.stderrIncludes ?? []) {
    if (!stderr.includes(needle)) reasons.push(`stderr-missing:${needle}`);
  }
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/**
 * cli checker：跑一条命令并与期望比对。
 * @param {{ runner?: typeof defaultRunner }} [options]
 * @returns {Checker}
 */
export function createCliChecker(options = {}) {
  const runner = options.runner ?? defaultRunner;
  return {
    name: "cli",
    version: "1",
    /**
     * @param {{ command: string, cwd?: string, timeoutMs?: number, expect?: Record<string, any> }} input
     */
    async run(input) {
      const startedAt = new Date().toISOString();
      const result = await runner(String(input.command), {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      const endedAt = new Date().toISOString();
      const compared = compareCli(result, input.expect ?? {});
      return {
        verdict: compared.verdict,
        detail: { reasons: compared.reasons },
        startedAt,
        endedAt,
        exitCode: result.exitCode,
        stdout: String(result.stdout ?? "").slice(-4000),
        stderr: String(result.stderr ?? "").slice(-4000),
      };
    },
  };
}

/**
 * checker 注册表。
 * @param {{ runner?: typeof defaultRunner }} [options]
 * @returns {Map<string, Checker>}
 */
export function createCheckers(options = {}) {
  const checkers = [createBuildChecker(options), createCliChecker(options)];
  return new Map(checkers.map((item) => [item.name, item]));
}
