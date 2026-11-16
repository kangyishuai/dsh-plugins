// @ts-check
// 路径解析：所有函数接受显式 dataRoot，便于在 mkdtemp 里测试。
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 会话 id 的传输安全形态，拒绝 "." ".." 与路径分隔符。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/u;

/**
 * 解析数据根。优先级：配置 dataRoot → 环境变量 DSH_HOME → ~/.dsh。
 * 不创建目录（创建由调用方负责）。
 * @param {{ dataRoot?: unknown } | undefined} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveDataRoot(config, env = process.env, home = homedir()) {
  const configured = typeof config?.dataRoot === "string" ? config.dataRoot.trim() : "";
  if (configured) return resolve(configured);
  const fromEnv = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(home, ".dsh"));
}

/** @param {string} dataRoot @returns {string} */
export function btwRoot(dataRoot) {
  return join(dataRoot, "btw");
}

/**
 * 一个父会话的历史文件路径。父会话 id 不安全时返回 undefined（不落盘）。
 * @param {string} dataRoot
 * @param {string} parentSessionId
 * @returns {string | undefined}
 */
export function historyFile(dataRoot, parentSessionId) {
  const id = String(parentSessionId ?? "");
  if (!SAFE_ID.test(id)) return undefined;
  return join(btwRoot(dataRoot), `${id}.jsonl`);
}
