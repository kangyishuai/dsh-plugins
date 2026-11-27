// @ts-check
// 旁问的执行体：fork 一个只读子代理、拿回文本与用量、随后归档。
// 依据实测（notes/btw/experiment-cache-prefix.md）：
//   - 第三方插件拿不到带 adapter 的 llm 实例，必须走 fork 子代理；
//   - fork 子代理复用主会话前缀缓存（57%→94%），写缓存 0；
//   - Agent 只能从调用上下文取（exec.agent / invocation.agent）**做工具调用归属**，
//     但 `ctx.agents.get(childId)` 本身是活代理表的普通查表（宿主 dsh-agent AgentRegistry.get
//     就是 `store.get(id)?.agent`），子代理在 `startActivation` 返回前已经注册，所以拿得到；
//     它的 `agent.ctx` 是**该子代理自己的 scope ctx**（dsh-agent-loop: createScope(loopCtx, this)），
//     只读 guard 必须挂在这个 ctx 上，见 resolveGuardTools 的说明。
import { clip, LIMITS } from "./limits.js";
import { buildSideQuestionPrompt } from "./prompts.js";

/** @typedef {{ inputTokens: number, cacheReadTokens: number, outputTokens: number, totalTokens: number }} Usage */

/**
 * 尽力告警（没有 logger 或 logger 抛错都不影响旁问）。
 * @param {any} ctx
 * @param {string} message
 * @returns {void}
 */
function warn(ctx, message) {
  try {
    const logger = ctx?.logger;
    if (typeof logger?.warn === "function") logger.warn(message);
  } catch {
    /* 日志失败不影响旁问 */
  }
}

/**
 * 在 llm/stream waterfall 上做纯观察，记录每个会话最后一次请求的 usage。
 * 不需要 adapter，也不会参与会话写入（只读转发每个 chunk）。
 *
 * 内存卫生（AUD-BTW-08）：旁问只用自己子会话的条目（`runSideQuestion` 的 finally 会删），
 * 这里再按最近使用保留上限条，避免流经观察器的会话把 Map 撑成只增不删。
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
        // 先删再插：Map 插入序即最近使用序，热会话不会被当成最旧淘汰。
        bySession.delete(sessionId);
        bySession.set(sessionId, {
          inputTokens: Number(usage.inputTokens ?? 0),
          cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          totalTokens: Number(usage.totalTokens ?? 0),
        });
        while (bySession.size > LIMITS.usageSessions) {
          const oldest = bySession.keys().next().value;
          if (oldest === undefined) break;
          bySession.delete(oldest);
        }
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
 * 只读 guard 的**唯一**挂载点：子代理自己的 `ctx.tools`。
 *
 * 为什么不能退回插件自己的 ctx（0.6.3 及以前是 `child?.ctx?.tools ?? ctx?.tools`）：
 * - 宿主 `tools.guard(guard)` 的实现是 `guards.effect(this.ctx, …)`，文档写明
 *   「Register a monotonic denial **in the calling scope**」；`this.ctx` 由 Cordis 的
 *   traceable proxy 取**调用点**的 ctx，所以 `child.ctx.tools.guard(...)` 落在子代理的 scope 层。
 * - `checkGuards(exec)` 只遍历 `[guards.global, ...guards.chainLayers(exec.agent)]`，
 *   所以子代理 scope 上的 guard 只拦这个子代理（以及它自己的子代理）。
 * - 插件自己的 ctx 没有 scope → `scopeOf(ctx)` 为 undefined → 落到 **global 层**，会拒绝
 *   **整个宿主进程里所有 agent** 的工具调用（旁问运行期间其它会话/agent teams 全部被拒）。
 *   因此取不到子代理 ctx 时宁可不挂 guard（提示词仍然禁止用工具），也不能全局兜底。
 * @param {any} child 宿主活代理表里的子代理（`ctx.agents.get(childId)`）
 * @returns {{ guard: (guard: (execution: any) => string | undefined) => any } | undefined}
 */
export function resolveGuardTools(child) {
  const tools = child?.ctx?.tools;
  return typeof tools?.guard === "function" ? tools : undefined;
}

/**
 * 正常 settle 的分类（纯函数，便于单测；不改动结果里的文本）。
 * @param {{ stopReason?: unknown, outerAborted?: boolean, text?: unknown, truncated?: boolean }} input
 * @returns {{ ok: boolean, status: string, code?: string }}
 */
export function classifySettle(input) {
  if (String(input?.stopReason ?? "") === "aborted") {
    return { ok: false, status: input?.outerAborted === true ? "cancelled" : "timeout" };
  }
  if (String(input?.text ?? "") === "") {
    return { ok: false, status: "failed", code: "empty_answer" };
  }
  return { ok: true, status: input?.truncated === true ? "truncated" : "done" };
}

/**
 * 异常路径的分类：外层取消 → cancelled，内部超时 → timeout，其余算 fork 失败。
 * @param {{ aborted?: boolean, outerAborted?: boolean }} input
 * @returns {{ ok: boolean, status: string, code?: string }}
 */
export function classifySettleError(input) {
  if (input?.aborted === true) {
    return { ok: false, status: input?.outerAborted === true ? "cancelled" : "timeout" };
  }
  return { ok: false, status: "failed", code: "fork_failed" };
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
 * @returns {Promise<{ ok: boolean, text: string, status: string, childId?: string, usage?: Usage, ms: number, code?: string, guardScope: "child" | "none" }>}
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
    return {
      ok: false,
      text: "",
      status: "failed",
      code: "subagents_unavailable",
      ms: 0,
      guardScope: "none",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.totalMs);
  const outer = input.signal;
  const onOuterAbort = () => controller.abort();
  // 已经取消的 signal 再加监听器不会触发，必须显式检查（否则用户取消的旁问还会跑）。
  if (outer?.aborted === true) controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  /** @type {any} */
  let activation;
  let releaseGuard;
  /** @type {"child" | "none"} */
  let guardScope = "none";
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

    // 只读保护只挂子代理自己的 ctx（见 resolveGuardTools 的长注释）。
    // 取不到就**不挂**：退回插件 ctx 会把 guard 落到全局层、误伤所有会话。
    try {
      const tools = resolveGuardTools(ctx?.agents?.get?.(activation?.childId));
      if (tools !== undefined) {
        releaseGuard = tools.guard(makeReadOnlyGuard(allowedTools));
        guardScope = "child";
      } else {
        // 不静默降级：README 说只读是运行期强制的，真降级了要能在日志里看到。
        warn(ctx, "[btw] read-only guard not armed: side-question child context is unavailable");
      }
    } catch (error) {
      // guard 挂不上不致命：提示词仍禁止用工具，且 fork 时不额外放行工具
      warn(ctx, `[btw] read-only guard not armed: ${String(error)}`);
    }

    const settled = await activation?.result;
    const clipped = clip(extractText(settled), LIMITS.answerChars);
    const usage = usageBySession?.get(String(activation?.childId ?? ""));
    const verdict = classifySettle({
      stopReason: settled?.stopReason,
      outerAborted: outer?.aborted === true,
      text: clipped.text,
      truncated: clipped.truncated,
    });
    return {
      ...verdict,
      text: clipped.text,
      childId: activation?.childId,
      usage,
      ms: now() - startedAt,
      guardScope,
    };
  } catch (_error) {
    const verdict = classifySettleError({
      aborted: controller.signal.aborted,
      outerAborted: outer?.aborted === true,
    });
    return {
      ...verdict,
      text: "",
      childId: activation?.childId,
      ms: now() - startedAt,
      guardScope,
    };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
    try {
      releaseGuard?.();
    } catch {
      /* 释放失败不影响结果 */
    }
    const childId = activation?.childId;
    if (typeof childId === "string" && childId !== "") {
      // 用量表只服务这一次旁问：结束即删，长时间运行的宿主不会按会话数线性增长（AUD-BTW-08）。
      try {
        usageBySession?.delete?.(childId);
      } catch {
        /* 清理失败不影响结果 */
      }
    }
    // 归档子会话，避免旁问淹没会话列表（R1 已验证 archiveSession 可用）。
    // workspaceRegistry 由调用方注入后传入：直接用 ctx.workspaceRegistry 会抛
    // "cannot get property workspaceRegistry without inject"（真机冒烟抓到）。
    if (typeof childId === "string" && typeof workspaceRegistry?.archiveSession === "function") {
      try {
        await workspaceRegistry.archiveSession(childId, { stopActivity: true });
      } catch {
        /* 归档失败不改变旁问结果；README 已说明可能留下子会话 */
      }
    }
  }
}
