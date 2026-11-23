// @ts-check
// 子进程调用的薄封装：统一 stdout/stderr/exit code，**永远不抛**（失败也返回 code）。
// 抽出来是为了可测：测试里用 PATH 指向桩脚本，就能验证「调了什么命令、参数是什么」。

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** 默认超时（ms）：gh / git 卡住时不能把轮询的 inFlight 永远占着。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 超时返回的 exit code（沿用 GNU timeout 的约定，便于调用方分辨）。 */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} CommandResult
 */

/**
 * 跑一条命令（argv 数组，**不经 shell**）。
 * 默认 30s 超时（P2 复审）：gh 卡住（网络/凭据弹窗/大仓库）会让 `pollPrs` 的 inFlight
 * 永久为 true —— 之后每一轮轮询都被 `skipped: in-flight` 吞掉，面板上看起来"轮询开着但不更新"。
 * 超时按 `code:124` 返回，**不抛**，调用方按失败分支处理。
 * @param {string} command 可执行文件名（走 PATH）或绝对路径
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<CommandResult>}
 */
export async function runCommand(command, args, options) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && Number(options?.timeoutMs) > 0
      ? Number(options?.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFile(command, args ?? [], {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    // execFile 超时：error.killed === true，code 可能是 null / "ETIMEDOUT"
    const timedOut = anyError?.killed === true || anyError?.code === "ETIMEDOUT";
    if (timedOut) {
      return {
        code: TIMEOUT_EXIT_CODE,
        stdout: String(anyError?.stdout ?? ""),
        stderr: `timeout after ${timeoutMs}ms`,
      };
    }
    return {
      code: Number(anyError?.code ?? 1),
      stdout: String(anyError?.stdout ?? ""),
      stderr: String(anyError?.stderr ?? anyError?.message ?? ""),
    };
  }
}
