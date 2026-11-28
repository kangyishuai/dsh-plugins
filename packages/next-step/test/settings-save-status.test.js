// @ts-check
// USIM-U1-10（P2）：设置分节的保存方式必须一致，且「已保存 / 保存失败」要看得见。
//
// next-step 的形态是**自动保存**（拨开关/选分档立刻写盘，没有保存按钮）：本文件用迷你 hooks
// 运行时驱动真实 client 源码的 NextStepSettings，断言 `data-next-step-settings-status`
// 的 clean → saving → saved → clean 与 error → retry 两条路径。
//
// 时序：「已保存」是短暂态，client 用 `setTimeout`（线上 2.5s，这里缩短成 300ms）复位回
// 「· 已保存」。这些用例**不再用真实 sleep 猜时序**——并行压测时 `sleep(4)` 可能实际睡几百毫秒，
// 越过复位窗口，断言 `saved` 时状态已回落成 `clean`（2026-11-28 实测：16 路并发 ×6 轮 96 次里
// 红 4 次，报错 `'clean' !== 'saved'`）。现在和 `client-retry-feedback.test.js` 共用
// `test/helpers/clock.js` 的假时钟：`waitFor()` 推进假时间直到目标状态出现，再推进到复位窗口后
// 断言回落，完全不依赖真实毫秒。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installClock, waitFor } from "./helpers/clock.js";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
/** 「已保存」短暂态在单测里的复位窗口（生产默认 2500ms，见 `__test.timings`）。 */
const RESET_MS = 300;

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

/** 找到某个开关（没有则 undefined，不抛错）。 @param {any} fiber @param {string} key */
const findSwitch = (fiber, key) =>
  findElement(fiber.element, (element) => element?.props?.["data-next-step-switch"] === key);

/** 当前保存状态（锚点还没渲染出来时是 undefined）。 @param {any} fiber */
const saveStateOf = (fiber) => statusOf(fiber)?.props?.["data-state"];

/**
 * 挂载设置分节并等到 settings RPC 回来（开关出现）。时间由假时钟推进，不依赖真实 sleep。
 * @param {ReturnType<typeof installClock>} clock
 * @param {any} hooks
 * @param {any} Component
 * @param {any} props
 */
async function mountSettings(clock, hooks, Component, props) {
  const fiber = hooks.mount(Component, props);
  const ready = await waitFor(clock, hooks, () => findSwitch(fiber, "card") !== undefined);
  assert.ok(ready, "settings 载入后应该出现开关");
  return fiber;
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
  const clock = installClock();
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.timings.settingsSaveResetMs;
  booted.__test.timings.settingsSaveResetMs = RESET_MS;
  try {
    const { api } = fakeApi();
    const fiber = await mountSettings(clock, hooks, booted.Component, {
      api: api,
      t: booted.t,
    });
    const status = statusOf(fiber);
    assert.ok(status, "缺少 data-next-step-settings-status 锚点");
    assert.equal(status.props["data-state"], "clean");
    assert.equal(status.props.role, "status");
    assert.match(textOf(status), /settings\.saved/u);

    switchOf(fiber, "card").props.onClick();
    hooks.flush();
    assert.equal(saveStateOf(fiber), "saving", "写盘期间要有「保存中…」");
    // 写盘成功 → 短暂显示「已保存」：假时间推进到出现 saved，而不是睡固定毫秒。
    const saved = await waitFor(clock, hooks, () => saveStateOf(fiber) === "saved");
    assert.ok(saved, "自动保存成功后要短暂显示「已保存」");
    assert.equal(saveStateOf(fiber), "saved");
    assert.match(textOf(statusOf(fiber)), /settings\.saved/u);

    // 「已保存」是短暂态：推进假时间越过复位窗口（TIMINGS.settingsSaveResetMs）后必须回落 clean。
    await clock.advance(RESET_MS + 1, hooks.flush);
    assert.equal(saveStateOf(fiber), "clean", "复位窗口过后要回落到「· 已保存」");
    assert.match(textOf(statusOf(fiber)), /settings\.saved/u);
  } finally {
    booted.__test.timings.settingsSaveResetMs = previous;
    booted.browser.restore();
    clock.restore();
  }
});

test("next-step 设置：保存失败显示「保存失败：原因」，恢复后可重试", async () => {
  const clock = installClock();
  const hooks = createHooks();
  const booted = bootSettings(hooks);
  const previous = booted.__test.timings.settingsSaveResetMs;
  booted.__test.timings.settingsSaveResetMs = RESET_MS;
  try {
    const { api, behavior, calls } = fakeApi();
    const fiber = await mountSettings(clock, hooks, booted.Component, {
      api: api,
      t: booted.t,
    });

    behavior.updateSettings = () => Promise.resolve({ ok: false, error: { message: "disk full" } });
    switchOf(fiber, "card").props.onClick();
    const failed = await waitFor(clock, hooks, () => saveStateOf(fiber) === "error");
    assert.ok(failed, "保存失败要显示 error 状态");
    assert.equal(saveStateOf(fiber), "error");
    assert.match(textOf(statusOf(fiber)), /settings\.updateFailed/u);
    assert.match(textOf(statusOf(fiber)), /disk full/u);
    const retry = retryOf(fiber);
    assert.ok(retry, "失败时必须给出重试入口");

    behavior.updateSettings = () =>
      Promise.resolve({ ok: true, settings: Object.assign({}, { card: false }) });
    retry.props.onClick();
    const saved = await waitFor(clock, hooks, () => saveStateOf(fiber) === "saved");
    assert.ok(saved, "重试成功后要显示「已保存」");
    assert.equal(saveStateOf(fiber), "saved");
    assert.equal(calls.filter((call) => call.method === "updateSettings").length, 2);
  } finally {
    booted.__test.timings.settingsSaveResetMs = previous;
    booted.browser.restore();
    clock.restore();
  }
});
