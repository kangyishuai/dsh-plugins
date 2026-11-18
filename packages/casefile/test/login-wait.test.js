// @ts-check
// 等登录：轮询就绪判据、超时与错误三态（注入 sleep/probe，不碰真浏览器）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { awaitLogin, LOGIN_WAIT_DEFAULTS } from "../lib/core/login-wait.js";

/** 造一个假 CDP 端点：json/list 返回给定页面。 */
function fakeFetch(/** @type {any[]} */ pages) {
  const calls = { list: 0 };
  globalThis.fetch = /** @type {any} */ (
    async () => {
      calls.list += 1;
      return {
        ok: true,
        status: 200,
        json: async () => pages,
      };
    }
  );
  return calls;
}

test("ready：第 N 次探测为真时返回 ready，并给出尝试次数", async () => {
  fakeFetch([
    { type: "page", id: "t1", url: "https://example.test/", webSocketDebuggerUrl: "ws://x/1" },
  ]);
  const values = [false, false, true];
  let index = 0;
  const result = await awaitLogin({
    endpoint: "http://127.0.0.1:9999",
    pollMs: 1,
    timeoutMs: 5000,
    sleep: async () => {},
    probe: async () => values[index++] === true,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.attempts, 3);
  assert.equal(result.lastValue, true);
  assert.match(result.hint, /可以继续采集/u);
});

test("timeout：一直不就绪时明确报超时，不假装成功", async () => {
  fakeFetch([
    { type: "page", id: "t1", url: "https://example.test/", webSocketDebuggerUrl: "ws://x/1" },
  ]);
  const result = await awaitLogin({
    endpoint: "http://127.0.0.1:9999",
    pollMs: 1,
    timeoutMs: 30,
    sleep: async () => {},
    probe: async () => false,
  });
  assert.equal(result.status, "timeout");
  assert.ok(result.attempts >= 1);
  assert.match(result.hint, /登录还没完成/u);
});

test("error：CDP 端点不可用时给出可操作提示", async () => {
  globalThis.fetch = /** @type {any} */ (
    async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }
  );
  const result = await awaitLogin({
    endpoint: "http://127.0.0.1:9999",
    pollMs: 1,
    timeoutMs: 20,
    sleep: async () => {},
  });
  assert.equal(result.status, "timeout", "连接被拒属于可等状态，最终应是 timeout");
  globalThis.fetch = /** @type {any} */ (
    async () => {
      throw new Error("some fatal cdp failure");
    }
  );
  const fatal = await awaitLogin({
    endpoint: "http://127.0.0.1:9999",
    pollMs: 1,
    timeoutMs: 5000,
    sleep: async () => {},
  });
  assert.equal(fatal.status, "error");
  assert.match(String(fatal.hint), /确认带 --remote-debugging-port/u);
});

test("没有 HTTP 页面时不算错误，继续等", async () => {
  fakeFetch([{ type: "page", id: "t1", url: "about:blank" }]);
  const result = await awaitLogin({
    endpoint: "http://127.0.0.1:9999",
    pollMs: 1,
    timeoutMs: 25,
    sleep: async () => {},
    probe: async () => true,
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.lastValue, null);
});

test("默认就绪判据是「没有密码输入框」", () => {
  assert.match(LOGIN_WAIT_DEFAULTS.readyJs, /input\[type=password\]/u);
  assert.equal(LOGIN_WAIT_DEFAULTS.pollMs, 2000);
});
