// @ts-check
// client 半的两份验收：**文案键集一致性** + **旧卡折叠行的纯逻辑**。
//
// 为什么需要这个文件（AUD-NS-07）：`error.aborted`（「生成超时或被取消」）只写在 client.js 的
// 内联字典里，`locale/{zh,en}.json` 漏了它。运行时用的是内联字典，所以界面看起来正常；但发布包里
// 的 `locale/*.json` 才是我对外宣称的键集（打包/外部消费/将来切到文件加载都会读它），漂移会静默丢失
// 一条最常见失败态的文案。`pnpm check` 只比 zh/en 两个文件，不比内联字典，所以这里补一条 parity 测试
// ——思路与 `packages/session-delete/test/client.test.js` 的同一段一致。
//
// 为什么顺带测 `firstSentenceOf`（AUD-NS-02）：旧卡默认折叠成一行「已过期 · 摘要首句」，
// 首句截断是纯逻辑，抽出来才能在 `node --test` 里钉住（组件渲染本身由桌面只读回归覆盖）。
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
 * 只执行到 factory 返回：不 apply，不挂 slot，因此不需要 DOM/React 的完整实现。
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
  assert.equal(captured.id, "@kangyishuai/dsh-next-step");
  const exported = captured.factory((/** @type {string} */ name) => {
    if (name === "react") return reactStub;
    throw new Error(`未预期的 require：${name}`);
  });
  assert.ok(exported?.__test, "module.exports.__test 缺失（单测出口）");
  return exported;
}

const client = loadClient();

/** @param {string} name */
const localeOf = (name) => JSON.parse(readFileSync(join(HERE, "..", "locale", name), "utf8"));

test("内联字典与 locale/*.json 的键集完全一致（防止再次漂移）", () => {
  const { zh, en } = client.__test;
  const zhFile = localeOf("zh.json").nextStep;
  const enFile = localeOf("en.json").nextStep;
  assert.deepEqual(
    Object.keys(zh).sort(),
    Object.keys(zhFile).sort(),
    "locale/zh.json 与内联 zh 字典的键集不一致",
  );
  assert.deepEqual(
    Object.keys(en).sort(),
    Object.keys(enFile).sort(),
    "locale/en.json 与内联 en 字典的键集不一致",
  );
  // 键集一一对应：zh 有的键 en 必须也有（译者漏翻会显示成裸 key）
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh / en 键集不一致");
  // 文案不得为空（允许有意留白，但 0 长度几乎一定是漏填）
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, "string", `zh.${key} 不是字符串`);
    assert.notEqual(value.trim(), "", `zh.${key} 是空文案`);
  }
});

test("error.aborted 这条最常见失败态的文案在两份 locale 文件里都在（AUD-NS-07）", () => {
  const zhFile = localeOf("zh.json").nextStep;
  const enFile = localeOf("en.json").nextStep;
  assert.equal(typeof zhFile["error.aborted"], "string");
  assert.equal(typeof enFile["error.aborted"], "string");
  // 与内联字典同一句话（同一份键不能出现两种说法）
  assert.equal(zhFile["error.aborted"], client.__test.zh["error.aborted"]);
  assert.equal(enFile["error.aborted"], client.__test.en["error.aborted"]);
});

test("firstSentenceOf：取首句、压缩空白、超长截断并加省略号", () => {
  const { firstSentenceOf } = client.__test;
  // 中文摘要：只留第一句
  assert.equal(
    firstSentenceOf("测试通过 42 项。下一步可以发布 v0.5.0。"),
    "测试通过 42 项。",
    "只取第一句（含句末标点）",
  );
  // 没有句末标点时保留整段
  assert.equal(firstSentenceOf("改成 %5"), "改成 %5");
  // 换行 / 连续空白压成单空格
  assert.equal(firstSentenceOf("第一行\n  第二行"), "第一行 第二行");
  // 一句话超过上限：截断并加省略号（长度不超过上限）
  const long = "很长的摘要".repeat(30);
  const folded = firstSentenceOf(long);
  assert.ok(folded.length <= 60, `折叠行不该超过 60 字，实际=${folded.length}`);
  assert.ok(folded.endsWith("…"), "截断后要有省略号");
  // 空输入不崩
  assert.equal(firstSentenceOf(""), "");
  assert.equal(firstSentenceOf(undefined), "");
});
