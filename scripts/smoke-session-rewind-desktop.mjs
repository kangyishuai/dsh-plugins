#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑
//   pnpm smoke:session-rewind-desktop
//   # 发版门禁用 --require：连不上端口时不是 SKIP，而是失败（避免「没测也绿」）
//   pnpm smoke:session-rewind-desktop --require
//
// 只读：只切会话、开/关对话框与面板、点取消；**不回溯、不写文件、不发模型请求**，因此可以直接
// 跑在真实 profile 上。端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
//
// 两条踩过的坑：
//   1. `Esc` `Esc` 在「正在运行本 agent 的会话」里会触发内置停止，取消正在跑的这一轮
//      （脚本自己的工具调用会被 abort）。所以先切到一个**有消息的空闲会话**再按 Esc。
//   2. 侧栏里可能有没有消息的会话，切过去候选列表是空的；必须挑选有用户消息的会话。
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

/** @param {any} cdp @param {string} key @param {number} vk */
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

const DIALOG = `[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"))`;

/** @param {any} cdp */
const dialogInfo = (cdp) =>
  cdp.evaluate(`(() => {
    const dlg = ${DIALOG};
    if (!dlg) return null;
    return {
      title: dlg.getAttribute("aria-label") || "",
      text: (dlg.textContent || "").replace(/\\s+/g, " "),
      rows: [...dlg.querySelectorAll(".dsh-srw-row")].map((row) => (row.textContent || "").trim()),
      hasSearch: !!dlg.querySelector('input[type="search"]'),
      radios: [...dlg.querySelectorAll('input[type="radio"]')].map((r) => r.value),
      resend: (() => {
        const box = dlg.querySelector('input[data-rewind-resend="true"]');
        return box ? { present: true, checked: box.checked } : { present: false, checked: false };
      })(),
      buttons: [...dlg.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean),
    };
  })()`);

/** @param {any} cdp @param {string[]} labels */
const clickDialogButton = (cdp, labels) =>
  cdp.evaluate(`(() => {
    const dlg = ${DIALOG};
    if (!dlg) return false;
    const btn = [...dlg.querySelectorAll("button")].find((b) => ${JSON.stringify(labels)}.includes((b.textContent || "").trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

/** @param {any} cdp */
const drawerInfo = (cdp) =>
  cdp.evaluate(`(() => {
    const root = document.querySelector(".dsh-srw-drawer");
    if (!root) return null;
    return {
      tabs: [...root.querySelectorAll(".dsh-srw-tab")].map((t) => (t.textContent || "").trim()),
      text: (root.textContent || "").replace(/\\s+/g, " "),
    };
  })()`);

/** @param {any} cdp @param {string} tab */
const openDrawerTab = (cdp, tab) =>
  cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll(".dsh-srw-tab")].find((t) => (t.textContent || "").trim() === ${JSON.stringify(tab)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
    },
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
        "提示：先带调试端口重启桌面版，或用 --args --remote-debugging-port=9222 启动。",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`SKIP 无法连接 CDP（127.0.0.1:${port}）：${message}`);
    console.log("提示：先按文件头的命令带 --remote-debugging-port=9222 重启 DSH 桌面版。");
    console.log("（发版门禁请加 --require：连不上端口将判为失败而不是跳过。）");
    return;
  }

  await mkdir(SHOTS, { recursive: true }).catch(() => {});
  try {
    // ---------- A. 插件加载与入口 ----------
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
      "插件 client 半已加载（样式注入）",
      info?.pluginStyles?.length > 0,
      JSON.stringify(info?.pluginStyles ?? []),
    );
    check("会话头部有回溯面板入口", info?.headerButton === true, "");
    check(
      "用户消息旁有 ↶ 按钮",
      info?.rewindButtons > 0,
      `${info?.userRows ?? 0} user rows / ${info?.rewindButtons ?? 0} buttons`,
    );
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // ---------- B. 切到有消息的空闲会话（Esc 不能在本 agent 会话里按） ----------
    const originalSession = await cdp.evaluate(`(() => {
      const root = document.querySelector("[data-conversation-session]");
      return root ? root.getAttribute("data-conversation-session") : null;
    })()`);
    const sessionIds = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
      return rows.map((row) => (row.getAttribute("data-row-key") || "").replace("session:", ""));
    })()`);
    /** @type {string | null} */
    let idleSession = null;
    for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
      if (id === originalSession) continue;
      await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(id)} + '"]');
        if (row) row.click();
      })()`);
      await sleep(900);
      const users = await cdp.evaluate(
        `document.querySelectorAll('[data-chat-flow-kind="user"]').length`,
      );
      if (users > 0) {
        idleSession = id;
        break;
      }
    }
    check(
      "找到一个有消息的空闲会话用于 Esc 流程",
      idleSession !== null,
      idleSession ?? "侧栏里没有第二个有消息的会话",
    );

    // ---------- C. Esc Esc → 候选列表 → 搜索 ----------
    /** @type {any} */
    let candidates = null;
    if (idleSession !== null) {
      await cdp.evaluate(
        `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); })()`,
      );
      await sleep(200);
      await pressEscape(cdp, "Escape", 53);
      await sleep(120);
      await pressEscape(cdp, "Escape", 53);
      await sleep(900);
      candidates = await dialogInfo(cdp);
    }
    check(
      "Esc Esc 打开候选列表",
      candidates !== null,
      candidates ? candidates.title : "没有对话框",
    );
    check("候选列表可搜索", candidates?.hasSearch === true, "");
    const needle = candidates && candidates.rows.length > 0 ? candidates.rows[0].slice(0, 2) : "";
    if (needle !== "") {
      await cdp.evaluate(`(() => {
        const input = document.querySelector('.dsh-srw-dialog input[type="search"], [class*="dsh-srw"] input[type="search"]');
        if (!input) return;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setValue.call(input, ${JSON.stringify(needle)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await sleep(900);
      const filteredRows = await cdp.evaluate(`document.querySelectorAll(".dsh-srw-row").length`);
      check("候选搜索过滤生效", filteredRows > 0, `needle=${needle}, rows=${filteredRows}`);
      await cdp.screenshot(join(SHOTS, "02-candidates.png"));
    } else {
      check("候选搜索过滤生效", false, "候选列表为空");
    }

    // ---------- D. 选候选 → 确认框（只看不执行）→ 取消 ----------
    const picked = await cdp.evaluate(`(() => {
      const dlg = ${DIALOG};
      if (!dlg) return false;
      const row = dlg.querySelector(".dsh-srw-row");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await sleep(1600);
    const confirm = await dialogInfo(cdp);
    check(
      "选择候选后进入确认框",
      picked && confirm !== null,
      confirm ? confirm.title : "没有确认框",
    );
    check(
      "确认框写明影响面与预览",
      typeof confirm?.text === "string" && /将撤回|This withdraws/u.test(confirm.text),
      (confirm?.text ?? "").slice(0, 160),
    );
    check(
      "确认框有「仅对话 / 对话+文件」两个范围",
      Array.isArray(confirm?.radios) &&
        confirm.radios.includes("chat") &&
        confirm.radios.includes("both"),
      JSON.stringify(confirm?.radios ?? null),
    );
    check(
      "确认框有「回退后立即重发」且默认不勾选",
      confirm?.resend?.present === true && confirm.resend.checked === false,
      JSON.stringify(confirm?.resend ?? null),
    );
    check(
      "确认框可取消（不执行回退）",
      await clickDialogButton(cdp, ["取消", "Cancel"]),
      "点不到取消按钮",
    );
    await sleep(600);
    const closed = await dialogInfo(cdp);
    check("取消后对话框关闭且未回溯", closed === null, closed ? "对话框仍在" : "");

    // ---------- E. 回溯面板四页签 ----------
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
      if (btn) btn.click();
    })()`);
    await sleep(1000);
    const drawer = await drawerInfo(cdp);
    check(
      "回溯面板打开且四页签齐全",
      drawer !== null &&
        ["已撤回", "回溯记录", "救援点", "设置"].every((tab) => drawer.tabs.includes(tab)),
      JSON.stringify(drawer?.tabs ?? null),
    );
    await cdp.screenshot(join(SHOTS, "03-panel.png"));

    await openDrawerTab(cdp, "回溯记录");
    await sleep(1000);
    const timeline = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-timeline");
      if (!root) return null;
      return {
        nodes: root.querySelectorAll(".dsh-srw-tl-node").length,
        dots: root.querySelectorAll(".dsh-srw-tl-dot").length,
      };
    })()`);
    check(
      "回溯记录渲染为时间线（节点数 === 圆点数）",
      timeline === null || (timeline.nodes >= 1 && timeline.dots === timeline.nodes),
      JSON.stringify(timeline),
    );

    await openDrawerTab(cdp, "救援点");
    await sleep(900);
    const rescuesText = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      return root ? (root.textContent || "").replace(/\\s+/g, " ") : "";
    })()`);
    check("救援点页签可渲染", /救援点|rescue/iu.test(rescuesText), rescuesText.slice(0, 120));

    // ---------- F. 设置 → 诊断（含只读工具与孤儿数据） ----------
    await openDrawerTab(cdp, "设置");
    await sleep(1400);
    const health = await cdp.evaluate(`(async () => {
      const root = document.querySelector(".dsh-srw-drawer");
      if (!root) return "";
      const refresh = [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "刷新");
      if (refresh) refresh.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return (root.textContent || "").replace(/\\s+/g, " ");
    })()`);
    check(
      "设置页诊断可加载",
      /诊断/u.test(health) && /正常|异常|OK|Problem/u.test(health),
      health.slice(0, 200),
    );
    check(
      "诊断报告只读工具已注册",
      /只读工具/u.test(health) && /enabled|disabled by config/u.test(health),
      health.slice(0, 400),
    );
    check("诊断报告孤儿数据检查", /孤儿数据/u.test(health), health.slice(0, 400));
    await cdp.screenshot(join(SHOTS, "04-settings.png"));

    // ---------- G. 收尾：关闭面板，切回原会话 ----------
    await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      const btn = root ? [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
      if (btn) btn.click();
    })()`);
    await sleep(500);
    check("面板可关闭", (await drawerInfo(cdp)) === null, "");
    if (originalSession !== null) {
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
