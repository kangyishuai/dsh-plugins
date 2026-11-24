// @ts-check
// 协调器工具篮子：定义与执行映射。
// 设计依据 notes/projects/m3-design.md §3.2（方案 B：默认 preset + tools.restrict 收窄）：
//   协调器**没有** bash / 写文件 / 删除 / git push / 合并；危险动作只能「申请」。
// 这里只依赖注入进来的函数，所以能用假 deps 完整单测。

/**
 * @typedef {object} CoordinatorDeps
 * @property {(task: string) => Promise<{ sessionId: string, isolated?: boolean }>} startThread
 * @property {() => Promise<{ rows: any[], counts: Record<string, number>, attention: number }>} listThreads
 * @property {(sessionId: string, text: string) => Promise<{ ok: boolean }>} messageThread
 * @property {(request: { action: string, args?: any, reason: string }) => Promise<{ ok?: boolean, requestId: string, autoApproved?: boolean, executed?: boolean, reason?: string }>} requestAction
 * @property {(text: string) => Promise<{ ok: boolean, added?: boolean, reason?: string }>} writeMemory
 * @property {() => Promise<{ instructions: string, memoryIndex: string }>} readMemory
 */

/** 允许申请的危险动作白名单（其余一律拒绝，并在返回里说明）。 */
export const REQUESTABLE_ACTIONS = Object.freeze([
  "merge",
  "push-branch",
  "push-protected-branch",
  "purge-trash",
  "delete-thread",
  "delete-project",
  "change-settings",
]);

/**
 * 申请一个危险动作（入审批队列，不执行）。
 * @param {CoordinatorDeps} deps
 * @param {{ action?: string, args?: any, reason?: string }} input
 * @returns {Promise<{ ok: boolean, requestId?: string, error?: string, autoApproved?: boolean, executed?: boolean, reason?: string }>}
 */
export async function requestAction(deps, input) {
  const action = String(input?.action ?? "");
  if (!REQUESTABLE_ACTIONS.includes(action)) {
    return { ok: false, error: `action-not-requestable: ${action || "(empty)"}` };
  }
  const reason = String(input?.reason ?? "").trim();
  if (reason === "") return { ok: false, error: "reason-required" };
  const created = await deps.requestAction({ action, args: input?.args ?? null, reason });
  // 透传预授权结果：命中时它已经被执行过，模型需要知道真相而不是"已排队"
  return {
    ok: true,
    requestId: created.requestId,
    ...(created.autoApproved === true
      ? {
          autoApproved: true,
          executed: created.executed === true,
          ...(created.executed === true ? {} : { reason: String(created.reason ?? "") }),
        }
      : {}),
  };
}

/**
 * 构造协调器可用的工具定义。
 * 每个定义都带 output.schema 与 render（宿主要求，0.2.2-rc.3 实测）。
 * @param {CoordinatorDeps} deps
 * @returns {any[]}
 */
export function buildCoordinatorTools(deps) {
  return [
    {
      name: "project_thread_start",
      description:
        "Start a new thread in this project for a task. Use when the task deserves its own session (multi-step, will touch files, or may take long).",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "A self-contained task description." } },
        required: ["task"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            isolated: { type: "boolean" },
          },
          required: ["sessionId"],
        },
      },
      async execute(/** @type {any} */ args) {
        const task = String(args?.task ?? "").trim();
        if (task === "") return { ok: false, error: "task-required" };
        const thread = await deps.startThread(task);
        return { ok: true, sessionId: thread.sessionId, isolated: thread.isolated === true };
      },
      render(/** @type {any} */ _args, /** @type {any} */ value) {
        if (!value?.ok) return [{ type: "text", text: `failed: ${value?.error ?? "unknown"}` }];
        return [{ type: "text", text: `thread ${String(value.sessionId).slice(0, 20)} started` }];
      },
    },
    {
      name: "project_thread_list",
      description:
        "List the project's threads with their state (waiting-user, failed, working, done, idle).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: "object",
          properties: {
            total: { type: "number" },
            attention: { type: "number" },
            rows: { type: "array" },
          },
        },
      },
      async execute() {
        const result = await deps.listThreads();
        return {
          ok: true,
          total: result.rows.length,
          attention: result.attention,
          rows: result.rows.map((/** @type {any} */ row) => ({
            sessionId: row.sessionId,
            state: row.view?.state ?? "idle",
            turn: row.view?.turn ?? 0,
          })),
        };
      },
      render(/** @type {any} */ _args, /** @type {any} */ value) {
        const count = Number(value?.total ?? 0);
        const attention = Number(value?.attention ?? 0);
        return [{ type: "text", text: `${count} threads, ${attention} need attention` }];
      },
    },
    {
      name: "project_thread_message",
      description: "Send a follow-up instruction to an existing thread.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionId", "text"],
        additionalProperties: false,
      },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
      async execute(/** @type {any} */ args) {
        const sessionId = String(args?.sessionId ?? "").trim();
        const text = String(args?.text ?? "").trim();
        if (sessionId === "" || text === "")
          return { ok: false, error: "sessionId-and-text-required" };
        await deps.messageThread(sessionId, text);
        return { ok: true };
      },
      render(/** @type {any} */ _args, /** @type {any} */ value) {
        return [{ type: "text", text: value?.ok ? "message queued" : "failed" }];
      },
    },
    {
      name: "project_memory_read",
      description:
        "Read this project's standing rules and memory index. Read before you write so you do not duplicate what is already known.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: "object",
          properties: {
            instructions: { type: "string" },
            memoryIndex: { type: "string" },
          },
        },
        render(/** @type {any} */ _args, /** @type {any} */ value) {
          const rules = String(value?.instructions ?? "");
          const memory = String(value?.memoryIndex ?? "");
          return [
            {
              type: "text",
              text: `rules: ${rules.length} chars · memory: ${memory.length} chars`,
            },
          ];
        },
      },
      async execute() {
        const content = await deps.readMemory();
        return {
          instructions: String(content?.instructions ?? ""),
          memoryIndex: String(content?.memoryIndex ?? ""),
        };
      },
    },
    {
      name: "project_memory_write",
      description:
        "Remember a durable fact about this project (a convention, a gotcha, a decision). Keep it short and self-contained; duplicates are ignored.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "One short paragraph to remember." } },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            added: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["ok"],
        },
        render(/** @type {any} */ _args, /** @type {any} */ value) {
          if (!value?.ok)
            return [{ type: "text", text: `not saved: ${value?.reason ?? "unknown"}` }];
          return [{ type: "text", text: value.added ? "remembered" : "already known" }];
        },
      },
      async execute(/** @type {any} */ args) {
        const text = String(args?.text ?? "").trim();
        if (text === "") return { ok: false, reason: "text-required" };
        const result = await deps.writeMemory(text);
        return {
          ok: result.ok === true,
          added: result.added === true,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      },
    },
    {
      name: "project_request_action",
      description:
        "Ask for a dangerous or irreversible action. If the project pre-approves this action (policy-grant), it is executed immediately through the same gates; otherwise it is queued for a human to approve and execute.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...REQUESTABLE_ACTIONS] },
          reason: { type: "string", description: "Why this action is needed, in one sentence." },
          args: { type: "object", description: "Action-specific arguments." },
        },
        required: ["action", "reason"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            status: { type: "string" },
            error: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
      async execute(/** @type {any} */ args) {
        const result = await requestAction(deps, args ?? {});
        if (!result.ok) return { status: "rejected", error: String(result.error) };
        // 预授权命中时已经执行过：把真实结果交给模型，而不是一律说 "queued"
        if (result.autoApproved === true) {
          return {
            requestId: String(result.requestId),
            status: result.executed === true ? "executed" : "auto-approved-not-executed",
            ...(result.executed === true ? {} : { reason: String(result.reason ?? "") }),
          };
        }
        return { requestId: String(result.requestId), status: "queued" };
      },
      render(/** @type {any} */ _args, /** @type {any} */ value) {
        return [
          {
            type: "text",
            text:
              value?.status === "executed"
                ? `auto-approved and executed (${value?.requestId ?? ""})`
                : value?.status === "auto-approved-not-executed"
                  ? `auto-approved but not executed: ${value?.reason ?? ""}`
                  : value?.requestId
                    ? `queued for approval (${value.requestId})`
                    : `rejected: ${value?.error ?? ""}`,
          },
        ];
      },
    },
  ].map(toHostShape);
}

/**
 * 宿主要求 `render` 在 `output` 里（M1 实测的注册契约）；定义里放在顶层更好读，这里转一次。
 * @param {any} tool
 * @returns {any}
 */
function toHostShape(tool) {
  const { render, ...rest } = tool;
  // 两种写法都要支持：render 在工具顶层（本文件多数工具），或已经在 output 里。
  const resolved = typeof render === "function" ? render : rest.output?.render;
  return { ...rest, output: { ...rest.output, render: resolved } };
}

/**
 * 只保留给定工具名（用于 tools.restrict 的 allow 列表生成）。
 * @param {any[]} tools
 * @param {string[]} names
 * @returns {any[]}
 */
export function pickTools(tools, names) {
  const wanted = new Set(Array.isArray(names) ? names : []);
  return (Array.isArray(tools) ? tools : []).filter((tool) => wanted.has(tool?.name));
}
