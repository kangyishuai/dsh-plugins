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
      if (name.includes("ui-primitives")) return {};
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: clientPath });
  assert.ok(captured, "window.__ModuleLoader__.load was not called");
  assert.equal(captured.id, "@kangyishuai/dsh-session-rewind");
  const exported = captured.factory(sandbox.require);
  assert.ok(exported?.__test, "module.exports.__test is missing");
  return exported;
}

const client = loadClient();
const testApi = client.__test;

describe("DoubleEscape state machine", () => {
  it("returns true on the second press within the window", () => {
    const esc = new testApi.DoubleEscape(500);
    assert.equal(esc.press({ sessionId: "s1", time: 1000 }), false);
    assert.equal(esc.press({ sessionId: "s1", time: 1300 }), true);
  });

  it("resets after a successful double press", () => {
    const esc = new testApi.DoubleEscape(500);
    esc.press({ sessionId: "s1", time: 1000 });
    assert.equal(esc.press({ sessionId: "s1", time: 1200 }), true);
    assert.equal(esc.press({ sessionId: "s1", time: 1300 }), false);
  });

  it("does not fire across sessions", () => {
    const esc = new testApi.DoubleEscape(500);
    assert.equal(esc.press({ sessionId: "s1", time: 1000 }), false);
    assert.equal(esc.press({ sessionId: "s2", time: 1100 }), false);
  });

  it("does not fire outside the window", () => {
    const esc = new testApi.DoubleEscape(500);
    assert.equal(esc.press({ sessionId: "s1", time: 1000 }), false);
    assert.equal(esc.press({ sessionId: "s1", time: 2000 }), false);
    assert.equal(esc.press({ sessionId: "s1", time: 2100 }), true);
  });

  it("reset clears the pending first press", () => {
    const esc = new testApi.DoubleEscape(500);
    esc.press({ sessionId: "s1", time: 1000 });
    esc.reset();
    assert.equal(esc.press({ sessionId: "s1", time: 1100 }), false);
  });
});

describe("cutOfMarkerNode", () => {
  it("reads the rewind marker source", () => {
    const node = {
      kind: "user",
      data: { seq: 42, source: { kind: "session-rewind", targetSeq: 12 } },
    };
    assert.deepEqual(testApi.cutOfMarkerNode(node), { targetSeq: 12, markerSeq: 42 });
  });

  it("accepts steering markers too", () => {
    const node = {
      kind: "steering",
      anchorSeq: 30,
      data: { seq: 30, source: { kind: "session-rewind", targetSeq: 5 } },
    };
    assert.deepEqual(testApi.cutOfMarkerNode(node), { targetSeq: 5, markerSeq: 30 });
  });

  it("ignores ordinary user rows and other sources", () => {
    assert.equal(
      testApi.cutOfMarkerNode({ kind: "user", data: { seq: 3, source: { kind: "user" } } }),
      undefined,
    );
    assert.equal(
      testApi.cutOfMarkerNode({
        kind: "user",
        data: { seq: 3, source: { kind: "session-rewind" } },
      }),
      undefined,
    );
    assert.equal(testApi.cutOfMarkerNode({ kind: "assistant-step", data: { seq: 3 } }), undefined);
    assert.equal(testApi.cutOfMarkerNode(null), undefined);
  });
});

describe("collectCuts", () => {
  it("collects and de-duplicates marker cuts", () => {
    const nodes = [
      { kind: "user", data: { seq: 10, source: { kind: "user" } } },
      { kind: "user", data: { seq: 20, source: { kind: "session-rewind", targetSeq: 10 } } },
      { kind: "steering", data: { seq: 30, source: { kind: "session-rewind", targetSeq: 20 } } },
      { kind: "user", data: { seq: 20, source: { kind: "session-rewind", targetSeq: 10 } } },
    ];
    assert.deepEqual(testApi.collectCuts(nodes), [
      { targetSeq: 10, markerSeq: 20 },
      { targetSeq: 20, markerSeq: 30 },
    ]);
  });

  it("returns an empty list for no markers", () => {
    assert.deepEqual(
      testApi.collectCuts([{ kind: "user", data: { seq: 1, source: { kind: "user" } } }]),
      [],
    );
    assert.deepEqual(testApi.collectCuts(null), []);
  });
});

describe("inCut / hiddenNode", () => {
  const cuts = [
    { targetSeq: 10, markerSeq: 20 },
    { targetSeq: 30, markerSeq: 40 },
  ];

  it("matches inclusive bounds via anchorSeq", () => {
    assert.equal(testApi.inCut({ anchorSeq: 10 }, cuts), true);
    assert.equal(testApi.inCut({ anchorSeq: 20 }, cuts), true);
    assert.equal(testApi.inCut({ anchorSeq: 15 }, cuts), true);
    assert.equal(testApi.inCut({ anchorSeq: 25 }, cuts), false);
    assert.equal(testApi.inCut({ anchorSeq: 9 }, cuts), false);
    assert.equal(testApi.inCut({ anchorSeq: 35 }, cuts), true);
  });

  it("falls back to data.seq when anchorSeq is absent", () => {
    assert.equal(testApi.inCut({ data: { seq: 12 } }, cuts), true);
    assert.equal(testApi.inCut({ data: { seq: 99 } }, cuts), false);
  });

  it("hiddenNode shallow-copies and sets visibility", () => {
    const node = { key: "k", anchorSeq: 12, visibility: "visible", data: {} };
    const hidden = testApi.hiddenNode(node);
    assert.notEqual(hidden, node);
    assert.equal(hidden.visibility, "hidden");
    assert.equal(hidden.key, "k");
    assert.equal(hidden.anchorSeq, 12);
    // already hidden -> same reference
    assert.equal(testApi.hiddenNode(hidden), hidden);
  });
});

describe("errorTextKey", () => {
  it("maps every host code", () => {
    assert.equal(testApi.errorTextKey("session-rewind/busy"), "error.busy");
    assert.equal(testApi.errorTextKey("session-rewind/not-found"), "error.notFound");
    assert.equal(testApi.errorTextKey("session-rewind/inert"), "error.inert");
    assert.equal(testApi.errorTextKey("session-rewind/bad-target"), "error.badTarget");
    assert.equal(testApi.errorTextKey("session-rewind/not-on-surface"), "error.notOnSurface");
    assert.equal(testApi.errorTextKey("session-rewind/failed"), "error.failed");
  });

  it("accepts bare codes and falls back to generic", () => {
    assert.equal(testApi.errorTextKey("busy"), "error.busy");
    assert.equal(testApi.errorTextKey("something-else"), "error.generic");
    assert.equal(testApi.errorTextKey(undefined), "error.generic");
  });
});

describe("small helpers", () => {
  it("textOfMessage joins text blocks only", () => {
    assert.equal(
      testApi.textOfMessage({
        content: [
          { type: "text", text: "hello " },
          { type: "image", attachment: { id: "x" } },
          { type: "text", text: "world" },
        ],
      }),
      "hello world",
    );
    assert.equal(testApi.textOfMessage({}), "");
  });

  it("previewOf truncates with an ellipsis", () => {
    assert.equal(testApi.previewOf("abc", 10), "abc");
    assert.equal(testApi.previewOf("abcdefghij", 5), "abcd…");
  });

  it("relativeOf buckets by elapsed time", () => {
    const now = 1_000_000_000;
    assert.equal(testApi.relativeOf(now - 1000, now).key, "relative.justNow");
    assert.deepEqual(testApi.relativeOf(now - 5 * 60000, now), {
      key: "relative.minutes",
      params: { n: 5 },
    });
    assert.deepEqual(testApi.relativeOf(now - 3 * 3600000, now), {
      key: "relative.hours",
      params: { n: 3 },
    });
    assert.deepEqual(testApi.relativeOf(now - 2 * 86400000, now), {
      key: "relative.days",
      params: { n: 2 },
    });
  });
});

describe("module surface", () => {
  it("declares the required inject list", () => {
    // vm 里的 Array 与宿主 Array 原型不同，先转成本 realm 的数组再比较。
    assert.deepEqual(Array.from(client.inject), [
      "slots",
      "locale",
      "sessions",
      "shortcuts",
      "connection",
    ]);
  });

  it("exposes apply as a function", () => {
    assert.equal(typeof client.apply, "function");
  });

  it("keeps __test non-enumerable", () => {
    assert.equal(Object.keys(client).includes("__test"), false);
  });
});
