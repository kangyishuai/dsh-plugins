// @ts-check
// client 半纯函数回归（AUD-ARTIFACTS-01 / 03 / A-伪-5）。
//
// client.js 是宿主用 classic script 原样下发的（`window.__ModuleLoader__.load({ factory })`），
// 不能 import、也不能被 Node 直接 import。这里用 `node:vm` 造一个假 `window.__ModuleLoader__`
// 执行**真实源码**，从 factory 返回的 `exports.__test` 上取纯函数与行组件来断言——
// 不复制一份逻辑，避免单测与线上实现漂移。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const CLIENT_URL = new URL("../lib/client.js", import.meta.url);
const PACKAGE_ID = "@kangyishuai/dsh-artifacts";

/** 最小 React 桩：组件定义/调用只需要 createElement 与 hooks 的形状。 */
function reactStub() {
  return {
    /** @param {any} type @param {any} props @param {...any} children */
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
      };
    },
    /** @param {any} initial */
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    /** @param {any} _effect */
    useEffect(_effect) {
      // 行组件的 effect 只用来拉列表数据；纯函数/首帧断言的测试里不执行。
    },
    /** @param {any} callback */
    useCallback(callback) {
      return callback;
    },
    /** @param {any} initial */
    useRef(initial) {
      return { current: initial };
    },
  };
}

/** @returns {any} 节点树里的全部文本 */
function textOf(/** @type {any} */ node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node?.props?.children);
}

/** 执行真实 client.js，拿 `exports.__test`（以及 `inject`/`apply` 做形状断言）。 @returns {Promise<any>} */
async function loadClient() {
  const source = await readFile(CLIENT_URL, "utf8");
  /** @type {any} */
  let definition;
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
  const context = vm.createContext({ window, console });
  vm.runInContext(source, context, { filename: "client.js" });
  assert.ok(definition, "client.js must call window.__ModuleLoader__.load");
  assert.equal(definition.id, PACKAGE_ID);
  const exports = definition.factory((/** @type {string} */ id) => {
    assert.equal(id, "react", "client.js should only require react");
    return reactStub();
  });
  assert.ok(exports, "factory must return module.exports");
  assert.ok(Array.isArray(exports.inject));
  return exports;
}

test("AUD-ARTIFACTS-01：中文/Unicode id 的时间线行能被解析（不再只认 ASCII）", async () => {
  const client = await loadClient();
  const helpers = client.__test;
  assert.ok(helpers, "client.js should expose __test helpers for unit tests");
  const { pickId, pickIdFromText } = helpers;

  // 真实产物形态：slugify 保留中文（test/index.test.js 断言 q3-报告-2026）。
  assert.equal(
    pickIdFromText("artifact q3-报告-2026 · Q3 报告 · v2 · 42 B · html"),
    "q3-报告-2026",
  );
  assert.equal(
    pickIdFromText("artifact 走查产物-c654b0 · 走查产物 · v1 · 10 B · html"),
    "走查产物-c654b0",
  );
  assert.equal(
    pickIdFromText("artifact 报告.v2_最终-abc123 · 标题 · v3 · 1 B · html"),
    "报告.v2_最终-abc123",
  );

  // 分隔符是 ` · `：标题里再出现 ` · ` 也不能截错 id。
  assert.equal(
    pickIdFromText("artifact weekly-report-81a3cf · 周报 · 2026 Q4 · v3 · 100 B · html"),
    "weekly-report-81a3cf",
  );
  // 从 props.block 的文本块里认领（含嵌套的 text content block 形态）。
  assert.equal(
    pickId({
      block: {
        kind: "tool-result",
        content: [{ type: "text", text: "artifact 时间验收-390da5 · 时间验收 · v1 · 12 B · html" }],
      },
    }),
    "时间验收-390da5",
  );
  // 认不出 / 不安全 id → undefined（绝不把 `../etc` 当成 id 去打开页签）。
  assert.equal(pickIdFromText("no artifact line"), undefined);
  assert.equal(pickIdFromText("artifact ../etc · evil"), undefined);
  assert.equal(pickIdFromText("artifact .hidden · x"), undefined);
  assert.equal(pickIdFromText("artifact · empty"), undefined);
});

test("AUD-ARTIFACTS-01：行组件用 Unicode id 渲染，按钮可打开该 id", async () => {
  const client = await loadClient();
  const line = "artifact q3-报告-2026 · Q3 报告 · v4 · 42 B · html";
  const /** @type {any[]} */ opened = [];
  const row = client.__test.ArtifactRow({
    block: { content: [{ type: "text", text: line }] },
    rpc: async () => ({ ok: true, artifacts: [] }),
    open: (/** @type {string} */ id) => opened.push(id),
  });
  assert.equal(row?.props?.["data-dsh-artifact-row"], "q3-报告-2026");
  assert.match(textOf(row), /q3-报告-2026/u);
  assert.match(textOf(row), /打开预览/u);
  // 按钮的 onClick 真的带 id（修复前是 open(undefined) → 打开工件库）。
  const button = row?.props?.children?.find?.(
    (/** @type {any} */ child) => child?.props?.["data-dsh-artifact-open"] !== undefined,
  );
  assert.equal(button?.props?.["data-dsh-artifact-open"], "q3-报告-2026");
  button?.props?.onClick?.();
  assert.deepEqual(opened, ["q3-报告-2026"]);
});

test("A-伪-5：list/read 的调用不渲染时间线行（publish/append 仍渲染）", async () => {
  const client = await loadClient();
  const base = {
    rpc: async () => ({ ok: true, artifacts: [] }),
    open: () => {},
  };
  for (const action of ["list", "read"]) {
    const result = client.__test.ArtifactRow({
      ...base,
      block: {
        phase: "result",
        kind: "tool-result",
        call: { name: "artifact", argsRaw: JSON.stringify({ action }) },
        content: [{ type: "text", text: action === "list" ? "0 artifact(s):" : "<h1>x</h1>" }],
      },
    });
    assert.equal(result, null, `${action} must not render a timeline row`);
    // start 阶段拿不到解析后的 args，但 argsRaw 里有 action，也不该渲染。
    const started = client.__test.ArtifactRow({
      ...base,
      block: { phase: "start", argsRaw: JSON.stringify({ action }) },
    });
    assert.equal(started, null, `${action} (start phase) must not render a timeline row`);
  }
  const publish = client.__test.ArtifactRow({
    ...base,
    block: {
      phase: "result",
      kind: "tool-result",
      call: { name: "artifact", argsRaw: JSON.stringify({ action: "publish" }) },
      content: [{ type: "text", text: "artifact ok-abc123 · title · v1 · 3 B · html" }],
    },
  });
  assert.ok(publish, "publish/append keep their timeline row");
});

test("AUD-ARTIFACTS-03：srcDoc 渲染前注入等价 CSP meta（保留样式与图片能力）", async () => {
  const client = await loadClient();
  const { withPanelCsp, htmlFrameProps } = client.__test;
  assert.equal(typeof withPanelCsp, "function");

  const page =
    '<html><head><style>body{color:red}</style></head><body><img src="data:image/png;base64,AA"></body></html>';
  const injected = withPanelCsp(page);
  assert.match(injected, /<meta http-equiv="Content-Security-Policy" content="[^"]+">/u);
  assert.match(injected, /default-src 'none'/u);
  assert.match(injected, /style-src 'unsafe-inline'/u);
  assert.match(injected, /img-src data: blob:/u);
  // meta 必须在 </head> 之前（否则浏览器可能不生效）。
  assert.ok(injected.indexOf("Content-Security-Policy") < injected.indexOf("</head>"));
  // 原有样式/图片标记不被破坏。
  assert.ok(injected.includes("<style>body{color:red}</style>"));
  assert.ok(injected.includes('src="data:image/png;base64,AA"'));

  // 没有 <head> 的片段：meta 前置，仍是有效策略。
  const fragment = withPanelCsp("<p>hi</p>");
  assert.ok(fragment.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(fragment.endsWith("<p>hi</p>"));
  // 作者自己写了 CSP 也照样注入：多份策略取交集，不允许用一条宽松 CSP 绕过面板硬化。
  const authored =
    '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head>';
  const guarded = withPanelCsp(authored);
  assert.ok(
    guarded.startsWith(
      '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src',
    ),
    `panel CSP must stay first in <head>: ${guarded}`,
  );
  assert.ok(guarded.includes("content=\"default-src 'none'\""), "author CSP is preserved");

  // 面板真正用的 iframe 属性：srcDoc 是注入后的文档，sandbox 仍保持不透明源。
  const frame = htmlFrameProps("q3-报告-2026", "Q3 报告", page);
  assert.equal(frame["data-dsh-artifact-frame"], "q3-报告-2026");
  assert.equal(frame.sandbox, "allow-scripts");
  assert.match(frame.srcDoc, /Content-Security-Policy/u);
  assert.ok(frame.srcDoc.includes("<style>body{color:red}</style>"));
});
