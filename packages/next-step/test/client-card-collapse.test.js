// @ts-check
// 旧卡折叠的渲染回归（AUD-NS-02，client 半）。
//
// 背景：真实 14 天数据里 401 张 shown 卡有 329 张（82%）没有任何决策，而 ✕ 只在「最新一轮且未决策」
// 时渲染——旧卡永久留在对话流里，单会话最多 80 张。现在**更早轮次、未决策的卡默认折叠成一行**
// （「更早的一轮 · 摘要首句」），完整摘要留在会话日志与 title 里。
//
// 这里不引入 DOM/React：用迷你 hooks 运行时驱动**真实 client 源码**，断言组件返回的元素树
// （桌面只读回归 `scripts/smoke-next-step-desktop.mjs` 负责真机 DOM 那一层）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const SESSION = "session-1";
const TURN = 3;

/** 迷你 hooks 运行时：一个组件实例 + 重渲染，并保留最近一次渲染的元素树。 @returns {any} */
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
    if (previous !== undefined && previous.kind === "effect" && sameDeps(previous.deps, deps))
      return;
    queued.push(() => {
      if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
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
    /**
     * @param {Function} Component
     * @param {any} props
     */
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
  };
}

/** 极简浏览器全局：client 半只在两处碰它们（样式注入、键帽探测）。 */
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

/** 载入真实 client 源码 → 跑 apply() → 拿到决策卡组件。 @param {any} hooks */
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
        /**
         * @param {string} _name
         * @param {Function} callback
         */
        inject(_name, callback) {
          callback();
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
      /** @param {string[]} _names @param {Function} _callback */
      inject(_names, _callback) {
        return () => {};
      },
    };
    module.apply(ctx);
    const card = slots.find((entry) => entry.descriptor.name === "conversation.chat.turnTail");
    assert.ok(card !== undefined, "没有注册 conversation.chat.turnTail");
    return { Component: card.Component, restore: browser.restore };
  } catch (error) {
    browser.restore();
    throw error;
  }
}

/** 一张「出过」的卡（摘要故意是两句：折叠行只留首句）。 */
const CARD = {
  shown: true,
  summary: "测试通过 42 项。下一步可以发布 v0.5.0。",
  question: "要继续吗？",
  options: [
    { label: "改成 %5", stance: "primary" },
    { label: "写 v1.3", stance: "secondary" },
  ],
};

/**
 * @param {{ cards?: any, decisions?: any, reveals?: any }} projection
 * @param {{ turnOrder?: number[] }} [timeline]
 */
function propsOf(projection, timeline = { turnOrder: [TURN] }) {
  const inputState = {
    draft: "",
    attachmentIds: [],
    occurrences: [],
    phase: "plain",
    claim: null,
  };
  return {
    api: undefined,
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
    useProjection: () => ({ cards: {}, decisions: {}, reveals: {}, ...projection }),
    /** @param {Function} selector */
    useChat: (selector) => selector({ timeline }),
    /** @param {Function} selector */
    useInput: (selector) => selector(inputState),
    /** @param {Function} selector */
    useSession: (selector) => selector({ running: false, removed: false, subagent: false }),
    inputActions: undefined,
  };
}

/**
 * 在元素树里深度优先找第一个满足条件的节点。
 * @param {any} element
 * @param {(element: any) => boolean} predicate
 * @returns {any}
 */
function findElement(element, predicate) {
  if (element === null || element === undefined) return undefined;
  // React 的 children 里会嵌套数组（`map` / 条件表达式），要一起展开。
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

/**
 * 收集元素树里所有满足条件的节点（数组 children 会递归展开）。
 * @param {any} element
 * @param {(element: any) => boolean} predicate
 * @returns {any[]}
 */
function collectElements(element, predicate) {
  /** @type {any[]} */
  const found = [];
  if (element === null || element === undefined) return found;
  if (Array.isArray(element)) {
    for (const child of element) found.push(...collectElements(child, predicate));
    return found;
  }
  if (typeof element !== "object") return found;
  if (predicate(element)) found.push(element);
  const children = element.props?.children;
  found.push(...collectElements(Array.isArray(children) ? children : [children], predicate));
  return found;
}

/**
 * 元素树里的纯文本（组件里嵌套的字符串与数字）。
 * @param {any} element
 * @returns {string}
 */
function textOf(element) {
  if (element === null || element === undefined) return "";
  if (typeof element === "string") return element;
  if (typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join("");
  if (typeof element !== "object") return "";
  const children = element.props?.children;
  return textOf(Array.isArray(children) ? children : [children]);
}

test("更早轮次的卡默认折叠成一行：只有摘要首句，没有提问 / 胶囊 / ✕（AUD-NS-02）", () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const fiber = hooks.mount(
      plugin.Component,
      propsOf(
        { cards: { [String(TURN)]: CARD } },
        // 已经不是最后一轮 → 只读态
        { turnOrder: [TURN, TURN + 1] },
      ),
    );
    const tree = fiber.element;
    assert.equal(tree.type, "section");
    assert.equal(tree.props["data-next-step-card"], "", "卡片锚点还在（统计与冒烟都靠它）");
    assert.equal(tree.props["data-next-step-state"], "readonly");
    assert.equal(tree.props["data-next-step-collapsed"], "true", "旧卡必须标记成折叠态");
    assert.equal(tree.props.title, CARD.summary, "完整摘要在 title 里可看");

    const folded = findElement(
      tree,
      (node) => node.props?.["data-next-step-summary"] !== undefined,
    );
    assert.ok(folded !== undefined, "折叠行要保留 data-next-step-summary 锚点（冒烟按它取文本）");
    const foldedText = textOf(folded);
    assert.equal(foldedText, "测试通过 42 项。", "折叠行只显示摘要首句（第二句不进折叠行）");
    const tag = findElement(tree, (node) => node.props?.["data-next-step-expired"] !== undefined);
    assert.equal(textOf(tag), "card.expired", "折叠行带「更早的一轮」标签");
    assert.equal(
      findElement(tree, (node) => node.props?.["data-next-step-question"] !== undefined),
      undefined,
      "折叠态不再渲染提问（旧卡是噪音来源）",
    );
    assert.equal(
      findElement(tree, (node) => node.props?.["data-next-step-pill"] !== undefined),
      undefined,
      "折叠态没有胶囊",
    );
    assert.equal(
      findElement(tree, (node) => node.props?.["data-next-step-dismiss"] !== undefined),
      undefined,
      "折叠态没有 ✕（只读不写会话日志）",
    );
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});

test("最后一轮的可交互卡不受影响：摘要 + 提问 + 胶囊 + ✕ 都在", () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const fiber = hooks.mount(
      plugin.Component,
      propsOf({ cards: { [String(TURN)]: CARD } }, { turnOrder: [TURN] }),
    );
    const tree = fiber.element;
    assert.equal(tree.props["data-next-step-state"], "interactive");
    assert.equal(
      tree.props["data-next-step-collapsed"],
      undefined,
      "可交互卡不是折叠态（折叠是旧卡的默认形态）",
    );
    const summary = findElement(
      tree,
      (node) => node.props?.["data-next-step-summary"] !== undefined,
    );
    assert.match(
      textOf(summary),
      /测试通过 42 项。下一步可以发布 v0\.5\.0。/u,
      "可交互卡保留整段摘要",
    );
    assert.ok(
      findElement(tree, (node) => node.props?.["data-next-step-question"] !== undefined) !==
        undefined,
      "可交互卡有提问",
    );
    const pills = collectElements(
      tree,
      (node) => node.props?.["data-next-step-pill"] !== undefined,
    );
    assert.equal(pills.length, 2, "可交互卡保留 2 粒胶囊");
    assert.ok(
      findElement(tree, (node) => node.props?.["data-next-step-dismiss"] !== undefined) !==
        undefined,
      "可交互卡有 ✕",
    );
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});

test("已决策（sent）的卡不折叠：仍保留「已发出」回显", () => {
  const hooks = createHooks();
  const plugin = bootPlugin(hooks);
  try {
    const fiber = hooks.mount(
      plugin.Component,
      propsOf(
        {
          cards: { [String(TURN)]: CARD },
          decisions: { [String(TURN)]: { turn: TURN, phase: "sent", index: 0 } },
        },
        { turnOrder: [TURN, TURN + 1] },
      ),
    );
    const tree = fiber.element;
    assert.equal(tree.props["data-next-step-state"], "sent");
    assert.equal(tree.props["data-next-step-collapsed"], undefined);
    const sent = findElement(tree, (node) => node.props?.["data-next-step-sent"] !== undefined);
    assert.equal(sent?.props?.["data-next-step-sent-label"], "改成 %5", "已发出的那一粒要回显");
    hooks.unmount(fiber);
  } finally {
    plugin.restore();
  }
});
