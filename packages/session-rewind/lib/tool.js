// @ts-check
// 只读 agent 工具 `session_rewind_candidates`：让模型自己看清「能退回到哪几步、退回去会丢什么」。
//
// 设计约束：
//   - 只读：绝不写日志、绝不执行回溯。真正的回退仍由用户点确认框触发（ADR 0006）。
//   - 不 import 宿主包（defineTool 在 @deepseek-ai/dsh-tools 里，插件不能依赖）；这里直接
//     构造 registry 需要的普通对象，`parameters` 与 `output.schema` 都是标准 JSON Schema。
//   - 形状不符就静默跳过：老版本没有 `tools` 服务时，插件其余功能照常工作。
import { hasOpenToolCalls, listCandidatesPage, planRewind } from "./plan.js";

/** 工具名（小写下划线，符合宿主 run_code 之外的自定义工具习惯）。 */
export const TOOL_NAME = "session_rewind_candidates";

/** 一次最多列多少条候选。 */
export const TOOL_MAX_LIMIT = 50;
/** 默认条数。 */
export const TOOL_DEFAULT_LIMIT = 10;

/**
 * 把面向模型的省略描述压成一行。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function oneLine(text, max) {
  const flat = String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(max - 1, 1))}…`;
}

/**
 * 列出可回退的候选消息。
 * @param {any[]} events
 * @param {number[]} surfaceNodes
 * @param {{query?: string, limit?: number}} [options]
 * @returns {{sessionId?: string, total: number, items: Array<{seq: number, time: number, preview: string, text: string}>}}
 */
export function listToolCandidates(events, surfaceNodes, options = {}) {
  const limit =
    Number.isSafeInteger(options.limit) && Number(options.limit) > 0
      ? Math.min(Number(options.limit), TOOL_MAX_LIMIT)
      : TOOL_DEFAULT_LIMIT;
  const page = listCandidatesPage(events, surfaceNodes, {
    limit,
    q: typeof options.query === "string" ? options.query : "",
  });
  return {
    total: page.candidates.length,
    items: page.candidates.map((candidate) => ({
      seq: candidate.seq,
      time: candidate.time,
      preview: oneLine(candidate.preview ?? candidate.text ?? "", 160),
      text: String(candidate.text ?? ""),
    })),
  };
}

/**
 * 评估「退回到这条消息」的影响面：撤回多少条消息、有没有未完成的工具调用。
 * @param {any[]} events
 * @param {number[]} surfaceNodes
 * @param {number} targetSeq
 * @returns {{ok: true, targetSeq: number, removedCount: number, crossesOpenToolCall: boolean, text: string} | {ok: false, error: string}}
 */
export function describeToolImpact(events, surfaceNodes, targetSeq) {
  const plan = planRewind(events, surfaceNodes, targetSeq);
  if ("error" in plan) return { ok: false, error: String(plan.error?.code ?? plan.error) };
  return {
    ok: true,
    targetSeq,
    removedCount: plan.shadowedSeqs.length,
    crossesOpenToolCall: hasOpenToolCalls(events, targetSeq),
    // planRewind 已经把目标消息的文本拼好（`user/message` 的 data 本身就是 message）。
    text: typeof plan.text === "string" ? plan.text : "",
  };
}

/**
 * 构造工具定义（不依赖宿主 defineTool）。
 * @param {{call: (sessionId: string, request: any) => Promise<any>}} host
 * @returns {any}
 */
export function createRewindToolDefinition(host) {
  return {
    name: TOOL_NAME,
    description:
      "List the user messages this conversation can be rewound to, or preview the impact of rewinding to one of them. Read-only: it never rewinds, never edits files and never appends to the session log. The user performs the actual rewind from the UI.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Optional case-insensitive substring filter over message text.",
        },
        limit: {
          type: "integer",
          description: `How many candidates to return (default ${TOOL_DEFAULT_LIMIT}, max ${TOOL_MAX_LIMIT}; clamped).`,
        },
        target_seq: {
          type: "integer",
          description:
            "Preview the impact of rewinding to this message sequence instead of listing candidates.",
        },
      },
    },
    output: {
      // 标准 JSON Schema（宿主的受支持子集）：`required` 必须是字符串数组，
      // 不接受 defineTool 那种 `required: true` 的属性级写法。
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["list", "impact", "error"] },
          session_id: { type: "string" },
          total: { type: "integer" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["seq"],
              properties: {
                seq: { type: "integer" },
                time: { type: "integer" },
                preview: { type: "string" },
              },
            },
          },
          impact: {
            type: "object",
            additionalProperties: false,
            properties: {
              target_seq: { type: "integer" },
              removed_messages: { type: "integer" },
              crosses_open_tool_call: { type: "boolean" },
              text: { type: "string" },
            },
          },
          error: { type: "string" },
        },
      },
      /**
       * @param {any} _args
       * @param {any} value
       * @returns {any[]}
       */
      render: (_args, value) => {
        const lines = [];
        if (value?.error) {
          lines.push(`Rewind preview failed: ${value.error}`);
        } else if (value?.kind === "impact" && value.impact) {
          lines.push(
            `Rewinding to message #${value.impact.target_seq} would withdraw ${value.impact.removed_messages} message(s) from the model context.`,
          );
          if (value.impact.crosses_open_tool_call) {
            lines.push(
              "Warning: an unfinished tool call follows this message; rewinding truncates it.",
            );
          }
          if (value.impact.text) lines.push(`Target message: ${oneLine(value.impact.text, 400)}`);
          lines.push("The user must confirm the rewind in the UI; this tool does not perform it.");
        } else {
          const candidates = Array.isArray(value?.candidates) ? value.candidates : [];
          if (candidates.length === 0) {
            lines.push("No messages can be rewound to in this conversation.");
          } else {
            lines.push(
              `Messages this conversation can be rewound to (${candidates.length} shown):`,
            );
            for (const item of candidates) {
              lines.push(`- #${item.seq}: ${oneLine(item.preview, 160)}`);
            }
            lines.push(
              "Call again with target_seq to preview the impact of one message. Rewinding itself is a user action in the UI.",
            );
          }
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    /**
     * @param {any} args
     * @param {any} exec
     * @returns {Promise<any>}
     */
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id;
      if (typeof sessionId !== "string" || sessionId === "") {
        return { kind: "error", error: "no active session" };
      }
      try {
        const payload = await host.call(sessionId, {
          query: typeof args?.query === "string" ? args.query : undefined,
          limit: typeof args?.limit === "number" ? args.limit : undefined,
          targetSeq: typeof args?.target_seq === "number" ? args.target_seq : undefined,
        });
        if (payload?.ok !== true) {
          return { kind: "error", error: String(payload?.error ?? "unavailable") };
        }
        return payload.value;
      } catch (error) {
        return {
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * 注册只读工具。`tools` 服务缺失或注册失败时静默跳过。
 * @param {{ctx: any, host: {call: (sessionId: string, request: any) => Promise<any>}, logger?: any, onInstalled?: () => void}} input
 * @returns {boolean} 是否注册成功（`tools` 服务就绪时会返回 true）
 */
export function installRewindTool(input) {
  const { ctx, host, logger, onInstalled } = input;
  const install = (/** @type {any} */ scope) => {
    try {
      const tools = scope?.tools ?? scope?.get?.("tools");
      if (!tools || typeof tools.register !== "function") return;
      const definition = createRewindToolDefinition(host);
      const disposer = tools.register(definition);
      scope?.effect?.(() => disposer, "session-rewind: read-only tool");
      if (typeof onInstalled === "function") onInstalled();
      return true;
    } catch (error) {
      logger?.warn?.(
        `session-rewind: failed to register ${TOOL_NAME}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["tools"], install);
      return true;
    }
    const tools = ctx.get?.("tools");
    if (tools && typeof tools.register === "function") {
      install({ tools, effect: ctx.effect?.bind(ctx) });
      return true;
    }
    return false;
  } catch (error) {
    logger?.warn?.(
      `session-rewind: cannot install ${TOOL_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
