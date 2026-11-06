// @ts-check
// 文件追踪层：把宿主的工具执行事件接到 files.js 的存储上。
//
// 挂载点（DSH 0.2.2-rc.1，见 docs/runtime/0.2.2-rc.1.md 与 dsh-tools/lib/pipeline.js）：
//   - `tools/execute` waterfall `(exec, next)`：在 `next()` **之前**抓 before；
//   - `tools/post-execute` waterfall `(exec, result, next)`：工具成功后提交 entry；
//   - `tools/result` emit `(exec, result)`：兜底清理 pending。
//
// 契约（设计 §2.1）：只处理 write / edit / apply_patch；子代理会话与嵌套执行不追踪；
// 任何失败只 warn，绝不阻断工具。本模块刻意不 import 任何东西（宿主与 files.js 都靠
// 结构化形状），因此可以脱离宿主单测。

/** 需要追踪的工具名。 */
export const TRACKED_TOOLS = Object.freeze(["write", "edit", "apply_patch"]);

/** Codex patch 头（与 @deepseek-ai/dsh-fs-patch 的解析器保持一致）。 */
const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const PATCH_ADD = "*** Add File: ";
const PATCH_DELETE = "*** Delete File: ";
const PATCH_UPDATE = "*** Update File: ";
const PATCH_MOVE = "*** Move to: ";

/**
 * 追踪选项。
 * @typedef {object} FileTrackingOptions
 * @property {boolean} enabled 总开关；false 时 installFileTracking 不注册任何监听
 * @property {boolean} capture 是否在工具执行前做 before 捕获（关闭则只能靠结果值）
 * @property {boolean} trackSubagents 是否追踪子代理会话（默认 false，设计 §2.1）
 */

/** 默认追踪选项。 */
/** @type {Readonly<FileTrackingOptions>} */
export const DEFAULT_TRACKING_OPTIONS = Object.freeze({
  enabled: true,
  capture: true,
  trackSubagents: false,
});

/**
 * @typedef {object} TrackingLogger
 * @property {(message: string) => void} [warn]
 * @property {(message: string) => void} [debug]
 */

/**
 * files.js store 的最小结构化契约（不 import，保持本模块可单测）。
 * @typedef {object} FileStoreLike
 * @property {(cwd: string, input: unknown) => Promise<any>} captureBefore
 * @property {(change: any) => Promise<any>} recordChange
 * @property {(cwd: string, input: unknown) => any} [safeRelativePath]
 */

/**
 * @typedef {object} InstallFileTrackingDeps
 * @property {FileStoreLike} store 文件引擎
 * @property {Partial<FileTrackingOptions>} [options] 追踪选项
 * @property {TrackingLogger} [logger] 日志（缺省用 ctx.logger）
 * @property {(session: any) => boolean} [isSubagentSession] 子代理判定（缺省看 header）
 * @property {(session: any) => string | undefined} [cwdOf] 会话 cwd 解析（缺省看 header.cwd）
 */

/**
 * 一条工具的改动描述（纯数据，`undefined` 表示「未知，调用方读盘补」）。
 * @typedef {object} ToolChange
 * @property {string} path 工具返回值里的路径（绝对或相对）
 * @property {boolean | undefined} existedBefore 改动前是否存在
 * @property {string | null | undefined} before 改动前文本（null = 不存在）
 * @property {string | null | undefined} after 改动后文本（null = 已删除）
 */

/**
 * `commitFromToolResult` 的结果。
 * @typedef {object} ToolChangeSet
 * @property {string} tool 工具名
 * @property {string | null} callId 调用 id
 * @property {ToolChange[]} changes 本次工具成功造成的逐路径改动
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

/**
 * @param {unknown} value
 * @returns {string | null | undefined} string -> 原值；null -> null；其他 -> undefined
 */
function textValue(value) {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return undefined;
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimText(value) {
  return value.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimEndText(value) {
  return value.replace(/[\p{White_Space}]+$/u, "");
}

/**
 * @typedef {object} PatchPathOperation
 * @property {"add" | "update" | "delete" | "move"} kind 操作类型（update + Move to 记为 move）
 * @property {string} path 源路径（patch 里的原始写法）
 * @property {string} [destination] move 的目标路径
 */

/**
 * 从 `apply_patch` 的 patch 文本里解析出会被触碰的路径（设计 §2.1）。
 *
 * 只做「够用」的解析：识别 `*** Add File:` / `*** Update File:` / `*** Delete File:` /
 * `*** Move to:`，忽略 hunk 内容。与宿主解析器一样，进入 update 操作后用 `trimEnd`
 * 判定头部，避免把 ` *** Add File: x` 这类上下文行误判成新操作。
 * @param {unknown} patchText patch 文本
 * @returns {PatchPathOperation[]}
 */
export function parsePatchPaths(patchText) {
  if (typeof patchText !== "string" || patchText.length === 0) return [];
  /** @type {PatchPathOperation[]} */
  const operations = [];
  let started = false;
  /** @type {PatchPathOperation | null} */
  let current = null;
  let hunkSeen = false;
  for (const raw of patchText.split(/\r?\n/)) {
    if (!started) {
      if (trimText(raw) === PATCH_BEGIN) started = true;
      continue;
    }
    /** @type {string} */
    const header =
      current !== null && current.kind !== "add" && hunkSeen ? trimEndText(raw) : trimText(raw);
    if (header === PATCH_END) break;
    if (header.startsWith(PATCH_ADD)) {
      current = { kind: "add", path: header.slice(PATCH_ADD.length) };
      operations.push(current);
      hunkSeen = false;
      continue;
    }
    if (header.startsWith(PATCH_DELETE)) {
      current = { kind: "delete", path: header.slice(PATCH_DELETE.length) };
      operations.push(current);
      hunkSeen = false;
      continue;
    }
    if (header.startsWith(PATCH_UPDATE)) {
      current = { kind: "update", path: header.slice(PATCH_UPDATE.length) };
      operations.push(current);
      hunkSeen = false;
      continue;
    }
    if (
      current !== null &&
      current.kind === "update" &&
      !hunkSeen &&
      trimEndText(raw).startsWith(PATCH_MOVE)
    ) {
      current.kind = "move";
      current.destination = trimEndText(raw).slice(PATCH_MOVE.length);
      continue;
    }
    if (
      current !== null &&
      raw.length > 0 &&
      (raw.startsWith(" ") ||
        raw.startsWith("+") ||
        raw.startsWith("-") ||
        raw === "@@" ||
        raw.startsWith("@@ "))
    ) {
      hunkSeen = true;
    }
  }
  return operations;
}

/**
 * 从 pending 捕获里找出某个路径的 before 快照。
 * @param {any} capture installFileTracking 内部捕获记录
 * @param {string} targetPath 工具返回值里的路径
 * @returns {any | null}
 */
function captureFor(capture, targetPath) {
  if (!isRecord(capture) || !(capture.paths instanceof Map)) return null;
  const direct = capture.paths.get(targetPath);
  if (direct !== undefined) return direct;
  for (const [input, captured] of capture.paths) {
    if (input === targetPath) return captured;
    if (!isRecord(captured)) continue;
    if (captured.path === targetPath || captured.absPath === targetPath) return captured;
  }
  return null;
}

/**
 * @param {any} capture 捕获记录
 * @param {string} [targetPath] 目标路径
 * @returns {string | null | undefined}
 */
function capturedTextAt(capture, targetPath) {
  return capturedTextOf(singleCaptureOf(capture, targetPath));
}

/**
 * 把「pending 记录（含 paths Map）」或「单文件捕获」归一成单文件捕获。
 * @param {any} capture 捕获记录
 * @param {string} [targetPath] 优先匹配的路径
 * @returns {any | null}
 */
function singleCaptureOf(capture, targetPath) {
  if (!isRecord(capture)) return null;
  if (capture.paths instanceof Map) {
    if (typeof targetPath === "string" && targetPath.length > 0) {
      const matched = captureFor(capture, targetPath);
      if (matched !== null) return matched;
    }
    for (const value of capture.paths.values()) {
      if (isRecord(value)) return value;
    }
    return null;
  }
  return capture;
}

/**
 * @param {any} capture 捕获记录
 * @returns {string | null}
 */
function capturedPathOf(capture) {
  const single = singleCaptureOf(capture);
  if (single !== null && typeof single.absPath === "string" && single.absPath.length > 0) {
    return single.absPath;
  }
  return null;
}

/**
 * @param {any} capture 捕获记录
 * @returns {string | null | undefined} 捕获到的 before 文本；不可用时 undefined
 */
function capturedTextOf(capture) {
  const single = singleCaptureOf(capture);
  if (single === null || single.ok !== true) return undefined;
  if (single.existedBefore !== true) return null;
  return typeof single.text === "string" ? single.text : undefined;
}

/**
 * 从工具结果算出「本次成功改了什么」（纯函数，不读盘、不写盘）。
 *
 * - `write`：结果 value 为 `{path, operation, before, after}`，直接采用；
 * - `edit`：0.2.2-rc.1 的 value 已带 `before/after`，缺失时退回 pending 捕获 + 读盘；
 * - `apply_patch`：只处理 `status === "completed"` 的操作，按 `changes[]` 展开；
 *   没有 `changes` 时按 kind（add/update/delete/move）退化处理。
 * @param {any} exec 工具执行（`{name, callId}`）
 * @param {any} result 工具结果（`{isError, value}`）
 * @param {any} [capture] before 捕获记录
 * @returns {ToolChangeSet}
 */
export function commitFromToolResult(exec, result, capture) {
  const tool = isRecord(exec) && typeof exec.name === "string" ? exec.name : "";
  const callId =
    isRecord(exec) && typeof exec.callId === "string" && exec.callId.length > 0
      ? exec.callId
      : null;
  /** @type {ToolChangeSet} */
  const changeSet = { tool, callId, changes: [] };
  if (!TRACKED_TOOLS.includes(tool)) return changeSet;
  if (!isRecord(result) || result.isError === true) return changeSet;
  const value = result.value;

  if (tool === "write") {
    if (isRecord(value)) {
      const path =
        typeof value.path === "string" && value.path.length > 0
          ? value.path
          : capturedPathOf(capture);
      if (path === null) return changeSet;
      const before = textValue(value.before);
      const after = textValue(value.after);
      const existedBefore = before !== undefined ? before !== null : undefined;
      changeSet.changes.push({ path, existedBefore, before, after });
      return changeSet;
    }
    const path = capturedPathOf(capture);
    const before = capturedTextAt(capture, path ?? undefined);
    if (path === null || before === undefined) return changeSet;
    changeSet.changes.push({ path, existedBefore: before !== null, before, after: undefined });
    return changeSet;
  }

  if (tool === "edit") {
    const path =
      isRecord(value) && typeof value.path === "string" && value.path.length > 0
        ? value.path
        : capturedPathOf(capture);
    if (path === null) return changeSet;
    let before = isRecord(value) ? textValue(value.before) : undefined;
    if (before === undefined) before = capturedTextAt(capture, path);
    if (before === undefined) return changeSet;
    const after = isRecord(value) ? textValue(value.after) : undefined;
    changeSet.changes.push({ path, existedBefore: before !== null, before, after });
    return changeSet;
  }

  // apply_patch
  const operations = isRecord(value) && Array.isArray(value.operations) ? value.operations : [];
  for (const operation of operations) {
    if (!isRecord(operation) || operation.status !== "completed") continue;
    const changes = Array.isArray(operation.changes) ? operation.changes : [];
    if (changes.length > 0) {
      for (const change of changes) {
        if (!isRecord(change) || typeof change.path !== "string" || change.path.length === 0)
          continue;
        const before = textValue(change.before);
        if (before === undefined) continue;
        changeSet.changes.push({
          path: change.path,
          existedBefore: before !== null,
          before,
          after: textValue(change.after),
        });
      }
      continue;
    }
    const path = typeof operation.path === "string" ? operation.path : "";
    if (path.length === 0) continue;
    if (operation.kind === "add") {
      changeSet.changes.push({ path, existedBefore: false, before: null, after: undefined });
      continue;
    }
    const before = capturedTextAt(capture, path);
    if (before === undefined) continue;
    if (operation.kind === "delete") {
      changeSet.changes.push({ path, existedBefore: true, before, after: null });
      continue;
    }
    changeSet.changes.push({ path, existedBefore: before !== null, before, after: undefined });
    if (
      operation.kind === "move" &&
      typeof operation.destination === "string" &&
      operation.destination.length > 0
    ) {
      changeSet.changes.push({
        path: operation.destination,
        existedBefore: false,
        before: null,
        after: undefined,
      });
    }
  }
  return changeSet;
}

/**
 * 找出会话日志里最近一条真人 `user/message` 的 seq（没有则 0）。
 *
 * anchorSeq 是「这次改动属于哪一轮对话」的分界：回溯到 targetSeq 时只撤销
 * anchorSeq >= targetSeq 的改动。按「日志长度」做增量缓存，同一轮工具调用里不重复扫描。
 * @param {any} session 会话（需要 `id` 与 `snapshotEvents()`）
 * @param {Map<string, {length: number, seq: number}>} [cache] 增量缓存
 * @returns {number}
 */
export function latestHumanUserSeq(session, cache) {
  if (!isRecord(session) || typeof session.snapshotEvents !== "function") return 0;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return 0;
  }
  if (!Array.isArray(events) || events.length === 0) return 0;
  const sessionId = typeof session.id === "string" ? session.id : "";
  const cached = cache?.get(sessionId);
  if (cached !== undefined && cached.length === events.length) return cached.seq;
  let seq = 0;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!isRecord(event) || event.type !== "user/message" || !isRecord(event.data)) continue;
    const source = event.data.source;
    if (!isRecord(source) || source.kind !== "user") continue;
    seq =
      typeof event.seq === "number" && Number.isSafeInteger(event.seq) && event.seq >= 0
        ? event.seq
        : 0;
    break;
  }
  cache?.set(sessionId, { length: events.length, seq });
  return seq;
}

/**
 * 安装文件追踪钩子。
 *
 * 返回 `{pending, dispose, capture, commit}`：`dispose()` 卸掉全部监听（测试/热重载用），
 * `pending` 是进行中的捕获表（每会话每 callId 一条）。
 * @param {any} ctx host 上下文（需要 `on(name, listener)` 与可选 `logger`）
 * @param {InstallFileTrackingDeps} deps 依赖
 * @returns {{pending: Map<string, any>, dispose: () => void, capture: (exec: any) => Promise<any>, commit: (exec: any, result: any) => Promise<void>}}
 */
export function installFileTracking(ctx, deps) {
  const options = { ...DEFAULT_TRACKING_OPTIONS, ...(deps?.options ?? {}) };
  const store = deps?.store;
  const logger = deps?.logger ?? (isRecord(ctx) ? ctx.logger : undefined);
  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {Map<string, {length: number, seq: number}>} */
  const anchorCache = new Map();
  /** @type {Function[]} */
  const disposers = [];

  /**
   * 日志失败也不能影响工具。
   * @param {string} scope
   * @param {unknown} error
   * @returns {void}
   */
  function report(scope, error) {
    try {
      const warn = isRecord(logger) ? logger.warn : undefined;
      if (typeof warn === "function")
        warn(`session-rewind/file-tracking: ${scope}: ${messageOf(error)}`);
    } catch {
      // 日志本身失败就彻底放弃
    }
  }

  /**
   * @param {any} exec
   * @returns {string}
   */
  function keyOf(exec) {
    const sessionId =
      isRecord(exec) && isRecord(exec.agent) && isRecord(exec.agent.session)
        ? exec.agent.session.id
        : "";
    const callId = isRecord(exec) && typeof exec.callId === "string" ? exec.callId : "";
    return `${typeof sessionId === "string" ? sessionId : ""}:${callId}`;
  }

  /**
   * @param {any} exec
   * @returns {any | null}
   */
  function contextOf(exec) {
    if (!isRecord(exec) || typeof exec.name !== "string") return null;
    if (!TRACKED_TOOLS.includes(exec.name)) return null;
    if (exec.parent !== undefined) return null;
    if (!isRecord(exec.agent) || !isRecord(exec.agent.session)) return null;
    const session = exec.agent.session;
    /** @type {Record<string, any>} */
    const header = isRecord(session.header) ? session.header : {};
    if (options.trackSubagents !== true) {
      const subagent =
        typeof deps.isSubagentSession === "function"
          ? deps.isSubagentSession(session) === true
          : header.origin === "subagent" ||
            (typeof header.delegationDepth === "number" && header.delegationDepth > 0);
      if (subagent) return null;
    }
    const injectedCwd = typeof deps.cwdOf === "function" ? deps.cwdOf(session) : undefined;
    const cwd =
      typeof injectedCwd === "string" && injectedCwd.length > 0
        ? injectedCwd
        : typeof header.cwd === "string" && header.cwd.length > 0
          ? header.cwd
          : null;
    if (cwd === null) return null;
    const sessionId =
      typeof session.id === "string" && session.id.length > 0
        ? session.id
        : typeof exec.agent.id === "string"
          ? exec.agent.id
          : null;
    if (sessionId === null) return null;
    return {
      session,
      sessionId,
      cwd,
      anchorSeq: latestHumanUserSeq(session, anchorCache),
      key: keyOf(exec),
    };
  }

  /**
   * `tools/execute` 之前抓 before（写盘失败只 warn）。
   * @param {any} exec
   * @returns {Promise<any | null>}
   */
  async function capture(exec) {
    const context = contextOf(exec);
    if (context === null || store === undefined) return null;
    const record = {
      session: context.session,
      sessionId: context.sessionId,
      cwd: context.cwd,
      anchorSeq: context.anchorSeq,
      key: context.key,
      tool: exec.name,
      callId: typeof exec.callId === "string" ? exec.callId : null,
      capturedAt: Date.now(),
      /** @type {Map<string, any>} */
      paths: new Map(),
    };
    /** @type {string[]} */
    const inputs = [];
    if (exec.name === "apply_patch") {
      const patch = isRecord(exec.arguments) ? exec.arguments.input : undefined;
      for (const operation of parsePatchPaths(patch)) {
        if (operation.path.length > 0) inputs.push(operation.path);
        if (typeof operation.destination === "string" && operation.destination.length > 0) {
          inputs.push(operation.destination);
        }
      }
    } else {
      const filePath = isRecord(exec.arguments) ? exec.arguments.file_path : undefined;
      if (typeof filePath === "string" && filePath.length > 0) inputs.push(filePath);
    }
    for (const input of inputs) {
      const captured = await store.captureBefore(context.cwd, input);
      record.paths.set(input, captured);
      if (isRecord(captured) && typeof captured.path === "string" && captured.path.length > 0) {
        record.paths.set(captured.path, captured);
        if (typeof captured.absPath === "string" && captured.absPath.length > 0) {
          record.paths.set(captured.absPath, captured);
        }
      }
    }
    pending.set(context.key, record);
    return record;
  }

  /**
   * `tools/post-execute`：把成功的工具结果提交成 entry。
   * @param {any} exec
   * @param {any} result
   * @returns {Promise<void>}
   */
  async function commit(exec, result) {
    if (store === undefined) return;
    const captureRecord = pending.get(keyOf(exec)) ?? null;
    const context = captureRecord ?? contextOf(exec);
    if (context === null) return;
    const changeSet = commitFromToolResult(exec, result, captureRecord);
    if (changeSet.changes.length === 0) return;
    const anchorSeq =
      typeof context.anchorSeq === "number"
        ? context.anchorSeq
        : latestHumanUserSeq(context.session, anchorCache);
    for (const change of changeSet.changes) {
      const saved = captureFor(captureRecord, change.path);
      let before = change.before;
      if (before === undefined) before = capturedTextOf(saved);
      if (before === undefined) continue;
      let after = change.after;
      if (after === undefined) {
        const read = await store.captureBefore(context.cwd, change.path);
        after =
          isRecord(read) &&
          read.ok === true &&
          read.existedBefore === true &&
          typeof read.text === "string"
            ? read.text
            : null;
      }
      const existedBefore =
        typeof change.existedBefore === "boolean" ? change.existedBefore : before !== null;
      const mode = isRecord(saved) && typeof saved.mode === "number" ? saved.mode : null;
      await store.recordChange({
        sessionId: context.sessionId,
        cwd: context.cwd,
        anchorSeq,
        tool: changeSet.tool,
        callId: changeSet.callId,
        path: change.path,
        existedBefore,
        beforeContent: before,
        afterContent: after,
        mode,
      });
    }
  }

  /**
   * @param {any} exec
   * @returns {void}
   */
  function discard(exec) {
    pending.delete(keyOf(exec));
  }

  /**
   * 把内部能力挂到 dispose 函数上：既满足 Cordis 的「返回 dispose 函数」约定，
   * 也方便测试/诊断读取 pending。
   * @param {() => void} dispose
   * @returns {any}
   */
  function expose(dispose) {
    /** @type {any} */
    const api = dispose;
    api.pending = pending;
    api.dispose = dispose;
    api.capture = capture;
    api.commit = commit;
    return api;
  }

  if (
    options.enabled === false ||
    store === undefined ||
    !isRecord(ctx) ||
    typeof ctx.on !== "function"
  ) {
    return expose(() => {});
  }

  const notify = ctx.on;
  const onExecute = async (/** @type {any} */ exec, /** @type {() => any} */ next) => {
    try {
      if (options.capture !== false) await capture(exec);
    } catch (error) {
      report("capture failed", error);
    }
    return next();
  };
  const onPostExecute = async (
    /** @type {any} */ exec,
    /** @type {any} */ result,
    /** @type {() => any} */ next,
  ) => {
    let decision;
    try {
      decision = await next();
    } catch (error) {
      discard(exec);
      throw error;
    }
    try {
      await commit(exec, result);
    } catch (error) {
      report("commit failed", error);
    } finally {
      discard(exec);
    }
    return decision;
  };
  const onResult = (/** @type {any} */ exec) => {
    discard(exec);
  };

  for (const [name, listener] of [
    ["tools/execute", onExecute],
    ["tools/post-execute", onPostExecute],
    ["tools/result", onResult],
  ]) {
    try {
      const dispose = notify.call(ctx, name, listener);
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      report(`cannot register ${name}`, error);
    }
  }

  return expose(() => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        report("dispose failed", error);
      }
    }
  });
}
