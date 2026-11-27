// @ts-check
// client 半行为回归（AUD-projects-ui-01 / 04 / 05 / 06 / 07 / 08 / 10 / 15 / 16 / 19）。
//
// `lib/client.js` 是宿主原样下发的 classic script（`window.__ModuleLoader__.load({factory})`），
// 不能 import、也不能被 Node 直接执行。这里沿用 `packages/artifacts/test/client.test.js` 的套路：
// 用 `node:vm` 造一个假 `window.__ModuleLoader__` 执行**真实源码**，从 `exports.__test`
// 取纯函数与弹层 hook 断言行为——不复制实现，避免单测与线上漂移。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { parseArtifactMarkdown } from "../lib/artifact-render.js";

const CLIENT_URL = new URL("../lib/client.js", import.meta.url);
const PACKAGE_ID = "@kangyishuai/dsh-projects";

/* ------------------------------------------------------------------ */
/* 最小 DOM 桩：只实现 useModalLayer / tabListKeyDown 用到的那些 API     */
/* ------------------------------------------------------------------ */

/**
 * 简单选择器匹配：支持 `tag`、`[attr]`、`[attr="v"]`、`:not([attr="v"])` 与逗号分组。
 * @param {any} element @param {string} selector
 */
function matchesSelector(element, selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSimple(element, part));
}

/** @param {any} element @param {string} selector */
function matchesSimple(element, selector) {
  let rest = selector;
  const tag = /^([a-zA-Z][\w-]*)/u.exec(rest);
  if (tag) {
    if (String(element.tagName || "").toLowerCase() !== tag[1].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    const not = /^:not\(\[([\w-]+)(?:="([^"]*)")?\]\)/u.exec(rest);
    if (not) {
      const value = element.getAttribute(not[1]);
      if (not[2] === undefined) {
        if (value !== null) return false;
      } else if (String(value) === not[2]) {
        return false;
      }
      rest = rest.slice(not[0].length);
      continue;
    }
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]/u.exec(rest);
    if (!attr) return false;
    const value = element.getAttribute(attr[1]);
    if (not === null && attr[2] === undefined) {
      if (value === null) return false;
    } else if (attr[2] !== undefined && String(value) !== attr[2]) {
      return false;
    }
    rest = rest.slice(attr[0].length);
  }
  return true;
}

/** @param {string} tag @param {Record<string, any>} [attrs] @param {any[]} [children] */
function makeElement(tag, attrs = {}, children = []) {
  /** @type {any} */
  const element = {
    tagName: tag,
    attributes: { ...attrs },
    children: [],
    parentNode: null,
    disabled: attrs.disabled === true,
    tabIndex: attrs.tabindex === "-1" ? -1 : 0,
    textContent: attrs.__text ?? "",
    /** @param {any} child */
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    /** @param {string} name */
    getAttribute(name) {
      return Object.hasOwn(element.attributes, name) ? String(element.attributes[name]) : null;
    },
    /** @param {string} name @param {any} value */
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    /**
     * 注意：真实 DOM 的 activeElement 落在 document 上；桩里由 documentElement 记录。
     * @this {any}
     */
    focus() {
      if (typeof documentElement === "object" && documentElement !== null) {
        documentElement.activeElement = element;
      }
    },
    /** @param {any} node */
    contains(node) {
      let current = node;
      while (current) {
        if (current === element) return true;
        current = current.parentNode;
      }
      return false;
    },
    /** @param {string} selector */
    /** @param {string} selector */
    querySelectorAll(selector) {
      /** @type {any[]} */
      const out = [];
      const walk = (/** @type {any} */ node) => {
        for (const child of node.children || []) {
          if (matchesSelector(child, selector)) out.push(child);
          walk(child);
        }
      };
      walk(element);
      return out;
    },
    /** @param {string} selector */
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] ?? null;
    },
  };
  for (const child of children) element.appendChild(child);
  return element;
}

/** 当前 fake document（hook 里直接读全局 `document`）。 */
/** @type {any} */ let documentElement = null;

/**
 * @param {any[]} roots
 * @returns {any}
 */
function makeDocument(roots) {
  /** @type {Map<string, any[]>} */
  const listeners = new Map();
  const doc = {
    activeElement: null,
    hidden: false,
    head: makeElement("head"),
    body: makeElement("body"),
    /** @param {string} type @param {any} handler */
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    /** @param {string} type @param {any} handler */
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      listeners.set(
        type,
        list.filter((item) => item !== handler),
      );
    },
    /** @param {string} type @param {any} event */
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) handler(event);
    },
    /** @param {string} selector */
    /** @param {string} selector */
    querySelector(selector) {
      for (const root of roots) {
        if (matchesSelector(root, selector)) return root;
        const found = root.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    /** @param {string} selector */
    querySelectorAll(selector) {
      /** @type {any[]} */
      const out = [];
      for (const root of roots) {
        if (matchesSelector(root, selector)) out.push(root);
        out.push(...root.querySelectorAll(selector));
      }
      return out;
    },
    /** @param {string} tag */
    /** @param {string} tag */
    createElement(tag) {
      return makeElement(tag);
    },
  };
  return doc;
}

/* ------------------------------------------------------------------ */
/* 载入真实 client.js                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {any} fakeDocument
 * @returns {Promise<{exports: any, effects: {cleanups: Function[]}}>}
 */
async function loadClient(fakeDocument) {
  const source = await readFile(CLIENT_URL, "utf8");
  /** @type {any} */
  let definition;
  /** @type {{cleanups: Function[]}} */
  const effects = { cleanups: [] };
  const react = {
    /** @param {any} type @param {any} props @param {...any} children */
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children }, children };
    },
    /** @param {any} initial */
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    /** @param {any} effect */
    useEffect(effect) {
      const cleanup = effect();
      if (typeof cleanup === "function") effects.cleanups.push(cleanup);
      return undefined;
    },
    /** @param {any} callback */
    useCallback(callback) {
      return callback;
    },
    /** @param {any} initial */
    useRef(initial) {
      return { current: initial };
    },
    /** @param {any} initial */
    useMemo(initial) {
      return typeof initial === "function" ? initial() : initial;
    },
  };
  const window = {
    __ModuleLoader__: {
      /** @param {any} input */
      load(input) {
        definition = input;
      },
    },
    location: { search: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  const context = vm.createContext({
    window,
    console,
    document: fakeDocument,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.reject(new Error("no network in unit test")),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Promise,
    Intl,
    AbortController,
  });
  vm.runInContext(source, context, { filename: "client.js" });
  assert.ok(definition, "client.js 必须调用 window.__ModuleLoader__.load");
  assert.equal(definition.id, PACKAGE_ID);
  const exports = definition.factory((/** @type {string} */ id) => {
    assert.equal(id, "react", "client.js 只应 require react");
    return react;
  });
  assert.ok(exports?.__test, "client.js 必须暴露 exports.__test 供单测使用");
  return { exports, effects };
}

/** 所有已加载 client 的 cleanups 都跑一遍，避免用例互相串。 */
/**
 * @param {any} fakeDocument
 * @param {(api: any, effects: {cleanups: Function[]}) => any} run
 */
async function withClient(fakeDocument, run) {
  documentElement = fakeDocument;
  const loaded = await loadClient(fakeDocument);
  try {
    await run(loaded.exports.__test, loaded.effects);
  } finally {
    for (const cleanup of loaded.effects.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* 清理失败不影响断言结果 */
      }
    }
    documentElement = null;
  }
}

/* ------------------------------------------------------------------ */
/* AUD-projects-ui-01：IME 合成中的 Enter 不发送                        */
/* ------------------------------------------------------------------ */

test("AUD-01：IME 合成中的 Enter 一律 noop（isComposing / nativeEvent / keyCode 229 / ref 标记）", async () => {
  await withClient(makeDocument([]), (api) => {
    // 纯函数：三种浏览器差异都要挡住
    assert.equal(api.isImeConfirmKey({ isComposing: true }), true);
    assert.equal(api.isImeConfirmKey({ nativeEvent: { isComposing: true } }), true);
    assert.equal(api.isImeConfirmKey({ keyCode: 229 }), true);
    assert.equal(api.isImeConfirmKey({ which: 229 }), true);
    assert.equal(api.isImeConfirmKey({ key: "Process" }), true);
    assert.equal(api.isImeConfirmKey({ key: "Enter" }, { active: true }), true);
    assert.equal(api.isImeConfirmKey({ key: "Enter", isComposing: false }), false);

    // 意图：合成中连 slash 菜单的 Enter 都不能执行
    assert.equal(api.composerKeyIntent("Enter", { composing: true }), "noop");
    assert.equal(api.composerKeyIntent("Enter", { composing: true, slashOpen: true }), "noop");
    assert.equal(api.composerKeyIntent("ArrowDown", { composing: true, slashOpen: true }), "noop");
    // 正常路径保持不变
    assert.equal(api.composerKeyIntent("Enter", { composing: false }), "send");
    assert.equal(api.composerKeyIntent("Enter", { slashOpen: true }), "slashRun");
    assert.equal(api.composerKeyIntent("ArrowDown", { slashOpen: true }), "slashNext");
    assert.equal(api.composerKeyIntent("ArrowUp", { slashOpen: true }), "slashPrev");
    assert.equal(api.composerKeyIntent("Escape", { slashOpen: true }), "slashClose");
    assert.equal(api.composerKeyIntent("a", { slashOpen: true }), "noop");
  });
});

test("AUD-01：composer 输入框接了 composition 事件与 IME 守卫（接线守卫）", async () => {
  const source = await readFile(CLIENT_URL, "utf8");
  assert.match(source, /onCompositionStart:/u);
  assert.match(source, /onCompositionEnd:/u);
  assert.match(source, /isImeConfirmKey\(event, imeStateRef\.current\)/u);
  assert.match(source, /composerKeyIntent\(event\.key/u);
});

test("AUD-01/A4：其余 8 个 Enter 提交输入框也接了 IME 守卫（复审 A4 回归）", async () => {
  const source = await readFile(CLIENT_URL, "utf8");
  // 锚点 → 该输入框 Enter 触发的提交动作。steer / route 会真的发消息 / 起协调者回合，
  // IME 上词被当成 Enter 的代价与 composer 同级，所以这 8 处必须复用同一个判断。
  /** @type {[string, string][]} */
  const inputs = [
    ["data-projects-create-input", "submit()"],
    ["data-projects-new-dir", "addDir()"],
    ["data-projects-new-repo", "addRepo()"],
    ["data-projects-library-search", "runSearch()"],
    ["data-projects-thread-steer-input", "steerThreadNow("],
    ["data-projects-memory-append-input", "appendMemoryLine()"],
    ["data-projects-route-input", "dispatchRoute()"],
    ["data-projects-dir-input", "submitDir()"],
  ];
  for (const [anchor, action] of inputs) {
    const at = source.indexOf(`"${anchor}"`);
    assert.ok(at >= 0, `缺少输入框锚点 ${anchor}`);
    // 输入框的 props 里锚点在 onKeyDown 之前；取足够长的一段把 handler 包进来。
    const chunk = source.slice(at, at + 1400);
    const handlerAt = chunk.indexOf("onKeyDown:");
    assert.ok(handlerAt >= 0, `${anchor} 的输入框没有 onKeyDown`);
    const handler = chunk.slice(handlerAt);
    assert.ok(handler.includes(action), `${anchor} 的 Enter 提交动作 ${action} 不见了`);
    const enterAt = handler.indexOf('event.key === "Enter"');
    assert.ok(enterAt >= 0, `${anchor} 的 onKeyDown 里找不到 Enter 分支`);
    assert.match(
      handler.slice(0, enterAt),
      /if \(isImeConfirmKey\(event\)\) return;/u,
      `${anchor} 的 Enter 提交前没有 isImeConfirmKey 守卫（IME 上词会误提交）`,
    );
  }
});

test("A3：目录超限 toast 传齐两个占位符（{count} + {used}），不再渲染裸占位符", async () => {
  const source = await readFile(CLIENT_URL, "utf8");
  const calls = [...source.matchAll(/text\(t, "detail\.dirLimit", \{[\s\S]{0,240}?\}\)/gu)];
  // 两处：详情页输入框旁的上限提示行 + 超限 toast。
  assert.equal(calls.length, 2, `detail.dirLimit 的调用点数量变了：${calls.length}`);
  for (const call of calls) {
    assert.match(call[0], /count:/u, `缺少 count 参数：${call[0]}`);
    assert.match(call[0], /used:/u, `缺 used 参数会渲染出裸 {used}：${call[0]}`);
  }
});

/* ------------------------------------------------------------------ */
/* AUD-projects-ui-04/05/16/19 + 07：弹层焦点契约（真实行为）           */
/* ------------------------------------------------------------------ */

/**
 * 搭一个「打开 → 弹层 → 关闭」的 DOM：opener 在背景，dialog 里有三个可聚焦元素。
 * @returns {{doc: any, opener: any, first: any, last: any, input: any, dialog: any}}
 */
function modalFixture() {
  const opener = makeElement("button", { "data-panel-settings-open": "", __text: "⚙" });
  const first = makeElement("button", { "data-modal-autofocus": "", __text: "关闭" });
  const input = makeElement("input", { __text: "" });
  const last = makeElement("button", { __text: "确定" });
  const dialog = makeElement(
    "div",
    { "data-projects-firstrun-dialog": "", role: "dialog", "aria-modal": "true" },
    [first, input, last],
  );
  const background = makeElement("button", { "data-projects-background": "", __text: "背景" });
  const doc = makeDocument([opener, background, dialog]);
  return { doc, opener, first, last, input, dialog };
}

test("AUD-04/16/19：弹层打开时接管初始焦点，Esc 关闭，关闭后焦点归还", async () => {
  const fixture = modalFixture();
  /** @type {string[]} */
  const closed = [];
  await withClient(fixture.doc, (api, effects) => {
    fixture.doc.activeElement = fixture.opener;
    api.useModalLayer({
      open: true,
      selector: "[data-projects-firstrun-dialog]",
      onClose: () => closed.push("esc"),
      restoreSelector: "[data-panel-settings-open]",
    });
    // 打开即聚焦 [data-modal-autofocus]（不是 BODY、也不是背景）
    assert.equal(fixture.doc.activeElement, fixture.first, "初始焦点应落在 data-modal-autofocus");
    assert.equal(effects.cleanups.length, 1, "应挂了一个 document 级监听");

    // Esc 关闭（document 级 capture 生效）
    let prevented = false;
    fixture.doc.dispatch("keydown", {
      key: "Escape",
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    });
    assert.deepEqual(closed, ["esc"]);
    assert.equal(prevented, true);
  });
  // withClient 退出时会执行 cleanup：焦点回到 opener
  assert.equal(fixture.doc.activeElement, fixture.opener, "关闭后焦点应归还触发按钮");
});

test("AUD-05：Tab / Shift+Tab 在弹层内循环，不会跑到背景控件", async () => {
  const fixture = modalFixture();
  await withClient(fixture.doc, (api) => {
    api.useModalLayer({
      open: true,
      selector: "[data-projects-firstrun-dialog]",
      onClose: () => {},
    });
    let prevented = 0;
    /** @param {boolean} shift */
    const tab = (shift) =>
      fixture.doc.dispatch("keydown", {
        key: "Tab",
        shiftKey: shift,
        preventDefault: () => {
          prevented += 1;
        },
        stopPropagation: () => {},
      });

    // 焦点在最后一个 → Tab 回到第一个
    fixture.doc.activeElement = fixture.last;
    tab(false);
    assert.equal(fixture.doc.activeElement, fixture.first);
    assert.equal(prevented, 1);

    // 焦点在第一个 → Shift+Tab 去最后一个
    fixture.doc.activeElement = fixture.first;
    tab(true);
    assert.equal(fixture.doc.activeElement, fixture.last);
    assert.equal(prevented, 2);

    // 焦点意外跑到背景：下一次 Tab 先拉回弹层
    fixture.doc.activeElement = makeElement("button", { "data-projects-background": "" });
    tab(false);
    assert.equal(fixture.doc.activeElement, fixture.first);
    assert.equal(prevented, 3);
  });
});

test("AUD-04/05/16：弹层关闭（open=false）时不挂监听、不抢焦点", async () => {
  const fixture = modalFixture();
  const active = fixture.opener;
  fixture.doc.activeElement = active;
  await withClient(fixture.doc, (api, effects) => {
    api.useModalLayer({
      open: false,
      selector: "[data-projects-firstrun-dialog]",
      onClose: () => {},
    });
    assert.equal(effects.cleanups.length, 0, "关闭状态不应注册 document 监听");
    assert.equal(fixture.doc.activeElement, active, "关闭状态不应移动焦点");
  });
});

/* ------------------------------------------------------------------ */
/* AUD-projects-ui-10：ARIA tabs 的方向键 + roving tabindex             */
/* ------------------------------------------------------------------ */

test("AUD-10：tabListKeyDown 左右移动选中项并把焦点交给新页签", async () => {
  const tabs = [
    makeElement("button", { "data-projects-tab": "threads" }),
    makeElement("button", { "data-projects-tab": "library" }),
    makeElement("button", { "data-projects-tab": "routines" }),
    makeElement("button", { "data-projects-tab": "views" }),
  ];
  const doc = makeDocument(tabs);
  /** @type {string[]} */
  const selected = [];
  await withClient(doc, async (api) => {
    const handler = api.tabListKeyDown(
      ["threads", "library", "routines", "views"],
      "threads",
      (/** @type {string} */ next) => selected.push(next),
      "data-projects-tab",
    );
    let prevented = false;
    handler({
      key: "ArrowRight",
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.deepEqual(selected, ["library"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(doc.activeElement, tabs[1], "焦点应移动到下一个页签");

    // 左方向键从第一个回到最后一个（环形）
    handler({
      key: "ArrowLeft",
      preventDefault: () => {},
    });
    assert.deepEqual(selected, ["library", "views"]);
    // 非方向键不拦截
    let untouched = true;
    handler({
      key: "Enter",
      preventDefault: () => {
        untouched = false;
      },
    });
    assert.equal(untouched, true);
  });
});

/* ------------------------------------------------------------------ */
/* AUD-projects-ui-06 / 08 / USIM-U1-03 / U2-09：纯函数                 */
/* ------------------------------------------------------------------ */

test("AUD-06：files.partial 会翻译成「部分目录未列出」并带上已列/总目录数", async () => {
  await withClient(makeDocument([]), (api) => {
    const t = (/** @type {string} */ key) =>
      key === "library.filesPartial"
        ? "部分目录未列出：预算用尽，已列出 {listed}/{total} 个目录。"
        : key;
    assert.equal(
      api.libraryFilesPartialNote(t, { partial: true, dirs: [{}, {}] }, 5),
      "部分目录未列出：预算用尽，已列出 2/5 个目录。",
    );
    assert.equal(api.libraryFilesPartialNote(t, { partial: false, dirs: [] }, 5), "");
    assert.equal(api.libraryFilesPartialNote(t, null, 5), "");
  });
});

test("AUD-08 / USIM-U1-03：预算摘要用人类标签（不是 maxThreadsPerDay 这种键名）", async () => {
  /** @type {Record<string, string>} */
  const zh = {
    "settings.budgetShort.maxThreadsPerDay": "日线程 {value}",
    "settings.budgetShort.maxConcurrent": "并发 {value}",
    "settings.budgetShort.maxStepsPerThread": "步数 {value}",
    "settings.budgetShort.dailyTokens": "日 token {value}",
    "settings.budgetShort.weeklyTokens": "周 token {value}",
    "settings.budgetUnlimited": "不限",
    "settings.budgetSummary": "预算：{summary}",
  };
  const t = (/** @type {string} */ key) => zh[key];
  await withClient(makeDocument([]), (api) => {
    const keys = [
      "maxThreadsPerDay",
      "maxConcurrent",
      "maxStepsPerThread",
      "dailyTokens",
      "weeklyTokens",
    ];
    const line = api.budgetSummaryLine(
      t,
      { maxThreadsPerDay: 20, maxConcurrent: 2, maxStepsPerThread: 60 },
      keys,
    );
    assert.equal(line, "预算：日线程 20 · 并发 2 · 步数 60 · 日 token 不限 · 周 token 不限");
    assert.equal(line.includes("maxThreadsPerDay"), false, "界面不能出现配置键名");
    assert.equal(
      api.budgetSummaryLine(t, null, keys),
      "预算：日线程 不限 · 并发 不限 · 步数 不限 · 日 token 不限 · 周 token 不限",
    );
  });
});

test("USIM-U2-09：目录校验与服务端同口径（绝对路径、无 .. 段）", async () => {
  await withClient(makeDocument([]), (api) => {
    assert.equal(api.isSafeDirPath("/Users/me/work"), true);
    assert.equal(api.isSafeDirPath("relative/path"), false);
    assert.equal(api.isSafeDirPath(""), false);
    assert.equal(api.isSafeDirPath("/tmp/../etc"), false);
    assert.equal(api.isSafeDirPath("/tmp/ok/../etc"), false);
    assert.equal(api.isSafeDirPath("/tmp/ok"), true);
  });
});

/* ------------------------------------------------------------------ */
/* AUD-projects-ui-15：产物 Markdown 解析（客户端那份）                  */
/* ------------------------------------------------------------------ */

const ARTIFACT_FIXTURE = [
  "# 标题",
  "",
  "第一段第一行",
  "第一段第二行",
  "",
  "- 未完成项",
  "- [x] 已完成项",
  "",
  "| 名称 | 数量 |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "```js",
  "const x = 1;",
  "console.log(x);",
  "```",
].join("\n");

test("AUD-15：client parseArtifactBlocks 与 host parseArtifactMarkdown 同语义", async () => {
  await withClient(makeDocument([]), (api) => {
    const clientBlocks = api.parseArtifactBlocks(ARTIFACT_FIXTURE);
    const hostBlocks = parseArtifactMarkdown(ARTIFACT_FIXTURE);

    // 跨 realm：vm 里创建的数组/对象原型不同，先 JSON 归一化再比。
    /** @param {any} value */
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const normalizedClient = clientBlocks.map((/** @type {any} */ block) => {
      if (block.type === "list") {
        return {
          type: "list",
          paragraphs: block.items.map((/** @type {any} */ item) => item.text),
          checked: block.items.map((/** @type {any} */ item) => item.checked === true),
        };
      }
      if (block.type === "heading")
        return { type: "heading", level: block.level, paragraphs: [block.text] };
      if (block.type === "table")
        return { type: "table", paragraphs: block.header, rows: block.rows };
      if (block.type === "code") return { type: "code", paragraphs: [block.text] };
      return { type: block.type, paragraphs: [block.text] };
    });
    const normalizedHost = plain(hostBlocks).map((/** @type {any} */ block) => {
      if (block.type === "list") {
        return {
          type: "list",
          paragraphs: block.items,
          checked: (block.checked ?? []).map((/** @type {any} */ value) => value === true),
        };
      }
      if (block.type === "heading")
        return { type: "heading", level: block.level, paragraphs: [block.text] };
      if (block.type === "table")
        return { type: "table", paragraphs: block.header, rows: block.rows };
      if (block.type === "code") return { type: "code", paragraphs: [block.text] };
      return { type: block.type, paragraphs: [block.text] };
    });
    assert.deepEqual(plain(normalizedClient), plain(normalizedHost), "两份解析器的块语义必须一致");

    // 基础块类型齐全（标题 / 段落 / 清单 / 表格 / 代码）
    assert.deepEqual(plain(clientBlocks.map((/** @type {any} */ block) => block.type)), [
      "heading",
      "paragraph",
      "list",
      "table",
      "code",
    ]);
    // 勾选状态是真值，不是 `✓/○` 文本（渲染层的职责）
    assert.deepEqual(plain(clientBlocks[2].items.map((/** @type {any} */ item) => item.checked)), [
      false,
      true,
    ]);
  });
});

test("AUD-15：空/异常输入不崩，也不吞内容", async () => {
  await withClient(makeDocument([]), (api) => {
    assert.equal(api.parseArtifactBlocks("").length, 0);
    assert.equal(api.parseArtifactBlocks(null).length, 0);
    // 未闭合代码块也要把内容留下（不静默丢弃）
    const unclosed = api.parseArtifactBlocks("```\n仍然要说的话");
    assert.equal(
      unclosed.some((/** @type {any} */ block) => block.type === "code"),
      true,
    );
    assert.match(
      String(unclosed.find((/** @type {any} */ block) => block.type === "code").text),
      /仍然要说的话/u,
    );
  });
});
