// @ts-check
// 发版后真机复审 O1 / O3 / O4 的 client 回归。
//
// 这三条都是「用户看得见」的缺陷：
//   O1 列表页删除项目后，回收站区块还显示「空的」，整页刷新才对；
//   O3 Routine 删除没有确认框（会撤掉宿主定时任务并丢历史，ADR 0002 要求的破坏性确认缺失）；
//   O4 Routine 创建成功后表单不清空，用户很容易再点一次建出重复任务。
//
// 做法：用迷你 hooks 运行时驱动**真实 client.js** 里导出的组件/纯函数，
// 不复制实现、不 mock 业务逻辑；渲染树直接断言 data-* 锚点与回调用途。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 迷你 hooks 运行时（同 settings-save-status.test.js：驱动真实组件）    */
/* ------------------------------------------------------------------ */

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
     * @param {any} type @param {any} props @param {...any} children
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
        /** @type {any} */
        const hook = {
          kind: "state",
          value: typeof initial === "function" ? initial() : initial,
        };
        // set 必须跨渲染稳定（React 保证），否则 useCallback([..., setState]) 每次重渲染都变，
        // effect 依赖跟着变，会把「只挂载一次」的加载又跑一遍（测试自己制造假 bug）。
        hook.set = (/** @type {any} */ next) => {
          const value = typeof next === "function" ? next(hook.value) : next;
          if (Object.is(value, hook.value)) return;
          hook.value = value;
          dirty.add(fiber);
        };
        fiber.hooks[slot] = hook;
      }
      const hook = fiber.hooks[slot];
      return [hook.value, hook.set];
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
    /** @param {Function} fn */
    useMemo(fn) {
      const fiber = current;
      const slot = index++;
      if (!(slot in fiber.hooks)) fiber.hooks[slot] = { kind: "memo", value: fn() };
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
    /** 外部换 props 并同步渲染一次（模拟父组件重渲染）。
     * @param {any} fiber @param {any} props */
    update(fiber, props) {
      fiber.props = props;
      dirty.add(fiber);
      flush();
    },
    /** 卸载：跑所有 effect cleanup（清 interval / listener），避免测试漏定时器。
     * @param {any} fiber */
    unmount(fiber) {
      fiber.mounted = false;
      dirty.delete(fiber);
      for (const hook of fiber.hooks) {
        if (hook && hook.kind === "effect" && typeof hook.cleanup === "function") {
          try {
            hook.cleanup();
          } catch {
            /* 清理失败不影响断言 */
          }
        }
      }
    },
    flush,
  };
}

/** 极简浏览器全局（组件渲染期不读 DOM：RoutineDeleteDialog/PanelTrash 都不需要）。 */
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
      querySelectorAll() {
        return [];
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

/** 载入真实 client 源码，拿到 exports.__test。
 * @param {any} hooks */
function loadClient(hooks) {
  const browser = installGlobals();
  try {
    // 本仓库源码是 classic script（不能 import），这里真实执行后取 window.__ModuleLoader__。
    new Function(readFileSync(CLIENT, "utf8"))();
    const definition = browser.definition();
    assert.ok(definition !== null, "client.js 没有向 window.__ModuleLoader__ 注册");
    const module = definition.factory((/** @type {string} */ name) => {
      if (name === "react") return hooks.React;
      throw new Error(`未预期的 require：${name}`);
    });
    return { api: module.__test, browser };
  } catch (error) {
    browser.restore();
    throw error;
  }
}

/**
 * 用真实中文词典做 t()，只做 {name} 插值（与宿主 locale.register 行为一致）。
 * @param {any} api
 */
function makeT(api) {
  /** @type {Record<string, string>} */
  const dict = api.zh;
  return (/** @type {string} */ key, /** @type {Record<string, unknown>} */ values) => {
    let value = dict[key] ?? key;
    if (values === undefined) return value;
    value = value.replace(
      /\{(\w+)\}/gu,
      (/** @type {string} */ _whole, /** @type {string} */ name) =>
        Object.hasOwn(values, name) ? String(values[name]) : _whole,
    );
    return value;
  };
}

/* ------------------------------------------------------------------ */
/* O3：Routine 删除确认框                                              */
/* ------------------------------------------------------------------ */

test("O3：删除影响面一行包含名字/频率/宿主任务/投递状态/不可恢复性", () => {
  const hooks = createHooks();
  const { api, browser } = loadClient(hooks);
  try {
    const t = makeT(api);
    const active = api.routineDeleteImpact(
      {
        id: "r1",
        name: "每日巡检",
        frequency: "daily",
        scheduleId: "sched-1",
        status: { status: "active" },
      },
      t,
    );
    assert.equal(
      active,
      "每日巡检 · 每天 · 宿主任务 sched-1 · 正在自动投递 · 删除后不可恢复（宿主任务与历史一起移除，审计保留）",
    );
    // 暂停 / 手动档：不能声称「正在自动投递」。
    const paused = api.routineDeleteImpact(
      {
        id: "r2",
        name: "周报",
        frequency: "weekly",
        scheduleId: "sched-2",
        status: { status: "paused" },
      },
      t,
    );
    assert.match(paused, /每周/u);
    assert.match(paused, /不会自动投递/u);
    assert.doesNotMatch(paused, /正在自动投递/u);
    const manual = api.routineDeleteImpact(
      { id: "r3", frequency: "manual", scheduleId: "", hostStatus: "manual" },
      t,
    );
    // 没有名字时回退 id（不会渲染 "undefined"）
    assert.match(manual, /r3/u);
    assert.match(manual, /手动档（无宿主定时任务）/u);
    assert.match(manual, /不会自动投递/u);
    // 手动档没有宿主任务：措辞不能写「宿主任务与历史一起移除」。
    assert.match(manual, /本地记录与历史一起移除/u);
    assert.doesNotMatch(manual, /宿主任务与历史一起移除/u);
  } finally {
    browser.restore();
  }
});

test("O3：确认框结构、默认聚焦标记与取消/确认回传", () => {
  const hooks = createHooks();
  const { api, browser } = loadClient(hooks);
  try {
    const t = makeT(api);
    /** @type {string[]} */
    const events = [];
    const routine = {
      id: "r1",
      name: "每日巡检",
      frequency: "daily",
      scheduleId: "sched-1",
      status: { status: "active" },
    };
    const tree = api.RoutineDeleteDialog({
      t,
      routine,
      busy: false,
      error: "",
      onCancel: () => events.push("cancel"),
      onConfirm: () => events.push("confirm"),
    });
    const found = collect(tree);
    const dialog = found.find(
      (node) => node.props["data-projects-routine-delete-dialog"] !== undefined,
    );
    assert.ok(dialog, "缺少 [data-projects-routine-delete-dialog] 锚点");
    assert.equal(dialog.props.role, "alertdialog");
    assert.equal(dialog.props["aria-modal"], "true");
    const impact = found.find(
      (node) => node.props["data-projects-routine-delete-impact"] !== undefined,
    );
    assert.ok(impact, "缺少一行影响面");
    assert.equal(String(impact.props.children[0]), api.routineDeleteImpact(routine, t));
    const cancel = found.find(
      (node) => node.props["data-projects-routine-delete-cancel"] !== undefined,
    );
    const confirm = found.find(
      (node) => node.props["data-projects-routine-delete-confirm"] !== undefined,
    );
    assert.ok(cancel, "缺少取消按钮");
    assert.ok(confirm, "缺少确认按钮");
    // ADR 0002 §破坏性确认：主按钮默认聚焦（data-modal-autofocus 由 useModalLayer 读取）
    assert.ok(
      confirm.props["data-modal-autofocus"] !== undefined,
      "确认按钮必须带 data-modal-autofocus",
    );
    assert.equal(confirm.props.disabled, false);
    cancel.props.onClick();
    confirm.props.onClick();
    assert.deepEqual(events, ["cancel", "confirm"]);

    // 忙碌态：两个按钮都禁用，主按钮显示「正在删除…」；失败原因就地显示，不吞掉。
    const busyTree = api.RoutineDeleteDialog({
      t,
      routine,
      busy: true,
      error: "schedule/delete-failed",
      onCancel: () => {},
      onConfirm: () => {},
    });
    const busyFound = collect(busyTree);
    const busyConfirm = busyFound.find(
      (node) => node.props["data-projects-routine-delete-confirm"] !== undefined,
    );
    assert.equal(busyConfirm.props.disabled, true);
    assert.equal(String(busyConfirm.props.children[0]), "正在删除…");
    assert.ok(
      busyFound.some((node) => node.props["data-projects-routine-delete-error"] !== undefined),
      "失败原因必须显示在确认框里",
    );
  } finally {
    browser.restore();
  }
});

/**
 * 把 createElement 树拍平成元素列表（用于锚点断言）。
 * @param {any} node
 * @param {any[]} [out]
 * @returns {any[]}
 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (!("props" in node)) return out;
  out.push(node);
  if (Array.isArray(node.props.children)) collect(node.props.children, out);
  else if (node.props.children !== undefined) collect(node.props.children, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* O1：列表页删除项目后回收站即时重载                                   */
/* ------------------------------------------------------------------ */

test("O1：回收站区块在 reloadToken 变化时复用 load 路径重新拉取", async () => {
  const hooks = createHooks();
  const { api, browser } = loadClient(hooks);
  try {
    const t = makeT(api);
    /** @type {any[]} */
    const rpcCalls = [];
    const fakeApi = {
      ctx: {
        connection: {
          rpc: {
            /** @param {string} _channel @param {string} method */
            call: (_channel, method) => {
              rpcCalls.push(method);
              return Promise.resolve({
                ok: true,
                value: { entries: [{ entryId: "e1" }, { entryId: "e2" }] },
              });
            },
          },
        },
      },
    };
    const fiber = hooks.mount(api.PanelTrash, {
      api: fakeApi,
      t,
      onChanged: () => {},
      reloadToken: 0,
    });
    await sleep(10);
    hooks.flush();
    assert.equal(rpcCalls.length, 1, "挂载时应加载一次回收站");
    const rendered = collect(fiber.element);
    const rowCount = rendered.filter(
      (node) => node.props["data-projects-trash-row"] !== undefined,
    ).length;
    assert.equal(rowCount, 2, "应渲染两条回收站条目");

    // 删除项目后父级 bump epoch：回收站必须重拉，而不是继续显示旧快照。
    hooks.update(fiber, { ...fiber.props, reloadToken: 1 });
    await sleep(10);
    hooks.flush();
    assert.equal(rpcCalls.length, 2, "reloadToken 变化后应再次调用 listTrash");
  } finally {
    browser.restore();
  }
});

test("O1：删除项目成功后 bump trash epoch（源码接线守卫）", () => {
  const source = readFileSync(CLIENT, "utf8");
  // 列表行删除成功分支必须 bump epoch —— 只刷新项目列表不会更新回收站。
  const rowDelete = source.slice(
    source.indexOf("var confirmRowDelete = useCallback"),
    source.indexOf("var submitCreate = useCallback"),
  );
  assert.match(rowDelete, /setTrashEpoch\(/u, "confirmRowDelete 成功后必须 bump trash epoch");
  // 回收站组件从父级拿到 reloadToken，并把它放进 effect 依赖。
  assert.match(source, /reloadToken: trashEpoch/u, "PanelTrash 必须收到 reloadToken");
  assert.match(
    source.slice(source.indexOf("function PanelTrash"), source.indexOf("function ArtifactViewer")),
    /\[load, reloadToken\]/u,
    "PanelTrash 的加载 effect 必须依赖 reloadToken",
  );
});

/* ------------------------------------------------------------------ */
/* O4：创建成功后清空表单，失败保留输入                                 */
/* ------------------------------------------------------------------ */

test("O4：默认草稿 + 成功清空 / 失败保留", () => {
  const hooks = createHooks();
  const { api, browser } = loadClient(hooks);
  try {
    const fresh = api.defaultRoutineDraft();
    assert.equal(fresh.name, "");
    assert.equal(fresh.instructions, "");
    assert.equal(fresh.frequency, "daily");
    assert.equal(fresh.time, "09:00");
    const filled = {
      ...fresh,
      name: "每日巡检",
      instructions: "检查昨天的构建",
      frequency: "weekly",
      time: "10:30",
      weekday: 3,
      dayOfMonth: 9,
    };
    // 成功：名字/指令清空，频率/时间回默认值。
    assert.deepEqual(api.routineDraftAfterCreate(filled, { ok: true }), fresh);
    // 失败：原样保留，用户不用重填。
    assert.equal(api.routineDraftAfterCreate(filled, { ok: false }).name, "每日巡检");
    assert.equal(api.routineDraftAfterCreate(filled, { ok: false }).frequency, "weekly");
  } finally {
    browser.restore();
  }
});

test("O4：创建 handler 在成功后应用重置（源码接线守卫）", () => {
  const source = readFileSync(CLIENT, "utf8");
  const createHandler = source.slice(
    source.indexOf('"data-projects-routine-create"'),
    source.indexOf('"data-projects-routine-message"'),
  );
  assert.match(createHandler, /createRoutine/u);
  assert.match(createHandler, /routineDraftAfterCreate\(/u, "创建成功路径必须重置草稿");
  // 删除按钮只开确认框，不再直接调 RPC。
  const deleteButton = source.slice(
    source.indexOf('"data-projects-routine-delete": routine.id'),
    source.indexOf('"data-projects-routine-delete": routine.id') + 400,
  );
  assert.match(deleteButton, /setDeleteTarget\(/u);
  assert.doesNotMatch(deleteButton, /deleteRoutine\(/u, "删除按钮不能直接删，必须先确认");
});

/* ------------------------------------------------------------------ */
/* B1（复审阻塞）：创建 Routine 期间按钮必须显示「正在创建…」            */
/* ------------------------------------------------------------------ */

test("B1：创建 routine 时按钮文案是「正在创建…」（busy 用稳定 key，显示与判等分离）", async () => {
  const hooks = createHooks();
  const { api, browser } = loadClient(hooks);
  /** @type {any} */
  let fiber = null;
  try {
    const t = makeT(api);
    // createRoutine 一直 pending：把「创建中」这一帧钉住，便于断言文案。
    const pending = new Promise(() => {});
    const fakeApi = {
      ctx: {
        connection: {
          rpc: {
            /** @param {string} _channel @param {string} method */
            call: (_channel, method) => {
              if (method === "projects/routinesView") {
                return Promise.resolve({
                  ok: true,
                  value: {
                    available: true,
                    routines: [],
                    costHint: "",
                    timeZone: "Asia/Shanghai",
                    projectDir: "/tmp/p1",
                  },
                });
              }
              if (method === "projects/createRoutine") return pending;
              return Promise.resolve({ ok: true, value: null });
            },
          },
        },
      },
    };
    fiber = hooks.mount(api.RoutinesView, {
      api: fakeApi,
      t,
      project: { id: "p1" },
    });
    await sleep(10);
    hooks.flush();
    /** @returns {any} */
    const createButton = () =>
      collect(fiber.element).find(
        (node) => node.props && node.props["data-projects-routine-create"] !== undefined,
      );
    const idle = createButton();
    assert.ok(idle, "找不到创建按钮");
    assert.equal(String(idle.props.children), "创建");
    assert.equal(idle.props.disabled, false);

    idle.props.onClick();
    await sleep(10);
    hooks.flush();
    const busy = createButton();
    assert.ok(busy, "点击后创建按钮消失");
    // B1 回归点：以前 busy 里塞本地化文本、判等仍用 "create"，这里会一直是「创建」。
    assert.equal(
      String(busy.props.children),
      "正在创建…",
      "创建期间按钮文案必须是 routines.creating（不是一直「创建」）",
    );
    assert.equal(busy.props.disabled, true, "创建期间按钮必须 disabled");
  } finally {
    // 断言失败也要清 interval，否则 test runner 会挂着等定时器。
    if (fiber !== null) hooks.unmount(fiber);
    browser.restore();
  }
});

/* ------------------------------------------------------------------ */
/* O3 复审补充：busy 时忽略 Esc（框不能关着但删除继续）                  */
/* ------------------------------------------------------------------ */

test("O3：busy 时不允许关闭确认框（Esc 与取消按钮行为一致）", () => {
  const hooks = createHooks();
  const { api, browser } = loadClient(hooks);
  try {
    assert.equal(api.routineDeleteCloseAllowed(null), true);
    assert.equal(api.routineDeleteCloseAllowed({ busy: false }), true);
    assert.equal(api.routineDeleteCloseAllowed({ busy: true }), false);
    // 接线：onClose 经过这个守卫（源码守卫；真实 Esc 由 useModalLayer 统一接管）。
    const source = readFileSync(CLIENT, "utf8");
    const layer = source.slice(
      source.indexOf('selector: "[data-projects-routine-delete-dialog]"'),
      source.indexOf('selector: "[data-projects-routine-delete-dialog]"') + 400,
    );
    assert.match(layer, /routineDeleteCloseAllowed\(deleteTarget\)/u);
  } finally {
    browser.restore();
  }
});
