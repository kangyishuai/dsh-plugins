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
// 默认**只读**：只切会话、开关对话框/面板，不创建/不删除任何东西，因此可以直接跑在真实 profile 上。
//   pnpm smoke:projects-desktop            # 只读：live profile 里有项目就真断言详情页，没有就 SKIP
//   pnpm smoke:projects-desktop --create   # 显式授权写入：用 UI 建一个临时项目 → 断言 → 删除 → 彻底删除
// `--create` 会写 live profile（建一个 `smoke-desktop-<ts>` 的临时项目，收尾在回收站里彻底删除，
// 并断言盘上 `projects.json` 里已没有它），所以**默认关**。
//
// 断言覆盖：
//   连接桌面 UI / 插件 client 半已加载 / 宿主首启对话框处理 / 侧栏「项目」入口 / 面板渲染 /
//   B1 首启引导只断言存在不点击（**不写 live profile 的 firstRunDone**）/ data-projects-status 形状 /
//   无渲染崩溃 / 摘要已本地化 / 新建控件存在（不提交）/
//   详情页两列栅格 + 6 个状态药丸 + 3 个页签（§7.3）+ Library 右栏入口 + 审计不在详情页 /
//   设置四个分区 + 审计在 Debug 分区（设置页被禁用时如实 SKIP）/ Esc 关闭后界面仍可用 / 截图落盘。
//   `--create` 另有：建临时项目 / 删除进回收站 / 彻底删除 / 盘上 projects.json 校验。
// 未装进 live profile 时默认 SKIP（门禁加 --require 则失败）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
      // 默认只读；--create 会用 UI 建一个临时项目、断言完再删除（写 live profile，故默认关）
      create: { type: "boolean", default: false },
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
    //    **只读口径（B1 审查 P1-5）**：只断言它存在、CTA 有文案，**不点**——
    //    点 CTA 会写 live profile 的 `firstRunDone`（storageDomain），那就不是只读了。
    //    为了不挡后面的只读断言，这里只把节点从 DOM 里摘掉：不写任何存储，
    //    页面刷新后引导还在（下次跑仍能看到）。
    const guide = await cdp.evaluate(
      `(() => {
        const node = document.querySelector("[data-projects-firstrun]");
        if (!node) return { seen: false, cta: "", persisted: "" };
        const button = document.querySelector("[data-projects-firstrun-cta]");
        const cta = (button && button.textContent ? button.textContent : "").trim();
        const persisted = node.getAttribute("data-projects-firstrun-persisted") || "";
        node.remove();
        return { seen: true, cta, persisted };
      })()`,
    );
    await sleep(300);
    const guideGone = await cdp.evaluate(
      `document.querySelector("[data-projects-firstrun]") === null`,
    );
    check(
      "首启引导只断言存在、不点击（不写 live profile 的 firstRunDone）",
      guideGone === true &&
        (guide?.seen === false ||
          (guide?.seen === true &&
            typeof guide.cta === "string" &&
            guide.cta !== "" &&
            ["yes", "no"].includes(String(guide.persisted)))),
      JSON.stringify(guide),
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
    // 关掉模态：点 ✕。**不能靠 document 上派发 Esc**——模态的 onKeyDownCapture 只在焦点位于
    // 模态内部时触发，派发到 document 不冒泡下去（实测：模态一直开着，后面点账户菜单全被遮罩吃掉）。
    const modalClosed = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isOpen = () =>
        document.querySelector('[data-projects-new-modal="open"]') !== null;
      if (!isOpen()) return "already-closed";
      const close = document.querySelector("[data-projects-new-close]");
      if (close) close.click();
      for (let i = 0; i < 20; i += 1) {
        if (!isOpen()) return "closed";
        await wait(150);
      }
      return "still-open";
    })()`);
    check(
      "新建项目模态可关闭（✕ 生效，后续断言不被遮罩影响）",
      modalClosed === "closed" || modalClosed === "already-closed",
      String(modalClosed),
    );
    await sleep(300);

    // 3b) 详情页两列 + 6 个状态药丸 + 3 个页签（§7.3：页签最多 3；Library 走右栏入口、审计进设置）。
    //     **默认只读**：拿 live profile 里已有的项目断言；一个项目都没有时如实 SKIP（不伪 PASS）。
    //     --create：先用 UI 从零建一个临时项目，断言完再用同一套 UI「删除 → 回收站 → 彻底删除」，
    //               最后断言盘上 projects.json 里已没有它（因此这个开关默认关）。
    const tempName = `smoke-desktop-${Date.now().toString(36)}`;
    let projectName = "";

    /** 详情页快照：两列栅格 / 药丸 / 页签 / 右栏三段 / 外迁后的入口。 */
    const detailSnapshot = () =>
      cdp.evaluate(`(() => {
        const grid = document.querySelector("[data-projects-detail-grid]");
        const main = document.querySelector("[data-projects-detail-main]");
        const rail = document.querySelector("[data-projects-rail]");
        const detail = document.querySelector("[data-projects-detail]");
        const text = (detail && detail.innerText) || "";
        const left = (node) => (node ? node.getBoundingClientRect().left : Number.NaN);
        return {
          detail: Boolean(detail),
          grid: Boolean(grid),
          main: Boolean(main),
          rail: Boolean(rail),
          // Claude 结构：左=对话（main）、右=Threads 面板（panel-column），rail 只在抽屉里
          panel: Boolean(document.querySelector("[data-panel-column]")),
          // 两列：右栏在主列右侧。窄窗（容器 < 820px，见 client 的 gridRef）
          // 会折成单列，那时只能断言三个锚点都在；宽窗时必须是并排。
          gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
          twoColumn:
            Boolean(grid) &&
            Boolean(main) &&
            Boolean(document.querySelector("[data-panel-column]")) &&
            left(document.querySelector("[data-panel-column]")) > left(main),
          pills: document.querySelectorAll("[data-projects-pill]").length,
          tabs: [...document.querySelectorAll("[data-projects-tab]")].map((node) =>
            node.getAttribute("data-projects-tab"),
          ),
          libraryOpen: Boolean(document.querySelector("[data-projects-library-open]")),
          auditInDetail: Boolean(
            document.querySelector("[data-projects-audit], [data-projects-audit-empty]"),
          ),
          hasInstructions: Boolean(document.querySelector("[data-projects-instructions]")),
          hasContextSection: /指令|Instructions/u.test(text) && /记忆|Memory/u.test(text) && /上下文|Context/u.test(text),
          hasThreads: Boolean(document.querySelector("[data-projects-threads], [data-projects-threads-empty]")),
        };
      })()`);

    if (values.create === true) {
      const created = await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const name = ${JSON.stringify(tempName)};
        const openButton = document.querySelector("[data-projects-new]");
        if (!openButton) return "no-new-button";
        openButton.click();
        for (let i = 0; i < 25; i += 1) {
          const modal = document.querySelector("[data-projects-new-modal]");
          if (modal && modal.getAttribute("data-projects-new-modal") === "open") break;
          await wait(200);
        }
        const scratch = document.querySelector("[data-projects-new-scratch]");
        if (!scratch) return "no-scratch-entry";
        scratch.click();
        await wait(400);
        const input = document.querySelector("[data-projects-create-input]");
        if (!input) return "no-input";
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(300);
        const button = document.querySelector("[data-projects-create]");
        if (!button || button.disabled === true) return "create-disabled";
        button.click();
        for (let i = 0; i < 40; i += 1) {
          const rows = [...document.querySelectorAll("[data-projects-row]")];
          if (rows.some((row) => ((row && row.innerText) || "").includes(name))) return "created";
          await wait(250);
        }
        return "no-row";
      })()`);
      projectName = created === "created" ? tempName : "";
      check(
        "--create：用 UI 从零建一个临时项目（smoke-desktop-<ts>）",
        created === "created",
        String(created),
      );
    }

    // live profile 可能停在详情页（上次打开的项目）：先返回列表，否则"行数=0"会被误判成空 profile
    await cdp.evaluate(`(() => {
      const back = document.querySelector("[data-projects-detail-back]");
      if (back) back.click();
      return Boolean(back);
    })()`);
    await sleep(600);
    const rowOpened = await cdp.evaluate(
      projectName === ""
        ? `(() => {
            const row = document.querySelector("[data-projects-row]");
            if (!row) return "no-row";
            row.click();
            return "clicked-row";
          })()`
        : `(() => {
            const name = ${JSON.stringify(projectName)};
            const row = [...document.querySelectorAll("[data-projects-row]")].find((node) =>
              ((node && node.innerText) || "").includes(name),
            );
            if (!row) return "no-row";
            // 行本身带 onClick；点行内的第一个按钮会点到 pin/⋯（实测进不了详情）
            row.click();
            return "clicked-row";
          })()`,
    );
    if (rowOpened === "no-row") {
      if (values.create === true) {
        check("详情页两列（主列 + 右栏）", false, "临时项目建好后找不到项目行");
      } else {
        // 没有项目时**不跳过**：详情页无从打开，但空态本身是可见的产品状态，
        // 断言它比记一条 SKIP 更有价值（0 SKIP 也不靠“跳过冒充覆盖”）。
        // 详情页本身由 `--create` 覆盖（发版门禁用 `--require --create`）。
        const emptyState = await cdp.evaluate(`(() => {
          const q = (sel) => document.querySelector(sel);
          const text = (sel) => ((q(sel) || {}).textContent || "").replace(/\\s+/g, " ").trim();
          const empty = q("[data-projects-empty]");
          const summary = (q("[data-projects-summary]") || {}).textContent || "";
          return {
            empty: Boolean(empty),
            title: empty ? (empty.querySelector("span") || {}).textContent || "" : "",
            hint: empty ? (empty.textContent || "").trim() : "",
            summary: summary.replace(/\\s+/g, " ").trim(),
            newButton: Boolean(q("[data-projects-new]")),
            newDisabled: Boolean((q("[data-projects-new]") || {}).disabled),
            trashHint: /回收站/u.test(empty ? (empty.parentElement || empty).textContent || "" : ""),
            rows: document.querySelectorAll("[data-projects-row]").length,
          };
        })()`);
        check(
          "无项目时空态正确（标题/说明/CTA/摘要都是真实渲染）",
          emptyState?.empty === true &&
            String(emptyState.title).trim().length > 0 &&
            String(emptyState.hint).trim().length > 0 &&
            emptyState.newButton === true &&
            emptyState.newDisabled === false &&
            emptyState.rows === 0 &&
            /0 个项目|0 projects/u.test(String(emptyState.summary)),
          JSON.stringify(emptyState),
        );
        check(
          "无项目时回收站入口提示可见（不作假空列表）",
          emptyState?.trashHint === true,
          JSON.stringify({ trashHint: emptyState?.trashHint }),
        );
      }
    } else {
      let detailSeen = false;
      for (let i = 0; i < 25; i += 1) {
        detailSeen = await cdp.evaluate(
          `Boolean(document.querySelector("[data-projects-detail-grid]"))`,
        );
        if (detailSeen === true) break;
        await sleep(200);
      }
      // 线程区在 tab 内容里，比头部晚一拍渲染：等它出现再取快照，否则 hasThreads 会假红。
      for (let i = 0; i < 20; i += 1) {
        const ready = await cdp.evaluate(
          `Boolean(document.querySelector("[data-projects-threads], [data-projects-threads-empty]"))`,
        );
        if (ready === true) break;
        await sleep(150);
      }
      const snap = await detailSnapshot();
      check(
        "详情页是两列栅格（data-projects-detail-grid/main/rail）",
        detailSeen === true &&
          snap.detail === true &&
          snap.grid === true &&
          snap.main === true &&
          snap.rail === true &&
          (snap.twoColumn === true || snap.gridWidth < 820),
        JSON.stringify({
          detailSeen,
          grid: snap.grid,
          main: snap.main,
          rail: snap.rail,
          gridWidth: snap.gridWidth,
          twoColumn: snap.twoColumn,
        }),
      );
      check(
        "详情页有 6 个状态药丸 + 3 个页签（线程/记忆/Routines，§7.3 上限 3）",
        snap.pills === 6 &&
          Array.isArray(snap.tabs) &&
          snap.tabs.length === 3 &&
          ["threads", "memory", "routines"].every((id) => snap.tabs.includes(id)) &&
          !snap.tabs.includes("library") &&
          !snap.tabs.includes("audit"),
        JSON.stringify({ pills: snap.pills, tabs: snap.tabs }),
      );
      check(
        "Library 走右栏入口、审计不在详情页（§7.3 外迁后无残留）",
        snap.libraryOpen === true && snap.auditInDetail === false,
        JSON.stringify({ libraryOpen: snap.libraryOpen, auditInDetail: snap.auditInDetail }),
      );
      // 结构对齐 Claude 后：详情页 = 左对话 + 右面板；指令/记忆/上下文在「项目设置」抽屉里
      const drawer = await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const open = document.querySelector("[data-panel-settings-open]");
        if (open) open.click();
        for (let i = 0; i < 20; i += 1) {
          if (document.querySelector('[data-panel-settings-drawer="open"]')) break;
          await wait(150);
        }
        const d = document.querySelector('[data-panel-settings-drawer="open"]');
        const text = (d && d.innerText) || "";
        const result = {
          open: Boolean(d),
          instructions: /指令|Instructions/u.test(text),
          memory: /记忆|Memory/u.test(text),
          context: /上下文|Context/u.test(text),
        };
        document.querySelector("[data-panel-settings-close]")?.click();
        return result;
      })()`);
      check(
        "详情页：右面板（线程/药丸）+ 设置抽屉三段（指令/记忆/上下文）",
        snap.panel === true &&
          snap.hasThreads === true &&
          drawer?.open === true &&
          drawer?.instructions === true &&
          drawer?.memory === true &&
          drawer?.context === true,
        JSON.stringify({ panel: snap.panel, threads: snap.hasThreads, drawer }),
      );
      const back = await cdp.evaluate(`(() => {
        const button = document.querySelector("[data-projects-detail-back]");
        if (!button) return "no-button";
        button.click();
        return "clicked";
      })()`);
      await sleep(600);
      check("详情页可返回列表", back !== "no-button", String(back));

      if (projectName !== "") {
        // —— --create 收尾：同一套 UI 删除 → 回收站 → 彻底删除 → 盘上校验 ——
        const deleted = await cdp.evaluate(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const name = ${JSON.stringify(projectName)};
          const row = [...document.querySelectorAll("[data-projects-row]")].find((node) =>
            ((node && node.innerText) || "").includes(name),
          );
          if (!row) return "no-row";
          row.click();
          for (let i = 0; i < 25; i += 1) {
            if (document.querySelector("[data-projects-detail]")) break;
            await wait(200);
          }
          const menu = document.querySelector("[data-projects-row-menu]");
          if (!menu) return "no-menu";
          menu.click();
          await wait(500);
          const del = document.querySelector("[data-projects-delete]");
          if (!del) return "no-delete-item";
          del.click();
          for (let i = 0; i < 30; i += 1) {
            if (document.querySelector("[data-projects-delete-confirm-panel]")) break;
            await wait(200);
          }
          const confirm = document.querySelector("[data-projects-delete-confirm]");
          if (!confirm) return "no-confirm";
          confirm.click();
          for (let i = 0; i < 40; i += 1) {
            if (!document.querySelector("[data-projects-detail]")) return "deleted";
            await wait(250);
          }
          return "still-open";
        })()`);
        check(
          "--create：详情 ⋯ → 删除 → 确认（项目进入回收站）",
          deleted === "deleted",
          String(deleted),
        );
        const purged = await cdp.evaluate(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const name = ${JSON.stringify(projectName)};
          const findRow = () =>
            [...document.querySelectorAll("[data-projects-trash-row]")].find((node) =>
              ((node && node.innerText) || "").includes(name),
            );
          for (let i = 0; i < 40; i += 1) {
            const row = findRow();
            if (row) {
              const button = row.querySelector("[data-projects-trash-delete]");
              if (!button) return "no-trash-button";
              button.click();
              await wait(700);
              const again = findRow();
              const confirmButton = again ? again.querySelector("[data-projects-trash-delete]") : null;
              if (!confirmButton) return "gone-before-confirm";
              confirmButton.click();
              for (let j = 0; j < 40; j += 1) {
                await wait(250);
                if (!findRow()) return "purged";
              }
              return "still-in-trash";
            }
            await wait(250);
          }
          return "no-trash-row";
        })()`);
        check("--create：回收站里彻底删除（两步确认）", purged === "purged", String(purged));
        const stillListed = await cdp.evaluate(`(() => {
          const name = ${JSON.stringify(projectName)};
          return [...document.querySelectorAll("[data-projects-row]")].some((node) =>
            ((node && node.innerText) || "").includes(name),
          );
        })()`);
        // 盘上校验：数据根与宿主一致（DSH_HOME/projects 或 ~/.dsh/projects，可用
        // DSH_PROJECTS_DATA_ROOT 覆盖——只读回归不写 profile，这里只读 projects.json）。
        const dataRoot =
          process.env.DSH_PROJECTS_DATA_ROOT ||
          (process.env.DSH_HOME
            ? join(process.env.DSH_HOME, "projects")
            : join(homedir(), ".dsh", "projects"));
        const projectsFile = join(dataRoot, "projects.json");
        let raw = "";
        for (let i = 0; i < 20; i += 1) {
          raw = await readFile(projectsFile, "utf8").catch(() => "");
          if (raw !== "" && !raw.includes(projectName)) break;
          await sleep(250);
        }
        check(
          "--create：盘上 projects.json 里已没有这个临时项目",
          raw !== "" && !raw.includes(projectName) && stillListed === false,
          JSON.stringify({ dataRoot, readable: raw !== "", stillListed }),
        );
      }
    }
    await cdp.screenshot(join(SHOTS, "01b-projects-list.png"));

    // 4) 设置分节
    // 先清掉可能残留的弹窗/菜单（新建项目模态、宿主菜单等），否则账户菜单点不动。
    for (let i = 0; i < 2; i += 1) {
      await cdp.evaluate(
        `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
      );
      await sleep(250);
    }
    const openedSettings = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      if (document.querySelector("[data-projects-settings]")) return "already-open";
      // 设置入口在**左下角账户菜单**里（0.2.2-rc.5 实测：「设置 ⌘ ,」是菜单项，不是独立按钮）。
      // 弹窗/菜单残留会让第一次点击落空，所以最多重试 3 次，并且以「菜单真的出现」为准。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const trigger =
          document.querySelector('button[aria-label="账号菜单"], button[aria-label="Account menu"]') ||
          [...document.querySelectorAll("button[aria-haspopup='menu']")].at(-1);
        if (!trigger) break;
        trigger.click();
        for (let i = 0; i < 10; i += 1) {
          if (document.querySelector("[role=menu]")) break;
          await wait(120);
        }
        const item = [...document.querySelectorAll("[role=menuitem]")].find((node) =>
          /^(设置|Settings)/.test(((node.textContent || "").trim())),
        );
        if (item) {
          item.click();
          await wait(700);
          return "account-menu";
        }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await wait(250);
      }
      // 兜底：有些版本把设置放成独立按钮
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
    if (settingsSeen !== true) {
      // 设置页默认停在「账号与余额」：在**设置弹窗内**点「项目」分节再等一轮。
      // 注意不能全局搜按钮——侧栏也有一个「项目」入口，点它会顶掉设置弹窗（实测踩过）。
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const dialog = [...document.querySelectorAll("[role=dialog], dialog")].find((node) =>
          /设置|Settings/u.test((node.textContent || "").slice(0, 200)),
        );
        if (!dialog) return "no-dialog";
        const cell = [...dialog.querySelectorAll("button, [role=tab], [role=menuitem], [role=button]")].find(
          (node) => /^(项目|Projects)/u.test(((node.textContent || "").trim())),
        );
        if (cell) cell.click();
        await wait(500);
        return cell ? "clicked-section" : "no-section";
      })()`);
      for (let i = 0; i < 20; i += 1) {
        settingsSeen = await cdp.evaluate(
          `Boolean(document.querySelector("[data-projects-settings]"))`,
        );
        if (settingsSeen === true) break;
        await sleep(200);
      }
    }
    // 有些 live profile 会把设置页整体禁用（cordis.patch.yml 里 ui-settings enabled:false）。
    // 那不是「通过」：渲染了就真断言，没渲染就如实 SKIP（计数行不把跳过冒充覆盖）。
    // 打开就真断言（不是「渲染了就算过」）；打不开才 SKIP，并且把跳过写进计数行。
    // 我们的分节可能比对话框晚一拍渲染：等到 nav 出现再快照（否则 nav:[] 会误判成"没有分区"）
    if (settingsSeen === true) {
      for (let i = 0; i < 25; i += 1) {
        const ready = await cdp.evaluate(
          `document.querySelectorAll("[data-projects-settings-nav-item]").length > 0`,
        );
        if (ready) break;
        await sleep(200);
      }
    }
    const settingsSnap =
      settingsSeen === true
        ? await cdp.evaluate(`(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const nav = [...document.querySelectorAll("[data-projects-settings-nav-item]")].map(
              (node) => node.getAttribute("data-projects-settings-nav-item"),
            );
            const debugNav = document.querySelector('[data-projects-settings-nav-item="debug"]');
            if (debugNav) debugNav.click();
            await wait(1200);
            return {
              panel: Boolean(document.querySelector("[data-projects-settings]")),
              sections: document.querySelector("[data-projects-settings]")?.getAttribute("data-projects-settings-section") || "",
              nav,
              debugPanel: Boolean(document.querySelector("[data-projects-settings-debug]")),
              auditTitle: document.querySelector("[data-projects-audit-title]")?.textContent || "",
              audit: Boolean(document.querySelector("[data-projects-audit], [data-projects-audit-empty]")),
            };
          })()`)
        : null;
    if (settingsSeen === true) {
      check(
        "设置页出现「项目」分节（四个分区，Debug 可进入）",
        settingsSnap?.panel === true &&
          Array.isArray(settingsSnap.nav) &&
          settingsSnap.nav.join(",") === "general,memory,usage,debug" &&
          settingsSnap.sections === "debug" &&
          settingsSnap.debugPanel === true,
        JSON.stringify(settingsSnap),
      );
      check(
        "审计在设置 Debug 分区（原项目详情页签外迁；空态也算）",
        settingsSnap?.audit === true && /审计|Audit/u.test(String(settingsSnap.auditTitle)),
        JSON.stringify({ audit: settingsSnap?.audit, title: settingsSnap?.auditTitle }),
      );
    } else if (openedSettings === "no-button") {
      const reason = "找不到设置入口（该 profile/宿主版本没有设置页）";
      skip("设置页出现「项目」分节（四个分区，Debug 可进入）", reason);
      skip("审计在设置 Debug 分区（原项目详情页签外迁；空态也算）", reason);
    } else {
      const reason = `点开设置入口后没有项目分节（${openedSettings}）`;
      skip("设置页出现「项目」分节（四个分区，Debug 可进入）", reason);
      skip("审计在设置 Debug 分区（原项目详情页签外迁；空态也算）", reason);
    }
    await cdp.screenshot(join(SHOTS, "02-projects-settings.png"));

    // 5) 关闭设置并回到会话，确认界面未崩（优先点宿主弹窗自带的关闭按钮）
    await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const dialog = [...document.querySelectorAll("[role=dialog], dialog")].find((node) =>
        /设置|Settings/u.test((node.textContent || "").slice(0, 120)),
      );
      const close = dialog
        ? [...dialog.querySelectorAll("button")].find((node) =>
            /^(关闭|Close)$/.test((node.textContent || "").trim()),
          )
        : null;
      if (close) close.click();
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(400);
    })()`);
    await sleep(400);
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
    console.log(`SKIP ${item.name}${item.detail ? ` :: ${item.detail}` : ""}`);
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
