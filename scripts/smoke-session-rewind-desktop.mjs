#!/usr/bin/env node
// @ts-check
// 用法：先带调试端口启动 DSH 桌面版：
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
// 然后：pnpm smoke:session-rewind-desktop
//
// 只读桌面回归：不写文件、不发模型请求、不改会话；只切会话、打开/关闭对话框与面板。
// 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
//
// 重要：Esc Esc 在「正在运行本 agent 的会话」里会触发内置的停止，取消正在跑的这一轮
// （脚本自己的工具调用会被 abort）。所以脚本会先切到一个空闲会话再按 Esc，最后切回原会话。
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-session-rewind-desktop-shots");
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

/**
 * @param {ReturnType<typeof connect> extends Promise<infer T> ? T : never} cdp
 * @param {string} key
 * @param {number} vk
 */
async function pressEscape(cdp, key, vk) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: vk,
    });
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: { port: { type: "string" } },
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
    console.log(
      `SKIP 无法连接 CDP（127.0.0.1:${port}）：${error instanceof Error ? error.message : String(error)}`,
    );
    console.log("提示：先按文件头的命令带 --remote-debugging-port=9222 重启 DSH 桌面版。");
    return;
  }
  await mkdir(SHOTS, { recursive: true }).catch(() => {});
  try {
    const info = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "");
      return {
        title: document.title,
        pluginStyles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter((p) => p && p.includes("session-rewind")),
        headerButton: buttons.some((aria) => aria.includes("回溯面板")),
        userRows: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
        rewindButtons: [...document.querySelectorAll('[data-chat-flow-kind="user"] button')].filter((b) => (b.getAttribute("aria-label") || "").includes("回退到此处")).length,
      };
    })()`);
    check(
      "连接到 DSH 桌面 UI",
      typeof info?.title === "string" && info.title.length > 0,
      info?.title ?? "",
    );
    check(
      "插件 client 半已加载",
      info?.pluginStyles?.length > 0,
      JSON.stringify(info?.pluginStyles ?? []),
    );
    check("会话头部有回溯面板入口", info?.headerButton === true, "");
    check(
      "用户消息旁有 ↶ 按钮（当前会话）",
      info?.rewindButtons > 0,
      `${info?.userRows ?? 0} user rows / ${info?.rewindButtons ?? 0} buttons`,
    );
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // 切到另一个会话，避免 Esc Esc 取消正在跑的这一轮。
    const originalSession = await cdp.evaluate(`(() => {
      const root = document.querySelector("[data-conversation-session]");
      return root ? root.getAttribute("data-conversation-session") : null;
    })()`);
    const sessionIds = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
      return rows.map((row) => (row.getAttribute("data-row-key") || "").replace("session:", ""));
    })()`);
    /** @type {string | null} */
    let switched = null;
    for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
      if (id === originalSession) continue;
      await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(id)} + '"]');
        if (row) row.click();
      })()`);
      await sleep(900);
      const userRows = await cdp.evaluate(
        `document.querySelectorAll('[data-chat-flow-kind="user"]').length`,
      );
      if (userRows > 0) {
        switched = id;
        break;
      }
    }
    if (switched !== null) {
      await cdp.evaluate(
        `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); })()`,
      );
      await sleep(200);
    }
    let candidates = null;
    if (switched !== null) {
      await pressEscape(cdp, "Escape", 53);
      await sleep(120);
      await pressEscape(cdp, "Escape", 53);
      await sleep(900);
      candidates = await cdp.evaluate(`(() => {
        const dialog = document.querySelector(".dsh-srw-dialog");
        if (!dialog) return null;
        return {
          title: dialog.getAttribute("aria-label") || "",
          rows: [...dialog.querySelectorAll(".dsh-srw-row")].map((row) => (row.textContent || "").trim()),
          hasSearch: !!dialog.querySelector('input[type="search"]'),
        };
      })()`);
    }
    check(
      "Esc Esc 打开候选列表",
      candidates !== null,
      candidates ? candidates.title : switched === null ? "no idle second session" : "no dialog",
    );
    check("候选列表可搜索", candidates?.hasSearch === true, "");
    const needle = candidates && candidates.rows.length > 0 ? candidates.rows[0].slice(0, 2) : "";
    if (needle !== "") {
      await cdp.evaluate(`(() => {
        const input = document.querySelector('.dsh-srw-dialog input[type="search"]');
        if (!input) return;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setValue.call(input, ${JSON.stringify(needle)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await sleep(900);
      const filteredRows = await cdp.evaluate(`document.querySelectorAll(".dsh-srw-row").length`);
      check("候选搜索过滤生效", filteredRows > 0, `needle=${needle}, rows=${filteredRows}`);
    } else {
      check("候选搜索过滤生效", false, "no candidate rows");
    }
    await cdp.screenshot(join(SHOTS, "02-candidates.png"));
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector(".dsh-srw-dialog");
      const btn = dialog ? [...dialog.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "取消") : null;
      if (btn) btn.click();
    })()`);
    await sleep(400);

    // 回溯面板 → 四页签 + 设置/诊断
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
      if (btn) btn.click();
    })()`);
    await sleep(900);
    const drawer = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      if (!root) return null;
      return { tabs: [...root.querySelectorAll(".dsh-srw-tab")].map((t) => (t.textContent || "").trim()) };
    })()`);
    check(
      "回溯面板四页签",
      drawer !== null &&
        ["已撤回", "回溯记录", "救援点", "设置"].every((tab) => drawer.tabs.includes(tab)),
      JSON.stringify(drawer?.tabs ?? null),
    );
    await cdp.screenshot(join(SHOTS, "03-panel.png"));
    const settingsOk = await cdp.evaluate(`(async () => {
      const tab = [...document.querySelectorAll(".dsh-srw-tab")].find((t) => (t.textContent || "").trim() === "设置");
      if (!tab) return { ok: false, text: "no-settings-tab" };
      tab.click();
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const root = document.querySelector(".dsh-srw-drawer");
      const text = root ? (root.textContent || "").replace(/\\s+/g, " ") : "";
      return { ok: text.includes("诊断") && (text.includes("正常") || text.includes("异常")), text: text.slice(0, 260) };
    })()`);
    check("设置页诊断可加载", settingsOk?.ok === true, String(settingsOk?.text ?? ""));
    await cdp.screenshot(join(SHOTS, "04-settings.png"));
    await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      const btn = root ? [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
      if (btn) btn.click();
    })()`);
    if (originalSession !== null) {
      await sleep(400);
      await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(originalSession)} + '"]');
        if (row) row.click();
      })()`);
      await sleep(800);
    }
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
