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
// 只读：只打开会话菜单、确认框、回收站面板与设置页分节，然后 Esc 关闭。
// **从不确认删除、不恢复、不彻底删除**，因此可以直接跑在真实 profile 上。
// 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
//
// `--workspace <侧栏里的工作区标题>`：把会话相关操作**严格限制**在该工作区内。
// 指定后脚本只在那个工作区的分组里找会话行；找不到就判失败，**不会**去碰别的工作区的会话。
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

/**
 * 等页面可交互：document.readyState complete 且根节点有内容，最多等 ~15s。
 * @param {any} cdp
 */
async function ensureReady(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await cdp
      .evaluate(
        `(() => document.readyState === "complete" && document.body && document.body.innerText.trim().length > 20)()`,
      )
      .catch(() => false);
    if (ready === true) {
      await sleep(600);
      return;
    }
    await sleep(400);
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
      workspace: { type: "string" },
    },
    allowPositionals: true,
  });
  // 容忍 `pnpm <script> -- --require`：多余的 `--` 会被当成位置参数，这里忽略它。
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
  // 紧接着别的 GUI 冒烟跑时，渲染线程可能还在忙；先等页面稳定再断言。
  await ensureReady(cdp);
  try {
    // ---------- A. 插件加载 ----------
    const workspaceTitle = typeof values.workspace === "string" ? values.workspace : null;
    /** 目标工作区里第一个会话行的 key；未指定工作区时为 null（此时不碰任何会话行）。 */
    const scopedRow = await cdp.evaluate(`(() => {
      const title = ${JSON.stringify(workspaceTitle)};
      if (!title) return { status: "unscoped" };
      // 侧栏显示的是目录名而不是完整路径，所以按 basename 匹配。
      const base = title.split("/").filter(Boolean).pop() || title;
      // 折叠的工作区里没有会话行，先点开。
      for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
      const wsRow = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find((r) => (r.textContent || "").includes(base));
      if (!wsRow) return { status: "no-workspace" };
      // 分组容器是 workspace 行的祖父节点（不依赖 class 名，结构变了也不会乱点）
      const section = wsRow.parentElement && wsRow.parentElement.parentElement;
      if (!section) return { status: "no-section" };
      const rows = [...section.querySelectorAll('[data-row-key^="session:"]')];
      if (rows.length === 0) return { status: "no-session" };
      const row = rows[0];
      const menu = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("操作"));
      return {
        status: "ok",
        key: row.getAttribute("data-row-key"),
        label: (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
        hasMenu: Boolean(menu),
      };
    })()`);

    /** 目标工作区当前会话行数（只统计该分组，用于前后对比）。 */
    const scopedBefore =
      workspaceTitle === null
        ? 0
        : await cdp.evaluate(`(() => {
            const raw = ${JSON.stringify(String(values.workspace ?? ""))};
            const base = raw.split("/").filter(Boolean).pop() || raw;
            const wsRow = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find((r) => (r.textContent || "").includes(base));
            const section = wsRow && wsRow.parentElement && wsRow.parentElement.parentElement;
            return section ? section.querySelectorAll('[data-row-key^="session:"]').length : 0;
          })()`);
    const info = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "");
      return {
        title: document.title,
        pluginStyles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter((p) => p && p.includes("session-delete")),
        footerEntry: buttons.some((aria) => aria.includes("回收站")),
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
    if (workspaceTitle === null) {
      check("未指定 --workspace（不碰任何会话行）", true, "会话相关检查将跳过");
    } else {
      check(
        `工作区「${workspaceTitle}」里找到会话行`,
        scopedRow?.status === "ok",
        JSON.stringify(scopedRow),
      );
      check("该会话行有「操作」菜单按钮", scopedRow?.hasMenu === true, JSON.stringify(scopedRow));
    }
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // ---------- B. 回收站面板（只读：打开 → 单页列表 → Esc 关闭） ----------
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
    // 0.5.x：审计 / 体检 / 回执 已搬到设置页，面板只做回收站一件事。
    const panelShape = await cdp.evaluate(`(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
      if (!dlg) return null;
      const text = dlg.textContent || "";
      const buttons = [...dlg.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
      return {
        hasTabs: ["审计", "体检", "回执"].some((tab) => buttons.some((label) => label.startsWith(tab))),
        hasBatch: buttons.some((label) => label.startsWith("恢复（")) || text.includes("全选"),
        text: text.replace(/\\s+/g, " ").slice(0, 120),
      };
    })()`);
    check(
      "回收站面板是单页（不再有 审计/体检/回执 页签）",
      panelShape !== null && panelShape.hasTabs === false,
      JSON.stringify(panelShape),
    );
    check(
      "回收站面板保留全选与批量操作",
      panelShape !== null && panelShape.hasBatch === true,
      JSON.stringify(panelShape),
    );
    await cdp.screenshot(join(SHOTS, "02-panel.png"));
    await pressEscape(cdp);
    await sleep(600);
    check("Esc 关闭回收站面板", (await dialogText(cdp, "会话回收站")) === null, "面板仍在");

    // ---------- C. 会话菜单 → 删除确认框（只看不删） ----------
    const opened =
      workspaceTitle === null
        ? "skipped"
        : await cdp.evaluate(`(async () => {
      const row = document.querySelector('[data-row-key="' + ${JSON.stringify(scopedRow?.key ?? "")} + '"]');
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
      // 没给 --workspace 时这一步是**故意跳过**的（不碰任何真实会话），不算失败。
      opened === "skipped" || (opened === "clicked" && confirm !== null),
      JSON.stringify({ opened, has: confirm !== null }),
    );
    check(
      "确认框写明影响面（日志大小/是否 live）",
      opened === "skipped" ||
        (typeof confirm === "string" && /约\s*[\d.]+\s*(B|KB|MB|GB)|移入本机回收站/u.test(confirm)),
      (confirm ?? "skipped").slice(0, 160),
    );
    await cdp.screenshot(join(SHOTS, "04-confirm.png"));
    await pressEscape(cdp);
    await sleep(700);
    const afterEsc = await cdp.evaluate(`(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("移入回收站"));
      return dlg === undefined;
    })()`);
    check("Esc 关闭确认框且未执行删除", afterEsc === true, "");

    // ---------- D. 设置页分节（只读：打开 → 切到「会话回收站」→ Esc） ----------
    const settings = await cdp.evaluate(`(async () => {
      const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const opener = '[data-shortcut-modal="settings"]';
      const isOpen = () => Boolean(document.querySelector(opener));
      for (const needle of ["设置", "账号菜单", "Settings"]) {
        if (isOpen()) break;
        const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes(needle));
        if (!btn) continue;
        btn.click();
        await sleepMs(800);
      }
      if (!isOpen()) return { status: "no-settings-panel" };
      const shell = document.querySelector(opener);
      const nav = [...shell.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "会话回收站");
      if (!nav) return { status: "no-section-nav" };
      nav.click();
      await sleepMs(1500);
      const text = (shell.textContent || "").replace(/\\s+/g, " ");
      return { status: "ok", text: text.slice(0, 400) };
    })()`);
    check(
      "设置页出现「会话回收站」分节",
      settings?.status === "ok",
      JSON.stringify(settings ?? null),
    );
    check(
      "设置页包含删除偏好与维护入口",
      settings?.status === "ok" &&
        settings.text.includes("删除偏好") &&
        settings.text.includes("体检") &&
        settings.text.includes("操作回执"),
      (settings?.text ?? "").slice(0, 200),
    );
    await cdp.screenshot(join(SHOTS, "03-settings.png"));
    await pressEscape(cdp);
    await sleep(600);

    // 目标工作区的会话行数前后一致 = 确实没删（只比较该工作区，不看别人的会话）
    const afterCount =
      workspaceTitle === null
        ? null
        : await cdp.evaluate(`(() => {
            const raw = ${JSON.stringify(workspaceTitle)};
            const base = raw.split("/").filter(Boolean).pop() || raw;
            const wsRow = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find((r) => (r.textContent || "").includes(base));
            const section = wsRow && wsRow.parentElement && wsRow.parentElement.parentElement;
            return section ? section.querySelectorAll('[data-row-key^="session:"]').length : null;
          })()`);
    check(
      "目标工作区会话数未变（只读验证）",
      workspaceTitle === null || afterCount === scopedBefore,
      workspaceTitle === null || scopedBefore === null
        ? "skipped"
        : `${afterCount}/${scopedBefore}`,
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
