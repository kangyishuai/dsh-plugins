// @ts-check
// 模型工具的两段式控制器：先 plan 拿一次性 token，再 delete。
// 只做状态机与校验，不直接依赖 @deepseek-ai/*，方便单测。
import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 120_000;

/**
 * @param {object} options
 * @param {{ plan: (sessionId: string) => Promise<any>, trash: (sessionId: string, request: any) => Promise<any> }} options.ops
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 */
export function createAgentToolController({ ops, now = Date.now, ttlMs = DEFAULT_TTL_MS }) {
  /** @type {Map<string, { sessionId: string, digest: string, cascade: boolean, expiresAt: number }>} */
  const tokens = new Map();

  /** @param {string} token */
  function takeToken(token) {
    const entry = tokens.get(token);
    if (!entry) return { error: "invalid-token" };
    tokens.delete(token);
    if (entry.expiresAt < now()) return { error: "token-expired" };
    return { entry };
  }

  /**
   * 第一步：只读预览 + 发 token。
   * @param {{ sessionId: string, cascade?: boolean }} args
   */
  async function plan(args) {
    const plan = await ops.plan(args.sessionId);
    if (plan.blockers.length > 0) {
      return {
        ok: false,
        code: "blocked",
        sessionId: plan.sessionId,
        blockers: plan.blockers,
      };
    }
    const token = randomUUID();
    tokens.set(token, {
      sessionId: plan.sessionId,
      digest: plan.digest,
      cascade: args.cascade === true,
      expiresAt: now() + ttlMs,
    });
    // 简单上限，防止模型反复 plan 把内存撑大
    while (tokens.size > 32) {
      const oldest = tokens.keys().next().value;
      if (oldest === undefined) break;
      tokens.delete(oldest);
    }
    return {
      ok: true,
      sessionId: plan.sessionId,
      title: plan.title,
      sizeBytes: plan.sizeBytes,
      live: plan.live,
      children: plan.children.map((/** @type {any} */ child) => ({
        id: child.id,
        title: child.title,
      })),
      cascade: args.cascade === true,
      digest: plan.digest,
      token,
      expiresAt: new Date(now() + ttlMs).toISOString(),
      hint: "call this tool again with action=delete and the token to execute; the token is single-use and expires in 2 minutes",
    };
  }

  /**
   * 第二步：带 token 执行删除。
   * @param {{ sessionId: string, token?: string, cascade?: boolean, callerSessionId?: string }} args
   */
  async function remove(args) {
    if (args.callerSessionId && args.callerSessionId === args.sessionId) {
      return {
        ok: false,
        code: "caller-session",
        message: "refusing to delete the session that is calling this tool",
      };
    }
    if (!args.token)
      return {
        ok: false,
        code: "token-required",
        message: "call action=plan first to obtain a token",
      };
    const taken = takeToken(args.token);
    if (taken.error)
      return {
        ok: false,
        code: taken.error,
        message: "token is invalid or expired; run action=plan again",
      };
    const entry = /** @type {any} */ (taken.entry);
    if (entry.sessionId !== args.sessionId) {
      return { ok: false, code: "token-mismatch", message: "token was issued for another session" };
    }
    const plan = await ops.plan(args.sessionId);
    if (plan.blockers.length > 0) {
      return { ok: false, code: "blocked", blockers: plan.blockers };
    }
    if (plan.digest !== entry.digest) {
      return {
        ok: false,
        code: "stale-plan",
        message: "session changed after the preview; run action=plan again",
      };
    }
    const result = await ops.trash(args.sessionId, {
      digest: plan.digest,
      cascade: args.cascade === true || entry.cascade === true,
      operator: "agent",
    });
    return {
      ok: true,
      sessionId: args.sessionId,
      entryId: result.entryId,
      receiptId: result.receiptId,
      cascaded: result.cascaded,
      removed: result.removed,
    };
  }

  return { plan, remove, size: () => tokens.size };
}

/**
 * 生成给模型看的纯文本摘要。
 * @param {any} planResult
 * @returns {string}
 */
export function summarizePlanForModel(planResult) {
  if (!planResult.ok) {
    const blockers = (planResult.blockers ?? [])
      .map((/** @type {any} */ item) => item.code)
      .join(", ");
    return (
      "Delete preview failed: " +
      (planResult.code || "blocked") +
      (blockers ? " (" + blockers + ")" : "")
    );
  }
  const parts = [
    "Delete preview for " + (planResult.title || planResult.sessionId),
    "size " +
      (typeof planResult.sizeBytes === "number" ? planResult.sizeBytes + " bytes" : "unknown"),
  ];
  if (planResult.live) parts.push("session is live");
  if (planResult.children.length > 0) parts.push(planResult.children.length + " child session(s)");
  parts.push("token " + planResult.token + " expires " + planResult.expiresAt);
  return parts.join(" | ");
}
