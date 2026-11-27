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

/**
 * 把项目 id 收敛成安全的**单段**目录名（id 会被拼进数据根路径）。
 *
 * 与 `store.isSafeRecordKey` 同口径：只留字母数字与 `_`/`-`，其余字符直接去掉；
 * 去掉后为空时返回 "project"（不返回空串，否则路径会退化成 `workspaces/` 本身）。
 * @param {unknown} projectId
 * @returns {string}
 */
export function workspaceKey(projectId) {
  const cleaned = String(projectId ?? "").replace(/[^A-Za-z0-9_-]/gu, "");
  return cleaned === "" ? "project" : cleaned.slice(0, 120);
}

/**
 * 无目录项目的专用工作区目录：`<dataRoot>/workspaces/<projectId>`。
 *
 * **唯一出口**（审计 AUD-PROJ-01）：协调者 / 定时任务 / 提醒 / 线程四种会话的 cwd
 * 都必须走这里，绝不能回落成插件数据根本身——数据根里有 `projects.json`（全部项目、
 * 线程、审批、审计）、`trash/`（已删数据）以及其它项目的 `instructions.md` 与 `memory/`，
 * 默认权限档是 `danger-full-access`，把数据根当 cwd 等于把整份元数据交给一个 agent。
 * @param {string} dataRoot
 * @param {unknown} projectId
 * @returns {string}
 */
export function projectWorkspaceDir(dataRoot, projectId) {
  const root = String(dataRoot ?? "").replace(/\/+$/u, "");
  return `${root}/workspaces/${workspaceKey(projectId)}`;
}

/**
 * 一个会话（线程 / 协调者 / 定时投递 / 提醒）该用哪个 cwd。
 *
 * 规则：绑了目录（`dirs` 非空）用第一个目录；否则用该项目的专用工作区目录。
 * 以前 4 处各自复制了「无目录 → `this.dataRoot`」的回落，把插件数据根当成会话工作目录
 * （审计 AUD-PROJ-01 的 P1）。统一到这里之后只需测这一个函数 + 源码守卫。
 * @param {{ dirs?: unknown, id?: unknown }} project
 * @param {string} dataRoot
 * @returns {string}
 */
export function projectCwd(project, dataRoot) {
  const dirs = Array.isArray(project?.dirs) ? project.dirs : [];
  for (const dir of dirs) {
    if (typeof dir === "string" && dir.trim() !== "") return dir;
  }
  return projectWorkspaceDir(dataRoot, project?.id);
}
