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

// ---------------------------------------------------------------------------
// 确认框 / 批量执行用到的纯函数
//
// 这三条不变量是这次 UI 精简的骨架：
//   1. 影响面只拼「成立的事实」——没有 live 就不能出现 live 占位；
//   2. 批量按块切分——0.4.x 一次 RPC 全选 80 条会被宿主上限整单拒绝；
//   3. 内联词典与 locale/*.json 的键集必须完全一致（两处漂移会静默显示 key）。
// ---------------------------------------------------------------------------
describe("dialog presentation helpers", () => {
  /**
   * 用内联中文词典模拟宿主注入的 t()，只做 {name} 插值。
   * @param {string} key
   * @param {Record<string, unknown>} [values]
   * @returns {string}
   */
  const t = (key, values) => {
    /** @type {Record<string, string>} */
    const dict = client.__test.zh;
    const template = dict[key] ?? key;
    return template.replace(
      /\{(\w+)\}/g,
      (/** @type {string} */ _whole, /** @type {string} */ name) => String(values?.[name] ?? ""),
    );
  };

  it("impactLine only concatenates facts that are true", () => {
    const { impactLine } = client.__test;
    assert.equal(impactLine({}, t), "");
    assert.equal(
      impactLine({ sizeBytes: 2048 }, t),
      "约 2.0 KB",
      "a plan without children or live work must not invent empty facts",
    );
    assert.equal(
      impactLine({ sizeBytes: 2048, live: true, children: [{ id: "a" }] }, t),
      "约 2.0 KB · 1 个子会话 · 正在运行，会先停止",
    );
  });

  it("chunk splits a long selection so no single request exceeds the host bound", () => {
    const { chunk, batchChunk } = client.__test;
    assert.equal(batchChunk, 20);
    const ids = Array.from({ length: 80 }, (_, index) => `e${index}`);
    const groups = chunk(ids, batchChunk);
    assert.equal(groups.length, 4);
    assert.equal(groups[0].length, 20);
    assert.deepEqual(groups.flat(), ids);
    assert.deepEqual(chunk([], batchChunk), []);
    assert.deepEqual(
      chunk(["only"], 0),
      [["only"]],
      "a non-positive size must still make progress",
    );
  });

  it("joinList truncates long technical lists instead of growing the dialog", () => {
    const { joinList } = client.__test;
    assert.equal(joinList([{ label: "归档" }, { label: "置顶" }]), "归档 · 置顶");
    assert.equal(
      joinList(
        Array.from({ length: 9 }, (_, index) => `x${index}`),
        4,
      ),
      "x0 · x1 · x2 · x3 …",
    );
    assert.equal(joinList(undefined), "");
  });

  it("the inline dictionaries and locale/*.json agree on every key", () => {
    const { zh, en } = client.__test;
    const zhJson = JSON.parse(fs.readFileSync(path.join(here, "..", "locale", "zh.json"), "utf8"));
    const enJson = JSON.parse(fs.readFileSync(path.join(here, "..", "locale", "en.json"), "utf8"));
    assert.deepEqual(
      Object.keys(zh).sort(),
      Object.keys(zhJson.sessionDelete).sort(),
      "locale/zh.json drifted from the inline zh dictionary",
    );
    assert.deepEqual(
      Object.keys(en).sort(),
      Object.keys(enJson.sessionDelete).sort(),
      "locale/en.json drifted from the inline en dictionary",
    );
    for (const key of Object.keys(zh)) {
      assert.equal(typeof en[key], "string", `en is missing ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 批量执行与面板加载
//
// 用户实测的原始症状是「回收站 80 条，全选彻底删除没反应」：宿主单次上限 50，
// 整单被拒之后界面只留一行灰字。这两条不变量必须在没有浏览器的地方也守住：
//   1. 一次选择无论多大，都不能出现「单次请求超上限」；
//   2. 面板加载失败只能影响面板自己，不许把确认框/ toast 一起拖死。
// ---------------------------------------------------------------------------
describe("batch driver", () => {
  /** @param {Record<string, (request?: any) => any>} handlers */
  const fakeCall = (handlers) => {
    /** @type {{ method: string, request: any, count: number }[]} */
    const calls = [];
    const call = async (/** @type {string} */ method, /** @type {any} */ request) => {
      calls.push({ method, request, count: (request?.entryIds || []).length });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected call ${method}`);
      return handler(request);
    };
    return { call, calls };
  };

  it("splits 80 selected entries into chunks that never exceed the host bound", async () => {
    const { runBatch } = client.__test;
    const ids = Array.from({ length: 80 }, (_, index) => `e${index}`);
    const { call, calls } = fakeCall({
      purgeMany: (/** @type {any} */ request) => ({
        ok: true,
        total: request.entryIds.length,
        succeeded: request.entryIds.length,
        results: request.entryIds.map((/** @type {string} */ entryId) => ({ entryId, ok: true })),
      }),
    });
    /** @type {any[]} */
    const progress = [];
    const summary = await runBatch({
      ids,
      kind: "purge",
      call,
      chunkSize: 20,
      onProgress: (/** @type {any} */ state) => progress.push(state.done),
    });
    assert.equal(calls.length, 4, "80 entries must take four requests, not one rejected call");
    assert.deepEqual(
      calls.map((row) => row.count),
      [20, 20, 20, 20],
    );
    assert.equal(summary.total, 80);
    assert.equal(summary.ok, 80);
    assert.deepEqual(summary.failures, []);
    assert.equal(progress[progress.length - 1], 80, "progress must reach the total");
    assert.ok(
      progress.every((value, index) => index === 0 || value >= progress[index - 1]),
      `progress must be monotonic: ${progress.join(",")}`,
    );
  });

  it("summarises partial failures instead of aborting the rest", async () => {
    const { runBatch } = client.__test;
    const ids = ["a", "b", "c"];
    const { call } = fakeCall({
      purgeMany: (/** @type {any} */ request) => ({
        ok: false,
        total: request.entryIds.length,
        succeeded: 2,
        results: request.entryIds.map((/** @type {string} */ entryId) => ({
          entryId,
          ok: entryId !== "b",
          error: entryId === "b" ? "entry vanished" : undefined,
        })),
      }),
    });
    const summary = await runBatch({ ids, kind: "purge", call, chunkSize: 20 });
    assert.equal(summary.ok, 2);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].entryId, "b");
  });

  it("records a thrown request as per-entry failures and keeps going", async () => {
    const { runBatch } = client.__test;
    const ids = ["a", "b", "c"];
    let attempt = 0;
    const { call } = /** @type {any} */ (
      (() => {
        /** @type {any[]} */
        const calls = [];
        return {
          calls,
          call: async (/** @type {string} */ method, /** @type {any} */ request) => {
            calls.push({ method, request });
            attempt += 1;
            if (attempt === 1) throw new Error("host went away");
            return {
              ok: true,
              results: request.entryIds.map((/** @type {string} */ entryId) => ({
                entryId,
                ok: true,
              })),
            };
          },
        };
      })()
    );
    const summary = await runBatch({ ids, kind: "restore", call, chunkSize: 2 });
    assert.equal(summary.total, 3);
    // 第一批整块失败 → 2 条失败；第二批成功 → 1 条成功。
    assert.equal(summary.failures.length, 2);
    assert.equal(summary.ok, 1);
  });

  it("honours the stop request between chunks", async () => {
    const { runBatch } = client.__test;
    const ids = Array.from({ length: 10 }, (_, index) => `e${index}`);
    let done = 0;
    const { call, calls } = fakeCall({
      purgeMany: (/** @type {any} */ request) => {
        done += request.entryIds.length;
        return {
          ok: true,
          results: request.entryIds.map((/** @type {string} */ entryId) => ({ entryId, ok: true })),
        };
      },
    });
    /** @type {number[]} */
    const seen = [];
    const summary = await runBatch({
      ids,
      kind: "purge",
      call,
      chunkSize: 2,
      onProgress: (/** @type {any} */ state) => seen.push(state.done),
      // 处理完第一批之后用户点了「停止」。
      shouldStop: () => seen.length >= 1,
    });
    assert.equal(calls.length, 1, "no further chunk may start after the stop request");
    assert.equal(summary.stopped, true);
    assert.equal(summary.done, 2);
    assert.ok(done < ids.length);
  });

  it("passes the restore result session id back to the caller", async () => {
    const { runBatch } = client.__test;
    /** @type {string[]} */
    const restored = [];
    const { call } = fakeCall({
      restoreMany: (/** @type {any} */ request) => ({
        ok: true,
        results: request.entryIds.map((/** @type {string} */ entryId) => ({
          entryId,
          ok: true,
          sessionId: `session-${entryId}`,
        })),
      }),
    });
    await runBatch({
      ids: ["a", "b"],
      kind: "restore",
      call,
      chunkSize: 20,
      onRestored: (/** @type {string} */ sessionId) => restored.push(sessionId),
    });
    assert.deepEqual(restored, ["session-a", "session-b"]);
  });
});

describe("panel loader", () => {
  it("reports a failed list instead of throwing into the overlay", async () => {
    const { createPanelLoader } = client.__test;
    /** @type {any} */
    const sinks = { data: undefined, error: undefined, readOnly: false };
    const loader = createPanelLoader(
      async () => {
        throw new Error("boom");
      },
      {
        setData: (/** @type {any} */ value) => {
          sinks.data = value;
        },
        setError: (/** @type {any} */ value) => {
          sinks.error = value;
        },
      },
    );
    const value = await loader.load();
    assert.equal(value, null, "a failed load must resolve, not reject");
    assert.match(String(sinks.error), /boom/u);
  });

  it("keeps the read-only banner off when the health call fails", async () => {
    const { createPanelLoader } = client.__test;
    /** @type {any} */
    const sinks = { readOnly: false };
    const loader = createPanelLoader(
      async () => {
        throw new Error("no health");
      },
      {
        setReadOnly: (/** @type {boolean} */ value) => {
          sinks.readOnly = value;
        },
      },
    );
    await assert.doesNotReject(() => loader.loadHealth());
    assert.equal(sinks.readOnly, false, "a failed probe must not switch the panel to read-only");
  });

  it("publishes both the entry list and the read-only flag on success", async () => {
    const { createPanelLoader } = client.__test;
    const entries = [{ entryId: "e1" }];
    /** @type {any} */
    const sinks = {};
    const loader = createPanelLoader(
      async (/** @type {string} */ method) =>
        method === "list" ? { entries } : { readOnly: true },
      {
        setData: (/** @type {any} */ value) => {
          sinks.data = value;
        },
        setReadOnly: (/** @type {boolean} */ value) => {
          sinks.readOnly = value;
        },
      },
    );
    await loader.load();
    await loader.loadHealth();
    assert.deepEqual(sinks.data, { entries });
    assert.equal(sinks.readOnly, true);
  });
});
