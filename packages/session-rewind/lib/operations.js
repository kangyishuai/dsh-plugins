// @ts-check
// 执行层：把一次 Remote 请求拆成「解析会话 → 校验 → 规划 → 追加 marker」的同步逻辑。
//
// 这一层刻意不 import 任何 @deepseek-ai/*：宿主相关的只剩两处，
//   - service.js 里的 `createUserMessage`（构造 marker 消息）；
//   - service.js 里的 `RemoteError`（把下面的 code 搬到线上）。
// 其余（解析 sessions/agents、错误码、append 参数）都在这里，可以用假的
// session/agent 在 node --test 里覆盖全部错误分支。
import {
  cutsOf,
  listCandidatesPage,
  MARKER_SOURCE_KIND,
  MARKER_TEXT,
  messageImages,
  planRewind,
} from "./plan.js";

/** RemoteError code 的统一前缀。 */
export const ERROR_PREFIX = "session-rewind";

/** 设计约定的全部失败码（host 只给 code + 兜底 message，文案在客户端 locale）。 */
export const ERROR_CODES = Object.freeze({
  notFound: `${ERROR_PREFIX}/not-found`,
  busy: `${ERROR_PREFIX}/busy`,
  inert: `${ERROR_PREFIX}/inert`,
  badTarget: `${ERROR_PREFIX}/bad-target`,
  notOnSurface: `${ERROR_PREFIX}/not-on-surface`,
  failed: `${ERROR_PREFIX}/failed`,
  filesConflict: `${ERROR_PREFIX}/files-conflict`,
  filesUnavailable: `${ERROR_PREFIX}/files-unavailable`,
  filesRescueFailed: `${ERROR_PREFIX}/files-rescue-failed`,
  filesFailed: `${ERROR_PREFIX}/files-failed`,
  rescueNotFound: `${ERROR_PREFIX}/rescue-not-found`,
  storageUnavailable: `${ERROR_PREFIX}/storage-unavailable`,
});

/**
 * 一次请求失败：`code` 已经是线上的完整 code（`session-rewind/...`）。
 * service.js 会把它原样转成 `RemoteError`。
 */
export class RewindRequestError extends Error {
  /**
   * @param {string} code 完整失败码
   * @param {string} message 兜底诊断文本
   */
  constructor(code, message) {
    super(message);
    this.name = "RewindRequestError";
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @typedef {object} ServiceDeps
 * @property {(sessionId: string) => any} getAgent 取 agent（可能没有）
 * @property {(sessionId: string) => any} getSession 取 live session（可能没有）
 * @property {boolean} available 宿主是否提供了 sessions/agents 服务
 * @property {(targetSeq: number, extra?: {mode?: string, auditId?: string}) => any} createMarkerMessage 构造 marker 消息
 * @property {Set<string>} [inflight] 每会话的进行中标记（防重入）
 * @property {(sessionId: string, targetSeq: number) => {fileCount?: number} | undefined} [summarizeFiles] 每个目标之后的文件改动摘要
 */

/**
 * @typedef {object} ResolvedSession
 * @property {any} agent 对应的 agent（没有则 undefined）
 * @property {any} session live session
 * @property {string} sessionId
 */

/**
 * 是否为合法的非负安全整数事件序号。
 * @param {unknown} value
 * @returns {boolean}
 */
function isEventSeq(value) {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 取日志快照；宿主形状不对时算 failed（不是会话不存在）。
 * @param {any} session
 * @returns {any[]}
 */
function snapshotEventsOf(session) {
  if (typeof session?.snapshotEvents !== "function") {
    throw new RewindRequestError(ERROR_CODES.failed, "session does not expose snapshotEvents()");
  }
  const events = session.snapshotEvents();
  if (!Array.isArray(events)) {
    throw new RewindRequestError(
      ERROR_CODES.failed,
      "session.snapshotEvents() did not return an array",
    );
  }
  return events;
}

/**
 * 取 surface 节点顺序；宿主形状不对时算 failed。
 * @param {any} session
 * @returns {number[]}
 */
function surfaceNodesOf(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) {
    throw new RewindRequestError(ERROR_CODES.failed, "session surface nodes are unavailable");
  }
  return nodes;
}

/**
 * 解析并校验会话，按 not-found → inert → busy 的顺序返回明确失败码。
 *
 * - not-found：没有 live session（agent 也没有）；
 * - inert：子代理会话（`header.origin === "subagent"` 或 `delegationDepth > 0`）；
 * - busy：agent 存在且 `status !== "idle"`（v1 不主动打断运行中的回合）。
 * @param {ServiceDeps} deps
 * @param {any} sessionId
 * @returns {ResolvedSession}
 */
export function resolveSession(deps, sessionId) {
  if (deps.available !== true) {
    throw new RewindRequestError(
      ERROR_CODES.failed,
      "host session services are unavailable in this profile",
    );
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new RewindRequestError(ERROR_CODES.notFound, "a session id is required");
  }
  const agent = deps.getAgent(sessionId);
  const session = agent?.session ?? deps.getSession(sessionId);
  if (session === undefined || session === null) {
    throw new RewindRequestError(
      ERROR_CODES.notFound,
      `session "${sessionId}" is not open in this host`,
    );
  }
  const header = isRecord(session.header) ? session.header : {};
  const delegationDepth = header.delegationDepth;
  if (
    header.origin === "subagent" ||
    (typeof delegationDepth === "number" && delegationDepth > 0)
  ) {
    throw new RewindRequestError(
      ERROR_CODES.inert,
      `session "${sessionId}" is a subagent session and cannot be rewound`,
    );
  }
  if (agent !== undefined && agent !== null && agent.status !== "idle") {
    throw new RewindRequestError(
      ERROR_CODES.busy,
      `session "${sessionId}" is not idle; stop the running turn before rewinding`,
    );
  }
  return { agent, session, sessionId };
}

/**
 * 构造 marker 的消息输入（交给 `createUserMessage` 的入参）。
 * @param {number} targetSeq
 * @returns {{content: Array<{type: string, text: string}>, source: {kind: string, targetSeq: number}}}
 */
/**
 * @param {number} targetSeq
 * @param {{mode?: string, auditId?: string}} [extra]
 */
export function createMarkerMessageInput(targetSeq, extra = {}) {
  return {
    content: [{ type: "text", text: MARKER_TEXT }],
    source: {
      kind: MARKER_SOURCE_KIND,
      targetSeq,
      ...(extra && typeof extra.mode === "string" ? { mode: extra.mode } : {}),
      ...(extra && typeof extra.auditId === "string" ? { auditId: extra.auditId } : {}),
    },
  };
}

/**
 * 把 plan 转成 `session.append()` 的 surface 元数据。
 * `sourceEventSeqs` 必须完整列出被遮蔽节点，否则宿主会拒绝这次 append。
 * @param {any} plan planRewind 的成功结果
 * @returns {{surfaceOp: {op: string, startSeq: number, endSeq: number}, sourceEventSeqs: number[]}}
 */
export function buildAppendOptions(plan) {
  return {
    surfaceOp: { op: "replace", startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
    sourceEventSeqs: [...plan.shadowedSeqs],
  };
}

/**
 * @param {any} planError planRewind 返回的错误
 * @returns {never}
 */
function throwPlanError(planError) {
  const code =
    planError?.code === "not-on-surface" ? ERROR_CODES.notOnSurface : ERROR_CODES.badTarget;
  throw new RewindRequestError(code, String(planError?.message ?? "rewind target is not usable"));
}

/**
 * `candidates`：surface 上的真人用户消息列表（最新在前）。
 * @param {ServiceDeps} deps
 * @param {any} request `{ sessionId, limit? }`
 * @returns {{sessionId: string, candidates: any[], nextCursor: number | null}}
 */
export function candidatesResponse(deps, request) {
  const { session, sessionId } = resolveSession(deps, request?.sessionId);
  const page = listCandidatesPage(snapshotEventsOf(session), surfaceNodesOf(session), {
    limit: request?.limit,
    cursor: request?.cursor,
    q: request?.q,
  });
  const summarize =
    typeof deps.summarizeFiles === "function" ? deps.summarizeFiles : () => undefined;
  return {
    sessionId,
    candidates: page.candidates.map((candidate) => {
      const files = summarize(sessionId, candidate.seq);
      const fileCount =
        files !== undefined && typeof files.fileCount === "number" ? files.fileCount : 0;
      return {
        ...candidate,
        hasFiles: fileCount > 0,
        fileCount,
        reachable: true,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

/**
 * `rewind`：追加一条 marker，把目标消息及其后的 surface 节点整体替换掉。
 * @param {ServiceDeps} deps
 * @param {any} request `{ sessionId, targetSeq }`
 * @returns {{targetSeq: number, markerSeq: number, removedCount: number, text: string, target: {text: string, images: any[]}}}
 */
export function rewindResponse(deps, request) {
  const { session, sessionId } = resolveSession(deps, request?.sessionId);
  const targetSeq = request?.targetSeq;
  if (!isEventSeq(targetSeq)) {
    throw new RewindRequestError(
      ERROR_CODES.badTarget,
      `targetSeq must be a non-negative safe integer, got ${String(targetSeq)}`,
    );
  }
  if (typeof session.append !== "function") {
    throw new RewindRequestError(ERROR_CODES.failed, "session does not expose append()");
  }
  const inflight = deps.inflight;
  if (inflight?.has(sessionId) === true) {
    throw new RewindRequestError(
      ERROR_CODES.failed,
      `a rewind is already in progress for session "${sessionId}"`,
    );
  }
  inflight?.add(sessionId);
  try {
    const events = snapshotEventsOf(session);
    const plan = planRewind(events, surfaceNodesOf(session), targetSeq);
    if ("error" in plan) throwPlanError(plan.error);
    const targetEvent = events[targetSeq];
    const marker = deps.createMarkerMessage(targetSeq, {
      mode: request?.mode === "both" ? "both" : "chat",
      ...(typeof request?.auditId === "string" ? { auditId: request.auditId } : {}),
    });
    const event = session.append("user/message", marker, buildAppendOptions(plan));
    if (!isRecord(event) || !isEventSeq(event.seq)) {
      throw new RewindRequestError(
        ERROR_CODES.failed,
        "session.append() did not return an event with a seq",
      );
    }
    return {
      targetSeq,
      markerSeq: event.seq,
      removedCount: plan.shadowedSeqs.length,
      text: plan.text,
      target: {
        text: plan.text,
        images: targetEvent !== undefined ? messageImages(targetEvent.data) : [],
      },
    };
  } finally {
    inflight?.delete(sessionId);
  }
}

/**
 * `cuts`：日志里已经存在的回溯区间（客户端兜底用）。
 * @param {ServiceDeps} deps
 * @param {any} request `{ sessionId }`
 * @returns {{cuts: import("./plan.js").Cut[]}}
 */
export function cutsResponse(deps, request) {
  const { session } = resolveSession(deps, request?.sessionId);
  return { cuts: cutsOf(snapshotEventsOf(session)) };
}

/**
 * 追加一条回溯 marker（mode=both 时由 service 在救援点建好后调用）。
 * @param {any} session live session
 * @param {any} plan planRewind 的成功结果
 * @param {ServiceDeps} deps 依赖
 * @param {{mode?: "chat" | "both", auditId?: string}} [extra]
 * @returns {any} 落库事件
 */
export function appendRewindMarker(session, plan, deps, extra = {}) {
  if (typeof session.append !== "function") {
    throw new RewindRequestError(ERROR_CODES.failed, "session does not expose append()");
  }
  const marker = deps.createMarkerMessage(plan.targetSeq, {
    mode: extra.mode === "both" ? "both" : "chat",
    ...(typeof extra.auditId === "string" ? { auditId: extra.auditId } : {}),
  });
  return session.append("user/message", marker, buildAppendOptions(plan));
}

/**
 * 解析一次回溯请求的目标（不做任何写操作）。
 * @param {ServiceDeps} deps
 * @param {any} request `{ sessionId, targetSeq }`
 * @returns {{session: any, sessionId: string, plan: import("./plan.js").RewindPlan, targetEvent: any}}
 */
export function resolveRewindTarget(deps, request) {
  const { session, sessionId } = resolveSession(deps, request?.sessionId);
  const targetSeq = request?.targetSeq;
  if (!isEventSeq(targetSeq)) {
    throw new RewindRequestError(
      ERROR_CODES.badTarget,
      `targetSeq must be a non-negative safe integer, got ${String(targetSeq)}`,
    );
  }
  const events = snapshotEventsOf(session);
  const plan = planRewind(events, surfaceNodesOf(session), targetSeq);
  if ("error" in plan) throwPlanError(plan.error);
  return { session, sessionId, plan, targetEvent: events[targetSeq] };
}

/**
 * 读取一个会话当前完整事件日志（给 ghost/health 用）。
 * @param {ServiceDeps} deps
 * @param {string} sessionId
 * @returns {{session: any, events: any[]}}
 */
export function sessionEvents(deps, sessionId) {
  const { session } = resolveSession(deps, sessionId);
  return { session, events: snapshotEventsOf(session) };
}
