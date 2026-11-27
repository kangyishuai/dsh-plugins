// @ts-check
// 数据根下的两种写盘原语：**单行追加**与**整份原子替换**。
//
// 为什么单独一个模块（审计 AUD-ADV-01 / 02 / §4）：
//   - 盘上数据的正确性只取决于两件事：一次写要么完整、要么不发生；同一文件的写者要排队。
//     `readFile` 后 `writeFile` 覆盖是最坏组合（既非原子、又把并发读到的旧内容写回去）。
//   - btw 的 history/settings 与 advisor 的 budget/settings 各自实现过一版 temp+rename，
//     再复制第三次就会漂移，所以这里收敛成一份。
//
// 取舍：
//   - 追加用 `appendFile`（POSIX O_APPEND，单行 <4 KiB 的写入不会被撕开）；崩溃最多留下
//     最后一行半截，读取侧本来就跳过坏行。
//   - 整份替换用「同目录唯一 tmp + rename」：rename 在同一文件系统内是原子的。
//   - 进程内用 per-path 串行队列；跨进程没有锁（同一数据根只该有一个宿主进程，README 已写明）。

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** per-path 串行队列的尾巴（值总是已 settle 的 promise，不会把错误传下去）。 */
/** @type {Map<string, Promise<void>>} */
const TAILS = new Map();

/**
 * 同一个 path 上的任务按提交顺序串行执行（进程内 single-flight）。
 * 前一个任务失败不会阻塞后一个；失败会照常传回给各自的调用方。
 * @template T
 * @param {string} path
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function serializeByPath(path, task) {
  const previous = TAILS.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  /** @type {Promise<void>} */
  const tail = run.then(
    () => {},
    () => {},
  );
  TAILS.set(path, tail);
  void tail.then(() => {
    if (TAILS.get(path) === tail) TAILS.delete(path);
  });
  return run;
}

/**
 * 原子替换整份文件内容。
 * @param {string} path
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 追加一行 JSON（整份文件的写者排队，避免「读全文 + 覆盖」丢行）。
 * @param {string} path
 * @param {unknown} value
 * @param {{ rotateBytes?: number, rotateTo?: string }} [options] 超过 rotateBytes 时先改名到 rotateTo（默认 `${path}.1`）
 * @returns {Promise<void>}
 */
export function appendJsonLine(path, value, options = {}) {
  return serializeByPath(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const rotateBytes = Number(options.rotateBytes ?? 0) || 0;
    if (rotateBytes > 0) {
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && info.size > rotateBytes) {
        // 滚动失败（例如目标已存在且平台不允许覆盖）不该让本次记录丢掉：继续往旧文件追加。
        await rename(path, options.rotateTo ?? `${path}.1`).catch(() => {});
      }
    }
    await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
  });
}

/**
 * 读一份「一行一个 JSON」的文件；坏行跳过、文件不存在返回空数组。
 * @param {string} path
 * @returns {Promise<any[]>}
 */
export async function readJsonLines(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  /** @type {any[]} */
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") out.push(parsed);
    } catch (_error) {
      /* 跳过坏行：一行脏数据不该毁掉整份账本 */
    }
  }
  return out;
}
