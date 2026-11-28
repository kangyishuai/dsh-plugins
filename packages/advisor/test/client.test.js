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
      priceCacheReadPerMTok: 0.25,
      priceCacheWritePerMTok: 0.5,
    };
    const cny = api.convertCurrency(usd, "CNY");
    assert.equal(cny.currency, "CNY");
    assert.equal(cny.maxCostPerDay, 72);
    assert.equal(cny.workspaceMaxCostPerDay, 144);
    assert.equal(cny.priceInputPerMTok, 1.08);
    assert.equal(cny.priceOutputPerMTok, 2.16);
    assert.equal(cny.priceCacheReadPerMTok, 1.8);
    assert.equal(cny.priceCacheWritePerMTok, 3.6);

    const back = api.convertCurrency(cny, "USD");
    assert.equal(back.currency, "USD");
    assert.equal(back.maxCostPerDay, 10);
    assert.equal(back.priceInputPerMTok, 0.15);
    assert.equal(back.priceCacheReadPerMTok, 0.25);
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
        priceCacheReadPerMTok: 0.25,
        priceCacheWritePerMTok: 0.5,
      },
    });
    assert.equal(out.settings.maxCostPerDay, 0.5);
    assert.equal(out.settings.workspaceMaxCostPerDay, 1.25);
    assert.equal(out.settings.priceInputPerMTok, 0.15);
    assert.equal(out.settings.priceOutputPerMTok, 0.075);
    assert.equal(out.settings.priceCacheReadPerMTok, 0.25);
    assert.equal(out.settings.priceCacheWritePerMTok, 0.5);
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
      priceCacheReadPerMTok: 0.5,
      priceCacheWritePerMTok: 0.75,
    });
    assert.equal(out.currency, "CNY");
    assert.equal(out.usdToCny, 7.3);
    assert.equal(out.maxCostPerDay, 7.3);
    assert.equal(out.workspaceMaxCostPerDay, 0);
    assert.equal(out.priceInputPerMTok, 1.5);
    assert.equal(out.priceCacheReadPerMTok, 0.5);
    assert.equal(out.priceCacheWritePerMTok, 0.75);
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

// ---------------------------------------------------------------------------
// 注入样式的主题正确性
//
// 背景：0.5.x 的「未保存」提示与逐轮警告用的是 `--dsw-alias-state-warning-primary`，
// 而宿主主题里并没有这个 token（真名是 state-warn-*）。写错名字不会报错，只会静默落到
// CSS 里的硬编码 fallback，于是那些文字永远不跟随深浅色主题。这条用例守住：
//   1. 样式表只用宿主真实存在的 token（白名单只收已验证的）；
//   2. 警告文字用宿主自己的 warning 文本 token。
// ---------------------------------------------------------------------------
describe("injected styles: theme tokens", () => {
  /** 宿主 0.2.2-rc.2 主题里真实存在的 token（只收本插件用到的）。 */
  const HOST_THEME_TOKENS = new Set([
    "--dsw-alias-bg-base",
    "--dsw-alias-bg-layer-2",
    "--dsw-alias-border-l2",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-secondary",
    "--dsw-alias-state-error-primary",
    "--dsw-alias-state-success-primary",
    "--dsw-alias-state-warn-label",
    "--dsw-alias-state-warn-primary",
  ]);

  const css = () => client.__test.clientCss();

  it("exposes the injected stylesheet for inspection", () => {
    assert.equal(typeof client.__test.clientCss, "function");
    assert.ok(css().length > 1000, "stylesheet looks empty");
  });

  it("only references theme tokens the host actually defines", () => {
    const used = new Set(
      [...css().matchAll(/var\((--(?:dsw|ds)-[a-z0-9-]+)/g)].map((match) => match[1]),
    );
    assert.ok(used.size > 0, "no theme tokens found in the stylesheet");
    const unknown = [...used].filter((token) => !HOST_THEME_TOKENS.has(token)).sort();
    assert.deepEqual(
      unknown,
      [],
      `unknown host tokens (would silently fall back to a hardcoded colour): ${unknown.join(", ")}`,
    );
  });

  it("uses the host warning text token for warning copy", () => {
    for (const selector of [
      ".dsh-advisor-dirty",
      '.dsh-advisor-save-status[data-state="dirty"]',
      ".dsh-advisor-turn-warn",
    ]) {
      const rule = css()
        .split("}")
        .find((/** @type {string} */ chunk) => chunk.trim().startsWith(selector));
      assert.ok(rule, `${selector} rule is missing`);
      assert.match(
        rule,
        /color:var\(--dsw-alias-state-warn-(?:label|primary)/,
        `${selector} must use the host warning tokens`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 命令输出 / 生效状态（审计 USIM-U2-07 / USIM-U2-08）
// ---------------------------------------------------------------------------

describe("command line and card view", () => {
  it("rebuilds the original command line from name + args", () => {
    assert.equal(api.commandLineOf({ name: "advisor", args: " status" }), "/advisor status");
    assert.equal(api.commandLineOf({ name: "advisor", args: "  doctor  " }), "/advisor doctor");
    assert.equal(api.commandLineOf({ name: "advisor", args: "" }), "/advisor");
    assert.equal(api.commandLineOf({ name: "advisor", args: null }), "/advisor");
    assert.equal(api.commandLineOf({ name: null, args: null }), "/");
    assert.equal(api.commandLineOf(null), "");
  });

  it("uses the settled text as body and strips the plugin's command echo line", () => {
    const view = api.commandCardView({
      name: "advisor",
      args: " status",
      outcome: { kind: "success", text: "/advisor status\n模式：off\n顾问：未配置" },
    });
    assert.equal(view.line, "/advisor status");
    assert.equal(view.state, "ok");
    assert.equal(view.body, "模式：off\n顾问：未配置");

    const error = api.commandCardView({
      name: "advisor",
      args: " on",
      outcome: { kind: "error", text: "/advisor on\n还没有选顾问模型。用 /advisor 打开选择器" },
    });
    assert.equal(error.state, "error");
    assert.equal(error.body, "还没有选顾问模型。用 /advisor 打开选择器");

    // 没有 echo 行时整段都是正文（兼容旧文本 / 其它入口）。
    const plain = api.commandCardView({
      name: "advisor",
      args: " report",
      outcome: { kind: "success", text: "顾问报告（跨会话）\n累计 3 条建议" },
    });
    assert.equal(plain.body, "顾问报告（跨会话）\n累计 3 条建议");

    // 还在跑：没有正文，状态是 running。
    const running = api.commandCardView({ name: "advisor", args: " doctor", outcome: null });
    assert.equal(running.state, "running");
    assert.equal(running.body, "");
  });

  it("keeps multi-line output intact (no truncation, no ellipsis)", () => {
    const lines = [
      "模式：advisory",
      "生效：已生效：会征询顾问",
      "顾问：p/m",
      "本会话：2 次",
      "最近一次：reviewed",
    ];
    const view = api.commandCardView({
      name: "advisor",
      args: " status",
      outcome: { kind: "success", text: `/advisor status\n${lines.join("\n")}` },
    });
    assert.equal(view.body.split("\n").length, lines.length);
    assert.doesNotMatch(view.body, /…/u);
    assert.match(view.body, /^生效：/mu);
  });
});

describe("receipt of a local command execution", () => {
  it("only reacts to the advisor command", () => {
    assert.equal(api.receiptOf("btw", { kind: "success", text: "OK" }), null);
    assert.equal(api.receiptOf(undefined, { kind: "success", text: "OK" }), null);
  });

  it("carries the full multi-line text and the error tone", () => {
    const ok = api.receiptOf("advisor", {
      kind: "success",
      text: "/advisor doctor\n✅ 宿主 llm 服务可用",
    });
    assert.equal(ok.tone, "ok");
    assert.equal(ok.text, "/advisor doctor\n✅ 宿主 llm 服务可用");
    const failed = api.receiptOf("advisor", {
      kind: "error",
      text: "/advisor on\n还没有选顾问模型。",
    });
    assert.equal(failed.tone, "error");
  });

  it("ignores malformed or empty results", () => {
    assert.equal(api.receiptOf("advisor", null), null);
    assert.equal(api.receiptOf("advisor", { kind: "success" }), null);
    assert.equal(api.receiptOf("advisor", { kind: "success", text: "   " }), null);
  });
});

describe("effective advisor state (saved vs in effect)", () => {
  it("reports off with the real reason instead of echoing the saved mode", () => {
    const state = api.effectiveState({ mode: "advisory", provider: "", model: "" });
    assert.equal(state.effective, "off");
    assert.equal(state.reason, "unconfigured");
    assert.equal(state.key, "settings.effective.off.unconfigured");
  });

  it("covers on / shadow / off-mode", () => {
    assert.deepEqual(api.effectiveState({ mode: "advisory", provider: "p", model: "m" }), {
      effective: "on",
      reason: null,
      key: "settings.effective.on",
    });
    assert.deepEqual(api.effectiveState({ mode: "shadow", provider: "p", model: "m" }), {
      effective: "shadow",
      reason: null,
      key: "settings.effective.shadow",
    });
    assert.deepEqual(api.effectiveState({ mode: "off", provider: "p", model: "m" }), {
      effective: "off",
      reason: "mode",
      key: "settings.effective.off.mode",
    });
  });

  it("never throws on malformed settings", () => {
    const state = api.effectiveState(null);
    assert.equal(state.effective, "off");
    assert.equal(state.reason, "mode");
    assert.equal(api.effectiveState({ mode: "nope", provider: 3, model: 4 }).effective, "off");
  });
});

// ---------------------------------------------------------------------------
// 回执/轻提示定位（发版后真机 bug：固定在 bottom:24px 会盖住 composer 与发送按钮）
//
// 真机证据：1280×820、有会话时 `.dsh-advisor-toast.dsh-advisor-receipt` 高 204px、
// composer y=700–736、send y=748–782，回执与输入区重叠 y=36。
// 这里锁死纯函数的几何约定，真正的「不回退/不重叠」由桌面冒烟与真机截图复核。
// ---------------------------------------------------------------------------

describe("toast/receipt placement above the composer", () => {
  it("falls back to 24px when there is no composer or no viewport", () => {
    assert.equal(api.toastBottomOffset(), 24);
    assert.equal(api.toastBottomOffset({}), 24);
    assert.equal(api.toastBottomOffset({ composerTop: null, viewportHeight: 820 }), 24);
    assert.equal(api.toastBottomOffset({ composerTop: 700, viewportHeight: 0 }), 24);
    assert.equal(api.toastBottomOffset({ composerTop: 700, viewportHeight: NaN }), 24);
    assert.equal(api.toastBottomOffset({ composerTop: undefined, viewportHeight: 820 }), 24);
  });

  it("sits one gap above the composer input, leaving 8px to the composer card", () => {
    // 真机 1280×820：composer 输入框 top=700 → 820-700+16=136，回执底边落在 y=684。
    assert.equal(api.toastBottomOffset({ composerTop: 700, viewportHeight: 820 }), 136);
    assert.equal(api.toastBottomOffset({ composerTop: 780, viewportHeight: 820 }), 56);
    // 视觉间距（复审 nit）：宿主 composer 卡片顶比输入框顶高 8px（内边距/边框），
    // 回执底边 → 卡片顶 = 684 → 692 = 8px，而不是原 gap=12 时的 4px。
    const cardTop = 700 - 8;
    const receiptBottom = 820 - api.toastBottomOffset({ composerTop: 700, viewportHeight: 820 });
    assert.equal(cardTop - receiptBottom, 8);
  });

  it("keeps the gap/clamp invariants across viewports (no receipt pushed off-screen)", () => {
    // 复审建议 (f)：离散值之外再扫一遍不变量：底距 >= 回退值、整块高 + 底距 + 留白 = 视口。
    for (const viewportHeight of [150, 260, 320, 480, 700, 820, 1200]) {
      for (const composerTop of [60, 100, 150, 240, 360, 580, 700, viewportHeight]) {
        const bottom = api.toastBottomOffset({ composerTop, viewportHeight });
        assert.ok(bottom >= 24, `bottom=${bottom} < 24 at ${composerTop}/${viewportHeight}`);
        const maxHeight = api.toastMaxHeight({ bottom, viewportHeight });
        assert.ok(maxHeight !== null);
        assert.equal(bottom + maxHeight + 8, viewportHeight);
      }
    }
  });

  it("clamps low so a composer near the bottom does not push the toast off-screen", () => {
    // composer 顶在视口下方 / 贴底：算出来是负数或 0，仍保留 24px 底距。
    assert.equal(api.toastBottomOffset({ composerTop: 900, viewportHeight: 820 }), 24);
    assert.equal(api.toastBottomOffset({ composerTop: 820, viewportHeight: 820 }), 24);
  });

  it("clamps high so a very short window keeps some receipt visible", () => {
    // 上界 = 视口高 - minVisible(120) - 留白(8)，820 时是 692。
    assert.equal(api.toastBottomOffset({ composerTop: 100, viewportHeight: 820 }), 692);
    // 200 高的窗口 + composer 在 150：natural 66 < 上界 72，按 natural 走。
    assert.equal(api.toastBottomOffset({ composerTop: 150, viewportHeight: 200 }), 66);
    // 150 高的窗口：上界被 baseBottom 兜到 24。
    assert.equal(api.toastBottomOffset({ composerTop: 100, viewportHeight: 150 }), 24);
  });

  it("computes the receipt max-height from the space above the composer", () => {
    assert.equal(api.toastMaxHeight({ bottom: 136, viewportHeight: 820 }), 676);
    assert.equal(api.toastMaxHeight({ bottom: 24, viewportHeight: 820 }), 788);
    assert.equal(api.toastMaxHeight({ bottom: 300, viewportHeight: 400 }), 92);
    assert.equal(api.toastMaxHeight({ bottom: 400, viewportHeight: 400 }), 0);
    assert.equal(api.toastMaxHeight({}), null);
    assert.equal(api.toastMaxHeight({ bottom: 136, viewportHeight: 0 }), null);
  });

  it("shrinks the receipt body but never below the readable floor", () => {
    // 820 高、composer 输入框 top=700 → 整块 676，正文上限 = min(42vh=344, 676-48=628) = 344。
    assert.equal(api.toastBodyMaxHeight({ bottom: 136, viewportHeight: 820 }), 344);
    // 矮窗口：整块可用 92 → 正文被压到 floor 60（宁可略超出也不成一像素线）。
    assert.equal(api.toastBodyMaxHeight({ bottom: 300, viewportHeight: 400 }), 60);
    assert.equal(api.toastBodyMaxHeight({}), null);
  });

  it("keeps the stylesheet's fallback bottom and interactive pointer behaviour", () => {
    const css = api.clientCss();
    assert.match(css, /\.dsh-advisor-toast\{[^}]*position:fixed[^}]*bottom:24px/u);
    // 回执要能选文本 / 点关闭：不能被 pointer-events:none 关掉。
    assert.doesNotMatch(css, /\.dsh-advisor-toast\{[^}]*pointer-events:none/u);
  });
});
