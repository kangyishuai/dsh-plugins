// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，并且「已保存 / 未保存 / 保存失败」要看得见。
//
// btw 的形态是**显式保存**：无改动时保存按钮 disabled、状态显示「已保存」；改动后显示
// 「有未保存更改」并启用按钮；保存失败显示原因且按钮仍可点（重试）。本文件用迷你 hooks
// 运行时驱动**真实 client 源码**的 BtwSettings 组件，断言这四态与稳定锚点
// （`data-btw-settings-status` / `data-btw-settings-save`）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时（与既有 client 单测同一套路：useState/useRef/useEffect/useCallback）。 */
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

/**
 * 载入真实 client 源码 → 跑 apply() → 拿到 settings.section 注册组件。
 * @param {any} hooks
 * @param {any} api
 */
function bootSettings(hooks, api) {
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
    const ctx = {
      /** @param {Function} fn */
      effect(fn) {
        const out = fn();
        return typeof out === "function" ? out : () => {};
      },
      get() {
        return undefined;
      },
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (/** @type {string} */ key) => key;
        },
      },
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
      /** @param {string[]} _names @param {Function} _callback */
      inject(_names, _callback) {
        return () => {};
      },
    };
    module.apply(ctx);
    const section = slots.find((entry) => entry.descriptor.name === "settings.section");
    assert.ok(section !== undefined, "没有注册 settings.section");
    assert.equal(section.descriptor.id, "btw");
    const injected = section.descriptor.inject();
    // 注入的 api 是 apply() 里用 callRemote 拼的；测试把两个读写方法换成假实现，
    // 其余键保持宿主真实形状（不伪造额外方法）。
    const componentApi = Object.assign({}, injected.api, {
      settings: api.settings,
      updateSettings: api.updateSettings,
    });
    // 注册项是 `(slotProps) => h(BtwSettings, slotProps)` 的薄包装：取出真正的组件来挂载。
    const wrapper = section.Component({ api: componentApi, t: (/** @type {string} */ key) => key });
    assert.equal(typeof wrapper.type, "function", "settings.section 没有渲染出组件");
    return {
      Component: wrapper.type,
      props: wrapper.props,
      __test: module.__test,
    };
  } finally {
    // 组件渲染不再需要 window/document；但 client 源码里的定时器不受影响。
    browser.restore();
  }
}

/** 元素树里找第一个满足条件的节点。 @param {any} element @param {(element: any) => boolean} predicate @returns {any} */
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

/** @param {any} fiber */
function statusOf(fiber) {
  return findElement(fiber.element, (element) => element?.props?.["data-btw-settings-status"]);
}

/** @param {any} fiber */
function saveButtonOf(fiber) {
  return findElement(fiber.element, (element) => element?.props?.["data-btw-settings-save"]);
}

/** 等异步 RPC + 状态刷新。 @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

/**
 * 轮询等待状态行变成某个 state。
 * 并行跑全部包测试时事件循环会被抢，固定 sleep 的窗口会抖动；
 * 这里改成「等到期望状态或超时」，再断言，避免随机红。
 * @param {any} hooks @param {any} fiber @param {string} state @param {number} [timeoutMs]
 */
async function waitStatus(hooks, fiber, state, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    hooks.flush();
    const status = statusOf(fiber);
    if (status?.props?.["data-state"] === state) return status;
    await sleep(50);
  }
  const status = statusOf(fiber);
  assert.equal(status?.props?.["data-state"], state, `状态行没有在 ${timeoutMs}ms 内变成 ${state}`);
  return status;
}

/** 假 api：settings 返回初始值；updateSettings 按用例替换。 */
function fakeApi(options = {}) {
  /** @type {{ method: string, request: any }[]} */
  const calls = [];
  /** @type {any} */
  const behavior = {
    settings: () =>
      Promise.resolve({
        allowedTools: ["read"],
        historyLimit: 50,
        echoAnswer: true,
        boundedContext: false,
        readOnly: false,
      }),
    updateSettings: (/** @type {any} */ _patch) =>
      Promise.resolve({
        allowedTools: [],
        historyLimit: 50,
        echoAnswer: false,
        boundedContext: false,
        readOnly: false,
      }),
  };
  const api = {
    settings: () => {
      calls.push({ method: "settings", request: undefined });
      return behavior.settings();
    },
    updateSettings: (/** @type {any} */ patch) => {
      calls.push({ method: "updateSettings", request: patch });
      return behavior.updateSettings(patch);
    },
  };
  return { api, behavior, calls, ...options };
}

test("btw 设置：clean 时保存按钮禁用、状态显示「已保存」", async () => {
  const hooks = createHooks();
  const { api } = fakeApi();
  const booted = bootSettings(hooks, api);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-btw-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saved/u);
    const save = saveButtonOf(fiber);
    assert.ok(save, "缺少 data-btw-settings-save 锚点");
    assert.equal(save.props.disabled, true, "无改动时保存按钮必须 disabled");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
  }
});

test("btw 设置：改动后 dirty（未保存更改），保存按钮启用；保存成功转 saved 再回落 clean", async () => {
  const hooks = createHooks();
  const { api, calls } = fakeApi();
  const booted = bootSettings(hooks, api);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  // 保存后的「已保存」窗口要比并行测试的调度抖动更宽；回落用轮询等待。
  booted.__test.settingsSaveTiming.resetMs = 4000;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);

    // 改「允许工具」→ dirty
    const toolsInput = findElement(
      fiber.element,
      (element) => element?.props?.["data-btw-setting-tools"] !== undefined,
    );
    assert.ok(toolsInput, "找不到工具输入框");
    toolsInput.props.onChange({ target: { value: "read, grep" } });
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "dirty");
    assert.match(textOf(statusOf(fiber)), /settings\.unsaved/u);
    assert.equal(saveButtonOf(fiber).props.disabled, false);

    // 保存成功 → saved
    saveButtonOf(fiber).props.onClick();
    await pump(hooks);
    const savedStatus = await waitStatus(hooks, fiber, "saved", 4000);
    assert.match(textOf(savedStatus), /settings\.saved/u);
    assert.deepEqual(calls.filter((call) => call.method === "updateSettings").length, 1);
    const savedCall = calls.find((call) => call.method === "updateSettings");
    assert.ok(savedCall, "应当发出一次 updateSettings");
    assert.equal(savedCall.request.allowedTools, "read, grep");

    // 短暂态回落后仍是「· 已保存」，按钮重新禁用
    await waitStatus(hooks, fiber, "clean", 8000);
    assert.equal(saveButtonOf(fiber).props.disabled, true);
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
  }
});

test("btw 设置：保存失败显示原因且可重试（按钮仍启用），重试成功转 saved", async () => {
  const hooks = createHooks();
  const { api, behavior } = fakeApi();
  const booted = bootSettings(hooks, api);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 4000;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);

    const echoInput = findElement(
      fiber.element,
      (element) => element?.props?.["data-btw-setting-echo"] !== undefined,
    );
    echoInput.props.onChange({ target: { checked: false } });
    hooks.flush();

    behavior.updateSettings = () => Promise.reject(new Error("boom"));
    saveButtonOf(fiber).props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "error");
    assert.match(textOf(statusOf(fiber)), /settings\.failedReason/u);
    assert.equal(saveButtonOf(fiber).props.disabled, false, "失败后必须还能重试");

    // 重试成功
    behavior.updateSettings = () =>
      Promise.resolve({
        allowedTools: ["read"],
        historyLimit: 50,
        echoAnswer: false,
        boundedContext: false,
        readOnly: false,
      });
    saveButtonOf(fiber).props.onClick();
    await pump(hooks);
    await waitStatus(hooks, fiber, "saved", 4000);
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
  }
});
