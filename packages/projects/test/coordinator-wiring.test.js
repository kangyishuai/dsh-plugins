// @ts-check
// B2 复审修复的单测：
//   P0  协调器工具真的注册进 agent 作用域（以前 `attachCoordinatorTools` 全仓零调用者）
//   P1-5 F17 Tasks 事件路径（冒烟里没有 todo 事件，订阅坏了也 PASS）
//   P1-6 写路径：sendToCoordinator / steerThread / selectThreadModel / createPr 的参数形状与错误信封
//   P2   协调者气泡去重
//
// 为什么能测：service.js 顶部 import 了宿主包（仓库里没有，运行时注入），node --test 里 import 不了。
// 所以注册逻辑抽到 lib/coordinator-tools.js、写路径抽到 lib/write-paths.js，这里用假 deps 驱动，
// 再用「读 service.js 源码」的守卫断言把「接上线」这件事钉死（同 pin.test.js 的做法）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { mountCoordinatorTools } from "../lib/coordinator-tools.js";
import { initialView, reduce } from "../lib/overview.js";
import {
  createPrCore,
  selectModelParams,
  selectThreadModelCore,
  sendToCoordinatorCore,
  shouldRecordCoordinatorMessage,
  steerPromptParams,
  steerThreadCore,
} from "../lib/write-paths.js";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVICE_SOURCE = readFileSync(join(PKG_DIR, "lib/service.js"), "utf8");

/** 假店：只实现这几条写路径用到的成员。 */
function fakeStore(project = { id: "p1", name: "alpha", policy: {} }) {
  /** @type {any[]} */
  const audits = [];
  const threads = new Map();
  return {
    audits,
    threads,
    getProject: (/** @type {string} */ id) => (id === project.id ? project : undefined),
    listProjects: () => [project],
    listThreads: () => [...threads.values()],
    projectOfSession: (/** @type {string} */ sessionId) =>
      threads.has(sessionId) ? project : undefined,
    appendAudit: (/** @type {any} */ entry) => {
      audits.push(entry);
      return entry;
    },
    save() {
      return this;
    },
  };
}

/** 假 sessionController：记录每次调用，便于断言形状。 */
function fakeController(overrides = {}) {
  /** @type {{ prompt: any[], selectModel: any[], state: any[], projections: any[] }} */
  const calls = { prompt: [], selectModel: [], state: [], projections: [] };
  return {
    calls,
    prompt: async (/** @type {any} */ params, /** @type {any} */ signal) => {
      calls.prompt.push({ params, signal });
      return { ok: true };
    },
    state: async (/** @type {any} */ args) => {
      calls.state.push(args);
      return { running: true };
    },
    projections: async (/** @type {any} */ args) => {
      calls.projections.push(args);
      return { modelSelection: { provider: "deepseek", model: "x", reasoningEffort: "high" } };
    },
    selectModel: async (/** @type {any} */ params, /** @type {any} */ signal) => {
      calls.selectModel.push({ params, signal });
      return { ok: true };
    },
    ...overrides,
  };
}

describe("P0 协调器工具挂载（agent 作用域）", () => {
  it("6 个 project_* 工具全部注册进 agent.ctx.tools，并回写审计", () => {
    /** @type {string[]} */
    const registered = [];
    const agent = {
      id: "s-coordinator",
      ctx: {
        tools: {
          register: (/** @type {any} */ definition) => {
            registered.push(String(definition?.name ?? ""));
            return () => {};
          },
        },
      },
    };
    /** @type {any[]} */
    const audit = [];
    const result = mountCoordinatorTools({
      agent,
      deps: {
        startThread: async () => ({ sessionId: "s1" }),
        listThreads: async () => ({ rows: [], counts: {}, attention: 0 }),
        messageThread: async () => ({ ok: true }),
        writeMemory: async () => ({ ok: true }),
        readMemory: async () => ({ instructions: "", memoryIndex: "" }),
        requestAction: async () => ({ requestId: "r1" }),
      },
      onAudit: (entry) => audit.push(entry),
    });
    assert.equal(result.attached, true);
    assert.equal(result.count, 6);
    assert.deepEqual(registered.sort(), [
      "project_memory_read",
      "project_memory_write",
      "project_request_action",
      "project_thread_list",
      "project_thread_message",
      "project_thread_start",
    ]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].attached, true);
    assert.equal(audit[0].count, 6);
  });

  it("注册失败**不抛**，转成 attached:false + reason 交给审计（宿主不显示插件日志）", () => {
    const agent = {
      id: "s-coordinator",
      ctx: {
        tools: {
          register: () => {
            throw new TypeError('tool "project_thread_start" must declare output { … }');
          },
        },
      },
    };
    /** @type {any[]} */
    const audit = [];
    const result = mountCoordinatorTools({
      agent,
      deps: /** @type {any} */ ({}),
      onAudit: (entry) => audit.push(entry),
    });
    assert.equal(result.attached, false);
    assert.equal(result.count, 0);
    assert.match(result.reason, /must declare output/u);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].attached, false);
    assert.match(String(audit[0].reason), /must declare output/u);
  });

  it("拿不到 tools 服务时也是显式失败（不是假装挂上）", () => {
    /** @type {any[]} */
    const audit = [];
    const result = mountCoordinatorTools({
      agent: { id: "s", ctx: {} },
      deps: /** @type {any} */ ({}),
      onAudit: (e) => audit.push(e),
    });
    assert.equal(result.attached, false);
    assert.equal(result.reason, "no-tools-service");
    assert.equal(audit[0].reason, "no-tools-service");
  });

  it("service 的两个入口都真的调了挂载（守卫：零调用者回归 → 红）", () => {
    // agent/created 路径
    const created = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("onAgentCreated(agent)"));
    assert.match(created.slice(0, 1200), /attachCoordinatorToolsFor\(sessionId, agent\)/u);
    // warmUpCoordinator 路径（agent 出现后重试挂载）
    const warmup = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("async warmUpCoordinator"));
    assert.match(warmup.slice(0, 2200), /attachCoordinatorToolsFor\(sessionId, agent\)/u);
    // agent 被销毁时要摘掉注册（否则作用域里留指向旧 agent 的定义）
    const disposed = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("onAgentDisposed(sessionId)"));
    assert.match(disposed.slice(0, 1200), /coordinatorToolDisposers/u);
  });
});

describe("P1-5 F17：todo/write 事件必须变成行内 tasks（订阅坏了要能红）", () => {
  it("reduce(会话事件) 后 todoItems 非空，行 tasks 才有内容", () => {
    const event = {
      type: "todo/write",
      at: 1_760_000_000_000,
      data: {
        todos: [
          { content: "改 store", status: "completed" },
          { content: "补单测", status: "in_progress" },
        ],
      },
    };
    const view = /** @type {any} */ (reduce(initialView(), event));
    assert.equal(view.todoItems.length, 2);
    assert.equal(view.todoItems[0].content, "改 store");
    assert.deepEqual(view.todos, { total: 2, done: 1 });
    // service.progress() 的行字段就是 `tasks: view.todoItems`——这里把它的来源钉住
    assert.match(
      SERVICE_SOURCE,
      /tasks: Array\.isArray\(view\.todoItems\) \? view\.todoItems : \[\]/u,
    );
  });

  it("service 订阅了 session/event 并写回线程事件（守卫）", () => {
    assert.match(SERVICE_SOURCE, /ctx\.on\?\.\("session\/event"/u);
    assert.match(SERVICE_SOURCE, /reduce\(previous, event\)/u);
    assert.match(SERVICE_SOURCE, /applyThreadEvent\(sessionId, event, next\)/u);
  });
});

describe("P1-6 写路径：参数形状 / signal 必传 / 错误信封", () => {
  it("发一句话给协调器：mode=queue、content=[{type:text}]、signal 必传", async () => {
    const store = fakeStore();
    const sc = fakeController();
    /** @type {any[]} */
    const recorded = [];
    const result = await sendToCoordinatorCore({
      store,
      sessionController: sc,
      ensureCoordinator: async () => ({ sessionId: "s-coord", created: true }),
      recordMessage: (...args) => recorded.push(args),
      projectId: "p1",
      text: "  看一下线程 1  ",
      now: () => 1_700_000_000_000,
    });
    assert.equal(result.sent, true);
    assert.equal(result.created, true);
    assert.equal(result.chars, "看一下线程 1".length);
    const sent = sc.calls.prompt[0];
    assert.equal(sent.params.mode, "queue");
    assert.equal(sent.params.sessionId, "s-coord");
    assert.equal(sent.params.requestId, "projects-coordinator-msg-1700000000000");
    assert.deepEqual(sent.params.content, [{ type: "text", text: "看一下线程 1" }]);
    assert.ok(sent.signal, "prompt 必须带 signal（宿主缺省会抛）");
    assert.equal(typeof sent.signal.aborted, "boolean");
    assert.deepEqual(recorded[0], ["p1", "user", "看一下线程 1"]);
    assert.equal(store.audits.at(-1).action, "coordinator/message");
  });

  it("steering：mode=steer，并如实回读 running；错误信封原样抛", async () => {
    assert.equal(steerPromptParams("s1", "hi", 42).mode, "steer");
    assert.deepEqual(steerPromptParams("s1", "hi", 42).content, [{ type: "text", text: "hi" }]);

    const store = fakeStore();
    store.threads.set("s1", { sessionId: "s1", projectId: "p1" });
    const sc = fakeController();
    const result = await steerThreadCore({
      store,
      sessionController: sc,
      sessionId: "s1",
      text: "快一点",
    });
    assert.equal(result.steered, true);
    assert.equal(result.running, true);
    assert.equal(sc.calls.prompt[0].params.mode, "steer");
    assert.ok(sc.calls.prompt[0].signal);
    assert.equal(store.audits.at(-1).action, "thread/steer");

    // 错误信封：空文本 / 未知线程都必须带可读前缀（client 直接显示 message）
    await assert.rejects(
      () => steerThreadCore({ store, sessionController: sc, sessionId: "s1", text: "  " }),
      /projects: steer requires text/u,
    );
    await assert.rejects(
      () => steerThreadCore({ store, sessionController: sc, sessionId: "nope", text: "x" }),
      /projects: unknown thread nope/u,
    );
    // prompt 抛错必须原样传播（不能让 UI 以为成功）
    const failing = fakeController({
      prompt: async () => {
        throw new Error("host: prompt rejected");
      },
    });
    await assert.rejects(
      () => steerThreadCore({ store, sessionController: failing, sessionId: "s1", text: "x" }),
      /host: prompt rejected/u,
    );
  });

  it("换模型：pass reasoningEffort 且回读 modelSelection；effort 为空时不带该字段", async () => {
    assert.deepEqual(selectModelParams("s1", "deepseek", "v4", "high"), {
      sessionId: "s1",
      provider: "deepseek",
      model: "v4",
      reasoningEffort: "high",
    });
    assert.deepEqual(selectModelParams("s1", "deepseek", "v4", "  "), {
      sessionId: "s1",
      provider: "deepseek",
      model: "v4",
    });

    const store = fakeStore();
    store.threads.set("s1", { sessionId: "s1", projectId: "p1" });
    const sc = fakeController();
    const result = await selectThreadModelCore({
      store,
      sessionController: sc,
      projectId: "p1",
      sessionId: "s1",
      input: { provider: "deepseek", model: "v4", reasoningEffort: "high" },
    });
    assert.deepEqual(sc.calls.selectModel[0].params, {
      sessionId: "s1",
      provider: "deepseek",
      model: "v4",
      reasoningEffort: "high",
    });
    assert.ok(sc.calls.selectModel[0].signal);
    assert.equal(result.reasoningEffort, "high");
    assert.deepEqual(result.selection, {
      provider: "deepseek",
      model: "x",
      reasoningEffort: "high",
    });
    assert.equal(store.audits.at(-1).action, "thread/model");
    assert.equal(store.audits.at(-1).reasoningEffort, "high");
  });

  it("Create PR：走 openPr、透出真实原因；openPr 没返回原因时退成 unknown（删掉调用会红）", async () => {
    const store = fakeStore({ id: "p1", name: "alpha", policy: { pr: { tier: "ready" } } });
    store.threads.set("s1", { sessionId: "s1", branch: "dsh/x", prNumber: null, ciState: null });
    /** @type {any[]} */
    const calls = [];
    const result = await createPrCore({
      store,
      openPr: async (
        /** @type {string} */ projectId,
        /** @type {string} */ sessionId,
        /** @type {any} */ options,
      ) => {
        calls.push({ projectId, sessionId, options });
        return { opened: false, decision: { action: "none", reason: "no-commits" } };
      },
      projectId: "p1",
      sessionId: "s1",
    });
    assert.deepEqual(calls, [{ projectId: "p1", sessionId: "s1", options: { tier: "ready" } }]);
    assert.equal(result.reason, "no-commits");
    assert.equal(result.tier, "ready");
    assert.equal(result.branch, "dsh/x");

    // 反向验证：不调 openPr（= 删掉那一行）只能得到 unknown —— 冒烟的 F20 断言因此会红
    const withoutOpenPr = await createPrCore({
      store,
      openPr: async () => undefined,
      projectId: "p1",
      sessionId: "s1",
    });
    assert.equal(withoutOpenPr.reason, "unknown");
  });
});

describe("P2 协调者气泡去重（乐观写 + 事件双写）", () => {
  it("同角色同文本且时间窗内 → 不写；超窗或内容不同 → 写", () => {
    const list = [{ role: "user", text: "继续", at: 10_000 }];
    assert.equal(shouldRecordCoordinatorMessage(list, "user", "继续", 10_400), false);
    assert.equal(shouldRecordCoordinatorMessage(list, "user", "继续", 20_000), true);
    assert.equal(shouldRecordCoordinatorMessage(list, "user", "换一句", 10_400), true);
    assert.equal(shouldRecordCoordinatorMessage(list, "assistant", "继续", 10_400), true);
    assert.equal(shouldRecordCoordinatorMessage([], "user", "  ", 10_000), false);
  });
});
