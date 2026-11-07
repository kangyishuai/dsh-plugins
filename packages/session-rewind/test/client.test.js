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

// ---------------------------------------------------------------------------
// v2：客户端偏好 / 预览 / 候选分页 / 抽屉数据 / 图片回填
// ---------------------------------------------------------------------------

describe("prefs (sanitizePrefs / clampInt)", () => {
  it("falls back to defaults for garbage input", () => {
    assert.deepEqual(testApi.sanitizePrefs(null), {
      defaultMode: "chat",
      pageSize: 100,
      confirmOnList: true,
    });
    assert.deepEqual(testApi.sanitizePrefs("not an object"), testApi.PREF_DEFAULTS);
    assert.deepEqual(testApi.sanitizePrefs({}), testApi.PREF_DEFAULTS);
  });

  it("keeps valid values and normalizes the mode", () => {
    assert.deepEqual(
      testApi.sanitizePrefs({ defaultMode: "both", pageSize: 50, confirmOnList: false }),
      { defaultMode: "both", pageSize: 50, confirmOnList: false },
    );
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
        restore: [{ path: "a.ts", bytes: 100 }],
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
    assert.equal(testApi.normalizeTab("settings"), "settings");
    assert.equal(testApi.normalizeTab("ghost"), "ghost");
    assert.equal(testApi.normalizeTab("nope"), "ghost");
    assert.deepEqual(testApi.DRAWER_TABS, ["ghost", "audit", "rescues", "settings"]);
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
    assert.equal(
      testApi.errorTextKey("session-rewind/storage-unavailable"),
      "error.storageUnavailable",
    );
    assert.equal(testApi.errorTextKey("session-rewind/config-invalid"), "error.configInvalid");
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
      "confirm.fileSummary",
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
      addEventListener: () => {},
      removeEventListener: () => {},
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
          const value = fixtures[name];
          if (value === undefined) {
            return {
              ok: false,
              error: { code: "session-rewind/files-conflict", message: "conflict" },
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
  assert.equal(typeof decorated?.ui?.options, "function", "commandUi.decorate was not called");
  const overlay = registrations.find((registration) => registration.entry.name === "shell.overlay");
  const element = overlay.component({ t });
  return { api: element.props.api, store: element.props.store, calls, decorated, storage };
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

    harness.api.setDrawerTab("settings");
    await flush();
    drawer = harness.store.getSnapshot().drawer;
    assert.equal(drawer.settings.health.data.ok, true);
    harness.api.updatePrefs({ defaultMode: "both", pageSize: 50 });
    assert.equal(harness.store.getSnapshot().drawer.settings.prefs.defaultMode, "both");
    assert.ok(harness.storage.get("dsh-session-rewind.prefs.v1").includes('"both"'));

    harness.api.closeDrawer();
    assert.equal(harness.store.getSnapshot().drawer.open, false);
  });

  it("serves the /rewind command decoration with candidates and opens the confirm dialog", async () => {
    const harness = applyHarness(fixtures());
    const options = await harness.decorated.ui.options({ sessionId: "s1" });
    assert.equal(options.length, 1);
    assert.equal(options[0].id, "9");
    assert.match(options[0].detail, /^\d{2}:\d{2}$/);
    harness.decorated.ui.onSelect({ id: "9" }, { sessionId: "s1" });
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
});
