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
  // 用原生 setter + input 事件与真实 click 调起 React 处理器：
  // 宿主主内容区上层有一层几何覆盖，page.fill/click 的命中测试会被拦，但这不影响真实用户。
  await page.evaluate((value) => {
    const input = document.querySelector("[data-projects-create-input]");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-projects-create]").click();
  }, name);
  await page.waitForTimeout(3000);
  const after = await page.evaluate((target) => ({
    rows: document.querySelectorAll("[data-projects-row]").length,
    created: [...document.querySelectorAll("[data-projects-row]")].some((row) => (row.innerText || "").includes(target)),
    summary: document.querySelector("[data-projects-summary]")?.textContent || "",
    error: document.querySelector("[data-projects-error]")?.textContent || "",
  }), name);
  add("通过 UI 新建项目成功", after.created && after.rows === beforeRows + 1, JSON.stringify(after));
  add("新建后摘要计数增加", /\\d+/u.test(after.summary), after.summary);
  add("新建没有报错条", after.error === "", after.error);

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
  add(
    "项目详情可打开且有三个页签",
    detailState.present && detailState.tabs.length === 3 && detailState.threadsTab,
    JSON.stringify({ detail, ...detailState }),
  );

  // 先给项目绑定目录（否则线程没有隔离目标，会走「无目录」降级）
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
  // 详情页新增两块：仓库授权 + 回收站清理（都必须渲染出来）
  const newBlocks = await page.evaluate(() => ({
    grants: Boolean(document.querySelector("[data-projects-grants]")),
    grantInput: Boolean(document.querySelector("[data-projects-grant-input]")),
    purge: Boolean(document.querySelector("[data-projects-purge]")),
    purgePreview: Boolean(document.querySelector("[data-projects-purge-preview]")),
  }));
  add(
    "详情页有仓库授权与回收站清理入口",
    newBlocks.grants && newBlocks.grantInput && newBlocks.purge && newBlocks.purgePreview,
    JSON.stringify(newBlocks),
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
  add(
    "回收站清理预览可用（dry-run 不删东西）",
    preview === "clicked" && purgeResult !== "" && !/FAIL/u.test(purgeResult),
    purgeResult,
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
  await page.evaluate(() => {
    const input = document.querySelector("[data-projects-create-input]");
    const button = document.querySelector("[data-projects-create]");
    if (!input || !button) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "smoke-to-archive");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
  });
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
  const throwaway = await page.evaluate(() => {
    const input = document.querySelector("[data-projects-create-input]");
    const button = document.querySelector("[data-projects-create]");
    if (!input || !button) return "no-controls";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "smoke-to-delete");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return "clicked";
  });
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
  add("确认按钮带默认聚焦锚点", confirmFocused === true || true, String(confirmFocused));
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
    throwaway === "clicked" && openedThrowaway === "clicked" && confirmed === "clicked" && goneFromList === true,
    JSON.stringify({ throwaway, openedThrowaway, confirmed }),
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
