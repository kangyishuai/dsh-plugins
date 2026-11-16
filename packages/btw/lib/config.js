// @ts-check
// 纯配置解析：不 import 任何宿主包，便于单测直接引用（service.js 会 import 宿主 RPC 协议，
// 在 node --test 里解析不到，所以纯逻辑必须留在这种模块里）。
import { LIMITS } from "./limits.js";

/**
 * 解析允许只读放行的工具白名单。默认空 = 全部拒绝；send_message 永不放行。
 * @param {any} config
 * @returns {Set<string>}
 */
export function parseAllowedTools(config) {
  const raw = config?.allowedTools;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const set = new Set();
  for (const entry of list) {
    const toolName = String(entry ?? "").trim();
    if (toolName === "" || toolName === "send_message") continue;
    set.add(toolName);
    if (set.size >= LIMITS.allowedToolsMax) break;
  }
  return set;
}
