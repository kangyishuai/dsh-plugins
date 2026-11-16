// @ts-check
// host 半：在 DSH 的 Node 进程里运行，可以使用 ctx 上的宿主服务。
// M1 已完成：可注入数据根的项目仓储（lib/store.js）。
// 下一步：项目级上下文注入、Remote Service、客户端面板。
import { join } from "node:path";

import { ProjectStore } from "./store.js";

export const name = "projects";

/**
 * 数据根必须可注入：优先配置项，其次进程环境给的 DSH_HOME。
 * 不在模块顶层解析（硬性约定 7）。
 * @param {Record<string, unknown>|undefined} config
 * @returns {string}
 */
export function resolveDataRoot(config) {
  const configured = config?.dataRoot;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home !== "") return join(home, "projects");
  throw new Error("projects: no data root; set config.dataRoot or export DSH_HOME");
}

/**
 * @param {DSH.HostContext} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  /** @type {ProjectStore|undefined} */
  let store;
  try {
    store = new ProjectStore({ root: resolveDataRoot(config) }).load();
  } catch (error) {
    // 降级：仓储不可用时插件保持静默，不阻断宿主启动
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(`[${name}] store unavailable: ${message}`);
    return;
  }
  const count = store.listProjects().length;
  ctx.logger?.info?.(`[${name}] loaded ${count} project(s) from ${store.file}`);
}

export default apply;
