// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，且「已保存 / 保存失败」要看得见。
//
// session-rewind 的形态是**自动保存**（写 localStorage，改完立刻生效）：本文件用迷你 hooks
// 运行时驱动真实 `apply()` 注册的 RewindSettingsSection，断言
// `data-session-rewind-settings-status` 的 clean → saved → clean 与 error → retry 两条路径。
// 失败注入方式：`localStorage.setItem` 抛错（隐私模式 / 配额满），这是该插件唯一的持久化失败源。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时：额外支持 useSyncExternalStore（订阅 store 变化重渲染）。 */
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
   * 无 hooks 的子组件（如 SettingsTab 这种纯渲染函数）就地展开成元素树，方便断言。
   * 只展开 `function` 类型且不是宿主字符串标签的节点；展开深度用一个上限兜底。
   * @param {any} element @param {number} [depth]
   * @returns {any}
   */
  function expandTree(element, depth = 0) {
    if (depth > 8 || element === null || element === undefined) return element;
    if (Array.isArray(element)) return element.map((child) => expandTree(child, depth));
    if (typeof element !== "object") return element;
    if (typeof element.type === "function") {
      return expandTree(element.type(element.props), depth + 1);
    }
    const children = element.props?.children;
    if (children === undefined) return element;
    return {
      ...element,
      props: { ...element.props, children: expandTree(children, depth) },
    };
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

/** 极简浏览器全局：localStorage 可切换成抛错，document 只用于样式注入。 */
function installGlobals() {
  /** @type {any} */
  let loaded = null;
  /** @type {Map<string, string>} */
  const storage = new Map();
  /** @type {{ fail: boolean }} */
  const storageState = { fail: false };
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
      navigator: { clipboard: { writeText: async () => {} } },
      localStorage: {
        /** @param {string} key */
        getItem: (key) => (storage.has(key) ? String(storage.get(key)) : null),
        /** @param {string} key @param {string} value */
        setItem: (key, value) => {
          if (storageState.fail) throw new Error("QuotaExceededError");
          storage.set(key, value);
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
    storage,
    storageState,
    restore() {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
    },
  };
}

/**
 * 载入真实 client 源码 → 跑 apply() → 拿到 settings.section 注册组件。
 * @param {any} hooks
 */
function bootSettings(hooks) {
  const browser = installGlobals();
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
    const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);
    const ctx = {
      /** @param {Function} fn */
      effect(fn) {
        const out = fn();
        return typeof out === "function" ? out : () => {};
      },
      get() {
        return undefined;
      },
      locale: { register: () => () => {}, bind: () => t },
      connection: {
        rpc: {
          /** @param {string} _channel @param {string} method */
          call: (_channel, method) => {
            const name = String(method).split("/")[1];
            if (name === "health") {
              return Promise.resolve({
                ok: true,
                value: { ok: true, version: 1, dataRoot: "/tmp/d", usage: {}, checks: [] },
              });
            }
            return Promise.resolve({ ok: true, value: {} });
          },
        },
      },
      sessions: {
        binding: () => ({ session: { getSnapshot: () => ({ running: false, subagent: null }) } }),
        list: { getSnapshot: () => ({ ids: [], byId: {} }) },
        scope: () => ({}),
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
    const section = slots.find((entry) => entry.descriptor.name === "settings.section");
    assert.ok(section !== undefined, "没有注册 settings.section");
    assert.equal(section.descriptor.id, "session-rewind");
    return {
      Component: section.Component,
      props: {},
      __test: module.__test,
      browser,
    };
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

/** @param {any} fiber */
function statusOf(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-session-rewind-settings-status"] !== undefined,
  );
}

/** 第二个单选（defaultMode = both）。 @param {any} fiber */
function secondModeRadio(fiber) {
  /** @type {any[]} */
  const radios = [];
  /** @param {any} element */
  const walk = (element) => {
    if (element === null || element === undefined) return;
    if (Array.isArray(element)) {
      for (const child of element) walk(child);
      return;
    }
    if (typeof element !== "object") return;
    if (element.props?.type === "radio" && typeof element.props.onChange === "function") {
      radios.push(element);
    }
    walk(element.props?.children);
  };
  walk(fiber.element);
  assert.ok(radios.length >= 2, `找不到两个模式单选（实际 ${radios.length}）`);
  return radios[1];
}

/** @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

test("session-rewind 设置：自动保存后先显示「已保存」，再回落「· 已保存」", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-session-rewind-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saved/u);

    // 改默认回退范围（自动保存）→ 短暂 saved
    secondModeRadio(fiber).props.onChange({ target: { checked: true } });
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.match(textOf(statusOf(fiber)), /settings\.saved/u);
    const stored = JSON.parse(String(booted.browser.storage.get("dsh-session-rewind.prefs.v1")));
    assert.equal(stored.defaultMode, "both", "自动保存必须真的把偏好写进 localStorage");

    await sleep(360);
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "clean");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
    booted.browser.restore();
  }
});

test("session-rewind 设置：localStorage 写失败显示「保存失败：原因」，恢复后可重试", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);

    booted.browser.storageState.fail = true;
    secondModeRadio(fiber).props.onChange({ target: { checked: true } });
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "error");
    assert.match(textOf(statusOf(fiber)), /settings\.saveFailed/u);
    assert.match(textOf(statusOf(fiber)), /settings\.saveFailedStorage/u);
    const retry = findElement(
      fiber.element,
      (element) => element?.props?.["data-session-rewind-settings-retry"] !== undefined,
    );
    assert.ok(retry, "失败时必须给出重试入口");

    // 存储恢复 → 重试成功写盘并转 saved
    booted.browser.storageState.fail = false;
    retry.props.onClick();
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    const stored = JSON.parse(String(booted.browser.storage.get("dsh-session-rewind.prefs.v1")));
    assert.equal(stored.defaultMode, "both");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
    booted.browser.restore();
  }
});
