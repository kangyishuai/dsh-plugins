// @ts-check
// 数据根解析（**纯函数**，便于 node --test 直接引用）。
//
// 优先级与 btw / session-delete 一致：config.dataRoot → DSH_HOME（+ /projects）→ ~/.dsh/projects。
//
// 为什么必须有 ~/.dsh 回落：DSH 桌面版的进程环境里**不导出 DSH_HOME**（实测 2026-11-18：
// 主进程 env 只有 HOME），此前这里直接抛错，结果 projects 面板在真实桌面里显示
// `projects: store is unavailable`，只有 web 冒烟（显式设了 DSH_HOME）才是好的。
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 解析 projects 的数据根（`projects.json` 所在目录）。
 * @param {{ dataRoot?: unknown } | Record<string, unknown> | undefined} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveDataRoot(config, env = process.env, home = homedir()) {
  const configured =
    config !== null && typeof config === "object" && "dataRoot" in config
      ? config.dataRoot
      : undefined;
  if (typeof configured === "string" && configured.trim() !== "") return resolve(configured);
  const fromEnv = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (fromEnv !== "") return resolve(join(fromEnv, "projects"));
  return resolve(join(home, ".dsh", "projects"));
}
