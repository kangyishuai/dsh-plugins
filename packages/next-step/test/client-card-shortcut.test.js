// @ts-check
// 卡片 ⌘/Ctrl+Enter 快捷键的回归测试（client 半）。
//
// 背景：卡片数据是**投影晚到**的——回合尾部先挂载、`status` 先变成 interactive，卡片随后才
// 从投影里进来。登记到键盘桥的 effect 如果只在 [sessionId, status] 变化时重跑，晚到的卡片就
// 永远登记不上：卡片看起来可点，⌘↵ 却静默失效（点击正常）。这条测试把那个时序钉住。
//
// 这里不引入 DOM/React 依赖：用一个够用的迷你 hooks 运行时（useState/useRef/useEffect/
// useLayoutEffect/useCallback）驱动真实组件源码，只观察「键盘观察者是否接管手势」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const SESSION = "session-1";
const TURN = 1;

/**
 * 迷你 hooks 运行时：一个组件实例（fiber）+ 重渲染 + 依赖比较。
 * @returns {any}
 */
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
    fiber.Component(fiber.props);
    const effects = queued;
    queued = [];
    for (const run of effects) run();
  }

  /** 跑到没有新的状态更新为止（不递归、不重入）。 */
  function flush() {
    let guard = 0;
    while (dirty.size > 0 && guard < 100) {
      guard += 1;
      const list = [...dirty];
      dirty.clear();
      for (const fiber of list) {
        if (fiber.mounted) render(fiber);
      }
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
    if (previous !== undefined && previous.kind === "effect" && sameDeps(previous.deps, deps))
      return;
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
      if (hook.kind !== "state") throw new Error("hook order changed");
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
        fiber.hooks[slot] = {
          kind: "callback",
          deps: deps === undefined ? undefined : [...deps],
          fn,
        };
      }
      return fiber.hooks[slot].fn;
    },
  };

  /**
   * @param {Function} Component
   * @param {any} props
   */
  function mount(Component, props) {
    const fiber = { Component, props, hooks: [], mounted: true };
    render(fiber);
    flush();
    return fiber;
  }

  /**
   * @param {any} fiber
   * @param {any} props
   */
  function update(fiber, props) {
    fiber.props = props;
    render(fiber);
    flush();
  }

  /** @param {any} fiber */
  function unmount(fiber) {
    fiber.mounted = false;
    for (const hook of fiber.hooks) {
      if (hook && hook.kind === "effect" && typeof hook.cleanup === "function") hook.cleanup();
    }
  }

  return { React, mount, update, flush, unmount };
}

/** 极简浏览器全局：client 半只在两处碰它们（样式注入、键帽探测）。 */
function installBrowserGlobals() {
  let loaded = /** @type {any} */ (null);
  const documentStub = {
    documentElement: { dataset: {} },
    head: { appendChild() {} },
    querySelector() {
      return null;
    },
    createElement() {
      return { dataset: {}, textContent: "", remove() {} };
    },
  };
  const windowStub = {
    __ModuleLoader__: {
      /** @param {any} definition */
      load(definition) {
        loaded = definition;
      },
    },
    getComputedStyle() {
      return null;
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: windowStub,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: documentStub,
    configurable: true,
    writable: true,
  });
  return {
    definition() {
      return loaded;
    },
    restore() {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
    },
  };
}

/**
 * 载入真实 client 源码 → 跑 apply() → 拿到决策卡组件与键盘观察者。
 * @param {any} hooks
 */
function bootPlugin(hooks) {
  const browser = installBrowserGlobals();
  try {
    new Function(readFileSync(CLIENT, "utf8"))();
  } catch (error) {
    browser.restore();
    throw error;
  }
  const definition = browser.definition();
  assert.ok(definition !== null, "client.js 没有向 window.__ModuleLoader__ 注册");
  assert.equal(definition.id, "@kangyishuai/dsh-next-step");
  const module = definition.factory((/** @type {string} */ name) => {
    if (name === "react") return hooks.React;
    throw new Error(`未预期的 require：${name}`);
  });

  /** @type {{path: string, method: string, payload: any}[]} */
  const calls = [];
  /** @type {((input: any) => void)[]} */
  const fixedListeners = [];
  /** @type {{descriptor: any, Component: any}[]} */
  const slots = [];
  const connection = {
    rpc: {
      /**
       * @param {string} path
       * @param {string} method
       * @param {any} payload
       */
      call(path, method, payload) {
        calls.push({ path, method, payload });
        if (method === "nextStep/act") return Promise.resolve({ value: { ok: true, text: "" } });
        return Promise.resolve(undefined);
      },
    },
  };

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
      /**
       * @param {string} _name
       * @param {Function} cb
       */
      inject(_name, cb) {
        cb();
        return () => {};
      },
      /**
       * @param {any} descriptor
       * @param {any} Component
       */
      register(descriptor, Component) {
        slots.push({ descriptor, Component });
        return () => {};
      },
    },
    /**
     * @param {string[]} names
     * @param {(scope: any) => void} cb
     */
    inject(names, cb) {
      if (names.includes("shortcuts")) {
        cb({
          shortcuts: {
            /** @param {(input: any) => void} listener */
            observeFixedInput(listener) {
              fixedListeners.push(listener);
              return () => {};
            },
          },
          /** @param {Function} fn */
          effect(fn) {
            fn();
            return () => {};
          },
        });
      }
      return () => {};
    },
  };

  module.apply(ctx);
  const card = slots.find((entry) => entry.descriptor.name === "conversation.chat.turnTail");
  assert.ok(card !== undefined, "没有注册 conversation.chat.turnTail");
  assert.equal(card.descriptor.id, "next-step");
  assert.equal(fixedListeners.length, 1, "键盘观察者应当登记且只登记一次");
  return {
    card: card.Component,
    api: card.descriptor.inject().api,
    press: fixedListeners[0],
    calls,
    restore: browser.restore,
  };
}

/** 一张「可交互」的卡。 */
const CARD = {
  shown: true,
  summary: "改成百分比写法",
  question: "要继续吗？",
  options: [
    { label: "改成 %5", stance: "primary" },
    { label: "写 v1.3", stance: "secondary" },
  ],
  nextPrompt: "继续",
};

/** @param {any} overrides */
const view = (overrides = {}) => ({ cards: {}, decisions: {}, reveals: {}, ...overrides });

/**
 * @param {any} plugin
 * @param {any} projection
 * @param {any} [input]
 */
function propsOf(plugin, projection, input = {}) {
  const inputState = {
    draft: "",
    attachmentIds: [],
    occurrences: [],
    phase: "plain",
    claim: null,
    ...input,
  };
  return {
    api: plugin.api,
    t: (/** @type {string} */ key) => key,
    turn: {
      turn: TURN,
      end: { seq: 10 },
      data: {
        /** @param {string} key */
        get(key) {
          return key === "turn-tail" ? { closing: { finalNode: { seq: 10 } } } : undefined;
        },
      },
    },
    sessionId: SESSION,
    useProjection: () => projection,
    /** @param {Function} selector */
    useChat: (selector) => selector({ timeline: { turnOrder: [TURN] } }),
    /** @param {Function} selector */
    useInput: (selector) => selector(inputState),
    /** @param {Function} selector */
    useSession: (selector) => selector({ running: false, removed: false, subagent: false }),
    inputActions: undefined,
  };
}

/**
 * 按 ⌘↵（焦点在输入框里）。
 * @param {any} plugin
 * @returns {{consumed: boolean}}
 */
function pressPrimaryEnter(plugin) {
  const state = { consumed: false };
  const occurrence = {
    getAttribute: (/** @type {string} */ name) =>
      name === "data-conversation-session" ? SESSION : null,
  };
  plugin.press({
    type: "keydown",
    gesture: {
      code: "Enter",
      meta: true,
      control: false,
      alt: false,
      shift: false,
      repeat: false,
      composing: false,
      defaultPrevented: false,
    },
    context: {
      modal: null,
      region: "editable",
      target: {
        /** @param {string} selector */
        closest(selector) {
          return selector === "[data-conversation-session]" ? occurrence : null;
        },
      },
    },
    consume() {
      state.consumed = true;
    },
  });
  return state;
}

/** @param {any} plugin */
const actCalls = (plugin) =>
  plugin.calls.filter((/** @type {any} */ call) => call.method === "nextStep/act");

test("卡片晚到（先 interactive、后到投影）时 ⌘↵ 仍能接管", async () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    // 第一帧：回合刚结束，status 已是 interactive，但卡片还没从投影进来。
    const fiber = hooks.mount(plugin.card, propsOf(plugin, view()));
    assert.equal(actCalls(plugin).length, 0);
    assert.equal(pressPrimaryEnter(plugin).consumed, false, "没有卡片时不能吞掉手势");

    // 第二帧：卡片数据到了（同一个组件实例，只有投影变了）。
    hooks.update(fiber, propsOf(plugin, view({ cards: { [String(TURN)]: CARD } })));

    const press = pressPrimaryEnter(plugin);
    assert.equal(press.consumed, true, "卡片可交互时 ⌘↵ 应当被接管");
    const calls = actCalls(plugin);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload, {
      args: { request: { sessionId: SESSION, turn: TURN, index: 0 } },
    });
    hooks.flush();
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});

test("只有一粒胶囊的卡片同样接管（与胶囊数量无关）", async () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    // 真机复现过「一粒能用、两粒失效」的错觉：实际是卡片到达时机不同，不是胶囊数量。
    const single = { ...CARD, options: [CARD.options[0]] };
    const fiber = hooks.mount(plugin.card, propsOf(plugin, view()));
    hooks.update(fiber, propsOf(plugin, view({ cards: { [String(TURN)]: single } })));

    assert.equal(pressPrimaryEnter(plugin).consumed, true);
    assert.equal(actCalls(plugin).length, 1);
    assert.deepEqual(actCalls(plugin)[0].payload.args.request.index, 0);
    hooks.flush();
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});

test("输入框有草稿时 ⌘↵ 透传（不抢宿主的 Queue/Steer）", async () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const projection = view({ cards: { [String(TURN)]: CARD } });
    const fiber = hooks.mount(plugin.card, propsOf(plugin, projection, { draft: "我自己在写" }));
    const press = pressPrimaryEnter(plugin);
    assert.equal(press.consumed, false);
    assert.equal(actCalls(plugin).length, 0);
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});

test("被抑制的候选揭示后才接管 ⌘↵", async () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const hidden = { ...CARD, shown: false };
    const fiber = hooks.mount(
      plugin.card,
      propsOf(plugin, view({ cards: { [String(TURN)]: hidden } })),
    );
    assert.equal(pressPrimaryEnter(plugin).consumed, false, "候选没揭示时不能接管");

    hooks.update(
      fiber,
      propsOf(
        plugin,
        view({ cards: { [String(TURN)]: hidden }, reveals: { [String(TURN)]: true } }),
      ),
    );
    assert.equal(pressPrimaryEnter(plugin).consumed, true);
    assert.equal(actCalls(plugin).length, 1);
    hooks.flush();
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});

test("已决策的卡不再接管 ⌘↵", async () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const projection = view({
      cards: { [String(TURN)]: CARD },
      decisions: { [String(TURN)]: { index: 0, phase: "sent" } },
    });
    const fiber = hooks.mount(plugin.card, propsOf(plugin, projection));
    assert.equal(pressPrimaryEnter(plugin).consumed, false);
    assert.equal(actCalls(plugin).length, 0);
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});
