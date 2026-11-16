#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：artifacts。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:artifacts-desktop --require
//
// 只读：只展开右侧栏、点开指南、确认 Artifacts 入口与库渲染，不写任何文件、不改设置、不发消息。
// 前提：这个包**已经装进 desktop profile**（否则指南里不会有 Artifacts 入口，属预期 FAIL 而非脚本故障）。
// 依赖 `pnpm smoke:artifacts`（web、临时 DSH_HOME）覆盖数据面；这里只保证真实桌面 profile 里插件可用。
import { parseArgs } from "node:util";

const PORT = Number(process.env.DSH_CDP_PORT ?? 9222);

/** @param {number} port */
async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((/** @type {any} */ item) => item.type === "page");
  if (!page) throw new Error(`127.0.0.1:${port} 上没有 page target`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP 连接失败"));
  });
  let seq = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  ws.onmessage = (/** @type {any} */ event) => {
    const message = JSON.parse(String(event.data));
    const record = pending.get(message.id);
    if (!record) return;
    pending.delete(message.id);
    if (message.error) record.reject(new Error(JSON.stringify(message.error)));
    else record.resolve(message.result);
  };
  /** @param {string} method @param {any} [params] */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** @param {string} expression */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "页面脚本异常");
    return result.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

/** @param {string} name @param {boolean} ok @param {string} [detail] */
const results = [];
const record = (name, ok, detail = "") => results.push({ name, ok, detail });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { values } = parseArgs({ options: { require: { type: "boolean", default: false } } });
  let cdp;
  try {
    cdp = await connect(PORT);
  } catch (error) {
    console.log(
      `SKIP 连不上桌面版调试端口 ${PORT}：${error instanceof Error ? error.message : String(error)}`,
    );
    if (values.require) process.exitCode = 1;
    return;
  }

  try {
    const title = await cdp.evaluate("document.title");
    record("桌面版页面已加载", typeof title === "string" && title.length > 0, String(title));

    // 展开右侧栏（已展开时按钮不存在，忽略）
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("打开右侧边栏"));
      if (b) b.click();
      return true;
    })()`);
    await sleep(1200);

    // 打开指南：优先"更多工具"，其次添加入口
    const opened = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("button")];
      const pick = (re) => buttons.find((b) => re.test(b.getAttribute("aria-label") || ""));
      const target = pick(/更多工具|More tools/u) ?? pick(/新标签页|New tab/u);
      if (target) target.click();
      return Boolean(target);
    })()`);
    record("右侧栏入口可用", opened === true, String(opened));
    await sleep(1500);

    const entry = await cdp.evaluate(`(() => {
      const nodes = [...document.querySelectorAll("button, [role=button], a")];
      const hit = nodes.find((n) => /Artifacts/u.test((n.textContent || "").trim()));
      if (hit) { hit.click(); return true; }
      return false;
    })()`);
    record("指南里有 Artifacts 入口", entry === true, String(entry));
    await sleep(2000);

    const library = await cdp.evaluate(`(() => ({
      library: Boolean(document.querySelector("[data-dsh-artifact-library]")),
      cards: document.querySelectorAll("[data-dsh-artifact-card]").length,
      crashed: document.body.innerText.includes("Something went wrong"),
    }))()`);
    record(
      "工件库打开且未崩",
      library.library === true && library.crashed === false,
      JSON.stringify(library),
    );
  } catch (error) {
    record("执行过程", false, error instanceof Error ? error.message : String(error));
  } finally {
    cdp.close();
  }

  let failed = 0;
  for (const item of results) {
    console.log(`${item.ok ? "PASS " : "FAIL "}${item.name}${item.ok ? "" : ` :: ${item.detail}`}`);
    if (!item.ok) failed += 1;
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
