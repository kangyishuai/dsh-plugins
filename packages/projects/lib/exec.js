// @ts-check
// 子进程调用的薄封装：统一 stdout/stderr/exit code，**永远不抛**（失败也返回 code）。
// 抽出来是为了可测：测试里用 PATH 指向桩脚本，就能验证「调了什么命令、参数是什么」。

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} CommandResult
 */

/**
 * 跑一条命令（argv 数组，**不经 shell**）。
 * @param {string} command 可执行文件名（走 PATH）或绝对路径
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<CommandResult>}
 */
export async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFile(command, args ?? [], {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    return {
      code: Number(anyError?.code ?? 1),
      stdout: String(anyError?.stdout ?? ""),
      stderr: String(anyError?.stderr ?? anyError?.message ?? ""),
    };
  }
}
