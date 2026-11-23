#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：projects。
// 由 pnpm new 生成；这是**硬性要求**（docs/plugin-conventions.md §6.1），不是可选步骤。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:projects-desktop --require
//
// 默认**只读**：只切会话、开关对话框/面板，不执行破坏性操作，因此可以直接跑在真实 profile 上。
// 需要写东西的流程请单独开一个 --deep 模式，并要求显式传入专用目录。
//
// 断言覆盖（11 项，全部只读）：
//   插件 client 半已加载 / 首启对话框处理 / 侧栏「项目」入口 / 面板渲染 / data-projects-status 形状 /
//   无渲染崩溃 / 摘要已本地化 / 新建控件存在（不提交）/ 设置分节（设置页被禁用时容忍跳过）/
//   Esc 关闭后界面仍可用 / 截图落盘。
// 未装进 live profile 时默认 SKIP（门禁加 --require 则失败）。
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-projects-desktop-shots");
const PLUGIN = "@kangyishuai/dsh-projects";
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
  /**
   * 只用于**数据分支**的 SKIP（例如 live profile 里一个项目都没有，详情页无从打开）。
   * 判定「是否真的跑过」由末尾计数行承担：SKIP 不计入 PASS，也不伪装成通过
   * （docs/plugin-conventions.md §6.1）。
   * @type {{name: string, detail: string}[]}
   */
  const skips = [];
  const skip = (/** @type {string} */ name, /** @type {string} */ detail = "") =>
    skips.push({ name, detail });

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

  /** 关掉首启「预览版说明」对话框：它会把其余内容置为 inert，导致后续聚焦/点击失效。 */
  const dismissFirstRunDialog = async () => {
    return cdp.evaluate(`(() => {
      const dialog = document.querySelector("[role=dialog], dialog");
      if (!dialog) return "none";
      const buttons = [...dialog.querySelectorAll("button")];
      const primary = dialog.querySelector("[data-modal-autofocus]") || buttons[buttons.length - 1];
      if (!primary) return "no-button";
      primary.click();
      return "dismissed";
    })()`);
  };

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
      booted: (window.__DSH_BOOT__?.entries ?? []).map((entry) => entry.name ?? entry.id ?? ""),
      styles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter(Boolean),
      labels: [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "").filter(Boolean),
    }))()`);
    check(
      "连接到 DSH 桌面 UI",
      typeof info?.title === "string" && info.title.length > 0,
      info?.title ?? "",
    );

    const loaded = (info?.booted ?? []).some((/** @type {any} */ name) =>
      String(name).includes(PLUGIN),
    );
    if (!loaded) {
      const count = Array.isArray(info?.booted) ? info.booted.length : 0;
      const message = `插件未装进当前 live profile（${PLUGIN}；已加载 ${count} 个 client 模块）`;
      if (values.require === true) {
        check("插件已加载（client 半）", false, message);
        throw new Error(message);
      }
      console.log(`SKIP ${message}`);
      console.log("（发版门禁请加 --require；装插件后需重启桌面版，host 半才会生效。）");
      return;
    }
    check("插件已加载（client 半）", true, "");

    const dismissed = await dismissFirstRunDialog();
    check("首启对话框已处理（不再 inert）", dismissed !== "no-button", dismissed);
    await sleep(400);

    // 1) 侧栏导航入口
    const navLabel = await cdp.evaluate(`(() => {
      const names = ["项目", "Projects"];
      for (const name of names) {
        const button = document.querySelector('button[aria-label="' + name + '"]');
        if (button) return name;
      }
      return "";
    })()`);
    check("侧栏有「项目」入口", typeof navLabel === "string" && navLabel !== "", navLabel);

    // 2) 打开面板
    await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="项目"]') || document.querySelector('button[aria-label="Projects"]');
      if (button) button.click();
    })()`);
    let opened = false;
    for (let i = 0; i < 25; i += 1) {
      opened = await cdp.evaluate(`Boolean(document.querySelector("[data-projects-panel]"))`);
      if (opened === true) break;
      await sleep(200);
    }
    check("项目面板已渲染", opened === true, "");
    await sleep(600);

    // 0) B1 首启引导（F63）：一次性弹窗，会盖住面板（fixed backdrop）。
    //    只读回归里点掉它；唯一的写入是 UI 状态 firstRunDone（storageDomain），
    //    不碰项目数据。已经看过（firstRunDone=true）时这里不存在，计 PASS。
    const guideSeen = await cdp.evaluate(
      `(() => {
        const node = document.querySelector("[data-projects-firstrun]");
        if (!node) return "absent";
        const button = document.querySelector("[data-projects-firstrun-cta]");
        if (!button) return "no-cta";
        button.click();
        return "dismissed";
      })()`,
    );
    await sleep(500);
    const guideGone = await cdp.evaluate(
      `document.querySelector("[data-projects-firstrun]") === null`,
    );
    check(
      "首启引导已处理（一次性，不挡后续操作）",
      guideSeen === "absent" || (guideSeen === "dismissed" && guideGone === true),
      String(guideSeen),
    );

    const status = await cdp
      .evaluate(
        `document.querySelector("[data-projects-panel]")?.getAttribute("data-projects-status") ?? ""`,
      )
      .catch(() => "");
    check(
      "面板状态可断言（data-projects-status）",
      /^(loading|ready)\|\d+\|(ok|error)\|\S*$/u.test(String(status)),
      String(status),
    );

    const crashed = await cdp
      .evaluate(`document.querySelector("[data-projects-crash]")?.textContent ?? ""`)
      .catch(() => "");
    check("面板没有渲染崩溃", crashed === "", String(crashed).slice(0, 200));

    const summary = await cdp
      .evaluate(`document.querySelector("[data-projects-summary]")?.textContent ?? ""`)
      .catch(() => "");
    check(
      "摘要文案已本地化（非裸 key）",
      typeof summary === "string" && summary !== "" && !summary.includes("panel."),
      String(summary),
    );

    // 3) 只读断言：新建入口打开模态、给出两条入口、名称为空时主按钮禁用（打开即关，不提交）
    //    注意：`data-projects-create-input`/`-create` 现在常驻 DOM 但在模态里（关闭时 display:none），
    //    只查"存在"会变成测隐藏控件，所以必须先点入口再查。
    await cdp.screenshot(join(SHOTS, "01-projects-panel.png"));
    const openedNew = await cdp.evaluate(`(() => {
      const button = document.querySelector("[data-projects-new]");
      if (!button) return "no-button";
      button.click();
      return "clicked";
    })()`);
    let modalSeen = false;
    for (let i = 0; i < 25; i += 1) {
      modalSeen = await cdp.evaluate(
        `document.querySelector("[data-projects-new-modal]")?.getAttribute("data-projects-new-modal") === "open"`,
      );
      if (modalSeen === true) break;
      await sleep(200);
    }
    const chooser = await cdp.evaluate(`(() => ({
      scratch: Boolean(document.querySelector("[data-projects-new-scratch]")),
      folder: Boolean(document.querySelector("[data-projects-new-folder]")),
      form: Boolean(document.querySelector("[data-projects-new-form]")),
    }))()`);
    check(
      "新建入口打开模态并给出两条入口（不提交）",
      openedNew === "clicked" &&
        modalSeen === true &&
        chooser?.scratch === true &&
        chooser?.folder === true &&
        chooser?.form === false,
      JSON.stringify({ openedNew, modalSeen, chooser }),
    );
    const emptyName = await cdp.evaluate(`(() => {
      const formHost = document.querySelector("[data-projects-new-scratch]");
      if (formHost) formHost.click();
      return true;
    })()`);
    await sleep(400);
    const createDisabled = await cdp.evaluate(
      `document.querySelector("[data-projects-create]")?.disabled === true`,
    );
    check(
      "项目名为空时创建按钮禁用（唯一门槛）",
      emptyName === true && createDisabled === true,
      String(createDisabled),
    );
    // 关掉模态（Esc），后续断言不应被遮罩影响
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await sleep(400);

    // 3b) 详情页两列（数据分支：live profile 里没有项目时 SKIP，而不是伪 PASS）
    const rowOpened = await cdp.evaluate(`(() => {
      const row = document.querySelector("[data-projects-row] button, [data-projects-row]");
      if (!row) return "no-row";
      row.click();
      return "clicked";
    })()`);
    if (rowOpened === "no-row") {
      skip("详情页两列（主列 + 右栏）", "live profile 没有项目，属于数据分支");
    } else {
      let detailSeen = false;
      for (let i = 0; i < 25; i += 1) {
        detailSeen = await cdp.evaluate(
          `Boolean(document.querySelector("[data-projects-detail]"))`,
        );
        if (detailSeen === true) break;
        await sleep(200);
      }
      const rail = await cdp.evaluate(`(() => {
        const detail = document.querySelector("[data-projects-detail]");
        if (!detail) return null;
        const text = detail.innerText || "";
        return {
          hasInstructions: Boolean(document.querySelector("[data-projects-instructions]")),
          hasContextSection: /指令/u.test(text) && /记忆/u.test(text) && /上下文/u.test(text),
          hasThreads: Boolean(document.querySelector("[data-projects-threads]")),
        };
      })()`);
      check(
        "详情页渲染主列 + 右栏三段（指令/记忆/上下文）",
        detailSeen === true &&
          rail?.hasInstructions === true &&
          rail?.hasContextSection === true &&
          rail?.hasThreads === true,
        JSON.stringify({ detailSeen, rail }),
      );
      const back = await cdp.evaluate(`(() => {
        const button = document.querySelector("[data-projects-detail-back]");
        if (!button) return "no-button";
        button.click();
        return "clicked";
      })()`);
      await sleep(500);
      check("详情页可返回列表", back !== "no-button", String(back));
    }
    await cdp.screenshot(join(SHOTS, "01b-projects-list.png"));

    // 4) 设置分节
    const openedSettings = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((b) =>
        /设置|Settings/u.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || "") + " " + (b.getAttribute("title") || "")),
      );
      if (!button) return "no-button";
      button.click();
      return "clicked";
    })()`);
    let settingsSeen = false;
    for (let i = 0; i < 25; i += 1) {
      settingsSeen = await cdp.evaluate(
        `Boolean(document.querySelector("[data-projects-settings]"))`,
      );
      if (settingsSeen === true) break;
      await sleep(200);
    }
    // 有些 profile 会把设置页整体禁用（cordis.patch.yml 里 ui-settings enabled:false），那就无从打开。
    check(
      "设置页出现「项目」分节",
      settingsSeen === true || openedSettings === "no-button",
      settingsSeen ? "rendered" : `tolerated: ${openedSettings}（设置页未启用）`,
    );
    await cdp.screenshot(join(SHOTS, "02-projects-settings.png"));

    // 5) 关闭设置并回到会话，确认界面未崩
    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await sleep(500);
    const bodyLength = await cdp.evaluate(`document.body.innerText.trim().length`);
    check(
      "关闭后界面仍可用",
      typeof bodyLength === "number" && bodyLength > 50,
      String(bodyLength),
    );
    await cdp.screenshot(join(SHOTS, "03-back.png"));
  } catch (error) {
    if (!checks.some((item) => item.ok === false)) {
      check("桌面回归执行", false, error instanceof Error ? error.message : String(error));
    }
  } finally {
    cdp?.ws.close();
  }

  let failed = 0;
  for (const item of checks) {
    console.log((item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`));
    if (!item.ok) failed += 1;
  }
  for (const item of skips) {
    console.log("SKIP " + item.name + (item.detail ? ` :: ${item.detail}` : ""));
  }
  console.log(`截图目录：${SHOTS}`);
  if (failed > 0) {
    console.error(`FAIL ${failed} 项桌面回归断言失败`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS 全部 ${checks.length} 项桌面回归断言通过` +
        (skips.length > 0 ? `（另有 ${skips.length} 项数据分支 SKIP）` : ""),
    );
  }
  // 门禁靠这一行判定「跑过但一条断言都没执行」（见 docs/plugin-conventions.md §6.1）。
  console.log(`${checks.length - failed} PASS / ${skips.length} SKIP / ${failed} FAIL`);
};

await main();
