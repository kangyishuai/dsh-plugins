// @ts-check
// client.js 的「接线」测试（审计 USIM-U2-07 / USIM-U2-08）：
// 不渲染 React，只验证 apply() 把东西注册到了正确的宿主扩展点上。
//
// 为什么要这一层：命令卡片、回执、设置徽标都是**可降级**的扩展点，最危险的回归是
// 「某天 conversation.chat.commandview 或 command/executed 不可用 → 插件整个不激活」
// 或「注册抛错 → toast / 设置页也没了」。GUI 冒烟能看见结果，但只有这一层能在 CI 里
// 锁住「注册到了哪个 slot / key」以及「缺服务时的降级路径」。
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
 * 造一个「足够真」的 client ctx：记录每次 slot 注册、effect、事件监听与 RPC 调用。
 * @param {{ on?: boolean, commandUi?: boolean, rpc?: boolean }} [options]
 * @returns {any}
 */
function makeCtx(options = {}) {
  const record = {
    slotNames: /** @type {string[]} */ ([]),
    slots: /** @type {any[]} */ ([]),
    effects: /** @type {string[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    injections: /** @type {string[]} */ ([]),
    decorations: /** @type {any[]} */ ([]),
    rpc: /** @type {any[]} */ ([]),
    warnings: /** @type {string[]} */ ([]),
  };
  /** @type {any} */
  const services = {};
  /** @type {any} */
  const ctx = {
    effect(/** @type {any} */ fn, /** @type {string} */ label) {
      record.effects.push(String(label));
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    on(/** @type {string} */ name, /** @type {any} */ listener) {
      if (options.on === false) throw new Error("ctx.on is not available");
      record.events.push({ name, listener });
      return () => {};
    },
    get(/** @type {string} */ name) {
      return services[name];
    },
    inject(/** @type {string[]} */ names, /** @type {any} */ factory) {
      record.injections.push(names.join(","));
      const scope = Object.assign({}, ctx, { get: ctx.get, effect: ctx.effect });
      if (options.commandUi !== false) {
        scope.commandUi = services.commandUi;
      }
      factory(scope);
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
    connection: {
      rpc: {
        call(
          /** @type {string} */ _channel,
          /** @type {string} */ method,
          /** @type {any} */ payload,
        ) {
          record.rpc.push({ method, payload });
          return Promise.resolve({ ok: true, value: {} });
        },
      },
    },
  };
  if (options.commandUi !== false) {
    services.commandUi = {
      decorate(/** @type {any} */ decoration) {
        record.decorations.push(decoration);
        return () => {};
      },
    };
  }
  if (options.rpc === false) ctx.connection = undefined;
  return { ctx, record };
}

/** @param {any} record @param {string} name */
function slotOf(record, name) {
  return record.slots.filter((/** @type {any} */ slot) => slot.entry.name === name);
}

describe("client wiring: slots", () => {
  it("registers the /advisor command card renderer for its own command name", () => {
    const { ctx, record } = makeCtx();
    loadModule().apply(ctx);
    const commandViews = slotOf(record, "conversation.chat.commandview");
    assert.equal(commandViews.length, 1, "必须注册一个 commandview 渲染器");
    const entry = commandViews[0].entry;
    // 宿主的 keyed 子 slot 用 commands.register() 的命令名作为 entryKey（`CommandNodeView` 传
    // `entryKey: command.name`）。key 对不上就永远走宿主的通用卡片（单行省略号）。
    assert.equal(entry.key, "advisor");
    assert.equal(entry.id, "advisor-command");
    assert.equal(typeof commandViews[0].component, "function");
    // locale 命名空间必须声明，否则组件拿不到 t()。
    assert.equal(entry.locale, "advisor");
  });

  it("keeps the existing surfaces (overlay / settings / turn line) registered", () => {
    const { ctx, record } = makeCtx();
    loadModule().apply(ctx);
    assert.deepEqual(record.slotNames.sort(), [
      "conversation.chat.commandview",
      "conversation.chat.turnTail",
      "settings.section",
      "shell.overlay",
    ]);
    const overlay = slotOf(record, "shell.overlay");
    assert.equal(overlay[0].entry.id, "advisor");
    const settings = slotOf(record, "settings.section");
    assert.equal(settings[0].entry.order, 92);
    const tail = slotOf(record, "conversation.chat.turnTail");
    assert.equal(tail[0].entry.id, "advisor-turn-line");
  });

  it("still decorates /advisor with the model picker", () => {
    const { ctx, record } = makeCtx();
    loadModule().apply(ctx);
    assert.equal(record.decorations.length, 1);
    assert.equal(record.decorations[0].name, "advisor");
    assert.equal(record.decorations[0].ui.kind, "popupSelect");
  });
});

describe("client wiring: command receipt", () => {
  it("subscribes with the host's (sessionId, name, result) argument order", () => {
    const client = loadModule();
    const { ctx, record } = makeCtx();
    client.apply(ctx);
    const handlers = record.events.filter(
      (/** @type {any} */ event) => event.name === "command/executed",
    );
    assert.equal(handlers.length, 1, "必须监听宿主的 command/executed（本地提交回执）");
    const handler = handlers[0].listener;
    assert.equal(client.__test.lastCommandReceipt(), null);

    // 宿主 `notifyExecuted` 调的是 `listener(sessionId, name, result)`：
    // 只传 name/result（漏掉 sessionId）会把 sessionId 当命令名，回执永远收不到。
    assert.equal(handler("session-1", "btw", { kind: "success", text: "OK" }), undefined);
    assert.equal(client.__test.lastCommandReceipt(), null, "非 advisor 命令不能产生回执");

    assert.equal(
      handler("session-1", "advisor", { kind: "success", text: "/advisor status\n模式：off" }),
      undefined,
    );
    assert.deepEqual(client.__test.lastCommandReceipt(), {
      tone: "ok",
      text: "/advisor status\n模式：off",
    });

    // 错误参数顺序（name 当第一个参数）会被命令名过滤掉，不会误触发。
    handler("advisor", { kind: "success", text: "错序" });
    assert.deepEqual(client.__test.lastCommandReceipt()?.tone, "ok");
    assert.equal(client.__test.lastCommandReceipt()?.text, "/advisor status\n模式：off");

    // 畸形输入不抛：宿主的 notifyExecuted 会吞异常，但静默失败不该被测试放过。
    assert.doesNotThrow(() => handler(undefined, "advisor", null));
  });

  it("degrades when the host exposes no event bus", () => {
    const { ctx, record } = makeCtx({ on: false });
    assert.doesNotThrow(() => loadModule().apply(ctx));
    assert.deepEqual(record.events, []);
    assert.equal(slotOf(record, "conversation.chat.commandview").length, 1);
  });
});
