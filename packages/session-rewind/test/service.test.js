// @ts-check
// operations.js 的单测：用假的 session / agent 覆盖 candidates / rewind / cuts
// 的成功路径与全部失败码。这里不 import lib/service.js——service.js 依赖
// @deepseek-ai/*（本仓库不安装宿主包），它只是本层与 RemoteError/createUserMessage
// 的薄桥接，逻辑全部下沉到 operations.js。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAppendOptions,
  candidatesResponse,
  createMarkerMessageInput,
  cutsResponse,
  ERROR_CODES,
  ERROR_PREFIX,
  RewindRequestError,
  resolveSession,
  rewindResponse,
} from "../lib/operations.js";
import { MARKER_SOURCE_KIND, MARKER_TEXT } from "../lib/plan.js";

/**
 * @param {string} text
 * @returns {any}
 */
function userMessage(text) {
  return {
    id: `user-${text}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/**
 * @param {number} targetSeq
 * @returns {any}
 */
function markerMessage(targetSeq) {
  return {
    id: `marker-${targetSeq}`,
    role: "user",
    content: [{ type: "text", text: MARKER_TEXT }],
    source: { kind: MARKER_SOURCE_KIND, targetSeq },
  };
}

/**
 * @param {number} seq
 * @param {any} data
 * @param {string} [type]
 * @returns {any}
 */
function event(seq, data, type = "user/message") {
  return { seq, time: 100 + seq, type, data };
}

/** @returns {any} */
function systemEvent() {
  return event(
    0,
    { role: "system", content: [], source: { kind: "system-prompt" } },
    "system/message",
  );
}

/**
 * 假 session：只实现 operations.js 用到的三个成员。
 * @param {any[]} events
 * @param {{ header?: any, surface?: number[], appendImpl?: (type: string, data: any, opts: any) => any }} [options]
 * @returns {any}
 */
function fakeSession(events, options = {}) {
  return {
    header: options.header ?? { version: 4, id: "s1", createdAt: 0, isSeeded: false },
    surface: { nodes: options.surface ?? events.map((item) => item.seq) },
    snapshotEvents: () => events,
    append(/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ opts) {
      if (options.appendImpl) return options.appendImpl(type, data, opts);
      const appended = { type, seq: events.length, time: 999, data };
      events.push(appended);
      return appended;
    },
  };
}

/**
 * @param {{ agent?: any, session?: any, available?: boolean, inflight?: Set<string> }} [options]
 * @returns {{ deps: import("../lib/operations.js").ServiceDeps, markers: any[] }}
 */
function depsOf(options = {}) {
  /** @type {any[]} */
  const markers = [];
  return {
    markers,
    deps: {
      available: options.available ?? true,
      inflight: options.inflight ?? new Set(),
      getAgent: () => options.agent,
      getSession: () => options.session,
      createMarkerMessage: (targetSeq) => {
        const message = markerMessage(targetSeq);
        markers.push(message);
        return message;
      },
    },
  };
}

/**
 * @param {() => any} fn
 * @returns {string | undefined}
 */
function codeOf(fn) {
  try {
    fn();
    return undefined;
  } catch (error) {
    return /** @type {any} */ (error).code;
  }
}

test("ERROR_CODES 与设计约定的完整 code 一致", () => {
  assert.equal(ERROR_PREFIX, "session-rewind");
  assert.deepEqual(ERROR_CODES, {
    notFound: "session-rewind/not-found",
    busy: "session-rewind/busy",
    inert: "session-rewind/inert",
    badTarget: "session-rewind/bad-target",
    notOnSurface: "session-rewind/not-on-surface",
    failed: "session-rewind/failed",
  });
  const error = new RewindRequestError(ERROR_CODES.busy, "boom");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "RewindRequestError");
  assert.equal(error.code, "session-rewind/busy");
});

test("createMarkerMessageInput 是固定文本 + 生产者身份", () => {
  assert.deepEqual(createMarkerMessageInput(7), {
    content: [{ type: "text", text: MARKER_TEXT }],
    source: { kind: MARKER_SOURCE_KIND, targetSeq: 7 },
  });
});

test("buildAppendOptions 生成完整 replace 区间并复制被遮蔽节点", () => {
  /** @type {number[]} */
  const shadowedSeqs = [3, 4, 5];
  const options = buildAppendOptions({ surfaceStart: 3, surfaceEnd: 5, shadowedSeqs });
  assert.deepEqual(options, {
    surfaceOp: { op: "replace", startSeq: 3, endSeq: 5 },
    sourceEventSeqs: [3, 4, 5],
  });
  assert.notEqual(options.sourceEventSeqs, shadowedSeqs);
  shadowedSeqs.push(6);
  assert.deepEqual(options.sourceEventSeqs, [3, 4, 5]);
});

test("resolveSession：宿主服务缺失 → failed", () => {
  const { deps } = depsOf({ session: fakeSession([systemEvent()]), available: false });
  assert.equal(
    codeOf(() => resolveSession(deps, "s1")),
    ERROR_CODES.failed,
  );
});

test("resolveSession：sessionId 缺失或会话不存在 → not-found", () => {
  const { deps } = depsOf({ session: undefined });
  assert.equal(
    codeOf(() => resolveSession(deps, "")),
    ERROR_CODES.notFound,
  );
  assert.equal(
    codeOf(() => resolveSession(deps, undefined)),
    ERROR_CODES.notFound,
  );
  assert.equal(
    codeOf(() => resolveSession(deps, "missing")),
    ERROR_CODES.notFound,
  );
});

test("resolveSession：子代理会话 → inert（优先于 busy）", () => {
  const subagentSession = fakeSession([systemEvent()], {
    header: { version: 4, id: "s1", createdAt: 0, isSeeded: false, origin: "subagent" },
  });
  const running = { status: "running", session: subagentSession };
  const { deps } = depsOf({ agent: running, session: subagentSession });
  assert.equal(
    codeOf(() => resolveSession(deps, "s1")),
    ERROR_CODES.inert,
  );

  const nested = fakeSession([systemEvent()], {
    header: { version: 4, id: "s1", createdAt: 0, isSeeded: false, delegationDepth: 2 },
  });
  const nestedDeps = depsOf({ session: nested }).deps;
  assert.equal(
    codeOf(() => resolveSession(nestedDeps, "s1")),
    ERROR_CODES.inert,
  );

  // delegationDepth 0 不是子代理
  const root = fakeSession([systemEvent()], {
    header: { version: 4, id: "s1", createdAt: 0, isSeeded: false, delegationDepth: 0 },
  });
  assert.equal(resolveSession(depsOf({ session: root }).deps, "s1").session, root);
});

test("resolveSession：运行中的会话 → busy", () => {
  const session = fakeSession([systemEvent()]);
  const { deps } = depsOf({ agent: { status: "running", session }, session });
  assert.equal(
    codeOf(() => resolveSession(deps, "s1")),
    ERROR_CODES.busy,
  );

  // 没有 status 字段的 agent 也算非空闲（契约：只有 idle 允许写）
  const unknownDeps = depsOf({ agent: { session }, session }).deps;
  assert.equal(
    codeOf(() => resolveSession(unknownDeps, "s1")),
    ERROR_CODES.busy,
  );

  const idle = depsOf({ agent: { status: "idle", session }, session });
  assert.equal(resolveSession(idle.deps, "s1").agent.status, "idle");
  // 没有 agent（detached session）不阻塞
  assert.equal(resolveSession(depsOf({ session }).deps, "s1").session, session);
});

test("resolveSession：优先使用 agent.session", () => {
  const agentSession = fakeSession([systemEvent()]);
  const decoy = fakeSession([systemEvent()]);
  const { deps } = depsOf({ agent: { status: "idle", session: agentSession }, session: decoy });
  const resolved = resolveSession(deps, "s1");
  assert.equal(resolved.session, agentSession);
  assert.equal(resolved.agent.status, "idle");
  assert.equal(resolved.sessionId, "s1");
});

test("candidatesResponse：返回 {sessionId, candidates}，最新在前", () => {
  const log = [
    systemEvent(),
    event(1, userMessage("hello")),
    event(2, { message: { role: "assistant" } }, "assistant/message"),
    event(3, userMessage("newer")),
  ];
  const session = fakeSession(log);
  const { deps } = depsOf({ agent: { status: "idle", session }, session });
  const response = candidatesResponse(deps, { sessionId: "s1" });
  assert.equal(response.sessionId, "s1");
  assert.deepEqual(
    response.candidates.map((candidate) => candidate.seq),
    [3, 1],
  );
  assert.equal(response.candidates[0].text, "newer");
  assert.equal(log.length, 4, "candidates 是只读的，不追加事件");
});

test("candidatesResponse：limit 透传", () => {
  const log = [
    systemEvent(),
    event(1, userMessage("a")),
    event(2, userMessage("b")),
    event(3, userMessage("c")),
  ];
  const session = fakeSession(log);
  const { deps } = depsOf({ session });
  const response = candidatesResponse(deps, { sessionId: "s1", limit: 2 });
  assert.deepEqual(
    response.candidates.map((candidate) => candidate.seq),
    [3, 2],
  );
});

test("candidatesResponse：缺 sessionId / 会话不存在 → not-found", () => {
  const { deps } = depsOf({ session: undefined });
  assert.equal(
    codeOf(() => candidatesResponse(deps, {})),
    ERROR_CODES.notFound,
  );
  assert.equal(
    codeOf(() => candidatesResponse(deps, undefined)),
    ERROR_CODES.notFound,
  );

  const session = fakeSession([systemEvent()]);
  const busy = depsOf({ agent: { status: "running", session }, session }).deps;
  assert.equal(
    codeOf(() => candidatesResponse(busy, { sessionId: "s1" })),
    ERROR_CODES.busy,
  );
});

test("rewindResponse：追加正确 marker 并返回结果", () => {
  const log = [
    systemEvent(),
    event(1, userMessage("hello")),
    event(2, { message: { role: "assistant" } }, "assistant/message"),
  ];
  const session = fakeSession(log);
  const inflight = new Set();
  const { deps, markers } = depsOf({ agent: { status: "idle", session }, session, inflight });
  /** @type {any[]} */
  const appends = [];
  session.append = (
    /** @type {string} */ type,
    /** @type {any} */ data,
    /** @type {any} */ opts,
  ) => {
    appends.push({ type, data, opts });
    const appended = { type, seq: log.length, time: 999, data };
    log.push(appended);
    return appended;
  };

  const response = rewindResponse(deps, { sessionId: "s1", targetSeq: 1 });

  assert.deepEqual(response, { targetSeq: 1, markerSeq: 3, removedCount: 2, text: "hello" });
  assert.equal(appends.length, 1);
  const [{ type, data, opts }] = appends;
  assert.equal(type, "user/message");
  assert.equal(data, markers[0]);
  assert.equal(data.source.kind, MARKER_SOURCE_KIND);
  assert.equal(data.source.targetSeq, 1);
  assert.deepEqual(data.content, [{ type: "text", text: MARKER_TEXT }]);
  assert.deepEqual(opts, {
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [1, 2],
  });
  assert.equal(inflight.size, 0, "in-flight 标记在结束时清理");
});

test("rewindResponse：目标不是真人用户消息 → bad-target，不写日志", () => {
  const log = [
    systemEvent(),
    event(1, userMessage("hello")),
    event(2, { message: { role: "assistant" } }, "assistant/message"),
    event(3, userMessage("ctx")),
  ];
  log[3].data.source = { kind: "runtime-context" };
  const session = fakeSession(log);
  const { deps } = depsOf({ agent: { status: "idle", session }, session });

  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 2 })),
    ERROR_CODES.badTarget,
  );
  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 3 })),
    ERROR_CODES.badTarget,
  );
  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 99 })),
    ERROR_CODES.badTarget,
  );
  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 1.5 })),
    ERROR_CODES.badTarget,
  );
  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1" })),
    ERROR_CODES.badTarget,
  );
  assert.equal(log.length, 4, "失败的请求不追加事件");
});

test("rewindResponse：目标已被 compaction 遮蔽 → not-on-surface", () => {
  const log = [systemEvent(), event(1, userMessage("gone")), event(2, userMessage("visible"))];
  const session = fakeSession(log, { surface: [0, 2] });
  const { deps } = depsOf({ agent: { status: "idle", session }, session });
  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 1 })),
    ERROR_CODES.notOnSurface,
  );
});

test("rewindResponse：会话不存在 / 运行中 / 子代理 → 对应错误码", () => {
  const missing = depsOf({ session: undefined }).deps;
  assert.equal(
    codeOf(() => rewindResponse(missing, { sessionId: "s1", targetSeq: 1 })),
    ERROR_CODES.notFound,
  );

  const session = fakeSession([systemEvent(), event(1, userMessage("hi"))]);
  const busy = depsOf({ agent: { status: "running", session }, session }).deps;
  assert.equal(
    codeOf(() => rewindResponse(busy, { sessionId: "s1", targetSeq: 1 })),
    ERROR_CODES.busy,
  );

  const subagentSession = fakeSession([systemEvent(), event(1, userMessage("hi"))], {
    header: { version: 4, id: "s1", createdAt: 0, isSeeded: false, origin: "subagent" },
  });
  const inert = depsOf({
    agent: { status: "idle", session: subagentSession },
    session: subagentSession,
  }).deps;
  assert.equal(
    codeOf(() => rewindResponse(inert, { sessionId: "s1", targetSeq: 1 })),
    ERROR_CODES.inert,
  );
});

test("rewindResponse：同会话并发 → failed，且不写日志", () => {
  const log = [systemEvent(), event(1, userMessage("hi"))];
  const session = fakeSession(log);
  const inflight = new Set(["s1"]);
  const { deps } = depsOf({ agent: { status: "idle", session }, session, inflight });
  let appended = false;
  session.append = () => {
    appended = true;
    return { seq: 2 };
  };

  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 1 })),
    ERROR_CODES.failed,
  );
  assert.equal(appended, false);
});

test("rewindResponse：append 抛错时原样上抛并清理 in-flight", () => {
  const log = [systemEvent(), event(1, userMessage("hi"))];
  const inflight = new Set();
  const session = fakeSession(log, {
    appendImpl: () => {
      throw new Error("session cannot append outside a SessionStore");
    },
  });
  const { deps } = depsOf({ agent: { status: "idle", session }, session, inflight });

  assert.throws(
    () => rewindResponse(deps, { sessionId: "s1", targetSeq: 1 }),
    /cannot append outside a SessionStore/,
  );
  assert.equal(inflight.size, 0);
  // service.js 会把这种非 RewindRequestError 归到 session-rewind/failed
});

test("rewindResponse：append 返回形状不对 → failed，并清理 in-flight", () => {
  const log = [systemEvent(), event(1, userMessage("hi"))];
  const inflight = new Set();
  const session = fakeSession(log, { appendImpl: () => ({}) });
  const { deps } = depsOf({ agent: { status: "idle", session }, session, inflight });
  assert.equal(
    codeOf(() => rewindResponse(deps, { sessionId: "s1", targetSeq: 1 })),
    ERROR_CODES.failed,
  );
  assert.equal(inflight.size, 0);
});

test("cutsResponse：返回日志里已有的回溯区间", () => {
  const log = [
    systemEvent(),
    event(1, userMessage("first")),
    event(2, markerMessage(1)),
    event(3, userMessage("second")),
    event(4, markerMessage(3)),
  ];
  const session = fakeSession(log);
  const { deps } = depsOf({ session });
  assert.deepEqual(cutsResponse(deps, { sessionId: "s1" }), {
    cuts: [
      { targetSeq: 1, markerSeq: 2 },
      { targetSeq: 3, markerSeq: 4 },
    ],
  });
});

test("cutsResponse：会话不存在 → not-found；无 marker → 空数组", () => {
  const missing = depsOf({ session: undefined }).deps;
  assert.equal(
    codeOf(() => cutsResponse(missing, { sessionId: "s1" })),
    ERROR_CODES.notFound,
  );

  const session = fakeSession([systemEvent(), event(1, userMessage("hi"))]);
  assert.deepEqual(cutsResponse(depsOf({ session }).deps, { sessionId: "s1" }), { cuts: [] });
});
