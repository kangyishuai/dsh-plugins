// @ts-check
// rewind-flow.js 的单测（AUD-REW-10）：用假 session/agent/store 覆盖编排状态机的全部分支。
//
// 覆盖：chat / both 成功、conflicts 拒绝、无文件动作、部分失败（marker 已写/未写）、
// 运行中取消与拒绝、tracking/cwd 不可用、并发重入、审计失败不致命。
// 文件写入本身在 files.test.js；这里只钉「顺序与失败语义」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_CODES } from "../lib/operations.js";
import { createRewindFlow } from "../lib/rewind-flow.js";

/**
 * @param {number} seq
 * @param {any} data
 * @param {string} [type]
 * @returns {any}
 */
function event(seq, data, type = "user/message") {
  return { seq, time: 100 + seq, type, data };
}

/** @param {string} text @returns {any} */
function userMessage(text) {
  return {
    id: `user-${text}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/** @returns {any} */
function makeSession() {
  /** @type {any[]} */
  const events = [
    event(0, { role: "system", content: [], source: { kind: "system-prompt" } }, "system/message"),
    event(1, userMessage("first")),
    event(
      2,
      {
        turn: 1,
        step: 1,
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      "assistant/message",
    ),
    event(3, userMessage("second")),
    event(
      4,
      {
        turn: 1,
        step: 1,
        message: { id: "a2", role: "assistant", content: [{ type: "text", text: "ok2" }] },
      },
      "assistant/message",
    ),
  ];
  return {
    header: { version: 4, id: "s1", createdAt: 0, isSeeded: false },
    surface: { nodes: [0, 1, 2, 3, 4] },
    snapshotEvents: () => events,
    /**
     * @param {string} type
     * @param {any} data
     * @returns {any}
     */
    append(type, data) {
      const appended = { type, seq: events.length, time: 999, data };
      events.push(appended);
      return appended;
    },
  };
}

/** 空恢复计划（无文件动作）。 */
const emptyPlan = {
  available: false,
  tracked: false,
  sessionId: "s1",
  targetSeq: 3,
  cwd: "/tmp/ws",
  restore: [],
  trash: [],
  skipped: [],
  conflicts: [],
  warnings: [],
  totalBytes: 0,
  actions: [],
};

/**
 * 一套可注入的 flow 环境。
 * @param {Record<string, any>} [options]
 * @returns {any}
 */
function makeFlow(options = {}) {
  const session = options.session ?? makeSession();
  const agent = options.agent;
  /** @type {any[]} */
  const audits = [];
  /** @type {any[]} */
  const markers = [];
  /** @type {any[]} */
  const warnings = [];
  /** @type {any[]} */
  const planCalls = [];
  /** @type {any[]} */
  const applyCalls = [];
  /** @type {any[]} */
  const settleCalls = [];
  const inflight = options.inflight ?? new Set();
  const store = {
    newAuditId: () => "aud-1",
    planRestore: async (/** @type {any} */ request) => {
      planCalls.push(request);
      return options.filePlan ?? emptyPlan;
    },
    applyRestore: async (/** @type {any} */ request) => {
      applyCalls.push(request);
      if (options.applyRestore) return options.applyRestore(request);
      await request.beforeApply();
      return {
        restored: ["a.txt"],
        trashed: ["new.txt"],
        skipped: [],
        failed: [],
        rescueId: "res-1",
        removedDirs: [],
      };
    },
    appendAudit: async (/** @type {any} */ record) => {
      audits.push(record);
      if (options.auditError) throw options.auditError;
    },
  };
  const flow = createRewindFlow({
    store,
    config: options.config ?? {},
    trackingEnabled: () => options.trackingEnabled !== false,
    cwdOf: () =>
      options.cwd === null ? undefined : options.cwd === undefined ? "/tmp/ws" : options.cwd,
    logger: {
      warn: (/** @type {string} */ message) => warnings.push(message),
      info: () => {},
    },
    inflight,
    serviceDeps: () => ({
      available: true,
      getAgent: () => agent,
      getSession: () => session,
      createMarkerMessage: (/** @type {number} */ targetSeq, /** @type {any} */ extra) => {
        const message = {
          id: `marker-${targetSeq}`,
          role: "user",
          content: [{ type: "text", text: "marker" }],
          source: { kind: "session-rewind", targetSeq, ...extra },
        };
        markers.push(message);
        return message;
      },
    }),
    estimateTokens: () => 42,
    settle:
      options.settle ??
      (async (/** @type {any} */ target, /** @type {any} */ settleOptions) => {
        settleCalls.push({ target, settleOptions });
        // 真实 settleAgent 在 idle 后返回；假 agent 也要把状态改成 idle，后续 resolve 才可通过。
        if (target && typeof target === "object") target.status = "idle";
        return { cancelled: true, droppedSteering: ["s1"], idle: true };
      }),
  });
  return {
    flow,
    session,
    store,
    audits,
    markers,
    warnings,
    planCalls,
    applyCalls,
    settleCalls,
    inflight,
  };
}

/** @param {() => Promise<any>} fn @returns {Promise<any>} */
async function rejection(fn) {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

test("rewind-flow: chat 模式只追加 marker、写审计、清理 in-flight", async () => {
  const h = makeFlow();
  const result = await h.flow.execute({
    sessionId: "s1",
    targetSeq: 3,
    mode: "chat",
    requestedBy: "test",
  });
  assert.equal(result.targetSeq, 3);
  assert.equal(result.markerSeq, 5);
  assert.equal(result.removedCount, 2);
  // USIM-U2-20：用户/助手消息数与面板 ghost 同口径（目标 3 + 助手 4）。
  assert.equal(result.removedMessageCount, 2);
  assert.equal(result.tokens, 42);
  assert.equal(result.files, null);
  assert.equal(h.session.snapshotEvents().length, 6);
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].mode, "chat");
  assert.equal(h.audits[0].requestedBy, "test");
  assert.equal(h.audits[0].markerSeq, 5);
  assert.equal(h.audits[0].removedMessageCount, 2);
  assert.equal(h.inflight.size, 0);
});

test("rewind-flow: both 模式按 plan → 救援点/写文件 → marker → 审计的顺序", async () => {
  const filePlan = {
    ...emptyPlan,
    available: true,
    tracked: true,
    actions: [
      {
        path: "a.txt",
        action: "restore",
        beforeHash: "h1",
        afterHash: "h2",
        currentHash: "h2",
        currentExists: true,
        bytes: 4,
        mode: null,
        anchorSeq: 3,
      },
    ],
    restore: [{ path: "a.txt", bytes: 4 }],
  };
  const h = makeFlow({ filePlan });
  const result = await h.flow.execute({
    sessionId: "s1",
    targetSeq: 3,
    mode: "both",
    requestedBy: "remote",
  });
  assert.deepEqual(result.files, {
    restored: ["a.txt"],
    trashed: ["new.txt"],
    skipped: [],
    failed: [],
    rescueId: "res-1",
  });
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0].sessionId, "s1");
  assert.equal(h.planCalls[0].targetSeq, 3);
  assert.equal(h.planCalls[0].cwd, "/tmp/ws");
  assert.equal(h.applyCalls.length, 1);
  // marker 在 beforeApply 里追加：applyRestore 被调用时 marker 已经落了。
  assert.equal(h.session.snapshotEvents().length, 6);
  assert.equal(h.audits[0].mode, "both");
  assert.equal(h.audits[0].files.rescueId, "res-1");
  assert.equal(h.inflight.size, 0);
});

test("rewind-flow: both 冲突时整体拒绝、不追加 marker、不写文件", async () => {
  const conflicts = [{ path: "x.txt", reason: "modified-externally" }];
  const h = makeFlow({ filePlan: { ...emptyPlan, conflicts } });
  const error = await rejection(() =>
    h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "both", requestedBy: "remote" }),
  );
  assert.equal(error?.code, ERROR_CODES.filesConflict);
  assert.deepEqual(error?.details?.conflicts, conflicts);
  assert.equal(h.session.snapshotEvents().length, 5);
  assert.equal(h.applyCalls.length, 0);
  assert.equal(h.audits.length, 0);
  assert.equal(h.inflight.size, 0);
});

test("rewind-flow: both 没有文件动作时仍追加 marker，且不创建救援点", async () => {
  const h = makeFlow({
    filePlan: { ...emptyPlan, skipped: [{ path: "big.bin", reason: "too-large" }] },
  });
  const result = await h.flow.execute({
    sessionId: "s1",
    targetSeq: 3,
    mode: "both",
    requestedBy: "remote",
  });
  assert.equal(h.applyCalls.length, 0);
  assert.equal(h.session.snapshotEvents().length, 6);
  assert.deepEqual(result.files.restored, []);
  assert.deepEqual(result.files.trashed, []);
  assert.deepEqual(result.files.skipped, [{ path: "big.bin", reason: "too-large" }]);
  assert.equal(result.files.rescueId, null);
});

test("rewind-flow: marker 已写入后文件失败 -> 返回部分结果（会话已回溯）", async () => {
  const filePlan = {
    ...emptyPlan,
    available: true,
    actions: [
      {
        path: "a.txt",
        action: "restore",
        beforeHash: "h1",
        afterHash: "h2",
        currentHash: "h2",
        currentExists: true,
        bytes: 4,
        mode: null,
        anchorSeq: 3,
      },
    ],
  };
  const h = makeFlow({
    filePlan,
    applyRestore: async (/** @type {any} */ request) => {
      await request.beforeApply();
      throw new Error("write boom");
    },
  });
  const result = await h.flow.execute({
    sessionId: "s1",
    targetSeq: 3,
    mode: "both",
    requestedBy: "remote",
  });
  assert.equal(result.markerSeq, 5);
  assert.deepEqual(result.files.restored, []);
  assert.deepEqual(result.files.failed, [{ path: "*", reason: "write boom" }]);
  assert.equal(result.files.rescueId, null);
  assert.equal(h.audits.length, 1);
});

test("rewind-flow: marker 写入前失败 -> 原样抛出、不写审计", async () => {
  const h = makeFlow({
    filePlan: { ...emptyPlan, available: true, actions: [{ path: "a.txt", action: "restore" }] },
    applyRestore: async () => {
      throw new Error("rescue boom");
    },
  });
  const error = await rejection(() =>
    h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "both", requestedBy: "remote" }),
  );
  assert.equal(error?.message, "rescue boom");
  assert.equal(h.session.snapshotEvents().length, 5);
  assert.equal(h.audits.length, 0);
  assert.equal(h.inflight.size, 0);
});

test("rewind-flow: 运行中且 cancelRunning=false -> busy，不追加 marker", async () => {
  let cancelled = false;
  const agent = {
    status: "running",
    session: makeSession(),
    cancel: () => {
      cancelled = true;
    },
    whenIdle: async () => {},
  };
  const h = makeFlow({ agent, config: { cancelRunning: false } });
  const error = await rejection(() =>
    h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "chat", requestedBy: "remote" }),
  );
  assert.equal(error?.code, ERROR_CODES.busy);
  assert.equal(cancelled, false);
  assert.equal(h.session.snapshotEvents().length, 5);
});

test("rewind-flow: 运行中默认先取消并等 idle，结果/审计记录 cancelledTurn 与 droppedSteering", async () => {
  const agent = {
    status: "running",
    session: makeSession(),
    cancel: () => {},
    whenIdle: async () => {},
  };
  const h = makeFlow({ agent });
  const result = await h.flow.execute({
    sessionId: "s1",
    targetSeq: 3,
    mode: "chat",
    requestedBy: "remote",
  });
  assert.equal(h.settleCalls.length, 1);
  assert.equal(result.cancelledTurn, true);
  assert.equal(result.droppedSteering, 1);
  assert.equal(h.audits[0].cancelledTurn, true);
  assert.equal(h.audits[0].droppedSteering, 1);
});

test("rewind-flow: 取消后没有 idle -> busy，不追加 marker", async () => {
  const agent = {
    status: "running",
    session: makeSession(),
    cancel: () => {},
    whenIdle: async () => {},
  };
  const h = makeFlow({
    agent,
    settle: async () => ({ cancelled: true, droppedSteering: [], idle: false }),
  });
  const error = await rejection(() =>
    h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "chat", requestedBy: "remote" }),
  );
  assert.equal(error?.code, ERROR_CODES.busy);
  assert.equal(h.session.snapshotEvents().length, 5);
});

test("rewind-flow: 文件追踪关闭 / cwd 缺失时 both 报 files-unavailable", async () => {
  const disabled = makeFlow({ trackingEnabled: false });
  const first = await rejection(() =>
    disabled.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "both", requestedBy: "remote" }),
  );
  assert.equal(first?.code, ERROR_CODES.filesUnavailable);

  const noCwd = makeFlow({ cwd: null });
  // cwdOf 返回 undefined：覆盖「会话没有工作目录」。
  const second = await rejection(() =>
    noCwd.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "both", requestedBy: "remote" }),
  );
  assert.equal(second?.code, ERROR_CODES.filesUnavailable);
  assert.equal(noCwd.session.snapshotEvents().length, 5);
});

test("rewind-flow: planRestore 报 files-unavailable 时 both 拒绝", async () => {
  const h = makeFlow({
    filePlan: {
      ...emptyPlan,
      warnings: [{ code: "files-unavailable", message: "cwd gone" }],
    },
  });
  const error = await rejection(() =>
    h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "both", requestedBy: "remote" }),
  );
  assert.equal(error?.code, ERROR_CODES.filesUnavailable);
  assert.equal(h.session.snapshotEvents().length, 5);
});

test("rewind-flow: 同会话并发重入 -> failed，且不追加 marker", async () => {
  const inflight = new Set(["s1"]);
  const h = makeFlow({ inflight });
  const error = await rejection(() =>
    h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "chat", requestedBy: "remote" }),
  );
  assert.equal(error?.code, ERROR_CODES.failed);
  assert.equal(h.session.snapshotEvents().length, 5);
});

test("rewind-flow: 审计写失败只告警，不影响回溯结果", async () => {
  const h = makeFlow({ auditError: new Error("disk full") });
  const result = await h.flow.execute({
    sessionId: "s1",
    targetSeq: 3,
    mode: "chat",
    requestedBy: "remote",
  });
  assert.equal(result.markerSeq, 5);
  assert.ok(
    h.warnings.some((/** @type {string} */ message) => /audit append failed/u.test(message)),
  );
});

test("rewind-flow: 把 cancelTimeoutMs 传给取消实现", async () => {
  const agent = {
    status: "running",
    session: makeSession(),
    cancel: () => {},
    whenIdle: async () => {},
  };
  const h = makeFlow({ agent, config: { cancelTimeoutMs: 1234 } });
  await h.flow.execute({ sessionId: "s1", targetSeq: 3, mode: "chat", requestedBy: "remote" });
  assert.deepEqual(h.settleCalls[0].settleOptions, { timeoutMs: 1234 });
});
