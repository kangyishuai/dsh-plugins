// @ts-check
// 一次顾问调用：prepareCall → stream → 聚合文本 / usage / 错误分类。
// 这是整个插件唯一会花钱的地方，所有失败都必须变成**结构化结果**，绝不向上抛。
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { classifyAbort } from "./abort-reason.js";
import { advisorSystemPrompt, buildAdvisorInput, mintNonce } from "./prompt.js";

/** 额外调用统一打这个 purpose：也是递归防护的判据（监听器按它跳过自己）。 */
export const PURPOSE = "advisor";

/**
 * 把 SDK 抛出的错误归类成稳定的 code（供工具结果与 UI 文案使用）。
 * @param {unknown} error
 * @returns {string}
 */
export function classifyError(error) {
  const anyError = /** @type {any} */ (error);
  const code = typeof anyError?.code === "string" ? anyError.code : "";
  const name = typeof anyError?.name === "string" ? anyError.name : "";
  const message = typeof anyError?.message === "string" ? anyError.message : String(error ?? "");

  if (name === "AbortError" || code === "ABORT_ERR" || /abort/iu.test(message)) return "aborted";
  if (code !== "") return code;
  if (/credential|api[ _-]?key|unauthorized|401/iu.test(message)) return "MISSING_CREDENTIAL";
  if (/rate.?limit|429|too many requests/iu.test(message)) return "rate_limited";
  if (/overload|529|503/iu.test(message)) return "overloaded";
  if (/context|too long|too many tokens|prompt_too_long/iu.test(message)) return "prompt_too_long";
  if (/timeout|timed out/iu.test(message)) return "timeout";
  return "error";
}

/**
 * @typedef {object} CallInput
 * @property {any} llm 宿主 llm 服务
 * @property {{ provider: string, model: string, reasoningEffort?: string }} route
 * @property {{ maxTokens: number, temperature: number|null, timeoutMs: number }} settings
 * @property {string} transcript
 * @property {string} [focus]
 * @property {string} [locale]
 * @property {string} sessionId
 * @property {string} [extra] 第二轮取证时追加的上下文
 * @property {boolean} [canRequestEvidence]
 * @property {AbortSignal} [signal]
 * @property {DSH.Logger} [logger]
 */

/**
 * @typedef {object} CallResult
 * @property {boolean} ok
 * @property {string} [text] 顾问原始输出
 * @property {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number }} [usage]
 * @property {number} ms 耗时
 * @property {string} [code]
 * @property {string} [message]
 * @property {string} model 实际使用的模型 id
 * @property {string} effort 实际使用的思考档（空串表示默认）
 */

/**
 * 走一次顾问补全。**任何异常都不抛**，统一返回 `{ ok:false, code, message }`。
 * @param {CallInput} input
 * @returns {Promise<CallResult>}
 */
export async function callAdvisor(input) {
  const { llm, route, settings, transcript, sessionId } = input;
  const startedAt = Date.now();
  const model = route.model;
  const effort = typeof route.reasoningEffort === "string" ? route.reasoningEffort : "";

  if (!llm || typeof llm.prepareCall !== "function") {
    return {
      ok: false,
      code: "llm_unavailable",
      message: "宿主没有提供 llm.prepareCall",
      ms: 0,
      model,
      effort,
    };
  }

  const nonce = mintNonce();
  const baseText = buildAdvisorInput({
    transcript,
    nonce,
    focus: input.focus,
    locale: input.locale,
  });
  const userText =
    input.extra === undefined || input.extra === "" ? baseText : `${baseText}\n\n${input.extra}`;
  const system = advisorSystemPrompt({ canRequestEvidence: input.canRequestEvidence === true });
  const messages = /** @type {any} */ ([
    { role: "user", content: [{ type: "text", text: userText }] },
  ]);

  // 超时与用户中断合并：任一触发都中止（绝不留下孤儿请求继续烧 token）。
  const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
  // 超时与用户取消都会让流以 aborted 收尾，事后无法从 finish 分辨；
  // 这里先记住「信号里的一员确实因超时触发」，收尾时用它区分 code。
  let timedOut = false;
  timeoutSignal.addEventListener("abort", () => {
    timedOut = true;
  });
  const signals = [input.signal, timeoutSignal].filter(Boolean);
  const signal =
    signals.length > 1 && typeof AbortSignal.any === "function"
      ? AbortSignal.any(/** @type {AbortSignal[]} */ (signals))
      : /** @type {AbortSignal|undefined} */ (signals[0]);

  /**
   * @param {string} effortOverride 传空串表示「这次不带思考档」
   * @returns {Promise<CallResult>}
   */
  const run = async (effortOverride) => {
    const useEffort = effortOverride !== "" ? effortOverride : effort;
    const callConfig = {
      provider: route.provider,
      model: route.model,
      maxTokens: settings.maxTokens,
      ...(settings.temperature === null || settings.temperature === undefined
        ? {}
        : { temperature: settings.temperature }),
    };
    const prepared = await llm.prepareCall(
      callConfig,
      signal,
      (/** @type {any} */ controls, /** @type {any} */ modelInfo) => {
        /** @type {any} */
        const next = { ...controls };
        if (effortOverride === "") {
          // 显式要求「不要思考档」：不要 materialize 默认值。
          return next;
        }
        if (useEffort !== "") next.reasoningEffort = useEffort;
        else if (typeof modelInfo?.reasoning?.defaultEffort === "string") {
          next.reasoningEffort = modelInfo.reasoning.defaultEffort;
        }
        return next;
      },
    );

    const assembler = new BlockAssembler();
    /** @type {any} */
    let usage;
    /** @type {any} */
    let finish;
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages,
      system,
      sessionId,
      purpose: PURPOSE,
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk?.type === "usage") usage = chunk.usage;
      if (chunk?.type === "finish") finish = chunk.reason;
      assembler.push(chunk);
    }

    const settled = assembler.finish;
    if (settled?.kind === "error") {
      const failure = settled.failure;
      return {
        ok: false,
        code: classifyError(failure),
        message: `顾问调用失败：${failure?.message ?? "unknown"}`,
        ms: Date.now() - startedAt,
        model,
        effort: useEffort,
      };
    }
    if (settled?.kind === "aborted" || finish?.kind === "aborted") {
      const verdict = classifyAbort({
        // 外部 signal 先于超时触发 → 用户/回合取消；超时 signal 触发 → 超时。
        cancelled: timedOut !== true && (input.signal?.aborted ?? false),
        timedOut,
        timeoutMs: settings.timeoutMs,
      });
      return {
        ok: false,
        code: verdict.code,
        message: verdict.message,
        ms: Date.now() - startedAt,
        model,
        effort: useEffort,
      };
    }

    let text = "";
    for (const block of assembler.blocks()) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
    }

    const normalizedUsage = {
      inputTokens: Number(usage?.inputTokens ?? 0) || 0,
      outputTokens: Number(usage?.outputTokens ?? 0) || 0,
      cacheReadTokens: Number(usage?.cacheReadTokens ?? 0) || 0,
      cacheWriteTokens: Number(usage?.cacheWriteTokens ?? 0) || 0,
      reasoningTokens: Number(usage?.reasoningTokens ?? 0) || 0,
    };

    return {
      ok: true,
      text,
      usage: normalizedUsage,
      ms: Date.now() - startedAt,
      model,
      effort: useEffort,
    };
  };

  try {
    try {
      return await run(effort);
    } catch (error) {
      const code = classifyError(error);
      // 模型不支持这个思考档：去掉思考档重试**一次**（不无限重试）。
      if (code === "UNSUPPORTED_REASONING_EFFORT" || code === "INVALID_MODEL_REASONING") {
        input.logger?.warn?.(`[advisor] 模型不支持思考档 ${effort || "(默认)"}，已降级重试`);
        return await run("");
      }
      throw error;
    }
  } catch (error) {
    return {
      ok: false,
      code: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
      model,
      effort,
    };
  }
}
