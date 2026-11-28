// @ts-check
// 预算升级的**可观测性**：诊断文本里的「预算升级：N 次」+ 中英文案同步。
//
// 背景（2026-11-28）：空输出恢复会**花更多 token**（预算从设置值升到 ≥3000），但这个过程原来
// 只在日志里留痕；设置页诊断看到的仍是 generated / failed / skipped，看不出「这次卡片是升级救回来的，
// 多花了多少」。现在 `service.js` 的 counters 多一个 `budgetEscalations`（每次 generate 走升级路径
// +1，口径在 `generation-recovery.js` 的 `countBudgetEscalation` 里钉住），设置页诊断多一行。
//
// 本文件驱动**真实 client 源码**（vm 沙箱里跑 classic script，取出 module.exports.__test），
// 断言的是 `diagnosticsText()` 这个从设置组件里抽出来的纯函数——不复制实现、不伪造 stats。
// 行序、缺失字段的兜底（老宿主没有 `budgetEscalations`）、中英文案都钉在这里。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");

/**
 * 在 vm 沙箱里跑真实 client.js（classic script），返回 factory 产出的 module.exports。
 * 与 `test/locale-parity.test.js` 同一套最小 loader（只执行到 factory 返回，不 apply、不挂 slot）。
 * @returns {any}
 */
function loadClient() {
  const code = readFileSync(CLIENT, "utf8");
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
        /** @param {any} options */
        load(options) {
          captured = options;
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      getComputedStyle: () => null,
    },
    document: {
      createElement: () => ({ dataset: {}, style: {}, remove: () => {} }),
      documentElement: { dataset: {} },
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
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: CLIENT });
  assert.ok(captured !== null, "client.js 没有向 window.__ModuleLoader__ 注册");
  const exported = captured.factory((/** @type {string} */ name) => {
    if (name === "react") return reactStub;
    throw new Error(`未预期的 require：${name}`);
  });
  assert.ok(exported?.__test, "module.exports.__test 缺失（单测出口）");
  return exported;
}

const client = loadClient();
const { diagnosticsText, zh, en } = client.__test;

/**
 * 宿主 `t` 的最小替身：`{name}` 插值。**只替代文案渲染**，被测函数（diagnosticsText）是真实源码。
 * @param {Record<string, string>} dict
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 */
function translateWith(dict) {
  return (key, params = {}) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/gu, (match, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    );
}

/** nextStep/diagnostics 的真实 stats 形状（计数 + 版本 + 采集）。 */
function statsFixture(overrides = {}) {
  return {
    generated: 12,
    hidden: 3,
    failed: 1,
    aborted: 0,
    skipped: 4,
    inflight: 0,
    budgetEscalations: 2,
    lastError: "",
    lastSkip: null,
    version: "0.5.2",
    buildHash: "abcdef1234567890",
    promptVersion: 4,
    scheme: "v1",
    telemetry: { lines: 42, bytes: 2048, path: "/tmp/dsh/next-step/events.jsonl" },
    ...overrides,
  };
}

test("诊断文本包含「预算升级：N 次」，紧跟在计数摘要行之后", () => {
  const text = diagnosticsText(statsFixture(), translateWith(zh));
  const lines = text.split("\n");
  assert.equal(
    lines[0].startsWith("已生成 12（未显示 3）"),
    true,
    `首行是计数摘要，实际=${lines[0]}`,
  );
  assert.equal(lines[1], "预算升级：2 次", "计数行之后就是预算升级次数（同一层信息）");
  // 原有各行一个都不能丢（这次只是把内联块抽成纯函数）
  assert.equal(lines[2], "无错误");
  assert.match(text, /版本 0\.5\.2 · 构建 abcdef12/u);
  assert.match(text, /提示词 v4 · 口径 v1/u);
  assert.match(text, /事件 42 条 · 2\.0 KB/u);
  assert.equal(text.includes("/tmp/dsh/next-step/events.jsonl"), true);
  // 不允许出现未替换模板 / undefined 数字
  assert.equal(/undefined|NaN|\{count\}/u.test(text), false, `诊断文本有未替换值：${text}`);
});

test("老宿主没有 budgetEscalations：按 0 显示（不显示 undefined / NaN）", () => {
  const stats = statsFixture();
  delete (/** @type {any} */ (stats).budgetEscalations);
  const text = diagnosticsText(stats, translateWith(zh));
  assert.equal(text.split("\n")[1], "预算升级：0 次");
  assert.equal(/undefined|NaN/u.test(text), false);
  // 脏值（字符串 / null）同样兜底成 0，不让诊断面板露馅
  for (const bad of [null, undefined, "", "x"]) {
    const dirty = diagnosticsText(statsFixture({ budgetEscalations: bad }), translateWith(zh));
    assert.equal(dirty.split("\n")[1], "预算升级：0 次", String(bad));
  }
});

test("英文 locale 同一行：Budget escalations: {count}", () => {
  const text = diagnosticsText(statsFixture({ budgetEscalations: 7 }), translateWith(en));
  assert.equal(text.split("\n")[1], "Budget escalations: 7");
});

test("lastSkip / lastError 仍照旧渲染（抽纯函数没有丢分支）", () => {
  const text = diagnosticsText(
    statsFixture({
      lastError: "model output did not match the card schema (json:empty)",
      lastSkip: { kind: "failed", reason: "model output did not match the card schema" },
    }),
    translateWith(zh),
  );
  assert.match(text, /最近错误：model output did not match the card schema \(json:empty\)/u);
  assert.match(text, /最近跳过：failed · model output did not match the card schema/u);
});

test("文案键在两份 locale 文件与内联字典里都在，且说法一致", () => {
  const zhFile = JSON.parse(readFileSync(join(HERE, "..", "locale", "zh.json"), "utf8")).nextStep;
  const enFile = JSON.parse(readFileSync(join(HERE, "..", "locale", "en.json"), "utf8")).nextStep;
  assert.equal(zhFile["settings.budgetEscalations"], "预算升级：{count} 次");
  assert.equal(enFile["settings.budgetEscalations"], "Budget escalations: {count}");
  // 内联字典是运行时真正用的那份；两边必须同一句话（parity 测试只比键集，不比文案）
  assert.equal(zh["settings.budgetEscalations"], zhFile["settings.budgetEscalations"]);
  assert.equal(en["settings.budgetEscalations"], enFile["settings.budgetEscalations"]);
});

test("diagnosticsText 只通过 t(key, {count}) 取这条文案（接线口径）", () => {
  /** @type {{ key: string, params: any }[]} */
  const seen = [];
  const spy = (/** @type {string} */ key, /** @type {any} */ params) => {
    seen.push({ key, params });
    return key;
  };
  diagnosticsText(statsFixture(), spy);
  const hit = seen.filter((call) => call.key === "settings.budgetEscalations");
  assert.equal(hit.length, 1, "预算升级那一行只取一次文案");
  // 注意跨 realm：参数对象由 vm 里的代码构造，deepEqual 会因原型不同失败，逐字段断言。
  assert.equal(hit[0].params.count, "2", "参数名必须是 count（文案里是 {count}）");
  assert.equal(Object.keys(hit[0].params).length, 1, "只传 count，别把整个 stats 塞进文案");
});
