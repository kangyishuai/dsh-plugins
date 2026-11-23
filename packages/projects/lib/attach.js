// @ts-check
// 把一个已归属项目的会话接上项目上下文。
// 这个模块**故意不 import 任何 @deepseek-ai/\***（宿主的包只在运行时可用），
// 这样它能在 node --test 里直接单测。
import { PROJECT_CONTEXT_ORDER, renderProjectContext } from "./context.js";
import { readProjectFiles } from "./project-files.js";

/** @typedef {import("./store.js").ProjectStore} ProjectStore */

/**
 * 全局注册一个「按会话求值」的项目上下文条目。
 *
 * 为什么不是 per-agent 注册：实测（docs/runtime §11.18）在 `agent/created` 里注册不会进入提示词。
 * 为什么是函数：`refreshContext` 用 `resolveContext`，它会调用 `text(context)`；
 * context 里带当前 agent/session（宿主 sandbox-policy 就是这么用 context.agent?.session 的）。
 *
 * @param {object} deps
 * @param {() => any} deps.getStore
 * @param {() => string} deps.getDataRoot
 * @param {(entry: any) => any} deps.register 实际的 systemPrompt.context 调用
 * @param {(project: any) => string} [deps.renderPersona] 协调器会话的人格文本
 * @param {(sessionId: string, kind: "call"|"unmatched"|"thread"|"coordinator") => void} [deps.onRender] 诊断回调
 * @returns {() => void} disposer
 */
export function registerProjectContext(deps) {
  /**
   * 一次请求渲染「项目上下文 + 协调器人格」。
   * 三种会话都要照顾到：
   *  - 线程会话：注入项目上下文；
   *  - 协调器会话：注入项目上下文 + 人格（人格原来走 per-agent 注册，实测无效，见 runtime §11.18）；
   *  - 其它会话：返回空串，绝不注入（全局条目必须按会话过滤，否则会污染所有会话）。
   * @param {any} context
   * @returns {string}
   */
  const render = (context) => {
    try {
      const store = deps.getStore();
      if (!store) return "";
      const sessionId = String(context?.agent?.session?.id ?? context?.session?.id ?? "");
      if (sessionId === "") return "";

      deps.onRender?.(sessionId, "call");
      const threadProject = store.projectOfSession(sessionId);
      const coordinatorProject = store
        .listProjects()
        .find((/** @type {any} */ item) => item.coordinatorSessionId === sessionId);
      const project = threadProject ?? coordinatorProject;
      // F44：暂停（paused）只停「新建线程 + 定时任务」，**不**停上下文注入——
      // 暂停后再和已有线程对话仍然应该带着项目规则与记忆（以前这里只认 active，
      // 暂停项目一对话上下文就静默消失，是个不容易发现的回归）。
      // 归档（archived）才是真的不再注入：数据还在，但项目已经不在工作集里。
      const injectable = Boolean(project) && project.state !== "archived";
      if (!injectable) {
        deps.onRender?.(sessionId, "unmatched");
        return "";
      }
      deps.onRender?.(sessionId, threadProject ? "thread" : "coordinator");

      const blocks = [];
      if (threadProject) {
        const files = readProjectFiles(deps.getDataRoot(), project.id);
        const text = renderProjectContext({
          project,
          instructions: files.instructions,
          memoryIndex: files.memoryIndex,
        });
        if (text !== "") blocks.push(text);
      } else if (typeof deps.renderPersona === "function") {
        // 协调器：项目上下文 + 人格一起给（人格里已经写明「人格不改变权限」）
        const files = readProjectFiles(deps.getDataRoot(), project.id);
        const text = renderProjectContext({
          project,
          instructions: files.instructions,
          memoryIndex: files.memoryIndex,
        });
        if (text !== "") blocks.push(text);
        const persona = deps.renderPersona(project);
        if (typeof persona === "string" && persona !== "") blocks.push(persona);
      }
      return blocks.join("\n\n");
    } catch {
      // 渲染失败不应该让整个请求失败：退回空串，其它上下文照常
      return "";
    }
  };
  const dispose = deps.register({
    name: "projects",
    order: PROJECT_CONTEXT_ORDER,
    required: false,
    interpolate: false,
    text: render,
  });
  return typeof dispose === "function" ? dispose : () => {};
}
