// @ts-check
// client.js 的「接线」测试：不渲染 React，只验证 apply() 把东西注册到了正确的宿主扩展点上。
//
// 为什么需要这一层：菜单/快捷键/设置页都是**可降级**的扩展点，最危险的回归是
// 「某天 ctx.contextMenus 不可用 → 插件整个不激活」或者「快捷键注册抛错 → 菜单也没了」。
// GUI 冒烟能看见结果，但只有这一层能在 CI 里锁住「降级路径本身」。
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "..", "lib", "client.js");

/**
 * 在 vm 里加载 client.js 并返回 `exports`。
 * @returns {any}
 */
function loadModule() {
  const code = fs.readFileSync(clientPath, "utf8");
  /** @type {any} */
  let captured = null;
  const reactStub = {
    createElement: () => ({ type: "stub" }),
    Fragment: "Fragment",
    useSyncExternalStore: () => undefined,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (/** @type {any} */ fn) => fn,
    useRef: () => ({ current: null }),
    useMemo: (/** @type {any} */ fn) => fn(),
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
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    console,
    performance: { now: () => 0 },
    // 用真实定时器：菜单降级靠一个宽限期定时器，桩掉它等于测不到那条路径。
    // 但都要 unref —— 插件里的轮询 interval 否则会把 node --test 挂住不退出。
    setTimeout: (/** @type {any} */ fn, /** @type {any} */ ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    setInterval: (/** @type {any} */ fn, /** @type {any} */ ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearInterval,
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
  return captured.factory(sandbox.require);
}

/**
 * 造一个「足够真」的 client ctx：记录每次注册，服务按需注入。
 * @param {{ services?: Record<string, any>, throwOnShortcut?: boolean }} [options]
 */
function makeCtx(options = {}) {
  const services = options.services ?? {};
  /** @type {{ slotNames: string[], slots: any[], menus: any[], shortcuts: any[], effects: string[], warnings: string[] }} */
  const record = { slotNames: [], slots: [], menus: [], shortcuts: [], effects: [], warnings: [] };
  const rpc = {
    call: (/** @type {string} */ _channel, /** @type {string} */ method) => {
      assert.match(method, /^sessionDelete\//u, `unexpected RPC: ${method}`);
      return Promise.resolve({ ok: true, value: null });
    },
  };
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
      // 真宿主里这是「等依赖就绪」；测试里只模拟「已就绪」和「永远不到」两种。
      const first = deps[0];
      if (services[first] === undefined) return;
      callback({ [first]: services[first] });
    },
    logger: {
      info: () => {},
      warn: (/** @type {string} */ message) => record.warnings.push(String(message)),
    },
    connection: { rpc },
  };
  return { ctx, record };
}

/** @param {ReturnType<typeof makeCtx>} made */
function registeredNames(made) {
  return made.record.slots.map((/** @type {any} */ row) => row.entry.name);
}

describe("client wiring: settings section", () => {
  it("registers a settings.section entry so the maintenance UI has a home", () => {
    const made = makeCtx();
    loadModule().apply(made.ctx);
    const settings = made.record.slots.find(
      (/** @type {any} */ row) => row.entry.name === "settings.section",
    );
    assert.ok(settings, `settings.section was not registered: ${registeredNames(made).join(", ")}`);
    assert.equal(settings.entry.id, "session-delete");
    assert.equal(
      typeof settings.entry.label,
      "function",
      "label must be a thunk for locale changes",
    );
    assert.ok(typeof settings.component === "function");
  });
});

describe("client wiring: menus and shortcuts", () => {
  /** @returns {ReturnType<typeof makeCtx>} */
  function withHostMenus() {
    const made = makeCtx({
      services: {
        contextMenus: {
          register(/** @type {any} */ contribution) {
            made.record.menus.push(contribution);
            return () => {};
          },
        },
        shortcuts: {
          register(/** @type {any} */ command) {
            made.record.shortcuts.push(command);
            return () => {};
          },
        },
      },
    });
    return made;
  }

  it("registers official context-menu contributions for both session and workspace targets", () => {
    const made = withHostMenus();
    loadModule().apply(made.ctx);
    const targets = made.record.menus.map((/** @type {any} */ row) => row.target).sort();
    assert.deepEqual(targets, ["session", "workspace"]);
    // 菜单条目必须是数据贡献（有 resolve），不是旧的 slot 组件。
    for (const menu of made.record.menus) {
      assert.equal(typeof menu.resolve, "function", `menu ${menu.id} has no resolve()`);
      assert.equal(typeof menu.order, "number");
    }
    // 有 contextMenus 时不应再注册旧的会话菜单 slot（否则菜单里会出现两行）。
    assert.ok(
      !registeredNames(made).includes("sidebar.workspaces.session.menu.item"),
      "legacy session menu slot must not be registered when contextMenus is available",
    );
  });

  it("menu rows carry the shortcut command id so the host can show keycaps", () => {
    const made = withHostMenus();
    loadModule().apply(made.ctx);
    const sessionMenu = made.record.menus.find(
      (/** @type {any} */ row) => row.target === "session",
    );
    const [action] = sessionMenu.resolve({ sessionId: "s1", displayTitle: "T" });
    assert.equal(action.commandId, "session.delete");
    assert.equal(action.danger, true);
    assert.equal(action.separatorBefore, true);
    assert.equal(typeof action.run, "function");

    const workspaceMenu = made.record.menus.find(
      (/** @type {any} */ row) => row.target === "workspace",
    );
    const [workspaceAction] = workspaceMenu.resolve({
      workspaceId: "ws1",
      path: "/tmp/x",
      displayTitle: "W",
    });
    assert.equal(workspaceAction.commandId, "session.deleteWorkspace");
    assert.equal(typeof workspaceAction.run, "function");
  });

  it("declares a safe shortcut default set: macOS/Windows bound, Linux deliberately unbound", () => {
    const made = withHostMenus();
    loadModule().apply(made.ctx);
    const commands = Object.fromEntries(
      made.record.shortcuts.map((/** @type {any} */ row) => [row.id, row]),
    );
    const deleteCommand = commands["session.delete"];
    assert.ok(deleteCommand, "session.delete was not registered");
    // 宿主会校验所有 runtime × platform 的默认键；Linux 声明了就会让整条 register() 抛错。
    assert.equal(
      Object.keys(deleteCommand.defaults).some((key) => key.endsWith("linux")),
      false,
    );
    assert.deepEqual(deleteCommand.defaults["desktop:macos"], {
      code: "Backspace",
      modifiers: ["primary", "alt"],
    });
    assert.deepEqual(deleteCommand.defaults["web:macos"], {
      code: "Backspace",
      modifiers: ["primary", "alt"],
    });
    // 编辑区也要触发：composer 几乎总是持有焦点，只允许 page 等于按不出来。
    assert.ok(deleteCommand.regions.includes("page"));
    assert.ok(deleteCommand.regions.includes("editable"));
    assert.equal(
      deleteCommand.regions.includes("terminal"),
      false,
      "the terminal keeps its own delete key",
    );

    const workspaceCommand = commands["session.deleteWorkspace"];
    assert.ok(workspaceCommand, "session.deleteWorkspace was not registered");
    assert.deepEqual(
      workspaceCommand.defaults,
      {},
      "workspace-wide deletion must not ship a default key",
    );
  });

  it("blocks the shortcut with a reason when there is no current session", () => {
    const made = withHostMenus();
    loadModule().apply(made.ctx);
    const command = made.record.shortcuts.find(
      (/** @type {any} */ row) => row.id === "session.delete",
    );
    const result = command.resolve({ region: "page", modal: null, target: null });
    assert.equal(result.status, "blocked");
    assert.equal(typeof result.reason, "string");
  });

  it("hands the current session to the confirmation when one is focused", () => {
    const made = makeCtx({
      services: {
        contextMenus: { register: () => () => {} },
        shortcuts: {
          register(/** @type {any} */ command) {
            made.record.shortcuts.push(command);
            return () => {};
          },
        },
        sessions: {
          list: {
            getSnapshot: () => ({
              ids: ["s1", "s2"],
              byId: {
                s1: { id: "s1", displayTitle: "one", retainedBy: {} },
                s2: { id: "s2", displayTitle: "two", retainedBy: { mainView: 1 } },
              },
            }),
          },
        },
      },
    });
    loadModule().apply(made.ctx);
    const command = made.record.shortcuts.find(
      (/** @type {any} */ row) => row.id === "session.delete",
    );
    const result = command.resolve({ region: "page", modal: null, target: null });
    assert.equal(result.status, "handled");
    assert.equal(typeof result.run, "function");
    assert.doesNotThrow(() => result.run());
  });

  it("falls back to the legacy slot when the host has no contextMenus service", async () => {
    const module = loadModule();
    // 老宿主永远不会提供 contextMenus：apply 之后等宽限期过去，必须自己补上旧 slot。
    module.__test.menuFallback.ms = 10;
    const made = makeCtx({ services: { shortcuts: { register: () => () => {} } } });
    module.apply(made.ctx);
    assert.ok(
      !registeredNames(made).includes("sidebar.workspaces.session.menu.item"),
      "the legacy slot must wait for the grace period before taking over",
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(
      registeredNames(made).includes("sidebar.workspaces.session.menu.item"),
      "old hosts lost their delete entry: the legacy slot must be the fallback",
    );
  });

  it("keeps menus working when shortcut registration throws (a key conflict is not fatal)", () => {
    const made = makeCtx({
      services: {
        contextMenus: {
          register(/** @type {any} */ contribution) {
            made.record.menus.push(contribution);
            return () => {};
          },
        },
        shortcuts: {
          register() {
            throw new Error("Conflicting shortcut defaults: session.delete and settings.open");
          },
        },
      },
    });
    assert.doesNotThrow(() => loadModule().apply(made.ctx));
    assert.equal(made.record.menus.length, 2, "a shortcut conflict must not take the menus down");
    assert.ok(
      made.record.warnings.some((message) => message.includes("session.delete")),
      `a swallowed conflict must still be logged: ${made.record.warnings.join(" | ")}`,
    );
  });

  it("keeps the plugin alive when the host has neither contextMenus nor shortcuts", () => {
    const made = makeCtx();
    assert.doesNotThrow(() => loadModule().apply(made.ctx));
    assert.ok(registeredNames(made).includes("sidebar.footer.action"));
    assert.ok(registeredNames(made).includes("shell.overlay"));
    assert.ok(registeredNames(made).includes("settings.section"));
  });
});
