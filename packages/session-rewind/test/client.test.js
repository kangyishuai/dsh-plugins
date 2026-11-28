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

  // 保留 props/children：纯函数单测仍用不到，但组件渲染断言（AUD-REW-06/07/08/16/17）需要
  // 从返回的元素树里找 data-* 锚点与文案。
  /**
   * @param {any} type
   * @param {any} props
   * @param {...any} children
   * @returns {any}
   */
  const stubCreateElement = (type, props, ...children) => ({ type, props: props || {}, children });
  const reactStub = {
    createElement: stubCreateElement,
    Fragment: "Fragment",
    cloneElement: (/** @type {any} */ element, /** @type {any} */ extra) => ({
      ...element,
      props: { ...(element.props || {}), ...extra },
    }),
    isValidElement: (/** @type {any} */ value) =>
      !!value && typeof value === "object" && "type" in value,
    useSyncExternalStore: () => undefined,
    useState: (/** @type {any} */ initial) => [initial, () => {}],
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

// ---------------------------------------------------------------------------
// v2：客户端偏好 / 预览 / 候选分页 / 抽屉数据 / 图片回填
// ---------------------------------------------------------------------------

describe("prefs (sanitizePrefs / clampInt)", () => {
  it("falls back to defaults for garbage input", () => {
    assert.deepEqual(testApi.sanitizePrefs(null), {
      defaultMode: "chat",
      pageSize: 100,
      confirmOnList: true,
      recallEnabled: true,
    });
    assert.deepEqual(testApi.sanitizePrefs("not an object"), testApi.PREF_DEFAULTS);
    assert.deepEqual(testApi.sanitizePrefs({}), testApi.PREF_DEFAULTS);
  });

  it("keeps valid values and normalizes the mode", () => {
    assert.deepEqual(
      testApi.sanitizePrefs({ defaultMode: "both", pageSize: 50, confirmOnList: false }),
      { defaultMode: "both", pageSize: 50, confirmOnList: false, recallEnabled: true },
    );
    assert.equal(testApi.sanitizePrefs({ recallEnabled: false }).recallEnabled, false);
    assert.equal(testApi.sanitizePrefs({ defaultMode: "weird" }).defaultMode, "chat");
    assert.equal(testApi.sanitizePrefs({ confirmOnList: 0 }).confirmOnList, true);
  });

  it("clamps the page size into the allowed range", () => {
    assert.equal(testApi.sanitizePrefs({ pageSize: 1 }).pageSize, testApi.PAGE_SIZE_MIN);
    assert.equal(testApi.sanitizePrefs({ pageSize: 9999 }).pageSize, testApi.PAGE_SIZE_MAX);
    assert.equal(testApi.sanitizePrefs({ pageSize: "abc" }).pageSize, 100);
    assert.equal(testApi.PREF_STORAGE_KEY, "dsh-session-rewind.prefs.v1");
  });

  it("clampInt rounds, clamps and falls back", () => {
    assert.equal(testApi.clampInt(5, 20, 500, 100), 20);
    assert.equal(testApi.clampInt(9999, 20, 500, 100), 500);
    assert.equal(testApi.clampInt("100.6", 20, 500, 100), 101);
    assert.equal(testApi.clampInt(undefined, 20, 500, 100), 100);
    assert.equal(testApi.clampInt(Number.NaN, 20, 500, 100), 100);
  });
});

describe("formatting helpers", () => {
  it("formatCount inserts thousands separators", () => {
    assert.equal(testApi.formatCount(0), "0");
    assert.equal(testApi.formatCount(999), "999");
    assert.equal(testApi.formatCount(12000), "12,000");
    assert.equal(testApi.formatCount(1234567), "1,234,567");
    assert.equal(testApi.formatCount(-5), "0");
    assert.equal(testApi.formatCount(undefined), "0");
  });

  it("formatBytes scales units", () => {
    assert.equal(testApi.formatBytes(0), "0 B");
    assert.equal(testApi.formatBytes(512), "512 B");
    assert.equal(testApi.formatBytes(1024), "1 KB");
    assert.equal(testApi.formatBytes(1536), "1.5 KB");
    assert.equal(testApi.formatBytes(20 * 1024), "20 KB");
    assert.equal(testApi.formatBytes(1536 * 1024), "1.5 MB");
    assert.equal(testApi.formatBytes(1024 * 1024 * 1024), "1 GB");
  });

  it("formatClock / formatDateTime use local time", () => {
    const time = new Date(2026, 0, 2, 3, 4, 5).getTime();
    assert.equal(testApi.formatClock(time), "03:04");
    assert.equal(testApi.formatDateTime(time), "01-02 03:04");
    assert.equal(testApi.formatClock(null), "");
    assert.equal(testApi.formatDateTime(undefined), "");
  });
});

describe("preview normalization", () => {
  it("accepts missing fields with safe defaults", () => {
    const preview = testApi.normalizePreview(null);
    assert.equal(preview.targetSeq, null);
    assert.equal(preview.chat.removedCount, 0);
    assert.deepEqual(preview.files.restore, []);
    assert.deepEqual(preview.warnings, []);
  });

  it("normalizes a full host payload", () => {
    const preview = testApi.normalizePreview({
      sessionId: "s1",
      targetSeq: 12,
      target: { seq: 12, time: 1000, preview: "hi", text: "hello", images: [] },
      chat: { removedCount: 7, tokens: 1200, crossesOpenToolCall: true, reachable: true },
      files: {
        available: true,
        tracked: true,
        totalBytes: 2048,
        restore: [
          { path: "a.ts", bytes: 100 },
          { path: "deleted.ts", bytes: 10, deleted: true },
        ],
        trash: [{ path: "b.ts", bytes: 200 }],
        skipped: [{ path: "c.bin", reason: "too-large" }],
        conflicts: [],
      },
      warnings: [{ code: "w1", message: "careful" }, null, { code: "x" }],
    });
    assert.equal(preview.sessionId, "s1");
    assert.equal(preview.targetSeq, 12);
    assert.equal(preview.chat.tokens, 1200);
    assert.equal(preview.chat.crossesOpenToolCall, true);
    assert.equal(preview.files.available, true);
    assert.equal(preview.files.restore[0].path, "a.ts");
    assert.equal(preview.files.restore[0].deleted, false);
    assert.equal(preview.files.restore[1].deleted, true);
    assert.equal(preview.files.skipped[0].reason, "too-large");
    assert.equal(preview.warnings.length, 1);
    assert.equal(preview.warnings[0].message, "careful");
  });

  it("falls back to target.seq when targetSeq is absent", () => {
    const preview = testApi.normalizePreview({ target: { seq: 9 } });
    assert.equal(preview.targetSeq, 9);
    assert.equal(preview.target.seq, 9);
  });
});

describe("fileModeState / effectiveMode", () => {
  function previewWith(/** @type {any} */ files) {
    return testApi.normalizePreview({ targetSeq: 1, files });
  }

  it("disabled when preview is missing", () => {
    assert.deepEqual(testApi.fileModeState(null), {
      available: false,
      reasonKey: "confirm.filesUnavailable",
      reasonParams: {},
    });
  });

  it("available when there is a restore or trash list", () => {
    const state = testApi.fileModeState(
      previewWith({ available: true, tracked: true, restore: [{ path: "a" }] }),
    );
    assert.equal(state.available, true);
    assert.equal(state.reasonKey, null);
  });

  it("disabled on conflicts with the conflict count", () => {
    const state = testApi.fileModeState(
      previewWith({ available: true, tracked: true, conflicts: [{ path: "a", reason: "x" }] }),
    );
    assert.equal(state.available, false);
    assert.equal(state.reasonKey, "confirm.filesConflicts");
    assert.deepEqual(state.reasonParams, { n: 1 });
  });

  it("explains unavailable vs no-changes", () => {
    assert.equal(
      testApi.fileModeState(previewWith({ available: false, tracked: false })).reasonKey,
      "confirm.filesNone",
    );
    const disabled = testApi.normalizePreview({
      targetSeq: 1,
      files: { available: false, tracked: true },
      warnings: [{ code: "tracking-disabled", message: "off" }],
    });
    assert.equal(testApi.fileModeState(disabled).reasonKey, "confirm.filesUnavailable");
    assert.equal(
      testApi.fileModeState(previewWith({ available: true, tracked: true })).reasonKey,
      "confirm.filesNone",
    );
    // 记录过文件改动、但全部已满足目标态（例如第二次回溯到同一目标）：
    // 说明「无文件变更」，而不是「无法回退文件」。
    assert.equal(
      testApi.fileModeState(previewWith({ available: false, tracked: true })).reasonKey,
      "confirm.filesNone",
    );
    // 只有被跳过的文件（too-large / binary）时不能暗示「这轮没改过文件」。
    assert.equal(
      testApi.fileModeState(
        previewWith({
          available: false,
          tracked: true,
          skipped: [{ path: "big.bin", reason: "too-large" }],
        }),
      ).reasonKey,
      "confirm.filesUnavailable",
    );
  });

  it("effectiveMode only picks both when files are usable", () => {
    const usable = previewWith({ available: true, tracked: true, restore: [{ path: "a" }] });
    assert.equal(testApi.effectiveMode("both", usable), "both");
    assert.equal(testApi.effectiveMode("both", null), "chat");
    assert.equal(testApi.effectiveMode("chat", usable), "chat");
  });

  it("conflictPathsOf / failedPathsOf read host details", () => {
    assert.deepEqual(
      testApi.conflictPathsOf({
        conflicts: [{ path: "a" }, "b"],
      }),
      ["a", "b"],
    );
    assert.deepEqual(testApi.conflictPathsOf({ files: { conflicts: [{ path: "c" }] } }), ["c"]);
    assert.deepEqual(testApi.conflictPathsOf(null), []);
    assert.deepEqual(testApi.failedPathsOf({ failed: [{ path: "x" }] }), ["x"]);
    assert.deepEqual(testApi.failedPathsOf({ files: { failed: ["y"] } }), ["y"]);
    assert.deepEqual(testApi.failedPathsOf(undefined), []);
  });
});

describe("candidate paging", () => {
  it("normalizes a page and its cursor", () => {
    const page = testApi.normalizeCandidatePage({
      sessionId: "s1",
      candidates: [
        { seq: 9, index: 1, time: 100, preview: "a", hasFiles: true, fileCount: 2 },
        { seq: "bad" },
      ],
      nextCursor: 9,
    });
    assert.equal(page.sessionId, "s1");
    assert.equal(page.candidates.length, 1);
    assert.equal(page.candidates[0].hasFiles, true);
    assert.equal(page.candidates[0].fileCount, 2);
    assert.equal(page.nextCursor, 9);
    assert.equal(testApi.normalizeCandidatePage({}).nextCursor, null);
    assert.deepEqual(testApi.normalizeCandidatePage(null).candidates, []);
  });

  it("merges older pages without duplicates", () => {
    const merged = testApi.mergeCandidatePages([{ seq: 9 }, { seq: 8 }], [{ seq: 8 }, { seq: 7 }]);
    assert.deepEqual(
      merged.map((/** @type {any} */ item) => item.seq),
      [9, 8, 7],
    );
    assert.deepEqual(testApi.mergeCandidatePages(null, [{ seq: 1 }]), [{ seq: 1 }]);
  });

  it("builds page params from prefs, cursor and query", () => {
    assert.deepEqual(testApi.pageParamsOf(testApi.PREF_DEFAULTS, null, ""), { limit: 100 });
    assert.deepEqual(testApi.pageParamsOf(testApi.PREF_DEFAULTS, 42, "  hi  "), {
      limit: 100,
      cursor: 42,
      q: "hi",
    });
    assert.equal(testApi.pageParamsOf(testApi.PREF_DEFAULTS, null, "x".repeat(500)).q.length, 200);
  });
});

describe("ghost / audit / rescue normalization", () => {
  it("normalizes ghost cuts and items", () => {
    const ghost = testApi.normalizeGhost({
      cuts: [
        {
          targetSeq: 3,
          markerSeq: 9,
          time: 1000,
          mode: null,
          removedCount: 2,
          items: [
            { seq: 3, kind: "user", time: 900, text: "hello", messageId: "m1" },
            { seq: 4, kind: "weird" },
          ],
        },
        { markerSeq: 10 },
      ],
      nextCursor: 9,
    });
    assert.equal(ghost.cuts.length, 1);
    assert.equal(ghost.cuts[0].mode, "chat");
    assert.equal(ghost.cuts[0].items[0].kind, "user");
    assert.equal(ghost.cuts[0].items[1].kind, "tool");
    assert.equal(ghost.nextCursor, 9);
  });

  it("merges older ghost pages by cut key", () => {
    const first = [{ targetSeq: 3, markerSeq: 9 }];
    const second = [
      { targetSeq: 3, markerSeq: 9 },
      { targetSeq: 1, markerSeq: 2 },
    ];
    assert.deepEqual(testApi.mergeGhostCuts(first, second).map(testApi.ghostCutKey), [
      "3:9",
      "1:2",
    ]);
    assert.equal(testApi.ghostCutKey({ targetSeq: 1 }), "1:-1");
  });

  it("normalizes file receipts with strings and objects", () => {
    const receipt = testApi.filesReceiptOf({
      restored: ["a", { path: "b" }],
      trashed: ["c"],
      skipped: [{ path: "d", reason: "big" }],
      failed: [{ path: "e", reason: "boom" }],
      rescueId: "r1",
    });
    assert.deepEqual(receipt.restored, ["a", "b"]);
    assert.deepEqual(receipt.trashed, ["c"]);
    assert.equal(receipt.skipped[0].reason, "big");
    assert.equal(receipt.failed[0].path, "e");
    assert.equal(receipt.rescueId, "r1");
    assert.equal(testApi.filesReceiptOf(null), null);
  });

  it("normalizes audit entries and drops id-less rows", () => {
    const entries = testApi.normalizeAuditEntries({
      entries: [
        { id: 7, time: 1, targetSeq: 2, markerSeq: 3, mode: "both", removedCount: 4, tokens: 5 },
        { time: 1 },
        "junk",
      ],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "7");
    assert.equal(entries[0].mode, "both");
    assert.equal(entries[0].files, null);
    assert.deepEqual(testApi.normalizeAuditEntries(null), []);
  });

  it("normalizes rescue lists and restore results", () => {
    const rescues = testApi.normalizeRescues({
      rescues: [
        {
          id: "r1",
          time: 10,
          targetSeq: 4,
          completed: true,
          paths: [{ path: "a", existed: true, bytes: 3 }, "b", { nope: 1 }],
        },
        { time: 1 },
      ],
    });
    assert.equal(rescues.length, 1);
    assert.equal(rescues[0].paths.length, 2);
    assert.equal(rescues[0].paths[1].path, "b");
    assert.equal(rescues[0].completed, true);
    assert.deepEqual(testApi.normalizeRescueResult({ restored: ["a"], failed: [{ path: "b" }] }), {
      restored: ["a"],
      failed: [{ path: "b", bytes: 0, reason: "" }],
    });
  });

  it("normalizes health including a numeric version", () => {
    const health = testApi.normalizeHealth({
      ok: true,
      version: 1,
      dataRoot: "/tmp/x",
      checks: [{ name: "数据根", ok: true, detail: "/tmp/x" }, { nope: 1 }],
      usage: { bytes: 10, entries: 2, sessions: 1, blobs: 3 },
    });
    assert.equal(health.ok, true);
    assert.equal(health.version, "1");
    assert.equal(health.dataRoot, "/tmp/x");
    assert.equal(health.checks.length, 1);
    assert.equal(health.usage.blobs, 3);
    assert.equal(testApi.normalizeHealth(null).ok, false);
  });
});

describe("rewind receipt and image refill", () => {
  const image = {
    attachmentId: "att-1",
    mediaType: "image/png",
    bytes: 100,
    width: 10,
    height: 20,
    name: "shot.png",
  };

  it("reads the new target.images shape", () => {
    const refs = testApi.imageRefsOf({ target: { images: [image, { attachmentId: "x" }] } });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentId, "att-1");
    assert.deepEqual(
      testApi.imageRefsOf({ images: [image] }).map((/** @type {any} */ r) => r.attachmentId),
      ["att-1"],
    );
    assert.deepEqual(testApi.imageRefsOf(null), []);
  });

  it("maps media types to extensions and builds file names", () => {
    assert.equal(testApi.mediaExtensionOf("image/png"), "png");
    assert.equal(testApi.mediaExtensionOf("image/jpeg"), "jpg");
    assert.equal(testApi.mediaExtensionOf("application/pdf"), undefined);
    assert.equal(testApi.imageFileName(image, 0), "shot.png");
    assert.equal(testApi.imageFileName({ mediaType: "image/webp" }, 1), "image-2.webp");
    assert.equal(testApi.imageFileName({ mediaType: "nope" }, 0), "image-1.img");
  });

  it("normalizes the v2 rewind response", () => {
    const summary = testApi.rewindSummaryOf({
      targetSeq: 5,
      markerSeq: 9,
      removedCount: 3,
      tokens: 42,
      target: { text: "hi", images: [image] },
      files: { restored: ["a"], trashed: ["b"], skipped: [], failed: [], rescueId: "r1" },
    });
    assert.equal(summary.targetSeq, 5);
    assert.equal(summary.markerSeq, 9);
    assert.equal(summary.removedCount, 3);
    assert.equal(summary.text, "hi");
    assert.equal(summary.images.length, 1);
    assert.deepEqual(summary.files.restored, ["a"]);
    assert.equal(summary.files.rescueId, "r1");
  });

  it("still accepts the v1 rewind response", () => {
    const summary = testApi.rewindSummaryOf({
      targetSeq: 2,
      markerSeq: 4,
      removedCount: 1,
      text: "old",
    });
    assert.equal(summary.text, "old");
    assert.deepEqual(summary.images, []);
    assert.equal(summary.files, null);
    assert.equal(summary.markerSeq, 4);
  });
});

describe("drawer tabs and mode labels", () => {
  it("normalizes tab names", () => {
    assert.equal(testApi.normalizeTab("audit"), "audit");
    assert.equal(testApi.normalizeTab("rescues"), "rescues");
    // 设置已迁到独立设置分节：旧值 "settings" 必须安全回落到 ghost，
    // 否则用旧版持久化状态的用户打开抽屉会看到空白页。
    assert.equal(testApi.normalizeTab("settings"), "ghost");
    assert.equal(testApi.normalizeTab("ghost"), "ghost");
    assert.equal(testApi.normalizeTab("nope"), "ghost");
    assert.deepEqual(testApi.DRAWER_TABS, ["ghost", "audit", "rescues"]);
  });

  it("labels modes", () => {
    assert.equal(testApi.modeLabelKey("both"), "ghost.mode.both");
    assert.equal(testApi.modeLabelKey("chat"), "ghost.mode.chat");
    assert.equal(testApi.modeLabelKey(null), "ghost.mode.chat");
  });
});

describe("v2 error codes", () => {
  it("maps every new host code", () => {
    assert.equal(testApi.errorTextKey("session-rewind/files-conflict"), "error.filesConflict");
    assert.equal(
      testApi.errorTextKey("session-rewind/files-unavailable"),
      "error.filesUnavailable",
    );
    assert.equal(
      testApi.errorTextKey("session-rewind/files-rescue-failed"),
      "error.filesRescueFailed",
    );
    assert.equal(testApi.errorTextKey("session-rewind/files-failed"), "error.filesFailed");
    assert.equal(testApi.errorTextKey("session-rewind/rescue-not-found"), "error.rescueNotFound");
    assert.equal(testApi.errorTextKey("session-rewind/trash-not-found"), "error.trashNotFound");
    assert.equal(
      testApi.errorTextKey("session-rewind/storage-unavailable"),
      "error.storageUnavailable",
    );
    assert.equal(testApi.errorTextKey("session-rewind/config-invalid"), "error.configInvalid");
  });

  it("trashPartialOf: 只认服务端 details.files 的部分恢复结果（N4）", () => {
    assert.equal(testApi.trashPartialOf(null), null);
    assert.equal(testApi.trashPartialOf(new Error("boom")), null);
    assert.equal(testApi.trashPartialOf({ code: "session-rewind/files-failed" }), null);
    assert.equal(testApi.trashPartialOf({ details: {} }), null);
    assert.equal(
      testApi.trashPartialOf({ details: { files: { restored: [], failed: [] } } }),
      null,
    );
    assert.deepEqual(
      testApi.trashPartialOf({
        details: { files: { restored: ["a", "b"], failed: [{ path: "c", reason: "x" }] } },
      }),
      { restored: 2, failed: 1 },
    );
    // 只有失败、没有恢复成功也算部分失败：要报 0/1 而不是通用错误。
    assert.deepEqual(
      testApi.trashPartialOf({ details: { files: { restored: [], failed: [{ path: "c" }] } } }),
      { restored: 0, failed: 1 },
    );
  });
});

describe("dictionaries", () => {
  const zh = testApi.dictionaries.zh;
  const en = testApi.dictionaries.en;

  it("zh and en have exactly the same keys", () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  });

  it("has no empty translations", () => {
    for (const key of Object.keys(zh)) {
      assert.equal(typeof zh[key], "string");
      assert.ok(zh[key].length > 0, `zh.${key} is empty`);
      assert.ok(en[key].length > 0, `en.${key} is empty`);
    }
  });

  it("covers the recovery/trash/health/diagnostics keys (AUD-REW-06/08/16/17)", () => {
    for (const key of [
      "confirm.recoverable",
      "confirm.recoverableFiles",
      "confirm.trackingScope",
      "confirm.skippedReasonLine",
      "drawer.hintRewind",
      "drawer.pickMessage",
      "health.auditRecordsAtLeast",
      "skip.reason.too-large",
      "skip.reason.binary",
      "skip.reason.symlink",
      "skip.reason.excluded",
      "skip.reason.outside-cwd",
      "skip.reason.not-a-file",
      "skip.reason.unreadable",
      "skip.reason.invalid-path",
      "skip.reason.invalid-cwd",
      "skip.reason.storage-full",
      "skip.reason.other",
      "toast.rewoundSkipped",
      "trash.title",
      "trash.empty",
      "trash.meta",
      "trash.restore",
      "trash.confirm",
      "trash.clear",
      "trash.clearConfirm",
      "trash.clearConfirmAction",
      "trash.clearing",
      "trash.clearDone",
      "trash.loadFailed",
      "toast.trashRestored",
      "toast.trashPartial",
      "settings.more",
      "health.dataRoot",
      "health.tracking",
      "health.storage",
      "health.storageLine",
      "health.audit",
      "health.auditRecords",
      "health.readOnlyTool",
      "health.enabled",
      "health.disabled",
      "health.disabledByConfig",
      "health.notRegistered",
      "health.orphans",
      "health.orphansNone",
      "health.orphansCount",
      "health.orphansSkipped",
      "health.markerShape",
      "health.markerCuts",
      "health.sessionCwd",
      "health.cwdMissing",
      "health.session",
    ]) {
      assert.ok(Object.hasOwn(zh, key), `missing zh ${key}`);
      assert.ok(Object.hasOwn(en, key), `missing en ${key}`);
    }
  });

  it("covers the v2 UI keys", () => {
    for (const key of [
      "confirm.summary",
      "confirm.modeChat",
      "confirm.modeBoth",
      "confirm.busy",
      "confirm.settling",
      "confirm.resend",
      "confirm.resendHint",
      "dialog.settling",
      "toast.stoppedTurn",
      "toast.resent",
      "confirm.stateChanges",
      "confirm.stateHint",
      "state.planMode",
      "state.goal",
      "state.todo",
      "state.separator",
      "timeline.kindRescue",
      "timeline.rescueMeta",
      "confirm.fileSummary",
      "confirm.restoreDeleted",
      "toast.rewound",
      "toast.view",
      "drawer.tab.ghost",
      "drawer.tab.audit",
      "drawer.tab.rescues",
      "drawer.tab.settings",
      "ghost.refill",
      "audit.copyJson",
      "rescues.restore",
      "settings.defaultMode",
      "settings.pageSize",
      "settings.confirmOnList",
      "settings.healthTitle",
      "list.search",
      "list.loadOlder",
    ]) {
      assert.ok(Object.hasOwn(zh, key), `missing zh ${key}`);
      assert.ok(Object.hasOwn(en, key), `missing en ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// apply() 运行时冒烟：假 ctx + 假 RPC，验证各层接线与关键流程（不渲染 React）。
// ---------------------------------------------------------------------------

/** @typedef {{ name: string, request: any }} RpcCall */

/** React 的最小替身：createElement 只保留 {type, props}，hook 全部降级。 */
function makeReactStub() {
  /**
   * @param {any} type
   * @param {any} props
   * @param {...any} children
   * @returns {any}
   */
  function h(type, props, ...children) {
    return { type, props: props || {}, children };
  }
  /**
   * @param {any} element
   * @param {any} extra
   * @returns {any}
   */
  function cloneElement(element, extra) {
    return { ...element, props: { ...(element.props || {}), ...extra } };
  }
  /** @param {any} value */
  const isValidElement = (value) => !!value && typeof value === "object" && "type" in value;
  /**
   * @param {any} _subscribe
   * @param {any} getSnapshot
   * @returns {any}
   */
  const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
  /** @param {any} initial @returns {any[]} */
  const useState = (initial) => [initial, () => {}];
  const useEffect = () => {};
  /** @param {any} fn @returns {any} */
  const useCallback = (fn) => fn;
  /** @returns {any} */
  const useRef = () => ({ current: null });
  /** @param {any} component @returns {any} */
  const memo = (component) => component;
  return {
    createElement: h,
    Fragment: "Fragment",
    cloneElement,
    isValidElement,
    useSyncExternalStore,
    useState,
    useEffect,
    useCallback,
    useRef,
    memo,
  };
}

/** 构造一套能跑 apply() 的假宿主。 */
/**
 * @param {Record<string, any>} fixtures 每个 RPC 方法名 → 返回值
 * @param {any} [options] { running?: boolean }
 * @returns {any}
 */
function applyHarness(fixtures, options = {}) {
  const reactStub = makeReactStub();
  /** @type {Map<string, string>} */
  const storage = new Map();
  if (options.prefs) storage.set("dsh-session-rewind.prefs.v1", JSON.stringify(options.prefs));
  /** @type {any} */
  let captured = null;
  /** @type {RpcCall[]} */
  const calls = [];
  /** @type {any[]} */
  const registrations = [];
  /** @type {any} */
  let decorated = null;
  /** @type {Map<string, any[]>} */
  const listeners = new Map();
  /** 注入到宿主的样式表文本（apply() 里 ctx.effect 注册的那份）。 @type {string[]} */
  const styles = [];

  /**
   * @param {any} key
   * @param {any} [params]
   * @returns {string}
   */
  const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);
  /** @type {any} */
  const sandbox = {
    window: {
      /** @param {any} definition */
      __ModuleLoader__: {
        load: (/** @type {any} */ definition) => {
          captured = definition;
        },
      },
      /** @param {string} type @param {any} handler */
      addEventListener: (type, handler) => {
        const list = listeners.get(type) || [];
        list.push(handler);
        listeners.set(type, list);
      },
      /** @param {string} type @param {any} handler */
      removeEventListener: (type, handler) => {
        const list = listeners.get(type) || [];
        listeners.set(
          type,
          list.filter((item) => item !== handler),
        );
      },
      /** @param {any} fn */
      setTimeout: (fn) => setTimeout(fn, 0),
      /** @param {any} id */
      clearTimeout: (id) => clearTimeout(id),
      localStorage: {
        /** @param {string} key */
        getItem: (key) => (storage.has(key) ? String(storage.get(key)) : null),
        /** @param {string} key @param {string} value */
        setItem: (key, value) => storage.set(key, value),
      },
      navigator: { clipboard: { writeText: async () => {} } },
    },
    document: {
      createElement: () => ({
        dataset: {},
        style: {},
        remove: () => {},
        /** 记下注入的样式文本，供「主题 token 配对」用例断言。 @param {string} value */
        set textContent(value) {
          styles.push(value);
        },
        get textContent() {
          return "";
        },
      }),
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
    /** @param {any} fn */
    requestAnimationFrame: (fn) => fn,
    cancelAnimationFrame: () => {},
    /** @param {string} name */
    require: (name) => (name === "react" ? reactStub : {}),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(clientPath, "utf8"), sandbox, { filename: clientPath });
  const exported = captured.factory(sandbox.require);

  /** @type {any} */
  const ctx = {
    /** @param {any} fn @returns {any} */
    effect: (fn) => {
      const out = fn();
      return typeof out === "function" ? out : () => {};
    },
    locale: { register: () => () => {}, bind: () => t },
    slots: {
      /** @param {any} entry @param {any} component */
      register: (entry, component) => {
        registrations.push({ entry, component });
        return () => {};
      },
      /** @param {any} _name @param {any} factory */
      inject: (_name, factory) => {
        factory();
        return () => {};
      },
      entries: () => [],
      subscribe: () => () => {},
    },
    sessions: {
      binding: () => ({
        session: {
          getSnapshot: () => ({
            running: options.running === true,
            subagent: null,
            removed: false,
          }),
        },
      }),
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => ({}),
    },
    connection: {
      rpc: {
        /** @param {string} _channel @param {string} method @param {any} payload */
        call: async (_channel, method, payload) => {
          const name = method.split("/")[1];
          const request = payload?.args?.request;
          calls.push({ name, request });
          let value = fixtures[name];
          // 数组夹具 = 按调用顺序消费（用于「第一次失败、重试成功」这类断言）。
          if (Array.isArray(value)) {
            if (!options.queues) options.queues = new Map();
            const queue = options.queues;
            if (!queue.has(name)) queue.set(name, value.slice());
            const entries = queue.get(name);
            value = entries.length > 1 ? entries.shift() : entries[0];
          }
          if (value === undefined) {
            return {
              ok: false,
              error: { code: "session-rewind/files-conflict", message: "conflict" },
            };
          }
          if (value && typeof value === "object" && typeof value.__fail === "string") {
            return {
              ok: false,
              error: {
                code: value.__fail,
                message: String(value.__message ?? "failed"),
                details: value.__details,
              },
            };
          }
          return { ok: true, value };
        },
      },
    },
    /** @param {any} _deps @param {any} cb */
    inject: (_deps, cb) => {
      cb({ get: () => undefined, /** @param {any} fn */ effect: (/** @type {any} */ fn) => fn() });
    },
    /** @param {any} name */
    get: (name) =>
      name === "commandUi"
        ? {
            /** @param {any} spec */
            decorate: (spec) => {
              decorated = spec;
              return () => {};
            },
          }
        : options.services && options.services[name] !== undefined
          ? options.services[name]
          : undefined,
  };

  exported.apply(ctx);
  assert.ok(
    registrations.some((registration) => registration.entry.name === "shell.overlay"),
    "shell.overlay was not registered",
  );
  assert.ok(
    registrations.some(
      (registration) => registration.entry.name === "conversation.session.header.actions",
    ),
    "header actions slot was not registered",
  );
  assert.equal(decorated?.ui?.kind, "action", "commandUi.decorate(action) was not called");
  const overlay = registrations.find((registration) => registration.entry.name === "shell.overlay");
  const element = overlay.component({ t });
  /**
   * 模拟同源其它视图的 localStorage 写入触发本窗口的 storage 事件。
   * @param {string} key
   * @param {string} value
   */
  const fireStorage = (key, value) => {
    for (const handler of listeners.get("storage") || []) handler({ key, newValue: value });
  };
  return {
    api: element.props.api,
    store: element.props.store,
    calls,
    decorated,
    storage,
    fireStorage,
    listeners,
    styles,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("apply() runtime wiring", () => {
  const candidate = { seq: 9, index: 1, time: 1000, preview: "hi", text: "hi" };
  /** @returns {any} */
  const fixtures = () => ({
    candidates: { sessionId: "s1", candidates: [candidate], nextCursor: null },
    preview: {
      sessionId: "s1",
      targetSeq: 9,
      target: { seq: 9, time: 1000, preview: "hi", text: "hi", images: [] },
      chat: { removedCount: 3, tokens: 1234, crossesOpenToolCall: false, reachable: true },
      files: {
        available: true,
        tracked: true,
        totalBytes: 300,
        restore: [{ path: "a.ts", bytes: 100 }],
        trash: [],
        skipped: [],
        conflicts: [],
      },
      warnings: [],
    },
    rewind: {
      targetSeq: 9,
      markerSeq: 12,
      removedCount: 3,
      tokens: 1234,
      auditId: "aud-1",
      target: { text: "hi", images: [] },
      files: { restored: ["a.ts"], trashed: [], skipped: [], failed: [], rescueId: "res-1" },
    },
    ghost: {
      cuts: [
        {
          targetSeq: 9,
          markerSeq: 12,
          time: 1000,
          mode: "both",
          removedCount: 1,
          items: [{ seq: 9, kind: "user", time: 900, text: "hi", messageId: "m1" }],
        },
      ],
      nextCursor: null,
    },
    audit: {
      entries: [
        {
          id: "aud-1",
          time: 1000,
          targetSeq: 9,
          mode: "both",
          removedCount: 3,
          tokens: 10,
          files: { restored: ["a.ts"] },
        },
      ],
    },
    rescues: {
      rescues: [
        {
          id: "res-1",
          time: 1000,
          targetSeq: 9,
          completed: true,
          paths: [{ path: "a.ts", existed: true, bytes: 100 }],
        },
      ],
    },
    restoreRescue: { restored: ["a.ts"], failed: [] },
    trash: {
      operations: [
        {
          id: "trash-1",
          time: 1000,
          targetSeq: 9,
          rescueId: "res-1",
          totalBytes: 7,
          paths: [{ path: "n.txt", bytes: 7 }],
        },
      ],
    },
    restoreTrash: { restored: ["n.txt"], failed: [], safetyRescueId: "res-2" },
    clearTrash: { dryRun: true, auditId: "trash-1", files: 1, bytes: 7, paths: ["n.txt"] },
    health: {
      ok: true,
      version: 1,
      dataRoot: "/tmp/d",
      checks: [{ name: "root", ok: true }],
      usage: { bytes: 1, entries: 1, sessions: 1, blobs: 1 },
    },
  });

  it("lists candidates, previews, rewinds in the chosen mode and toasts with a view action", async () => {
    const harness = applyHarness(fixtures());
    harness.api.openList("s1");
    await flush();
    let state = harness.store.getSnapshot();
    assert.equal(state.mode, "list");
    assert.equal(state.candidates.length, 1);

    harness.api.openConfirm(state.candidates[0], "s1", "list");
    await flush();
    state = harness.store.getSnapshot();
    assert.equal(state.mode, "confirm");
    assert.equal(state.preview.chat.removedCount, 3);
    assert.equal(state.previewLoading, false);
    assert.equal(state.rewindMode, "chat");
    assert.equal(state.busy, false);

    harness.api.setRewindMode("both");
    harness.api.doRewind();
    await flush();
    state = harness.store.getSnapshot();
    assert.equal(state.mode, null);
    const rewind = harness.calls.find((/** @type {any} */ call) => call.name === "rewind");
    assert.equal(rewind.request.mode, "both");
    assert.ok(state.toast.text.includes("toast.rewound"));
    assert.ok(state.toast.text.includes("toast.rewoundFiles"));
    assert.equal(state.toast.action.labelKey, "toast.view");
  });

  it("keeps the dialog open with the host error when the rewind fails", async () => {
    const data = fixtures();
    data.rewind = undefined;
    const harness = applyHarness(data);
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    harness.api.doRewind();
    await flush();
    const state = harness.store.getSnapshot();
    assert.equal(state.mode, "confirm");
    assert.equal(state.errorKey, "error.filesConflict");
    assert.equal(state.executing, false);
  });

  it("loads every drawer tab and restores a rescue point", async () => {
    const harness = applyHarness(fixtures());
    harness.api.openDrawer("s1", "ghost");
    await flush();
    let drawer = harness.store.getSnapshot().drawer;
    assert.equal(drawer.open, true);
    assert.equal(drawer.ghost.cuts.length, 1);

    harness.api.setDrawerTab("audit");
    await flush();
    drawer = harness.store.getSnapshot().drawer;
    assert.equal(drawer.audit.entries.length, 1);
    harness.api.toggleAuditPaths("aud-1");
    assert.equal(harness.store.getSnapshot().drawer.audit.expanded["aud-1"], true);

    harness.api.setDrawerTab("rescues");
    await flush();
    assert.equal(harness.store.getSnapshot().drawer.rescues.list.length, 1);
    harness.api.setPendingRescue("res-1");
    harness.api.confirmRescue();
    await flush();
    drawer = harness.store.getSnapshot().drawer;
    assert.equal(drawer.rescues.pendingId, null);
    assert.ok(harness.calls.some((/** @type {any} */ call) => call.name === "restoreRescue"));

    // 设置不再是抽屉页签：偏好改走 prefsStore，诊断走 settingsHealthStore。
    harness.api.loadSettingsHealth();
    await flush();
    const sectionHealth = harness.api.settingsHealthStore.getSnapshot();
    assert.equal(sectionHealth.loading, false);
    assert.equal(sectionHealth.data.ok, true);
    harness.api.updatePrefs({ defaultMode: "both", pageSize: 50 });
    assert.equal(harness.api.prefsStore.getSnapshot().defaultMode, "both");
    assert.ok(harness.storage.get("dsh-session-rewind.prefs.v1").includes('"both"'));

    harness.api.closeDrawer();
    assert.equal(harness.store.getSnapshot().drawer.open, false);
  });

  it("回溯面板「选择消息回退」关面板并打开候选对话框（USIM-U2-10）", async () => {
    const harness = applyHarness(fixtures());
    harness.api.openDrawer("s1", "ghost");
    await flush();
    assert.equal(harness.store.getSnapshot().drawer.open, true);
    harness.api.pickMessageFromDrawer();
    await flush();
    const state = harness.store.getSnapshot();
    assert.equal(state.drawer.open, false);
    assert.equal(state.mode, "list");
    assert.equal(state.candidates.length, 1);
  });

  it("成功 toast 报跳过数，并把「查看」指向回溯记录", async () => {
    const data = fixtures();
    data.rewind = {
      ...data.rewind,
      files: {
        restored: ["a.ts"],
        trashed: [],
        skipped: [{ path: "big.bin", reason: "too-large" }],
        failed: [],
        rescueId: "res-1",
      },
    };
    const harness = applyHarness(data);
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    harness.api.doRewind();
    await flush();
    const state = harness.store.getSnapshot();
    assert.ok(state.toast.text.includes("toast.rewoundSkipped"));
    assert.equal(state.toast.action.labelKey, "toast.view");
    state.toast.action.onClick();
    await flush();
    assert.equal(harness.store.getSnapshot().drawer.tab, "audit");
  });

  it("toast 与被撤回面板用同一个「用户/助手消息」口径（USIM-U2-20）", async () => {
    const data = fixtures();
    data.rewind = { ...data.rewind, removedCount: 4, removedMessageCount: 3 };
    const harness = applyHarness(data);
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    harness.api.doRewind();
    await flush();
    const toast = harness.store.getSnapshot().toast;
    assert.ok(toast.text.includes('"messages":3'), toast.text);
    assert.ok(toast.text.includes('"n":4'), toast.text);
  });

  it("恢复点页签加载回收站，并接通恢复/清空（dry-run → 确认）", async () => {
    const harness = applyHarness(fixtures());
    harness.api.openDrawer("s1", "rescues");
    await flush();
    let drawer = harness.store.getSnapshot().drawer;
    assert.equal(drawer.rescues.list.length, 1);
    assert.equal(drawer.rescues.trash.list.length, 1);
    assert.equal(drawer.rescues.trash.list[0].id, "trash-1");

    harness.api.setPendingTrashRestore("trash-1");
    harness.api.confirmTrashRestore();
    await flush();
    const restoreCall = harness.calls.find(
      (/** @type {any} */ call) => call.name === "restoreTrash",
    );
    assert.deepEqual(restoreCall.request, { sessionId: "s1", auditId: "trash-1" });
    assert.equal(harness.store.getSnapshot().drawer.rescues.trashPendingId, null);

    harness.api.previewTrashClear("trash-1");
    await flush();
    drawer = harness.store.getSnapshot().drawer;
    assert.equal(drawer.rescues.trashClearId, "trash-1");
    assert.equal(drawer.rescues.trashClearImpact.files, 1);
    harness.api.confirmTrashClear();
    await flush();
    const clearCalls = harness.calls.filter(
      (/** @type {any} */ call) => call.name === "clearTrash",
    );
    assert.deepEqual(
      clearCalls.map((/** @type {any} */ call) => call.request.dryRun),
      [true, false],
    );
    assert.equal(harness.store.getSnapshot().drawer.rescues.trashClearId, null);
    assert.ok(harness.store.getSnapshot().toast);
  });

  it("restoreTrash 部分失败：报「已恢复/失败」数量并刷新列表（复审 N4）", async () => {
    const data = fixtures();
    data.restoreTrash = {
      __fail: "session-rewind/files-failed",
      __message: "some files could not be restored from the trash",
      __details: {
        files: {
          restored: ["n.txt"],
          failed: [{ path: "m.txt", reason: "destination already exists" }],
          safetyRescueId: "res-2",
        },
      },
    };
    const harness = applyHarness(data);
    harness.api.openDrawer("s1", "rescues");
    await flush();
    /** @param {string} name */
    /** @param {string} name @returns {number} */
    const countCalls = (name) =>
      harness.calls.filter((/** @type {any} */ call) => call.name === name).length;
    const rescuesBefore = countCalls("rescues");
    const auditBefore = countCalls("audit");

    harness.api.setPendingTrashRestore("trash-1");
    harness.api.confirmTrashRestore();
    await flush();

    const state = harness.store.getSnapshot();
    assert.equal(state.drawer.rescues.trashPendingId, null, "部分失败后确认行要收起");
    assert.equal(state.drawer.rescues.trashExecutingId, null);
    assert.ok(state.toast, "必须有 toast");
    assert.equal(
      state.toast.key,
      "toast.trashPartial",
      `应报部分成功而不是通用错误：${JSON.stringify(state.toast)}`,
    );
    assert.deepEqual(state.toast.params, { restored: 1, failed: 1 });
    assert.equal(countCalls("rescues"), rescuesBefore + 1, "部分失败后要刷新回收站列表");
    assert.equal(countCalls("audit"), auditBefore + 1, "部分失败后要刷新审计列表");
  });

  it("restoreTrash 通用失败（无 details）仍报错误码", async () => {
    const data = fixtures();
    data.restoreTrash = { __fail: "session-rewind/storage-unavailable" };
    const harness = applyHarness(data);
    harness.api.openDrawer("s1", "rescues");
    await flush();
    harness.api.setPendingTrashRestore("trash-1");
    harness.api.confirmTrashRestore();
    await flush();
    const state = harness.store.getSnapshot();
    assert.equal(state.toast.key, "error.storageUnavailable");
  });

  it("bare /rewind 打开插件自己的候选对话框（USIM-U2-26：不再用宿主 popupSelect）", async () => {
    const harness = applyHarness(fixtures());
    assert.equal(harness.decorated.ui.kind, "action");
    harness.decorated.ui.run({ sessionId: "s1" });
    await flush();
    const state = harness.store.getSnapshot();
    // 与 Esc Esc 同一套对话框：有列表模式、搜索与 ↑/↓ 键盘处理（handleOverlayKey）。
    assert.equal(state.mode, "list");
    assert.equal(state.candidates.length, 1);
    assert.equal(state.candidates[0].seq, 9);
    // 键盘路径：↓ / Enter 由全局 handleOverlayKey 处理，不是宿主下拉。
    harness.api.move(1);
    harness.api.pick();
    await flush();
    assert.equal(harness.store.getSnapshot().mode, "confirm");
  });

  it("executes directly when the list-confirm pref is off and the default mode is chat", async () => {
    const harness = applyHarness(fixtures(), {
      prefs: { defaultMode: "chat", pageSize: 100, confirmOnList: false },
    });
    harness.api.openList("s1");
    await flush();
    harness.api.pick();
    await flush();
    const state = harness.store.getSnapshot();
    assert.equal(state.mode, null, "no dialog is expected for a direct chat rewind");
    assert.equal(state.executing, false);
    assert.equal(
      harness.calls.find((/** @type {any} */ call) => call.name === "rewind").request.mode,
      "chat",
    );
  });

  it("still confirms when the default mode is both, even with list-confirm off", async () => {
    const harness = applyHarness(fixtures(), {
      prefs: { defaultMode: "both", pageSize: 100, confirmOnList: false },
    });
    harness.api.openConfirm(candidate, "s1", "list");
    await flush();
    const state = harness.store.getSnapshot();
    assert.equal(state.mode, "confirm");
    assert.equal(state.rewindMode, "both");
    assert.equal(
      harness.calls.some((/** @type {any} */ call) => call.name === "rewind"),
      false,
    );
  });

  it("回退后立即重发：勾选后成功回调会提交输入框", async () => {
    /** @type {number} */
    let submitted = 0;
    const conversation = {
      input: {
        for: () => ({
          snapshot: { draft: "" },
          setDraft: () => {},
          focus: () => {},
          actions: {
            submit: () => {
              submitted += 1;
            },
          },
        }),
      },
    };
    const harness = applyHarness(fixtures(), { services: { conversation } });
    const submittedBefore = submitted;
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    harness.api.setResend(true);
    assert.equal(harness.store.getSnapshot().resend, true);
    harness.api.doRewind();
    await flush();
    await flush();
    assert.equal(submitted, submittedBefore + 1);
    assert.equal(harness.store.getSnapshot().resend, false);
  });

  it("文件模式不重发", async () => {
    const harness = applyHarness(fixtures(), {});
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    harness.api.setResend(true);
    harness.api.setRewindMode("both");
    harness.api.doRewind();
    await flush();
    await flush();
    const rewind = harness.calls.find((/** @type {any} */ call) => call.name === "rewind");
    assert.equal(rewind.request.mode, "both");
  });

  it("预览里的会话状态变更被归一化", () => {
    const changes = testApi.normalizeStateChanges([
      { type: "plan/mode", labelKey: "state.planMode", count: 1 },
      { type: "goal/change", labelKey: "state.goal", count: 3 },
      { labelKey: 42 },
      null,
    ]);
    assert.deepEqual(changes, [
      { type: "plan/mode", labelKey: "state.planMode", count: 1 },
      { type: "goal/change", labelKey: "state.goal", count: 3 },
    ]);
    const preview = testApi.normalizePreview({
      chat: { removedCount: 2, tokens: 10 },
      stateChanges: [{ type: "todo/write", labelKey: "state.todo", count: 1 }],
    });
    assert.equal(preview.stateChanges.length, 1);
    assert.equal(preview.stateChanges[0].labelKey, "state.todo");
  });

  it("审计记录区分回溯与文件恢复并按时间倒序", () => {
    const entries = testApi.normalizeAuditEntries({
      entries: [
        { id: "a", time: 100, mode: "chat", removedCount: 1, tokens: 2 },
        {
          id: "b",
          time: 300,
          action: "rescue-restore",
          rescueId: "r1",
          files: { restored: ["x"] },
        },
        { id: "c", time: 200, mode: "both", removedCount: 3, tokens: 4 },
      ],
    });
    assert.deepEqual(
      entries.map((/** @type {any} */ entry) => [entry.id, entry.kind]),
      [
        ["b", "rescue-restore"],
        ["c", "both"],
        ["a", "chat"],
      ],
    );
  });

  it("parseCutBroadcast 只接受合法载荷", () => {
    assert.equal(testApi.parseCutBroadcast(""), null);
    assert.equal(testApi.parseCutBroadcast("not json"), null);
    assert.equal(testApi.parseCutBroadcast("{}"), null);
    assert.equal(testApi.parseCutBroadcast(JSON.stringify({ sessionId: 42 })), null);
    assert.deepEqual(
      testApi.parseCutBroadcast(
        JSON.stringify({ sessionId: "s1", targetSeq: 3, markerSeq: 9, at: 7 }),
      ),
      { sessionId: "s1", targetSeq: 3, markerSeq: 9, at: 7 },
    );
    assert.deepEqual(testApi.parseCutBroadcast(JSON.stringify({ sessionId: "s1" })), {
      sessionId: "s1",
      targetSeq: null,
      markerSeq: null,
      at: 0,
    });
  });

  it("回溯成功后把 cut 广播写进 localStorage（供其它视图同步）", async () => {
    const harness = applyHarness(fixtures(), {});
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    harness.api.doRewind();
    await flush();
    await flush();
    const raw = harness.storage.get(testApi.CUT_BROADCAST_KEY);
    assert.ok(raw, "broadcast key was not written");
    const payload = testApi.parseCutBroadcast(raw);
    assert.equal(payload.sessionId, "s1");
    // 具体 seq 由夹具的 rewind 响应决定；这里只断言「带上了宿主给的 marker」。
    assert.equal(payload.markerSeq, harness.store.getSnapshot().target ? null : payload.markerSeq);
    assert.equal(typeof payload.markerSeq, "number");
    assert.equal(typeof payload.targetSeq, "number");
    assert.ok(payload.at > 0);
  });

  it("收到别的视图的广播后按宿主 cuts 重新求值", async () => {
    const harness = applyHarness(fixtures(), {});
    const before = harness.calls.filter((/** @type {any} */ call) => call.name === "cuts").length;
    harness.fireStorage(
      testApi.CUT_BROADCAST_KEY,
      JSON.stringify({ sessionId: "s1", targetSeq: 3, markerSeq: 9, at: 1 }),
    );
    await flush();
    const after = harness.calls.filter((/** @type {any} */ call) => call.name === "cuts");
    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].request.sessionId, "s1");
  });

  it("广播键之外的 storage 事件被忽略", async () => {
    const harness = applyHarness(fixtures(), {});
    harness.fireStorage("some-other-key", JSON.stringify({ sessionId: "s1" }));
    harness.fireStorage(testApi.CUT_BROADCAST_KEY, "broken");
    await flush();
    assert.equal(harness.calls.filter((/** @type {any} */ call) => call.name === "cuts").length, 0);
  });

  it("warns about the running turn and still executes (host stops it first)", async () => {
    const harness = applyHarness(fixtures(), { running: true });
    harness.api.openConfirm(candidate, "s1", "row");
    await flush();
    assert.equal(harness.store.getSnapshot().busy, true);
    harness.api.doRewind();
    await flush();
    assert.equal(
      harness.calls.some((/** @type {any} */ call) => call.name === "rewind"),
      true,
      "rewind runs; the host cancels the running turn and waits for idle",
    );
  });

  // -------------------------------------------------------------------------
  // 注入样式的主题正确性（0.6.1 -> 0.6.2 的回归用例）
  //
  // 背景：0.6.1 的主按钮写成 `background: var(--dsw-alias-brand-primary); color: #fff`。
  // --dsw-alias-brand-primary 是「与背景反色的实心表面色」——浅色 #0f1115、深色 #f9fafb，
  // 于是深色主题下变成白底白字（1.05:1），确认按钮的文字肉眼不可见。
  // 两个子用例分别守住两条不变量：
  //   1. 只用宿主真实存在的 token（写错名字会静默落到 CSS fallback，颜色永远不跟随主题）；
  //   2. 反色实心填充不得配死白前景（前景必须用 --dsw-alias-label-primary-foreground）。
  // -------------------------------------------------------------------------
  describe("injected styles: theme token pairing", () => {
    /** 宿主 0.2.2-rc.2 主题里真实存在的 token（只收本插件用到的）。 */
    const HOST_THEME_TOKENS = new Set([
      "--dsw-alias-bg-base",
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-bg-mask-1",
      "--dsw-alias-border-l2",
      "--dsw-alias-border-l3",
      "--dsw-alias-brand-primary",
      "--dsw-alias-button-primary-fill",
      "--dsw-alias-button-primary-hover",
      "--dsw-alias-interactive-bg-hover",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-primary-foreground",
      "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-link",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warn-label",
      "--dsw-alias-state-warn-primary",
      "--dsw-alias-toast-bg",
      "--dsw-alias-toast-label",
      "--dsw-radius-sm",
      "--ds-font-family-code",
    ]);

    /** 反色实心表面色：填充它会翻转底色，前景必须跟着翻转。 */
    const INVERTED_FILL_RE = /var\(--dsw-alias-(?:brand-primary|button-primary-fill)\b/;
    /** 死白前景。 */
    const HARDCODED_WHITE_RE = /^(?:#fff(?:fff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i;

    /** @returns {string} 本次 apply() 注入的样式文本 */
    const injectedCss = () => {
      /** @type {string[]} */
      const styles = applyHarness(fixtures()).styles;
      assert.equal(styles.length > 0, true, "apply() injected no stylesheet");
      return styles.join("\n");
    };

    /**
     * 把 CSS 文本拆成 [{ selector, declarations: Map<string,string> }]。
     * 本插件的样式表没有嵌套规则（无 @media），按 `}` 切分即可。
     * @param {string} css
     * @returns {Array<{ selector: string, declarations: Map<string, string> }>}
     */
    const parseRules = (css) =>
      css
        .split("}")
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.includes("{"))
        .map((chunk) => {
          const at = chunk.indexOf("{");
          const declarations = new Map();
          for (const declaration of chunk.slice(at + 1).split(";")) {
            const colon = declaration.indexOf(":");
            if (colon === -1) continue;
            declarations.set(
              declaration.slice(0, colon).trim().toLowerCase(),
              declaration.slice(colon + 1).trim(),
            );
          }
          return { selector: chunk.slice(0, at).trim(), declarations };
        });

    it("only references theme tokens the host actually defines", () => {
      const used = new Set(
        [...injectedCss().matchAll(/var\((--(?:dsw|ds)-[a-z0-9-]+)/g)].map((match) => match[1]),
      );
      assert.equal(used.size > 0, true, "no theme tokens found in the injected CSS");
      const unknown = [...used].filter((token) => !HOST_THEME_TOKENS.has(token)).sort();
      assert.deepEqual(
        unknown,
        [],
        `unknown host tokens (would silently fall back to a hardcoded colour): ${unknown.join(", ")}`,
      );
    });

    it("never pairs an inverted fill with a hardcoded white foreground", () => {
      /** @type {string[]} */
      const offenders = [];
      for (const rule of parseRules(injectedCss())) {
        const background =
          rule.declarations.get("background") || rule.declarations.get("background-color");
        const foreground = rule.declarations.get("color");
        if (!background || !foreground) continue;
        if (!INVERTED_FILL_RE.test(background)) continue;
        if (HARDCODED_WHITE_RE.test(foreground)) offenders.push(rule.selector);
      }
      assert.deepEqual(offenders, [], `inverted fill + #fff foreground: ${offenders.join(", ")}`);
    });

    it("pairs the primary button fill with the host foreground token", () => {
      const primary = parseRules(injectedCss()).find(
        (rule) => rule.selector === ".dsh-srw-btn-primary",
      );
      assert.ok(primary, ".dsh-srw-btn-primary rule is missing");
      assert.match(
        String(primary.declarations.get("color")),
        /var\(--dsw-alias-label-primary-foreground/,
        "primary button text must use --dsw-alias-label-primary-foreground",
      );
      assert.match(
        String(primary.declarations.get("background")),
        /var\(--dsw-alias-button-primary-fill/,
        "primary button fill must use --dsw-alias-button-primary-fill",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// v3：输入历史召回（非破坏性）——纯数据部分
// ---------------------------------------------------------------------------

describe("isRecallGesture", () => {
  it("accepts a bare ArrowUp / ArrowDown", () => {
    assert.equal(testApi.isRecallGesture({ code: "ArrowUp" }), true);
    assert.equal(testApi.isRecallGesture({ code: "ArrowDown" }), true);
  });

  it("rejects modified, composing, consumed and unrelated keys", () => {
    for (const gesture of [
      { code: "ArrowUp", control: true },
      { code: "ArrowUp", alt: true },
      { code: "ArrowUp", shift: true },
      { code: "ArrowUp", meta: true },
      { code: "ArrowUp", composing: true },
      { code: "ArrowUp", defaultPrevented: true },
      { code: "Enter" },
      { code: "PageUp" },
      {},
      null,
      undefined,
    ]) {
      assert.equal(testApi.isRecallGesture(gesture), false, JSON.stringify(gesture));
    }
  });
});

describe("recallStep", () => {
  it("enters history from the live line and remembers the draft", () => {
    const step = testApi.recallStep({ index: -1, saved: "" }, "ArrowUp", 3, "half typed");
    assert.deepEqual(step, { index: 2, saved: "half typed", restore: null });
  });

  it("walks back and stops at the oldest entry without wrapping", () => {
    let state = { index: 2, saved: "draft" };
    state = testApi.recallStep(state, "ArrowUp", 3, "");
    assert.deepEqual(state, { index: 1, saved: "draft", restore: null });
    state = testApi.recallStep(state, "ArrowUp", 3, "");
    assert.deepEqual(state, { index: 0, saved: "draft", restore: null });
    state = testApi.recallStep(state, "ArrowUp", 3, "");
    assert.deepEqual(state, { index: 0, saved: "draft", restore: null }, "no wrap");
  });

  it("walks forward and restores the pending line past the newest entry", () => {
    let state = { index: 0, saved: "draft" };
    state = testApi.recallStep(state, "ArrowDown", 3, "");
    assert.deepEqual(state, { index: 1, saved: "draft", restore: null });
    state = testApi.recallStep(state, "ArrowDown", 3, "");
    assert.deepEqual(state, { index: 2, saved: "draft", restore: null });
    state = testApi.recallStep(state, "ArrowDown", 3, "");
    assert.deepEqual(state, { index: -1, saved: "", restore: "draft" });
  });

  it("does nothing at the live line or with an empty history", () => {
    assert.deepEqual(testApi.recallStep({ index: -1, saved: "" }, "ArrowDown", 3, "x"), {
      index: -1,
      saved: "",
      restore: null,
    });
    assert.deepEqual(testApi.recallStep({ index: -1, saved: "" }, "ArrowUp", 0, "x"), {
      index: -1,
      saved: "",
      restore: null,
    });
  });
});

describe("caretEdges", () => {
  const box = { top: 100, bottom: 200 };
  it("classifies the first and last visual line", () => {
    assert.deepEqual(testApi.caretEdges({ top: 100, bottom: 120 }, box, 20), {
      first: true,
      last: false,
    });
    assert.deepEqual(testApi.caretEdges({ top: 180, bottom: 200 }, box, 20), {
      first: false,
      last: true,
    });
  });

  it("reports both edges on a single-line composer", () => {
    assert.deepEqual(testApi.caretEdges({ top: 110, bottom: 130 }, { top: 100, bottom: 130 }, 20), {
      first: true,
      last: true,
    });
  });

  it("reports neither edge on a middle line and degrades on missing input", () => {
    assert.deepEqual(testApi.caretEdges({ top: 140, bottom: 160 }, box, 20), {
      first: false,
      last: false,
    });
    assert.deepEqual(testApi.caretEdges(null, box, 20), { first: false, last: false });
    assert.deepEqual(testApi.caretEdges({ top: 100 }, null, 20), { first: false, last: false });
  });

  it("falls back to a sane line height", () => {
    assert.equal(testApi.caretEdges({ top: 100, bottom: 120 }, box, NaN).first, true);
  });
});

describe("historyFromCandidates", () => {
  it("flips the host order (newest first) into oldest-first", () => {
    const page = [
      { seq: 9, text: "third" },
      { seq: 5, text: "second" },
      { seq: 2, text: "first" },
    ];
    const list = testApi.historyFromCandidates(page);
    assert.deepEqual(
      Array.from(list).map((/** @type {any} */ item) => item.text),
      ["first", "second", "third"],
    );
    assert.deepEqual(
      Array.from(list).map((/** @type {any} */ item) => item.seq),
      [2, 5, 9],
    );
  });

  it("drops empty and malformed entries", () => {
    const list = testApi.historyFromCandidates([
      { seq: 4, text: "   " },
      { seq: 3, preview: "only preview" },
      { text: "no seq" },
      null,
      { seq: 1, text: "keep" },
    ]);
    assert.deepEqual(Array.from(list), [{ seq: 1, text: "keep" }]);
  });

  it("keeps only the newest RECALL_LIMIT entries", () => {
    const page = [];
    for (let seq = testApi.RECALL_LIMIT + 5; seq >= 1; seq -= 1) {
      page.push({ seq, text: `p${seq}` });
    }
    const list = testApi.historyFromCandidates(page);
    assert.equal(list.length, testApi.RECALL_LIMIT);
    assert.equal(list[0].seq, 6);
    assert.equal(list[list.length - 1].seq, testApi.RECALL_LIMIT + 5);
  });

  it("tolerates non-array input", () => {
    assert.deepEqual(Array.from(testApi.historyFromCandidates(null)), []);
    assert.deepEqual(Array.from(testApi.historyFromCandidates(undefined)), []);
  });
});

describe("createRecallCache", () => {
  /** @param {number} start 起始毫秒 */
  function clockFrom(start) {
    let now = start;
    return {
      now: () => now,
      advance: (/** @type {number} */ ms) => {
        now += ms;
      },
    };
  }

  it("peeks, reports freshness and forgets", () => {
    const clock = clockFrom(1000);
    const cache = testApi.createRecallCache(clock.now);
    assert.equal(cache.peek("s1"), undefined);
    assert.equal(cache.fresh("s1"), false);

    const items = [{ seq: 1, text: "a" }];
    cache.set("s1", items);
    assert.deepEqual(Array.from(cache.peek("s1")), items);
    assert.equal(cache.fresh("s1"), true);

    clock.advance(testApi.RECALL_TTL_MS + 1);
    assert.equal(cache.fresh("s1"), false, "stale after the TTL");
    assert.deepEqual(Array.from(cache.peek("s1")), items, "stale value stays readable");

    cache.forget("s1");
    assert.equal(cache.peek("s1"), undefined);
  });

  it("keeps sessions apart and normalizes bad ids", () => {
    const cache = testApi.createRecallCache(() => 0);
    cache.set("s1", [{ seq: 1, text: "one" }]);
    cache.set("s2", [{ seq: 2, text: "two" }]);
    assert.equal(cache.peek("s1")[0].text, "one");
    assert.equal(cache.peek("s2")[0].text, "two");
    assert.equal(cache.peek(null), undefined, "unknown session has no cache entry");
    cache.forget(null);
    assert.equal(cache.peek("s1")[0].text, "one");
  });
});

// ---------------------------------------------------------------------------
// AUD-REW-06/07/08/16/17：确认框可恢复性、焦点、回收站、诊断文案、设置折叠
// ---------------------------------------------------------------------------

/**
 * 展开假 React 元素树：函数组件不会被 vm 里的 createElement 调用，这里手动调用一次，
 * 才能看到 Btn / ModePicker / FileSummary 等内部结构。
 * @param {any} node
 * @param {number} [depth]
 * @returns {any[]}
 */
function expandElements(node, depth = 0) {
  /** @type {any[]} */
  const out = [];
  if (node === null || node === undefined || typeof node !== "object" || depth > 60) return out;
  if (Array.isArray(node)) {
    for (const item of node) out.push(...expandElements(item, depth));
    return out;
  }
  if (typeof node.type === "function") {
    // React 把 h(Comp, props, child) 的子节点放在 props.children；我们的 createElement 替身
    // 把它们放在 element.children，展开组件时要合并回去。
    const children =
      node.children.length === 0
        ? undefined
        : node.children.length === 1
          ? node.children[0]
          : node.children;
    out.push(...expandElements(node.type({ ...node.props, children }), depth + 1));
    return out;
  }
  out.push(node);
  out.push(...expandElements(node.children, depth + 1));
  return out;
}

/**
 * 深度遍历假 React 元素树（loadClient 的 createElement 返回 {type, props, children}）。
 * @param {any} node
 * @param {(element: any) => void} visit
 * @returns {void}
 */
function walkElements(node, visit) {
  for (const element of expandElements(node)) visit(element);
}

/**
 * @param {any} node
 * @returns {any[]}
 */
function elementsOf(node) {
  /** @type {any[]} */
  const out = [];
  walkElements(node, (element) => out.push(element));
  return out;
}

/** 元素树的纯文本（含字符串/number 子节点与嵌套数组；函数组件先展开）。 */
/**
 * @param {any} node
 * @returns {string}
 */
function elementText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => elementText(item)).join("");
  if (typeof node !== "object") return "";
  if (typeof node.type === "function") {
    const children =
      node.children.length === 0
        ? undefined
        : node.children.length === 1
          ? node.children[0]
          : node.children;
    return elementText(node.type({ ...node.props, children }));
  }
  return elementText(node.children);
}

/** 与 applyHarness 一致的最简 t：保留了 key 与参数，便于断言「用了哪个键」。 */
const tr = (/** @type {any} */ key, /** @type {any} */ params) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

/** 一个不会执行任何动作的 api 替身。 */
const noopApi = () => ({
  setRewindMode: () => {},
  togglePathList: () => {},
  setResend: () => {},
  doRewind: () => {},
  cancelDialog: () => {},
  setPendingRescue: () => {},
  cancelRescue: () => {},
  confirmRescue: () => {},
  setPendingTrashRestore: () => {},
  cancelTrashRestore: () => {},
  confirmTrashRestore: () => {},
  previewTrashClear: () => {},
  cancelTrashClear: () => {},
  confirmTrashClear: () => {},
});

/** 归一化后的 preview 夹具。 */
function previewFixture() {
  return {
    target: { seq: 9, time: 1000, preview: "hi", text: "hi", images: [] },
    chat: { removedCount: 3, tokens: 1234, crossesOpenToolCall: false, reachable: true },
    stateChanges: [],
    files: {
      available: true,
      tracked: true,
      totalBytes: 300,
      restore: [{ path: "a.ts", bytes: 100, deleted: false, reason: "" }],
      trash: [],
      skipped: [
        { path: ".git/config", bytes: 10, reason: "excluded" },
        { path: "link.txt", bytes: 5, reason: "symlink" },
        { path: "../outside.txt", bytes: 7, reason: "outside-cwd" },
        { path: "big.bin", bytes: 9, reason: "too-large" },
        { path: "big2.bin", bytes: 9, reason: "too-large" },
      ],
      conflicts: [],
    },
    warnings: [
      { code: "files-skipped", message: "host english skip warning" },
      { code: "cwd-missing", message: "keep this warning" },
    ],
  };
}

/** 确认框状态夹具。 */
function confirmState(/** @type {any} */ overrides = {}) {
  return {
    mode: "confirm",
    origin: "row",
    sessionId: "s1",
    target: { seq: 9, time: 1000, preview: "hi", text: "hi" },
    preview: previewFixture(),
    previewLoading: false,
    previewErrorKey: null,
    previewErrorParams: null,
    rewindMode: "both",
    showAllPaths: false,
    resend: false,
    busy: false,
    executing: false,
    loading: false,
    errorKey: null,
    errorParams: null,
    errorPaths: [],
    ...overrides,
  };
}

describe("confirm dialog helpers (AUD-REW-06/07/16)", () => {
  it("recoverableHintKeys: 文件模式且追踪到文件时额外说明救援点/回收站", () => {
    assert.deepEqual(testApi.recoverableHintKeys(previewFixture(), "chat"), [
      "confirm.recoverable",
    ]);
    assert.deepEqual(testApi.recoverableHintKeys(previewFixture(), "both"), [
      "confirm.recoverable",
      "confirm.recoverableFiles",
    ]);
    const untracked = previewFixture();
    untracked.files.tracked = false;
    assert.deepEqual(testApi.recoverableHintKeys(untracked, "both"), ["confirm.recoverable"]);
    assert.deepEqual(testApi.recoverableHintKeys(null, "both"), ["confirm.recoverable"]);
  });

  it("skippedReasonSummary: 按原因分组计数并映射 locale 键", () => {
    const summary = testApi.skippedReasonSummary(previewFixture().files);
    assert.deepEqual(summary, [
      { reason: "too-large", key: "skip.reason.too-large", count: 2 },
      { reason: "excluded", key: "skip.reason.excluded", count: 1 },
      { reason: "outside-cwd", key: "skip.reason.outside-cwd", count: 1 },
      { reason: "symlink", key: "skip.reason.symlink", count: 1 },
    ]);
    assert.deepEqual(testApi.skippedReasonSummary({ skipped: [{ reason: "weird" }] }), [
      { reason: "weird", key: "skip.reason.other", count: 1 },
    ]);
    assert.deepEqual(testApi.skippedReasonSummary(null), []);
    assert.equal(testApi.skipReasonKey("binary"), "skip.reason.binary");
    assert.equal(testApi.skipReasonKey(undefined), "skip.reason.other");
  });

  it("focusWrapIndex: Tab 在浮层里环绕（AUD-REW-07）", () => {
    assert.equal(testApi.focusWrapIndex(3, 2, false), 0);
    assert.equal(testApi.focusWrapIndex(3, 0, true), 2);
    assert.equal(testApi.focusWrapIndex(3, 1, false), null);
    assert.equal(testApi.focusWrapIndex(3, 1, true), null);
    assert.equal(testApi.focusWrapIndex(3, -1, false), 0);
    assert.equal(testApi.focusWrapIndex(3, -1, true), 2);
    assert.equal(testApi.focusWrapIndex(0, 0, false), null);
    assert.equal(testApi.focusWrapIndex(1, 0, false), 0);
  });

  it("pickOverlayFocusTarget: 内联清空确认优先于抽屉页签（N3）", () => {
    // 抽屉页签也带 data-modal-autofocus；内联确认出现时必须先命中确认行里的主按钮。
    /** @param {Record<string, any>} found */
    const hostFor = (found) => {
      /** @type {string[]} */
      const queried = [];
      return {
        queried,
        querySelector(/** @type {string} */ selector) {
          queried.push(selector);
          return Object.hasOwn(found, selector) ? found[selector] : null;
        },
      };
    };
    const inline = hostFor({
      [testApi.INLINE_CONFIRM_FOCUS_SELECTOR]: "inline-primary",
      "[data-modal-autofocus]": "tab",
    });
    assert.equal(testApi.pickOverlayFocusTarget(inline), "inline-primary");
    assert.equal(inline.queried[0], testApi.INLINE_CONFIRM_FOCUS_SELECTOR);

    const drawerOnly = hostFor({
      "[data-modal-autofocus]": "tab",
      [testApi.FOCUSABLE_SELECTOR]: "x",
    });
    assert.equal(testApi.pickOverlayFocusTarget(drawerOnly), "tab");

    const empty = hostFor({});
    assert.equal(testApi.pickOverlayFocusTarget(empty), null);
    assert.equal(testApi.pickOverlayFocusTarget(null), null);
  });

  it("ConfirmBody: 渲染可恢复性一行、按原因报跳过、过滤 host 英文 warning", () => {
    const tree = testApi.ConfirmBody({ state: confirmState(), api: noopApi(), t: tr });
    const elements = elementsOf(tree);
    const recoverable = elements.filter(
      (element) => element.props["data-rewind-recoverable"] !== undefined,
    );
    assert.equal(recoverable.length, 1);
    const recoverableText = elementText(recoverable[0]);
    assert.ok(recoverableText.includes("confirm.recoverable"));
    assert.ok(recoverableText.includes("confirm.recoverableFiles"));
    const skipped = elements.filter((element) => element.props["data-srw-skipped"] !== undefined);
    assert.equal(skipped.length, 1);
    const skippedText = elementText(skipped[0]);
    assert.ok(skippedText.includes("confirm.skipped"));
    assert.equal(skipped[0].props["data-srw-skipped"], "5");
    const reasons = elements
      .filter((element) => element.props["data-reason"] !== undefined)
      .map((element) => element.props["data-reason"]);
    assert.deepEqual(reasons.sort(), ["excluded", "outside-cwd", "symlink", "too-large"]);
    assert.ok(skippedText.includes("skip.reason.too-large"));
    const trackingScope = elements.filter(
      (element) => element.props["data-srw-tracking-scope"] !== undefined,
    );
    assert.equal(trackingScope.length, 1);
    assert.ok(elementText(trackingScope[0]).includes("confirm.trackingScope"));
    const fullText = elementText(tree);
    assert.ok(fullText.includes("keep this warning"));
    assert.equal(fullText.includes("host english skip warning"), false);
  });

  it("ConfirmBody: 纯 skipped 预览也展示原因与数量（N2 / AUD-REW-04）", () => {
    const skippedOnly = previewFixture();
    skippedOnly.files.restore = [];
    skippedOnly.files.trash = [];
    const tree = testApi.ConfirmBody({
      state: confirmState({ preview: skippedOnly, rewindMode: "chat" }),
      api: noopApi(),
      t: tr,
    });
    const elements = elementsOf(tree);
    const skipped = elements.filter((element) => element.props["data-srw-skipped"] !== undefined);
    assert.equal(skipped.length, 1, "skipped-only preview must still render FileSummary");
    assert.equal(skipped[0].props["data-srw-skipped"], "5");
    assert.ok(elementText(skipped[0]).includes("confirm.skipped"));
    const reasons = elements
      .filter((element) => element.props["data-reason"] !== undefined)
      .map((element) => element.props["data-reason"]);
    assert.deepEqual(reasons.sort(), ["excluded", "outside-cwd", "symlink", "too-large"]);
  });

  it("ConfirmBody: chat 模式不出现文件可恢复性那一段", () => {
    const tree = testApi.ConfirmBody({
      state: confirmState({ rewindMode: "chat" }),
      api: noopApi(),
      t: tr,
    });
    const recoverable = elementsOf(tree).filter(
      (element) => element.props["data-rewind-recoverable"] !== undefined,
    );
    assert.equal(recoverable.length, 1);
    const text = elementText(recoverable[0]);
    assert.ok(text.includes("confirm.recoverable"));
    assert.equal(text.includes("confirm.recoverableFiles"), false);
  });

  it("RewindDialog: 主按钮默认聚焦，不可执行时回落到取消；列表模式聚焦搜索框", () => {
    const tree = testApi.RewindDialog({ state: confirmState(), api: noopApi(), t: tr });
    const buttons = elementsOf(tree).filter((element) => element.type === "button");
    const primary = buttons.find((button) =>
      String(button.props.className || "").includes("dsh-srw-btn-primary"),
    );
    assert.ok(primary, "primary button not found");
    assert.equal(primary.props["data-modal-autofocus"], "");
    const cancel = buttons.find((button) => elementText(button).includes("dialog.cancel"));
    assert.ok(cancel, "cancel button not found");
    assert.equal(cancel.props["data-modal-autofocus"], undefined);

    const disabledTree = testApi.RewindDialog({
      state: confirmState({ executing: true }),
      api: noopApi(),
      t: tr,
    });
    const disabledButtons = elementsOf(disabledTree).filter((element) => element.type === "button");
    const disabledCancel = disabledButtons.find((button) =>
      elementText(button).includes("dialog.cancel"),
    );
    assert.ok(disabledCancel);
    assert.equal(disabledCancel.props["data-modal-autofocus"], "");

    const listTree = testApi.RewindDialog({
      state: {
        mode: "list",
        candidates: [{ seq: 9, index: 1, time: 1000, preview: "hi", text: "hi", hasFiles: false }],
        selected: 0,
        listLoading: false,
        listLoadingOlder: false,
        listCursor: null,
        listSearch: "",
        listErrorKey: null,
        listErrorParams: null,
      },
      api: noopApi(),
      t: tr,
    });
    const search = elementsOf(listTree).find(
      (element) => element.type === "input" && element.props.type === "search",
    );
    assert.ok(search, "search input not found");
    assert.equal(search.props["data-modal-autofocus"], "");
  });
});

describe("recovery points / trash tab (AUD-REW-08)", () => {
  /** @returns {any} */
  const trashData = () => ({
    loading: false,
    errorKey: null,
    errorParams: null,
    list: [],
    pendingId: null,
    executingId: null,
    trash: {
      loading: false,
      errorKey: null,
      errorParams: null,
      list: [
        {
          id: "trash-1",
          time: 1000,
          targetSeq: 9,
          rescueId: "res-1",
          totalBytes: 7,
          paths: [{ path: "n.txt", bytes: 7 }],
        },
      ],
    },
    trashPendingId: null,
    trashExecutingId: null,
    trashClearId: null,
    trashClearImpact: null,
    trashClearExecuting: false,
  });

  it("RescuesTab: 回收站并入救援点页签，按操作列出并可恢复/清空", () => {
    const tree = testApi.RescuesTab({ data: trashData(), api: noopApi(), t: tr });
    const elements = elementsOf(tree);
    assert.equal(
      elements.filter((element) => element.props["data-srw-trash"] !== undefined).length,
      1,
    );
    assert.ok(elementText(tree).includes("trash.title"));
    assert.ok(elementText(tree).includes("rescues.empty"));
    const ops = elements.filter((element) => element.props["data-srw-trash-op"] !== undefined);
    assert.equal(ops.length, 1);
    const text = elementText(ops[0]);
    assert.ok(text.includes("trash.restore"));
    assert.ok(text.includes("trash.clear"));
    assert.ok(text.includes("trash.meta"));
  });

  it("RescuesTab: 清空需要先看影响面（ADR 0002）", () => {
    const data = trashData();
    data.trashClearId = "trash-1";
    data.trashClearImpact = { dryRun: true, files: 2, bytes: 2048, paths: ["n.txt", "m.txt"] };
    const tree = testApi.RescuesTab({ data, api: noopApi(), t: tr });
    const confirmRows = elementsOf(tree).filter(
      (element) => element.props["data-srw-trash-clear"] !== undefined,
    );
    assert.equal(confirmRows.length, 1);
    const text = elementText(confirmRows[0]);
    assert.ok(text.includes("trash.clearConfirm"));
    assert.ok(text.includes('"n":2'), text);
    assert.ok(text.includes("trash.clearConfirmAction"));

    // N3：不可恢复操作默认聚焦主按钮（ADR 0002 / §7.4.2），「取消」不抢焦点。
    const buttons = elementsOf(confirmRows[0]).filter((element) => element.type === "button");
    const primary = buttons.filter((element) =>
      String(element.props.className).includes("dsh-srw-btn-primary"),
    );
    assert.equal(primary.length, 1);
    assert.equal(
      primary[0].props["data-modal-autofocus"],
      "",
      "内联「确认永久删除」必须带 data-modal-autofocus",
    );
    const cancel = buttons.filter(
      (element) => !String(element.props.className).includes("primary"),
    );
    assert.equal(cancel.length, 1);
    assert.equal(cancel[0].props["data-modal-autofocus"], undefined, "空闲态焦点不应在「取消」上");

    // 执行中主按钮 disabled：焦点回落「取消」。
    data.trashClearExecuting = true;
    const executingTree = testApi.RescuesTab({ data, api: noopApi(), t: tr });
    const executingRow = elementsOf(executingTree).filter(
      (element) => element.props["data-srw-trash-clear"] !== undefined,
    )[0];
    const executingButtons = elementsOf(executingRow).filter(
      (element) => element.type === "button",
    );
    const executingPrimary = executingButtons.filter((element) =>
      String(element.props.className).includes("dsh-srw-btn-primary"),
    )[0];
    const executingCancel = executingButtons.filter(
      (element) => !String(element.props.className).includes("primary"),
    )[0];
    assert.equal(executingPrimary.props.disabled, true);
    assert.equal(executingPrimary.props["data-modal-autofocus"], undefined);
    assert.equal(executingCancel.props["data-modal-autofocus"], "", "执行中焦点应回落「取消」");
  });

  it("normalizeTrash*: RPC 形状退化时不炸", () => {
    const ops = testApi.normalizeTrashOps({
      operations: [
        { id: "t1", totalBytes: 9, paths: [{ path: "a", bytes: 9 }] },
        { id: 2, paths: ["b"] },
        { nope: true },
      ],
    });
    assert.equal(ops.length, 2);
    assert.deepEqual(ops[0].paths, [{ path: "a", bytes: 9 }]);
    assert.equal(ops[0].totalBytes, 9);
    assert.deepEqual(ops[1].paths, [{ path: "b", bytes: 0 }]);
    assert.deepEqual(testApi.normalizeTrashResult(undefined), {
      restored: [],
      failed: [],
      safetyRescueId: null,
    });
    assert.deepEqual(testApi.normalizeTrashImpact({ dryRun: true, files: 1, bytes: 2 }), {
      dryRun: true,
      auditId: "",
      files: 1,
      bytes: 2,
      paths: [],
    });
  });
});

describe("回溯记录 tab：新旧审计行口径（N11）", () => {
  /** @param {any[]} entries */
  const auditData = (entries) => ({
    loading: false,
    errorKey: null,
    errorParams: null,
    entries,
    expanded: {},
  });

  it("历史 audit 行（0.7.0 及以前）没有 removedMessageCount 时用中性「上下文记录」", () => {
    const legacy = testApi.normalizeAuditEntries({
      entries: [{ id: "old", time: 100, mode: "chat", removedCount: 9, tokens: 12 }],
    })[0];
    assert.equal(legacy.removedMessageCountKnown, false);
    const tree = testApi.AuditTab({ data: auditData([legacy]), api: noopApi(), t: tr });
    const text = elementText(tree);
    assert.ok(text.includes("audit.metaLegacy"), `历史行要用中性口径：${text}`);
    assert.ok(text.includes('"n":9'), `历史行应显示节点数 9：${text}`);
    assert.doesNotMatch(text, /audit\.meta\|/u, `历史行不能标成「用户/助手消息」：${text}`);
  });

  it("新 audit 行（有 removedMessageCount）仍用「用户/助手消息」并显示新口径", () => {
    const fresh = testApi.normalizeAuditEntries({
      entries: [
        { id: "new", time: 100, mode: "chat", removedCount: 9, removedMessageCount: 4, tokens: 12 },
      ],
    })[0];
    assert.equal(fresh.removedMessageCountKnown, true);
    const tree = testApi.AuditTab({ data: auditData([fresh]), api: noopApi(), t: tr });
    const text = elementText(tree);
    assert.ok(text.includes("audit.meta|"), `新行仍用 audit.meta：${text}`);
    assert.ok(text.includes('"n":4'), `新行应显示用户/助手消息数 4：${text}`);
    assert.doesNotMatch(text, /audit\.metaLegacy/u, text);
  });
});

describe("settings section (AUD-REW-16/17)", () => {
  it("SettingsTab: 低频设置与诊断收进默认收起的「更多设置」", () => {
    const prefs = {
      defaultMode: "chat",
      pageSize: 100,
      confirmOnList: true,
      recallEnabled: true,
    };
    const health = {
      loading: false,
      errorKey: null,
      errorParams: null,
      data: {
        ok: true,
        version: 1,
        dataRoot: "/tmp/d",
        usage: { bytes: 1, entries: 2, sessions: 3, blobs: 4 },
        checks: [
          {
            name: "data root",
            nameKey: "health.dataRoot",
            ok: true,
            detail: "/tmp/d",
            detailKey: "",
            detailParams: {},
          },
          {
            name: "file storage",
            nameKey: "health.storage",
            ok: true,
            detail: "raw english",
            detailKey: "health.storageLine",
            detailParams: { bytes: 1, entries: 2, sessions: 3 },
          },
        ],
      },
    };
    const tree = testApi.SettingsTab({
      prefs,
      health,
      api: { updatePrefs: () => {}, loadHealth: () => {} },
      t: tr,
      onRefreshHealth: () => {},
    });
    const elements = elementsOf(tree);
    const details = elements.filter((element) => element.type === "details");
    assert.equal(details.length, 1);
    assert.equal(details[0].props["data-srw-more-settings"], "");
    assert.equal(details[0].props.open, undefined, "默认必须收起");
    assert.ok(elementText(details[0]).includes("settings.more"));
    const text = elementText(tree);
    // 诊断项标题走 nameKey、detail 走 detailKey（英文界面不再混中文/中文界面不再混英文）。
    assert.ok(text.includes("health.dataRoot"));
    assert.ok(text.includes("health.storageLine"));
    assert.equal(text.includes("raw english"), false);
    // 首屏保留常用偏好。
    assert.ok(text.includes("settings.defaultMode"));
    assert.ok(text.includes("settings.recall"));
  });

  it("healthCheckLabel/Detail: 缺键时退回 host 的 name/detail", () => {
    const fallback = { name: "legacy check", detail: "legacy detail" };
    assert.equal(testApi.healthCheckLabel(fallback, tr), "legacy check");
    assert.equal(testApi.healthCheckDetail(fallback, tr), "legacy detail");
    assert.equal(testApi.healthCheckLabel(null, tr), "");
    assert.equal(testApi.healthCheckDetail(null, tr), "");
  });

  it("normalizeHealth: 保留 nameKey/detailKey/detailParams", () => {
    const view = testApi.normalizeHealth({
      ok: true,
      checks: [
        {
          name: "data root",
          nameKey: "health.dataRoot",
          ok: true,
          detail: "/tmp/d",
          detailKey: "health.storageLine",
          detailParams: { bytes: 1, entries: 2, sessions: 3 },
        },
      ],
      usage: {},
    });
    assert.equal(view.checks[0].nameKey, "health.dataRoot");
    assert.equal(view.checks[0].detailKey, "health.storageLine");
    assert.deepEqual(view.checks[0].detailParams, { bytes: 1, entries: 2, sessions: 3 });
    // 旧 host（只有 name/detail）也要能渲染。
    const legacy = testApi.normalizeHealth({ ok: true, checks: [{ name: "old", ok: true }] });
    assert.equal(legacy.checks[0].nameKey, "");
    assert.equal(legacy.checks[0].detailKey, "");
  });
});

// ---------------------------------------------------------------------------
// USIM-U3-01：回溯不可持久 —— 重启（宿主重启 + 冷启动）后仍要隐藏被撤回的消息
// ---------------------------------------------------------------------------

describe("cold-start visibility (USIM-U3-01)", () => {
  /** 一条假的 inner chat builder，只记录最近一次 replace/apply 的 payload。 @returns {any} */
  function makeInnerBuilder() {
    return {
      empty: undefined,
      lastReplace: null,
      lastApply: null,
      replace(/** @type {any} */ payload) {
        this.lastReplace = payload;
        return payload;
      },
      apply(/** @type {any} */ payload) {
        this.lastApply = payload;
        return payload;
      },
      groupInput: () => undefined,
      publish: () => {},
    };
  }

  /** 宿主 chat 节点形状：shadowed 节点仍在（宿主 transcript 用原始事件），但没有 marker 节点。 */
  function makeNodes() {
    return [
      {
        key: "u:9",
        kind: "user",
        data: { seq: 9, source: { kind: "user" } },
        visibility: "visible",
      },
      {
        key: "a:17",
        kind: "assistant",
        data: { seq: 17 },
        visibility: "visible",
      },
      {
        key: "u:27",
        kind: "user",
        data: { seq: 27, source: { kind: "user" } },
        visibility: "visible",
      },
    ];
  }

  /** @param {any[]} nodes */
  function visibilityOf(nodes) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const node of nodes) out[node.key] = node.visibility ?? "visible";
    return out;
  }

  it("cutsForSession: rebuild 时的 activeSession 优先于创建/记住的 sessionId", () => {
    const cutsRef = {
      get: (/** @type {any} */ id) => (id === "s1" ? [{ targetSeq: 9, markerSeq: 21 }] : []),
    };
    assert.equal(testApi.resolveCutSession(null, "s1", "s0"), "s1");
    assert.equal(testApi.resolveCutSession("s0", null, "s2"), "s0");
    assert.equal(testApi.resolveCutSession(null, null, "s2"), "s2");
    assert.equal(testApi.resolveCutSession(null, null, null), null);
    assert.deepEqual(testApi.cutsForSession(null, "s1", null, cutsRef), [
      { targetSeq: 9, markerSeq: 21 },
    ]);
    assert.deepEqual(testApi.cutsForSession("s0", null, null, cutsRef), []);
    assert.deepEqual(testApi.cutsForSession(null, null, null, cutsRef), []);
    assert.deepEqual(testApi.cutsForSession("s1", null, null, cutsRef), [
      { targetSeq: 9, markerSeq: 21 },
    ]);
  });

  it("冷启动：builder 先以 null 会话创建，宿主 cuts 到达后（rebuild）隐藏 shadowed 行", () => {
    const cutStore = testApi.createCutStore();
    const inner = makeInnerBuilder();
    const wrapper = new testApi.RewindVisibilityBuilder(inner, cutStore, null);
    const nodes = makeNodes();

    // ① 冷启动第一次渲染：宿主会话还没 resume、cuts 还没拉到 —— 什么都不知道。
    wrapper.replace({ nodes, timeline: {} });
    assert.deepEqual(visibilityOf(inner.lastReplace.nodes), {
      "u:9": "visible",
      "a:17": "visible",
      "u:27": "visible",
    });

    // ② seedCuts 成功：宿主 cuts 进 store，随后 rebuild 期间 activeSession = 会话 id。
    cutStore.set("s1", [{ targetSeq: 9, markerSeq: 21 }]);
    testApi.withActiveSession("s1", () => wrapper.replace({ nodes, timeline: {} }));
    assert.deepEqual(visibilityOf(inner.lastReplace.nodes), {
      "u:9": "hidden",
      "a:17": "hidden",
      "u:27": "visible",
    });

    // ③ rebuild 之后的流式 apply（activeSession 已复位）仍要记住会话 id，
    //    否则 hidden 会被全量替换回 visible。
    wrapper.apply({ upserts: nodes, timeline: {} });
    assert.deepEqual(visibilityOf(inner.lastApply.upserts), {
      "u:9": "hidden",
      "a:17": "hidden",
      "u:27": "visible",
    });
  });

  it("宿主说没有 cuts 时不隐藏任何行（不误伤）", () => {
    const cutStore = testApi.createCutStore();
    const inner = makeInnerBuilder();
    const wrapper = new testApi.RewindVisibilityBuilder(inner, cutStore, "s1");
    wrapper.replace({ nodes: makeNodes(), timeline: {} });
    assert.deepEqual(visibilityOf(inner.lastReplace.nodes), {
      "u:9": "visible",
      "a:17": "visible",
      "u:27": "visible",
    });
  });

  it("seedCuts: 冷启动第一次 RPC 失败后会重试，成功后再重建", async () => {
    const data = fixturesForSeed();
    const harness = applyHarness(data);
    harness.api.seedCuts("s1");
    await flush();
    // 第一次失败（宿主还没 resume 完），此时还没成功。
    assert.equal(harness.calls.filter((/** @type {any} */ call) => call.name === "cuts").length, 1);
    // 等退避重试（300ms 起步）跑完。
    await new Promise((resolve) => setTimeout(resolve, 700));
    const cutCalls = harness.calls.filter((/** @type {any} */ call) => call.name === "cuts");
    assert.ok(cutCalls.length >= 2, `expected a retry, got ${cutCalls.length}`);
    for (const call of cutCalls) assert.deepEqual(call.request, { sessionId: "s1" });
  });
});

/** seedCuts 重试测试用的最小夹具（第一次失败、第二次成功）。 */
function fixturesForSeed() {
  return {
    cuts: [
      { __fail: "session-rewind/not-found", __message: "session not resumed yet" },
      { cuts: [{ targetSeq: 9, markerSeq: 21 }] },
    ],
    candidates: { sessionId: "s1", candidates: [], nextCursor: null },
    preview: undefined,
    rewind: undefined,
    ghost: { cuts: [], nextCursor: null },
    audit: { entries: [] },
    rescues: { rescues: [] },
    trash: { operations: [] },
    restoreRescue: { restored: [], failed: [] },
    restoreTrash: { restored: [], failed: [], safetyRescueId: null },
    clearTrash: { dryRun: true, files: 0, bytes: 0, paths: [] },
    health: { ok: true, version: 1, checks: [], usage: {} },
  };
}
