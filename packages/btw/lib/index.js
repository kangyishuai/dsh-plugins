// @ts-check
// host 半：注册 `/btw` 命令。旁问通过 fork 只读子代理执行（见 lib/subagent.js）。
// 实测依据：notes/btw/experiment-busy-dispatch.md（命令在回合进行中可立即派发）、
//           notes/btw/experiment-cache-prefix.md（fork 复用主前缀缓存）。
import { appendRecord, lastRecord, listRecent } from "./history.js";
import { clip, LIMITS } from "./limits.js";
import { format, loadMessages, pickLanguage } from "./messages.js";
import { historyFile, resolveDataRoot } from "./paths.js";
import { observeUsage, runSideQuestion } from "./subagent.js";

export const name = "btw";

/**
 * 依赖声明刻意**不用**模块级 `export const inject`：那样任何一项服务没就绪，
 * 插件就会一直等（真机实测会让宿主启动卡住、不打印 URL）。
 * 正确做法是 apply() 里用 `ctx.inject(names, (scoped) => …)` 延迟注入，
 * 与 packages/advisor/lib/service.js 里 `ctx.inject(['tools'], …)` 同形。
 */
const REQUIRED_SERVICES = ["agents", "commands", "subagents", "tools", "workspaceRegistry"];

/** 默认文案（locale 未加载时兜底，键集与 locale/en.json 的 command/usage 段一致）。 */
const FALLBACK = {
  description: "Ask a read-only side question without interrupting the main task",
  hint: "[question]",
  empty: "Usage: /btw <your question>.",
  noHistory: "No side question yet in this session.",
  forkUnavailable: "Side questions are unavailable right now (the subagent runtime is not loaded).",
  forkFailed: "The side question could not start. Try again, or ask in the main conversation.",
  emptyAnswer: "The model returned no answer. Try rephrasing, or ask in the main conversation.",
  timeout: "The side question timed out before it answered.",
  cancelled: "The side question was cancelled.",
  tooLong: "That question is too long ({length} characters, limit {max}).",
  meta: "btw · new {newTokens} tokens · cached {cachedTokens} · {ms}ms",
  reopen: "Last side question: {question}",
  questionHeading: "Side question: {question}",
};

/**
 * 解析允许只读放行的工具白名单。默认空 = 全部拒绝。
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

/**
 * @param {DSH.HostContext} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const dataRoot = resolveDataRoot(config);
  const allowedTools = parseAllowedTools(config);
  const language = pickLanguage(config?.language);
  const usageBySession = observeUsage(ctx);

  /** @type {Record<string, string>} */
  let messages = FALLBACK;
  const localeDir = new URL("../locale/", import.meta.url).pathname;
  void loadMessages(localeDir, language)
    .then((loaded) => {
      messages = { ...FALLBACK, ...flatten(loaded) };
    })
    .catch(() => {
      // locale 读不到就用兜底英文，不影响功能
    });

  const inject = /** @type {any} */ (ctx).inject;
  if (typeof inject !== "function") {
    ctx.logger.warn(`[${name}] ctx.inject unavailable; /btw not registered`);
    return;
  }

  inject.call(ctx, REQUIRED_SERVICES, (/** @type {any} */ scoped) => {
    const commands = scoped.commands;
    if (typeof commands?.register !== "function") {
      ctx.logger.warn(`[${name}] commands service unavailable; /btw not registered`);
      return;
    }

    commands.register({
      name: "btw",
      description: messages.description ?? FALLBACK.description,
      input: { hint: messages.hint ?? FALLBACK.hint },
      // 问题本身已进入旁问历史，不再写进 session log
      recordInput: false,
      /**
       * @param {any} invocation
       * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
       */
      async handler(invocation) {
        const agent = invocation?.agent;
        const question = clip(String(invocation?.rawInput ?? "").trim(), LIMITS.questionChars);
        const file = historyFile(
          dataRoot,
          agent?.id ?? invocation?.agent?.session?.header?.id ?? "",
        );

        if (question.text === "") {
          const previous = await lastRecord(file).catch(() => undefined);
          if (previous === undefined)
            return { kind: "error", text: messages.noHistory ?? FALLBACK.noHistory };
          return { kind: "success", text: formatReopen(messages, previous) };
        }
        if (question.truncated) {
          return {
            kind: "error",
            text: format(messages.tooLong ?? FALLBACK.tooLong, {
              length: String(invocation?.rawInput ?? "").trim().length,
              max: LIMITS.questionChars,
            }),
          };
        }

        const history = await listRecent(file, LIMITS.replayRecords).catch(() => []);
        const outcome = await runSideQuestion({
          ctx: scoped,
          agent,
          question: question.text,
          history,
          allowedTools,
          signal: invocation?.signal,
          usageBySession,
        });

        if (outcome.code === "subagents_unavailable") {
          return { kind: "error", text: messages.forkUnavailable ?? FALLBACK.forkUnavailable };
        }
        if (!outcome.ok) {
          const key =
            outcome.status === "timeout"
              ? "timeout"
              : outcome.status === "cancelled"
                ? "cancelled"
                : outcome.code === "empty_answer"
                  ? "emptyAnswer"
                  : "forkFailed";
          return { kind: "error", text: messages[key] ?? FALLBACK[key] ?? FALLBACK.forkFailed };
        }

        const record = {
          id: `btw_${Date.now().toString(36)}`,
          parentSessionId: String(agent?.id ?? ""),
          childSessionId: outcome.childId ?? null,
          question: question.text,
          answer: outcome.text,
          status: outcome.status,
          cost: outcome.usage ?? null,
          ms: outcome.ms,
          at: Date.now(),
        };
        let stored = true;
        await appendRecord(file, record).catch(() => {
          stored = false;
        });

        return { kind: "success", text: formatAnswer(messages, record, stored) };
      },
    });

    ctx.logger.info(`[${name}] /btw registered (read-only, ${allowedTools.size} allowed tool(s))`);
  });
}

/**
 * @param {Record<string, string>} messages
 * @param {any} record
 * @param {boolean} stored
 * @returns {string}
 */
function formatAnswer(messages, record, stored) {
  const usage = record.cost ?? {};
  const meta = format(messages.meta ?? FALLBACK.meta, {
    newTokens: String(usage.inputTokens ?? 0),
    cachedTokens: String(usage.cacheReadTokens ?? 0),
    ms: String(record.ms ?? 0),
  });
  const lines = [record.answer, "", `— ${meta}`];
  if (record.status === "truncated")
    lines.push(messages.truncated ?? "The answer was cut off; ask again to retry.");
  if (!stored) lines.push(messages.storeFailed ?? "(history was not saved)");
  return lines.join("\n");
}

/**
 * @param {Record<string, string>} messages
 * @param {any} record
 * @returns {string}
 */
function formatReopen(messages, record) {
  const heading = format(messages.reopen ?? FALLBACK.reopen, {
    question: String(record.question ?? ""),
  });
  return [
    heading,
    "",
    String(record.answer ?? ""),
    "",
    `— ${format(messages.meta ?? FALLBACK.meta, {
      newTokens: String(record.cost?.inputTokens ?? 0),
      cachedTokens: String(record.cost?.cacheReadTokens ?? 0),
      ms: String(record.ms ?? 0),
    })}`,
  ].join("\n");
}

/**
 * 把嵌套的 locale 表拍平成 `a.b.c` 键，便于与 FALLBACK 合并。
 * @param {Record<string, any>} table
 * @param {string} [prefix]
 * @returns {Record<string, string>}
 */
function flatten(table, prefix = "") {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(table ?? {})) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object") Object.assign(out, flatten(value, path));
    else if (typeof value === "string") out[leafKey(path)] = value;
  }
  return out;
}

/**
 * locale 文件的键是 `command.description` / `usage.hint` 这类路径，兜底表用的是叶子名。
 * @param {string} path
 * @returns {string}
 */
function leafKey(path) {
  const [, ...rest] = path.split(".");
  return rest.length === 0 ? path : rest[rest.length - 1];
}
