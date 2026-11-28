// @ts-check
// N3 接线测试：驱动**真实的 `RewindOverlay`** 渲染 + useEffect（vm 里 fake hooks + fake document），
// 而不是只测 helper / 组件 props。
//
// 复审 p3-nits §3.4 / M4：之前 vm 的 `useEffect` 是 stub，把 OverlayHost 的 effect 改回旧的
// `querySelector("[data-modal-autofocus]") || FOCUSABLE_SELECTOR`（= 会被抽屉页签抢走）时 118/118 全绿。
// 这里让 effect 真跑：fake document 只提供 `.dsh-srw-drawer` 宿主，fake 宿主按选择器返回不同节点
// （内联确认行 / 抽屉页签 / 任意可聚焦），断言 focus 落在谁身上：
//   1) 打开抽屉、无内联确认 → 页签；
//   2) 进入清空确认（dry-run 影响面还没到）→ 页签；
//   3) 影响面到达（内联主按钮带 data-modal-autofocus）→ **内联主按钮**；
//   4) 开始执行（主按钮 disabled，autofocus 移到「取消」）→ **取消**。
// 任何一步 effect 不重跑或顺序/优先级改回旧实现都会红。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "..", "lib", "client.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 带 fake hooks（useState / useEffect / useRef / useSyncExternalStore）的 React 运行时。
 * 每个组件实例一份持久 hooks store，effect 在 deps 变化时重跑（模拟 React 的 cleanup→effect）。
 * @returns {{ React: any, render: (store: any, component: any, props: any) => any, flushEffects: (store: any) => void }}
 */
function createHooksRuntime() {
  /** @type {any} */
  let current = null;

  /** @param {any} type @param {any} props @param {...any} children */
  const h = (type, props, ...children) => ({ type, props: props || {}, children });

  const React = {
    createElement: h,
    Fragment: "Fragment",
    cloneElement: (/** @type {any} */ element, /** @type {any} */ extra) => ({
      ...element,
      props: { ...(element.props || {}), ...extra },
    }),
    isValidElement: (/** @type {any} */ value) =>
      !!value && typeof value === "object" && "type" in value,
    useSyncExternalStore: (/** @type {any} */ _subscribe, /** @type {any} */ getSnapshot) =>
      getSnapshot(),
    useState: (/** @type {any} */ initial) => {
      const store = current;
      const index = store.index++;
      if (!(index in store.states)) {
        store.states[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        store.states[index],
        (/** @type {any} */ next) => {
          store.states[index] = typeof next === "function" ? next(store.states[index]) : next;
        },
      ];
    },
    useEffect: (/** @type {any} */ fn, /** @type {any} */ deps) => {
      const store = current;
      const index = store.index++;
      store.effects.push({ index, fn, deps });
    },
    useCallback: (/** @type {any} */ fn) => fn,
    useRef: (/** @type {any} */ initial) => {
      const store = current;
      const index = store.index++;
      if (!(index in store.refs)) {
        store.refs[index] = { current: initial === undefined ? null : initial };
      }
      return store.refs[index];
    },
    memo: (/** @type {any} */ component) => component,
  };

  /** @param {any} component @param {any} props */
  function renderOnce(
    /** @type {any} */ store,
    /** @type {any} */ component,
    /** @type {any} */ props,
  ) {
    store.index = 0;
    store.effects = [];
    current = store;
    let tree;
    try {
      tree = component(props);
    } finally {
      current = null;
    }
    return tree;
  }

  /** 按 React 语义跑本轮 effect：deps 变才跑（先 cleanup 上一轮）。 */
  function flushEffects(/** @type {any} */ store) {
    for (const effect of store.effects) {
      const index = effect.index;
      const previous = store.lastDeps[index];
      const deps = effect.deps;
      const same =
        previous !== undefined &&
        deps !== undefined &&
        previous.length === deps.length &&
        previous.every((/** @type {any} */ value, /** @type {number} */ i) =>
          Object.is(value, deps[i]),
        );
      if (same) continue;
      if (typeof store.cleanups[index] === "function") store.cleanups[index]();
      store.lastDeps[index] = deps;
      const cleanup = effect.fn();
      store.cleanups[index] = typeof cleanup === "function" ? cleanup : null;
    }
  }

  return { React, render: renderOnce, flushEffects };
}

/**
 * fake DOM：`.dsh-srw-drawer` 宿主按选择器返回不同节点，并记录真实 `.focus()` 调用。
 * @param {{ inlineSelector: string, focusableSelector: string }} selectors
 * @returns {any}
 */
function createFocusScene(selectors) {
  /** @type {string[]} */
  const focused = [];
  /** @param {string} id */
  const element = (id) => ({
    id,
    focus() {
      focused.push(id);
      scene.activeElement = this;
    },
  });
  const opener = element("opener");
  const tab = element("drawer-tab");
  const inlinePrimary = element("inline-primary");
  const inlineCancel = element("inline-cancel");
  const firstFocusable = element("first-focusable");
  const scene = {
    /** @type {any} */
    state: null,
    /** 内联确认行是否已带 data-modal-autofocus（影响面到达 / 执行中）。 */
    hasInline: false,
    /** @type {any} */
    inlineTarget: null,
    /** @type {any} */
    activeElement: opener,
    focused,
    opener,
    tab,
    inlinePrimary,
    inlineCancel,
  };
  const host = {
    offsetParent: {},
    querySelector(/** @type {string} */ selector) {
      // 与生产 INLINE_CONFIRM_FOCUS_SELECTOR 一致：内联确认行里的 autofocus 优先。
      if (selector === selectors.inlineSelector) {
        return scene.hasInline ? scene.inlineTarget : null;
      }
      if (selector === "[data-modal-autofocus]") return tab;
      if (selector === selectors.focusableSelector) return firstFocusable;
      return null;
    },
    querySelectorAll(/** @type {string} */ selector) {
      return selector === selectors.focusableSelector ? [tab, inlinePrimary, inlineCancel] : [];
    },
  };
  const doc = {
    activeElement: opener,
    querySelector(/** @type {string} */ selector) {
      return selector === ".dsh-srw-dialog, .dsh-srw-drawer" ? host : null;
    },
    contains: (/** @type {any} */ value) => value === opener,
    addEventListener() {},
    removeEventListener() {},
  };
  return { scene, doc, host };
}

/** 在 vm 里加载 client.js（fake React / fake document），返回 `__test`。 @param {any} doc */
function loadClient(/** @type {any} */ doc) {
  const code = fs.readFileSync(clientPath, "utf8");
  /** @type {any} */
  let captured = null;
  const runtime = createHooksRuntime();
  /** @type {any} */
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (/** @type {any} */ value) => {
          captured = value;
        },
      },
      addEventListener() {},
      removeEventListener() {},
      setTimeout: () => 0,
      clearTimeout() {},
    },
    document: doc,
    console,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (/** @type {any} */ fn) => fn,
    cancelAnimationFrame() {},
    require: (/** @type {string} */ name) => {
      if (name === "react") return runtime.React;
      if (name.includes("ui-primitives")) return {};
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: clientPath });
  assert.ok(captured, "window.__ModuleLoader__.load was not called");
  const exported = captured.factory(sandbox.require);
  return { testApi: exported.__test, runtime };
}

/** 先载一次 client 拿真实选择器常量（fake DOM 只返回 null，不做任何聚焦）。 */
const PRELOAD = loadClient({
  activeElement: null,
  querySelector: () => null,
  contains: () => false,
  addEventListener() {},
  removeEventListener() {},
});
const SELECTORS = {
  inlineSelector: PRELOAD.testApi.INLINE_CONFIRM_FOCUS_SELECTOR,
  focusableSelector: PRELOAD.testApi.FOCUSABLE_SELECTOR,
};

/** 抽屉打开、停在「救援点」页签、无内联确认的基础 state。 @returns {any} */
function baseState() {
  return {
    mode: null,
    toast: null,
    previewLoading: false,
    executing: false,
    loading: false,
    drawer: {
      open: true,
      tab: "rescues",
      ghost: { cuts: [], loading: false, errorKey: null, errorParams: null, q: "" },
      audit: { entries: [], expanded: {}, loading: false, errorKey: null, errorParams: null },
      rescues: {
        list: [],
        loading: false,
        errorKey: null,
        errorParams: null,
        trash: { loading: false, errorKey: null, errorParams: null, list: [] },
        trashPendingId: null,
        trashExecutingId: null,
        trashClearId: null,
        trashClearImpact: null,
        trashClearExecuting: false,
      },
    },
  };
}

/** 只做一次「清空」确认的四态：无确认 / 确认中未拿到影响面 / 影响面到达 / 执行中。 */
test("N3 接线：OverlayHost 的 focus effect 随回收站清空确认把焦点放到内联主按钮/取消", async () => {
  const { scene, doc } = createFocusScene(SELECTORS);
  scene.state = baseState();
  const loaded = loadClient(doc);
  const api = loaded.testApi;
  const runtime = loaded.runtime;
  assert.equal(typeof api.RewindOverlay, "function", "RewindOverlay 必须导出给接线测试");

  /** @param {any} next */
  const setState = (next) => {
    scene.state = next;
  };
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => scene.state,
  };
  const apiProps = {
    closeDrawer() {},
    cancelTrashClear() {},
    confirmTrashClear() {},
    cancelRescue() {},
    setDrawerTab() {},
    refreshDrawer() {},
    pickMessageFromDrawer() {},
    clearToast() {},
    move() {},
    pick() {},
    doRewind() {},
    cancelDialog() {},
  };
  const props = { store, api: apiProps, t: (/** @type {string} */ key) => key };
  const instance = {
    index: 0,
    states: [],
    refs: [],
    effects: [],
    lastDeps: [],
    cleanups: [],
  };

  /** 渲染 + 跑 effect + 等 setTimeout(0) 的聚焦。 @param {any} nextState */
  const renderWith = async (nextState) => {
    setState(nextState);
    runtime.render(instance, api.RewindOverlay, props);
    runtime.flushEffects(instance);
    await tick();
  };

  // 1) 打开抽屉：焦点落在抽屉当前页签（既有行为，不能回归）。
  await renderWith(baseState());

  assert.deepEqual(scene.focused, ["drawer-tab"], "打开抽屉应先聚焦当前页签");

  // 2) 点了「清空」、dry-run 影响面还没回来：没有内联 autofocus，仍焦点页签。
  let state = /** @type {any} */ (baseState());
  state.drawer.rescues.trashClearId = "trash-1";
  state.drawer.rescues.trashClearImpact = null;
  await renderWith(state);
  assert.deepEqual(scene.focused, ["drawer-tab", "drawer-tab"], "确认行加载中不抢焦点");

  // 3) 影响面到达：内联「确认永久删除」带 autofocus → 焦点必须移过去（不能被页签抢走）。
  scene.hasInline = true;
  scene.inlineTarget = scene.inlinePrimary;
  state = /** @type {any} */ (baseState());
  state.drawer.rescues.trashClearId = "trash-1";
  state.drawer.rescues.trashClearImpact = { dryRun: true, files: 1, bytes: 7, paths: ["n.txt"] };
  await renderWith(state);
  assert.deepEqual(
    scene.focused,
    ["drawer-tab", "drawer-tab", "inline-primary"],
    "影响面到达后焦点必须在「确认永久删除」主按钮上",
  );

  // 4) 执行中：主按钮 disabled，autofocus 移到「取消」→ 焦点回落取消。
  scene.inlineTarget = scene.inlineCancel;
  state = /** @type {any} */ (baseState());
  state.drawer.rescues.trashClearId = "trash-1";
  state.drawer.rescues.trashClearImpact = { dryRun: true, files: 1, bytes: 7, paths: ["n.txt"] };
  state.drawer.rescues.trashClearExecuting = true;
  await renderWith(state);
  assert.deepEqual(
    scene.focused,
    ["drawer-tab", "drawer-tab", "inline-primary", "inline-cancel"],
    "执行中焦点必须回落到「取消」",
  );

  // 5) 确认行收起（清空完成/取消）：回到页签，不停在已卸载按钮上（旧元素不再存在）。
  scene.hasInline = false;
  await renderWith(baseState());
  assert.equal(scene.focused.at(-1), "drawer-tab", "确认行收起后焦点回到页签");
});
