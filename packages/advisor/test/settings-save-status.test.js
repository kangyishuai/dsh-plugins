// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，并且「已保存 / 未保存 / 保存失败」要看得见。
//
// advisor 的形态是**显式保存**：无改动时保存按钮 disabled、状态显示「已保存」；改动后显示
// 「有未保存更改」并启用按钮；保存失败显示「保存失败」+ 顶部错误横幅（原因 + 重试）。
// 本文件用迷你 hooks 运行时驱动**真实 client 源码**的 AdvisorSettings 组件，断言
// `data-advisor-settings-status` / `data-advisor-settings-save` 两个稳定锚点与四态。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时（与 btw/next-step 的 client 单测同一套路）。 */
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

/** 载入真实 client 源码 → 跑 apply() → 拿到 settings.section 注册的组件。 @param {any} hooks @param {any} api */
function bootSettings(hooks, api) {
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
      inject() {
        return () => {};
      },
    };
    module.apply(ctx);
    const section = slots.find((entry) => entry.descriptor.name === "settings.section");
    assert.ok(section !== undefined, "没有注册 settings.section");
    assert.equal(section.descriptor.id, "advisor");
    return {
      Component: section.Component,
      props: { api: api, t: (/** @type {string} */ key) => key },
      __test: module.__test,
    };
  } finally {
    browser.restore();
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
    (element) => element?.props?.["data-advisor-settings-status"] !== undefined,
  );
}

/** @param {any} fiber */
function saveButtonOf(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-advisor-settings-save"] !== undefined,
  );
}

/** @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 3) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

/** 设置快照（host `advisor/options` 返回形状里 normalizeOptions 接受的部分）。 */
function settingsFixture(overrides = {}) {
  return Object.assign(
    {
      mode: "advisory",
      provider: "",
      model: "",
      reasoningEffort: "",
      privacyScope: "summary",
      redact: true,
      dedupe: true,
      temperature: null,
      postAnswer: "off",
      advisorTools: false,
      tracePrompt: "preview",
      currency: "USD",
      usdToCny: 7.2,
      allowedModels: [],
      confirmedHosts: [],
    },
    overrides,
  );
}

/** 假 api：options 返回快照；updateSettings 按用例替换。 */
function fakeApi() {
  /** @type {{ method: string, request: any }[]} */
  const calls = [];
  /** @type {any} */
  const behavior = {
    settings: settingsFixture(),
    updateSettings: () => Promise.resolve({ ok: true, settings: behaviorNext.settings }),
  };
  /** @type {any} */
  const behaviorNext = { settings: settingsFixture({ mode: "off" }) };
  const api = {
    options: (/** @type {any} */ _sessionId) => {
      calls.push({ method: "options", request: _sessionId });
      return Promise.resolve({
        ok: true,
        settings: behavior.settings,
        routes: [{ provider: "mock", displayName: "Mock" }],
        totals: {},
        price: {},
      });
    },
    models: () => Promise.resolve([]),
    modelInfo: () => Promise.resolve({}),
    updateSettings: (/** @type {any} */ patch) => {
      calls.push({ method: "updateSettings", request: patch });
      return behavior.updateSettings();
    },
    doctor: () => Promise.resolve([]),
    preview: () => Promise.resolve({ text: "" }),
    notify: () => {},
  };
  return { api, behavior, behaviorNext, calls };
}

test("advisor 设置：clean 时保存按钮禁用、状态显示「已保存」", async () => {
  const hooks = createHooks();
  const { api } = fakeApi();
  const booted = bootSettings(hooks, api);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-advisor-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saved/u);
    assert.equal(
      status.props["data-advisor-dirty"],
      undefined,
      "clean 时旧锚点 data-advisor-dirty 不应存在（按旧语义只在 dirty 时出现）",
    );
    const save = saveButtonOf(fiber);
    assert.ok(save, "缺少 data-advisor-settings-save 锚点");
    assert.equal(save.props.disabled, true, "无改动时保存按钮必须 disabled");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
  }
});

test("advisor 设置：改动后 dirty、保存按钮启用；保存成功转 saved 再回落 clean", async () => {
  const hooks = createHooks();
  const { api, calls } = fakeApi();
  const booted = bootSettings(hooks, api);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);

    const modeSelect = findElement(
      fiber.element,
      (element) => element?.props?.["data-advisor-select"] === "mode",
    );
    assert.ok(modeSelect, "找不到模式下拉");
    modeSelect.props.onChange({ target: { value: "off" } });
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "dirty");
    assert.match(textOf(statusOf(fiber)), /settings\.dirty/u);
    // 旧锚点保留（§7.8 只增不删）：dirty 时按旧语义存在，且仍是 host warning 文案载体。
    assert.equal(statusOf(fiber).props["data-advisor-dirty"], "");
    assert.match(String(statusOf(fiber).props.className), /dsh-advisor-dirty/u);
    assert.equal(saveButtonOf(fiber).props.disabled, false);

    saveButtonOf(fiber).props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    const saved = calls.filter((call) => call.method === "updateSettings");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].request.mode, "off");

    await sleep(360);
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "clean");
    assert.equal(saveButtonOf(fiber).props.disabled, true);
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
  }
});

test("advisor 设置：保存失败显示「保存失败」与原因横幅，按钮仍可重试，重试成功转 saved", async () => {
  const hooks = createHooks();
  const { api, behavior, behaviorNext } = fakeApi();
  const booted = bootSettings(hooks, api);
  const previous = booted.__test.settingsSaveTiming.resetMs;
  booted.__test.settingsSaveTiming.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, booted.props);
    await pump(hooks);
    const modeSelect = findElement(
      fiber.element,
      (element) => element?.props?.["data-advisor-select"] === "mode",
    );
    modeSelect.props.onChange({ target: { value: "off" } });
    hooks.flush();

    behavior.updateSettings = () => Promise.resolve({ ok: false, message: "disk full" });
    saveButtonOf(fiber).props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "error");
    // 原因进状态行（与其他 6 个插件一致）；单测 t 是 key 恒等，故断言模板 key 前缀。
    assert.match(textOf(statusOf(fiber)), /settings\.error\.save/u);
    const banner = findElement(
      fiber.element,
      (element) => element?.props?.["data-advisor-error"] !== undefined,
    );
    assert.ok(banner, "失败时必须有错误横幅（带原因与重试）");
    // t 在单测里是 key 恒等函数，因此断言「用的是带 {message} 的失败模板」而不是具体文案。
    assert.match(textOf(banner), /settings\.error\.saveHost/u);
    assert.equal(saveButtonOf(fiber).props.disabled, false, "失败后必须还能重试");

    behavior.updateSettings = () => Promise.resolve({ ok: true, settings: behaviorNext.settings });
    saveButtonOf(fiber).props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
  } finally {
    booted.__test.settingsSaveTiming.resetMs = previous;
  }
});
