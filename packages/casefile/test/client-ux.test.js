// @ts-check
// client 半 UX 回归（2026-11-28 用户模拟审计：USIM-U1-04/05/16、USIM-U2-16、USIM-U3-07）。
//
// 这些是「文案/表单行为」缺陷：单元测试拿不到 client.js 的 JSX，所以这里用 vm 把
// **真实的 lib/client.js** 跑起来：极简 React shim（createElement/useState/useEffect/
// useCallback）+ 假宿主 ctx（locale/slots/connection），然后把注册到槽位里的组件渲染成
// 一棵可检查的树。任何一条断言红了都必须对应审计里的用户可见问题，不是实现细节。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const root = join(import.meta.dirname, "..");
const CLIENT_SOURCE = readFileSync(join(root, "lib", "client.js"), "utf8");
const TOOLS = readFileSync(join(root, "lib", "tools.js"), "utf8");

// ---------- 极简 React shim ----------

/** @typedef {{ kind: string, text?: string, type?: any, props?: any, children?: any[] }} RNode */

/**
 * @param {any[]} children
 * @param {any[]} out
 * @returns {any[]}
 */
function flattenChildren(children, out) {
  for (const child of children) {
    if (Array.isArray(child)) flattenChildren(child, out);
    else if (child === null || child === undefined || typeof child === "boolean") continue;
    else out.push(child);
  }
  return out;
}

/**
 * @param {any[] | undefined} left
 * @param {any[] | undefined} right
 * @returns {boolean}
 */
function sameDeps(left, right) {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function createReactShim() {
  /** @type {any} */
  let current = null;

  /** @param {any} type @param {any} props @param {...any} children */
  function createElement(type, props, ...children) {
    const kids = flattenChildren(children, []);
    // 与 React 一致：函数组件从 props.children 里取孩子（Tag/AdvancedHint 都这么写）
    const next = Object.assign(
      {},
      props || {},
      kids.length === 0
        ? {}
        : {
            children: kids.length === 1 ? kids[0] : kids,
          },
    );
    return { type, props: next, children: kids };
  }

  /** @param {any} initial */
  function useState(initial) {
    const store = current;
    const index = store.index++;
    if (!(index in store.states)) {
      store.states[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      store.states[index],
      (/** @type {any} */ value) => {
        const next = typeof value === "function" ? value(store.states[index]) : value;
        if (Object.is(next, store.states[index])) return;
        store.states[index] = next;
        store.session.dirty = true;
      },
    ];
  }

  /** @param {any} fn @param {any[]} [deps] */
  function useCallback(fn, deps) {
    const store = current;
    const index = store.index++;
    const prev = store.callbacks[index];
    if (prev && sameDeps(prev.deps, deps)) return prev.fn;
    store.callbacks[index] = { fn, deps };
    return fn;
  }

  /** @param {any} fn @param {any[]} [deps] */
  function useEffect(fn, deps) {
    const store = current;
    const index = store.index++;
    store.effects.push({ index, fn, deps });
  }

  return {
    React: { createElement, useState, useCallback, useEffect },
    /** @param {any} store */
    setCurrent(store) {
      current = store;
    },
  };
}

/** @returns {{ createElement: any, setAttribute: any, textContent: string, parentNode: any }} */
function makeElementStub() {
  return {
    createElement: null,
    setAttribute() {},
    textContent: "",
    parentNode: null,
  };
}

function makeDocumentStub() {
  /** @type {any} */
  const head = {
    children: [],
    /** @param {any} el */
    appendChild(el) {
      head.children.push(el);
      el.parentNode = head;
    },
    /** @param {any} el */
    removeChild(el) {
      head.children = head.children.filter((/** @type {any} */ item) => item !== el);
      el.parentNode = null;
    },
  };
  return {
    head,
    createElement() {
      return makeElementStub();
    },
  };
}

// ---------- 渲染会话（持久化 hook 状态，可重渲染） ----------

/**
 * @param {any} Component
 * @param {any} props
 * @param {{ React: any, setCurrent: (store: any) => void }} shim
 */
function createRenderSession(Component, props, shim) {
  /** @type {Map<string, any>} */
  const stores = new Map();
  /** @type {any} */
  const session = { dirty: false, tree: null, pending: [] };

  /** @param {string} path @param {any} type */
  function storeFor(path, type) {
    let store = stores.get(path);
    if (!store) {
      store = {
        session,
        type,
        index: 0,
        states: [],
        callbacks: [],
        effects: [],
        lastDeps: [],
      };
      stores.set(path, store);
    }
    return store;
  }

  /**
   * @param {any} node
   * @param {string} path
   * @returns {RNode | null}
   */
  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") {
      return { kind: "text", text: String(node) };
    }
    if (Array.isArray(node)) {
      return {
        kind: "fragment",
        children: node.map((child, index) => renderNode(child, `${path}.${index}`)),
      };
    }
    if (typeof node.type === "function") {
      const store = storeFor(path, node.type);
      store.index = 0;
      store.effects = [];
      shim.setCurrent(store);
      /** @type {any} */
      let output;
      try {
        output = node.type(node.props);
      } finally {
        shim.setCurrent(null);
      }
      session.pending.push(store);
      return {
        kind: "component",
        type: node.type,
        props: node.props || {},
        children: [renderNode(output, `${path}.out`)],
      };
    }
    return {
      kind: "host",
      type: node.type,
      props: node.props || {},
      children: (node.children || []).map((/** @type {any} */ child, /** @type {number} */ index) =>
        renderNode(child, `${path}.${index}`),
      ),
    };
  }

  function render() {
    session.pending = [];
    session.tree = renderNode({ type: Component, props, children: [] }, "root");
  }

  function runEffects() {
    const pending = session.pending;
    session.pending = [];
    for (const store of pending) {
      const effects = store.effects;
      store.effects = [];
      for (const effect of effects) {
        const prev = store.lastDeps[effect.index];
        if (effect.deps && prev && sameDeps(prev, effect.deps)) continue;
        store.lastDeps[effect.index] = effect.deps;
        effect.fn();
      }
    }
  }

  return { session, render, runEffects };
}

/** @param {number} [ms] */
function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑完微任务与副作用，直到没有 setState 再触发重渲染。
 * @param {{ session: any, render: () => void, runEffects: () => void }} view
 */
async function pump(view) {
  await tick();
  for (let round = 0; round < 40; round += 1) {
    view.runEffects();
    await tick();
    if (!view.session.dirty) return;
    view.session.dirty = false;
    view.render();
    await tick();
  }
  throw new Error("client 渲染没有收敛（可能有 effect 死循环）");
}

// ---------- 树查询 ----------

/**
 * @param {RNode | null} node
 * @param {(node: RNode) => boolean} predicate
 * @param {RNode[]} [out]
 * @returns {RNode[]}
 */
function findAll(node, predicate, out = []) {
  if (!node) return out;
  if (node.kind === "text") return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
}

/**
 * @param {RNode | null} node
 * @returns {string}
 */
function textContent(node) {
  if (!node) return "";
  if (node.kind === "text") return node.text || "";
  return (node.children || []).map(textContent).join("");
}

/**
 * @param {RNode | null} node
 * @param {string} needle
 */
function countText(node, needle) {
  /** @type {string[]} */
  const texts = [];
  /** @param {RNode | null} current */
  const walk = (current) => {
    if (!current) return;
    if (current.kind === "text") {
      texts.push(current.text || "");
      return;
    }
    for (const child of current.children || []) walk(child);
  };
  walk(node);
  return texts.filter((text) => text.includes(needle)).length;
}

/**
 * @param {RNode | null} node
 * @param {string} key
 * @param {string} [value]
 */
function findData(node, key, value) {
  const hits = findAll(
    node,
    (item) =>
      item.kind === "host" &&
      item.props &&
      Object.hasOwn(item.props, key) &&
      (value === undefined || String(item.props[key]) === value),
  );
  assert.ok(hits.length > 0, `没有找到 [${key}=${value ?? "*"}]`);
  return hits[0];
}

/**
 * 节点子树里是否有某个 details 高级说明。
 * @param {RNode | null} node
 */
function advancedBlocks(node) {
  return findAll(node, (item) => item.kind === "host" && item.type === "details");
}

// ---------- 假宿主 ----------

/**
 * @param {Record<string, (args?: any) => any>} handlers
 */
function makeRpc(handlers) {
  /** @type {Array<{ method: string, args: any }>} */
  const calls = [];
  return {
    calls,
    call(/** @type {string} */ _path, /** @type {string} */ method, /** @type {any} */ params) {
      const name = method.replace(/^casefile\//u, "");
      calls.push({ method: name, args: params?.args });
      const handler = handlers[name];
      if (!handler) {
        return Promise.resolve({
          ok: false,
          error: { code: "test-unmocked", message: `unmocked ${name}` },
        });
      }
      return Promise.resolve(handler(params?.args)).then((result) => {
        if (result && typeof result === "object" && "ok" in result) return result;
        return { ok: true, value: result };
      });
    },
  };
}

/**
 * 在 vm 里加载真实 client.js，并 apply 到假 ctx，返回槽位注册表。
 */
function loadClient() {
  /** @type {any} */
  let descriptor = null;
  const shim = createReactShim();
  const sandbox = {
    window: {
      __ModuleLoader__: {
        /** @param {any} value */
        load(value) {
          descriptor = value;
        },
      },
    },
    document: makeDocumentStub(),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: "lib/client.js" });
  assert.ok(descriptor, "client.js 必须调用 window.__ModuleLoader__.load");

  /** @type {Record<string, any>} */
  const registry = {};
  /** @type {any} */
  let dictionaries = null;
  /** @type {any} */
  let rpc = null;

  /** @param {string} key @param {Record<string, any>} [vars] */
  const t = (key, vars) => {
    const raw = dictionaries?.zh?.[key] ?? key;
    if (!vars) return raw;
    return String(raw).replace(/\{(\w+)\}/gu, (_match, name) =>
      vars[name] === undefined || vars[name] === null ? "—" : String(vars[name]),
    );
  };

  const ctx = {
    effect(/** @type {() => any} */ fn) {
      fn();
      return () => {};
    },
    locale: {
      register(/** @type {string} */ _ns, /** @type {any} */ dicts) {
        dictionaries = dicts;
      },
      bind() {
        return t;
      },
    },
    slots: {
      inject(/** @type {string} */ _name, /** @type {() => void} */ fn) {
        fn();
      },
      register(/** @type {any} */ config, /** @type {any} */ Component) {
        registry[String(config.name)] = Component;
        return () => {};
      },
    },
    connection: {
      rpc: {
        call(/** @type {any[]} */ ...args) {
          assert.ok(rpc, "测试必须在挂载前设置 RPC mock");
          return rpc.call(...args);
        },
      },
    },
  };

  const moduleExports = descriptor.factory((/** @type {string} */ name) => {
    if (name === "react") return shim.React;
    throw new Error(`client.js require 了未预期的模块：${name}`);
  });
  moduleExports.apply(ctx);

  return {
    registry,
    shim,
    ctx,
    t,
    /** @param {any} next */
    setRpc(next) {
      rpc = next;
    },
    /**
     * @param {string} slot
     * @param {Record<string, any>} [extra]
     */
    mount(slot, extra) {
      const Component = registry[slot];
      assert.ok(typeof Component === "function", `槽位 ${slot} 没有注册组件`);
      const view = createRenderSession(
        Component,
        Object.assign({ api: { ctx, t }, t }, extra || {}),
        shim,
      );
      view.render();
      return view;
    },
  };
}

// ---------- 固定测试数据 ----------

const PROJECT = {
  id: "demo-app",
  title: "示例 App",
  target: { kind: "binary", ref: "/tmp/demo/App.bin" },
  authTier: "owned",
  scope: "all",
  state: "investigating",
  evidence: 0,
  claims: 0,
  obligations: 0,
};

const DETAIL = {
  project: {
    id: "demo-app",
    title: "示例 App",
    target: { kind: "binary", ref: "/tmp/demo/App.bin" },
    authTier: "owned",
    scope: "all",
    state: "investigating",
  },
  autonomy: { level: "L2" },
  stats: { selectedClaims: 0, openObligations: 0, passedObligations: 0 },
  claims: [],
  evidence: [],
  obligations: [],
  unknowns: [],
  builds: [],
  checks: [],
};

/**
 * @param {Partial<typeof DETAIL>} [patch]
 */
function detailWith(patch = {}) {
  return Object.assign({}, DETAIL, patch);
}

/** 默认 RPC：空项目列表 + 空总览。 */
function emptyHandlers() {
  return {
    listProjects: () => [],
    overview: () => null,
  };
}

// ---------- USIM-U1-04：空态说人话，工具名进「高级」折叠 ----------

test("USIM-U1-04 案卷空态是人话引导（是什么 / 适合谁 / 第一步），工具名只在高级折叠里", async () => {
  const client = loadClient();
  client.setRpc(makeRpc(emptyHandlers()));
  const view = client.mount("main");
  await pump(view);

  const empty = findData(view.session.tree, "data-casefile-empty", "projects");
  // 高级折叠里的工具名不算「普通文案」：先把它从文本里剔掉再断言
  const humanText = advancedBlocks(empty).reduce(
    (accumulator, block) => accumulator.replace(textContent(block), ""),
    textContent(empty),
  );
  assert.match(humanText, /第一步/u, "空态必须给第一步");
  assert.match(humanText, /适合|面向/u, "空态必须说适合谁");
  assert.doesNotMatch(humanText, /case_[a-z]+/u, `普通文案里不应出现工具名：${humanText}`);

  const advanced = advancedBlocks(empty);
  assert.ok(advanced.length > 0, "空态必须把工具名收进「高级/开发者」折叠");
  const advancedText = advanced.map(textContent).join("\n");
  assert.match(advancedText, /case_claim/u, "高级折叠里要保留 case_claim");
  assert.match(advancedText, /case_evidence/u, "高级折叠里要保留 case_evidence");
  assert.match(advancedText, /开发者|开发人员|AI/u, "折叠标题要说明是给开发者/AI 的");
});

test("USIM-U1-04 详情页三个空页签：人话在前，工具名在折叠里", async () => {
  const client = loadClient();
  client.setRpc(
    makeRpc({
      listProjects: () => [PROJECT],
      overview: () => null,
      projectDetail: () => DETAIL,
    }),
  );
  const view = client.mount("main");
  await pump(view);
  findAll(
    view.session.tree,
    (node) =>
      node.kind === "host" && node.props && node.props["data-casefile-project-row"] === "demo-app",
  )[0].props.onClick();
  await pump(view);

  const claimsEmpty = findData(view.session.tree, "data-casefile-empty", "claims");
  const claimsHuman = textContent(claimsEmpty).replace(
    textContent(advancedBlocks(claimsEmpty)[0] || null),
    "",
  );
  assert.doesNotMatch(claimsHuman, /case_[a-z]+/u, "结论空态正文不应出现工具名");
  assert.match(claimsHuman, /证据|出处/u, "结论空态要解释结论是什么");
  assert.match(textContent(advancedBlocks(claimsEmpty)[0] || null), /case_claim/u);

  const evidenceEmpty = findData(view.session.tree, "data-casefile-empty", "evidence");
  const evidenceHuman = textContent(evidenceEmpty).replace(
    textContent(advancedBlocks(evidenceEmpty)[0] || null),
    "",
  );
  assert.doesNotMatch(evidenceHuman, /case_[a-z]+/u, "证据空态正文不应出现工具名");
  assert.match(evidenceHuman, /观察|出处/u, "证据空态要解释证据是什么");
  assert.match(textContent(advancedBlocks(evidenceEmpty)[0] || null), /case_evidence/u);

  const obligationTab = findData(view.session.tree, "data-casefile-tab", "obligation");
  obligationTab.props.onClick();
  await pump(view);
  const obligationEmpty = findData(view.session.tree, "data-casefile-empty", "obligations");
  const obligationHuman = textContent(obligationEmpty).replace(
    textContent(advancedBlocks(obligationEmpty)[0] || null),
    "",
  );
  assert.doesNotMatch(obligationHuman, /case_[a-z]+/u, "义务空态正文不应出现工具名");
  assert.match(obligationHuman, /断言|验收/u, "义务空态要解释义务是什么");
  assert.match(textContent(advancedBlocks(obligationEmpty)[0] || null), /case_obligation/u);
});

// ---------- USIM-U1-04（设置）：REA 未接入是说明，不是红色错误 ----------

test("USIM-U1-04 设置里 REA 未接入是「信息/不可用」说明，高级检测细节可展开", async () => {
  const client = loadClient();
  client.setRpc(
    makeRpc({
      listProjects: () => [],
      diagnose: () => ({
        dataRoot: "/tmp/casefile-test",
        grade: { ok: false, level: "missing" },
        rea: { availableTools: 0 },
      }),
    }),
  );
  const view = client.mount("settings.section");
  await pump(view);

  const notice = findData(view.session.tree, "data-casefile-rea-notice");
  const noticeClass = String(notice.props.className || "");
  assert.doesNotMatch(noticeClass, /cf-error/u, "REA 未接入不是错误状态，不能用错误色");
  const noticeText = textContent(notice).replace(
    textContent(advancedBlocks(notice)[0] || null),
    "",
  );
  assert.match(noticeText, /可选|不影响|手工/u, "要说明未接入 REA 的影响（可选/不阻塞）");
  assert.doesNotMatch(noticeText, /先接好/u, "不能像报错一样命令用户先接好");
  assert.doesNotMatch(noticeText, /mcp__rea__/u, "原始工具模式留给高级折叠");

  const rea = findData(view.session.tree, "data-casefile-rea");
  assert.equal(String(rea.props["data-state"]), "unavailable");

  const advancedText = advancedBlocks(notice).map(textContent).join("\n");
  assert.match(advancedText, /mcp__rea__\*/u, "高级折叠里保留 mcp__rea__* 检测结果");

  assert.equal(
    findAll(
      view.session.tree,
      (node) => node.kind === "host" && String(node.props?.className || "").includes("cf-error"),
    ).length,
    0,
    "设置页不应把 REA 未接入渲染成 cf-error",
  );
});

test("USIM-U1-04 设置里 REA 已接入显示为正常状态", async () => {
  const client = loadClient();
  client.setRpc(
    makeRpc({
      listProjects: () => [],
      diagnose: () => ({
        dataRoot: "/tmp/casefile-test",
        grade: { ok: true, level: "ok" },
        rea: { availableTools: 3 },
      }),
    }),
  );
  const view = client.mount("settings.section");
  await pump(view);
  const rea = findData(view.session.tree, "data-casefile-rea");
  assert.equal(String(rea.props["data-state"]), "connected");
  assert.match(textContent(rea), /已接入/u);
  assert.match(textContent(rea), /3/u);
});

// ---------- USIM-U1-05：新建表单有标签、必填有可见反馈、提交中禁用、失败可读 ----------

test("USIM-U1-05 新建表单：下拉与输入都有可见标签，标题标记必填", async () => {
  const client = loadClient();
  client.setRpc(makeRpc(emptyHandlers()));
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-new").props.onClick();
  await pump(view);

  const form = findData(view.session.tree, "data-casefile-create");
  const labels = findAll(form, (node) => node.kind === "host" && node.type === "label");
  assert.ok(labels.length >= 4, `四个字段都要有 <label>，实际 ${labels.length}`);
  const labelText = labels.map(textContent).join(" | ");
  for (const word of ["项目标题", "目标", "对象类型", "授权范围"]) {
    assert.ok(labelText.includes(word), `缺少标签：${word}（实际：${labelText}）`);
  }

  const titleInput = findData(form, "data-casefile-field-input", "title");
  assert.equal(String(titleInput.props["aria-required"]), "true", "标题必须标记必填");
  assert.equal(String(titleInput.props.required), "true");
  const kindSelect = findData(form, "data-casefile-field-input", "kind");
  assert.equal(String(kindSelect.props["aria-label"]), "对象类型");
  const authSelect = findData(form, "data-casefile-field-input", "auth");
  assert.equal(String(authSelect.props["aria-label"]), "授权范围");
});

test("USIM-U1-05 新建表单：空标题提交要给高亮 + 可读错误，且不发请求", async () => {
  const client = loadClient();
  const rpc = makeRpc(emptyHandlers());
  client.setRpc(rpc);
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-new").props.onClick();
  await pump(view);

  const submit = findData(view.session.tree, "data-casefile-submit");
  assert.notEqual(submit.props.disabled, true, "空标题时按钮要可点（否则就是「点了没反应」）");
  submit.props.onClick();
  await pump(view);

  const error = findData(view.session.tree, "data-casefile-create-error");
  assert.match(textContent(error), /填写.*标题|标题.*必填/u);
  const titleInput = findData(view.session.tree, "data-casefile-field-input", "title");
  assert.equal(String(titleInput.props["data-invalid"]), "true", "必填未填时输入框要高亮");
  assert.equal(
    rpc.calls.filter((entry) => entry.method === "createProject").length,
    0,
    "必填校验失败不能发 createProject",
  );
});

test("USIM-U1-05 新建表单：标题失焦立即给错误与高亮", async () => {
  const client = loadClient();
  client.setRpc(makeRpc(emptyHandlers()));
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-new").props.onClick();
  await pump(view);
  const titleInput = findData(view.session.tree, "data-casefile-field-input", "title");
  assert.equal(typeof titleInput.props.onBlur, "function", "必填项要在失焦时校验");
  titleInput.props.onBlur();
  await pump(view);
  const error = findData(view.session.tree, "data-casefile-create-error");
  assert.match(textContent(error), /填写.*标题|标题.*必填/u);
  assert.equal(
    String(findData(view.session.tree, "data-casefile-field-input", "title").props["data-invalid"]),
    "true",
  );
});

test("USIM-U1-05 新建表单：提交中禁用、成功关表单进详情、失败留在表单上给可读错误", async () => {
  const client = loadClient();
  /** @type {any} */
  let resolveCreate = null;
  const rpc = makeRpc({
    listProjects: () => [PROJECT],
    overview: () => null,
    projectDetail: () => DETAIL,
    createProject: () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
  });
  client.setRpc(rpc);
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-new").props.onClick();
  await pump(view);
  const titleInput = findData(view.session.tree, "data-casefile-field-input", "title");
  titleInput.props.onInput({ target: { value: "我的新项目" } });
  await pump(view);
  findData(view.session.tree, "data-casefile-submit").props.onClick();
  await pump(view);
  findData(view.session.tree, "data-casefile-create");

  const submit = findData(view.session.tree, "data-casefile-submit");
  assert.equal(submit.props.disabled, true, "提交中必须禁用按钮");
  assert.match(textContent(submit), /创建中/u);

  resolveCreate({ id: "new-project", title: "我的新项目" });
  await pump(view);
  assert.equal(
    rpc.calls.filter((entry) => entry.method === "createProject").length,
    1,
    "只应提交一次",
  );
  assert.equal(
    findAll(
      view.session.tree,
      (node) => node.kind === "host" && node.props?.["data-casefile-create"] === "1",
    ).length,
    0,
    "创建成功后表单要收起",
  );

  // 失败路径：新开一份，createProject 返回业务错误
  const client2 = loadClient();
  client2.setRpc(
    makeRpc({
      listProjects: () => [],
      overview: () => null,
      createProject: () => ({ ok: false, error: { code: "bad-request", message: "标题不能为空" } }),
    }),
  );
  const view2 = client2.mount("main");
  await pump(view2);
  findData(view2.session.tree, "data-casefile-new").props.onClick();
  await pump(view2);
  findData(view2.session.tree, "data-casefile-field-input", "title").props.onInput({
    target: { value: "x" },
  });
  await pump(view2);
  findData(view2.session.tree, "data-casefile-submit").props.onClick();
  await pump(view2);
  const failure = findData(view2.session.tree, "data-casefile-create-error");
  assert.match(textContent(failure), /创建失败/u);
  assert.match(textContent(failure), /标题不能为空/u);
  assert.equal(
    findAll(
      view2.session.tree,
      (node) => node.kind === "host" && node.props?.["data-casefile-create"] === "1",
    ).length,
    1,
    "失败后表单要保留，方便改完重试",
  );
});

// ---------- USIM-U1-16：自主性悬浮说明是人话 + L0–L3 副标题 ----------

test("USIM-U1-16 自主性悬浮说明是人话，L0–L3 作为副标题保留", async () => {
  const client = loadClient();
  client.setRpc(
    makeRpc({ listProjects: () => [PROJECT], overview: () => null, projectDetail: () => DETAIL }),
  );
  const view = client.mount("main");
  await pump(view);
  const badge = findData(view.session.tree, "data-casefile-autonomy");
  const title = String(badge.props.title || "");
  assert.doesNotMatch(title, /scope=selected/u, `悬浮说明不应出现代码术语：${title}`);
  assert.match(title, /反复尝试|自动|权限等级/u, "要用人话解释这个等级是什么");
  assert.match(title, /L0[–-]L3|L0-L3|L0 到 L3/u, "L0–L3 术语保留为副标题");
});

// ---------- USIM-U2-16：运行 tab 空态同一句只出现一次 ----------

test("USIM-U2-16「运行」tab 空态文案不重复", async () => {
  const client = loadClient();
  client.setRpc(
    makeRpc({
      listProjects: () => [PROJECT],
      overview: () => null,
      projectDetail: () => detailWith({ builds: [], checks: [] }),
    }),
  );
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-project-row", "demo-app").props.onClick();
  await pump(view);
  findData(view.session.tree, "data-casefile-tab", "run").props.onClick();
  await pump(view);

  const tree = view.session.tree;
  assert.equal(countText(tree, "还没有构建记录"), 1, "同一句空态文案只能出现一次");
  assert.equal(countText(tree, "还没有检查记录"), 1, "检查空态也不能重复");
});

// ---------- USIM-U3-07：面板有明确入口 + 影响面 + 确认；工具描述要求用户明确同意 ----------

test("USIM-U3-07 面板有「移入回收站」入口：先 dry-run 影响面，再显式确认才真删", async () => {
  const client = loadClient();
  const rpc = makeRpc({
    listProjects: () => [PROJECT],
    overview: () => null,
    projectDetail: () => DETAIL,
    listTrash: () => [],
    dropProject: (args) =>
      args?.options?.dryRun === true
        ? {
            dryRun: true,
            projectId: "demo-app",
            projects: 1,
            bytes: 2048,
            files: 12,
            trashRoot: "/tmp/casefile-test/trash",
            previewTrashPath: "/tmp/casefile-test/trash/preview-demo-app",
            recoverable: true,
          }
        : { trashedTo: "/tmp/casefile-test/trash/2026-demo-app", bytes: 2048, files: 12 },
  });
  client.setRpc(rpc);
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-project-row", "demo-app").props.onClick();
  await pump(view);

  const danger = findData(view.session.tree, "data-casefile-danger");
  assert.match(textContent(danger), /危险操作|回收站/u, "危险操作区要说明这是什么");

  const drop = findData(view.session.tree, "data-casefile-drop");
  drop.props.onClick();
  await pump(view);

  const dryRunCalls = rpc.calls.filter(
    (entry) => entry.method === "dropProject" && entry.args?.options?.dryRun === true,
  );
  assert.equal(dryRunCalls.length, 1, "点入口必须先 dry-run 拿影响面");
  assert.equal(
    rpc.calls.filter(
      (entry) => entry.method === "dropProject" && entry.args?.options?.confirm === true,
    ).length,
    0,
    "看影响面之前不能真执行",
  );

  const preview = findData(view.session.tree, "data-casefile-drop-preview");
  const previewText = textContent(preview);
  assert.match(previewText, /12/u, "影响面要给文件数");
  assert.match(previewText, /2\.0 KB|2048|KB/u, "影响面要给体积");
  assert.match(previewText, /恢复/u, "要说明可恢复");

  findData(view.session.tree, "data-casefile-drop-confirm").props.onClick();
  await pump(view);
  const confirmCalls = rpc.calls.filter(
    (entry) => entry.method === "dropProject" && entry.args?.options?.confirm === true,
  );
  assert.equal(confirmCalls.length, 1, "确认后才真正移入回收站");
  assert.equal(confirmCalls[0].args.projectId, "demo-app");
  assert.ok(
    rpc.calls.some((entry) => entry.method === "listTrash"),
    "移入回收站后应刷新回收站视图",
  );
});

test("USIM-U3-07 影响面预览可以取消，且不会真的 drop", async () => {
  const client = loadClient();
  const rpc = makeRpc({
    listProjects: () => [PROJECT],
    overview: () => null,
    projectDetail: () => DETAIL,
    dropProject: () => ({ dryRun: true, files: 1, bytes: 10, recoverable: true }),
  });
  client.setRpc(rpc);
  const view = client.mount("main");
  await pump(view);
  findData(view.session.tree, "data-casefile-project-row", "demo-app").props.onClick();
  await pump(view);
  findData(view.session.tree, "data-casefile-drop").props.onClick();
  await pump(view);
  findData(view.session.tree, "data-casefile-drop-cancel").props.onClick();
  await pump(view);
  assert.equal(
    rpc.calls.filter(
      (entry) => entry.method === "dropProject" && entry.args?.options?.confirm === true,
    ).length,
    0,
  );
  assert.equal(
    findAll(
      view.session.tree,
      (node) => node.kind === "host" && node.props?.["data-casefile-drop-preview"] !== undefined,
    ).length,
    0,
    "取消后影响面预览要收起",
  );
});

test("USIM-U3-07 工具描述要求 agent 必须先得到用户明确同意才 drop", () => {
  assert.match(TOOLS, /用户明确同意|用户同意/u, "case_project 的 drop 说明必须要求用户明确同意");
  assert.match(TOOLS, /不要自行|不得自行|不能自行/u, "要明确禁止 agent 自行 drop 项目");
});

// ---------- USIM-U3-11：README 双语补「卸载后残留」 ----------

test("USIM-U3-11 README 双语都有「卸载后残留 + 手工清理」说明", () => {
  const readmeEn = readFileSync(join(root, "README.md"), "utf8");
  const readmeZh = readFileSync(join(root, "README.zh-CN.md"), "utf8");

  assert.match(readmeEn, /^## Uninstall/mu, "英文 README 缺 Uninstall 章节");
  assert.match(readmeZh, /^## 卸载/mu, "中文 README 缺卸载章节");

  for (const [name, text] of [
    ["README.md", readmeEn],
    ["README.zh-CN.md", readmeZh],
  ]) {
    const start = text.search(/^## (?:Uninstall|卸载)/mu);
    const section = text.slice(start, start + 1600);
    assert.match(section, /casefile|data root|数据根/iu, `${name} 要说明数据根位置`);
    assert.match(section, /trash|回收站/iu, `${name} 要说明回收站去留`);
    assert.match(section, /remove|delete|删除|清理/iu, `${name} 要给手工清理方式`);
  }
});
