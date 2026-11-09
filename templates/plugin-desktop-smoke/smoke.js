#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：__NAME__。
// 由 pnpm new 生成；这是**硬性要求**（docs/plugin-conventions.md §6.1），不是可选步骤。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:__NAME__-desktop --require
//
// 默认**只读**：只切会话、开关对话框/面板，不执行破坏性操作，因此可以直接跑在真实 profile 上。
// 需要写东西的流程请单独开一个 --deep 模式，并要求显式传入专用目录。
//
// 待办（删掉本段前请把两处 TODO 换成真实断言）：
//   - TODO: 断言插件的入口在真实 UI 里可见（按钮/菜单/页脚，取决于你的 client 半）
//   - TODO: 断言核心交互（打开面板、切换页签、Esc 关闭）不会崩
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-__NAME__-desktop-shots");
const PLUGIN = "@kangyishuai/dsh-__NAME__";
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {number} port
 */
async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((/** @type {any} */ item) => item.type === "page");
  if (!page) throw new Error(`no page target on 127.0.0.1:${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  ws.onmessage = (/** @type {any} */ event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const record = pending.get(msg.id);
      if (record === undefined) return;
      pending.delete(msg.id);
      if (msg.error) record.reject(new Error(JSON.stringify(msg.error)));
      else record.resolve(msg.result);
    }
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
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "evaluate failed",
      );
    }
    return result.result?.value;
  };
  /** @param {string} file */
  const screenshot = async (file) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
  };
  return { ws, evaluate, screenshot };
}

const main = async () => {
  const { values } = parseArgs({
    options: { port: { type: "string" }, require: { type: "boolean", default: false } },
    allowPositionals: false,
  });
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const check = (
    /** @type {string} */ name,
    /** @type {boolean} */ ok,
    /** @type {string} */ detail = "",
  ) => checks.push({ name, ok, detail });

  /** @type {Awaited<ReturnType<typeof connect>> | undefined} */
  let cdp;
  try {
    cdp = await connect(port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (values.require === true) {
      console.error(`FAIL 无法连接 CDP（127.0.0.1:${port}）：${message}`);
      console.error(
        '提示：先带调试端口重启桌面版：open -a "DeepSeek Harness" --args --remote-debugging-port=9222',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`SKIP 无法连接 CDP（127.0.0.1:${port}）：${message}`);
    console.log("（发版门禁请加 --require：连不上端口将判为失败而不是跳过。）");
    return;
  }

  await mkdir(SHOTS, { recursive: true }).catch(() => {});
  try {
    // 等页面可交互（紧接着别的 GUI 冒烟跑时渲染线程可能还在忙）
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ready = await cdp
        .evaluate(
          `(() => document.readyState === "complete" && document.body && document.body.innerText.trim().length > 20)()`,
        )
        .catch(() => false);
      if (ready === true) break;
      await sleep(400);
    }
    await sleep(600);

    const info = await cdp.evaluate(`(() => ({
      title: document.title,
      pluginStyles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter((p) => p && p.includes(${JSON.stringify(PLUGIN)})),
      buttons: [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "").filter(Boolean),
    }))()`);
    check(
      "连接到 DSH 桌面 UI",
      typeof info?.title === "string" && info.title.length > 0,
      info?.title ?? "",
    );
    // 约定：client 半的 <style> 要带 data-plugin，这里据此断言插件真的加载了。
    check(
      "插件 client 半已加载（样式注入）",
      info?.pluginStyles?.length > 0,
      JSON.stringify(info?.pluginStyles ?? []),
    );

    // TODO: 换成你的入口断言，例如：
    // check("侧栏/头部/页脚有入口", info?.buttons?.some((aria) => aria.includes("<你的入口 aria-label>")), "");

    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // TODO: 在这里加只读交互（打开面板 → 切页签 → Esc 关闭），并断言每一步。

    check("（骨架）只读回归可执行", true, "把上面的 TODO 换成本插件的真实断言");
  } catch (error) {
    check("桌面回归执行", false, error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.ws.close();
  }

  let failed = 0;
  for (const item of checks) {
    console.log((item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`));
    if (!item.ok) failed += 1;
  }
  console.log(`截图目录：${SHOTS}`);
  if (failed > 0) {
    console.error(`FAIL ${failed} 项桌面回归断言失败`);
    process.exitCode = 1;
  } else {
    console.log(`PASS 全部 ${checks.length} 项桌面回归断言通过`);
  }
};

await main();
