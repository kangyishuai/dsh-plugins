// @ts-check
// core/provenance.js：把"当时用的哪套工具"锚进项目。
//
// 为什么需要：案卷的价值在于半年后别人还能复算。只写"我跑过 REA"不够——
// 要记下 REA 版本和当时的工具面（capability hash）。工具面变了，同样的
// 结论可能不再可复现。
//
// 版本从哪来：宿主没有暴露 MCP 服务器版本，所以从用户 profile 的 patch 文件里
// 解析 `rea-agents@x.y.z`（那是实际被启动的那个包）；解析不到就留 null 并说明，
// 不猜。

import { createHash } from "node:crypto";

/**
 * 从 cordis patch 文本里解析 REA 版本（`rea-agents@1.2.3` 或 `npx -y rea-agents@1.2.3`）。
 * @param {string} text
 * @returns {string | null}
 */
export function parseReaVersion(text) {
  if (typeof text !== "string" || text === "") return null;
  const match = text.match(/rea-agents(?:@|\/)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/u);
  return match ? match[1] : null;
}

/**
 * 从已安装的 rea-agents package.json 文本里取版本。
 * @param {string} text
 * @returns {string | null}
 */
export function parsePackageVersion(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    const value = JSON.parse(text);
    const version = value?.version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

/**
 * 工具面哈希：同一套工具（名字集合）得到同一个值。
 * 只取名字，不取描述——描述会随版本微调，名字集合才是"能不能做这件事"的边界。
 * @param {readonly string[]} toolNames
 * @returns {string}
 */
export function capabilityHash(toolNames) {
  const names = [...new Set(toolNames.map((name) => String(name)))].sort();
  return createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 16);
}

/**
 * 组装项目溯源：REA 版本 + 工具面哈希 + 探测时间。
 * @param {{ toolNames?: readonly string[], reaVersion?: string | null }} input
 * @returns {{ reaVersion: string | null, capabilityHash: string, reaToolCount: number, probedAt: string }}
 */
export function buildProvenance(input) {
  const names = Array.isArray(input.toolNames) ? input.toolNames : [];
  return {
    reaVersion:
      typeof input.reaVersion === "string" && input.reaVersion !== "" ? input.reaVersion : null,
    capabilityHash: capabilityHash(names),
    reaToolCount: new Set(names).size,
    probedAt: new Date().toISOString(),
  };
}
