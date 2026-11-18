// @ts-check
// core/manifest.js：REA 能力清单与契约测试用的纯逻辑。
//
// 为什么需要它（spec/04-plan.md 风险表第一条）：
//   REA 两个月从 207 涨到 255 个工具，社区插件都在硬编码数字。
//   casefile 只依赖「少数关键工具」，用清单 + 运行时 diff 替代版本号判断。

import { sha256Text } from "./digest.js";

/** MCP 工具名前缀（REA 官方 setup / 社区桥都用这个命名）。 */
export const REA_TOOL_PREFIX = "mcp__rea__";

/**
 * casefile 在 M0–M2 真正依赖的 REA 工具。
 * 任何一条缺失都意味着对应能力降级，而不是插件坏掉。
 */
export const REQUIRED_REA_TOOLS = /** @type {const} */ ([
  "open_binary",
  "close_binary",
  "record_unknown",
  "update_unknown",
  "export_evidence_bundle",
  "import_evidence_bundle",
]);

/** 可选增强：缺了只影响某些目标类型或某些 checker。 */
export const OPTIONAL_REA_TOOLS = /** @type {const} */ ([
  "inspect_web_page",
  "observe_web_session",
  "capture_browser_scenario",
  "compare_web_captures",
  "compare_web_screenshots",
  "inspect_web_network_capture",
  "compare_process_captures",
  "compare_artifacts",
  "compare_functions",
  "build_reconstruction_obligation_ledger",
  "evaluate_reconstruction_coverage",
  "verify_reconstruction",
  "check_build_task",
  "inspect_playwright_trace",
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isReaTool(name) {
  return typeof name === "string" && name.startsWith(REA_TOOL_PREFIX);
}

/**
 * 把工具名列表化简成裸名（去掉 `mcp__rea__` 前缀）。
 * @param {readonly string[]} names
 * @returns {string[]}
 */
export function bareReaToolNames(names) {
  return names
    .filter(isReaTool)
    .map((name) => name.slice(REA_TOOL_PREFIX.length))
    .sort();
}

/**
 * 运行时能力探测：给定当前可见工具名，算出具备/缺失。
 * @param {readonly string[]} visibleNames
 * @returns {{ present: string[], missingRequired: string[], missingOptional: string[], availableReaTools: number, capabilityHash: string }}
 */
export function diffCapabilities(visibleNames) {
  const bare = new Set(bareReaToolNames(visibleNames));
  const present = [...REQUIRED_REA_TOOLS, ...OPTIONAL_REA_TOOLS].filter((name) => bare.has(name));
  const missingRequired = REQUIRED_REA_TOOLS.filter((name) => !bare.has(name));
  const missingOptional = OPTIONAL_REA_TOOLS.filter((name) => !bare.has(name));
  const capabilityHash = sha256Text(bareReaToolNames(visibleNames).join("\n")).slice(0, 32);
  return {
    present,
    missingRequired,
    missingOptional,
    availableReaTools: bare.size,
    capabilityHash,
  };
}

/**
 * 人类可读的诊断结论。
 * @param {ReturnType<typeof diffCapabilities>} diff
 * @returns {{ ok: boolean, level: "ok" | "degraded" | "missing", message: string }}
 */
export function gradeCapabilities(diff) {
  if (diff.availableReaTools === 0) {
    return {
      ok: false,
      level: "missing",
      message:
        "没有检测到 mcp__rea__* 工具：REA 尚未接进当前 DSH。先装 REA（rea-agents）并把它注册为 MCP 服务器，再重启 Harness。",
    };
  }
  if (diff.missingRequired.length > 0) {
    return {
      ok: false,
      level: "degraded",
      message: `REA 已连接，但缺少 casefile 依赖的工具：${diff.missingRequired.join("、")}。升级 rea-agents 后重试。`,
    };
  }
  if (diff.missingOptional.length > 0) {
    return {
      ok: true,
      level: "degraded",
      message: `REA 已连接（${diff.availableReaTools} 个工具）。可选能力缺失 ${diff.missingOptional.length} 项，对应 checker 会降级。`,
    };
  }
  return {
    ok: true,
    level: "ok",
    message: `REA 已连接（${diff.availableReaTools} 个工具），casefile 依赖的能力齐全。`,
  };
}
