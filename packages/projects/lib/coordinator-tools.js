// @ts-check
// 协调器工具「挂到 agent 作用域」的唯一实现（不依赖宿主包，可单测）。
//
// 为什么单独抽模块（B2 复审 P0）：`attachCoordinatorTools` 曾经在 service 里，而 service 顶部
// import 了 `@deepseek-ai/dsh-typert-protocol`（仓库里没有这个包，运行时由宿主注入），
// 所以「工具到底有没有注册上」在 node --test 里根本没法验证——于是它悄悄变成零调用者的死代码，
// `project_thread_start` / `project_request_action` / `project_memory_*` 运行时不存在。
// 抽出来之后：
//   1. 注册失败/成功都必须走 onAudit（宿主默认不显示插件日志，装不上要写进审计）；
//   2. 可以在单测里用假 `agent.ctx.tools.register` 把「6 个工具都注册了」钉死。
import { buildCoordinatorTools } from "./tools.js";

/**
 * @typedef {object} MountResult
 * @property {boolean} attached 是否已全部注册
 * @property {number} count 注册成功的工具数
 * @property {(() => void)[]} disposers 清理函数
 * @property {string} reason 失败原因（成功为空串）
 */

/**
 * 把协调器工具注册进指定 agent 的 scope。
 * **永远不抛**：失败转成 `{ attached:false, reason }` 并回调 onAudit（调用方据此写审计）。
 * @param {object} input
 * @param {any} input.agent 协调器 agent（取 `agent.ctx.tools`）
 * @param {import("./tools.js").CoordinatorDeps} input.deps
 * @param {(result: MountResult) => void} [input.onAudit]
 * @returns {MountResult}
 */
export function mountCoordinatorTools(input) {
  const agent = input?.agent;
  const tools = agent?.ctx?.tools;
  /** @param {MountResult} result */
  const report = (result) => {
    try {
      input?.onAudit?.(result);
    } catch {
      /* 审计写不进去也不能影响注册结果 */
    }
    return result;
  };
  if (!tools || typeof tools.register !== "function") {
    return report({ attached: false, count: 0, disposers: [], reason: "no-tools-service" });
  }
  /** @type {(() => void)[]} */
  const disposers = [];
  try {
    const definitions = buildCoordinatorTools(input?.deps ?? /** @type {any} */ ({}));
    for (const definition of definitions) {
      const dispose = tools.register(definition);
      if (typeof dispose === "function") disposers.push(dispose);
    }
    return report({ attached: true, count: definitions.length, disposers, reason: "" });
  } catch (error) {
    // 注册了一半就抛：把已经挂上的先摘掉，避免作用域里留半套工具
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    const reason = String(/** @type {any} */ (error)?.message ?? error).slice(0, 200);
    return report({ attached: false, count: 0, disposers: [], reason });
  }
}
