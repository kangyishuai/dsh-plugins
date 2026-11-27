// @ts-check
// 超时兜底：回收某个 web 冒烟自己的 TaskSpace。
//
// 背景：browserScript 里的 try/finally 能覆盖「断言失败 / 脚本异常」，但**外部超时**是 Node 侧
// `child.kill("SIGTERM")` 直接杀进程，浏览器脚本没有机会跑 finally —— 空间和它开的 Page 会留下，
// 页面额度攒满后后续 web 冒烟整段卡死（本轮回归实测：第一次失败后所有 web 冒烟都 180s 超时）。
//
// 所以 Node 侧检测到超时后，用一次独立的 `ego-browser nodejs` 交互按**名字**找回这个空间并
// `finish({ keep: [] })`。只认 `ownership === "agent"` 的空间，绝不碰用户自己的标签页。

import { spawn } from "node:child_process";

/** @typedef {{ ok: boolean, found: boolean, id: number | null, error: string }} FinishResult */

const MARKER = "EGO_RECLAIM ";

/**
 * 生成按名字回收 TaskSpace 的内层脚本。
 * @param {string} name
 * @returns {string}
 */
export function buildFinishNamedSpaceScript(name) {
  return `(async () => {
const target = ${JSON.stringify(name)};
const spaces = await listTaskSpaces();
const hit = spaces.find((space) => space && space.name === target && space.ownership === "agent");
if (!hit) {
  console.log(${JSON.stringify(MARKER)} + JSON.stringify({ found: false, id: null, target }));
  return;
}
const task = await taskSpace(Number(hit.id));
await task.finish({ keep: [] });
console.log(${JSON.stringify(MARKER)} + JSON.stringify({ found: true, id: Number(hit.id), target }));
})();`;
}

/**
 * 按名字回收一个 agent 拥有的 TaskSpace；失败只返回 { ok: false }，绝不抛（失败不能盖住
 * 冒烟本身的错误）。整体有超时上限：浏览器卡住时这次兜底也不会再拖 180s。
 * @param {string} name
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<FinishResult>}
 */
export async function finishAgentTaskSpace(name, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const source = buildFinishNamedSpaceScript(name);
  /** @type {FinishResult} */
  const result = { ok: false, found: false, id: null, error: "" };
  try {
    const out = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let text = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        text += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        text += String(chunk);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolvePromise(timedOut ? `${text}\nTIMEOUT` : text);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolvePromise(`SPAWN_ERROR ${String(error)}`);
      });
      child.stdin.end(source);
    });
    const at = String(out).indexOf(MARKER);
    if (at < 0) {
      result.error = `回收脚本没有返回标记：${String(out).slice(-500)}`;
      return result;
    }
    const parsed = JSON.parse(
      String(out)
        .slice(at + MARKER.length)
        .split("\n")[0]
        .trim(),
    );
    result.ok = true;
    result.found = parsed.found === true;
    result.id = typeof parsed.id === "number" ? parsed.id : null;
    return result;
  } catch (error) {
    result.error = String(error instanceof Error ? error.message : error).slice(0, 500);
    return result;
  }
}
