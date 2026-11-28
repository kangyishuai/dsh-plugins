// @ts-check
// USIM-U1-10（P2）：设置分节的保存状态必须可见。
//
// casefile 的设置分节是**只读诊断**（项目数 / 数据根 / REA 连接），没有任何可保存项。
// 本文件用迷你 hooks 运行时驱动真实 `apply()` 注册的 CasefileSettings，断言
// `data-casefile-settings-status="readonly"` 明确告诉用户「没有可保存的设置」，
// 而不是让用户找不到保存按钮、怀疑改动没生效（也不伪造「已保存」）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时（useState/useEffect/useCallback/useRef/useMemo）。 */
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

/** 极简浏览器全局。 */
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

/** 载入真实 client 源码 → 跑 apply() → 拿到 settings.section 组件。 @param {any} hooks */
function bootSettings(hooks) {
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
    const ctx = {
      /** @param {Function} fn */
      effect(fn) {
        const out = fn();
        return typeof out === "function" ? out : () => {};
      },
      get() {
        return undefined;
      },
      logger: { warn() {}, error() {} },
      locale: { register: () => () => {}, bind: () => (/** @type {string} */ key) => key },
      connection: {
        rpc: {
          /** @param {string} _channel @param {string} method */
          call: (_channel, method) => {
            const name = String(method).split("/")[1];
            if (name === "listProjects") {
              return Promise.resolve({ ok: true, value: [{ id: "c1", title: "Case 1" }] });
            }
            if (name === "diagnose") {
              return Promise.resolve({
                ok: true,
                value: {
                  dataRoot: "/tmp/casefile",
                  grade: { ok: true, level: "connected" },
                  rea: { availableTools: 3 },
                },
              });
            }
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
      /** @param {string[]} _names @param {Function} callback */
      inject(_names, callback) {
        callback({ get: () => undefined });
        return () => {};
      },
    };
    module.apply(ctx);
    const section = slots.find((entry) => entry.descriptor.name === "settings.section");
    assert.ok(section !== undefined, "没有注册 settings.section");
    assert.equal(section.descriptor.id, "casefile");
    return { Component: section.Component, inject: section.descriptor.inject(), browser };
  } catch (error) {
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

/** @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

test("casefile 设置：只读分节明确显示「无可保存设置」，不伪造已保存", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  try {
    const fiber = hooks.mount(booted.Component, Object.assign({}, booted.inject));
    await pump(hooks);
    const status = findElement(
      fiber.element,
      (element) => element?.props?.["data-casefile-settings-status"] !== undefined,
    );
    assert.ok(status, "缺少 data-casefile-settings-status 锚点");
    assert.equal(status.props["data-state"], "readonly");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.readOnlyStatus/u);
    // 只读分节里不能有保存按钮（没有可保存的设置）。
    const save = findElement(
      fiber.element,
      (element) => element?.props?.["data-casefile-settings-save"] !== undefined,
    );
    assert.equal(save, undefined);
  } finally {
    booted.browser.restore();
  }
});
