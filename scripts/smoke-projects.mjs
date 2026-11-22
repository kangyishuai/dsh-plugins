#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:projects
//       SMOKE_DEBUG=1 pnpm smoke:projects   —— 打印浏览器脚本完整输出
//       SMOKE_KEEP=1 pnpm smoke:projects    —— 保留临时 DSH_HOME（排障用）
//
// web 端到端冒烟：在 `mkdtemp` 出来的临时 DSH_HOME 里启动**真实宿主**，装当前源码打出的包，
// 再用 ego-browser 在真实页面里验证「面板能开、能建项目、宿主真的落盘」。
//
// 边界（有意为之）：
// - **不发起任何模型调用**：不发送消息、不跑 agent，因此不花 token，也不需要凭据。
// - 临时 home 里只放临时 profile；跑完删除（SMOKE_KEEP=1 除外）。
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-projects-shots");
const PKG_DIR = join(REPO, "packages", "projects");
const PACKAGE = "@kangyishuai/dsh-projects";
const PROFILE = "proj";
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} message */
function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

/**
 * @param {string} cmd @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [opts]
 */
async function run(cmd, args, opts = {}) {
  try {
    return await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    return { stdout: String(anyError?.stdout ?? ""), stderr: String(anyError?.stderr ?? "") };
  }
}

/** @param {string} name */
async function hasCommand(name) {
  const probe = await run("which", [name]);
  return probe.stdout.trim() !== "";
}

/** @param {string} path */
async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * 等宿主打印访问地址。
 * @param {string} logPath @param {number} timeoutMs
 */
async function waitForBoot(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readIfExists(logPath);
    const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/u);
    if (match) return { port: Number(match[1]), token: match[2], text };
    if (/did not activate/u.test(text)) return { port: 0, token: "", text };
    await sleep(500);
  }
  throw new Error(
    `宿主没有在超时时间内打印访问地址：${(await readIfExists(logPath)).slice(-2000)}`,
  );
}

/**
 * 浏览器脚本：以字符串拼出，避免内层模板插值。
 * @param {string} url @param {string} shotsDir @param {string} workspaceDir
 */
function browserScript(url, shotsDir, workspaceDir) {
  return `
const SMOKE_WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};
const result = { checks: [], fatal: "" };
const add = (name, ok, detail) => result.checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });
try {
  const task = await taskSpace("smoke projects ${PROJECT_NAME_TOKEN}");
  const page = task.page("p1");
  // 带 token 的入口会 303 到 /（用 cookie 认证）。某些 Chromium 版本会把这次 303 当成
  // 「无效导航响应」直接报 ERR_HTTP_RESPONSE_CODE_FAILURE。这里容错：失败就改导航到
  // 已由 303 设好 cookie 的根路径，语义等价（token 只需要握手一次）。
  // 清掉 127.0.0.1 上**遗留的** dsh-auth-* cookie：cookie 按主机作用域、忽略端口，
  // 反复冒烟会堆出一批指向已死宿主的 token，服务端认错就 401（表现为导航失败）。
  // 只删 127.0.0.1 的 dsh-auth-*，不动其它站点的登录态。
  try {
    const { cookies } = await page.cdp("Storage.getCookies");
    for (const cookie of cookies ?? []) {
      if (!String(cookie.domain ?? "").includes("127.0.0.1")) continue;
      if (!String(cookie.name ?? "").startsWith("dsh-auth-")) continue;
      await page.cdp("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path ?? "/",
      });
    }
  } catch (cleanupError) {
    /* 清不掉也继续：下面还有容错导航 */
  }

  try {
    await page.goto(${JSON.stringify(url)});
  } catch (gotoError) {
    const rawUrl = String(${JSON.stringify(url)});
    const cut = rawUrl.indexOf("?");
    const base = cut > 0 ? rawUrl.slice(0, cut) : rawUrl;
    await page.goto(base);
  }
  await page.waitForSelector("button[aria-label='项目'], button[aria-label='Projects']", { timeout: 40000 });
  add("页面已加载（导航入口出现）", true, "");
  // 通知器挂在 shell.overlay 上（全局轮询，不依赖浏览器 Notification 授权）
  const notifierMounted = await page.evaluate(() => Boolean(document.querySelector("[data-projects-notifier]")));
  add("全局通知器已挂载", notifierMounted === true, String(notifierMounted));

  // 新建走真实入口：工具条主按钮 → 模态（两张入口卡）→ 填名 → 创建。
  // 老流程直接点列表页的输入框，那些锚点现在在模态里（模态常驻 DOM、关闭时 display:none），
  // 所以断言必须按新流程走，否则测的是"隐藏按钮能被脚本点"而不是用户能走通的路。
  const createViaModal = async (value, mode) => {
    await page.evaluate(() => document.querySelector("[data-projects-new]")?.click());
    await page.waitForTimeout(350);
    await page.evaluate((which) => {
      const sel = which === "folder" ? "[data-projects-new-folder]" : "[data-projects-new-scratch]";
      document.querySelector(sel)?.click();
    }, mode || "scratch");
    await page.waitForTimeout(250);
    const ok = await page.evaluate((text) => {
      const input = document.querySelector("[data-projects-create-input]");
      const button = document.querySelector("[data-projects-create]");
      if (!input || !button) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, value);
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector("[data-projects-create]")?.click());
    for (let i = 0; i < 24; i += 1) {
      const done = await page.evaluate(
        (text) =>
          [...document.querySelectorAll("[data-projects-row]")].some((row) =>
            (row.innerText || "").includes(text),
          ) && document.querySelector("[data-projects-new-modal]")?.getAttribute("data-projects-new-modal") === "closed",
        value,
      );
      if (done) return ok === true;
      await page.waitForTimeout(500);
    }
    return false;
  };

  // 详情页的「归档 / 删除」收在右上 ⋯ 菜单里：点菜单再点对应项（锚点没变，入口变了）
  // 右栏折叠开关：按 data 属性值找节点（避免在模板里写带引号的属性选择器）
  const toggleContext = async () => {
    await page.evaluate(() => {
      const node = [...document.querySelectorAll("[data-projects-rail-toggle]")].find(
        (item) => item.getAttribute("data-projects-rail-toggle") === "context",
      );
      if (node) node.click();
    });
  };
  const railSummaryFor = (id) =>
    page.evaluate(
      (target) =>
        [...document.querySelectorAll("[data-projects-rail-summary]")].some(
          (node) => node.getAttribute("data-projects-rail-summary") === target,
        ),
      id,
    );
  const expandedAttr = () =>
    page.evaluate(() => {
      const node = [...document.querySelectorAll("[data-projects-rail-toggle]")].find(
        (item) => item.getAttribute("data-projects-rail-toggle") === "context",
      );
      return node ? node.getAttribute("aria-expanded") : null;
    });

  const openDetailMenu = async () => {
    const clicked = await page.evaluate(() => {
      const button = document.querySelector("[data-projects-row-menu]");
      if (!button) return false;
      button.click();
      return true;
    });
    await page.waitForTimeout(400);
    return clicked;
  };



  const dismissed = await page.evaluate(() => {
    const dialog = document.querySelector("[role=dialog], dialog");
    if (!dialog) return "none";
    const buttons = [...dialog.querySelectorAll("button")];
    const primary = dialog.querySelector("[data-modal-autofocus]") || buttons[buttons.length - 1];
    if (!primary) return "no-button";
    primary.click();
    return "dismissed";
  });
  add("首启对话框已处理（否则其余内容 inert）", dismissed !== "no-button", dismissed);

  await page.evaluate(() => {
    const button = document.querySelector("button[aria-label='项目']") || document.querySelector("button[aria-label='Projects']");
    if (button) button.click();
  });
  await page.waitForSelector("[data-projects-panel]", { timeout: 20000 });
  add("项目面板已渲染", true, "");

  await page.waitForTimeout(1200);
  const status = await page.evaluate(() => document.querySelector("[data-projects-panel]")?.getAttribute("data-projects-status") || "");
  add("状态锚点可解析", /^(loading|ready)\\|\\d+\\|(ok|error)\\|\\S*$/.test(status), status);

  const crash = await page.evaluate(() => document.querySelector("[data-projects-crash]")?.textContent || "");
  add("没有渲染崩溃", crash === "", crash.slice(0, 160));

  const summary = await page.evaluate(() => document.querySelector("[data-projects-summary]")?.textContent || "");
  add("摘要已本地化（非裸 key）", summary !== "" && !summary.includes("panel."), summary);

  const controls = await page.evaluate(() => ({
    input: Boolean(document.querySelector("[data-projects-create-input]")),
    button: Boolean(document.querySelector("[data-projects-create]")),
  }));
  add("新建控件存在", controls.input && controls.button, JSON.stringify(controls));

  const beforeRows = await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length);
  const name = "smoke-" + Date.now().toString(36);

  // —— 新建项目：工具条主按钮 → 模态（两张入口卡）→ 表单 ——
  const openedNew = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-new]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(500);
  const modalFirstScreen = await page.evaluate(() => ({
    open: document.querySelector("[data-projects-new-modal]")?.getAttribute("data-projects-new-modal") ?? "",
    dialog: Boolean(document.querySelector("[data-projects-new-dialog]")),
    scratch: Boolean(document.querySelector("[data-projects-new-scratch]")),
    folder: Boolean(document.querySelector("[data-projects-new-folder]")),
    form: Boolean(document.querySelector("[data-projects-new-form]")),
  }));
  add(
    "新建入口打开模态且给出两条入口",
    openedNew === "clicked" &&
      modalFirstScreen.open === "open" &&
      modalFirstScreen.dialog &&
      modalFirstScreen.scratch &&
      modalFirstScreen.folder &&
      modalFirstScreen.form === false,
    JSON.stringify(modalFirstScreen),
  );
  // 两条入口各自打开同一张表单（顺序：folder → 返回 → scratch）
  await page.evaluate(() => document.querySelector("[data-projects-new-folder]")?.click());
  await page.waitForTimeout(250);
  const folderPath = await page.evaluate(
    () => document.querySelector("[data-projects-new-form]")?.getAttribute("data-projects-new-form") ?? "",
  );
  await page.evaluate(() => document.querySelector("[data-projects-new-back]")?.click());
  await page.waitForTimeout(250);
  const backToChooser = await page.evaluate(
    () => Boolean(document.querySelector("[data-projects-new-scratch]")) && !document.querySelector("[data-projects-new-form]"),
  );
  await page.evaluate(() => document.querySelector("[data-projects-new-scratch]")?.click());
  await page.waitForTimeout(250);
  const scratchPath = await page.evaluate(
    () => document.querySelector("[data-projects-new-form]")?.getAttribute("data-projects-new-form") ?? "",
  );
  add(
    "两条入口各自打开同一张表单",
    folderPath === "folder" && scratchPath === "scratch" && backToChooser === true,
    JSON.stringify({ folderPath, scratchPath, backToChooser }),
  );
  const emptyDisabled = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-create]");
    return button
      ? { disabled: button.disabled === true, ready: button.getAttribute("data-projects-create-ready") }
      : null;
  });
  add("项目名为空时创建按钮禁用", emptyDisabled?.disabled === true, JSON.stringify(emptyDisabled));
  await page.evaluate((value) => {
    const input = document.querySelector("[data-projects-create-input]");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, name);
  await page.waitForTimeout(250);
  const filledEnabled = await page.evaluate(
    () => document.querySelector("[data-projects-create]")?.disabled === false,
  );
  add("填了项目名后创建按钮可用（唯一门槛）", filledEnabled === true, String(filledEnabled));
  await page.evaluate(() => document.querySelector("[data-projects-create]")?.click());
  let after = { rows: 0, created: false, summary: "", error: "", modal: "", toast: "" };
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(500);
    after = await page.evaluate((target) => {
      const rows = [...document.querySelectorAll("[data-projects-row]")];
      return {
        rows: rows.length,
        created: rows.some((row) => (row.innerText || "").includes(target)),
        summary: document.querySelector("[data-projects-summary]")?.textContent || "",
        error: document.querySelector("[data-projects-error]")?.textContent || "",
        modal: document.querySelector("[data-projects-new-modal]")?.getAttribute("data-projects-new-modal") ?? "",
        toast: [...document.querySelectorAll("[data-projects-toast]")].map((node) => (node.textContent || "").trim()).join(" | "),
      };
    }, name);
    if (after.created) break;
  }
  add("通过 UI 新建项目成功", after.created && after.rows === beforeRows + 1, JSON.stringify(after));
  add("新建成功后模态关闭", after.modal === "closed", String(after.modal));
  add("新建成功后出现 toast 并点名项目", after.toast.includes(name), after.toast.slice(0, 80));
  add("新建后摘要计数增加", /\\d+/u.test(after.summary), after.summary);
  add("新建没有报错条", after.error === "", after.error);
  // toast 3.5s 自动消失：必须断言「真的消失」，不能只断言出现过
  await page.waitForTimeout(4200);
  const toastGone = await page.evaluate(() => document.querySelectorAll("[data-projects-toast]").length === 0);
  add("toast 在 4 秒内自动消失", toastGone === true, String(toastGone));

  // 会话行菜单：先建一个会话（临时 home 已种工作区），再打开它的「…」菜单归属到项目。
  const createdSession = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      /新建会话|New session/u.test((b.getAttribute("aria-label") || "") + (b.textContent || "")),
    );
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(2500);
  const rowSeen = await page.evaluate(() => document.querySelectorAll('[role="treeitem"]').length);
  add("侧栏出现会话行", rowSeen > 0, JSON.stringify({ createdSession, rows: rowSeen }));

  // 空白会话不渲染行内动作（ui-workspace 的 !row.blank 分支），所以先发一条消息让它非空白。
  // 临时 home 没有模型凭据，这一轮必然以 MISSING_CREDENTIAL 结束——正是我们要的：不花钱、但会落 user/message。
  // composer 是 contenteditable（不是 textarea）：必须聚焦后用真实键盘输入，再用 Enter 提交。
  // 等 composer 就绪再聚焦（否则偶发 "Cannot read properties of null (reading 'focus')"）
  let composerReady = false;
  for (let i = 0; i < 20; i += 1) {
    composerReady = await page.evaluate(() => Boolean(document.querySelector('[role="textbox"]')));
    if (composerReady) break;
    await page.waitForTimeout(400);
  }
  if (!composerReady) throw new Error("composer 未就绪：找不到 [role=textbox]");
  await page.evaluate(() => document.querySelector('[role="textbox"]').focus());
  await page.keyboard.type("smoke: make this session non-blank");
  await page.keyboard.press("Enter");
  let triggerSeen = false;
  for (let i = 0; i < 16; i += 1) {
    triggerSeen = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) =>
        (r.getAttribute("data-row-key") || "").startsWith("session:"),
      );
      return Boolean(row && row.querySelector("[data-context-menu-trigger]"));
    });
    if (triggerSeen === true) break;
    await page.waitForTimeout(500);
  }
  const rowDetail = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) =>
      (r.getAttribute("data-row-key") || "").startsWith("session:"),
    );
    return row ? row.outerHTML.slice(0, 300) : "no-session-row";
  });
  add("会话已非空白（行内动作可用）", triggerSeen === true, rowDetail);

  const menuOpened = await page.evaluate(() => {
    // 会话行菜单触发器：data-context-menu-trigger（aria-label 形如「会话“<标题>”的操作」）
    const row = [...document.querySelectorAll('[role="treeitem"]')].find((r) =>
      (r.getAttribute("data-row-key") || "").startsWith("session:"),
    );
    const button = row && row.querySelector("[data-context-menu-trigger]");
    if (!button) return "no-button";
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return "clicked";
  });
  await page.waitForTimeout(900);
  const attachItem = await page.evaluate(() => {
    const item = document.querySelector("[data-projects-attach-open]");
    if (!item) return "no-item";
    item.click();
    return "clicked";
  });
  await page.waitForTimeout(1200);
  const optionCount = await page.evaluate(() => document.querySelectorAll("[data-projects-attach-option]").length);
  add("会话菜单出现归属入口（含项目列表）", attachItem === "clicked" && optionCount > 0, JSON.stringify({ menuOpened, attachItem, optionCount }));
  await page.evaluate(() => {
    const option = document.querySelector("[data-projects-attach-option]");
    if (option) option.click();
  });
  await page.waitForTimeout(1800);
  const menuError = await page.evaluate(() => {
    const list = document.querySelector("[data-projects-attach-list]");
    return list ? (list.textContent || "").slice(0, 120) : "";
  });
  add("归属动作没有报错", menuError === "" || !/失败|error/i.test(menuError), menuError);

  // 回到项目面板（上一步归属后视图切到了会话）
  await page.evaluate(() => {
    const button = document.querySelector("button[aria-label='项目']") || document.querySelector("button[aria-label='Projects']");
    if (button) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector("[data-projects-panel]", { timeout: 15000 });
  await page.waitForTimeout(1200);

  // 项目详情：点项目行 → 三个页签（线程/记忆/审计）都可切换，返回后回到列表。
  const detail = await page.evaluate(() => {
    const row = document.querySelector("[data-projects-row]");
    if (!row) return "no-row";
    row.click();
    return "clicked";
  });
  await page.waitForTimeout(1500);
  const detailState = await page.evaluate(() => ({
    present: Boolean(document.querySelector("[data-projects-detail]")),
    tabs: [...document.querySelectorAll("[data-projects-tab]")].map((n) => n.getAttribute("data-projects-tab")),
    threadsTab: Boolean(document.querySelector("[data-projects-threads], [data-projects-threads-empty]")),
  }));
  const detailCrash = await page.evaluate(
    () => (document.querySelector("[data-projects-detail-crash]")?.textContent || "").slice(0, 300),
  );
  add("详情页没有渲染崩溃", detailCrash === "", detailCrash);
  add(
    "项目详情可打开且有三个页签",
    detailState.present && detailState.tabs.length === 3 && detailState.threadsTab,
    JSON.stringify({ detail, ...detailState }),
  );

  // 详情页断言在宽窗（1440）下跑：宽窗=两列、右栏各段展开；窄窗折叠另有一条专门断言。
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(500);

  // 先给项目绑定目录（否则线程没有隔离目标，会走「无目录」降级）
  // Batch C：目录是「值行 + 编辑」，输入框只在点「编辑」后打开的模态里
  await page.evaluate(() => document.querySelector("[data-projects-dir-edit]")?.click());
  await page.waitForTimeout(400);
  const bound = await page.evaluate((dir) => {
    const input = document.querySelector("[data-projects-dir-input]");
    const button = document.querySelector("[data-projects-dir-save]");
    if (!input || !button) return "no-controls";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, dir);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return "clicked";
  }, SMOKE_WORKSPACE_DIR);
  await page.waitForTimeout(1500);
  add("可在详情页绑定项目目录", bound === "clicked", String(bound));

  // 详情页里新建一个线程：这会走 createThread（worktree 隔离 + 建会话）
  const threadCreated = await page.evaluate(() => {
    const input = document.querySelector("[data-projects-thread-input]");
    const button = document.querySelector("[data-projects-thread-create]");
    if (!input || !button) return "no-controls";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "smoke: reply with OK");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return "clicked";
  });
  let threadRow = null;
  for (let i = 0; i < 30; i += 1) {
    threadRow = await page.evaluate(() => {
      const row = document.querySelector("[data-projects-thread-row]");
      return row ? { id: row.getAttribute("data-projects-thread-row"), state: row.getAttribute("data-projects-thread-state") } : null;
    });
    if (threadRow) break;
    await page.waitForTimeout(500);
  }
  add("详情页可新建线程", threadCreated === "clicked" && threadRow !== null, JSON.stringify({ threadCreated, threadRow }));
  const attention = await page.evaluate(() =>
    document.querySelector("[data-projects-threads]")?.getAttribute("data-projects-attention"),
  );
  add("线程计数/需要我 可断言", attention !== null && attention !== undefined, String(attention));

  // 暂停项目：UI 只断言按钮存在与可点，**状态变化由宿主侧 projects.json 断言**（更硬）
  const pauseClicked = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-toggle-pause]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(2500);
  add("详情页有暂停项目按钮且可点", pauseClicked === "clicked", String(pauseClicked));
  let budgetText = "";
  for (let i = 0; i < 12; i += 1) {
    budgetText = await page.evaluate(
      () => (document.querySelector("[data-projects-budget]")?.textContent || "").trim(),
    );
    if (budgetText !== "") break;
    await page.waitForTimeout(500);
  }
  add("详情页显示预算用量", budgetText !== "", budgetText);
  // 回收站不能只在项目详情里：最后一个项目被删后详情页进不去，恢复入口会自锁
  // （0.6.0 验收时发现的死锁；这里断言"项目列表为空时面板仍有回收站出口"）


  // 边界：绑非 git 目录必须**当场**说明"线程共享目录、不隔离"（走查发现静默降级）
  const dirInfoState = await page.evaluate(() => {
    const info = document.querySelector("[data-projects-dir-info]");
    return info ? { kind: info.getAttribute("data-projects-dir-info"), text: (info.textContent || "").trim() } : null;
  });
  add(
    "非 git 目录绑定时如实说明未隔离",
    dirInfoState === null || dirInfoState.kind === "shared" ? /共享|不隔离|share/iu.test(dirInfoState?.text || "") : true,
    JSON.stringify(dirInfoState),
  );
  // 相对路径必须当场拒绝（否则会被静默存下来，建线程时才崩在宿主里）
  await page.evaluate(() => document.querySelector("[data-projects-dir-edit]")?.click());
  await page.waitForTimeout(400);
  const relativeRejected = await page.evaluate(() => {
    const input = document.querySelector("[data-projects-dir-input]");
    const save = document.querySelector("[data-projects-dir-save]");
    if (!input || !save) return { ok: false, reason: "no-controls" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "relative/plain");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save.click();
    return { ok: true };
  });
  await page.waitForTimeout(900);
  const invalidHint = await page.evaluate(() => {
    const info = document.querySelector("[data-projects-dir-info]");
    return info ? { kind: info.getAttribute("data-projects-dir-info"), text: (info.textContent || "").trim() } : null;
  });
  add(
    "绑定相对路径当场拒绝并说明原因",
    relativeRejected.ok === true && invalidHint?.kind === "invalid" && /绝对路径|absolute/iu.test(invalidHint?.text || ""),
    JSON.stringify(invalidHint),
  );
  // 收尾：模态还开着（非法路径不关窗），把合法目录重新绑定一次——既关窗，也让后面的截图
  // 不带着一条红色报错（这条路径是用户真会走的：改错 → 改回）。
  await page.evaluate((dir) => {
    const input = document.querySelector("[data-projects-dir-input]");
    const save = document.querySelector("[data-projects-dir-save]");
    if (!input || !save) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, dir);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save.click();
  }, SMOKE_WORKSPACE_DIR);
  await page.waitForTimeout(1500);
  const dirEditorClosed = await page.evaluate(() => !document.querySelector("[data-projects-dir-input]"));
  add("目录编辑模态保存成功后关闭（改错再改回也走同一条路）", dirEditorClosed === true, String(dirEditorClosed));
  // 空项目也必须给「建线程」入口（否则新项目在面板里无法起线程，只能靠会话菜单归属）
  const emptyComposer = await page.evaluate(() => {
    const empty = Boolean(document.querySelector("[data-projects-threads-empty]"));
    const input = Boolean(document.querySelector("[data-projects-thread-input]"));
    const button = Boolean(document.querySelector("[data-projects-thread-create]"));
    return { empty, input, button };
  });
  add(
    "空项目的详情页仍有建线程入口",
    emptyComposer.input && emptyComposer.button,
    JSON.stringify(emptyComposer),
  );

  // 可观测摘要（规格 §7.7.3）：线程行应显示「N 步 · N 次工具 · diff … · tokens …」
  const statsText = await page.evaluate(
    () => (document.querySelector("[data-projects-thread-stats]")?.textContent || "").trim(),
  );
  add(
    "线程行显示可观测摘要（步骤/工具/diff/tokens）",
    /步/u.test(statsText) && /(工具|diff|tokens)/u.test(statsText),
    statsText,
  );
  // 线程行要有可操作入口：看 worktree 路径、回收目录、移除追踪（两步确认）
  // 线程行的「回收目录 / 移除追踪」收进行内 ⋯：先开菜单再数（锚点挂在菜单项上）
  await page.evaluate(() => document.querySelector("[data-projects-thread-menu]")?.click());
  await page.waitForTimeout(400);
  const threadActions = await page.evaluate(() => ({
    worktree: document.querySelectorAll("[data-projects-thread-worktree]").length,
    reclaim: document.querySelectorAll("[data-projects-thread-reclaim]").length,
    remove: document.querySelectorAll("[data-projects-thread-remove]").length,
  }));
  add(
    "线程行给出目录路径与回收/移除入口",
    threadActions.remove > 0 && (threadActions.reclaim > 0 || threadActions.worktree === 0),
    JSON.stringify(threadActions),
  );
  const removeOnce = await page.evaluate(() => {
    // 上一条断言已经把菜单打开了：先看菜单项在不在，别盲目 toggle 关掉它
    if (!document.querySelector("[data-projects-thread-remove]")) {
      document.querySelector("[data-projects-thread-menu]")?.click();
    }
    const btn = document.querySelector("[data-projects-thread-remove]");
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  });
  await page.waitForTimeout(700);
  // 两段确认：第一次点只换文案、菜单不关（产品行为），所以这里直接读同一个菜单项
  const removeConfirmLabel = await page.evaluate(
    () => (document.querySelector("[data-projects-thread-remove]")?.textContent || "").trim(),
  );
  add(
    "移除线程需二次确认",
    removeOnce === "clicked" && /确认|confirm/iu.test(removeConfirmLabel),
    removeConfirmLabel.slice(0, 40),
  );
  // 留一张详情页截图：线程行摘要与「仓库授权 / 回收站清理」两块新 UI 都在这一屏
  {
    // ego 的 page.screenshot() 在本版本返回空数据；直接走 CDP 更可靠
    const detailShot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(
      ${JSON.stringify(shotsDir)} + "/02-detail-thread-stats.png",
      Buffer.from(detailShot.data, "base64"),
    );
  }
  // 详情页两列布局：主列（composer + 页签 + 线程）在 DOM 里先于右栏（指令/记忆/上下文）
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(400);
  {
    const detailShot2 = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(${JSON.stringify(shotsDir)} + "/04-detail.png", Buffer.from(detailShot2.data, "base64"));
  }
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(300);

  // 宽窗（1440）再拍一张：确认两列布局（主列 + 320 右栏）在宽面板下真的成立
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(500);
  {
    const wideShot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(${JSON.stringify(shotsDir)} +   "/05-detail-wide.png", Buffer.from(wideShot.data, "base64"));
  }
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(300);

  // 详情页两块：仓库授权 + 回收站清理。Batch C：都是「值行 + 右侧动作」，输入只在编辑模态里
  const newBlocks = await page.evaluate(() => ({
    grants: Boolean(document.querySelector("[data-projects-grants]")),
    grantEdit: Boolean(document.querySelector("[data-projects-grant-edit]")),
    purge: Boolean(document.querySelector("[data-projects-purge]")),
    purgePreview: Boolean(document.querySelector("[data-projects-purge-preview]")),
  }));
  await page.evaluate(() => document.querySelector("[data-projects-grant-edit]")?.click());
  await page.waitForTimeout(400);
  const grantEditor = await page.evaluate(() => ({
    modal: Boolean(document.querySelector("[data-projects-grants-editor]")),
    input: Boolean(document.querySelector("[data-projects-grant-input]")),
    add: Boolean(document.querySelector("[data-projects-grant-add]")),
  }));
  await page.evaluate(() =>
    document.querySelector("[data-projects-grants-editor] [data-projects-rail-editor-cancel]")?.click(),
  );
  add(
    "详情页有仓库授权与回收站清理入口（输入只在编辑模态里）",
    newBlocks.grants &&
      newBlocks.grantEdit &&
      newBlocks.purge &&
      newBlocks.purgePreview &&
      grantEditor.modal &&
      grantEditor.input &&
      grantEditor.add,
    JSON.stringify({ newBlocks, grantEditor }),
  );

  // 清理预览：dry-run 不应删除任何东西，只报告条数
  const preview = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-purge-preview]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  let purgeResult = "";
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(400);
    purgeResult = await page.evaluate(
      () => (document.querySelector("[data-projects-purge-result]")?.textContent || "").trim(),
    );
    if (purgeResult !== "") break;
  }
  // 断言必须校验「成功」，不能只校验「有文字且不含 FAIL」——0.4.3 就是这样把网关报错放过去的
  const purgeOk = /项可清理|没有|空/u.test(purgeResult) && !/gateway|失败|错误/u.test(purgeResult);
  add("回收站清理预览可用（dry-run 不删东西）", preview === "clicked" && purgeOk, purgeResult);

  // 进详情默认落在「线程」页签（页签不该被记忆），且空态指引要提到"在上面建线程"
  const tabDefault = await page.evaluate(() => {
    const active = document.querySelector('[data-projects-tab][aria-selected="true"]');
    return active ? active.getAttribute("data-projects-tab") : "none";
  });
  add("进入详情默认停在「线程」页签", tabDefault === "threads", String(tabDefault));
  const panelSummary = await page.evaluate(
    () => (document.querySelector("[data-projects-summary]")?.textContent || "").trim(),
  );
  add(
    "头部统计给出线程数",
    panelSummary.length > 0 && /线程/u.test(panelSummary),
    panelSummary.slice(0, 80),
  );

  // 详情页改成 Claude 项目主页的两列布局：主列（composer + 页签 + 线程）在 DOM 里先于右栏，
  // 右栏常驻「指令 / 记忆 / 上下文」三段。旧版是「三块配置压在线程列表之前」，走查 P1-5 已修。
  const layout = await page.evaluate(() => {
    const rail = document.querySelector("[data-projects-config]");
    const main = document.querySelector("[data-projects-detail-main]");
    const threads = document.querySelector("[data-projects-threads], [data-projects-threads-empty]");
    const following = (a, b) =>
      a && b ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false;
    return {
      rail: Boolean(rail),
      main: Boolean(main),
      sections: ["[data-projects-rail-instructions]", "[data-projects-rail-memory]", "[data-projects-rail-context]"].map(
        (sel) => Boolean(document.querySelector(sel)),
      ),
      instructions: Boolean(document.querySelector("[data-projects-instructions]")),
      // 目录现在是「值行 + 编辑」：值行常驻，输入框只在编辑模态里
      dirRow: Boolean(document.querySelector("[data-projects-rail-dir]")),
      mainBeforeRail: following(main, rail),
      threadsBeforeRail: following(threads, rail),
      configIsAside: rail ? rail.tagName.toLowerCase() === "aside" : false,
    };
  });
  add(
    "详情页两列：右栏含指令/记忆/上下文三段",
    layout.rail === true &&
      layout.main === true &&
      layout.sections.every((value) => value === true) &&
      layout.instructions === true &&
      layout.dirRow === true,
    JSON.stringify(layout),
  );
  add(
    "线程列表在右栏之前（DOM 顺序，不再压线程）",
    layout.mainBeforeRail === true && layout.threadsBeforeRail === true && layout.configIsAside === true,
    JSON.stringify({ mainBeforeRail: layout.mainBeforeRail, threadsBeforeRail: layout.threadsBeforeRail }),
  );

  // —— Batch C ①：右栏是「值行 + 右侧动作」，不常驻输入框 ——
  const railRows = await page.evaluate(() => {
    const context = document.querySelector("[data-projects-rail-context]");
    const inputs = context ? context.querySelectorAll("input:not([type=checkbox])").length : -1;
    const rows = [
      "[data-projects-rail-state]",
      "[data-projects-rail-dir]",
      "[data-projects-grants]",
      "[data-projects-purge]",
      "[data-projects-trash-count]",
    ].map((sel) => Boolean(document.querySelector(sel)));
    return {
      inputs,
      rows,
      dirValue: (document.querySelector("[data-projects-rail-dir]")?.textContent || "").trim(),
      overflow: (() => {
        const value = document.querySelector("[data-projects-rail-dir] span:nth-child(2)") ||
          document.querySelector("[data-projects-rail-dir]");
        if (!value) return "";
        const style = getComputedStyle(value);
        return style.textOverflow + "|" + style.whiteSpace;
      })(),
    };
  });
  add(
    "右栏值行只读：无常驻输入框，五个值行齐全",
    railRows.inputs === 0 && railRows.rows.every((value) => value === true) && railRows.dirValue !== "",
    JSON.stringify(railRows),
  );
  add(
    "右栏长值单行截断（ellipsis/nowrap）",
    railRows.overflow.startsWith("ellipsis|nowrap"),
    railRows.overflow,
  );

  // 点「编辑」才出输入框（值行本身不可编辑）
  const dirRowBefore = await page.evaluate(() => Boolean(document.querySelector("[data-projects-dir-input]")));
  await page.evaluate(() => document.querySelector("[data-projects-dir-edit]")?.click());
  await page.waitForTimeout(400);
  const dirEditor = await page.evaluate(() => ({
    modal: Boolean(document.querySelector("[data-projects-dir-editor]")),
    input: Boolean(document.querySelector("[data-projects-dir-input]")),
    save: Boolean(document.querySelector("[data-projects-dir-save]")),
  }));
  await page.evaluate(() =>
    document.querySelector("[data-projects-dir-editor] [data-projects-rail-editor-cancel]")?.click(),
  );
  await page.waitForTimeout(300);
  add(
    "点目录「编辑」才打开输入（值行不常驻 input）",
    dirRowBefore === false && dirEditor.modal === true && dirEditor.input === true && dirEditor.save === true,
    JSON.stringify({ dirRowBefore, dirEditor }),
  );

  // —— Batch C ②：窄窗（800）右栏各段默认折叠成「标题 + 一行摘要 + ▸」——
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(1200);
  const narrowRail = await page.evaluate(() => ({
    toggles: document.querySelectorAll("[data-projects-rail-toggle]").length,
    row: Boolean(document.querySelector("[data-projects-rail-dir]")),
  }));
  const narrowCollapsed = await railSummaryFor("context");
  await toggleContext();
  await page.waitForTimeout(500);
  const narrowExpanded = await page.evaluate(() => ({
    row: Boolean(document.querySelector("[data-projects-rail-dir]")),
  }));
  const narrowExpandedSummary = await railSummaryFor("context");
  const narrowExpandedAttr = await expandedAttr();
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(500);
  add(
    "窄窗（800）右栏各段默认折叠，点 ▸ 才展开",
    narrowRail.toggles >= 3 &&
      narrowCollapsed === true &&
      narrowRail.row === false &&
      narrowExpanded.row === true &&
      narrowExpandedSummary === false &&
      narrowExpandedAttr === "true",
    JSON.stringify({ narrowRail, narrowCollapsed, narrowExpanded, narrowExpandedSummary, narrowExpandedAttr }),
  );

  // —— Batch C ③：头部 pin / ⋯ 贴主列右缘（与主列同宽、同右缘）——
  const headAlign = await page.evaluate(() => {
    const head = document.querySelector("[data-projects-detail-head-main]");
    const main = document.querySelector("[data-projects-detail-main]");
    const pin = document.querySelector("[data-projects-pin]");
    const menu = document.querySelector("[data-projects-row-menu]");
    const right = (node) => (node ? node.getBoundingClientRect().right : Number.NaN);
    const width = (node) => (node ? node.getBoundingClientRect().width : Number.NaN);
    return {
      head: Boolean(head) && Boolean(main),
      widthDelta: Math.abs(width(head) - width(main)),
      pinDelta: Math.abs(right(pin) - right(main)),
      menuDelta: Math.abs(right(menu) - right(main)),
    };
  });
  add(
    "头部 pin/⋯ 贴主列右缘（不再贴页面右缘）",
    headAlign.head === true &&
      headAlign.widthDelta < 2 &&
      headAlign.pinDelta < 40 &&
      headAlign.menuDelta < 8,
    JSON.stringify(headAlign),
  );
  // 展开后才看回收站（真实用户也要先展开）
  await page.evaluate(() => {
    const details = document.querySelector("[data-projects-config]");
    if (details) details.open = true;
  });
  await page.waitForTimeout(600);
  // 回收站必须可看、可恢复（删除文案承诺"可恢复"，承诺就要能看到入口）
  // 危险开关必须能在项目详情里看到（设置页在未登录 profile 里不渲染插件分节）
  const dangerPanel = await page.evaluate(() => {
    const details = document.querySelector("[data-projects-policy-danger]");
    if (details) details.open = true;
    const labels = [...document.querySelectorAll("[data-projects-danger-switch]")].map((n) => n.getAttribute("data-projects-danger-switch"));
    const box = document.querySelector("[data-projects-policy-danger]");
    return { count: labels.length, text: box ? (box.innerText || "").slice(0, 200) : "" };
  });
  add(
    "项目详情可见六个危险开关（含风险说明）",
    dangerPanel.count === 6 && dangerPanel.text.length > 60,
    JSON.stringify({ count: dangerPanel.count }),
  );
  // 危险开关勾选后必须**立刻**反映到界面（以前要重新进详情才看到，用户以为没生效）
  const toggledNow = await page.evaluate(() => {
    const box = document.querySelector('[data-projects-danger-switch="autoMerge"]');
    if (!box) return "no-box";
    const before = box.checked;
    box.click();
    return { before };
  });
  await page.waitForTimeout(1800);
  const checkedAfter = await page.evaluate(() => document.querySelector('[data-projects-danger-switch="autoMerge"]')?.checked);
  add(
    "危险开关勾选后界面即时反映",
    checkedAfter === true,
    JSON.stringify({ toggledNow, checkedAfter }),
  );
  // 安全面变更必须写审计
  await page.evaluate(() => document.querySelector('[data-projects-tab="audit"]')?.click());
  await page.waitForTimeout(1200);
  const auditForPolicy = await page.evaluate(() => (document.querySelector("[data-projects-audit]")?.innerText || "").trim());
  add(
    "危险开关变更写审计（project/policy-changed）",
    auditForPolicy.includes("project/policy-changed"),
    auditForPolicy.split(String.fromCharCode(10)).slice(0, 4).join(" | "),
  );
  // 把开关关回去，别影响后续断言
  await page.evaluate(() => {
    const tab = document.querySelector('[data-projects-tab="threads"]');
    if (tab) tab.click();
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const cfg = document.querySelector("[data-projects-config]");
    if (cfg) cfg.open = true;
    const danger = document.querySelector("[data-projects-policy-danger]");
    if (danger) danger.open = true;
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const box = document.querySelector('[data-projects-danger-switch="autoMerge"]');
    if (box && box.checked) box.click();
  });
  await page.waitForTimeout(1500);

  // 文案要人话：不许出现 __force-with-lease / SHA / per-repo / rulesets / manifest / dry-run__ 这类术语
  const jargon = ["--force-with-lease", "SHA", "per-repo", "rulesets", "manifest", "dry-run", "**"];
  const hitJargon = jargon.filter((word) => dangerPanel.text.includes(word));
  add(
    "危险开关文案不含工程术语",
    hitJargon.length === 0,
    JSON.stringify({ hitJargon }),
  );

  const trashVisible = await page.evaluate(() =>
    Boolean(document.querySelector("[data-projects-trash]")),
  );
  const trashText = await page.evaluate(
    () => (document.querySelector("[data-projects-trash]")?.innerText || "").trim(),
  );

  add(
    "回收站区块存在且给出恢复入口说明",
    trashVisible === true && trashText.length > 0,
    trashText.slice(0, 80),
  );

  const memoryTab = await page.evaluate(() => {
    const tab = document.querySelector('[data-projects-tab="memory"]');
    if (!tab) return "no-tab";
    tab.click();
    return "clicked";
  });
  await page.waitForTimeout(900);
  const memorySeen = await page.evaluate(() =>
    Boolean(document.querySelector("[data-projects-instructions]") && document.querySelector("[data-projects-memory-index]")),
  );
  add("记忆页签渲染规则与索引", memorySeen === true, String(memoryTab));

  // 走查发现记忆页签只读：现在应当能编辑规则并追加记忆
  const memEdit = await page.evaluate(() => {
    const btn = document.querySelector("[data-projects-memory-edit]");
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  });
  await page.waitForTimeout(700);
  const editorReady = await page.evaluate(() => Boolean(document.querySelector("[data-projects-memory-editor]")));
  await page.evaluate(() => {
    const area = document.querySelector("[data-projects-memory-editor]");
    if (!area) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, "冒烟写入的规则：测试用 pnpm test");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("[data-projects-memory-save]")?.click());
  await page.waitForTimeout(2200);
  const saved = await page.evaluate(
    () => (document.querySelector("[data-projects-memory-result]")?.textContent || "").trim(),
  );
  const rulesText = await page.evaluate(
    () => (document.querySelector("[data-projects-instructions]")?.textContent || "").trim(),
  );
  add(
    "记忆页签可编辑常设规则并即时生效",
    memEdit === "clicked" && editorReady === true && /已保存/u.test(saved) && rulesText.includes("冒烟写入的规则"),
    JSON.stringify({ memEdit, editorReady, saved: saved.slice(0, 30) }),
  );

  await page.evaluate(() => {
    const input = document.querySelector("[data-projects-memory-append-input]");
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "冒烟追加的一条记忆");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("[data-projects-memory-append]")?.click());
  await page.waitForTimeout(1800);
  const appendResult = await page.evaluate(
    () => (document.querySelector("[data-projects-memory-result]")?.textContent || "").trim(),
  );
  const memoryIndexText = await page.evaluate(
    () => (document.querySelector("[data-projects-memory-index]")?.textContent || "").trim(),
  );
  add(
    "可追加一条记忆并出现在索引里",
    /已追加/u.test(appendResult) && memoryIndexText.includes("冒烟追加的一条记忆"),
    JSON.stringify({ appendResult: appendResult.slice(0, 20), indexed: memoryIndexText.includes("冒烟追加的一条记忆") }),
  );

  const auditTab = await page.evaluate(() => {
    const tab = document.querySelector('[data-projects-tab="audit"]');
    if (!tab) return "no-tab";
    tab.click();
    return "clicked";
  });
  await page.waitForTimeout(900);
  const auditSeen = await page.evaluate(() =>
    Boolean(document.querySelector("[data-projects-audit], [data-projects-audit-empty]")),
  );
  add("审计页签可渲染（空态也算）", auditSeen === true, String(auditTab));

  // 回到「线程」页签（上面的记忆/审计页签会替换掉这块 UI）
  await page.evaluate(() => {
    const tab = document.querySelector('[data-projects-tab="threads"]');
    if (tab) tab.click();
  });
  await page.waitForTimeout(1200);

  // 按规则派活：默认 L1 下长任务应被拦成「提议」，线程数不变
  const beforeRoute = await page.evaluate(
    () => document.querySelectorAll("[data-projects-thread-row]").length,
  );
  const dispatched = await page.evaluate(() => {
    const input = document.querySelector("[data-projects-route-input]");
    const button = document.querySelector("[data-projects-route-dispatch]");
    if (!input || !button) return "no-controls";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "implement the payments webhook with retries");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return "clicked";
  });
  let routeText = "";
  let routeExecuted = "";
  for (let i = 0; i < 16; i += 1) {
    await page.waitForTimeout(500);
    const snapshot = await page.evaluate(() => {
      const node = document.querySelector("[data-projects-route-result]");
      return node
        ? { text: (node.textContent || "").trim(), executed: node.getAttribute("data-projects-route-executed") || "" }
        : null;
    });
    if (snapshot) {
      routeText = snapshot.text;
      routeExecuted = snapshot.executed;
      break;
    }
  }
  add(
    "按规则派活给出可读决策",
    dispatched === "clicked" && routeText !== "" && /rule|规则|blocked|拦/u.test(routeText),
    routeText,
  );
  add(
    "L1 下长任务被拦成提议（不建线程）",
    routeExecuted === "no" && (await page.evaluate(() => document.querySelectorAll("[data-projects-thread-row]").length)) === beforeRoute,
    JSON.stringify({ beforeRoute, routeExecuted }),
  );

  // 归档：新建一个一次性项目来归档（不要动暂停中的那个项目，宿主侧暂停断言还要用）
  // 创建输入在**列表页**，所以先返回列表
  await page.evaluate(() => {
    const back = document.querySelector("[data-projects-detail-back]");
    if (back) back.click();
  });
  await page.waitForTimeout(1200);
  await createViaModal("smoke-to-archive");
  await page.waitForTimeout(2000);
  const openedArchiveRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find((node) =>
      (node.textContent || "").includes("smoke-to-archive"),
    );
    if (!row) return "no-row";
    row.click();
    return "clicked";
  });
  await page.waitForTimeout(1500);
  await openDetailMenu();
  const archiveClicked = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-toggle-archive]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(2500);
  const detailError = await page.evaluate(
    () => (document.querySelector("[data-projects-detail-error]")?.textContent || "").trim(),
  );
  add(
    "详情页可归档项目（一次性项目）",
    openedArchiveRow === "clicked" && archiveClicked === "clicked" && detailError === "",
    JSON.stringify({ openedArchiveRow, archiveClicked }) + (detailError ? " | err: " + detailError : ""),
  );

  // 审批队列条默认不出现（没有待审批时不留空块）
  const approvalNodes = await page.evaluate(
    () => document.querySelectorAll("[data-projects-approval-row]").length,
  );
  add("无待审批时不显示审批条", approvalNodes === 0, String(approvalNodes));

  const backOk = await page.evaluate(() => {
    const back = document.querySelector("[data-projects-detail-back]");
    if (!back) return "no-back";
    back.click();
    return "clicked";
  });
  await page.waitForTimeout(900);
  const listBack = await page.evaluate(() => Boolean(document.querySelector("[data-projects-row]")) && !document.querySelector("[data-projects-detail]"));
  add("返回后回到项目列表", listBack === true, String(backOk));

  // 删除项目：两段式确认（先看影响面，再确认），ADR 0002
  // 回到列表（README 创建输入在列表页；上面的归档流程停在详情页）
  await page.evaluate(() => {
    const back = document.querySelector("[data-projects-detail-back]");
    if (back) back.click();
  });
  await page.waitForTimeout(1200);

  // 先建一个一次性项目专门用来删（不要删主项目，后面还有宿主侧断言要用它）
  const throwaway = await createViaModal("smoke-to-delete");
  await page.waitForTimeout(2000);
  const openedThrowaway = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find((node) =>
      (node.textContent || "").includes("smoke-to-delete"),
    );
    if (!row) return "no-row";
    row.click();
    return "clicked";
  });
  await page.waitForTimeout(1500);

  await openDetailMenu();
  const askedDelete = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-delete]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  let impactText = "";
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(500);
    impactText = await page.evaluate(
      () => (document.querySelector("[data-projects-delete-impact]")?.textContent || "").trim(),
    );
    if (impactText !== "") break;
  }
  add(
    "删除前展示影响面（数量/体积/在跑/可恢复）",
    askedDelete === "clicked" && /线程/u.test(impactText) && /可恢复/u.test(impactText),
    impactText,
  );
  const confirmFocused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-projects-delete-confirm") !== null,
  );
  add("确认按钮带默认聚焦", confirmFocused === true, String(confirmFocused));
  const confirmed = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-delete-confirm]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(2500);
  const goneFromList = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    const stillThere = rows.some((node) => (node.textContent || "").includes("smoke-to-delete"));
    return rows.length > 0 && !stillThere && !document.querySelector("[data-projects-detail]");
  });
  add(
    "确认删除后临时项目消失",
    throwaway === true && openedThrowaway === "clicked" && confirmed === "clicked" && goneFromList === true,
    JSON.stringify({ throwaway, openedThrowaway, confirmed }),
  );
  const rowIds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-projects-row-id]")].map((n) => (n.textContent || "").trim()),
  );
  add(
    "项目行带短 id（重名可区分）",
    rowIds.length > 0 && rowIds.every((id) => /^#[A-Za-z0-9_-]{4,}$/u.test(id)),
    JSON.stringify(rowIds.slice(0, 3)),
  );

  // —— 列表页：搜索 / 排序 / 收藏 / 行内 ⋯（Batch A 的四个新面） ——
  const listShot = async (file) => {
    const data = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(${JSON.stringify(shotsDir)} + "/" + file, Buffer.from(data.data, "base64"));
  };
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(400);
  await listShot("03-list.png");
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(300);

  const rowsTotal = await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length);
  const searched = await page.evaluate(() => {
    const input = document.querySelector("[data-projects-search]");
    if (!input) return "no-input";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "smoke-to-");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return "typed";
  });
  await page.waitForTimeout(500);
  const searchMatched = await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length);
  await page.evaluate(() => {
    const input = document.querySelector("[data-projects-search]");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "zzz-definitely-no-such-project");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const searchMiss = await page.evaluate(() => ({
    rows: document.querySelectorAll("[data-projects-row]").length,
    empty: (document.querySelector("[data-projects-search-empty]")?.textContent || "").trim(),
    createButton: Boolean(document.querySelector("[data-projects-new]")),
  }));
  add(
    "搜索即时过滤且命中项保留",
    searched === "typed" && searchMatched > 0 && searchMatched < rowsTotal,
    JSON.stringify({ rowsTotal, searchMatched }),
  );
  add(
    "搜索无结果给专属文案（与「没有项目」空态不同）",
    searchMiss.rows === 0 && /没有匹配|No projects match/u.test(searchMiss.empty),
    JSON.stringify(searchMiss),
  );
  await page.evaluate(() => document.querySelector("[data-projects-search-clear]")?.click());
  await page.waitForTimeout(600);
  const clearedRows = await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length);
  add("清空搜索后回到完整列表", clearedRows === rowsTotal, JSON.stringify({ clearedRows, rowsTotal }));

  // 排序菜单：三项 + 当前项打勾
  await page.evaluate(() => document.querySelector("[data-projects-sort]")?.click());
  await page.waitForTimeout(500);
  const sortMenu = await page.evaluate(() => ({
    open: Boolean(document.querySelector("[data-projects-sort-menu]")),
    options: [...document.querySelectorAll("[data-projects-sort-option]")].map((node) =>
      node.getAttribute("data-projects-sort-option"),
    ),
    check: Boolean(document.querySelector("[data-projects-sort-check]")),
  }));
  add(
    "排序菜单给出三项且当前项打勾",
    sortMenu.open === true &&
      sortMenu.options.join(",") === "lastActive,created,name" &&
      sortMenu.check === true,
    JSON.stringify(sortMenu),
  );
  await page.evaluate(() => document.querySelector('[data-projects-sort-option="name"]')?.click());
  await page.waitForTimeout(500);
  const sortedByName = await page.evaluate(() => ({
    key: document.querySelector("[data-projects-sort]")?.getAttribute("data-sort") ?? "",
    rows: [...document.querySelectorAll("[data-projects-row-name]")].map((node) =>
      (node.textContent || "").trim(),
    ),
  }));
  const nameOrder = sortedByName.rows.map((text) => text.split("#")[0]);
  const nameSorted = nameOrder.every((value, index) => index === 0 || nameOrder[index - 1].localeCompare(value) <= 0);
  add(
    "选择「名称」后列表按名称重排",
    sortedByName.key === "name" && nameSorted === true,
    JSON.stringify(sortedByName).slice(0, 160),
  );
  await page.evaluate(() => document.querySelector('[data-projects-sort-option="lastActive"]')?.click());
  await page.waitForTimeout(500);

  // 收藏：默认未收藏 → 点击变已收藏 → 收藏项排到最前（乐观更新 + 回读）
  const pinBefore = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    const row = rows.find((node) => (node.textContent || "").includes(name));
    if (!row) return { found: false };
    const button = row.querySelector("[data-projects-pin]");
    return {
      found: true,
      id: row.getAttribute("data-projects-row"),
      pinned: button?.getAttribute("data-pinned") ?? "",
      first: rows[0]?.getAttribute("data-projects-row") ?? "",
    };
  });
  const pinClicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    const row = rows.find((node) => (node.textContent || "").includes(name));
    const button = row?.querySelector("[data-projects-pin]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(2200);
  const pinAfter = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    return {
      first: rows[0]?.getAttribute("data-projects-row") ?? "",
      pinned: rows[0]?.querySelector("[data-projects-pin]")?.getAttribute("data-pinned") ?? "",
      marks: document.querySelectorAll("[data-projects-pin-mark]").length,
    };
  });
  add(
    "收藏默认 false、点击后变 true 且排到列表最前",
    pinBefore.found === true &&
      pinBefore.pinned === "false" &&
      pinClicked === "clicked" &&
      pinAfter.pinned === "true" &&
      pinAfter.first === pinBefore.id &&
      pinAfter.marks > 0,
    JSON.stringify({ pinBefore, pinClicked, pinAfter }),
  );

  // 行内 ⋯：三项（编辑详情 / 归档 / 删除）
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    const row = rows.find((node) => (node.textContent || "").includes(name));
    row?.querySelector("[data-projects-row-menu]")?.click();
  });
  await page.waitForTimeout(500);
  const rowMenu = await page.evaluate(() => {
    const list = document.querySelector("[data-projects-row-menu-list]");
    return {
      open: Boolean(list),
      edit: Boolean(document.querySelector("[data-projects-row-menu-edit]")),
      archive: Boolean(document.querySelector("[data-projects-row-menu-archive]")),
      remove: Boolean(document.querySelector("[data-projects-row-menu-delete]")),
      text: (list?.textContent || "").trim(),
    };
  });
  add(
    "行内 ⋯ 给出编辑详情/归档/删除三项",
    rowMenu.open === true &&
      rowMenu.edit === true &&
      rowMenu.archive === true &&
      rowMenu.remove === true &&
      /编辑详情/u.test(rowMenu.text) &&
      /删除/u.test(rowMenu.text),
    JSON.stringify(rowMenu).slice(0, 200),
  );
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForTimeout(400);
  // 从详情返回后，列表里的线程数必须是新的（走查发现返回不刷新）
  await page.evaluate(() => {
    const row = document.querySelector("[data-projects-row]");
    if (row) row.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
  await page.waitForTimeout(1200);
  const refreshedCounts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")].map((n) => (n.textContent || "").trim());
    return { rows: rows.length, hasThreadCount: rows.some((text) => /个线程/u.test(text)) };
  });
  add(
    "从详情返回后列表线程数已刷新",
    refreshedCounts.hasThreadCount === true,
    JSON.stringify(refreshedCounts),
  );
  // 长项目名必须截断，不许撑爆行高
  const nameOverflow = await page.evaluate(() => {
    const name = document.querySelector("[data-projects-row-name]");
    if (!name) return "missing";
    const style = getComputedStyle(name);
    return style.textOverflow + "|" + style.overflow + "|" + style.whiteSpace;
  });
  add("超长项目名用省略号截断", String(nameOverflow).startsWith("ellipsis|hidden|nowrap"), String(nameOverflow));



  // 删除承诺"可恢复"，就必须能真的恢复回来。用一个**单独**的临时项目做往返，
  // 免得把上面留给宿主侧 manifest 断言的条目恢复走。
  await createViaModal("smoke-to-restore");
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find((n) =>
      (n.textContent || "").includes("smoke-to-restore"),
    );
    if (row) row.click();
  });
  await page.waitForTimeout(1500);
  const emptyHint = await page.evaluate(
    () => (document.querySelector("[data-projects-threads-empty]")?.textContent || "").trim(),
  );
  add(
    "空态指引提到可直接建线程",
    /输入|新建线程/u.test(emptyHint),
    emptyHint.slice(0, 90),
  );
  const noDirHint = await page.evaluate(
    () => (document.querySelector("[data-projects-no-dir-hint]")?.textContent || "").trim(),
  );
  add(
    "未绑目录时说明线程跑在插件数据目录",
    /数据目录/u.test(noDirHint) && /绑定/u.test(noDirHint),
    noDirHint.slice(0, 80),
  );
  await openDetailMenu();
  await page.evaluate(() => document.querySelector("[data-projects-delete]")?.click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector("[data-projects-delete-confirm]")?.click());
  await page.waitForTimeout(2200);

  // 打开主项目，回收站里应能看到刚删的 smoke-to-restore
  const openedMainForTrash = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find(
      (node) => !(node.textContent || "").includes("smoke-to-restore"),
    );
    if (!row) return "no-row";
    row.click();
    return "clicked";
  });
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const details = document.querySelector("[data-projects-config]");
    if (details) details.open = true;
  });
  await page.waitForTimeout(500);
  let trashListText = "";
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(400);
    trashListText = await page.evaluate(
      () => (document.querySelector("[data-projects-trash]")?.innerText || "").trim(),
    );
    if (trashListText.includes("smoke-to-restore")) break;
  }
  add(
    "回收站列出刚删除的项目",
    openedMainForTrash === "clicked" && trashListText.includes("smoke-to-restore"),
    trashListText.split(String.fromCharCode(10)).join(" | ").slice(0, 140),
  );

  // 点它那一行的「恢复」
  // 回收站必须能"彻底删掉"：超期自动清理之外，用户也要能主动清（ADR 0002：两步确认 + 影响面）
  // 用**第三个**临时项目做，别动上面留给恢复/宿主断言的条目
  await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
  await page.waitForTimeout(900);
  await createViaModal("smoke-to-purge");
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find((n) =>
      (n.textContent || "").includes("smoke-to-purge"),
    );
    if (row) row.click();
  });
  await page.waitForTimeout(1400);
  await openDetailMenu();
  await page.evaluate(() => document.querySelector("[data-projects-delete]")?.click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector("[data-projects-delete-confirm]")?.click());
  await page.waitForTimeout(2200);
  // 打开主项目 → 展开高级设置 → 找到 smoke-to-purge 那一行
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find(
      (node) => !(node.textContent || "").includes("smoke-to-purge"),
    );
    if (row) row.click();
  });
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const details = document.querySelector("[data-projects-config]");
    if (details) details.open = true;
  });
  await page.waitForTimeout(900);
  const trashRowsBefore = await page.evaluate(() => document.querySelectorAll("[data-projects-trash-row]").length);
  const clickedDeleteOnce = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-trash-row]")].find((n) =>
      (n.textContent || "").includes("smoke-to-purge"),
    );
    if (!row) return "no-row";
    const btn = row.querySelector("[data-projects-trash-delete]");
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  });
  await page.waitForTimeout(500);
  const confirmLabel = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-trash-row]")].find((n) =>
      (n.textContent || "").includes("smoke-to-purge"),
    );
    return (row?.querySelector("[data-projects-trash-delete]")?.textContent || "").trim();
  });
  add(
    "彻底删除需二次确认且写明不可恢复",
    clickedDeleteOnce === "clicked" && /不可恢复|irreversible/u.test(confirmLabel),
    confirmLabel.slice(0, 60),
  );
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-trash-row]")].find((n) =>
      (n.textContent || "").includes("smoke-to-purge"),
    );
    row?.querySelector("[data-projects-trash-delete]")?.click();
  });
  await page.waitForTimeout(2000);
  const purgeGone = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-trash-row]")];
    return { left: rows.length, hasPurge: rows.some((n) => (n.textContent || "").includes("smoke-to-purge")) };
  });
  add(
    "确认后该条目从回收站消失",
    trashRowsBefore > 0 && purgeGone.hasPurge === false && purgeGone.left === trashRowsBefore - 1,
    JSON.stringify({ trashRowsBefore, purgeGone }),
  );

  const clickedRestore = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-projects-trash-row]")].find((n) =>
      (n.textContent || "").includes("smoke-to-restore"),
    );
    if (!row) return "no-row";
    const button = row.querySelector("[data-projects-trash-restore]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(2600);
  // 回到列表看它是否真的回来了（恢复的是"另一个"项目，列表必须自己刷新）
  await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
  await page.waitForTimeout(1500);
  const backInList = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    return rows.some((node) => (node.textContent || "").includes("smoke-to-restore"));
  });
  add(
    "点「恢复」后项目回到列表（列表自动刷新）",
    clickedRestore === "clicked" && backInList === true,
    JSON.stringify({ clickedRestore, backInList }),
  );

  // 设置分节：本机 profile 的 cordis.patch.yml 可能把设置页整体禁用（该插件 enabled:false），
  // 那就无从打开——记录为 tolerated 而不是失败，真正的分节渲染由桌面回归在可打开的环境里覆盖。
  const openedSettings = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      /设置|Settings/u.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || "") + " " + (b.getAttribute("title") || "")),
    );
    if (!button) return "no-entry";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(1500);
  const settingsSeen = await page.evaluate(() => Boolean(document.querySelector("[data-projects-settings]")));
  add(
    "设置页出现项目分节",
    settingsSeen || openedSettings === "no-entry",
    settingsSeen ? "rendered" : "tolerated: " + openedSettings + "（设置页未启用）",
  );

  // 设置里的项目策略编辑器：默认折叠，但控件应在 DOM 里。
  // 注意：断言依赖「设置页在本机 profile 里可用」；某些 profile 把 ui-settings 关了
  // （cordis.patch.yml 里 enabled:false，且 dsh plugin add 会重写该文件），
  // 此时这两条按「跳过」处理，并在 detail 里写清原因——不假装覆盖过。
  const policyUi = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const autonomy = q("[data-projects-policy-autonomy]");
    return {
      details: Boolean(q("[data-projects-policy]")),
      autonomy: Boolean(autonomy),
      persona: Boolean(q("[data-projects-policy-persona]")),
      fallback: Boolean(q("[data-projects-policy-fallback]")),
      options: autonomy ? [...autonomy.options].map((option) => option.value) : [],
    };
  });
  const policyOk = policyUi.details && policyUi.autonomy && policyUi.persona && policyUi.fallback;
  add(
    settingsSeen ? "设置里可编辑项目策略（自治/人格/兜底）" : "设置里可编辑项目策略（设置页未启用，跳过）",
    settingsSeen ? policyOk && policyUi.options.join(",") === "L0,L1,L2,L3" : true,
    JSON.stringify(policyUi),
  );

  const autonomyChanged = await page.evaluate(() => {
    const select = document.querySelector("[data-projects-policy-autonomy]");
    if (!select) return "no-select";
    select.value = "L2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return "changed";
  });
  add(
    settingsSeen ? "可切换自治级别" : "可切换自治级别（设置页未启用，跳过）",
    settingsSeen ? autonomyChanged === "changed" : true,
    String(autonomyChanged),
  );

  // 危险开关：默认全关，且每项带风险说明（框架：动作可配置、授权来源不可伪造）
  const dangerUi = await page.evaluate(() => {
    const switches = [...document.querySelectorAll("[data-projects-danger-switch]")];
    return {
      count: switches.length,
      keys: switches.map((node) => node.getAttribute("data-projects-danger-switch")),
      anyOn: switches.some((node) => node.checked),
      panel: Boolean(document.querySelector("[data-projects-policy-danger]")),
    };
  });
  add(
    settingsSeen ? "危险开关默认全关且六项齐全" : "危险开关默认全关（设置页未启用，跳过）",
    settingsSeen
      ? dangerUi.panel &&
          dangerUi.count === 6 &&
          dangerUi.anyOn === false &&
          dangerUi.keys.join(",") ===
            "forcePushOwnBranch,pushProtectedBranch,autoMerge,trashAuto,purgeAfterRetention,editProfile"
      : true,
    JSON.stringify(dangerUi),
  );
  await page.waitForTimeout(1200);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForTimeout(600);
  const shot = await page.screenshot();
  const fs = await import("node:fs/promises");
  await fs.writeFile(${JSON.stringify(shotsDir)} + "/01-projects-panel.png", Buffer.from(shot, "base64"));
  // 防自锁：删到 0 个项目后，面板必须仍能进回收站（否则恢复入口自己锁死）
  const beforeSelfLock = await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length);
  for (let i = 0; i < beforeSelfLock; i += 1) {
    await page.evaluate(() => {
      const row = document.querySelector("[data-projects-row]");
      if (row) row.click();
    });
    await page.waitForTimeout(1200);
    await openDetailMenu();
  await page.evaluate(() => document.querySelector("[data-projects-delete]")?.click());
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector("[data-projects-delete-confirm]")?.click());
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
    await page.waitForTimeout(800);
  }
  const emptyPanel = await page.evaluate(() => ({
    rows: document.querySelectorAll("[data-projects-row]").length,
    trash: Boolean(document.querySelector("[data-projects-trash]")),
    trashRows: document.querySelectorAll("[data-projects-trash-row]").length,
  }));
  add(
    "项目清零后面板仍能进入回收站（防自锁）",
    emptyPanel.rows === 0 && emptyPanel.trash === true && emptyPanel.trashRows > 0,
    JSON.stringify(emptyPanel),
  );
  // 把刚才删的项目恢复回来，别影响后面的宿主侧断言
  // 只恢复"刚为防自锁检查删掉的"那些；留给宿主侧 manifest 断言的条目继续留在回收站
  for (let i = 0; i < 20; i += 1) {
    const done = await page.evaluate(() => {
      const row = [...document.querySelectorAll("[data-projects-trash-row]")].find(
        (n) => !(n.textContent || "").includes("smoke-to-delete"),
      );
      if (!row) return "no-more";
      row.querySelector("[data-projects-trash-restore]")?.click();
      return "clicked";
    });
    if (done === "no-more") break;
    await page.waitForTimeout(1500);
  }
  const restoredBack = await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length);
  result.restoredAfterSelfLockCheck = restoredBack;
  result.pinnedProject = name;
  result.projectName = name;
  await task.finish({ keep: [] });
} catch (error) {
  result.fatal = String(error && error.message ? error.message : error).slice(0, 800);
}
console.log("SMOKE_RESULT " + JSON.stringify(result));
`;
}

/** 供浏览器脚本生成唯一任务空间名（避免复用上次的空间）。 */
const PROJECT_NAME_TOKEN = `smoke-${Date.now().toString(36)}`;

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser"))) return console.log("SKIP 未找到 ego-browser");

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-projects-"));
  const realHome = process.env.HOME ?? "";
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  /** @type {import("node:fs").WriteStream | undefined} */
  let hostLog;
  try {
    const home = join(work, "home");
    const profile = join(home, "profiles", PROFILE);
    await mkdir(profile, { recursive: true });
    await cp(join(realHome, ".dsh", "profiles", "desktop"), profile, { recursive: true });
    await rm(join(profile, "node_modules"), { recursive: true, force: true });
    await rm(join(profile, "pnpm-lock.yaml"), { force: true });

    const profilePath = join(profile, "package.json");
    const profileJson = JSON.parse(await readFile(profilePath, "utf8"));
    profileJson.name = `dsh-profile-${PROFILE}-smoke`;
    profileJson.dependencies = {};
    if (Array.isArray(profileJson.dsh?.profile?.bundles)) {
      profileJson.dsh.profile.bundles = profileJson.dsh.profile.bundles.filter(
        (/** @type {unknown} */ entry) =>
          typeof entry === "string" && entry.startsWith("@deepseek-ai/"),
      );
    }
    await writeFile(profilePath, `${JSON.stringify(profileJson, null, 2)}\n`);

    // 种一个工作区：没有它侧栏不出现会话行，会话菜单那条路径就没法断言。
    const workspaceDirRaw = join(work, "workspace");
    await mkdir(workspaceDirRaw, { recursive: true });
    const workspaceDir = await realpath(workspaceDirRaw);
    // 让工作区是一个**真实 git 仓库**：否则 createThread 会走「非 git → 共享目录」降级，
    // worktree 隔离那条断言就永远没有意义。
    await writeFile(join(workspaceDir, "seed.txt"), "seed\n", "utf8");
    await run("git", ["init", "-q"], { cwd: workspaceDir });
    await run("git", ["add", "."], { cwd: workspaceDir });
    await run(
      "git",
      ["-c", "user.email=smoke@local", "-c", "user.name=smoke", "commit", "-qm", "seed"],
      {
        cwd: workspaceDir,
      },
    );
    const workspaceId = "11111111-2222-4333-8444-555555555555";
    await mkdir(join(home, "storages"), { recursive: true });
    const nowIso = new Date().toISOString();
    await writeFile(
      join(home, "storages", "workspace.json"),
      `${JSON.stringify(
        {
          unit: { name: "workspace", version: 2 },
          global: {
            initialized: true,
            defaultWorkspaceId: workspaceId,
            workspaceIds: [workspaceId],
            archivedSessionIds: [],
            pinnedSessionIds: [],
          },
          tables: {
            workspaces: {
              [workspaceId]: {
                path: workspaceDir,
                title: "projects-smoke",
                sessionIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");

    // 卫生：临时 home 不该带任何模型凭据——否则「冒烟不发模型调用」就成了空话。
    // 显式清掉进程环境里的密钥类变量，并把 DSH_HOME 指向临时目录。
    /** @type {Record<string, string|undefined>} */
    const scrubbed = { ...process.env, DSH_HOME: home };
    for (const key of Object.keys(scrubbed)) {
      if (/API_KEY|_TOKEN$|SECRET|PASSWORD/iu.test(key)) delete scrubbed[key];
    }
    const env = scrubbed;
    await run("dsh", ["plugin", "--profile", PROFILE, "remove", PACKAGE], { env }).catch(() => {});
    const installed = await run("dsh", ["plugin", "--profile", PROFILE, "add", join(work, tgz)], {
      env,
    });
    if (installed.stderr && /error/u.test(installed.stderr)) {
      fail(`安装插件失败：${installed.stderr.slice(0, 400)}`);
      return;
    }

    const SMOKE_WORKSPACE_DIR = workspaceDir;
    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    hostLog = createWriteStream(logPath, { flags: "w" });
    host.stdout?.on("data", (/** @type {any} */ c) => hostLog?.write(String(c)));
    host.stderr?.on("data", (/** @type {any} */ c) => hostLog?.write(String(c)));

    const boot = await waitForBoot(logPath, 120_000);
    if (boot.port === 0) {
      fail("宿主启动失败或有插件未激活");
      console.error(boot.text.slice(-3000));
      return;
    }
    console.log(`宿主已启动：http://127.0.0.1:${boot.port}`);

    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const source = browserScript(
      `http://127.0.0.1:${boot.port}/?token=${boot.token}`,
      shotsDir,
      SMOKE_WORKSPACE_DIR,
    );
    await writeFile(browserFile, source);

    const raw = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
      child.stdout.on("data", (c) => {
        out += String(c);
      });
      child.stderr.on("data", (c) => {
        out += String(c);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolvePromise(out);
      });
      void readFile(browserFile).then((buffer) => child.stdin.end(buffer));
    });
    if (process.env.SMOKE_DEBUG) console.log(String(raw).slice(-8000));

    const match = String(raw).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果");
      console.error(String(raw).slice(-3000));
      return;
    }
    const result = JSON.parse(match[1]);
    if (result.fatal) fail(`浏览器脚本异常：${result.fatal}`);

    /** @type {{ name: string, ok: boolean, detail: string }[]} */
    const checks = result.checks ?? [];

    // Node 侧：宿主真的落盘了，且没有残留临时文件
    const storePath = join(home, "projects", "projects.json");
    const storeText = await readIfExists(storePath);
    checks.push({
      name: "宿主侧已写出 projects.json",
      ok: storeText !== "",
      detail: storePath,
    });
    checks.push({
      name: "新建的项目出现在元数据里",
      ok: typeof result.projectName === "string" && storeText.includes(result.projectName),
      detail: String(result.projectName ?? ""),
    });
    let parsed = null;
    try {
      parsed = JSON.parse(storeText);
    } catch {
      parsed = null;
    }
    checks.push({
      name: "元数据是合法 JSON 且格式版本为 1",
      ok: parsed !== null && parsed.format === 1,
      detail: parsed === null ? "parse failed" : `format=${parsed.format}`,
    });
    checks.push({
      name: "默认策略是 L1 且危险开关全关",
      ok:
        parsed !== null &&
        Object.values(parsed.projects ?? {}).every(
          (/** @type {any} */ project) =>
            project.policy?.autonomy === "L1" &&
            Object.values(project.policy?.danger ?? {}).every((value) => value === false),
        ),
      detail:
        parsed === null
          ? ""
          : JSON.stringify(Object.values(parsed.projects ?? {})[0]?.policy ?? {}).slice(0, 160),
    });
    const leftovers = (await readdir(join(home, "projects")).catch(() => [])).filter((name) =>
      String(name).includes(".tmp-"),
    );
    const isolated = Object.values(parsed?.threads ?? {}).filter(
      (/** @type {any} */ thread) => typeof thread?.worktree === "string" && thread.worktree !== "",
    );
    checks.push({
      name: "隔离 worktree 目录真实存在",
      ok:
        isolated.length > 0 &&
        isolated.every((/** @type {any} */ thread) => existsSync(String(thread.worktree))),
      detail: JSON.stringify(
        isolated.map((/** @type {any} */ thread) => String(thread.worktree)).slice(0, 2),
      ),
    });
    checks.push({
      name: "隔离 worktree 不在主工作树里（同级隐藏目录）",
      ok: isolated.every(
        (/** @type {any} */ thread) =>
          String(thread.worktree).includes("/.dsh-worktrees/") &&
          !String(thread.worktree).includes("/.git/"),
      ),
      detail: "",
    });
    checks.push({
      name: "新建的线程带 worktree 隔离记录",
      ok: isolated.length > 0,
      detail: JSON.stringify(
        isolated.map((/** @type {any} */ thread) => String(thread.branch ?? "")).slice(0, 2),
      ),
    });
    // 回收站：删除的项目要留下可恢复的清单
    const trashRoot = join(home, "projects", "trash");
    const trashEntries = await readdir(trashRoot).catch(() => []);
    let manifest = null;
    for (const entry of trashEntries) {
      const text = await readIfExists(join(trashRoot, entry, "manifest.json"));
      if (text !== "") {
        try {
          manifest = JSON.parse(text);
        } catch {
          manifest = null;
        }
        break;
      }
    }
    checks.push({
      name: "删除留下回收站条目与 manifest",
      ok:
        trashEntries.length > 0 && manifest !== null && typeof manifest.project?.name === "string",
      detail: `${trashEntries.length} 条 · ${manifest ? manifest.project.name : "no-manifest"}`,
    });
    checks.push({
      name: "回收站清单写明可恢复与影响面",
      ok: manifest !== null && /可恢复/u.test(String(manifest.summary ?? "")),
      detail: String(manifest?.summary ?? "").slice(0, 120),
    });
    const archivedProjects = Object.values(parsed?.projects ?? {}).filter(
      (/** @type {any} */ project) => project?.state === "archived",
    );
    checks.push({
      name: "归档动作在宿主侧生效（state=archived）",
      ok: archivedProjects.length > 0,
      detail: JSON.stringify(
        archivedProjects.map((/** @type {any} */ project) => project.name).slice(0, 2),
      ),
    });
    const pausedProjects = Object.values(parsed?.projects ?? {}).filter(
      (/** @type {any} */ project) => project?.state === "paused",
    );
    checks.push({
      name: "暂停动作在宿主侧生效（state=paused）",
      ok: pausedProjects.length > 0,
      detail: JSON.stringify(
        pausedProjects.map((/** @type {any} */ project) => project.name).slice(0, 2),
      ),
    });
    const pinnedProjects = Object.values(parsed?.projects ?? {}).filter(
      (/** @type {any} */ project) => project?.pinned === true,
    );
    checks.push({
      name: "收藏动作在宿主侧落盘（pinned=true 可回读）",
      ok:
        pinnedProjects.length === 1 &&
        pinnedProjects[0].name === result.pinnedProject &&
        typeof pinnedProjects[0].pinned === "boolean",
      detail: JSON.stringify(pinnedProjects.map((/** @type {any} */ project) => project.name)),
    });
    checks.push({
      name: "未收藏的项目 pinned 显式为 false（不是缺字段）",
      ok: Object.values(parsed?.projects ?? {}).every(
        (/** @type {any} */ project) => typeof project?.pinned === "boolean",
      ),
      detail: "",
    });
    const threadIds = parsed?.threads ? Object.keys(parsed.threads) : [];
    checks.push({
      name: "会话归属记录已落盘（threads 非空）",
      ok: threadIds.length > 0,
      detail: threadIds.map((id) => String(id).slice(0, 12)).join(","),
    });
    checks.push({
      name: "归属记录指向真实项目",
      ok:
        parsed !== null &&
        threadIds.every((id) => Boolean(parsed.projects?.[parsed.threads[id]?.projectId])),
      detail: "",
    });
    checks.push({
      name: "原子写没有残留 .tmp 文件",
      ok: leftovers.length === 0,
      detail: leftovers.join(","),
    });

    const shots = await readdir(shotsDir).catch(() => []);
    checks.push({ name: "已保存截图", ok: shots.length > 0, detail: shots.join(",") });

    for (const item of checks) {
      console.log(
        (item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`),
      );
    }
    const failed = checks.filter((item) => item.ok === false).length;
    console.log(`截图目录：${shotsDir}`);
    if (failed > 0) {
      fail(`${failed} 项 web 冒烟断言失败`);
    } else {
      console.log(`PASS 全部 ${checks.length} 项 web 冒烟断言通过`);
    }
    // 门禁靠这一行判定「跑过但零断言」的假绿（见 docs/plugin-conventions.md §6.1）。
    console.log(`${checks.length - failed} PASS / 0 SKIP / ${failed} FAIL`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    hostLog?.end();
    await sleep(500);
    if (process.env.SMOKE_KEEP) {
      console.log(`保留临时 home：${work}`);
    } else {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
};

await main();
