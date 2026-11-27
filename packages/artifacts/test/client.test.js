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

/** 节点树里有没有"打开预览"按钮（info 行不该有）。 @param {any} node @returns {any} */
function findOpenButton(node) {
  if (node === null || node === undefined) return undefined;
  if (typeof node !== "object") return undefined;
  if (node?.props?.["data-dsh-artifact-open"] !== undefined) return node;
  const children = node?.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findOpenButton(child);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

test("B2：list/read 渲染紧凑中性行（整卡不消失、无预览按钮、不认领 id）", async () => {
  const client = await loadClient();
  const base = {
    rpc: async () => ({ ok: true, artifacts: [] }),
    open: () => {
      throw new Error("list/read rows must not open the preview panel");
    },
  };
  // read：显示 id + 请求的版本；没有预览按钮；不能挂成写摘要行（data-dsh-artifact-row 只属于写 action）。
  const readRow = client.__test.ArtifactRow({
    ...base,
    block: {
      phase: "result",
      kind: "tool-result",
      call: {
        name: "artifact",
        argsRaw: JSON.stringify({ action: "read", id: "q3-报告-2026", version: 2 }),
      },
      content: [{ type: "text", text: "<h1>artifact body</h1>" }],
    },
  });
  assert.equal(readRow?.props?.["data-dsh-artifact-row-info"], "read");
  assert.equal(readRow?.props?.["data-dsh-artifact-row-info-state"], "ok");
  assert.match(textOf(readRow), /Artifact/u);
  assert.match(textOf(readRow), /读取/u);
  assert.match(textOf(readRow), /q3-报告-2026 v2/u);
  assert.equal(findOpenButton(readRow), undefined, "info row must not have a preview button");
  assert.equal(readRow?.props?.["data-dsh-artifact-row"], undefined);

  // list：解析结果首行的条数，给「N 项」。
  const listRow = client.__test.ArtifactRow({
    ...base,
    block: {
      phase: "result",
      kind: "tool-result",
      call: { name: "artifact", argsRaw: JSON.stringify({ action: "list" }) },
      content: [{ type: "text", text: "3 artifact(s), 42 B total:\n- a · t · html · v1 · 1 B" }],
    },
  });
  assert.equal(listRow?.props?.["data-dsh-artifact-row-info"], "list");
  assert.match(textOf(listRow), /列表/u);
  assert.match(textOf(listRow), /3 项/u);
  assert.equal(findOpenButton(listRow), undefined);

  // 空库也有中性行（不是整卡消失）。
  const emptyRow = client.__test.ArtifactRow({
    ...base,
    block: {
      phase: "result",
      kind: "tool-result",
      call: { name: "artifact", argsRaw: JSON.stringify({ action: "list" }) },
      content: [{ type: "text", text: "No artifacts yet." }],
    },
  });
  assert.match(textOf(emptyRow), /0 项/u);

  // start 阶段只有 argsRaw：也要可见（宿主 start→result 会重渲染同一行）。
  const started = client.__test.ArtifactRow({
    ...base,
    block: { phase: "start", argsRaw: JSON.stringify({ action: "list" }) },
  });
  assert.equal(started?.props?.["data-dsh-artifact-row-info"], "list");

  // 失败信封：中性行 + 错误态（不是 null → 整卡空白）。
  for (const action of ["list", "read"]) {
    const failed = client.__test.ArtifactRow({
      ...base,
      block: {
        phase: "result",
        kind: "tool-result",
        call: { name: "artifact", argsRaw: JSON.stringify({ action, id: "gone-000000" }) },
        content: [
          { type: "text", text: "artifact failed: unknown artifact or version: gone-000000" },
        ],
        isError: true,
      },
    });
    assert.equal(failed?.props?.["data-dsh-artifact-row-info"], action);
    assert.equal(failed?.props?.["data-dsh-artifact-row-info-state"], "error");
    assert.match(textOf(failed), /失败/u);
    assert.match(textOf(failed), /unknown artifact/u);
    assert.equal(findOpenButton(failed), undefined);
  }

  // 写 action 仍是原来的摘要行（有按钮）。
  const publish = client.__test.ArtifactRow({
    ...base,
    block: {
      phase: "result",
      kind: "tool-result",
      call: { name: "artifact", argsRaw: JSON.stringify({ action: "publish" }) },
      content: [{ type: "text", text: "artifact ok-abc123 · title · v1 · 3 B · html" }],
    },
  });
  assert.equal(publish?.props?.["data-dsh-artifact-row"], "ok-abc123");
  assert.ok(findOpenButton(publish), "publish/append keep their preview button");
});

test("B1：CSP meta 注入在任何不可信字节之前；sandbox 去掉 allow-scripts（含绕过对抗用例）", async () => {
  const client = await loadClient();
  const { withPanelCsp, htmlFrameProps } = client.__test;
  const META = '<meta http-equiv="Content-Security-Policy"';
  const CSP_MARK = "Content-Security-Policy";

  // 正常文档：DOCTYPE 之后、`<html>`/`<head>` 之前；样式与图片标记不被破坏。
  const page =
    '<!DOCTYPE html>\n<html><head><style>body{color:red}</style></head><body><img src="data:image/png;base64,AA"></body></html>';
  const injected = withPanelCsp(page);
  assert.ok(injected.startsWith(`<!DOCTYPE html>${META}`), injected.slice(0, 120));
  assert.ok(injected.indexOf(CSP_MARK) < injected.indexOf("<html>"));
  for (const directive of [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    // base-uri 不在 default-src 回落范围里：必须显式写，否则产物可用 <base href> 改导航目标。
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(injected.includes(directive), `panel CSP must include ${directive}`);
  }
  assert.ok(injected.includes("<style>body{color:red}</style>"));
  assert.ok(injected.includes('src="data:image/png;base64,AA"'));

  // 没有 DOCTYPE 的片段：meta 在文档最前（BOM 之后）。
  assert.ok(withPanelCsp("<p>hi</p>").startsWith(META));
  assert.ok(withPanelCsp("\uFEFF<p>hi</p>").startsWith(`\uFEFF${META}`));

  // 对抗用例：产物在注释 / 属性值 / 脚本字符串里先写一个 `<head`，注入点也不能被带走。
  const bypasses = [
    "<!-- <head> --><html><body>x</body></html>",
    '<html><body><div title="<head>">x</div></body></html>',
    '<script>var s="<head>";</script><p>x</p>',
    "<style>/* <head> */</style><p>x</p>",
    '<!DOCTYPE html><!-- <head> --><html><body data-x="<head>">x</body></html>',
  ];
  for (const payload of bypasses) {
    const hardened = withPanelCsp(payload);
    const metaAt = hardened.indexOf(CSP_MARK);
    assert.ok(metaAt >= 0, `CSP meta missing for ${payload}`);
    // meta 必须出现在所有不可信字节之前：要么紧跟 DOCTYPE，要么就是文档开头（BOM 除外）。
    assert.ok(
      hardened.startsWith(`<!DOCTYPE html>${META}`) ||
        hardened.startsWith(`\uFEFF${META}`) ||
        hardened.startsWith(META),
      `CSP meta must be before any untrusted byte: ${hardened.slice(0, 120)}`,
    );
    assert.ok(metaAt < hardened.indexOf("<head"), `payload must not preempt the meta: ${payload}`);
  }

  // 作者自己写了 CSP 也照样注入（多份策略取交集），且我们的 meta 在最前。
  const authored =
    '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>';
  const guarded = withPanelCsp(authored);
  assert.ok(guarded.startsWith(`<!DOCTYPE html>${META}`), guarded.slice(0, 120));
  assert.ok(guarded.includes('content="default-src *"'), "author CSP is preserved");

  // 面板真正用的 iframe：sandbox 完全沙箱（脚本不可能执行，CSP 只是第二道闸）。
  const frame = htmlFrameProps("q3-报告-2026", "Q3 报告", page);
  assert.equal(frame["data-dsh-artifact-frame"], "q3-报告-2026");
  assert.equal(frame.sandbox, "");
  assert.equal(/allow-scripts/u.test(String(frame.sandbox)), false);
  assert.equal(/allow-same-origin/u.test(String(frame.sandbox)), false);
  assert.match(frame.srcDoc, /Content-Security-Policy/u);
  assert.ok(frame.srcDoc.includes("<style>body{color:red}</style>"));
});
