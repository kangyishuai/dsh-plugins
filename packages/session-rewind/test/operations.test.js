// @ts-check
// operations.js 的单测：用假的 session / agent 覆盖错误码、marker 形状与 resolveSession。
//
// AUD-REW-10：旧版本这里有一半用例在测 `candidatesResponse` / `rewindResponse` /
// `cutsResponse`——三个在生产路径里没有调用方的死代码（已删除）。真正的编排在
// rewind-flow.js，由 test/rewind-flow.test.js 覆盖；本文件只测解析/校验层。
// 文件名从 service.test.js 改为 operations.test.js，避免「service 有单测」的假绿。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAppendOptions,
  createMarkerMessageInput,
  ERROR_CODES,
  ERROR_PREFIX,
  gcSkippedWarning,
  RewindRequestError,
  remoteFailureOf,
  resolveSession,
} from "../lib/operations.js";
import { MARKER_SOURCE_KIND, MARKER_TEXT } from "../lib/plan.js";

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
    filesConflict: "session-rewind/files-conflict",
    filesUnavailable: "session-rewind/files-unavailable",
    filesRescueFailed: "session-rewind/files-rescue-failed",
    filesFailed: "session-rewind/files-failed",
    rescueNotFound: "session-rewind/rescue-not-found",
    trashNotFound: "session-rewind/trash-not-found",
    storageUnavailable: "session-rewind/storage-unavailable",
  });
  const error = new RewindRequestError(ERROR_CODES.busy, "boom");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "RewindRequestError");
  assert.equal(error.code, "session-rewind/busy");
});

test("remoteFailureOf：details 平铺，不包 {details}（复审 B1 契约）", () => {
  const details = { files: { restored: ["n.txt"], failed: [{ path: "m.txt" }] } };
  const internal = new RewindRequestError(
    ERROR_CODES.filesFailed,
    "some files could not be recovered",
  );
  /** @type {any} */ (internal).details = details;
  const failure = remoteFailureOf(internal);
  assert.equal(failure.code, "session-rewind/files-failed");
  assert.equal(failure.message, "some files could not be recovered");
  // 关键：details 是原对象、平铺传给宿主 RemoteError 的第三参；不能出现 details.details。
  assert.equal(failure.details, details);
  assert.equal(/** @type {any} */ (failure.details).details, undefined);

  // 非 session-rewind 前缀 → 通用 failed + details null（不把未知内部字段漏到线上）。
  assert.deepEqual(remoteFailureOf(new Error("boom")), {
    code: "session-rewind/failed",
    message: "boom",
    details: null,
  });
  assert.deepEqual(remoteFailureOf("oops"), {
    code: "session-rewind/failed",
    message: "oops",
    details: null,
  });
  // 有前缀但没 details → null（客户端读到 undefined 不应崩）。
  assert.equal(remoteFailureOf({ code: "session-rewind/files-conflict" }).details, null);
});

test("gcSkippedWarning：entries 读不出来的 warn 带会话 id（复审 N2）", () => {
  const warning = gcSkippedWarning({
    removedBlobs: 0,
    bytesFreed: 0,
    skipped: "entries-unreadable",
    unreadableSessions: [
      { sessionId: "session-a", reason: "EISDIR: illegal operation on a directory" },
      { sessionId: "session-b", reason: "EACCES: permission denied" },
    ],
  });
  // 运维要能按 id 去修复 entries；只报数量的话永远定位不到会话。
  assert.ok(warning.includes("2 session(s)"), warning);
  assert.ok(warning.includes("session-a"), warning);
  assert.ok(warning.includes("session-b"), warning);
  assert.ok(warning.startsWith("session-rewind: "), warning);

  // 异常/旧形状（没有 id 列表）不抛，也不渲染空括号。
  const empty = gcSkippedWarning({ unreadableSessions: [] });
  assert.ok(empty.includes("0 session(s)"), empty);
  assert.doesNotMatch(empty, /\(\)/u, empty);
  assert.ok(gcSkippedWarning({}).includes("0 session(s)"));
  assert.ok(
    gcSkippedWarning({ unreadableSessions: [{ reason: "no id" }, null] }).includes("2 session(s)"),
    "没有 id 的条目仍计入数量，只是不拼进列表",
  );
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
