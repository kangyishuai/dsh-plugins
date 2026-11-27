// @ts-check
// web 冒烟失败时的共性收尾：留现场 + 给可操作的下一步。
//
// docs/plugin-conventions.md §6.4：断言失败的价值等于它留下的证据量。临时 DSH_HOME 里有
// host.log、profile 与插件设置，是唯一现场，所以失败分支必须保留它并把宿主日志尾部打出来。
//
// 另：ego 的 TaskSpace 每个任务空间只有 8 个 Page 额度；失败/超时没 finish 的脚本会把
// 额度占满，后续 web 冒烟会整段卡到超时（本轮回归实测）。这里统一给清理工具的名字。

import { readFile } from "node:fs/promises";
import { finishAgentTaskSpace } from "./ego-task-space.mjs";

/** TaskSpace 额度耗尽 / 连续超时时的可操作提示。 */
export const TASK_SPACE_HINT =
  "若是页面额度耗尽（Page budget reached）或多次失败后连续超时：先跑 `node scripts/ego-cleanup.mjs` 预览 agent 遗留的 TaskSpace（默认 dry-run、不碰用户 space），确认后加 `--apply` 清理，再重跑。";

/**
 * 外部超时（Node 侧 kill 掉 ego-browser）时的兜底：按名字回收本次冒烟自己的 TaskSpace。
 * 浏览器脚本里的 try/finally 覆盖不到 SIGTERM，所以这一步必须在 Node 侧补。
 * @param {string} name 与 browserScript 里 taskSpace(...) 的名字一致
 * @returns {Promise<void>}
 */
export async function reclaimTimedOutTaskSpace(name) {
  const result = await finishAgentTaskSpace(name);
  if (result.ok && result.found) {
    console.log(`浏览器脚本超时：已回收遗留 TaskSpace「${name}」（#${result.id}）`);
  } else {
    console.log(
      `浏览器脚本超时：没能自动回收 TaskSpace「${name}」${result.error ? `（${result.error}）` : ""}；` +
        "若后续冒烟连续超时，先跑 `node scripts/ego-cleanup.mjs` 预览，再加 `--apply` 清理。",
    );
  }
}

/**
 * 打印 TaskSpace 泄漏提示（只在浏览器脚本没返回结果/超时时调用）。
 * @returns {void}
 */
export function reportBrowserFailureHint() {
  console.error(`提示：${TASK_SPACE_HINT}`);
}

/**
 * 读 host.log 尾部；文件不存在或读不到时返回空串（不抛）。
 * @param {string} logPath
 * @param {number} [maxChars=4000]
 * @returns {Promise<string>}
 */
export async function readHostLogTail(logPath, maxChars = 4000) {
  try {
    const text = await readFile(logPath, "utf8");
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

/**
 * 失败留现场：把宿主日志尾部打到 stderr，再给 TaskSpace 提示。
 * @param {string} logPath
 * @param {{ maxChars?: number, write?: (text: string) => void }} [options]
 * @returns {Promise<void>}
 */
export async function reportFailureScene(logPath, options = {}) {
  const maxChars = options.maxChars ?? 4000;
  const write = options.write ?? ((text) => console.error(text));
  const tail = await readHostLogTail(logPath, maxChars);
  if (tail === "") write(`（没有可读的 host.log：${logPath}）`);
  else write(`---- host.log 尾部（${logPath}）----\n${tail}`);
}

/**
 * 失败运行判定：fail() 只设 process.exitCode，初值是 undefined（不是 0），
 * 直接 `!== 0` 会把成功也判成失败（smoke:next-step 2026-11 踩过）。
 * @returns {boolean}
 */
export function isFailedRun() {
  return process.exitCode !== undefined && process.exitCode !== 0;
}
