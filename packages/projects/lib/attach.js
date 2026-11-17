// @ts-check
// 把一个已归属项目的会话接上项目上下文。
// 这个模块**故意不 import 任何 @deepseek-ai/\***（宿主的包只在运行时可用），
// 这样它能在 node --test 里直接单测。
import { PROJECT_CONTEXT_ORDER, renderProjectContext } from "./context.js";
import { readProjectFiles } from "./project-files.js";

/** @typedef {import("./store.js").ProjectStore} ProjectStore */

/**
 * 给一个 agent 装上项目上下文；返回 disposer 与渲染文本（不注册时 text 仍可用于诊断）。
 * 独立成导出函数便于单测（不依赖 Cordis）。
 * @param {ProjectStore|undefined} store
 * @param {string} dataRoot
 * @param {{id?: string, ctx?: any}} agent
 * @returns {{dispose: () => void, text: string} | undefined}
 */
export function attachProjectContext(store, dataRoot, agent) {
  const sessionId = agent?.id;
  if (typeof sessionId !== "string" || sessionId === "" || !store) return undefined;
  const project = store.projectOfSession(sessionId);
  if (project?.state !== "active") return undefined;

  const files = readProjectFiles(dataRoot, project.id);
  const text = renderProjectContext({
    project,
    instructions: files.instructions,
    memoryIndex: files.memoryIndex,
  });
  if (text === "") return undefined;

  const systemPrompt = agent?.ctx?.systemPrompt;
  if (typeof systemPrompt?.context !== "function") {
    return { dispose: () => {}, text };
  }
  const dispose = systemPrompt.context({
    name: "projects",
    order: PROJECT_CONTEXT_ORDER,
    text,
    // 项目上下文是运行前提，不允许被"关闭可选上下文"静默丢掉
    required: true,
    // 文本里全是项目自己的措辞，不做变量插值
    interpolate: false,
  });
  return { dispose: typeof dispose === "function" ? dispose : () => {}, text };
}
