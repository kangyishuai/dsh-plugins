// @ts-check
// 旁问的执行体：fork 一个只读子代理、拿回文本与用量、随后归档。
// 依据实测（notes/btw/experiment-cache-prefix.md）：
//   - 第三方插件拿不到带 adapter 的 llm 实例，必须走 fork 子代理；
//   - fork 子代理复用主会话前缀缓存（57%→94%），写缓存 0；
//   - Agent 只能从调用上下文取（exec.agent / invocation.agent），ctx.agents.get() 返回 undefined。
import { clip, LIMITS } from "./limits.js";
import { buildSideQuestionPrompt } from "./prompts.js";

/** @typedef {{ inputTokens: number, cacheReadTokens: number, outputTokens: number, totalTokens: number }} Usage */

/**
 * 在 llm/stream waterfall 上做纯观察，记录每个会话最后一次请求的 usage。
 * 不需要 adapter，也不会参与会话写入（只读转发每个 chunk）。
 * @param {any} ctx
 * @returns {Map<string, Usage>}
 */
export function observeUsage(ctx) {
  /** @type {Map<string, Usage>} */
  const bySession = new Map();
  ctx.on("llm/stream", (/** @type {any} */ options, /** @type {any} */ next) => {
    const inner = next();
    return (async function* () {
      /** @type {any} */
      let usage;
      for await (const chunk of inner) {
        if (chunk?.type === "usage") usage = chunk.usage;
        yield chunk;
      }
      const sessionId = String(options?.sessionId ?? "");
      if (sessionId !== "" && usage !== undefined) {
        bySession.set(sessionId, {
          inputTokens: Number(usage.inputTokens ?? 0),
          cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          totalTokens: Number(usage.totalTokens ?? 0),
        });
      }
    })();
  });
  return bySession;
}

/**
 * 从 fork 子代理的 result 里抽文本（跳过 reasoning 块）。
 * @param {any} result
 * @returns {string}
 */
export function extractText(result) {
  const output = Array.isArray(result?.output) ? result.output : [];
  return output
    .filter((/** @type {any} */ block) => block?.type === "text" && typeof block.text === "string")
    .map((/** @type {any} */ block) => block.text)
    .join("\n")
    .trim();
}

/**
 * 只读 guard：白名单之外一律拒绝；send_message 永不放行。
 * @param {Set<string>} allowedTools
 * @returns {(execution: any) => string | undefined}
 */
export function makeReadOnlyGuard(allowedTools) {
  return (execution) => {
    const toolName = String(execution?.toolName ?? execution?.name ?? execution?.call?.name ?? "");
    if (toolName === "send_message") return "Side questions never message other agents.";
    if (allowedTools.has(toolName)) return undefined;
    return "Side questions are read-only: they cannot use tools.";
  };
}

/**
 * 执行一次旁问。
 * @param {{
 *   ctx: any,
 *   agent: any,
 *   question: string,
 *   history?: any[],
 *   allowedTools?: Set<string>,
 *   signal?: AbortSignal,
 *   usageBySession: Map<string, Usage>,
 *   scope?: string,
 *   provider?: "fork" | "spawn" | string,
 *   prompt?: { type: "text", text: string }[],
 *   workspaceRegistry?: any,
 *   now?: () => number,
 *   onChild?: (childId: string) => void,
 * }} input
 * @returns {Promise<{ ok: boolean, text: string, status: string, childId?: string, usage?: Usage, ms: number, code?: string }>}
 */
export async function runSideQuestion(input) {
  const {
    ctx,
    agent,
    question,
    history = [],
    allowedTools = new Set(),
    usageBySession,
    workspaceRegistry,
  } = input;
  const provider =
    typeof input.provider === "string" && input.provider !== "" ? input.provider : "fork";
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const subagents = ctx?.subagents;
  if (!agent || typeof subagents?.startActivation !== "function") {
    return { ok: false, text: "", status: "failed", code: "subagents_unavailable", ms: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.totalMs);
  const outer = input.signal;
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  /** @type {any} */
  let activation;
  let releaseGuard;
  try {
    activation = await subagents.startActivation({
      provider,
      label: `btw: ${clip(question, 40).text}`,
      prompt:
        Array.isArray(input.prompt) && input.prompt.length > 0
          ? input.prompt
          : buildSideQuestionPrompt(question, history, String(input.scope ?? "")),
      parent: agent,
      signal: controller.signal,
      delivery: "caller",
    });

    // 把子会话 id 尽早交给调用方：面板要靠它在 `llm/stream` 上旁听实时文本。
    // 注意此时子代理的第一次模型请求通常还没开始（网络往返在后面），不会漏 chunk。
    if (typeof input.onChild === "function") {
      try {
        input.onChild(String(activation?.childId ?? ""));
      } catch {
        /* 观察者失败不影响旁问本身 */
      }
    }

    // 只读保护挂在子代理自己的 ctx 上，随子代理释放。
    const child = ctx?.agents?.get?.(activation?.childId);
    const tools = child?.ctx?.tools ?? ctx?.tools;
    try {
      if (typeof tools?.guard === "function")
        releaseGuard = tools.guard(makeReadOnlyGuard(allowedTools));
    } catch {
      // guard 挂不上不致命：提示词仍禁止用工具，且 fork 时不额外放行工具
    }

    const settled = await activation?.result;
    const stopReason = String(settled?.stopReason ?? "");
    const text = extractText(settled);
    const clipped = clip(text, LIMITS.answerChars);
    const usage = usageBySession?.get(String(activation?.childId ?? ""));

    if (stopReason === "aborted") {
      const cancelled = outer?.aborted === true;
      return {
        ok: false,
        text: clipped.text,
        status: cancelled ? "cancelled" : "timeout",
        childId: activation?.childId,
        usage,
        ms: now() - startedAt,
      };
    }
    if (text === "") {
      return {
        ok: false,
        text: "",
        status: "failed",
        code: "empty_answer",
        childId: activation?.childId,
        usage,
        ms: now() - startedAt,
      };
    }
    return {
      ok: true,
      text: clipped.text,
      status: clipped.truncated ? "truncated" : "done",
      childId: activation?.childId,
      usage,
      ms: now() - startedAt,
    };
  } catch (_error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      text: "",
      status: aborted ? (outer?.aborted ? "cancelled" : "timeout") : "failed",
      code: aborted ? undefined : "fork_failed",
      childId: activation?.childId,
      ms: now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
    try {
      releaseGuard?.();
    } catch {
      /* 释放失败不影响结果 */
    }
    // 归档子会话，避免旁问淹没会话列表（R1 已验证 archiveSession 可用）。
    // workspaceRegistry 由调用方注入后传入：直接用 ctx.workspaceRegistry 会抛
    // "cannot get property workspaceRegistry without inject"（真机冒烟抓到）。
    const childId = activation?.childId;
    if (typeof childId === "string" && typeof workspaceRegistry?.archiveSession === "function") {
      try {
        await workspaceRegistry.archiveSession(childId, { stopActivity: true });
      } catch {
        /* 归档失败不改变旁问结果；README 已说明可能留下子会话 */
      }
    }
  }
}
