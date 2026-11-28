// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，且「已保存 / 未保存 / 保存失败」要看得见。
//
// projects 的设置分节**混用两种保存方式**：预算（显式「保存预算」按钮）与策略开关（改即存）。
// 本文件用迷你 hooks 运行时驱动真实 `apply()` 注册的 ProjectsSettings，断言统一状态行
// `data-projects-settings-status` 的 clean → dirty → saved 与 error → retry 两条路径，
// 以及预算保存按钮在 clean 时 disabled（§7.2.5）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你 hooks 运行时。 */
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
      location: { search: "" },
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

/** 一份项目夹具（settings 组件只读 fields，不需要完整形状）。 */
function projectFixture() {
  return {
    id: "p1",
    name: "P1",
    policy: {
      autonomy: "L1",
      persona: "",
      fallback: true,
      pr: { tier: "draft" },
      preapprove: [],
      autoRetry: false,
    },
    budget: {
      maxThreadsPerDay: 4,
      maxConcurrent: 2,
      maxStepsPerThread: 20,
      dailyTokens: 1000,
      weeklyTokens: 4000,
    },
  };
}

/**
 * 载入真实 client 源码 → 跑 apply() → 拿到 settings.section 组件与注入 props。
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
      throw new Error(`未预期的 require：${name}`);
    });
    /** @type {{method: string, request: any}[]} */
    const calls = [];
    /** @type {any} */
    const behavior = {
      setBudget: () => Promise.resolve({ budget: projectFixture().budget }),
      updateProject: () => Promise.resolve(projectFixture()),
    };
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
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (/** @type {string} */ key) => key;
        },
      },
      connection: {
        rpc: {
          /** @param {string} _channel @param {string} method @param {any} payload */
          call: (_channel, method, payload) => {
            const name = String(method).split("/")[1];
            const request = payload?.args || {};
            calls.push({ method: name, request: request });
            if (name === "describe") {
              return Promise.resolve({
                ok: true,
                value: { projectCount: 1, dataRoot: "/tmp/d" },
              });
            }
            if (name === "listProjects") {
              return Promise.resolve({ ok: true, value: [projectFixture()] });
            }
            if (name === "uiState") {
              return Promise.resolve({
                ok: true,
                value: { realtimeCi: false, available: false },
              });
            }
            if (name === "prPollState") return Promise.resolve({ ok: true, value: null });
            if (name === "realtimeCiSpec") {
              return Promise.resolve({ ok: true, value: { warning: "" } });
            }
            if (name === "usageView") return Promise.resolve({ ok: true, value: {} });
            if (name === "getProjectContent") {
              return Promise.resolve({
                ok: true,
                value: { instructionsChars: 0, memoryChars: 0, fragments: [] },
              });
            }
            if (name === "listAudit") return Promise.resolve({ ok: true, value: [] });
            if (name === "setBudget" || name === "updateProject") {
              return Promise.resolve()
                .then(() => behavior[name](request))
                .then((value) => ({ ok: true, value: value }));
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
    /** @type {{descriptor: any, Component: any}[]} */
    const slots = [];
    module.apply(ctx);
    const section = slots.find((entry) => entry.descriptor.name === "settings.section");
    assert.ok(section !== undefined, "没有注册 settings.section");
    assert.equal(section.descriptor.id, "projects");
    return {
      Component: section.Component,
      inject: section.descriptor.inject(),
      behavior,
      calls,
      browser,
      timing: module.__test.settingsSaveTiming,
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
    (element) => element?.props?.["data-projects-settings-status"] !== undefined,
  );
}

/** @param {any} fiber */
function budgetSaveButton(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-projects-settings-save"] !== undefined,
  );
}

/** @param {any} fiber */
function retryOf(fiber) {
  return findElement(
    fiber.element,
    (element) => element?.props?.["data-projects-settings-retry"] !== undefined,
  );
}

/** @param {any} fiber @param {string} key */
function budgetInput(fiber, key) {
  const found = findElement(
    fiber.element,
    (element) => element?.props?.["data-projects-budget-input"] === key,
  );
  assert.ok(found, `找不到预算输入 ${key}`);
  return found;
}

/** @param {any} fiber */
function autoRetryCheckbox(fiber) {
  const found = findElement(
    fiber.element,
    (element) => element?.props?.["data-projects-auto-retry"] !== undefined,
  );
  assert.ok(found, "找不到 autoRetry 开关");
  return found;
}

/** @param {any} hooks @param {number} [times] */
async function pump(hooks, times = 4) {
  for (let i = 0; i < times; i += 1) {
    await sleep(4);
    hooks.flush();
  }
}

test("projects 设置：clean 时预算保存 disabled、状态「· 已保存」", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.timing.resetMs;
  booted.timing.resetMs = 300;
  try {
    const props = Object.assign({}, booted.inject);
    const fiber = hooks.mount(booted.Component, props);
    await pump(hooks);
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-projects-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saveSaved/u);
    const save = budgetSaveButton(fiber);
    assert.ok(save, "缺少 data-projects-settings-save 锚点");
    assert.equal(save.props.disabled, true, "无改动时预算保存必须 disabled");
  } finally {
    booted.timing.resetMs = previous;
    booted.browser.restore();
  }
});

test("projects 设置：预算改动 → dirty；保存成功 → saved → 回落 clean", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.timing.resetMs;
  booted.timing.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, Object.assign({}, booted.inject));
    await pump(hooks);

    budgetInput(fiber, "dailyTokens").props.onChange({ target: { value: "2000" } });
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "dirty");
    assert.match(textOf(statusOf(fiber)), /settings\.saveUnsaved/u);
    assert.equal(budgetSaveButton(fiber).props.disabled, false, "有改动时预算保存必须可点");

    budgetSaveButton(fiber).props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.equal(budgetSaveButton(fiber).props.disabled, true, "保存后草稿清空 → 再次 disabled");

    await sleep(360);
    hooks.flush();
    assert.equal(statusOf(fiber).props["data-state"], "clean");
  } finally {
    booted.timing.resetMs = previous;
    booted.browser.restore();
  }
});

test("projects 设置：策略开关自动保存 → saved", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.timing.resetMs;
  booted.timing.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, Object.assign({}, booted.inject));
    await pump(hooks);
    autoRetryCheckbox(fiber).props.onChange({ target: { checked: true } });
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
    assert.ok(
      booted.calls.some(
        (call) =>
          call.method === "updateProject" && call.request?.patch?.policy?.autoRetry === true,
      ),
      "自动保存必须真的调用 updateProject",
    );
  } finally {
    booted.timing.resetMs = previous;
    booted.browser.restore();
  }
});

test("projects 设置：预算保存失败显示「保存失败：原因」，可重试", async () => {
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.timing.resetMs;
  booted.timing.resetMs = 300;
  try {
    const fiber = hooks.mount(booted.Component, Object.assign({}, booted.inject));
    await pump(hooks);
    budgetInput(fiber, "dailyTokens").props.onChange({ target: { value: "3000" } });
    hooks.flush();

    booted.behavior.setBudget = () => Promise.reject(new Error("disk full"));
    budgetSaveButton(fiber).props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "error");
    // t 在单测里是 key 恒等函数，因此断言「用的是带 {reason} 的失败模板」而不是具体文案。
    assert.match(textOf(statusOf(fiber)), /settings\.saveFailedDetail/u);
    const retry = retryOf(fiber);
    assert.ok(retry, "失败时必须给出重试入口");
    assert.equal(budgetSaveButton(fiber).props.disabled, false, "失败后草稿仍在，可再次保存");

    booted.behavior.setBudget = () => Promise.resolve({ budget: projectFixture().budget });
    retry.props.onClick();
    await pump(hooks);
    assert.equal(statusOf(fiber).props["data-state"], "saved");
  } finally {
    booted.timing.resetMs = previous;
    booted.browser.restore();
  }
});
