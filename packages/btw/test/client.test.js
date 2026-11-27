// @ts-check
// node:vm 单测：用假 `window.__ModuleLoader__.load` + 假 `require` 加载**真实 client.js**，
// 然后测两件事：
//   A. 纯交互函数（Enter 语义、通知去重/文案、空白会话判定）——USIM-U2-13 / U2-06；
//   B. `apply()` 的接线（通知通道、toast 座位、追问提示）——保证宿主座位一掉就红。
//
// 为什么用 vm 而不是把逻辑复制到 lib/：client 半是 classic script（不能 import），
// 复制一份必然漂移；直接跑源码里的函数才有意义。
// 注意：vm 沙箱里创建的对象/数组原型属于另一个 realm，deepEqual（非 strict）只做结构化比较。
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = fileURLToPath(new URL(".", import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");

/**
 * 在 vm 沙箱里执行 client.js（classic script），返回 factory 产出的 module.exports。
 * @returns {any}
 */
function loadModule() {
  const code = readFileSync(clientPath, "utf8");
  /** @type {any} */
  let captured = null;
  const reactStub = {
    createElement: () => ({ type: "stub" }),
    Fragment: "Fragment",
    useSyncExternalStore: () => undefined,
    useState: (/** @type {any} */ initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (/** @type {any} */ fn) => fn,
    useRef: (/** @type {any} */ initial) => ({ current: initial ?? null }),
    useMemo: (/** @type {any} */ fn) => fn(),
    useLayoutEffect: () => {},
    memo: (/** @type {any} */ component) => component,
  };
  /** @type {any} */
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (/** @type {any} */ options) => {
          captured = options;
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    },
    document: {
      createElement: () => ({
        dataset: {},
        style: {},
        setAttribute: () => {},
        remove: () => {},
      }),
      head: { appendChild: () => {} },
      querySelector: () => null,
      querySelectorAll: () => [],
      getSelection: () => null,
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    console,
    performance: { now: () => 0 },
    setTimeout: (/** @type {any} */ fn, /** @type {any} */ ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    requestAnimationFrame: (/** @type {any} */ fn) => fn,
    cancelAnimationFrame: () => {},
    require: (/** @type {string} */ name) => {
      if (name === "react") return reactStub;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: clientPath });
  assert.ok(captured, "window.__ModuleLoader__.load was not called");
  assert.equal(captured.id, "@kangyishuai/dsh-btw");
  return captured.factory(sandbox.require);
}

const module = loadModule();
const pure = module.__test;

/**
 * 造一个「足够真」的 client ctx：记录每次注册，服务按需注入。
 * @param {{ services?: Record<string, any> }} [options]
 * @returns {{ ctx: any, record: { slotNames: string[], slots: any[], effects: string[], tabs: any[] }, rpcCalls: any[] }}
 */
function makeCtx(options = {}) {
  const services = options.services ?? {};
  /** @type {{ slotNames: string[], slots: any[], effects: string[], tabs: any[] }} */
  const record = { slotNames: [], slots: [], effects: [], tabs: [] };
  /** @type {any[]} */
  const rpcCalls = [];
  const ctx = {
    effect(/** @type {any} */ fn, /** @type {string} */ label) {
      record.effects.push(String(label));
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    locale: {
      register: () => () => {},
      bind: () => (/** @type {string} */ key) => key,
    },
    slots: {
      inject(/** @type {string} */ name, /** @type {any} */ factory) {
        record.slotNames.push(name);
        return factory();
      },
      register(/** @type {any} */ entry, /** @type {any} */ component) {
        record.slots.push({ entry, component });
        return () => {};
      },
    },
    get(/** @type {string} */ name) {
      return services[name];
    },
    inject(/** @type {string[]} */ deps, /** @type {any} */ callback) {
      const first = deps[0];
      if (services[first] === undefined) return;
      callback({ [first]: services[first] });
    },
    logger: { info: () => {}, warn: () => {} },
    connection: {
      rpc: {
        call(
          /** @type {string} */ channel,
          /** @type {string} */ method,
          /** @type {any} */ payload,
        ) {
          rpcCalls.push({ channel, method, payload });
          return Promise.resolve({ value: null });
        },
      },
    },
  };
  return { ctx, record, rpcCalls };
}

// --- A. 纯交互函数 ---------------------------------------------------------

test("client Enter 语义：Enter 发送、Shift+Enter 换行、输入法组字中绝不发送", () => {
  assert.equal(typeof pure.shouldSubmitOnKey, "function", "client 必须导出 shouldSubmitOnKey");
  const enter = { key: "Enter", shiftKey: false };
  assert.equal(pure.shouldSubmitOnKey(enter), true, "普通 Enter 应发送（USIM-U2-13）");
  assert.equal(
    pure.shouldSubmitOnKey({ key: "Enter", shiftKey: true }),
    false,
    "Shift+Enter 必须换行而不是发送",
  );
  assert.equal(pure.shouldSubmitOnKey({ key: "Enter", metaKey: true }), true, "⌘↩ 保持可用");
  assert.equal(pure.shouldSubmitOnKey({ key: "Enter", ctrlKey: true }), true, "Ctrl+↩ 保持可用");
  assert.equal(pure.shouldSubmitOnKey({ key: "a" }), false);
  assert.equal(pure.shouldSubmitOnKey(undefined), false);
  assert.equal(pure.shouldSubmitOnKey(null), false);
  // 中文输入法选词时按 Enter 是「确认候选」，不能被当成发送。
  assert.equal(pure.shouldSubmitOnKey({ key: "Enter", isComposing: true }), false);
  assert.equal(pure.shouldSubmitOnKey({ key: "Enter", keyCode: 229 }), false);
  // 复审 B2：React 合成事件不保证暴露 isComposing，四条判据要与 projects 对齐。
  assert.equal(
    pure.shouldSubmitOnKey({ key: "Enter", nativeEvent: { isComposing: true } }),
    false,
    "nativeEvent.isComposing 也要挡住",
  );
  assert.equal(pure.shouldSubmitOnKey({ key: "Enter", which: 229 }), false, "which=229 旧 IME");
  assert.equal(pure.shouldSubmitOnKey({ key: "Process" }), false, "IE/旧 Edge 的 Process 键");
  assert.equal(
    pure.shouldSubmitOnKey({ key: "Enter" }, { active: true }),
    false,
    "composition 期间的 ref 标记也要挡住",
  );
  assert.equal(pure.shouldSubmitOnKey({ key: "Enter" }, { active: false }), true);
});

test("client 通知：首帧只建基线（不回放旧通知），进行中的仍提示", () => {
  assert.equal(typeof pure.planNotice, "function", "client 必须导出 planNotice");
  const running = { seq: 7, state: "running" };
  const done = { seq: 8, state: "done", ms: 4200, preview: "旁问只读" };
  const first = pure.planNotice(undefined, running);
  assert.equal(first.seq, 7);
  assert.equal(first.show, true, "挂载时正在进行的那次旁问要提示（它不是历史回放）");
  const baselineDone = pure.planNotice(undefined, done);
  assert.equal(baselineDone.seq, 8);
  assert.equal(baselineDone.show, false, "重开页面时不要把旧的完成通知再弹一遍");
  // 去重：同一个 seq 轮询多次只处理一次
  assert.equal(pure.planNotice(8, done).show, false);
  assert.equal(pure.planNotice(8, done).seq, 8);
  // 新通知正常出现
  assert.equal(pure.planNotice(8, { seq: 9, state: "error", text: "超时" }).show, true);
  // 畸形/负数 seq 不推进基线，也不弹
  assert.equal(pure.planNotice(8, { seq: "x", state: "done" }).show, false);
  assert.equal(pure.planNotice(8, { seq: -1, state: "done" }).show, false);
  assert.equal(pure.planNotice(8, null).show, false);
  // 首轮轮询是 null 时基线记 0：之后「开始→立刻失败」（完成得比首轮还快）仍然要弹，
  // 否则快速失败会像 U2-06 一样静默。
  assert.equal(pure.planNotice(0, { seq: 1, state: "error", text: "x" }).show, true);
  assert.equal(pure.planNotice(0, { seq: 1, state: "done" }).show, true);
});

test("client 通知文案：进行中常驻、完成带耗时与预览、失败带原因", () => {
  assert.equal(typeof pure.composeNoticeToast, "function", "client 必须导出 composeNoticeToast");
  const a = pure.composeNoticeToast(
    { seq: 1, state: "running" },
    (/** @type {string} */ key) => pure.messages.zh[key],
  );
  assert.equal(a.tone, "info");
  assert.match(a.text, /已提交/u);
  assert.equal(a.autoHideMs, 0, "进行中的提示不能自己消失（等待期间必须一直可见）");

  const b = pure.composeNoticeToast(
    { state: "done", ms: 4200, preview: "旁问只读，主线可干活" },
    (/** @type {string} */ key) => pure.messages.zh[key],
  );
  assert.equal(b.tone, "ok");
  assert.match(b.text, /4\.2s/u, "完成提示要带耗时");
  assert.match(b.text, /旁问只读/u, "完成提示要带答案预览");
  assert.ok(b.autoHideMs > 0, "完成提示会自动消失");

  const c = pure.composeNoticeToast(
    { state: "error", text: "旁问超时，没有得到答案。" },
    (/** @type {string} */ key) => pure.messages.zh[key],
  );
  assert.equal(c.tone, "error");
  assert.match(c.text, /超时/u, "失败提示必须带宿主给的原因");
  // 没有答案预览时用纯耗时文案兜底，且不留未替换的占位符
  const noPreview = pure.composeNoticeToast(
    { state: "done", ms: 1000, preview: "" },
    (/** @type {string} */ key) => pure.messages.zh[key],
  );
  assert.match(noPreview.text, /1s/u);
  assert.ok(!noPreview.text.includes("{preview}"), noPreview.text);
  assert.equal(
    pure.composeNoticeToast({ state: "unknown" }, () => "x"),
    null,
  );
});

test("client 终态回执：面板已显示答案时必须撤掉常驻「等待中」提示", () => {
  assert.equal(typeof pure.noticeAction, "function", "client 必须导出 noticeAction");
  const running = { state: "running" };
  const done = { state: "done", ms: 1000 };
  const error = { state: "error", text: "超时" };
  // 不是新回执：不动
  assert.equal(pure.noticeAction(done, false, false), "none");
  assert.equal(pure.noticeAction(null, true, false), "none");
  // 面板没开：三态都弹（完成/失败替换「等待中」提示）
  assert.equal(pure.noticeAction(running, true, false), "show");
  assert.equal(pure.noticeAction(done, true, false), "show");
  assert.equal(pure.noticeAction(error, true, false), "show");
  // 面板已开：答案就地可见，running/done 不再叠 toast，但要撤掉常驻提示；
  // 失败仍弹（面板里没有错误展示位）。
  assert.equal(pure.noticeAction(running, true, true), "dismiss");
  assert.equal(pure.noticeAction(done, true, true), "dismiss");
  assert.equal(pure.noticeAction(error, true, true), "show");
});

test("client 空白会话判定：只有 hero/blank 且没有任何对话节点才算空白", () => {
  assert.equal(typeof pure.isBlankConversation, "function");
  assert.equal(pure.isBlankConversation({ phase: "hero", chatRows: 0 }), true);
  assert.equal(pure.isBlankConversation({ phase: "", chatRows: 0 }), true);
  assert.equal(pure.isBlankConversation({ phase: "active", chatRows: 2 }), false);
  assert.equal(pure.isBlankConversation({ phase: "active", chatRows: 0 }), false);
  assert.equal(pure.isBlankConversation({ phase: "hero", chatRows: 1 }), false);
  assert.equal(
    pure.isBlankConversation({ phase: "engaging", chatRows: 0 }),
    false,
    "首回合提交中不算空白（命令卡片随后就会渲染）",
  );
  assert.equal(pure.isBlankConversation({}), true);
  assert.equal(pure.isBlankConversation(null), true);
});

// --- 复审 B1：回退抽屉必须真的能渲染出来 -----------------------------------

test("client 回退抽屉判定：tabReady 时也能因为「这次打开失败」落到抽屉（复审 B1）", () => {
  assert.equal(typeof pure.shouldRenderDrawer, "function", "client 必须导出 shouldRenderDrawer");
  assert.equal(
    pure.shouldRenderDrawer({ open: true, drawerFallback: true }, true),
    true,
    "B1 的 bug：tabReady 为 true 时抽屉也要能渲染，否则降级路径上用户什么都看不到",
  );
  assert.equal(
    pure.shouldRenderDrawer({ open: true }, true),
    false,
    "正常打开 tab 时不重复渲染抽屉",
  );
  assert.equal(
    pure.shouldRenderDrawer({ open: true }, false),
    true,
    "没有右侧栏服务时抽屉是唯一形态",
  );
  assert.equal(
    pure.shouldRenderDrawer({ open: false, drawerFallback: true }, true),
    false,
    "关掉就是关掉",
  );
  assert.equal(pure.shouldRenderDrawer(null, false), false);
  assert.equal(pure.shouldRenderDrawer(undefined, true), false);
});

test("client 回退抽屉：openTab 抛错立刻落抽屉，700ms 后没面板也落抽屉（复审 B1 行为）", async () => {
  // 场景 1：右栏服务在、openTab 抛错 → 以前只 patch open:true，而抽屉要求 !tabReady，
  // 于是「回退」永远渲染不出东西；现在必须落到抽屉。
  const failing = makeCtx({
    services: {
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: {
        openTab: () => {
          throw new Error("openTab boom");
        },
      },
    },
  });
  assert.doesNotThrow(() => module.apply(failing.ctx));
  const hooks = module.__test.hooks;
  assert.ok(hooks, "client 必须导出单测钩子（回退抽屉行为只能驱动真实 apply）");
  assert.equal(hooks.store.get().open, false, "初始不显示面板");
  hooks.revealPanel();
  const afterThrow = hooks.store.get();
  assert.equal(afterThrow.open, true, "openTab 抛错后要打开回退抽屉");
  assert.equal(hooks.store.get().drawerFallback, true, "必须显式打降级标记（tabReady 仍是 true）");
  assert.equal(
    pure.shouldRenderDrawer(afterThrow, true),
    true,
    "降级路径上抽屉必须真的渲染（这正是复审 B1 的死代码）",
  );

  // 场景 2：openTab 成功但宿主没渲染 tab → 700ms 后落抽屉；随后打开成功要清掉降级标记。
  const working = makeCtx({
    services: {
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { openTab: () => {} },
      layout: { openRightbar: () => {} },
    },
  });
  assert.doesNotThrow(() => module.apply(working.ctx));
  const hooks2 = module.__test.hooks;
  hooks2.revealPanel();
  assert.equal(hooks2.store.get().open, false, "openTab 成功时先等 tab 渲染，不立刻开抽屉");
  // vm 沙箱的 document.querySelector 恒为 null，等价于「700ms 后仍然没有面板」。
  await new Promise((/** @type {any} */ done) => setTimeout(done, 900));
  const afterTimeout = hooks2.store.get();
  assert.equal(afterTimeout.open, true, "700ms 后仍没有 [data-btw-panel] 就落抽屉");
  assert.equal(pure.shouldRenderDrawer(afterTimeout, true), true, "超时降级同样要真的渲染");
  // 右栏恢复后重新打开：清掉降级标记并收起抽屉，避免 tab + 抽屉两套面板同时在场。
  hooks2.revealPanel();
  assert.equal(hooks2.store.get().drawerFallback, false, "openTab 成功后必须清掉降级标记");
  assert.equal(hooks2.store.get().open, false, "tab 打开时抽屉要收起");
});

test("client 回退抽屉：BtwDrawer 的渲染判定与打开降级共用同一实现（防漂移）", () => {
  const source = readFileSync(clientPath, "utf8");
  assert.ok(
    source.includes("shouldRenderDrawer(shared, tabReady)"),
    "BtwDrawer 必须走 shouldRenderDrawer（否则行为测试与实现漂移，B1 会再退化成死代码）",
  );
  assert.equal(
    (source.match(/drawerFallback: true/gu) ?? []).length,
    3,
    "三条降级入口（立即回退 / 700ms 超时 / 按钮打开失败）都要打 drawerFallback",
  );
});

test("client 中英字典键集一一对应（新增通知/输入提示键不能只加一份）", () => {
  const zh = pure.messages.zh;
  const en = pure.messages.en;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh/en 键集必须一一对应");
  // U2-13：追问发送按钮不能再和线程头的「追问」同名。
  assert.notEqual(zh.followSend, zh.followUp, "发送按钮应叫「发送」，不是第二个「追问」");
  assert.notEqual(en.followSend, en.followUp);
  assert.match(zh.inputHint, /Enter/u);
  assert.match(zh.inputHint, /Shift/u);
  assert.match(en.inputHint, /Enter/u);
  assert.match(en.inputHint, /Shift/u);
  // U2-06：通知文案三态齐备。
  for (const key of ["notice.running", "notice.done", "notice.doneWithPreview", "notice.error"]) {
    assert.equal(typeof zh[key], "string", `zh 缺 ${key}`);
    assert.equal(typeof en[key], "string", `en 缺 ${key}`);
  }
  // 空态要解释「旁问是什么」，不能只写「还没有」。
  assert.match(zh.empty, /只读/u);
  assert.match(zh.empty, /不.*(打断|写进)/u);
  assert.match(en.empty, /read-only/u);
});

// --- B. 接线 ---------------------------------------------------------------

test("client 接线：通知/面板座位、追问与设置分节都注册到了宿主扩展点", () => {
  const { ctx, record } = makeCtx({
    services: {
      sidebarRightTabs: {
        register: (/** @type {any} */ entry) => {
          record.tabs.push(entry);
          return () => {};
        },
      },
    },
  });
  assert.doesNotThrow(() => module.apply(ctx));
  const slotNames = record.slots.map((/** @type {any} */ row) => row.entry.name);
  for (const name of [
    "shell.overlay",
    "conversation.input.left",
    "sidebar.right.pane.tab",
    "settings.section",
  ]) {
    assert.ok(slotNames.includes(name), `缺少座位 ${name}: ${slotNames.join(", ")}`);
  }
  const overlay = record.slots.find((/** @type {any} */ row) => row.entry.name === "shell.overlay");
  assert.equal(overlay.entry.id, "btw-panel");
  assert.equal(record.tabs.length, 1, "侧栏 tab 类型要注册（否则面板退化成浮层）");
  assert.equal(record.tabs[0].kind, "btw");
  assert.equal(record.tabs[0].title(), "title", "title 是 thunk（locale 变化时重取）");
  const settings = record.slots.find(
    (/** @type {any} */ row) => row.entry.name === "settings.section",
  );
  assert.equal(settings.entry.order, 95);
  assert.equal(typeof settings.entry.label, "function");
});

test("client 接线：宿主没有右侧栏服务时不抛（自动退化到浮层抽屉）", () => {
  const { ctx } = makeCtx();
  assert.doesNotThrow(() => module.apply(ctx));
});

test("client 接线：通知与追问提示的元素锚点在源码里（冒烟与桌面回归靠 data-* 定位）", () => {
  const source = readFileSync(clientPath, "utf8");
  for (const anchor of [
    '"data-btw-toast-tray": "true"',
    '"data-btw-toast": tone',
    '"data-btw-input-hint": "true"',
  ]) {
    assert.ok(source.includes(anchor), `缺少锚点 ${anchor}`);
  }
  // 通知通道：轮询 btw/notice（宿主执行 /btw 后写内存回执，client 拉取后给反馈）
  assert.ok(source.includes('callRemote("notice"'), "client 必须轮询 btw/notice");
  // 空白会话才自动打开面板（非空白会话命令卡片自己会渲染，不抢用户的布局）
  assert.ok(source.includes("isBlankConversation("), "自动开面板前必须判空白会话");
  // 两个输入框（新旁问 + 线程追问）共用同一套 Enter 语义
  assert.equal(
    (source.match(/shouldSubmitOnKey\(/gu) ?? []).length >= 2,
    true,
    "两个 textarea 都要用 shouldSubmitOnKey",
  );
  // 复审 B2：合成事件不可靠，两个输入框都要接 composition 事件并把 ref 传进去。
  assert.ok(source.includes("onCompositionStart:"), "输入框要接 compositionstart 维护组字标记");
  assert.ok(source.includes("onCompositionEnd:"), "输入框要接 compositionend 清掉组字标记");
  assert.equal(
    (source.match(/shouldSubmitOnKey\(event, compositionRef\.current\)/gu) ?? []).length,
    2,
    "两个 textarea 都要把 composition ref 传给 shouldSubmitOnKey",
  );
  // 发送中的反馈不能被 live 卡片吞掉：notice 有内容时必须可见
  assert.ok(
    source.includes("statusVisible") && source.includes('notice !== ""'),
    "状态条在 live 卡片存在时也要能显示失败/提示",
  );
});

test("client 接线：转正草稿按行数预算（不回归 0.6.1 的修复）", () => {
  const source = readFileSync(clientPath, "utf8");
  assert.ok(source.includes("fitDraftToLines(full"), "promote 必须用 fitDraftToLines");
  assert.ok(source.includes("promotedShort"));
});
