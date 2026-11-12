// @ts-check
// node:vm 单测：用假的 window.__ModuleLoader__.load + 假的 require 加载 client.js，
// 捕获 module.exports，然后只测 exports.__test 暴露的纯函数。
// 注意：用非 strict 的 assert —— vm 沙箱里创建的对象/数组其原型属于另一个 realm，
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
      getSelection: () => null,
      createRange: () => ({}),
      execCommand: () => false,
    },
    console,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (/** @type {any} */ fn) => fn,
    cancelAnimationFrame: () => {},
    require: (/** @type {any} */ name) => {
      if (name === "react") return reactStub;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: clientPath });
  assert.ok(captured, "window.__ModuleLoader__.load was not called");
  assert.equal(captured.id, "@kangyishuai/dsh-advisor");
  const exported = captured.factory(sandbox.require);
  assert.ok(exported?.__test, "module.exports.__test is missing");
  return exported;
}

const client = loadClient();
const api = client.__test;

describe("money clamp", () => {
  it("keeps decimals instead of rounding to integers", () => {
    assert.equal(api.clampMoney(0.5, 0, 0, 10000, 2), 0.5);
    assert.equal(api.clampMoney("0.15", 0, 0, 1000, 4), 0.15);
    assert.equal(api.clampMoney(0.075, 0, 0, 1000, 4), 0.075);
  });

  it("rounds to the field precision and clamps the range", () => {
    assert.equal(api.clampMoney(1.239, 0, 0, 10000, 2), 1.24);
    assert.equal(api.clampMoney(0.123456, 0, 0, 1000, 4), 0.1235);
    assert.equal(api.clampMoney(-1, 0, 0, 10000, 2), 0);
    assert.equal(api.clampMoney(99999, 0, 0, 1000, 4), 1000);
  });
});

describe("money input formatting", () => {
  it("drops trailing zeros and keeps meaningful decimals", () => {
    assert.equal(api.formatMoneyInput(0, 2), "0");
    assert.equal(api.formatMoneyInput(0.5, 2), "0.5");
    assert.equal(api.formatMoneyInput(0.15, 4), "0.15");
    assert.equal(api.formatMoneyInput(1.25, 2), "1.25");
    assert.equal(api.formatMoneyInput(0.0001, 4), "0.0001");
  });
});

describe("currency conversion", () => {
  it("keeps the real value when switching USD <-> CNY", () => {
    const usd = {
      currency: "USD",
      usdToCny: 7.2,
      maxCostPerDay: 10,
      workspaceMaxCostPerDay: 20,
      priceInputPerMTok: 0.15,
      priceOutputPerMTok: 0.3,
    };
    const cny = api.convertCurrency(usd, "CNY");
    assert.equal(cny.currency, "CNY");
    assert.equal(cny.maxCostPerDay, 72);
    assert.equal(cny.workspaceMaxCostPerDay, 144);
    assert.equal(cny.priceInputPerMTok, 1.08);
    assert.equal(cny.priceOutputPerMTok, 2.16);

    const back = api.convertCurrency(cny, "USD");
    assert.equal(back.currency, "USD");
    assert.equal(back.maxCostPerDay, 10);
    assert.equal(back.priceInputPerMTok, 0.15);
  });

  it("is a no-op when the currency does not change", () => {
    const settings = { currency: "CNY", usdToCny: 7.2, maxCostPerDay: 72 };
    assert.deepEqual(api.convertCurrency(settings, "CNY"), settings);
  });
});

describe("settings view", () => {
  it("normalizes decimal money fields from the host payload", () => {
    const out = api.normalizeOptions({
      ok: true,
      settings: {
        maxCostPerDay: 0.5,
        workspaceMaxCostPerDay: 1.25,
        priceInputPerMTok: 0.15,
        priceOutputPerMTok: 0.075,
      },
    });
    assert.equal(out.settings.maxCostPerDay, 0.5);
    assert.equal(out.settings.workspaceMaxCostPerDay, 1.25);
    assert.equal(out.settings.priceInputPerMTok, 0.15);
    assert.equal(out.settings.priceOutputPerMTok, 0.075);
    assert.equal(out.settings.maxTokens, 4096);
    assert.equal(out.settings.currency, "USD");
    assert.equal(out.settings.usdToCny, 7.2);
  });

  it("normalizes currency and the new money keys", () => {
    const out = api.normalizeSettingsView({
      currency: "CNY",
      usdToCny: 7.3,
      maxCostPerDay: 7.3,
      workspaceMaxCostPerDay: 0,
      priceInputPerMTok: 1.5,
    });
    assert.equal(out.currency, "CNY");
    assert.equal(out.usdToCny, 7.3);
    assert.equal(out.maxCostPerDay, 7.3);
    assert.equal(out.workspaceMaxCostPerDay, 0);
    assert.equal(out.priceInputPerMTok, 1.5);
  });

  it("does not report equal floats as a change", () => {
    const patch = api.diffSettings(
      { maxCostPerDay: 0.5, priceInputPerMTok: 0.15 },
      { maxCostPerDay: 0.5, priceInputPerMTok: 0.15 },
    );
    assert.deepEqual(patch, {});
  });

  it("reports a changed decimal", () => {
    const patch = api.diffSettings({ maxCostPerDay: 0.5 }, { maxCostPerDay: 0.51 });
    assert.deepEqual(patch, { maxCostPerDay: 0.51 });
  });
});

describe("advisor trace line", () => {
  const t = (/** @type {string} */ key) => {
    /** @type {Record<string, string>} */
    const dictionary = {
      "tail.trigger.shadow": "影子",
      "tail.trigger.other": "其他",
      "tail.trace.chars": "{chars} 字符",
    };
    return dictionary[key] ?? key;
  };

  it("formats local time as HH:mm", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    assert.equal(api.formatClock(at), "09:05");
    assert.equal(api.formatClock(0), "");
  });

  it("maps known triggers and falls back to other", () => {
    assert.equal(api.triggerLabel(t, "shadow"), "影子");
    assert.equal(api.triggerLabel(t, "nope"), "其他");
  });

  it("builds trigger · time · model · chars · usage", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    const text = api.traceTextOf(
      {
        trigger: "shadow",
        at,
        model: "zhinao/kimi",
        requestChars: 12438,
        usage: "1.2k in / 300 out / 1.2s / ≈$0.004",
      },
      t,
    );
    assert.match(text, /影子/);
    assert.match(text, /09:05/);
    assert.match(text, /zhinao\/kimi/);
    assert.match(text, /12,438 字符/);
    assert.match(text, /≈\$0\.004/);
  });

  it("normalizes at / trigger / requestChars from the host record", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    const out = api.normalizeAdviceItems({
      ok: true,
      items: [
        {
          turn: 2,
          at,
          trigger: "shadow",
          requestChars: 12438,
          requestPreview: "head…tail",
          requestPreviewTruncated: true,
          model: "zhinao/kimi",
          usage: "1.2k in / 300 out / 1.2s",
          status: "reviewed",
          advice: "x",
          summary: "y",
        },
      ],
    });
    assert.equal(out[0].at, at);
    assert.equal(out[0].trigger, "shadow");
    assert.equal(out[0].requestChars, 12438);
    assert.equal(out[0].requestPreview, "head…tail");
    assert.equal(out[0].requestPreviewTruncated, true);
  });
});
