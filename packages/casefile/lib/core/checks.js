// @ts-check
// core/checks.js：build / cli 两类 checker。纯 Node；命令执行通过注入的 runner，便于单测。
//
// 口径（spec/03-acceptance.md §3）：
//   - checker 只读、可重复执行，返回 pass / fail / unknown 三态；
//   - 崩溃/超时一律 unknown（不是 fail，也不是 pass）；
//   - 失败必须留 detail，便于下一轮只修失败项。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

import { comparePng } from "./png.js";

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
 * process checker：跑一个进程，判定退出码 / 输出 / 文件副作用。
 * 「副作用」只做存在性与可选哈希，不做模糊比较——没有预期就算 unknown 的边界不成立，
 * 所以调用方必须显式给出 expect，否则只判退出码。
 * @param {{ runner?: typeof defaultRunner }} [options]
 * @returns {Checker}
 */
export function createProcessChecker(options = {}) {
  const runner = options.runner ?? defaultRunner;
  return {
    name: "process",
    version: "1",
    /**
     * @param {{
     *   command: string, cwd?: string, timeoutMs?: number,
     *   expect?: {
     *     exitCode?: number, stdoutIncludes?: string[], stderrIncludes?: string[],
     *     files?: Array<{ path: string, exists?: boolean, sha256?: string }>,
     *   },
     * }} input
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
          detail: { reason: "timeout-or-killed" },
          startedAt,
          endedAt,
          exitCode: null,
          stdout: String(result.stdout ?? "").slice(-4000),
          stderr: String(result.stderr ?? "").slice(-4000),
        };
      }
      const expect = input.expect ?? {};
      /** @type {string[]} */
      const reasons = [];
      if (expect.exitCode != null && result.exitCode !== expect.exitCode) {
        reasons.push(`exit-code:${result.exitCode}!==${expect.exitCode}`);
      }
      const stdout = String(result.stdout ?? "");
      for (const needle of expect.stdoutIncludes ?? []) {
        if (!stdout.includes(needle)) reasons.push(`stdout-missing:${needle}`);
      }
      const stderr = String(result.stderr ?? "");
      for (const needle of expect.stderrIncludes ?? []) {
        if (!stderr.includes(needle)) reasons.push(`stderr-missing:${needle}`);
      }
      for (const file of expect.files ?? []) {
        const exists = existsSync(file.path);
        const want = file.exists !== false;
        if (exists !== want) {
          reasons.push(`file-${want ? "missing" : "unexpected"}:${file.path}`);
          continue;
        }
        if (exists && typeof file.sha256 === "string" && file.sha256 !== "") {
          const actual = sha256OfFile(file.path);
          if (actual !== file.sha256) reasons.push(`file-hash:${file.path}`);
        }
      }
      return {
        verdict: reasons.length === 0 ? "pass" : "fail",
        detail: { reasons, filesChecked: (expect.files ?? []).length },
        startedAt,
        endedAt,
        exitCode: result.exitCode,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      };
    },
  };
}

/**
 * @param {string} path
 * @returns {string}
 */
function sha256OfFile(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return "";
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

/**
 * selfTest checker：跑项目自带的自测，按 JSON 契约判定。
 * 接受两种形状：
 *   { ok: boolean, checks?: Array<{ ok: boolean, name?: string }> }
 *   { passed: boolean, assertions?: Array<{ ok?: boolean, passed?: boolean, name?: string }> }
 * JSON 无法解析 / 形状不符 → unknown（不是 pass）。
 * @param {{ runner?: typeof defaultRunner }} [options]
 * @returns {Checker}
 */
export function createSelfTestChecker(options = {}) {
  const runner = options.runner ?? defaultRunner;
  return {
    name: "selfTest",
    version: "1",
    /**
     * @param {{ command: string, cwd?: string, timeoutMs?: number, jsonPath?: string }} input
     */
    async run(input) {
      const startedAt = new Date().toISOString();
      const result = await runner(String(input.command), {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      const endedAt = new Date().toISOString();
      const raw = String(result.stdout ?? "");
      /** @type {any} */
      let report;
      try {
        const text =
          typeof input.jsonPath === "string" && input.jsonPath !== ""
            ? readFileSync(input.jsonPath, "utf8")
            : raw;
        report = JSON.parse(text);
      } catch (error) {
        return {
          verdict: "unknown",
          detail: { reason: "self-test-report-invalid", message: String(error) },
          startedAt,
          endedAt,
          exitCode: result.exitCode ?? null,
          stdout: raw.slice(-4000),
          stderr: String(result.stderr ?? "").slice(-4000),
        };
      }
      const checks = Array.isArray(report?.checks)
        ? report.checks
        : Array.isArray(report?.assertions)
          ? report.assertions
          : null;
      const declared = typeof report?.ok === "boolean" ? report.ok : report?.passed;
      if (typeof declared !== "boolean" && checks === null) {
        return {
          verdict: "unknown",
          detail: { reason: "self-test-report-shape" },
          startedAt,
          endedAt,
          exitCode: result.exitCode ?? null,
          stdout: raw.slice(-4000),
          stderr: String(result.stderr ?? "").slice(-4000),
        };
      }
      /** @type {string[]} */
      const reasons = [];
      if (declared === false) reasons.push("report-not-ok");
      const failedChecks = (checks ?? []).filter((/** @type {any} */ item) => {
        const ok = typeof item?.ok === "boolean" ? item.ok : item?.passed;
        return ok === false;
      });
      for (const item of failedChecks) reasons.push(`check-failed:${String(item?.name ?? "?")}`);
      return {
        verdict: reasons.length === 0 ? "pass" : "fail",
        detail: { reasons, checks: (checks ?? []).length, failed: failedChecks.length },
        startedAt,
        endedAt,
        exitCode: result.exitCode ?? null,
        stdout: raw.slice(-4000),
        stderr: String(result.stderr ?? "").slice(-4000),
      };
    },
  };
}

/**
 * web checker：比较两张截图（原件 vs 候选）的相似度与尺寸。
 * 采集（截图）由 REA / 浏览器完成；本 checker 只做「判」。
 * @param {any} [options]
 * @returns {Checker}
 */
export function createWebChecker(options = {}) {
  const read = options.readFile ?? ((/** @type {string} */ path) => readFileSync(path));
  return {
    name: "web",
    version: "1",
    /**
     * @param {{
     *   reference: string, candidate: string, minSimilarity?: number,
     *   allowSizeMismatch?: boolean,
     * }} input
     */
    async run(input) {
      const startedAt = new Date().toISOString();
      const minSimilarity = typeof input.minSimilarity === "number" ? input.minSimilarity : 0.98;
      /** @type {Buffer} */
      let reference;
      /** @type {Buffer} */
      let candidate;
      try {
        reference = read(String(input.reference));
        candidate = read(String(input.candidate));
      } catch (error) {
        return {
          verdict: "unknown",
          detail: { reason: "screenshot-missing", message: String(error) },
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: null,
          stdout: "",
          stderr: "",
        };
      }
      /** @type {ReturnType<typeof comparePng>} */
      let compared;
      try {
        compared = comparePng(reference, candidate);
      } catch (error) {
        return {
          verdict: "unknown",
          detail: { reason: "screenshot-invalid", message: String(error) },
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: null,
          stdout: "",
          stderr: "",
        };
      }
      const sizeOk = !compared.sizeMismatch || input.allowSizeMismatch === true;
      const pass = sizeOk && compared.similarity >= minSimilarity;
      /** @type {string[]} */
      const reasons = [];
      if (compared.sizeMismatch && input.allowSizeMismatch !== true) reasons.push("size-mismatch");
      if (compared.similarity < minSimilarity) reasons.push("below-threshold");
      return {
        verdict: pass ? "pass" : "fail",
        detail: {
          reasons,
          similarity: Number(compared.similarity.toFixed(4)),
          minSimilarity,
          meanAbsDiff: Number(compared.meanAbsDiff.toFixed(2)),
          diffPixels: compared.diffPixels,
          totalPixels: compared.totalPixels,
        },
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        stdout: JSON.stringify(compared),
        stderr: "",
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
  const checkers = [
    createBuildChecker(options),
    createCliChecker(options),
    createWebChecker(options),
    createProcessChecker(options),
    createSelfTestChecker(options),
  ];
  return new Map(checkers.map((item) => [item.name, item]));
}
