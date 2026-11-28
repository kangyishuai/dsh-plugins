// @ts-check
// USIM-U2-04：生成失败必须在聊天区/按钮处可见可操作；客户端超时 + 重试。
//
// 背景（用户实测，P2）：点「生成下一步建议」后聊天区一直显示「正在生成，请稍候」，2 分钟以上
// 不结束、无取消/重试；诊断里其实已记录失败（`json:empty`）；整页刷新后重试，聊天区又静默恢复
// 原状、无失败提示——与 README「补生成按钮会说明卡片被丢弃 / 超时或被取消」的承诺不符。
//
// 三个根因在本文件里逐条钉住（都驱动**真实 client 源码**，和 `client-card-collapse.test.js` 同一套
// 迷你 hooks 运行时；桌面只读回归负责真机 DOM 那一层）：
// 1. 手动生成失败 → loading 结束 + 一行原因摘要 + 「重试」按钮（detail 可展开）；
// 2. 自动生成失败/刷新后 → `generateState` 查到最近一次失败 → 同样显示「重试 + 原因」（不再静默）；
// 3. RPC 挂起 → 客户端超时结束 loading，**先取消服务端在途生成**再显示「生成超时，可重试」；
// 4. `inflight` 回执不再是一句永久文案 → 进入等待态轮询 `generateState`，后台失败后转为可重试错误。
//
// 时序：client 内部的 grace / 轮询 / 客户端超时都走 `setTimeout` + `Date.now()`（线上 2.5s / 2s /
// 30–60s，这里缩短成 5ms / 10ms / 40ms）。这些用例**不再用真实 sleep 猜时序**——并行全仓测试时
// 40ms 窗口会被调度抖动吃掉，把 `error.schema` 判成 `error.timeout`；`sleep(4)` 也可能实际睡几百
// 毫秒，把「loading」断言拖成「error」。现在装一个测试侧假时钟手动推进（见 `installClock`），断言
// 一律「等到目标相位」（`waitPhase`），不再依赖「睡多久才够」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const SESSION = "session-1";
const TURN = 3;

/** 迷你 hooks 运行时（与既有 client 单测同一套路：useState/useRef/useEffect/useLayoutEffect/useCallback）。 */
function createHooks() {
  /** @type {any} */
  let current = null;
  let index = 0;
  /** @type {(() => void)[]} */
  let queued = [];
  /** @type {Set<any>} */
  const dirty = new Set();

  /** @param {any} a @param {any} b */
  const sameDeps = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, at) => Object.is(value, b[at]));

  /** @param {any} fiber */
  function render(fiber) {
    current = fiber;
    index = 0;
    queued = [];
    fiber.element = fiber.Component(fiber.props);
    const effects = queued;
    queued = [];
    for (const run of effects) run();
  }

  function flush() {
    let guard = 0;
    while (dirty.size > 0 && guard < 100) {
      guard += 1;
      const list = [...dirty];
      dirty.clear();
      for (const fiber of list) if (fiber.mounted) render(fiber);
    }
  }

  /**
   * @param {Function} fn
   * @param {any[] | undefined} deps
   */
  function scheduleEffect(fn, deps) {
    const fiber = current;
    const slot = index++;
    const previous = fiber.hooks[slot];
    if (previous !== undefined && previous.kind === "effect" && sameDeps(previous.deps, deps)) {
      return;
    }
    queued.push(() => {
      if (
        previous !== undefined &&
        previous.kind === "effect" &&
        typeof previous.cleanup === "function"
      ) {
        previous.cleanup();
      }
      const cleanup = fn();
      fiber.hooks[slot] = {
        kind: "effect",
        deps: deps === undefined ? undefined : [...deps],
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    });
  }

  const React = {
    /**
     * @param {any} type
     * @param {any} props
     * @param {...any} children
     */
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    /** @param {any} initial */
    useState(initial) {
      const fiber = current;
      const slot = index++;
      if (!(slot in fiber.hooks)) {
        fiber.hooks[slot] = {
          kind: "state",
          value: typeof initial === "function" ? initial() : initial,
        };
      }
      const hook = fiber.hooks[slot];
      /** @param {any} next */
      const set = (next) => {
        const value = typeof next === "function" ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        dirty.add(fiber);
      };
      return [hook.value, set];
    },
    /** @param {any} value */
    useRef(value) {
      const fiber = current;
      const slot = index++;
      if (!(slot in fiber.hooks)) fiber.hooks[slot] = { kind: "ref", ref: { current: value } };
      return fiber.hooks[slot].ref;
    },
    /** @param {Function} fn @param {any[]} [deps] */
    useEffect(fn, deps) {
      scheduleEffect(fn, deps);
    },
    /** @param {Function} fn @param {any[]} [deps] */
    useLayoutEffect(fn, deps) {
      scheduleEffect(fn, deps);
    },
    /** @param {Function} fn @param {any[]} [deps] */
    useCallback(fn, deps) {
      const fiber = current;
      const slot = index++;
      const previous = fiber.hooks[slot];
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        fiber.hooks[slot] = { kind: "callback", deps: deps ? [...deps] : undefined, fn };
      }
      return fiber.hooks[slot].fn;
    },
  };

  return {
    React,
    /** @param {Function} Component @param {any} props */
    mount(Component, props) {
      const fiber = { Component, props, hooks: [], mounted: true, element: null };
      render(fiber);
      flush();
      return fiber;
    },
    /** @param {any} fiber @param {any} props */
    update(fiber, props) {
      fiber.props = props;
      render(fiber);
      flush();
    },
    /** @param {any} fiber */
    unmount(fiber) {
      fiber.mounted = false;
      for (const hook of fiber.hooks) {
        if (hook && hook.kind === "effect" && typeof hook.cleanup === "function") hook.cleanup();
      }
    },
    flush,
  };
}

/**
 * 受控假时钟：接管本进程的 `setTimeout` / `clearTimeout` / `Date.now`，由测试手动推进。
 *
 * 为什么需要：client 半用 `setTimeout` + `Date.now()` 表达 grace、`generateState` 轮询和客户端
 * 超时。真实定时器在**并行全仓测试**（8 包并发、机器负载高）下会被调度抖动吃掉，40ms 窗口里两次
 * 10ms 轮询还没跑完就判成超时（复审报告里的 `error.timeout` ≠ `error.schema`）。改成假时钟后时序
 * 完全确定，也不需要「睡多久才够」的经验值；Node 22/24 都能跑，且不引入任何依赖。
 *
 * 只替换全局函数，`restore()` 原样还回去（每个用例的 finally 里调用）。
 * @returns {{ advance: (ms: number, flush: () => void) => Promise<void>, restore: () => void }}
 */
function installClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;
  let now = 1_000_000;
  let nextId = 1;
  let sequence = 0;
  /** @type {Map<number, { id: number, at: number, sequence: number, run: Function, args: any[] }>} */
  const timers = new Map();

  /**
   * @param {Function} fn
   * @param {number} [ms]
   * @param {...any} args
   * @returns {number}
   */
  function fakeSetTimeout(fn, ms = 0, ...args) {
    const id = nextId++;
    timers.set(id, {
      id,
      at: now + Math.max(0, Number(ms) || 0),
      sequence: sequence++,
      run: fn,
      args,
    });
    return id;
  }

  /** @param {any} id */
  function fakeClearTimeout(id) {
    timers.delete(Number(id));
  }

  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: fakeSetTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: fakeClearTimeout,
  });
  Object.defineProperty(Date, "now", {
    configurable: true,
    writable: true,
    value: () => now,
  });

  /** 跑完微任务队列：一次 await 就会清空当前队列，多来几轮兜住链式 then。 */
  async function drain() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  /** drain 微任务 + 重渲染（重渲染才会跑 effect、注册下一次定时器）。 @param {() => void} flush */
  async function settle(flush) {
    await drain();
    flush();
    await drain();
  }

  /**
   * 触发所有到期时间 ≤ target 的定时器（按 at、注册顺序），每次触发后 drain + flush，
   * 让「轮询 → promise → setState → 重渲染 → 下一次 setTimeout」的链条一步步接上。
   * @param {number} target @param {() => void} flush
   */
  async function fireDue(target, flush) {
    for (;;) {
      await settle(flush);
      /** @type {any} */
      let next = null;
      for (const timer of timers.values()) {
        if (timer.at > target) continue;
        if (
          next === null ||
          timer.at < next.at ||
          (timer.at === next.at && timer.sequence < next.sequence)
        ) {
          next = timer;
        }
      }
      if (next === null) return;
      now = Math.max(now, next.at);
      timers.delete(next.id);
      next.run(...next.args);
    }
  }

  return {
    /**
     * 把假时间往前推 ms 毫秒，并跑完期间到期的所有定时器。
     * @param {number} ms @param {() => void} flush
     */
    async advance(ms, flush) {
      const target = now + ms;
      await fireDue(target, flush);
      now = target;
      // flush 里可能又排了 0ms 定时器：再收一遍（client 里没有 0ms，防御性处理）。
      await fireDue(target, flush);
    },
    restore() {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        writable: true,
        value: realSetTimeout,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        writable: true,
        value: realClearTimeout,
      });
      Object.defineProperty(Date, "now", {
        configurable: true,
        writable: true,
        value: realDateNow,
      });
      timers.clear();
    },
  };
}

/**
 * 确定性地等到条件成立：每次推进 step 假毫秒（默认 1ms）并 flush，直到 predicate 为真。
 * 超过 maxMs 假毫秒仍不成立时返回 false，交给调用方的断言报错（不会无限等）。
 * @param {ReturnType<typeof installClock>} clock
 * @param {any} hooks
 * @param {() => boolean} predicate
 * @param {{ step?: number, maxMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
async function waitFor(clock, hooks, predicate, options = {}) {
  const step = options.step ?? 1;
  const maxMs = options.maxMs ?? 200;
  for (let elapsed = 0; ; elapsed += step) {
    if (predicate()) return true;
    if (elapsed >= maxMs) return false;
    await clock.advance(step, hooks.flush);
  }
}

/** 极简浏览器全局（client 半只在样式注入与键帽探测处碰它们）。 */
function installGlobals() {
  /** @type {any} */
  let loaded = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      __ModuleLoader__: {
        /** @param {any} definition */
        load(definition) {
          loaded = definition;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      querySelector() {
        return null;
      },
      createElement() {
        return { dataset: {}, textContent: "", remove() {} };
      },
    },
  });
  return {
    definition: () => loaded,
    restore() {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
    },
  };
}

/** 载入真实 client 源码 → 跑 apply() → 拿到决策卡组件与 __test 出口。 @param {any} hooks */
function bootPlugin(hooks) {
  const browser = installGlobals();
  try {
    new Function(readFileSync(CLIENT, "utf8"))();
    const definition = browser.definition();
    assert.ok(definition !== null, "client.js 没有向 window.__ModuleLoader__ 注册");
    const module = definition.factory((/** @type {string} */ name) => {
      if (name === "react") return hooks.React;
      throw new Error(`未预期的 require：${name}`);
    });
    /** @type {{descriptor: any, Component: any}[]} */
    const slots = [];
    const connection = { rpc: { call: () => Promise.resolve(undefined) } };
    const ctx = {
      /** @param {Function} fn */
      effect(fn) {
        fn();
        return () => {};
      },
      /** @param {string} name */
      get(name) {
        return name === "connection" ? connection : undefined;
      },
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (/** @type {string} */ key) => key;
        },
      },
      slots: {
        /** @param {string} _name @param {Function} callback */
        inject(_name, callback) {
          callback();
          return () => {};
        },
        /** @param {any} descriptor @param {any} Component */
        register(descriptor, Component) {
          slots.push({ descriptor, Component });
          return () => {};
        },
      },
      /** @param {string[]} _names @param {Function} _callback */
      inject(_names, _callback) {
        return () => {};
      },
    };
    module.apply(ctx);
    const card = slots.find((entry) => entry.descriptor.name === "conversation.chat.turnTail");
    assert.ok(card !== undefined, "没有注册 conversation.chat.turnTail");
    return { Component: card.Component, __test: module.__test, restore: browser.restore };
  } catch (error) {
    browser.restore();
    throw error;
  }
}

/**
 * 改短补生成/轮询/超时时序（线上默认 2.5s / 2s / 30–60s）。这里的毫秒是**假时钟**推进的毫秒，
 * 不是真实等待；overrides 给单条用例放宽某个窗口（例如「要证明后台失败、不是客户端超时」的用例）。
 * @param {any} __test
 * @param {Record<string, number>} [overrides]
 */
function shortTimings(__test, overrides = {}) {
  const defaults = { ...__test.timings };
  Object.assign(__test.timings, {
    retryGraceMs: 5,
    pollIntervalMs: 10,
    clientTimeoutMarginMs: 0,
    clientTimeoutFloorMs: 40,
    clientTimeoutCeilMs: 40,
    ...overrides,
  });
  return () => Object.assign(__test.timings, defaults);
}

/** @returns {any} 可注入的假 api：记录调用、按用例替换 generate/generateState 的返回值。 */
function fakeApi() {
  /** @type {{ method: string, args: any[] }[]} */
  const calls = [];
  /** @type {any} */
  const behavior = {
    generate: (/** @type {any} */ _sessionId, /** @type {any} */ _turn) =>
      Promise.resolve({ ok: false, reason: "failed" }),
    generateState: () => Promise.resolve({ ok: true, inflight: false, turn: null, last: null }),
    cancelGenerate: () => Promise.resolve({ ok: true, cancelled: false }),
    settings: () => Promise.resolve({ enabled: true, card: true, timeoutMs: 20000 }),
  };
  const api = {
    keycap: "⌘↵",
    settings: () => behavior.settings(),
    generate: (/** @type {string} */ sessionId, /** @type {number} */ turn) => {
      calls.push({ method: "generate", args: [sessionId, turn] });
      return behavior.generate(sessionId, turn);
    },
    generateState: (/** @type {string} */ sessionId, /** @type {number} */ turn) => {
      calls.push({ method: "generateState", args: [sessionId, turn] });
      return behavior.generateState(sessionId, turn);
    },
    cancelGenerate: (/** @type {string} */ sessionId) => {
      calls.push({ method: "cancelGenerate", args: [sessionId] });
      return behavior.cancelGenerate(sessionId);
    },
  };
  return { api, behavior, calls };
}

/** 组件 props：最后一轮、没有卡（补生成入口的展示条件）。 @param {any} api @param {number} [turnNumber] */
function propsOf(api, turnNumber = TURN) {
  const inputState = { draft: "", attachmentIds: [], occurrences: [], phase: "plain", claim: null };
  return {
    api,
    t: (/** @type {string} */ key) => key,
    turn: {
      turn: turnNumber,
      end: { seq: 10 },
      data: {
        /** @param {string} key */
        get(key) {
          return key === "turn-tail" ? { closing: { finalNode: { seq: 10 } } } : undefined;
        },
      },
    },
    sessionId: SESSION,
    useProjection: () => ({ cards: {}, decisions: {}, reveals: {} }),
    /** @param {Function} selector */
    useChat: (selector) => selector({ timeline: { turnOrder: [turnNumber] } }),
    /** @param {Function} selector */
    useInput: (selector) => selector(inputState),
    /** @param {Function} selector */
    useSession: (selector) => selector({ running: false, removed: false, subagent: false }),
    inputActions: undefined,
  };
}

/**
 * 深度优先找第一个满足条件的元素。
 * @param {any} element @param {(element: any) => boolean} predicate
 * @returns {any}
 */
function findElement(element, predicate) {
  if (element === null || element === undefined) return undefined;
  if (Array.isArray(element)) {
    for (const child of element) {
      const found = findElement(child, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof element !== "object") return undefined;
  if (predicate(element)) return element;
  const children = element.props?.children;
  return findElement(Array.isArray(children) ? children : [children], predicate);
}

/** 元素树里的纯文本。 @param {any} element @returns {string} */
function textOf(element) {
  if (element === null || element === undefined) return "";
  if (typeof element === "string") return element;
  if (typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join("");
  if (typeof element !== "object") return "";
  const children = element.props?.children;
  return textOf(Array.isArray(children) ? children : [children]);
}

/** 取补生成 section（没有则 undefined）。 @param {any} tree */
const retrySectionOf = (tree) =>
  findElement(tree, (node) => node.props?.["data-next-step-retry"] !== undefined);

/** 补生成 section 当前的 phase（还没渲染出来时是 undefined）。 @param {any} fiber */
const retryPhaseOf = (fiber) =>
  retrySectionOf(fiber.element)?.props?.["data-next-step-retry-phase"];

/**
 * 等到补生成 section 进入指定 phase（假时钟推进，最多等 maxMs 假毫秒）。
 * @param {ReturnType<typeof installClock>} clock
 * @param {any} hooks
 * @param {any} fiber
 * @param {string} phase
 * @param {number} [maxMs]
 */
async function waitPhase(clock, hooks, fiber, phase, maxMs = 200) {
  await waitFor(clock, hooks, () => retryPhaseOf(fiber) === phase, { maxMs });
  assert.equal(retryPhaseOf(fiber), phase, `补生成的状态应该到「${phase}」`);
}

/**
 * 挂载组件并等到 grace 放行（补生成入口出现）。时间由假时钟推进，不依赖真实 sleep。
 * @param {ReturnType<typeof installClock>} clock @param {any} hooks @param {any} plugin @param {any} api
 */
async function mountRetry(clock, hooks, plugin, api) {
  const fiber = hooks.mount(plugin.Component, propsOf(api));
  await waitFor(clock, hooks, () => retrySectionOf(fiber.element) !== undefined);
  assert.ok(retrySectionOf(fiber.element) !== undefined, "grace 过后应该出现补生成入口");
  return fiber;
}

test("手动生成失败：loading 结束 + 一行原因 + 详情可展开 + 按钮变「重试」", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  const restoreTimings = shortTimings(plugin.__test);
  const { api, behavior, calls } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    let pending = /** @type {any} */ (null);
    behavior.generate = () =>
      new Promise((resolve) => {
        pending = resolve;
      });
    fiber = await mountRetry(clock, hooks, plugin, api);
    let section = retrySectionOf(fiber.element);
    assert.ok(section !== undefined, "没有卡时应该出现补生成入口");
    assert.equal(section.props["data-next-step-retry-phase"], "idle");
    assert.equal(
      textOf(findElement(section, (n) => n.props?.["data-next-step-generate"] !== undefined)),
      "retry.generate",
    );

    const button = () =>
      findElement(fiber.element, (n) => n.props?.["data-next-step-generate"] !== undefined);
    button().props.onClick();
    await clock.advance(0, hooks.flush);
    section = retrySectionOf(fiber.element);
    assert.equal(section.props["data-next-step-retry-phase"], "loading", "点击后进入 loading");
    assert.equal(button().props.disabled, true, "loading 时按钮不可再点");
    assert.equal(textOf(button()), "retry.generating", "loading 文案");

    pending({
      ok: false,
      reason: "schema",
      detail: "model output did not match the card schema (json:empty)",
    });
    await waitPhase(clock, hooks, fiber, "error");
    section = retrySectionOf(fiber.element);
    assert.equal(section.props["data-next-step-retry-phase"], "error", "失败后 loading 必须结束");
    assert.equal(button().props.disabled, false, "失败后按钮可重试");
    assert.equal(textOf(button()), "retry.retry", "按钮变「重试」");
    const alert = findElement(
      fiber.element,
      (n) => n.props?.["data-next-step-retry-error"] !== undefined,
    );
    assert.ok(alert !== undefined, "失败必须有一行可见原因（不能只写诊断日志）");
    assert.equal(
      textOf(findElement(alert, (n) => n.props?.["data-next-step-retry-reason"] !== undefined)),
      "error.schema",
    );
    const toggle = findElement(
      alert,
      (n) => n.props?.["data-next-step-retry-detail-toggle"] !== undefined,
    );
    assert.ok(toggle !== undefined, "有 detail 时应该出现「查看详情」");
    assert.equal(
      findElement(alert, (n) => n.props?.["data-next-step-retry-detail"] !== undefined),
      undefined,
      "详情默认收起",
    );
    toggle.props.onClick();
    await clock.advance(0, hooks.flush);
    const detail = findElement(
      fiber.element,
      (n) => n.props?.["data-next-step-retry-detail"] !== undefined,
    );
    assert.ok(detail !== undefined, "点「查看详情」后展开技术原因");
    assert.match(textOf(detail), /json:empty/u);

    // 重试走同一个按钮：再点一次会真的再发起一次生成（不会卡死在 in-flight 态）。
    button().props.onClick();
    assert.equal(calls.filter((/** @type {any} */ call) => call.method === "generate").length, 2);
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("自动生成失败（刷新后也一样）：状态查询直接显示「重试 + 原因」，不再静默恢复原状", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  const restoreTimings = shortTimings(plugin.__test);
  const { api, behavior, calls } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    behavior.generateState = () =>
      Promise.resolve({
        ok: true,
        inflight: false,
        turn: null,
        last: { turn: TURN, ok: false, reason: "schema", detail: "json:empty", at: 1 },
      });
    fiber = await mountRetry(clock, hooks, plugin, api);
    await waitPhase(clock, hooks, fiber, "error");
    const section = retrySectionOf(fiber.element);
    assert.equal(section.props["data-next-step-retry-phase"], "error");
    assert.equal(
      textOf(findElement(section, (n) => n.props?.["data-next-step-generate"] !== undefined)),
      "retry.retry",
      "自动生成失败后按钮就是「重试」，不是静默的「生成下一步建议」",
    );
    const alert = findElement(
      fiber.element,
      (n) => n.props?.["data-next-step-retry-error"] !== undefined,
    );
    assert.equal(
      textOf(findElement(alert, (n) => n.props?.["data-next-step-retry-reason"] !== undefined)),
      "error.schema",
    );
    assert.equal(
      calls.filter((/** @type {any} */ call) => call.method === "generate").length,
      0,
      "只查询状态，不重复调模型",
    );
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("RPC 挂起：客户端超时结束 loading、先取消服务端在途生成、显示「生成超时，可重试」", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  const restoreTimings = shortTimings(plugin.__test);
  const { api, behavior, calls } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    behavior.generate = () => new Promise(() => {}); // 永不 settle：模拟 RPC 挂起
    fiber = await mountRetry(clock, hooks, plugin, api);
    const button = () =>
      findElement(fiber.element, (n) => n.props?.["data-next-step-generate"] !== undefined);
    button().props.onClick();
    await clock.advance(0, hooks.flush);
    assert.equal(retrySectionOf(fiber.element).props["data-next-step-retry-phase"], "loading");

    // 假时钟推进到客户端超时（timings 已缩短到 40ms）：loading 必须结束，且**先取消服务端生成**。
    await waitPhase(clock, hooks, fiber, "error");
    const section = retrySectionOf(fiber.element);
    assert.equal(section.props["data-next-step-retry-phase"], "error", "超时后不能继续 loading");
    assert.equal(button().props.disabled, false, "超时后按钮可重试");
    assert.equal(textOf(button()), "retry.retry");
    const alert = findElement(
      fiber.element,
      (n) => n.props?.["data-next-step-retry-error"] !== undefined,
    );
    assert.equal(textOf(alert), "error.timeout", "超时文案");
    assert.equal(
      calls.filter((/** @type {any} */ call) => call.method === "cancelGenerate").length,
      1,
      "UI 结束 loading 前必须真的取消服务端在途生成（不能后台还在跑）",
    );

    // 超时后重试同样走这个按钮。
    button().props.onClick();
    assert.equal(calls.filter((/** @type {any} */ call) => call.method === "generate").length, 2);
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("挂载时仍有一笔在途生成：直接进入等待态，后台失败后转为可重试错误", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  // 这条与下一条要证明「后台失败 → error.schema」而不是客户端超时：把客户端超时窗口放大到 5s
  // （假时钟只推进 ~25ms）。双保险：即使进程真的被并行负载挂起几百毫秒，也不会误判成 error.timeout。
  const restoreTimings = shortTimings(plugin.__test, {
    clientTimeoutFloorMs: 5000,
    clientTimeoutCeilMs: 5000,
  });
  const { api, behavior, calls } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    let probes = 0;
    behavior.generateState = () => {
      probes += 1;
      // 第一次（挂载时状态查询）报在途；第一次轮询仍在途；第二次轮询后台已失败。
      if (probes <= 2) return Promise.resolve({ ok: true, inflight: true, turn: TURN, last: null });
      return Promise.resolve({
        ok: true,
        inflight: false,
        turn: null,
        last: { turn: TURN, ok: false, reason: "schema", detail: "json:empty", at: 1 },
      });
    };
    fiber = await mountRetry(clock, hooks, plugin, api);
    await waitPhase(clock, hooks, fiber, "waiting");
    const section = () => retrySectionOf(fiber.element);
    assert.equal(section().props["data-next-step-retry-phase"], "waiting");
    assert.ok(
      findElement(fiber.element, (n) => n.props?.["data-next-step-retry-waiting"] !== undefined),
      "等待态要有「后台正在生成」提示",
    );
    const button = () =>
      findElement(fiber.element, (n) => n.props?.["data-next-step-generate"] !== undefined);
    assert.equal(button().props.disabled, true, "等待态按钮禁用（避免再撞一次 inflight）");

    await waitPhase(clock, hooks, fiber, "error");
    assert.equal(
      section().props["data-next-step-retry-phase"],
      "error",
      "后台失败后必须转成可重试错误",
    );
    assert.equal(textOf(button()), "retry.retry");
    const alert = findElement(
      fiber.element,
      (n) => n.props?.["data-next-step-retry-error"] !== undefined,
    );
    assert.equal(
      textOf(findElement(alert, (n) => n.props?.["data-next-step-retry-reason"] !== undefined)),
      "error.schema",
    );
    assert.ok(
      calls.filter((/** @type {any} */ call) => call.method === "generateState").length >= 3,
      "等待态要靠 generateState 轮询后台状态（不能把 inflight 回执当终态）",
    );
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("手动点生成遇到 inflight：不显示永久「正在生成」，转等待态并在后台失败后给原因", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  // 同「挂载时在途」：把客户端超时窗口放大到 5s，保证终态来自后台失败（error.schema）而非超时。
  const restoreTimings = shortTimings(plugin.__test, {
    clientTimeoutFloorMs: 5000,
    clientTimeoutCeilMs: 5000,
  });
  const { api, behavior } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    let probes = 0;
    behavior.generate = () =>
      Promise.resolve({ ok: false, reason: "inflight", detail: "still running" });
    behavior.generateState = () => {
      probes += 1;
      // 挂载时没有在途（否则按钮会被等待态占住，点不到）；点击返回 inflight 之后才开始轮询。
      if (probes === 1)
        return Promise.resolve({ ok: true, inflight: false, turn: null, last: null });
      if (probes === 2)
        return Promise.resolve({ ok: true, inflight: true, turn: TURN, last: null });
      return Promise.resolve({
        ok: true,
        inflight: false,
        turn: null,
        last: { turn: TURN, ok: false, reason: "schema", detail: "json:empty", at: 1 },
      });
    };
    fiber = await mountRetry(clock, hooks, plugin, api);
    const section = () => retrySectionOf(fiber.element);
    assert.equal(section().props["data-next-step-retry-phase"], "idle");
    const button = () =>
      findElement(fiber.element, (n) => n.props?.["data-next-step-generate"] !== undefined);
    button().props.onClick();
    await clock.advance(0, hooks.flush);
    // RPC 回执是 inflight：不能停在一句「正在生成，请稍候」，也不能当失败 —— 进入等待态。
    assert.equal(section().props["data-next-step-retry-phase"], "waiting");
    assert.equal(button().props.disabled, true);
    await waitPhase(clock, hooks, fiber, "error");
    assert.equal(section().props["data-next-step-retry-phase"], "error");
    assert.equal(textOf(button()), "retry.retry");
    const alert = findElement(
      fiber.element,
      (n) => n.props?.["data-next-step-retry-error"] !== undefined,
    );
    assert.equal(
      textOf(findElement(alert, (n) => n.props?.["data-next-step-retry-reason"] !== undefined)),
      "error.schema",
    );
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("旧宿主 / 状态查询不可用：不阻塞首生成按钮（静默降级）", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  const restoreTimings = shortTimings(plugin.__test);
  const { api } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    delete (/** @type {any} */ (api).generateState);
    fiber = await mountRetry(clock, hooks, plugin, api);
    const section = retrySectionOf(fiber.element);
    assert.equal(section.props["data-next-step-retry-phase"], "idle");
    assert.equal(
      textOf(findElement(section, (n) => n.props?.["data-next-step-generate"] !== undefined)),
      "retry.generate",
    );
    assert.equal(
      findElement(fiber.element, (n) => n.props?.["data-next-step-retry-error"] !== undefined),
      undefined,
      "没有状态信息就不该编造失败",
    );
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("换轮次后上一轮的失败状态不会串到新一轮（组件实例可能被复用）", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  const restoreTimings = shortTimings(plugin.__test);
  const { api, behavior } = fakeApi();
  /** @type {any} */
  let fiber = null;
  try {
    behavior.generateState = () =>
      Promise.resolve({
        ok: true,
        inflight: false,
        turn: null,
        last: { turn: TURN, ok: false, reason: "schema", detail: "json:empty", at: 1 },
      });
    fiber = await mountRetry(clock, hooks, plugin, api);
    await waitPhase(clock, hooks, fiber, "error");
    const section = () => retrySectionOf(fiber.element);
    assert.equal(section().props["data-next-step-retry-phase"], "error");
    // 新一轮开始：状态查询对新回合没有失败记录 / 没有在途生成 → 必须回到 idle，不能带着上一轮的原因。
    behavior.generateState = () =>
      Promise.resolve({ ok: true, inflight: false, turn: null, last: null });
    hooks.update(fiber, propsOf(api, TURN + 1));
    await waitPhase(clock, hooks, fiber, "idle");
    assert.equal(section().props["data-next-step-retry-phase"], "idle");
    assert.equal(
      findElement(fiber.element, (n) => n.props?.["data-next-step-retry-error"] !== undefined),
      undefined,
      "上一轮的失败文案不能串到新一轮",
    );
  } finally {
    if (fiber !== null) hooks.unmount(fiber);
    restoreTimings();
    plugin.restore();
    clock.restore();
  }
});

test("纯逻辑出口：失败原因 → 摘要 key 映射与 detail 截断（供 locale parity 外的单元断言）", () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const { retryFailureOf, RETRY_DETAIL_CHARS, retryTimeoutOf } = plugin.__test;
    assert.deepEqual(retryFailureOf({ reason: "schema", detail: "x" }), {
      key: "error.schema",
      detail: "x",
    });
    assert.equal(retryFailureOf({ reason: "timeout" }).key, "error.timeout");
    assert.equal(retryFailureOf({ reason: "cancelled" }).key, "error.cancelled");
    assert.equal(retryFailureOf({ reason: "failed" }).key, "error.llm");
    assert.equal(retryFailureOf({}).key, "error.llm", "缺 reason 兜底成 failed → llm");
    assert.equal(retryFailureOf({ reason: "weird" }).key, "error.failed", "未知 reason 兜底");
    const long = "d".repeat(RETRY_DETAIL_CHARS + 20);
    const clipped = retryFailureOf({ reason: "schema", detail: long }).detail;
    assert.ok(clipped.length <= RETRY_DETAIL_CHARS);
    // 客户端超时 = clamp(服务端 timeout + margin, 30s, 60s)（线上默认服务端 20s → 30s）。
    assert.equal(retryTimeoutOf({ timeoutMs: 20000 }), 30000);
    assert.equal(retryTimeoutOf({ timeoutMs: 50000 }), 55000);
    assert.equal(retryTimeoutOf({ timeoutMs: 120000 }), 60000, "服务端超时再长，UI 最多等 60s");
    assert.equal(retryTimeoutOf(null), 30000, "设置还没读到时也不无限等");
  } finally {
    plugin.restore();
  }
});

test("生产 api 表面包含 generateState / cancelGenerate（复审 B1：新 Remote 必须真正接线）", () => {
  const hooks = createHooks();
  const { __test, restore } = bootPlugin(hooks);
  try {
    assert.ok(
      __test.apiSurface().includes("generateState"),
      `生产 api 缺少 generateState：${__test.apiSurface().join(",")}`,
    );
    assert.ok(
      __test.apiSurface().includes("cancelGenerate"),
      `生产 api 缺少 cancelGenerate：${__test.apiSurface().join(",")}`,
    );
  } finally {
    restore();
  }
});
