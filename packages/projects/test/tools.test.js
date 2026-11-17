// @ts-check
// 协调器工具单测：定义形状、执行映射、危险动作只能申请、白名单与原因校验。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCoordinatorTools,
  pickTools,
  REQUESTABLE_ACTIONS,
  requestAction,
} from "../lib/tools.js";

/** 假依赖：记录调用，便于断言工具到底做了什么。 */
function fakeDeps() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    startThread: async (/** @type {string} */ task) => {
      calls.push({ kind: "startThread", task });
      return { sessionId: "session-new", isolated: true };
    },
    listThreads: async () => {
      calls.push({ kind: "listThreads" });
      return {
        rows: [
          { sessionId: "a", view: { state: "failed", turn: 2 } },
          { sessionId: "b", view: { state: "done", turn: 1 } },
        ],
        counts: { failed: 1, done: 1 },
        attention: 1,
      };
    },
    messageThread: async (/** @type {string} */ sessionId, /** @type {string} */ text) => {
      calls.push({ kind: "messageThread", sessionId, text });
      return { ok: true };
    },
    requestAction: async (/** @type {any} */ request) => {
      calls.push({ kind: "requestAction", request });
      return { requestId: "req-1" };
    },
    writeMemory: async (/** @type {string} */ text) => {
      calls.push({ kind: "writeMemory", text });
      return { ok: true, added: true };
    },
    readMemory: async () => {
      calls.push({ kind: "readMemory" });
      return { instructions: "rules-here", memoryIndex: "memory-here" };
    },
  };
}

describe("工具定义形状", () => {
  it("每个工具都有 name/description/inputSchema/output{schema,render}", () => {
    const tools = buildCoordinatorTools(fakeDeps());
    assert.equal(tools.length, 6);
    for (const tool of tools) {
      assert.match(tool.name, /^project_/u);
      assert.ok(tool.description.length > 20, `${tool.name} 描述太短`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.output.schema, `${tool.name} 缺 output.schema`);
      assert.equal(typeof tool.output.render, "function", `${tool.name} 缺 render`);
      assert.equal(typeof tool.execute, "function");
    }
  });

  it("篮子不含 bash / 写文件 / 删除 / 推送 / 合并类工具", () => {
    const names = buildCoordinatorTools(fakeDeps()).map((tool) => tool.name);
    for (const forbidden of ["bash", "write_file", "delete", "git_push", "merge"]) {
      assert.ok(!names.includes(forbidden), `不该有 ${forbidden}`);
    }
    assert.deepEqual(names.sort(), [
      "project_memory_read",
      "project_memory_write",
      "project_request_action",
      "project_thread_list",
      "project_thread_message",
      "project_thread_start",
    ]);
  });
});

describe("execute 映射", () => {
  it("project_thread_start 建线程", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_thread_start");
    const result = await tool.execute({ task: "do it" });
    assert.deepEqual(result, { ok: true, sessionId: "session-new", isolated: true });
    assert.deepEqual(deps.calls[0], { kind: "startThread", task: "do it" });
  });

  it("project_thread_start 拒绝空任务（不调依赖）", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_thread_start");
    assert.deepEqual(await tool.execute({ task: "  " }), { ok: false, error: "task-required" });
    assert.equal(deps.calls.length, 0);
  });

  it("project_thread_list 只暴露摘要字段", async () => {
    const tool = buildCoordinatorTools(fakeDeps()).find((t) => t.name === "project_thread_list");
    const result = await tool.execute({});
    assert.equal(result.total, 2);
    assert.equal(result.attention, 1);
    assert.deepEqual(result.rows[0], { sessionId: "a", state: "failed", turn: 2 });
  });

  it("project_thread_message 转发会话与文本", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_thread_message");
    assert.deepEqual(await tool.execute({ sessionId: "s1", text: "try again" }), { ok: true });
    assert.deepEqual(deps.calls[0], { kind: "messageThread", sessionId: "s1", text: "try again" });
  });
});

describe("记忆写入", () => {
  it("转发文本给 deps.writeMemory", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_memory_write");
    const result = await tool.execute({ text: "conventions: use conventional commits" });
    assert.deepEqual(result, { ok: true, added: true });
    assert.deepEqual(deps.calls[0], {
      kind: "writeMemory",
      text: "conventions: use conventional commits",
    });
  });

  it("空文本被拒（不调依赖）", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_memory_write");
    assert.deepEqual(await tool.execute({ text: "  " }), { ok: false, reason: "text-required" });
    assert.equal(deps.calls.length, 0);
  });
});

describe("记忆读取", () => {
  it("返回规则与索引，并转发一次 readMemory", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_memory_read");
    const result = await tool.execute({});
    assert.deepEqual(result, { instructions: "rules-here", memoryIndex: "memory-here" });
    assert.deepEqual(deps.calls[0], { kind: "readMemory" });
  });
});

describe("危险动作只能申请", () => {
  it("白名单里的动作 + 有原因 → 入队并返回 requestId", async () => {
    const deps = fakeDeps();
    const tool = buildCoordinatorTools(deps).find((t) => t.name === "project_request_action");
    const result = await tool.execute({ action: "delete-thread", reason: "thread is stale" });
    assert.deepEqual(result, { requestId: "req-1", status: "queued" });
    assert.equal(deps.calls[0].request.action, "delete-thread");
  });

  it("不在白名单的动作被拒（例如 shell）", async () => {
    const deps = fakeDeps();
    const result = await requestAction(deps, { action: "run-shell", reason: "x" });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /action-not-requestable/u);
    assert.equal(deps.calls.length, 0, "被拒时不该触发依赖");
  });

  it("没有原因不允许入队（原因要给人看）", async () => {
    const deps = fakeDeps();
    const result = await requestAction(deps, { action: "merge", reason: "   " });
    assert.deepEqual(result, { ok: false, error: "reason-required" });
  });

  it("工具层把拒绝也表达清楚，而不是静默成功", async () => {
    const tool = buildCoordinatorTools(fakeDeps()).find((t) => t.name === "project_request_action");
    const result = await tool.execute({ action: "run-shell", reason: "x" });
    assert.equal(result.status, "rejected");
    assert.match(String(result.error), /action-not-requestable/u);
  });

  it("白名单是冻结的、且不含任何「直接执行」类动作", () => {
    assert.ok(Object.isFrozen(REQUESTABLE_ACTIONS));
    for (const action of REQUESTABLE_ACTIONS) {
      assert.match(action, /^(merge|push-branch|delete-thread|delete-project|change-settings)$/u);
    }
  });
});

describe("pickTools", () => {
  it("按名字挑工具（给 restrict 的 allow 列表用）", () => {
    const tools = buildCoordinatorTools(fakeDeps());
    const picked = pickTools(tools, ["project_thread_list", "project_request_action"]);
    assert.deepEqual(picked.map((tool) => tool.name).sort(), [
      "project_request_action",
      "project_thread_list",
    ]);
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(pickTools([], ["x"]), []);
    // @ts-expect-error 故意传 undefined
    assert.deepEqual(pickTools(undefined, undefined), []);
  });
});
