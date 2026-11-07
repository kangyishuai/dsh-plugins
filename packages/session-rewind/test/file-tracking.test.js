// @ts-check
// file-tracking.js 的单测：apply_patch 路径解析、工具结果 -> entry 的纯函数映射、
// anchor 计算，以及 tools/execute + tools/post-execute + tools/result 三个钩子的端到端行为。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  commitFromToolResult,
  DEFAULT_TRACKING_OPTIONS,
  installFileTracking,
  latestHumanUserSeq,
  parsePatchPaths,
  TRACKED_TOOLS,
} from "../lib/file-tracking.js";
import { createFileStore } from "../lib/files.js";

/**
 * @param {number} seq
 * @returns {any}
 */
function humanMessage(seq) {
  return {
    seq,
    time: 100 + seq,
    type: "user/message",
    data: {
      id: `u-${seq}`,
      role: "user",
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    },
  };
}

/**
 * @param {number} seq
 * @returns {any}
 */
function runtimeContextMessage(seq) {
  return {
    seq,
    time: 100 + seq,
    type: "user/message",
    data: { id: `rc-${seq}`, role: "user", content: [], source: { kind: "runtime-context" } },
  };
}

/**
 * 构造长度为 `length` 的事件数组（下标 == seq），`humanAt` 指定真人消息位置。
 * @param {number} length
 * @param {number[]} humanAt
 * @returns {any[]}
 */
function makeEvents(length, humanAt) {
  /** @type {any[]} */
  const events = [];
  for (let seq = 0; seq < length; seq++) {
    if (humanAt.includes(seq)) events.push(humanMessage(seq));
    else events.push(runtimeContextMessage(seq));
  }
  return events;
}

/**
 * @param {any} session
 * @returns {any}
 */
function makeAgent(session) {
  return { id: session.id, session, status: "idle" };
}

/**
 * @param {string} id
 * @param {string} cwd
 * @param {any[]} events
 * @param {Record<string, any>} [header]
 * @returns {any}
 */
function makeSession(id, cwd, events, header = {}) {
  return {
    id,
    header: { version: 4, id, createdAt: 0, isSeeded: false, cwd, ...header },
    snapshotEvents: () => events,
  };
}

/**
 * @param {any} session
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {string} [callId]
 * @param {Record<string, any>} [extra]
 * @returns {any}
 */
function makeExec(session, name, args, callId = "call-1", extra = {}) {
  return { name, arguments: args, callId, agent: makeAgent(session), ...extra };
}

/**
 * 假的宿主事件总线：记录监听器并允许手动触发，充当 Cordis ctx。
 * @returns {{ctx: any, handlers: Map<string, any>, logs: string[]}}
 */
function createBus() {
  /** @type {Map<string, any>} */
  const handlers = new Map();
  /** @type {string[]} */
  const logs = [];
  const ctx = {
    /**
     * @param {string} name
     * @param {Function} listener
     */
    on(name, listener) {
      handlers.set(name, listener);
      return () => handlers.delete(name);
    },
    logger: {
      /** @param {string} message */
      warn(message) {
        logs.push(String(message));
      },
    },
  };
  return { ctx, handlers, logs };
}

/**
 * 建一个临时 store + 工作目录。
 * @param {Record<string, any>} [options]
 * @returns {Promise<{root: string, cwd: string, store: ReturnType<typeof createFileStore>}>}
 */
async function makeEnv(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "session-rewind-tracking-"));
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const store = createFileStore({
    home: path.join(root, "data"),
    options: { pruneEvery: 0, ...options },
  });
  return { root, cwd, store };
}

/**
 * 驱动一次工具调用的三个钩子：execute -> post-execute -> result。
 * @param {{handlers: Map<string, any>}} bus
 * @param {any} exec
 * @param {() => Promise<any>} body 模拟工具本体，返回工具结果 value
 * @returns {Promise<{result: any, decision: any}>}
 */
async function runTool(bus, exec, body) {
  const execute = bus.handlers.get("tools/execute");
  const postExecute = bus.handlers.get("tools/post-execute");
  const result = await execute(exec, async () => ({ isError: false, value: await body() }));
  const decision = await postExecute(exec, result, async () => ({ kind: "accept" }));
  bus.handlers.get("tools/result")?.(exec, result);
  return { result, decision };
}

test("parsePatchPaths: 解析 add/update/delete/move", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+hello",
    "*** Update File: src/app.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: old.txt",
    "*** Update File: src/move.ts",
    "*** Move to: src/moved.ts",
    "@@",
    "-a",
    "+b",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(parsePatchPaths(patch), [
    { kind: "add", path: "src/new.ts" },
    { kind: "update", path: "src/app.ts" },
    { kind: "delete", path: "old.txt" },
    { kind: "move", path: "src/move.ts", destination: "src/moved.ts" },
  ]);
});

test("parsePatchPaths: 忽略 hunk 内容里的伪头部与 CRLF", () => {
  const patch = [
    "*** Begin Patch\r",
    "*** Update File: a.txt\r",
    "@@ context\r",
    " *** Add File: not-a-header.txt\r",
    "- *** Delete File: also-not.txt\r",
    "*** End Patch\r",
  ].join("\n");
  assert.deepEqual(parsePatchPaths(patch), [{ kind: "update", path: "a.txt" }]);
});

test("parsePatchPaths: 兼容 heredoc 包裹与空输入", () => {
  const patch = [
    "<<'EOF'",
    "*** Begin Patch",
    "*** Delete File: gone.txt",
    "*** End Patch",
    "EOF",
  ].join("\n");
  assert.deepEqual(parsePatchPaths(patch), [{ kind: "delete", path: "gone.txt" }]);
  assert.deepEqual(parsePatchPaths(""), []);
  assert.deepEqual(parsePatchPaths(null), []);
  assert.deepEqual(parsePatchPaths("*** Add File: unterminated.txt"), []);
});

test("commitFromToolResult: write create / update 直接采用结果 value", () => {
  const create = commitFromToolResult(
    { name: "write", callId: "c1" },
    {
      isError: false,
      value: { path: "/w/a.txt", operation: "create", before: null, after: "hello" },
    },
    undefined,
  );
  assert.deepEqual(create, {
    tool: "write",
    callId: "c1",
    changes: [{ path: "/w/a.txt", existedBefore: false, before: null, after: "hello" }],
  });
  const update = commitFromToolResult(
    { name: "write", callId: "c2" },
    {
      isError: false,
      value: { path: "/w/a.txt", operation: "update", before: "old", after: "new" },
    },
    undefined,
  );
  assert.deepEqual(update.changes, [
    { path: "/w/a.txt", existedBefore: true, before: "old", after: "new" },
  ]);
});

test("commitFromToolResult: edit 优先用 value，缺失时退回 pending 捕获", () => {
  const fromValue = commitFromToolResult(
    { name: "edit", callId: "c1" },
    { isError: false, value: { path: "/w/a.txt", before: "old", after: "new" } },
    undefined,
  );
  assert.deepEqual(fromValue.changes, [
    { path: "/w/a.txt", existedBefore: true, before: "old", after: "new" },
  ]);

  const capture = {
    ok: true,
    path: "a.txt",
    absPath: "/w/a.txt",
    existedBefore: true,
    text: "old",
    mode: 0o644,
    paths: new Map([
      [
        "a.txt",
        {
          ok: true,
          path: "a.txt",
          absPath: "/w/a.txt",
          existedBefore: true,
          text: "old",
          mode: 0o644,
        },
      ],
    ]),
  };
  const fromCapture = commitFromToolResult(
    { name: "edit", callId: "c2" },
    { isError: false, value: { path: "/w/a.txt" } },
    capture,
  );
  assert.deepEqual(fromCapture.changes, [
    { path: "/w/a.txt", existedBefore: true, before: "old", after: undefined },
  ]);
});

test("commitFromToolResult: apply_patch 只处理 completed 并展开 changes", () => {
  const value = {
    phase: "commit",
    cancelled: false,
    affectedPaths: [],
    operations: [
      {
        index: 0,
        kind: "add",
        path: "/w/new.txt",
        status: "completed",
        changes: [{ path: "/w/new.txt", before: null, after: "fresh" }],
      },
      {
        index: 1,
        kind: "update",
        path: "/w/u.txt",
        status: "completed",
        changes: [{ path: "/w/u.txt", before: "old", after: "new" }],
      },
      {
        index: 2,
        kind: "delete",
        path: "/w/d.txt",
        status: "completed",
        changes: [{ path: "/w/d.txt", before: "bye", after: null }],
      },
      {
        index: 3,
        kind: "move",
        path: "/w/src.txt",
        destination: "/w/dst.txt",
        status: "completed",
        changes: [
          { path: "/w/dst.txt", before: null, after: "mv" },
          { path: "/w/src.txt", before: "mv", after: null },
        ],
      },
      { index: 4, kind: "update", path: "/w/skipped.txt", status: "failed", changes: [] },
      { index: 5, kind: "update", path: "/w/skipped2.txt", status: "skipped" },
    ],
  };
  const changeSet = commitFromToolResult(
    { name: "apply_patch", callId: "c1" },
    { isError: false, value },
    undefined,
  );
  assert.deepEqual(
    changeSet.changes.map((change) => [
      change.path,
      change.existedBefore,
      change.before,
      change.after,
    ]),
    [
      ["/w/new.txt", false, null, "fresh"],
      ["/w/u.txt", true, "old", "new"],
      ["/w/d.txt", true, "bye", null],
      ["/w/dst.txt", false, null, "mv"],
      ["/w/src.txt", true, "mv", null],
    ],
  );
});

test("commitFromToolResult: 工具失败 / 非追踪工具 / 无 value 时为空", () => {
  assert.deepEqual(
    commitFromToolResult({ name: "write", callId: "c1" }, { isError: true }, undefined).changes,
    [],
  );
  assert.deepEqual(
    commitFromToolResult(
      { name: "read", callId: "c1" },
      { isError: false, value: { path: "/w/a.txt" } },
      undefined,
    ).changes,
    [],
  );
  assert.deepEqual(
    commitFromToolResult({ name: "write", callId: "c1" }, { isError: false }, undefined).changes,
    [],
  );
  assert.deepEqual(TRACKED_TOOLS, ["write", "edit", "apply_patch"]);
  assert.equal(DEFAULT_TRACKING_OPTIONS.enabled, true);
});

test("latestHumanUserSeq: 取最近一条真人消息并做增量缓存", () => {
  const events = makeEvents(5, [1, 3]);
  const session = makeSession("s", "/w", events);
  const cache = new Map();
  assert.equal(latestHumanUserSeq(session, cache), 3);
  assert.deepEqual(cache.get("s"), { length: 5, seq: 3 });
  // 同一份日志（长度不变）直接命中缓存
  assert.equal(latestHumanUserSeq(session, cache), 3);
  const noHuman = makeSession("t", "/w", makeEvents(3, []));
  assert.equal(latestHumanUserSeq(noHuman), 0);
  assert.equal(latestHumanUserSeq(null), 0);
});

test("installFileTracking: write 新建文件入库（create）", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "write", { file_path: "note.txt", content: "hello" });
  const target = path.join(env.cwd, "note.txt");

  const { result, decision } = await runTool(bus, exec, async () => {
    await writeFile(target, "hello");
    return { path: target, operation: "create", before: null, after: "hello" };
  });
  assert.equal(result.isError, false);
  assert.deepEqual(decision, { kind: "accept" });

  const entries = await env.store.entriesForSession("session-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "note.txt");
  assert.equal(entries[0].existedBefore, false);
  assert.equal(entries[0].tool, "write");
  assert.equal(entries[0].callId, "call-1");
  assert.equal(entries[0].anchorSeq, 0);
  assert.equal((await env.store.readBlob(entries[0].afterHash))?.toString("utf8"), "hello");
});

test("installFileTracking: write 覆盖已有文件（update）记录 before/after", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const target = path.join(env.cwd, "note.txt");
  await writeFile(target, "old");
  const session = makeSession("session-1", env.cwd, makeEvents(3, [2]));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "write", { file_path: "note.txt", content: "new" });
  await runTool(bus, exec, async () => {
    await writeFile(target, "new");
    return { path: target, operation: "update", before: "old", after: "new" };
  });
  const entries = await env.store.entriesForSession("session-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].existedBefore, true);
  assert.equal(entries[0].anchorSeq, 2);
  assert.equal((await env.store.readBlob(entries[0].beforeHash))?.toString("utf8"), "old");
  assert.equal((await env.store.readBlob(entries[0].afterHash))?.toString("utf8"), "new");
});

test("installFileTracking: edit 在结果缺 before/after 时用 pending 捕获 + 读盘", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const target = path.join(env.cwd, "app.js");
  await writeFile(target, "old");
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "edit", {
    file_path: "app.js",
    old_string: "old",
    new_string: "new",
  });
  await runTool(bus, exec, async () => {
    await writeFile(target, "new");
    return { path: target };
  });
  const entries = await env.store.entriesForSession("session-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, "edit");
  assert.equal((await env.store.readBlob(entries[0].beforeHash))?.toString("utf8"), "old");
  assert.equal((await env.store.readBlob(entries[0].afterHash))?.toString("utf8"), "new");
});

test("installFileTracking: apply_patch 的 add/update/delete/move 都入库", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  await writeFile(path.join(env.cwd, "update.txt"), "old");
  await writeFile(path.join(env.cwd, "delete.txt"), "bye");
  await writeFile(path.join(env.cwd, "move-src.txt"), "mv");
  const patch = [
    "*** Begin Patch",
    "*** Add File: new.txt",
    "+fresh",
    "*** Update File: update.txt",
    "@@",
    "-old",
    "+new",
    "*** Delete File: delete.txt",
    "*** Update File: move-src.txt",
    "*** Move to: move-dst.txt",
    "@@",
    "-mv",
    "+mv2",
    "*** End Patch",
  ].join("\n");
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "apply_patch", { input: patch });
  /** @param {string} name @returns {string} */
  const abs = (name) => path.join(env.cwd, name);

  await runTool(bus, exec, async () => {
    await writeFile(abs("new.txt"), "fresh");
    await writeFile(abs("update.txt"), "new");
    await rm(abs("delete.txt"));
    await writeFile(abs("move-dst.txt"), "mv2");
    await rm(abs("move-src.txt"));
    return {
      phase: "commit",
      cancelled: false,
      affectedPaths: [
        abs("new.txt"),
        abs("update.txt"),
        abs("delete.txt"),
        abs("move-dst.txt"),
        abs("move-src.txt"),
      ],
      operations: [
        {
          index: 0,
          kind: "add",
          path: abs("new.txt"),
          status: "completed",
          changes: [{ path: abs("new.txt"), before: null, after: "fresh" }],
        },
        {
          index: 1,
          kind: "update",
          path: abs("update.txt"),
          status: "completed",
          changes: [{ path: abs("update.txt"), before: "old", after: "new" }],
        },
        {
          index: 2,
          kind: "delete",
          path: abs("delete.txt"),
          status: "completed",
          changes: [{ path: abs("delete.txt"), before: "bye", after: null }],
        },
        {
          index: 3,
          kind: "move",
          path: abs("move-src.txt"),
          destination: abs("move-dst.txt"),
          status: "completed",
          changes: [
            { path: abs("move-dst.txt"), before: null, after: "mv2" },
            { path: abs("move-src.txt"), before: "mv", after: null },
          ],
        },
        {
          index: 4,
          kind: "update",
          path: abs("skipped.txt"),
          status: "failed",
          changes: [],
          failure: { code: "FS_IO_ERROR", message: "boom" },
        },
      ],
    };
  });

  const entries = await env.store.entriesForSession("session-1");
  assert.equal(entries.length, 5);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("new.txt")?.existedBefore, false);
  assert.equal(byPath.get("update.txt")?.existedBefore, true);
  assert.equal(byPath.get("delete.txt")?.afterHash, null);
  assert.equal(byPath.get("move-dst.txt")?.existedBefore, false);
  assert.equal(byPath.get("move-src.txt")?.afterHash, null);
  assert.equal(byPath.has("skipped.txt"), false);
});

test("installFileTracking: 子代理会话与嵌套执行不追踪", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const target = path.join(env.cwd, "a.txt");

  const subagent = makeSession("session-sub", env.cwd, makeEvents(2, [0]), { origin: "subagent" });
  await runTool(bus, makeExec(subagent, "write", { file_path: "a.txt" }), async () => {
    await writeFile(target, "x");
    return { path: target, operation: "create", before: null, after: "x" };
  });
  const delegated = makeSession("session-deep", env.cwd, makeEvents(2, [0]), {
    delegationDepth: 1,
  });
  await runTool(bus, makeExec(delegated, "write", { file_path: "a.txt" }), async () => {
    await writeFile(target, "x");
    return { path: target, operation: "create", before: null, after: "x" };
  });
  const nested = makeSession("session-nested", env.cwd, makeEvents(2, [0]));
  await runTool(
    bus,
    makeExec(nested, "write", { file_path: "a.txt" }, "call-nested", { parent: {} }),
    async () => {
      await writeFile(target, "x");
      return { path: target, operation: "create", before: null, after: "x" };
    },
  );
  assert.deepEqual(await env.store.entriesForSession("session-sub"), []);
  assert.deepEqual(await env.store.entriesForSession("session-deep"), []);
  assert.deepEqual(await env.store.entriesForSession("session-nested"), []);
});

test("installFileTracking: options.enabled=false 时不注册任何监听", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const bus = createBus();
  const tracking = installFileTracking(bus.ctx, { store: env.store, options: { enabled: false } });
  assert.equal(bus.handlers.size, 0);
  assert.equal(tracking.pending.size, 0);
  assert.doesNotThrow(() => tracking.dispose());
});

test("installFileTracking: 跳过 .git/逃逸/符号链接路径，但工具照常执行", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const outside = path.join(env.root, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, path.join(env.cwd, "link.txt"));
  await mkdir(path.join(env.cwd, ".git"), { recursive: true });

  const cases = [
    { filePath: "../outside.txt", target: outside, content: "escaped" },
    { filePath: ".git/config", target: path.join(env.cwd, ".git", "config"), content: "[core]" },
    { filePath: "link.txt", target: outside, content: "through-link" },
  ];
  for (const [index, item] of cases.entries()) {
    const exec = makeExec(
      session,
      "write",
      { file_path: item.filePath, content: item.content },
      `call-${index}`,
    );
    const { result } = await runTool(bus, exec, async () => {
      await writeFile(item.target, item.content);
      return {
        path: path.resolve(env.cwd, item.filePath),
        operation: "update",
        before: "secret",
        after: item.content,
      };
    });
    assert.equal(result.isError, false);
  }
  assert.deepEqual(await env.store.entriesForSession("session-1"), []);
});

test("installFileTracking: store 抛错时工具不被阻断，只记录 warn", async (t) => {
  const env = await makeEnv();
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  const brokenStore = {
    captureBefore: async () => {
      throw new Error("capture boom");
    },
    recordChange: async () => {
      throw new Error("record boom");
    },
  };
  installFileTracking(bus.ctx, { store: brokenStore });
  const exec = makeExec(session, "write", { file_path: "a.txt" });
  let bodyRan = false;
  const { result, decision } = await runTool(bus, exec, async () => {
    bodyRan = true;
    return { path: path.join(env.cwd, "a.txt"), operation: "create", before: null, after: "x" };
  });
  assert.equal(bodyRan, true);
  assert.equal(result.isError, false);
  assert.deepEqual(decision, { kind: "accept" });
  assert.equal(
    bus.logs.some((line) => line.includes("capture failed")),
    true,
  );
  assert.equal(
    bus.logs.some((line) => line.includes("commit failed")),
    true,
  );
});

test("installFileTracking: tools/result 清理 pending（异常路径）", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  const tracking = installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "write", { file_path: "a.txt" });
  const result = await bus.handlers.get("tools/execute")(exec, async () => ({
    isError: false,
    value: { path: path.join(env.cwd, "a.txt"), operation: "create", before: null, after: "x" },
  }));
  assert.equal(tracking.pending.size, 1);
  bus.handlers.get("tools/result")(exec, result);
  assert.equal(tracking.pending.size, 0);
  tracking.dispose();
  assert.equal(bus.handlers.size, 0);
});

test("installFileTracking: post-execute 的 next 抛错时清理 pending 并向上抛", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  const tracking = installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "write", { file_path: "a.txt" });
  await bus.handlers.get("tools/execute")(exec, async () => ({ isError: false, value: {} }));
  assert.equal(tracking.pending.size, 1);
  await assert.rejects(
    bus.handlers.get("tools/post-execute")(exec, { isError: false, value: {} }, async () => {
      throw new Error("downstream policy exploded");
    }),
    /downstream policy exploded/,
  );
  assert.equal(tracking.pending.size, 0);
});

test("installFileTracking: 超大文件被 skip 并留下 skipped entry", async (t) => {
  const env = await makeEnv({ maxFileBytes: 4, pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const target = path.join(env.cwd, "big.txt");
  await writeFile(target, "0123456789");
  const session = makeSession("session-1", env.cwd, makeEvents(2, [0]));
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const exec = makeExec(session, "edit", {
    file_path: "big.txt",
    old_string: "0",
    new_string: "1",
  });
  await runTool(bus, exec, async () => {
    await writeFile(target, "1123456789");
    return { path: target, before: "0123456789", after: "1123456789" };
  });
  const entries = await env.store.entriesForSession("session-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].skipped, "too-large");
});

test("installFileTracking: entry.anchorSeq 跟随最近一条真人消息", async (t) => {
  const env = await makeEnv({ pruneEvery: 0 });
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const events = makeEvents(6, [1, 4]);
  const session = makeSession("session-1", env.cwd, events);
  const bus = createBus();
  installFileTracking(bus.ctx, { store: env.store });
  const target = path.join(env.cwd, "a.txt");
  const exec = makeExec(session, "write", { file_path: "a.txt" });
  await runTool(bus, exec, async () => {
    await writeFile(target, "x");
    return { path: target, operation: "create", before: null, after: "x" };
  });
  const entries = await env.store.entriesForSession("session-1");
  assert.equal(entries[0].anchorSeq, 4);
});
