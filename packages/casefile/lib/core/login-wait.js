// @ts-check
// core/login-wait.js：等用户完成登录（轮询 CDP 页面就绪条件）。
//
// 为什么需要它：登录态页面要人参与（输账号/扫码/二次验证）。agent 不能干等，
// 也不能假装成功——所以做成"带超时的轮询 + 明确状态"：
//   - ready：就绪判据为真，可以继续采集
//   - timeout：到点还没好，保留现场，调用方决定是否重来
//   - error：端点/页面不可用（不存在、CDP 层失败）
// 判据用一段 JS 表达式（返回 boolean），由调用方给出——casefile 不猜"登录成功"长什么样。

/**
 * @typedef {{
 *   status: "ready" | "timeout" | "error",
 *   attempts: number,
 *   waitedMs: number,
 *   pollMs: number,
 *   timeoutMs: number,
 *   lastValue: boolean | null,
 *   hint: string,
 *   detail?: string,
 * }} LoginWaitResult
 */

/** 默认轮询参数。 */
export const LOGIN_WAIT_DEFAULTS = {
  pollMs: 2000,
  timeoutMs: 180000,
  readyJs: '!document.querySelector("input[type=password]")',
};

/**
 * 在 CDP 端点上找一个 HTTP(S) 页面 target。
 * @param {string} endpoint 形如 http://127.0.0.1:9223
 * @param {string} [urlPrefix] 只选 URL 以它开头的页面
 * @returns {Promise<{ id: string, url: string } | null>}
 */
export async function findPageTarget(endpoint, urlPrefix) {
  const base = String(endpoint).replace(/\/+$/, "");
  const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`target discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  const pages = (Array.isArray(targets) ? targets : []).filter(
    (/** @type {any} */ item) => item?.type === "page" && /^https?:/u.test(String(item.url ?? "")),
  );
  if (pages.length === 0) return null;
  const picked =
    (urlPrefix
      ? pages.find((/** @type {any} */ item) => String(item.url).startsWith(urlPrefix))
      : null) ?? pages[0];
  return { id: String(picked.id), url: String(picked.url) };
}

/**
 * 在页面里求值（一次性 WebSocket，用完即断）。
 * @param {string} wsUrl
 * @param {string} expression
 * @returns {Promise<boolean>}
 */
async function evaluateOnce(wsUrl, expression) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // 关闭失败不影响超时语义
      }
      reject(new Error("evaluate timeout"));
    }, 10000);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      );
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("cdp socket error"));
    };
    socket.onmessage = (/** @type {any} */ event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 忽略
      }
      if (message.error) {
        reject(new Error(`cdp error: ${JSON.stringify(message.error)}`));
        return;
      }
      resolve(message.result?.result?.value === true);
    };
  });
}

/**
 * 轮询等登录就绪。
 * @param {{
 *   endpoint: string,
 *   urlPrefix?: string,
 *   readyJs?: string,
 *   pollMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   probe?: (wsUrl: string, expression: string) => Promise<boolean>,
 * }} input
 * @returns {Promise<LoginWaitResult>}
 */
export async function awaitLogin(input) {
  const pollMs =
    Number.isInteger(input.pollMs) && Number(input.pollMs) > 0
      ? Number(input.pollMs)
      : LOGIN_WAIT_DEFAULTS.pollMs;
  const timeoutMs =
    Number.isInteger(input.timeoutMs) && Number(input.timeoutMs) > 0
      ? Number(input.timeoutMs)
      : LOGIN_WAIT_DEFAULTS.timeoutMs;
  const readyJs =
    typeof input.readyJs === "string" && input.readyJs.trim() !== ""
      ? input.readyJs
      : LOGIN_WAIT_DEFAULTS.readyJs;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const probe = input.probe ?? evaluateOnce;
  const started = Date.now();
  let attempts = 0;
  /** @type {boolean | null} */
  let lastValue = null;

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    try {
      const endpoint = String(input.endpoint ?? "").replace(/\/+$/, "");
      const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`target discovery failed: HTTP ${response.status}`);
      const targets = await response.json();
      const pages = (Array.isArray(targets) ? targets : []).filter(
        (/** @type {any} */ item) =>
          item?.type === "page" && /^https?:/u.test(String(item.url ?? "")),
      );
      const wanted = input.urlPrefix;
      const picked =
        (wanted
          ? pages.find((/** @type {any} */ item) => String(item.url).startsWith(wanted))
          : null) ?? pages[0];
      if (!picked) {
        lastValue = null;
        await sleep(pollMs);
        continue;
      }
      lastValue = await probe(String(picked.webSocketDebuggerUrl), readyJs);
      if (lastValue === true) {
        return {
          status: "ready",
          attempts,
          waitedMs: Date.now() - started,
          pollMs,
          timeoutMs,
          lastValue,
          hint: "已就绪：可以继续采集了。",
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 端点还没起来 / 页面还没开也属于"等"，只有明确不可恢复才报错
      // 端点还没起来（浏览器没启动 / 端口没开）属于可以继续等，不该立刻判失败；
      // 等满 timeoutMs 后由循环出口统一报 timeout。
      if (/ECONNREFUSED|ECONNRESET|fetch failed|target discovery failed/u.test(message)) {
        lastValue = null;
        await sleep(pollMs);
        continue;
      }
      return {
        status: "error",
        attempts,
        waitedMs: Date.now() - started,
        pollMs,
        timeoutMs,
        lastValue,
        hint: "CDP 端点或页面不可用；确认带 --remote-debugging-port 的浏览器已启动并打开了目标页。",
        detail: message.slice(0, 500),
      };
    }
    await sleep(pollMs);
  }

  return {
    status: "timeout",
    attempts,
    waitedMs: Date.now() - started,
    pollMs,
    timeoutMs,
    lastValue,
    hint: "等待超时：登录还没完成。现场保留，你可以登录后重新调用，或调大 timeoutMs。",
  };
}
