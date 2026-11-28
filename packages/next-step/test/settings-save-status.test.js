// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，且「已保存 / 保存失败」要看得见。
//
// next-step 的形态是**自动保存**（拨开关/选分档立刻写盘，没有保存按钮）：本文件用迷你 hooks
// 运行时驱动真实 client 源码的 NextStepSettings，断言 `data-next-step-settings-status`
// 的 clean → saving → saved → clean 与 error → retry 两条路径。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时（与 next-step 既有 client 单测同一套路）。 */
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

/** 极简浏览器全局（client 半只在样式注入处碰它们）。 */
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
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      documentElement: { dataset: {} },
      visibilityState: "visible",
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
      locale: { register: () => () => {}, bind: () => t },
      connection: { rpc: { call: () => Promise.resolve(undefined) } },
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
    assert.equal(section.descriptor.id, "next-step");
    return { Component: section.Component, t, __test: module.__test, browser };
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
    (element) => element?.props?.["data-next-step-settings-status"] !== undefined,
  );
}

/** @param {any} fiber */
function retryOf(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-next-step-settings-retry"] !== undefined,
  );
}

/** 某个开关按钮。 @param {any} fiber @param {string} key */
function switchOf(fiber, key) {
  const found = findElement(
    fiber.element,
    (element) => element?.props?.["data-next-step-switch"] === key,
  );
  assert.ok(found, `找不到开关 ${key}`);
  return found;
}

/** @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

/** 假 api：settings 返回固定快照；updateSettings 按用例替换。 */
function fakeApi() {
  /** @type {{ method: string, request: any }[]} */
  const calls = [];
  /** @type {any} */
  const settings = {
    enabled: true,
    card: true,
    ghost: false,
    telemetry: false,
    cardThreshold: "could",
    maxCardsPerSession: 5,
    pauseUntil: 0,
  };
  /** @type {any} */
  const behavior = {
    updateSettings: () =>
      Promise.resolve({
        ok: true,
        settings: Object.assign({}, settings, { card: false }),
      }),
  };
  const api = {
    settings: () => Promise.resolve(settings),
    diagnostics: () =>
      Promise.resolve({
        generated: 0,
        hidden: 0,
        failed: 0,
        aborted: 0,
        skipped: 0,
        inflight: 0,
        lastError: "",
      }),
    report: () => Promise.resolve(null),
    updateSettings: (/** @type {any} */ patch) => {
      calls.push({ method: "updateSettings", request: patch });
      return behavior.updateSettings(patch);
    },
  };
  return { api, behavior, calls };
}

test("next-step 设置：无改动时状态为「· 已保存」，自动保存成功后先显示「已保存」再回落", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.timings.settingsSaveResetMs;
  booted.__test.timings.settingsSaveResetMs = 300;
  try {
    const { api } = fakeApi();
    const fiber = hooks.mount(booted.Component, { api: api, t: booted.t });
    await pump(hooks);
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-next-step-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saved/u);

    switchOf(fiber, "card").props.onClick();
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "saving", "写盘期间要有「保存中…」");
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.match(textOf(statusOf(fiber)), /settings\.saved/u);

    await sleep(360);
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "clean");
  } finally {
    booted.__test.timings.settingsSaveResetMs = previous;
    booted.browser.restore();
  }
});

test("next-step 设置：保存失败显示「保存失败：原因」，恢复后可重试", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.timings.settingsSaveResetMs;
  booted.__test.timings.settingsSaveResetMs = 300;
  try {
    const { api, behavior, calls } = fakeApi();
    const fiber = hooks.mount(booted.Component, { api: api, t: booted.t });
    await pump(hooks);

    behavior.updateSettings = () => Promise.resolve({ ok: false, error: { message: "disk full" } });
    switchOf(fiber, "card").props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "error");
    assert.match(textOf(statusOf(fiber)), /settings\.updateFailed/u);
    assert.match(textOf(statusOf(fiber)), /disk full/u);
    const retry = retryOf(fiber);
    assert.ok(retry, "失败时必须给出重试入口");

    behavior.updateSettings = () =>
      Promise.resolve({ ok: true, settings: Object.assign({}, { card: false }) });
    retry.props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.equal(calls.filter((call) => call.method === "updateSettings").length, 2);
  } finally {
    booted.__test.timings.settingsSaveResetMs = previous;
    booted.browser.restore();
  }
});
