#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：casefile。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:casefile-desktop --require
//
// 只读：只切换主面板与设置分节、打开/取消新建表单，然后 Esc 关闭。
// 不写任何项目数据、不关闭义务、不点删除，因此可以直接跑在真实 profile 上。
// 数据面的断言（建项目/记证据/关义务被拒）在 `pnpm smoke:casefile` 的临时 DSH_HOME 里做。
//
// 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-casefile-desktop-shots");
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
  /**
   * 在页面里求值。
   * @param {string} expression
   * @param {boolean} [awaitPromise]
   */
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    const detail = /** @type {any} */ (result);
    if (detail.exceptionDetails) {
      throw new Error(`evaluate failed: ${JSON.stringify(detail.exceptionDetails).slice(0, 400)}`);
    }
    return detail.result ? detail.result.value : undefined;
  };
  return { send, evaluate, ws };
}

let passed = 0;
let failed = 0;
/** @type {string[]} */
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * 轮询直到选择器出现（比固定 sleep 稳）。
 * @param {any} page
 * @param {string} selector
 * @param {number} [timeoutMs]
 */
async function waitFor(page, selector, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await exists(page, selector)) === true) return true;
    await sleep(150);
  }
  return false;
}

/**
 * 按 aria-label 点按钮（侧栏入口、账号菜单这类最稳的定位方式）。
 * @param {any} page
 * @param {string} label
 */
async function clickAria(page, label) {
  return page.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('button,[role="button"]'))
      .find((node) => (node.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
}

/**
 * 在指定容器内按文本点（避免撞到侧栏同名入口）。
 * @param {any} page
 * @param {string} label
 * @param {string} scopeSelector
 */
async function clickTextScoped(page, label, scopeSelector) {
  return page.evaluate(`(() => {
    const scope = document.querySelector(${JSON.stringify(scopeSelector)});
    if (!scope) return false;
    const nodes = Array.from(scope.querySelectorAll('button,[role="button"],a,div,span'));
    const hit = nodes.find((node) => (node.textContent || '').trim() === ${JSON.stringify(label)});
    if (!hit) return false;
    (hit.closest('button,[role="button"],a') || hit).click();
    return true;
  })()`);
}

/** @param {any} page @param {string} selector */
async function exists(page, selector) {
  return page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
}

/** @param {any} page @param {string} selector */
async function textOf(page, selector) {
  return page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? (el.textContent || '').trim() : null;
  })()`);
}

/** @param {any} page */
async function screenshot(/** @type {any} */ page, /** @type {string} */ name) {
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  const data = /** @type {any} */ (result).data;
  if (typeof data === "string") {
    await writeFile(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
    },
  });
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  await mkdir(SHOTS, { recursive: true });

  /** @type {any} */
  let page;
  try {
    page = await connect(port);
  } catch (error) {
    const message = `连不上桌面版调试端口 ${port}：${String(error)}`;
    if (values.require) {
      console.error(`FAIL ${message}`);
      console.error("（--require：连不上就失败，不跳过）");
      process.exitCode = 1;
      return;
    }
    console.log(`SKIP ${message}`);
    return;
  }

  try {
    // 0) 宿主还在、页面可求值
    const ready = await page.evaluate("!!document.body && document.readyState !== 'loading'");
    check("桌面页面可访问", ready === true);
    await sleep(600);

    // 1) 侧栏入口：优先按 aria-label 点（与真实用户点的是同一个按钮）
    const navHit = await clickAria(page, "案卷");
    check("侧栏出现「案卷」入口并可点击", navHit === true);

    // 2) 工作台页渲染（首次挂载要等两个 RPC，轮询而不是固定 sleep）
    const pageMounted = await waitFor(page, "[data-casefile-page]");
    check("工作台主面板渲染（data-casefile-page）", pageMounted === true);
    await screenshot(page, "panel");

    // 3) 新建表单可打开/取消（不提交）
    const newHit = await clickTextScoped(page, "新建项目", "[data-casefile-page]");
    check("「新建项目」按钮可点击", newHit === true);
    const formMounted = await waitFor(page, "[data-casefile-create]", 3000);
    check("新建表单渲染（data-casefile-create）", formMounted === true);
    const cancelHit = await clickTextScoped(page, "取消", "[data-casefile-create]");
    check("「取消」能收起表单", cancelHit === true);
    await sleep(300);

    // 4) 空状态或项目行至少有一个可见（两种情况都算正常）
    const hasRows = await exists(page, "[data-casefile-project-row]");
    const hasEmpty = await exists(page, "[data-casefile-empty]");
    check(
      "列表区不是空白（有项目行或空状态）",
      hasRows === true || hasEmpty === true,
      `rows=${hasRows} empty=${hasEmpty}`,
    );

    // 5) 设置分节：账号菜单 → 设置 → 在设置面板内点「案卷」
    const menuHit = await clickAria(page, "账号菜单");
    check("能打开账号菜单", menuHit === true);
    await sleep(600);
    const settingsHit = await clickTextScoped(page, "设置", "body");
    check("能打开设置页", settingsHit === true);
    const dialogOpen = await waitFor(page, '[role="dialog"]', 4000);
    check("设置面板已出现", dialogOpen === true);
    const sectionHit = await clickTextScoped(page, "案卷", '[role="dialog"]');
    check("设置里出现「案卷」分节", sectionHit === true);
    const settingsMounted = await waitFor(page, "[data-casefile-settings]", 4000);
    check("设置分节渲染（data-casefile-settings）", settingsMounted === true);
    // 分节先渲染骨架（loading），REA 行要等 diagnose 回来才有
    await waitFor(page, "[data-casefile-rea]", 4000);
    const reaLine = await textOf(page, "[data-casefile-rea]");
    check(
      "设置里显示 REA 能力状态",
      typeof reaLine === "string" && reaLine.length > 0,
      String(reaLine),
    );
    await screenshot(page, "settings");

    // 6) Esc 回到对话（不打断任何回合）
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await sleep(400);
    check("Esc 后页面仍可用（没有崩）", (await page.evaluate("!!document.body")) === true);
  } catch (error) {
    failed += 1;
    failures.push("未捕获异常");
    console.error(`FAIL 未捕获异常：${String(error)}`);
    try {
      await screenshot(page, "failure");
    } catch {
      /* 截图失败不影响结论 */
    }
  } finally {
    try {
      page.ws?.close();
    } catch {
      /* ignore */
    }
    console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
    if (failed > 0) {
      console.error(`截图目录：${SHOTS}`);
      process.exitCode = 1;
    }
  }
}

await main();
