// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，且「已保存 / 保存失败」要看得见。
//
// session-delete 的形态是**自动保存**（勾选「同时删除子会话」立刻写 prefs）：本文件用迷你 hooks
// 运行时驱动真实 `apply()` 注册的 SettingsSection，断言
// `data-session-delete-settings-status` 的 clean → saved → clean 与 error → retry 两条路径。
// 失败注入方式：`setPrefs` RPC reject（宿主写盘失败/连不上）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时（含 useSyncExternalStore / useMemo）。 */
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

  /**
   * 无 hooks 的纯渲染子组件就地展开（便于断言），深度上限兜底。
   * @param {any} element @param {number} [depth] @returns {any}
   */
  function expandTree(element, depth = 0) {
    if (depth > 8 || element === null || element === undefined) return element;
    if (Array.isArray(element)) return element.map((child) => expandTree(child, depth));
    if (typeof element !== "object") return element;
    if (typeof element.type === "function")
      return expandTree(element.type(element.props), depth + 1);
    const children = element.props?.children;
    if (children === undefined) return element;
    return { ...element, props: { ...element.props, children: expandTree(children, depth) } };
  }

  /** @param {any} fiber */
  function render(fiber) {
    current = fiber;
    index = 0;
    queued = [];
    fiber.element = expandTree(fiber.Component(fiber.props));
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

  /** @param {Function} fn @param {any[] | undefined} deps */
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
    Fragment: "Fragment",
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
    /** @param {Function} fn @param {any[]} [deps] */
    useMemo(fn, deps) {
      const fiber = current;
      const slot = index++;
      const previous = fiber.hooks[slot];
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        fiber.hooks[slot] = { kind: "memo", deps: deps ? [...deps] : undefined, value: fn() };
      }
      return fiber.hooks[slot].value;
    },
    /**
     * @param {(listener: () => void) => () => void} subscribe
     * @param {() => any} getSnapshot
     */
    useSyncExternalStore(subscribe, getSnapshot) {
      const fiber = current;
      scheduleEffect(() => {
        const unsubscribe = subscribe(() => dirty.add(fiber));
        return typeof unsubscribe === "function" ? unsubscribe : () => {};
      }, []);
      return getSnapshot();
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
    flush,
  };
}

/** 极简浏览器全局（样式注入 + localStorage 不需要）。 */
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
      addEventListener() {},
      removeEventListener() {},
      setTimeout,
      clearTimeout,
      localStorage: { getItem: () => null, setItem: () => {} },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      documentElement: { dataset: {} },
      visibilityState: "visible",
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return null;
      },
      createElement() {
        return {
          dataset: {},
          setAttribute() {},
          textContent: "",
          remove() {},
        };
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

/**
 * 载入真实 client 源码 → 跑 apply() → 拿到 settings.section 组件与注入 props。
 * @param {any} hooks
 */
function bootSettings(hooks) {
  const browser = installGlobals();
  // apply() 会起一个 10s 的外部变更轮询；单测不需要它，换成空实现（否则测试进程不退出）。
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = /** @type {any} */ (() => 0);
  globalThis.clearInterval = /** @type {any} */ (() => {});
  try {
    new Function(readFileSync(CLIENT, "utf8"))();
    const definition = browser.definition();
    assert.ok(definition !== null, "client.js 没有向 window.__ModuleLoader__ 注册");
    const module = definition.factory((/** @type {string} */ name) => {
      if (name === "react") return hooks.React;
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
      throw new Error(`未预期的 require：${name}`);
    });
    /** @type {{descriptor: any, Component: any}[]} */
    const slots = [];
    /** @param {string} key @param {any} [params] */
    const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
    const ctx = {
      /** @param {Function} fn */
      effect(fn) {
        const out = fn();
        return typeof out === "function" ? out : () => {};
      },
      get() {
        return undefined;
      },
      logger: { warn() {} },
      locale: { register: () => () => {}, bind: () => t },
      connection: {
        rpc: {
          /** @param {string} _channel @param {string} method */
          call: (_channel, method) => {
            const name = String(method).split("/")[1];
            if (name === "getPrefs")
              return Promise.resolve({ ok: true, value: { cascadeChildren: false } });
            if (name === "list")
              return Promise.resolve({ ok: true, value: { entries: [], trashRoot: "/tmp/trash" } });
            if (name === "receipts" || name === "audit")
              return Promise.resolve({ ok: true, value: { entries: [] } });
            return Promise.resolve({ ok: true, value: undefined });
          },
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
      inject() {
        return () => {};
      },
    };
    module.apply(ctx);
    const section = slots.find((entry) => entry.descriptor.name === "settings.section");
    assert.ok(section !== undefined, "没有注册 settings.section");
    assert.equal(section.descriptor.id, "session-delete");
    return {
      Component: section.Component,
      inject: section.descriptor.inject(),
      t,
      __test: module.__test,
      browser,
      restore() {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
        browser.restore();
      },
    };
  } catch (error) {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    browser.restore();
    throw error;
  }
}

/** @param {any} element @param {(element: any) => boolean} predicate @returns {any} */
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

/** @param {any} element @returns {string} */
function textOf(element) {
  if (element === null || element === undefined) return "";
  if (typeof element === "string") return element;
  if (typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join("");
  if (typeof element !== "object") return "";
  const children = element.props?.children;
  return textOf(Array.isArray(children) ? children : [children]);
}

/** @param {any} fiber */
function statusOf(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-session-delete-settings-status"] !== undefined,
  );
}

/** @param {any} fiber */
function retryOf(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-session-delete-settings-retry"] !== undefined,
  );
}

/** 级联勾选框（设置分节里唯一的 checkbox）。 @param {any} fiber */
function cascadeCheckbox(fiber) {
  const found = findElement(
    fiber.element,
    (element) =>
      element?.props?.type === "checkbox" && typeof element.props.onChange === "function",
  );
  assert.ok(found, "找不到「同时删除子会话」勾选框");
  return found;
}

/** @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

test("session-delete 设置：自动保存后先显示「已保存」，再回落「· 已保存」", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const props = Object.assign({}, booted.inject, { t: booted.t });
    const fiber = hooks.mount(booted.Component, props);
    await pump(hooks);
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-session-delete-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saved/u);

    cascadeCheckbox(fiber).props.onChange({ target: { checked: true } });
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "saving", "写盘期间要有「保存中…」");
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.equal(props.prefsStore.getSnapshot().cascadeChildren, true, "乐观更新：勾选要立刻反映");

    await sleep(360);
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "clean");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
    booted.restore();
  }
});

test("session-delete 设置：setPrefs 失败显示「保存失败：原因」，恢复后可重试", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    let failNext = true;
    /** @type {any[]} */
    const writes = [];
    const call = (/** @type {string} */ method, /** @type {any} */ request) => {
      if (method === "setPrefs") {
        writes.push(request);
        if (failNext) return Promise.reject(new Error("disk full"));
        return Promise.resolve({ cascadeChildren: request.cascadeChildren });
      }
      if (method === "list") return Promise.resolve({ entries: [], trashRoot: "/tmp/trash" });
      if (method === "receipts" || method === "audit") return Promise.resolve({ entries: [] });
      return Promise.resolve(undefined);
    };
    const props = Object.assign({}, booted.inject, { call: call, t: booted.t });
    const fiber = hooks.mount(booted.Component, props);
    await pump(hooks);

    cascadeCheckbox(fiber).props.onChange({ target: { checked: true } });
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "error");
    assert.match(textOf(statusOf(fiber)), /settings\.saveFailedDetail/u);
    assert.match(textOf(statusOf(fiber)), /disk full/u);
    const retry = retryOf(fiber);
    assert.ok(retry, "失败时必须给出重试入口");

    failNext = false;
    retry.props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.equal(writes.length, 2, "重试要真的再写一次 prefs");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
    booted.restore();
  }
});
