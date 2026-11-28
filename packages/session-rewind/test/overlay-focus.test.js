// @ts-check
// N3 接线测试：驱动**真实的 `RewindOverlay`** 渲染 + useEffect（vm 里 fake hooks + fake document），
// 而不是只测 helper / 组件 props。
//
// 复审 p3-nits §3.4 / M4：之前 vm 的 `useEffect` 是 stub，把 OverlayHost 的 effect 改回旧的
// `querySelector("[data-modal-autofocus]") || FOCUSABLE_SELECTOR`（= 会被抽屉页签抢走）时 118/118 全绿。
// 这里让 effect 真跑，并且 fake DOM **从真实渲染树推导**（复审 p3-nits N4 的收紧项）：
//   - 渲染 `RewindOverlay` 得到的元素树交给 fake document，`querySelector/querySelectorAll` 按真实
//     选择器在树里匹配（不手工指定「现在谁是 autofocus」）；
//   - 抽屉页签 / 内联确认行 / 「确认永久删除」/「取消」全部由真实的 `RewindDrawer` + `RescuesTab`
//     渲染出来，`data-modal-autofocus` 也是组件按状态真实加/移的。
// 断言 focus 落在谁身上（标签从元素 role/class 与所在确认行推导）：
//   1) 打开抽屉、无内联确认 → 页签；
//   2) 进入清空确认（dry-run 影响面还没到，确认行还没有 `data-srw-trash-clear`）→ 页签；
//   3) 影响面到达（真实渲染出内联确认行，主按钮带 `data-modal-autofocus`）→ **内联主按钮**；
//   4) 开始执行（主按钮 disabled、autofocus 真实移到「取消」）→ **取消**；
//   5) 确认行收起 → 回到页签。
// 任何一步 effect 不重跑、顺序/优先级改回旧实现，或真实组件不再产出对应的 autofocus，都会红。
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

// ---------------------------------------------------------------------------
// 渲染树 → 可查询的 fake DOM（不手工设定 autofocus 目标）
// ---------------------------------------------------------------------------

/** @typedef {{ element: any, ancestors: any[] }} TreeEntry */

/**
 * 把元素树拍平成「元素 + 祖先链」。函数组件按 React 语义展开（本测试用到的抽屉子组件都没有
 * hooks，可以安全直接调用）；Fragment 不产生 DOM 节点。
 * @param {any} tree
 * @returns {TreeEntry[]}
 */
function flattenTree(tree) {
  /** @type {TreeEntry[]} */
  const entries = [];
  /** @param {any} node @param {any[]} ancestors */
  const visit = (node, ancestors) => {
    if (node === null || node === undefined || node === false || node === true) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, ancestors);
      return;
    }
    if (typeof node !== "object") return;
    if (node.type === "Fragment") {
      visit(node.children, ancestors);
      return;
    }
    if (typeof node.type === "function") {
      const children = node.children;
      const props =
        children.length === 0
          ? node.props
          : { ...node.props, children: children.length === 1 ? children[0] : children };
      visit(node.type(props), ancestors);
      return;
    }
    entries.push({ element: node, ancestors });
    visit(node.children, [...ancestors, node]);
  };
  visit(tree, []);
  return entries;
}

/** 把 `.a, [b="c"], tag:not([d])` 拆成单个复合选择器。 @param {string} selector */
function splitSelectors(selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

const TOKEN_RE = /(?:[.#]?[A-Za-z0-9_-]+|\[[^\]]*\]|:not\([^)]*\))/g;

/**
 * 一个复合选择器（无空格组合）是否命中元素。
 * @param {any} element
 * @param {string} compound
 * @returns {boolean}
 */
function matchCompound(element, compound) {
  const props = element.props || {};
  const tokens = String(compound).match(TOKEN_RE) || [];
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    if (token.startsWith(".")) {
      const cls = String(props.className || "");
      if (!cls.split(/\s+/).includes(token.slice(1))) return false;
    } else if (token.startsWith("[")) {
      if (!matchAttribute(props, token)) return false;
    } else if (token.startsWith(":not(")) {
      const inner = token.slice(":not(".length, -1).trim();
      if (!inner.startsWith("[") || matchAttribute(props, inner)) return false;
    } else {
      // 标签选择器。
      if (element.type !== token) return false;
    }
  }
  return true;
}

/**
 * `[name]` / `[name="value"]`（也接受无引号值）是否命中 props。
 * @param {any} props
 * @param {string} token
 * @returns {boolean}
 */
function matchAttribute(props, token) {
  const body = token.slice(1, -1).trim();
  const eq = body.indexOf("=");
  if (eq === -1) return props[body] !== undefined;
  const name = body.slice(0, eq).trim();
  let raw = body.slice(eq + 1).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  return props[name] !== undefined && String(props[name]) === raw;
}

/**
 * 选择器（可含后代组合符）是否命中元素（按真实 DOM 语义：祖先链从近到远找）。
 * @param {any} element
 * @param {any[]} ancestors
 * @param {string} selector
 * @returns {boolean}
 */
function matchesSelector(element, ancestors, selector) {
  for (const part of splitSelectors(selector)) {
    const chain = part.split(/\s+/).filter((piece) => piece !== "");
    if (chain.length === 0) continue;
    if (!matchCompound(element, chain[chain.length - 1])) continue;
    let ancestorIndex = ancestors.length - 1;
    let ok = true;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      let found = false;
      while (ancestorIndex >= 0) {
        if (matchCompound(ancestors[ancestorIndex], chain[i])) {
          found = true;
          ancestorIndex -= 1;
          break;
        }
        ancestorIndex -= 1;
      }
      if (!found) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * fake DOM：`document.querySelector(".dsh-srw-dialog, .dsh-srw-drawer")` 返回一个 host，
 * host 的选择器查询全部在当前渲染树上求值，命中的元素包成带 `focus()` 的节点。
 * 焦点标签从真实元素推导（role/class/是否在 `[data-srw-trash-clear]` 内），不再有手工开关。
 * @returns {{ scene: any, doc: any }}
 */
function createFocusScene() {
  /** @type {string[]} */
  const focused = [];
  /** @type {TreeEntry[]} */
  let entries = [];

  /** @type {any} */
  const opener = {
    id: "opener",
    offsetParent: {},
    focus() {
      scene.activeElement = opener;
      focused.push("opener");
    },
  };
  /** @type {WeakMap<any, any>} */
  const wrappers = new WeakMap();
  /** @type {WeakSet<any>} */
  const wrapperSet = new WeakSet();
  wrapperSet.add(opener);

  /**
   * 从真实渲染树推导焦点标签：页签用 role="tab"，确认行里的按钮按 primary class 区分。
   * @param {any} element @param {any[]} ancestors
   * @returns {string}
   */
  const labelOf = (element, ancestors) => {
    const props = element.props || {};
    const cls = String(props.className || "");
    if (props.role === "tab") return "drawer-tab";
    const inInlineConfirm =
      props["data-srw-trash-clear"] !== undefined ||
      ancestors.some((ancestor) => ancestor.props?.["data-srw-trash-clear"] !== undefined);
    if (inInlineConfirm) {
      if (cls.includes("dsh-srw-btn-primary")) return "inline-primary";
      if (cls.includes("dsh-srw-btn")) return "inline-cancel";
      return "inline-other";
    }
    if (cls.includes("dsh-srw-btn-primary")) return "dialog-primary";
    if (cls.includes("dsh-srw-btn")) return "dialog-cancel";
    if (cls.includes("dsh-srw-link")) return "link";
    return "other";
  };

  /** @param {TreeEntry} entry @returns {any} */
  const nodeFor = (entry) => {
    let node = wrappers.get(entry.element);
    if (!node) {
      node = {
        id: labelOf(entry.element, entry.ancestors),
        offsetParent: {},
        focus() {
          scene.activeElement = node;
          focused.push(node.id);
        },
      };
      wrappers.set(entry.element, node);
      wrapperSet.add(node);
    }
    return node;
  };

  const hostEntry = () =>
    entries.find((entry) =>
      matchesSelector(entry.element, entry.ancestors, ".dsh-srw-dialog, .dsh-srw-drawer"),
    );

  /**
   * @param {string} selector
   * @param {boolean} all
   * @returns {any}
   */
  const hostQuery = (selector, all) => {
    const host = hostEntry();
    if (!host) return all ? [] : null;
    const hits = entries.filter(
      (entry) =>
        entry !== host &&
        entry.ancestors.includes(host.element) &&
        matchesSelector(entry.element, entry.ancestors, selector),
    );
    if (all) return hits.map(nodeFor);
    return hits.length > 0 ? nodeFor(hits[0]) : null;
  };

  const host = {
    /** @param {string} selector */
    querySelector: (selector) => hostQuery(selector, false),
    /** @param {string} selector */
    querySelectorAll: (selector) => hostQuery(selector, true),
  };

  const scene = {
    /** @type {any} */
    activeElement: opener,
    /** 由测试设置为当前 store 快照（RewindOverlay 通过 getSnapshot 读取）。 */
    state: null,
    focused,
    /** 记录本轮真实渲染树；后续所有查询都从它推导。 @param {any} tree */
    setTree(tree) {
      entries = flattenTree(tree);
    },
    /** 当前渲染树里匹配该选择器的元素数（断言真实组件确实渲染了对应节点）。 @param {string} selector */
    count(selector) {
      return entries.filter((entry) => matchesSelector(entry.element, entry.ancestors, selector))
        .length;
    },
    /** 当前渲染树里匹配选择器的原始元素（断言真实组件产出的属性）。 @param {string} selector */
    elements(selector) {
      return entries
        .filter((entry) => matchesSelector(entry.element, entry.ancestors, selector))
        .map((entry) => entry.element);
    },
  };

  const doc = {
    get activeElement() {
      return scene.activeElement;
    },
    /** @param {string} selector */
    querySelector(selector) {
      return selector === ".dsh-srw-dialog, .dsh-srw-drawer" && hostEntry() ? host : null;
    },
    /** @param {any} value */
    contains(value) {
      return wrapperSet.has(value);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return { scene, doc };
}

/** 在 vm 里加载 client.js（fake React / fake document），返回 `{ testApi, runtime }`。 @param {any} doc */
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

/** 抽屉打开、停在「救援点」页签、回收站里有一次可清空操作的基础 state。 @returns {any} */
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
        trash: {
          loading: false,
          errorKey: null,
          errorParams: null,
          // 真实组件只有列表非空时才渲染每个回收站操作（含内联确认行），所以这里必须给一条。
          list: [
            {
              id: "trash-1",
              time: 1000,
              targetSeq: 9,
              rescueId: "res-1",
              totalBytes: 7,
              paths: [{ path: "n.txt", bytes: 7 }],
            },
          ],
        },
        trashPendingId: null,
        trashExecutingId: null,
        trashClearId: null,
        trashClearImpact: null,
        trashClearExecuting: false,
      },
    },
  };
}

test("N3 接线：OverlayHost 的 focus effect 随回收站清空确认把焦点放到内联主按钮/取消", async () => {
  const { scene, doc } = createFocusScene();
  const loaded = loadClient(doc);
  const api = loaded.testApi;
  const runtime = loaded.runtime;
  assert.equal(typeof api.RewindOverlay, "function", "RewindOverlay 必须导出给接线测试");

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

  /**
   * 渲染真实组件 → 把真实渲染树交给 fake DOM → 跑 effect → 等 setTimeout(0) 的聚焦。
   * @param {any} nextState
   */
  const renderWith = async (nextState) => {
    scene.state = nextState;
    const tree = runtime.render(instance, api.RewindOverlay, props);
    scene.setTree(tree);
    runtime.flushEffects(instance);
    await tick();
  };

  // 1) 打开抽屉：焦点落在抽屉当前页签（既有行为，不能回归）。
  await renderWith(baseState());
  assert.deepEqual(scene.focused, ["drawer-tab"], "打开抽屉应先聚焦当前页签");
  assert.equal(scene.count("[data-srw-trash-clear]"), 0, "影响面未到时不渲染内联清空确认行");

  // 2) 点了「清空」、dry-run 影响面还没回来：真实树里还没有内联确认行，仍焦点页签。
  let state = /** @type {any} */ (baseState());
  state.drawer.rescues.trashClearId = "trash-1";
  state.drawer.rescues.trashClearImpact = null;
  await renderWith(state);
  assert.equal(scene.count("[data-srw-trash-clear]"), 0, "加载中还没有内联确认行");
  assert.deepEqual(scene.focused, ["drawer-tab", "drawer-tab"], "确认行加载中不抢焦点");

  // 3) 影响面到达：真实 RescuesTab 渲染出 `[data-srw-trash-clear]`，主按钮带 autofocus
  //    → 焦点必须移过去（不能被页签抢走）。
  state = /** @type {any} */ (baseState());
  state.drawer.rescues.trashClearId = "trash-1";
  state.drawer.rescues.trashClearImpact = { dryRun: true, files: 1, bytes: 7, paths: ["n.txt"] };
  await renderWith(state);
  assert.equal(scene.count("[data-srw-trash-clear]"), 1, "影响面到达后要渲染内联确认行");
  assert.equal(scene.count("[data-srw-trash-clear] [data-modal-autofocus]"), 1);
  assert.deepEqual(
    scene.focused,
    ["drawer-tab", "drawer-tab", "inline-primary"],
    "影响面到达后焦点必须在「确认永久删除」主按钮上",
  );

  // 4) 执行中：真实组件把 autofocus 移到「取消」（主按钮 disabled）→ 焦点回落取消。
  state = /** @type {any} */ (baseState());
  state.drawer.rescues.trashClearId = "trash-1";
  state.drawer.rescues.trashClearImpact = { dryRun: true, files: 1, bytes: 7, paths: ["n.txt"] };
  state.drawer.rescues.trashClearExecuting = true;
  await renderWith(state);
  const executingAutofocus = scene.elements("[data-srw-trash-clear] [data-modal-autofocus]")[0];
  assert.ok(executingAutofocus, "执行中确认行里应有一个 autofocus 目标");
  assert.doesNotMatch(
    String(executingAutofocus.props.className),
    /dsh-srw-btn-primary/u,
    "执行中 autofocus 必须从主按钮移到「取消」",
  );
  const executingPrimary = scene
    .elements("[data-srw-trash-clear] button")
    .find((/** @type {any} */ element) =>
      String(element.props.className).includes("dsh-srw-btn-primary"),
    );
  assert.equal(executingPrimary?.props.disabled, true, "执行中主按钮要 disabled");
  assert.deepEqual(
    scene.focused,
    ["drawer-tab", "drawer-tab", "inline-primary", "inline-cancel"],
    "执行中焦点必须回落到「取消」",
  );

  // 5) 确认行收起（清空完成/取消）：回到页签，不停在已卸载按钮上。
  await renderWith(baseState());
  assert.equal(scene.count("[data-srw-trash-clear]"), 0, "确认行收起后不再渲染");
  assert.equal(scene.focused.at(-1), "drawer-tab", "确认行收起后焦点回到页签");
});
