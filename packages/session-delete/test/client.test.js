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
