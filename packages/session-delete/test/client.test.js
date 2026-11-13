// @ts-check
// node:vm 单测：用假的 window.__ModuleLoader__.load + 假的 require 加载 client.js，
// 捕获 module.exports，然后测 exports.__test 暴露的内部出口。
// 注意：用非 strict 的 assert —— vm 沙箱里创建的对象其原型属于另一个 realm，
// deepStrictEqual 会因为原型不同而误报；deepEqual 只做结构化比较。
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "..", "lib", "client.js");

/**
 * 在 vm 沙箱里执行 client.js（classic script），返回 factory 产出的 module.exports。
 * @returns {any}
 */
function loadClient() {
  const code = fs.readFileSync(clientPath, "utf8");
  /** @type {any} */
  let captured = null;

  const reactStub = {
    createElement: () => ({ type: "stub" }),
    Fragment: "Fragment",
    cloneElement: () => ({ type: "stub" }),
    isValidElement: () => false,
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
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    document: {
      createElement: () => ({ dataset: {}, style: {}, remove: () => {} }),
      head: { appendChild: () => {} },
      querySelector: () => null,
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    console,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (/** @type {any} */ fn) => fn,
    cancelAnimationFrame: () => {},
    require: (/** @type {string} */ name) => {
      if (name === "react") return reactStub;
      // 官方 UI 原语在单测里缺失：client 自己 try/catch 回退，这里抛错也能被它接住。
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: clientPath });
  assert.ok(captured, "window.__ModuleLoader__.load was not called");
  assert.equal(captured.id, "@kangyishuai/dsh-session-delete");
  const exported = captured.factory(sandbox.require);
  assert.ok(exported?.__test, "module.exports.__test is missing");
  return exported;
}

const client = loadClient();

// ---------------------------------------------------------------------------
// 配色 token 的成对性
//
// 背景：0.4.x 的「回收站计数」徽章是 `background: state-error` + 硬编码 `color: "#fff"`。
// 宿主深色主题下的 error 是**浅红** #f25a5a（给深色前景用的），配白字只有 3.29:1，
// 而配宿主的前景色 token 是 5.75:1（浅色主题 4.5:1）。
// 这类 bug 的共同点是「自适应的反色填充配了写死的白」，所以这里守住两条不变量：
//   1. 用到的主题 token 必须真实存在（写错名字会静默落到硬编码 fallback）；
//   2. 计数徽章的前景必须来自配对 token，不是 #fff 字面量。
// ---------------------------------------------------------------------------
describe("theme tokens", () => {
  /** 宿主 0.2.2-rc.2 主题里真实存在的 token（只收本插件用到的）。 */
  const HOST_THEME_TOKENS = new Set([
    "--dsw-alias-bg-base",
    "--dsw-alias-bg-layer-2",
    "--dsw-alias-bg-mask-1",
    "--dsw-alias-border-l2",
    "--dsw-alias-brand-primary",
    "--dsw-alias-interactive-bg-hover",
    "--dsw-alias-interactive-bg-hover-danger",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-primary-foreground",
    "--dsw-alias-label-secondary",
    "--dsw-alias-label-tertiary",
    "--dsw-alias-state-error-primary",
    "--dsw-alias-toast-bg",
    "--dsw-alias-toast-label",
  ]);

  it("exposes the design-token map for inspection", () => {
    const tokens = client.__test.tokens;
    assert.equal(typeof tokens, "object");
    assert.ok(Object.keys(tokens).length > 5, "token map looks empty");
  });

  it("only uses theme tokens the host actually defines", () => {
    const used = new Set();
    for (const value of Object.values(client.__test.tokens)) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(/var\((--(?:dsw|ds)-[a-z0-9-]+)/g)) used.add(match[1]);
    }
    assert.ok(used.size > 0, "no theme tokens found in the token map");
    const unknown = [...used].filter((token) => !HOST_THEME_TOKENS.has(token)).sort();
    assert.deepEqual(
      unknown,
      [],
      `unknown host tokens (would silently fall back to a hardcoded colour): ${unknown.join(", ")}`,
    );
  });

  it("pairs the danger badge fill with a theme foreground token", () => {
    const tokens = client.__test.tokens;
    assert.match(
      String(tokens.danger),
      /^var\(--dsw-alias-state-error-primary/,
      "danger fill must use --dsw-alias-state-error-primary",
    );
    assert.match(
      String(tokens.dangerText),
      /^var\(--dsw-alias-label-primary-foreground/,
      "danger foreground must use --dsw-alias-label-primary-foreground, not a hardcoded #fff",
    );
  });
});

// ---------------------------------------------------------------------------
// 确认框 / 批量执行用到的纯函数
//
// 这三条不变量是这次 UI 精简的骨架：
//   1. 影响面只拼「成立的事实」——没有 live 就不能出现 live 占位；
//   2. 批量按块切分——0.4.x 一次 RPC 全选 80 条会被宿主上限整单拒绝；
//   3. 内联词典与 locale/*.json 的键集必须完全一致（两处漂移会静默显示 key）。
// ---------------------------------------------------------------------------
describe("dialog presentation helpers", () => {
  /**
   * 用内联中文词典模拟宿主注入的 t()，只做 {name} 插值。
   * @param {string} key
   * @param {Record<string, unknown>} [values]
   * @returns {string}
   */
  const t = (key, values) => {
    /** @type {Record<string, string>} */
    const dict = client.__test.zh;
    const template = dict[key] ?? key;
    return template.replace(
      /\{(\w+)\}/g,
      (/** @type {string} */ _whole, /** @type {string} */ name) => String(values?.[name] ?? ""),
    );
  };

  it("impactLine only concatenates facts that are true", () => {
    const { impactLine } = client.__test;
    assert.equal(impactLine({}, t), "");
    assert.equal(
      impactLine({ sizeBytes: 2048 }, t),
      "约 2.0 KB",
      "a plan without children or live work must not invent empty facts",
    );
    assert.equal(
      impactLine({ sizeBytes: 2048, live: true, children: [{ id: "a" }] }, t),
      "约 2.0 KB · 1 个子会话 · 正在运行，会先停止",
    );
  });

  it("chunk splits a long selection so no single request exceeds the host bound", () => {
    const { chunk, batchChunk } = client.__test;
    assert.equal(batchChunk, 20);
    const ids = Array.from({ length: 80 }, (_, index) => `e${index}`);
    const groups = chunk(ids, batchChunk);
    assert.equal(groups.length, 4);
    assert.equal(groups[0].length, 20);
    assert.deepEqual(groups.flat(), ids);
    assert.deepEqual(chunk([], batchChunk), []);
    assert.deepEqual(
      chunk(["only"], 0),
      [["only"]],
      "a non-positive size must still make progress",
    );
  });

  it("joinList truncates long technical lists instead of growing the dialog", () => {
    const { joinList } = client.__test;
    assert.equal(joinList([{ label: "归档" }, { label: "置顶" }]), "归档 · 置顶");
    assert.equal(
      joinList(
        Array.from({ length: 9 }, (_, index) => `x${index}`),
        4,
      ),
      "x0 · x1 · x2 · x3 …",
    );
    assert.equal(joinList(undefined), "");
  });

  it("the inline dictionaries and locale/*.json agree on every key", () => {
    const { zh, en } = client.__test;
    const zhJson = JSON.parse(fs.readFileSync(path.join(here, "..", "locale", "zh.json"), "utf8"));
    const enJson = JSON.parse(fs.readFileSync(path.join(here, "..", "locale", "en.json"), "utf8"));
    assert.deepEqual(
      Object.keys(zh).sort(),
      Object.keys(zhJson.sessionDelete).sort(),
      "locale/zh.json drifted from the inline zh dictionary",
    );
    assert.deepEqual(
      Object.keys(en).sort(),
      Object.keys(enJson.sessionDelete).sort(),
      "locale/en.json drifted from the inline en dictionary",
    );
    for (const key of Object.keys(zh)) {
      assert.equal(typeof en[key], "string", `en is missing ${key}`);
    }
  });
});
