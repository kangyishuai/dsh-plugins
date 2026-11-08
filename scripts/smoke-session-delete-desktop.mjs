#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：session-delete。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑
//   pnpm smoke:session-delete-desktop
//   # 发版门禁加 --require：连不上端口时失败而不是跳过
//   pnpm smoke:session-delete-desktop --require
//
// 只读：只打开会话菜单、确认框、回收站面板与其页签，然后 Esc 关闭。
// **从不确认删除、不恢复、不彻底删除**，因此可以直接跑在真实 profile 上。
// 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-session-delete-desktop-shots");
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
  return { ws, send, evaluate, screenshot };
}

/** @param {any} cdp */
const pressEscape = async (cdp) => {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 53,
    });
  }
};

/** 当前打开的面板文本（回收站面板用 [role="dialog"] 承载）。 */
const dialogText = (/** @type {any} */ cdp, /** @type {string} */ needle) =>
  cdp.evaluate(`(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes(${JSON.stringify(needle)}));
    return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : null;
  })()`);

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
    // ---------- A. 插件加载 ----------
    const info = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "");
      return {
        title: document.title,
        pluginStyles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter((p) => p && p.includes("session-delete")),
        footerEntry: buttons.some((aria) => aria.includes("回收站")),
        sessionRows: document.querySelectorAll('[data-row-key^="session:"]').length,
        menuButtons: [...document.querySelectorAll('[data-row-key^="session:"] button')].filter((b) => (b.getAttribute("aria-label") || "").includes("操作")).length,
      };
    })()`);
    check(
      "连接到 DSH 桌面 UI",
      typeof info?.title === "string" && info.title.length > 0,
      info?.title ?? "",
    );
    check(
      "插件 client 半已加载（样式注入）",
      info?.pluginStyles?.length > 0,
      JSON.stringify(info?.pluginStyles ?? []),
    );
    check("侧栏页脚有回收站入口", info?.footerEntry === true, "");
    check(
      "会话行有「操作」菜单按钮",
      info?.menuButtons > 0,
      `${info?.sessionRows ?? 0} rows / ${info?.menuButtons ?? 0} menu buttons`,
    );
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // ---------- B. 回收站面板（只读：打开 → 四个页签 → Esc 关闭） ----------
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
      if (btn) btn.click();
    })()`);
    await sleep(900);
    const panel = await dialogText(cdp, "会话回收站");
    check(
      "点击页脚打开回收站面板",
      panel !== null,
      panel === null ? "面板没打开" : panel.slice(0, 80),
    );
    const tabs = await cdp.evaluate(`(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
      if (!dlg) return [];
      return [...dlg.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter((text) => ["回收站", "审计", "体检", "回执"].some((tab) => text.startsWith(tab)));
    })()`);
    check(
      "面板有 回收站/审计/体检/回执 四个页签",
      Array.isArray(tabs) && tabs.length >= 4,
      JSON.stringify(tabs),
    );
    await cdp.screenshot(join(SHOTS, "02-panel.png"));
    for (const tab of ["审计", "体检", "回执"]) {
      const opened = await cdp.evaluate(`(async () => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
        if (!dlg) return false;
        const btn = [...dlg.querySelectorAll("button")].find((b) => (b.textContent || "").trim().startsWith(${JSON.stringify(tab)}));
        if (!btn) return false;
        btn.click();
        await new Promise((resolve) => setTimeout(resolve, 900));
        return true;
      })()`);
      const text = await dialogText(cdp, "会话回收站");
      check(`${tab} 页签可打开`, opened === true && text !== null, (text ?? "").slice(0, 100));
    }
    await cdp.screenshot(join(SHOTS, "03-panel-tabs.png"));
    await pressEscape(cdp);
    await sleep(600);
    check("Esc 关闭回收站面板", (await dialogText(cdp, "会话回收站")) === null, "面板仍在");

    // ---------- C. 会话菜单 → 删除确认框（只看不删） ----------
    const opened = await cdp.evaluate(`(async () => {
      const row = document.querySelector('[data-row-key^="session:"]');
      if (!row) return "no-row";
      const btn = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("操作"));
      if (!btn) return "no-menu-button";
      btn.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const item = [...document.querySelectorAll("button, [role=menuitem]")].find((el) => (el.textContent || "").trim().startsWith("删除会话"));
      if (!item) return "no-menu-item";
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return "clicked";
    })()`);
    const confirm = await dialogText(cdp, "移入回收站");
    check(
      "会话菜单能打开删除确认框",
      opened === "clicked" && confirm !== null,
      JSON.stringify({ opened, has: confirm !== null }),
    );
    check(
      "确认框写明影响面（日志大小/是否 live）",
      typeof confirm === "string" && /会话日志约|MB|KB|live|恢复/u.test(confirm),
      (confirm ?? "").slice(0, 160),
    );
    await cdp.screenshot(join(SHOTS, "04-confirm.png"));
    await pressEscape(cdp);
    await sleep(700);
    const afterEsc = await cdp.evaluate(`(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("移入回收站"));
      return dlg === undefined;
    })()`);
    check("Esc 关闭确认框且未执行删除", afterEsc === true, "");

    // 侧栏行数没变 = 确实没删
    const rowsAfter = await cdp.evaluate(
      `document.querySelectorAll('[data-row-key^="session:"]').length`,
    );
    check(
      "会话行数未变（只读验证）",
      rowsAfter === info.sessionRows,
      `${rowsAfter}/${info.sessionRows}`,
    );
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
