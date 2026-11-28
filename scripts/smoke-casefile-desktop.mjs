#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：casefile。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:casefile-desktop --require
//
// 只读：切换主面板与设置分节、打开/取消新建表单、打开项目详情与「危险操作 → 移入回收站」的
// 影响面预览（dry-run，不落盘）、最后 Esc 关闭。
// 不写任何项目数据、不关闭义务、不确认任何删除，因此可以直接跑在真实 profile 上。
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
let skipped = 0;
/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const skips = [];

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
 * 数据分支未满足时的跳过：**不计 PASS**（复审 A6：空 profile 上把跳过记成通过是假绿）。
 * @param {string} name
 * @param {string} [detail]
 */
function skip(name, detail = "") {
  skipped += 1;
  skips.push(name);
  console.log(`SKIP ${name}${detail ? ` — ${detail}` : ""}`);
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
    // 优先只在可点击元素里找：危险操作区里父级 div 的 textContent 与按钮完全相同，
    // 按文档序会先命中父 div（无 onClick）→ 点了没反应（2026-11-28 真机实测）。
    const clickable = Array.from(
      scope.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[role="tab"],a'),
    ).filter(
      (node) => !node.disabled && (node.textContent || '').trim() === ${JSON.stringify(label)},
    );
    const hit =
      clickable[0] ||
      Array.from(scope.querySelectorAll('div,span,summary')).find(
        (node) => (node.textContent || '').trim() === ${JSON.stringify(label)},
      );
    if (!hit) return false;
    const target = hit.closest('button,[role="button"],[role="menuitem"],[role="option"],[role="tab"],a') || hit;
    if (target.tagName === 'DIV' || target.tagName === 'SPAN') {
      // 最后兜底：文本容器本身不可点时不伪造成功
      const inner = hit.querySelector('button,[role="button"],a');
      if (!inner) return false;
      inner.click();
      return true;
    }
    target.click();
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

    // 2b) 自主性级别徽章：L3 是危险状态，必须始终可见（默认 L2）
    // 注意：这个 helper 只接受**字符串表达式**（不是函数），否则 CDP 报 Invalid parameters
    const autonomy = await page.evaluate(`(() => {
      const el = document.querySelector("[data-casefile-autonomy]");
      return el ? { level: el.getAttribute("data-casefile-autonomy"), text: el.textContent || "" } : null;
    })()`);
    check(
      "面板显示自主性级别徽章（data-casefile-autonomy，默认 L2）",
      autonomy != null && /^L[0-3]$/.test(String(autonomy.level)) && autonomy.text.length > 0,
    );
    const autonomyHint = await page.evaluate(`(() => {
      const el = document.querySelector("[data-casefile-autonomy]");
      return el ? String(el.getAttribute("title") || "") : "";
    })()`);
    check(
      "自主性提示是人话（保留 L0–L3 副标题、无 scope= 代码术语）",
      typeof autonomyHint === "string" &&
        autonomyHint.includes("L0") &&
        !autonomyHint.includes("scope="),
      String(autonomyHint).slice(0, 120),
    );
    await screenshot(page, "panel");

    // 3) 新建表单可打开/取消（不提交）
    const newHit = await clickTextScoped(page, "新建项目", "[data-casefile-page]");
    check("「新建项目」按钮可点击", newHit === true);
    const formMounted = await waitFor(page, "[data-casefile-create]", 3000);
    check("新建表单渲染（data-casefile-create）", formMounted === true);
    const fieldInfo = await page.evaluate(`(() => {
      const form = document.querySelector("[data-casefile-create]");
      if (!form) return null;
      const title = form.querySelector('[data-casefile-field-input="title"]');
      const submit = form.querySelector("[data-casefile-submit]");
      return {
        labels: Array.from(form.querySelectorAll("label")).map((node) => (node.textContent || "").trim()),
        titleRequired: title ? title.getAttribute("aria-required") : null,
        submitDisabled: submit ? submit.disabled === true : null,
      };
    })()`);
    check(
      "新建表单四个字段都有可见标签（标题/目标/对象类型/授权范围）",
      fieldInfo != null &&
        Array.isArray(fieldInfo.labels) &&
        fieldInfo.labels.length >= 4 &&
        fieldInfo.labels.join(" ").includes("项目标题") &&
        fieldInfo.labels.join(" ").includes("授权范围"),
      JSON.stringify(fieldInfo?.labels),
    );
    check(
      "标题标记必填；空标题时「创建」仍可点（否则就是「点了没反应」）",
      fieldInfo != null && fieldInfo.titleRequired === "true" && fieldInfo.submitDisabled === false,
      JSON.stringify(fieldInfo),
    );
    const submitEmpty = await clickTextScoped(page, "创建", "[data-casefile-create]");
    const errorShown = await waitFor(page, "[data-casefile-create-error]", 2000);
    check("空标题点「创建」给出可见错误", submitEmpty === true && errorShown === true);
    const titleInvalid = await page.evaluate(`(() => {
      const input = document.querySelector('[data-casefile-field-input="title"]');
      return input ? input.getAttribute("data-invalid") : null;
    })()`);
    check(
      "必填未填时标题输入框高亮（data-invalid=true）",
      titleInvalid === "true",
      String(titleInvalid),
    );
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
    if (hasEmpty === true) {
      const emptyText = await textOf(page, '[data-casefile-empty="projects"]');
      const emptyAdvanced = await exists(
        page,
        '[data-casefile-empty="projects"] details[data-casefile-advanced]',
      );
      check(
        "空态是人话引导（含「第一步」），工具名收在高级折叠",
        typeof emptyText === "string" && emptyText.includes("第一步") && emptyAdvanced === true,
        `text=${String(emptyText).slice(0, 80)} advanced=${emptyAdvanced}`,
      );
    } else {
      skip("空态是人话引导（含「第一步」），工具名收在高级折叠", "有项目，空态不可见");
    }

    // 4b) 回收站入口（只读：点开、看到空/条目、返回；不点恢复/清空）
    const trashToggle = await clickTextScoped(page, "回收站", "[data-casefile-page]");
    check("「回收站」入口可点击（data-casefile-trash-toggle）", trashToggle === true);
    const trashView = await waitFor(page, "[data-casefile-trash-view]", 4000);
    check("回收站视图渲染（data-casefile-trash-view）", trashView === true);
    const trashEmpty = await exists(page, "[data-casefile-trash-empty]");
    const trashRows = await exists(page, "[data-casefile-trash-row]");
    check(
      "回收站列表不是空白（有条目或空状态）",
      trashEmpty === true || trashRows === true,
      `rows=${trashRows} empty=${trashEmpty}`,
    );
    await screenshot(page, "trash");
    const trashBack = await clickTextScoped(page, "返回项目列表", "[data-casefile-trash-view]");
    check("回收站能返回项目列表", trashBack === true);
    await waitFor(page, "[data-casefile-empty], [data-casefile-project-row]", 3000);

    // 4c) 危险操作：drop 的用户入口 + dry-run 影响面（只读，不确认）
    if (hasRows === true) {
      const opened = await page.evaluate(`(() => {
        const row = document.querySelector("[data-casefile-project-row]");
        if (!row) return false;
        row.click();
        return true;
      })()`);
      const danger = await waitFor(page, "[data-casefile-danger]", 4000);
      check(
        "详情页有默认收起的「危险操作」区（drop 的用户入口）",
        opened === true && danger === true,
      );
      // 复审 A4：`<details>` 折叠时子节点仍在 DOM 里，上面那条只证明「存在」；默认收起要单独断言。
      const dangerOpen = await page.evaluate(`(() => {
        const el = document.querySelector("[data-casefile-danger]");
        return el ? el.open === true : null;
      })()`);
      check(
        "「危险操作」默认收起（details.open === false）",
        dangerOpen === false,
        `open=${String(dangerOpen)}`,
      );
      // <details> 默认收起：子节点仍在 DOM，但真实用户要先展开才看得到/点得到（复审 A4 的延伸）。
      const dangerOpened = await page.evaluate(`(() => {
        const el = document.querySelector("[data-casefile-danger]");
        if (!el) return false;
        if (el.open !== true) {
          el.open = true;
          el.dispatchEvent(new Event("toggle", { bubbles: true }));
        }
        return el.open === true;
      })()`);
      await sleep(150);
      const dropHit = await clickTextScoped(page, "移入回收站…", "[data-casefile-danger]");
      const preview = await waitFor(page, "[data-casefile-drop-preview]", 4000);
      if (dangerOpened !== true) {
        check("「危险操作」可展开（真实用户点得到入口）", false, "open=false");
      }
      check("drop 入口先展示影响面（dry-run，不执行）", dropHit === true && preview === true);
      const previewText = await textOf(page, "[data-casefile-drop-preview]");
      check(
        "影响面文案说明可恢复",
        typeof previewText === "string" && previewText.includes("恢复"),
        String(previewText).slice(0, 100),
      );
      const dropCancel = await clickTextScoped(page, "取消", "[data-casefile-drop-preview]");
      check("危险操作影响面可以取消（只读）", dropCancel === true);
      await clickTextScoped(page, "返回列表", "[data-casefile-page]");
      await sleep(300);
    } else {
      // 复审 A6：空 profile 上这 4 条以前记 PASS（「无项目，跳过」），等于没验也全绿——
      // 改成 SKIP 并单独计数，收尾行能看出数据分支没覆盖。
      skip("详情页有默认收起的「危险操作」区（drop 的用户入口）", "无项目，数据分支未覆盖");
      skip("「危险操作」默认收起（details.open === false）", "无项目，数据分支未覆盖");
      skip("drop 入口先展示影响面（dry-run，不执行）", "无项目，数据分支未覆盖");
      skip("影响面文案说明可恢复", "无项目，数据分支未覆盖");
      skip("危险操作影响面可以取消（只读）", "无项目，数据分支未覆盖");
    }

    // 5) 设置分节：账号菜单 → 设置 → 在设置面板内点「案卷」
    // Radix 菜单要求窗口在前台才展开：连续冒烟时窗口可能失去焦点，先拉回前台并重试打开。
    await page.send("Page.bringToFront").catch(() => undefined);
    await page.evaluate("document.body.focus()").catch(() => undefined);
    await sleep(250);
    let menuHit = false;
    let menuReady = false;
    for (let attempt = 0; attempt < 8 && !menuReady; attempt += 1) {
      if (attempt === 0) menuHit = await clickAria(page, "账号菜单");
      else {
        await page.send("Page.bringToFront").catch(() => undefined);
        await clickAria(page, "账号菜单");
      }
      await sleep(300);
      menuReady = await exists(page, '[role="menu"]');
    }
    check("能打开账号菜单", menuHit === true);
    check("账号菜单已展开", menuReady === true);
    // 菜单项按钮的 textContent 含快捷键（「设置⌘,」），label 在内部 span；按可见文本找并点最近的可点祖先，
    // 菜单晚挂/重渲染时重试，避免 600ms 固定等待（2026-11-28 真机复跑实测会偶发）。
    let settingsHit = false;
    for (let attempt = 0; attempt < 20 && !settingsHit; attempt += 1) {
      settingsHit = await page.evaluate(`(() => {
        const nodes = Array.from(document.querySelectorAll('button[role="menuitem"],[role="menuitem"],button,a'));
        const hit = nodes.find((node) => (node.textContent || '').trim() === "设置" || (node.textContent || '').trim().startsWith("设置"));
        if (hit) {
          hit.click();
          return true;
        }
        const spans = Array.from(document.querySelectorAll('span,div')).filter(
          (node) => (node.textContent || '').trim() === "设置",
        );
        const target = spans[0] && spans[0].closest('button,[role="menuitem"],a');
        if (target) {
          target.click();
          return true;
        }
        return false;
      })()`);
      if (!settingsHit) await sleep(150);
    }
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
      "设置里显示 REA 接入状态",
      typeof reaLine === "string" && reaLine.length > 0,
      String(reaLine),
    );
    const reaInfo = await page.evaluate(`(() => {
      const notice = document.querySelector("[data-casefile-rea-notice]");
      const rea = document.querySelector("[data-casefile-rea]");
      return notice
        ? {
            className: String(notice.className || ""),
            state: rea ? rea.getAttribute("data-state") : null,
            text: rea ? String(rea.textContent || "").trim() : "",
          }
        : null;
    })()`);
    const reaInfoClassName = reaInfo ? String(reaInfo.className) : "";
    const reaInfoText = reaInfo ? String(reaInfo.text) : "";
    check(
      "REA 未接入按信息/不可用说明呈现（不是红色错误）",
      reaInfoClassName.includes("cf-info") &&
        !reaInfoClassName.includes("cf-error") &&
        reaInfoText.length > 0 &&
        (reaInfo?.state === "connected" || reaInfo?.state === "unavailable"),
      JSON.stringify(reaInfo),
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
    console.log(`\n结果：${passed} PASS / ${skipped} SKIP / ${failed} FAIL`);
    // 门禁靠这一行判定「跑过但一条断言都没执行」（见 docs/plugin-conventions.md §6.1）。
    console.log(`${passed} PASS / ${skipped} SKIP / ${failed} FAIL`);
    if (skips.length > 0) {
      console.log(`（SKIP 是数据分支未满足，未计 PASS：${skips.join(" / ")}）`);
    }
    if (failed > 0) {
      console.error(`截图目录：${SHOTS}`);
      process.exitCode = 1;
    }
  }
}

await main();
