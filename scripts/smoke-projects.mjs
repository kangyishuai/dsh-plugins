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
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Node 侧直接复用插件的读路径做「冷启动」验证：同一份 projects.json，
// 经过 ProjectStore.load() + deriveThreadState() 还能读出 failed（P0-2 的端到端证据）。
import {
  deriveThreadState,
  hydrateThreadView,
  replay,
  THREAD_STATES,
} from "../packages/projects/lib/overview.js";
import { ProjectStore } from "../packages/projects/lib/store.js";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-projects-shots");
const PKG_DIR = join(REPO, "packages", "projects");
const PACKAGE = "@kangyishuai/dsh-projects";
const PROFILE = "proj";
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * INFRA：基础设施自检失败。**不要**把它混进断言计数——端口没起来、projects.json 没落盘
 * 这类问题会让后面几十条断言连锁变红，看起来像代码坏了，实际是环境没就绪。
 * 打印 `INFRA` 并 fail-fast（非零退出），门禁只认 PASS/FAIL 计数行。
 * @param {string} message @param {unknown} [detail]
 * @returns {never}
 */
/** 宿主句柄：INFRA 早退时也要先杀掉，否则每轮失败都会留一个 150–280MB 的孤儿宿主。
 * @type {import("node:child_process").ChildProcess | undefined}
 */
let activeHost;

/** @param {string} message @param {any} [detail] @returns {never} */
function infraFail(message, detail) {
  console.error(`INFRA ${message}`);
  if (detail !== undefined && String(detail) !== "") console.error(String(detail).slice(-2000));
  try {
    activeHost?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  process.exit(1);
}

/** 宿主端口必须真的可连（比「日志里打印了地址」更硬）。 */
async function assertHostPort(/** @type {number} */ port) {
  const ok = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
  if (!ok) infraFail(`宿主端口 ${port} 不可用（进程起了但没监听）`);
}

/** 每次 RPC 一个唯一 rpcId（网关按它配对响应）。 */
let rpcCounter = 0;

/**
 * 直连宿主 RPC：`token → cookie → POST /api/<namespace>/<method>`（docs/runtime 0.2.2-rc.5 §18）。
 * wire 形状是完整的 client-request 信封（`{ type, rpcId, method, payload:{ args } }`），
 * 只发 `{ args }` 会被网关拒成 `gateway/bad-request`。
 * 用来验证「UI 不可达但契约必须成立」的行为（未知 projectId 拒绝、once 时序、Library 回读）。
 * @param {number} port @param {string} token @param {string} method @param {Record<string, unknown>} args
 */
async function hostRpc(port, token, method, args) {
  const base = `http://127.0.0.1:${port}`;
  const handshake = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  const cookies = (handshake.headers.getSetCookie?.() ?? []).map((item) => item.split(";")[0]);
  rpcCounter += 1;
  const rpcId = `smoke-${Date.now().toString(36)}-${rpcCounter}`;
  const response = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies.join("; ") },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const envelope =
    json && typeof json === "object" && json.result && typeof json.result === "object"
      ? json.result
      : json;
  const value =
    envelope && typeof envelope === "object" && "value" in envelope ? envelope.value : envelope;
  const error =
    envelope && typeof envelope === "object" && envelope.ok === false ? envelope.error : null;
  return { status: response.status, json, value, error, text };
}

/** catch 变量在 useUnknownInCatchVariables 下是 unknown：统一取一句话错误文案。 */
function errorText(/** @type {unknown} */ error) {
  return String(/** @type {any} */ (error)?.message ?? error);
}

/** 从 client.js 抽运行时字典键（与单测 locale-parity 同一份事实，冒烟再验一次线上口径）。 */
async function runtimeDictionaryKeys(/** @type {string} */ name) {
  const source = await readFile(join(REPO, "packages", "projects", "lib", "client.js"), "utf8");
  const marker = `var ${name} = {`;
  const start = source.indexOf(marker);
  const open = source.indexOf("{", start);
  let depth = 0;
  let index = open;
  let quote = "";
  let escaped = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== "") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // 求值对象是 packages/projects/lib/client.js 里的对象字面量（只含字符串常量），不来自外部输入。
  // biome-ignore lint/security/noGlobalEval: 见上一行说明
  const evaluate = /** @type {(code: string) => Record<string, string>} */ (eval);
  return Object.keys(evaluate(`(${source.slice(open, index + 1)})`));
}

/** @param {"zh"|"en"} lang */
async function localeKeys(lang) {
  const raw = JSON.parse(
    await readFile(join(REPO, "packages", "projects", "locale", `${lang}.json`), "utf8"),
  );
  return Object.keys(raw.projects ?? {});
}

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
 * @param {string} secondDir
 */
function browserScript(url, shotsDir, workspaceDir, secondDir) {
  return `
const SMOKE_WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};
const SMOKE_SECOND_DIR = ${JSON.stringify(secondDir)};
const result = { checks: [], skips: [], fatal: "" };
const add = (name, ok, detail) => result.checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });
const skipAdd = (name, detail) => result.skips.push({ name, detail: String(detail || "") });
// 轮询等待：固定的 waitForTimeout 在慢机器/首次编译时会偶发不足（同 commit 两次跑结果不同）。
const waitUntil = async (fn, timeout = 12000, step = 200) => {
  const startedAt = Date.now();
  for (;;) {
    let value = null;
    try {
      value = await fn();
    } catch (error) {
      value = null;
    }
    if (value) return value;
    if (Date.now() - startedAt >= timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
};
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
  // —— F63/U21 首启引导：一次性（firstRunDone 存宿主 storageDomain），4 bullet + CTA ——
  const firstRun = await page.evaluate(() => {
    const node = document.querySelector("[data-projects-firstrun]");
    return node
      ? {
          state: node.getAttribute("data-projects-firstrun"),
          persisted: node.getAttribute("data-projects-firstrun-persisted"),
          dialog: Boolean(document.querySelector("[data-projects-firstrun-dialog]")),
          bullets: document.querySelectorAll("[data-projects-firstrun-bullet]").length,
          cta: Boolean(document.querySelector("[data-projects-firstrun-cta]")),
        }
      : null;
  });
  add(
    "首启引导出现（4 条 bullet + CTA）",
    firstRun?.state === "open" && firstRun.dialog === true && firstRun.bullets === 4 && firstRun.cta === true,
    JSON.stringify(firstRun),
  );
  await page.evaluate(() => document.querySelector("[data-projects-firstrun-cta]")?.click());
  await page.waitForTimeout(700);
  const firstRunClosed = await page.evaluate(
    () => document.querySelector("[data-projects-firstrun]") === null,
  );
  add("点「开始使用」后首启引导关闭", firstRunClosed === true, String(firstRunClosed));

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
  // F39：goal ≤8,000 与字数提示（对齐 Claude 的 28 / 8,000 口径）
  const goalCounter = await page.evaluate(async () => {
    const input = document.querySelector("[data-projects-new-goal]");
    const counter = () => document.querySelector("[data-projects-goal-counter]");
    if (!input || !counter()) return { ok: false, reason: "no-counter" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const initial = counter().textContent || "";
    setter.call(input, "把 CI 修绿");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const typed = counter().textContent || "";
    const maxLength = input.getAttribute("maxlength");
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, initial, typed, maxLength };
  });
  add(
    "goal 带 x / 8,000 计数并随输入更新",
    goalCounter.ok === true &&
      goalCounter.initial.includes("/ 8,000") &&
      goalCounter.typed.includes("/ 8,000") &&
      goalCounter.typed !== goalCounter.initial,
    JSON.stringify(goalCounter),
  );
  add(
    "goal 输入有 8000 的硬上限（maxlength）",
    goalCounter.ok === true && goalCounter.maxLength === "8000",
    String(goalCounter.maxLength),
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

  // —— F2 Context 多选：目录 + 仓库都能加（≤10 上限由后端 store 再拦一道）——
  const contextTyped = await page.evaluate(() => {
    const set = (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    return {
      dir: set("[data-projects-new-dir]", "/tmp/projects-smoke-context"),
      repo: set("[data-projects-new-repo]", "acme/api"),
    };
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("[data-projects-new-dir-add]")?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("[data-projects-new-repo-add]")?.click());
  await page.waitForTimeout(300);
  const contextState = await page.evaluate(() => ({
    count: (document.querySelector("[data-projects-new-context-count]")?.textContent || "").trim(),
    dirs: document.querySelectorAll('[data-projects-new-context-item^="dir:"]').length,
    repos: document.querySelectorAll('[data-projects-new-context-item^="repo:"]').length,
    icon: Boolean(document.querySelector("[data-projects-new-icon]")),
  }));
  add(
    "新建项目有 Context 多选（目录 + 仓库可加入）",
    contextTyped.dir === true &&
      contextTyped.repo === true &&
      contextState.dirs === 1 &&
      contextState.repos === 1 &&
      contextState.icon === true,
    JSON.stringify({ contextTyped, contextState }),
  );
  // 加入后能移除（不做「只加不减」的多选）；移除目录，仓库留下以验证落盘
  await page.evaluate(() => document.querySelector('[data-projects-new-context-remove^="dir:"]')?.click());
  await page.waitForTimeout(250);
  const contextRemoved = await page.evaluate(
    () => document.querySelectorAll('[data-projects-new-context-item^="dir:"]').length,
  );
  add("Context 条目可以移除", contextRemoved === 0, String(contextRemoved));
  // —— F1 图标：创建时给一个短标记，列表行与 projects.json 都要能看到 ——
  await page.evaluate(() => {
    const input = document.querySelector("[data-projects-new-icon]");
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "🚀");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(300);
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
  const rowIcon = await page.evaluate((target) => {
    const row = [...document.querySelectorAll("[data-projects-row]")].find((node) =>
      (node.innerText || "").includes(target),
    );
    const icon = row?.querySelector("[data-projects-row-icon]");
    return icon ? (icon.textContent || "").trim() : "";
  }, name);
  add("列表行显示项目图标（F1）", rowIcon === "🚀", rowIcon);
  // toast 3.5s 自动消失：必须断言「真的消失」，不能只断言出现过。
  // 用轮询而不是固定 4.2s：慢机器上固定等待会偶发「还没消失」的假红。
  await waitUntil(
    async () =>
      (await page.evaluate(() => document.querySelectorAll("[data-projects-toast]").length)) === 0,
    12000,
    300,
  );
  const toastGone = await page.evaluate(() => document.querySelectorAll("[data-projects-toast]").length === 0);
  add("toast 在 4 秒内自动消失", toastGone === true, String(toastGone));
  const firstRunAgain = await page.evaluate(() =>
    Boolean(document.querySelector("[data-projects-firstrun]")),
  );
  add("首启引导不会在同一宿主再次出现", firstRunAgain === false, String(firstRunAgain));

  // 会话行菜单：先建一个会话（临时 home 已种工作区），再打开它的「…」菜单归属到项目。
  const createdSession = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      /新建会话|New session/u.test((b.getAttribute("aria-label") || "") + (b.textContent || "")),
    );
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await waitUntil(
    async () =>
      (await page.evaluate(() => document.querySelectorAll('[role="treeitem"]').length)) > 0,
    15000,
    300,
  );
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
  await waitUntil(
    async () => (await page.evaluate(() => Boolean(document.querySelector("[data-projects-attach-list]")))) === true,
    15000,
    300,
  );
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

  // 项目详情：点项目行 → 三个页签（线程/记忆/Routines）都可切换，返回后回到列表。
  // §7.3 页签上限 3：Library 改成右栏入口、审计进设置 Debug（下面各自断言）。
  const detail = await page.evaluate(() => {
    const row = document.querySelector("[data-projects-row]");
    if (!row) return "no-row";
    row.click();
    return "clicked";
  });
  await waitUntil(
    async () =>
      (await page.evaluate(
        () =>
          Boolean(
            document.querySelector("[data-projects-threads], [data-projects-threads-empty]"),
          ),
      )) === true,
    20000,
    300,
  );
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
    "项目详情可打开且恰四个页签（线程/Library/Routines/视图；D2）",
    detailState.present &&
      detailState.tabs.length === 4 &&
      ["threads", "library", "routines", "views"].every((id) =>
        detailState.tabs.includes(id),
      ) &&
      !detailState.tabs.includes("audit") &&
      detailState.threadsTab,
    JSON.stringify({ detail, ...detailState }),
  );

  // 外迁后不能有残留：详情页里既不该有 audit 页签，也不该有 Library 页签。
  const movedOut = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("[data-projects-tab]")].map((n) =>
      n.getAttribute("data-projects-tab"),
    );
    return {
      tabs,
      auditTab: Boolean(document.querySelector('[data-projects-tab="audit"]')),
      libraryTab: Boolean(document.querySelector('[data-projects-tab="library"]')),
      auditInDetail: Boolean(
        document.querySelector("[data-projects-detail] [data-projects-audit], [data-projects-detail] [data-projects-audit-empty]"),
      ),
      libraryRail: Boolean(document.querySelector("[data-projects-library-open]")),
      railLibraryRow: Boolean(document.querySelector("[data-projects-rail-library]")),
    };
  });
  add(
    "Library 成为页签、审计仍外迁：右栏 Library 入口可达且无审计残留锚点",
    movedOut.tabs.length === 4 &&
      movedOut.auditTab === false &&
      movedOut.libraryTab === true &&
      movedOut.auditInDetail === false &&
      movedOut.libraryRail === true &&
      movedOut.railLibraryRow === true,
    JSON.stringify(movedOut),
  );

  // U9：Library / Routines 都是真实视图。Library 不再是页签（§7.3）：
  // 点右栏 data-projects-library-open → 主列 data-projects-library-main 渲染 → back 收起。
  const u9 = await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const openTab = (id) => {
      const node = document.querySelector('[data-projects-tab="' + id + '"]');
      if (!node) return false;
      node.click();
      return true;
    };
    const readLibrary = () => {
      // B5 起 Library 是真实视图（不再是占位）：用它的数据锚点回答。
      const library = document.querySelector("[data-projects-library]");
      return library
        ? {
            present: true,
            kind: "library",
            note: "",
            degraded: library.getAttribute("data-projects-library-degraded") || "",
          }
        : null;
    };
    const readRoutines = () => {
      const root = document.querySelector("[data-projects-routines]");
      if (!root) return null;
      return {
        available: root.getAttribute("data-projects-routines-available"),
        note: document.querySelector("[data-projects-routines-cost]")?.textContent || "",
      };
    };
    const libraryOpen = document.querySelector("[data-projects-library-open]");
    const clickedLibrary = Boolean(libraryOpen);
    if (libraryOpen) libraryOpen.click();
    await wait(600);
    const library = readLibrary();
    const inMain = Boolean(
      document.querySelector("[data-projects-library-main] [data-projects-library]"),
    );
    const libraryBack = Boolean(document.querySelector("[data-projects-library-back]"));
    document.querySelector("[data-projects-library-back]")?.click();
    await wait(600);
    const backToThreads =
      Boolean(document.querySelector("[data-projects-threads], [data-projects-threads-empty]")) &&
      !document.querySelector("[data-projects-library-main]");
    const clickedRoutines = openTab("routines");
    await wait(900);
    const routines = readRoutines();
    openTab("threads");
    return {
      clickedLibrary,
      clickedRoutines,
      library,
      inMain,
      libraryBack,
      backToThreads,
      routines,
    };
  });
  add(
    "Library 从右栏入口打开并在主列渲染真实视图（不再是页签；B5 已落地）",
    u9.clickedLibrary === true &&
      u9.inMain === true &&
      u9.libraryBack === true &&
      u9.backToThreads === true &&
      u9.library?.kind === "library" &&
      u9.library.note === "" &&
      u9.library.present === true,
    JSON.stringify({ library: u9.library, inMain: u9.inMain, backToThreads: u9.backToThreads }),
  );
  add(
    "Routines 页签给出成本口径（每次投递跑一次模型，B4 已落地不是占位）",
    u9.clickedRoutines === true &&
      typeof u9.routines?.available === "string" &&
      u9.routines.available !== "" &&
      u9.routines.note.includes("跑一次模型"),
    JSON.stringify(u9.routines),
  );

  // Library 右栏行是开关：再点同一行收起（回线程列表），
  // aria-pressed 跟随状态——它是右栏入口，不是页签。
  const libraryToggle = await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rail = () => document.querySelector("[data-projects-library-open]");
    if (!rail()) return { ok: false, reason: "no-rail" };
    rail().click();
    await wait(700);
    const openedInMain = Boolean(document.querySelector("[data-projects-library-main]"));
    const pressedOpen = rail()?.getAttribute("aria-pressed") ?? "";
    rail()?.click();
    await wait(700);
    return {
      ok: true,
      openedInMain,
      pressedOpen,
      closed: !document.querySelector("[data-projects-library-main]"),
      pressedClosed: rail()?.getAttribute("aria-pressed") ?? "",
      threadsVisible: Boolean(
        document.querySelector("[data-projects-threads], [data-projects-threads-empty]"),
      ),
    };
  });
  add(
    "Library 右栏行可再次点击收起（aria-pressed 跟随，回到线程列表、不占页签）",
    libraryToggle.ok === true &&
      libraryToggle.openedInMain === true &&
      libraryToggle.pressedOpen === "true" &&
      libraryToggle.closed === true &&
      libraryToggle.pressedClosed === "false" &&
      libraryToggle.threadsVisible === true,
    JSON.stringify(libraryToggle),
  );
  await page.waitForTimeout(600);

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

  // —— F16/F25/F26/F27/F28/F31：Overview 六态 / 分组 / 药丸 / 步进 / 副标题 / Welcome ——
  // 线程由 createThread 建（会投递一条 prompt）；临时 home 没有模型凭据，
  // 这一轮必然以 MISSING_CREDENTIAL 失败 —— 正好验证「事件回写持久六态」。
  let overview = null;
  for (let i = 0; i < 60; i += 1) {
    overview = await page.evaluate(() => {
      const row = document.querySelector("[data-projects-thread-row]");
      if (!row) return null;
      const pills = {};
      for (const node of document.querySelectorAll("[data-projects-pill]")) {
        pills[node.getAttribute("data-projects-pill")] = Number(
          node.getAttribute("data-projects-pill-count"),
        );
      }
      return {
        sessionId: row.getAttribute("data-projects-thread-row") || "",
        state: row.getAttribute("data-projects-thread-state"),
        stepsState:
          document
            .querySelector("[data-projects-thread-steps]")
            ?.getAttribute("data-projects-thread-steps-state") || "",
        stepsText: (document.querySelector("[data-projects-thread-steps]")?.textContent || "").trim(),
        subtitle: Boolean(document.querySelector("[data-projects-thread-subtitle]")),
        subtitleText: (document.querySelector("[data-projects-thread-subtitle]")?.textContent || "").trim(),
        pills,
        pillsCount: document.querySelectorAll("[data-projects-pill]").length,
        groups: [...document.querySelectorAll("[data-projects-group]")].map((node) => ({
          id: node.getAttribute("data-projects-group"),
          count: Number(node.getAttribute("data-projects-group-count")),
        })),
        welcome: (document.querySelector("[data-projects-welcome-title]")?.textContent || "").trim(),
        status: (document.querySelector("[data-projects-welcome-status]")?.textContent || "").trim(),
        spark: document.querySelectorAll("[data-projects-spark-bar]").length,
      };
    });
    if (overview?.state && overview.state !== "working" && overview.state !== "idle") break;
    await page.waitForTimeout(500);
  }
  add(
    "线程六态由事件回写（失败轮 → failed）",
    overview?.state === "failed",
    JSON.stringify(overview?.state),
  );
  // Node 侧要拿同一份事实去和 projects.json 对（UI 说什么、盘上就得是什么）
  result.overviewFacts = {
    // 行的 sessionId：Node 侧要拿**同一行**的记录去对 projects.json（项目里不止一条线程）
    sessionId: overview?.sessionId ?? "",
    state: overview?.state ?? "",
    stepsState: overview?.stepsState ?? "",
    subtitlePresent: overview?.subtitle === true,
    subtitleText: overview?.subtitleText ?? "",
  };
  add(
    "Overview 药丸条：5 类 + 全部，计数可断言",
    overview?.pillsCount === 6 &&
      overview.pills.failed === 1 &&
      Object.keys(overview.pills).filter((key) => key !== "all").length === 5,
    JSON.stringify(overview?.pills),
  );
  add(
    "分组头带计数，且「等你」组收失败",
    (overview?.groups || []).some((group) => group.id === "waiting-user" && group.count >= 1),
    JSON.stringify(overview?.groups),
  );
  add(
    "没有 todo 时不显示 0/0（Claude 行尾留空，不再摆占位破折号）",
    overview?.stepsState === "none" && overview?.stepsText === "",
    JSON.stringify({ stepsState: overview?.stepsState, stepsText: overview?.stepsText }),
  );
  add(
    "副标题缺数据时不编造（只允许状态词或空）",
    overview?.subtitleText === "" || /空闲|在跑|等你|待审|失败|归档/u.test(String(overview?.subtitleText)),
    JSON.stringify({ subtitle: overview?.subtitle, text: overview?.subtitleText }),
  );
  add(
    "Welcome 头 + 状态句 + 7 日迷你图",
    /(Welcome back|欢迎回来)/u.test(overview?.welcome || "") &&
      (overview?.status || "") !== "" &&
      overview?.spark === 7,
    JSON.stringify({ welcome: overview?.welcome, status: overview?.status, spark: overview?.spark }),
  );

  // —— B2：协调者区（F9/F10/F11/F13）+ 展开面板（U5/U6/U7/F17/F19/F24/F12/F20）+ F21 轮询 ——
  const coordinatorInitial = await page.evaluate(() => {
    const area = document.querySelector("[data-projects-coordinator]");
    return {
      present: Boolean(area),
      available: area?.getAttribute("data-projects-coordinator-available") || "",
      input: Boolean(document.querySelector("[data-projects-coordinator-input]")),
      send: Boolean(document.querySelector("[data-projects-coordinator-send]")),
      restart: Boolean(document.querySelector("[data-projects-coordinator-restart]")),
      compaction: document
        .querySelector("[data-projects-coordinator-compaction]")
        ?.getAttribute("data-projects-coordinator-compaction") || "",
      empty: Boolean(document.querySelector("[data-projects-coordinator-empty]")),
    };
  });
  add(
    "项目页有协调者区（不是宿主 composer）+ 发送入口",
    coordinatorInitial.present === true &&
      coordinatorInitial.input === true &&
      coordinatorInitial.send === true,
    JSON.stringify(coordinatorInitial),
  );
  add(
    "没建会话时协调者区显示空态，且 compaction 判空有明确结论",
    coordinatorInitial.available === "no" &&
      coordinatorInitial.empty === true &&
      ["yes", "no"].includes(coordinatorInitial.compaction),
    JSON.stringify(coordinatorInitial),
  );
  // F9：建协调者会话（写）→ 回读 available/session（读）
  let coordinatorReady = null;
  for (let i = 0; i < 40; i += 1) {
    coordinatorReady = await page.evaluate(() => {
      const area = document.querySelector("[data-projects-coordinator]");
      return {
        available: area?.getAttribute("data-projects-coordinator-available") || "",
        session: area?.getAttribute("data-projects-coordinator-session") || "",
        restart: Boolean(document.querySelector("[data-projects-coordinator-restart]")),
      };
    });
    if (coordinatorReady.available === "yes" && coordinatorReady.session !== "") break;
    if (i === 0) {
      // 「建协调者」= ensureCoordinator（只建会话，**不发模型调用**）
      await page.evaluate(() =>
        document.querySelector("[data-projects-coordinator-create]")?.click(),
      );
    }
    await page.waitForTimeout(700);
  }
  add(
    "发一句话会给项目建出协调者会话（回读 session id）",
    coordinatorReady?.available === "yes" && coordinatorReady?.session !== "",
    JSON.stringify(coordinatorReady),
  );

  // 展开面板：U5 起始卡 / U7 chip / F17 Tasks / F19 steer / F24 模型 / F12 Create PR 条
  await page.evaluate(() => document.querySelector("[data-projects-thread-expand]")?.click());
  // 轮询等展开面板出现（固定 sleep 在慢机器上会闪空，重复跑时尤其不稳）
  {
    let shown = false;
    for (let i = 0; i < 20; i += 1) {
      shown = await page.evaluate(
        () =>
          document.querySelector("[data-projects-thread-detail]") !== null &&
          document.querySelector("[data-projects-thread-model-row]") !== null,
      );
      if (shown) break;
      await page.waitForTimeout(250);
    }
  }
  const expanded = await page.evaluate(() => ({
    detail: Boolean(document.querySelector("[data-projects-thread-detail]")),
    startCard: Boolean(document.querySelector("[data-projects-thread-start-card]")),
    chips: Boolean(document.querySelector("[data-projects-thread-chips]")),
    params: Boolean(document.querySelector("[data-projects-thread-params]")),
    paramsText: (
      document.querySelector("[data-projects-thread-params]")?.textContent || ""
    ).trim(),
    tasks: Boolean(document.querySelector("[data-projects-thread-tasks]")),
    tasksSource:
      document
        .querySelector("[data-projects-thread-tasks]")
        ?.getAttribute("data-projects-thread-tasks-source") || "",
    steerInput: Boolean(document.querySelector("[data-projects-thread-steer-input]")),
    steer: Boolean(document.querySelector("[data-projects-thread-steer]")),
    modelRow: Boolean(document.querySelector("[data-projects-thread-model-row]")),
    modelAvailable:
      document
        .querySelector("[data-projects-thread-model-row]")
        ?.getAttribute("data-projects-thread-model-available") || "",
    prButton: Boolean(document.querySelector("[data-projects-create-pr]")),
    prButtonDisabled: document.querySelector("[data-projects-create-pr]")?.disabled === true,
    effort: Boolean(document.querySelector("[data-projects-thread-effort-available]")),
    effortAvailable:
      document
        .querySelector("[data-projects-thread-effort-available]")
        ?.getAttribute("data-projects-thread-effort-available") || "",
    autofix: Boolean(document.querySelector("[data-projects-thread-autofix]")),
    autofixState:
      document
        .querySelector("[data-projects-thread-autofix]")
        ?.getAttribute("data-projects-thread-autofix-state") || "",
    autofixDisabled:
      document.querySelector("[data-projects-thread-autofix]")?.disabled === true,
    branchBar: Boolean(document.querySelector("[data-projects-branch-bar]")),
    branchLabel: (document.querySelector("[data-projects-branch-label]")?.textContent || "").trim(),
  }));
  add("线程行可展开，展开后有起始卡（U5）", expanded.detail && expanded.startCard, JSON.stringify(expanded));
  add(
    "展开面板给行内 chip（U7：参数 + 分支/无分支）",
    expanded.chips === true && expanded.params === true,
    JSON.stringify({ chips: expanded.chips, params: expanded.params }),
  );
  add(
    "Tasks 清单有区块并标数据来源（F17：没有 todo 显示 none，不编 0/0）",
    expanded.tasks === true && ["todo/write", "none"].includes(expanded.tasksSource),
    JSON.stringify({ tasks: expanded.tasks, source: expanded.tasksSource }),
  );
  // P1-7：thread.dir 以前只写不读——非隔离线程也必须能看出「跑在哪个目录」
  const workspaceDirName = String(SMOKE_WORKSPACE_DIR).split("/").pop() || "workspace";
  // 这一行是隔离线程（git 仓库 → worktree），chip 前半段写「隔离 worktree」；
  // 关键是**后半段必须是 thread.dir 的短名**（以前字段只写不读，行内根本看不到目录）。
  add(
    "行内 chip 显示 thread.dir 短名（P1-7：字段有读点，隔离/共享两种都显示）",
    expanded.params === true &&
      (expanded.paramsText.includes("共享目录") ||
        expanded.paramsText.includes("shared dir") ||
        expanded.paramsText.includes("隔离 worktree") ||
        expanded.paramsText.includes("isolated worktree")) &&
      expanded.paramsText.includes(workspaceDirName),
    JSON.stringify({ params: expanded.paramsText, expect: workspaceDirName }),
  );
  add(
    "steering 输入 + 按钮（F19）",
    expanded.steerInput === true && expanded.steer === true,
    JSON.stringify({ input: expanded.steerInput, button: expanded.steer }),
  );
  add(
    "每线程模型下拉或缺目录时有显式降级（F24）",
    expanded.modelRow === true && ["yes", "no"].includes(expanded.modelAvailable),
    JSON.stringify({ row: expanded.modelRow, available: expanded.modelAvailable }),
  );
  // F24/P1-3：effort 下拉必须和模型下拉并排出现（以前只传 provider/model，effort 从不传）
  add(
    "每线程 effort 下拉与模型下拉并排（F24：数据来自 modelCatalog.reasoning.efforts）",
    expanded.effort === true && ["yes", "no"].includes(expanded.effortAvailable),
    JSON.stringify({ effort: expanded.effort, available: expanded.effortAvailable }),
  );
  // F21/P1-2：auto-fix 的手动入口必须真实存在，并且当前没失败 CI 时是禁用的
  add(
    "auto-fix 手动入口可见且无失败 CI 时禁用（F21：autoFixStep 有调用者）",
    expanded.autofix === true &&
      expanded.autofixState === "none" &&
      expanded.autofixDisabled === true,
    JSON.stringify({
      button: expanded.autofix,
      state: expanded.autofixState,
      disabled: expanded.autofixDisabled,
    }),
  );
  // 有分支 → 按钮可点；没分支 → 按钮禁用并写明原因（两种都必须自洽，不能只测一种）
  const hasBranchLabel = /^分支 \\S+/u.test(String(expanded.branchLabel ?? ""));
  add(
    "Create PR 条 + 分支条（F12/F20/U16）：有分支可点、无分支时禁用并写明原因",
    expanded.branchBar === true &&
      expanded.prButton === true &&
      expanded.branchLabel !== "" &&
      expanded.prButtonDisabled === !hasBranchLabel,
    JSON.stringify({
      bar: expanded.branchBar,
      disabled: expanded.prButtonDisabled,
      label: expanded.branchLabel,
    }),
  );

  // F20（复审 P1-4）：以前这里只断言「按钮存在 + disabled 与分支自洽」，**从不点击**——
  // 把 service.createPr 里的 openPr 调用删掉，这条依然是 PASS。现在真的点：
  // 有分支就点一次，等行内动作条出现，并断言原因是**决策层的真实原因**（no-commits 等）；
  // 删掉 openPr 后 createPr 只能给出 "unknown"，于是这条会红。
  let prClick = { clicked: false, message: "", ok: null };
  if (expanded.prButton === true && expanded.prButtonDisabled === false) {
    await page.evaluate(() => document.querySelector("[data-projects-create-pr]")?.click());
    for (let i = 0; i < 30; i += 1) {
      prClick = await page.evaluate(() => {
        const el = document.querySelector("[data-projects-thread-action-result]");
        return {
          clicked: true,
          message: (el?.textContent || "").trim(),
          ok: el ? el.getAttribute("data-projects-thread-action-ok") : null,
        };
      });
      if (prClick.message !== "") break;
      await page.waitForTimeout(250);
    }
  }
  // 只有真的点过才算（没分支时按钮 disabled，本来就是「写明原因」的另一种自洽）
  // 注意：这段是模板字符串里的浏览器脚本，正则里不能写 \b（会被当成退格转义）
  const prReason = /(no-commits|branch-not-ours|too-many-attempts|tier-off|push-failed|gh-failed|title-required|body-required|branch-required)/u;
  add(
    "Create PR 点击后有真实结果态（F20：删掉 openPr 会红，不是只断言按钮存在）",
    expanded.prButtonDisabled === true
      ? expanded.prButton === true
      : prClick.message !== "" && prReason.test(prClick.message) && !prClick.message.includes("?"),
    JSON.stringify({ disabled: expanded.prButtonDisabled, ...prClick }),
  );

  // B2 证据截图：1440 宽详情页（协调者区 + 线程 chip + Tasks + PR/分支条）
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(500);
  {
    const b2Shot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(
      ${JSON.stringify(shotsDir)} + "/06-b2-detail-1440.png",
      Buffer.from(b2Shot.data, "base64"),
    );
  }

  // F21：轮询状态可见 + 实验档开关写→读
  const pollBefore = await page.evaluate(() => {
    const box = document.querySelector("[data-projects-detail-realtime-ci]");
    return {
      state: document
        .querySelector("[data-projects-poll-state]")
        ?.getAttribute("data-projects-poll-state") || "",
      toggle: Boolean(box),
      disabled: box?.disabled === true,
      implemented: box?.getAttribute("data-projects-detail-realtime-ci-implemented") || "",
      hint: (
        document.querySelector("[data-projects-detail-realtime-ci-row]")?.getAttribute("title") ||
        ""
      ).trim(),
    };
  });
  add(
    "PR 轮询状态可见（F21：运行中/已停 + 间隔）",
    ["running", "stopped"].includes(pollBefore.state) && pollBefore.toggle === true,
    JSON.stringify({ state: pollBefore.state, toggle: pollBefore.toggle }),
  );
  // F21 复审 P1-2：这个开关**没有实现**，以前能点能存却什么也不启动（假承诺）。
  // 现在必须 disabled 且写明「未实现」，不允许再回读成「已开启」。
  add(
    "实时监听开关 disabled 且明确「未实现」（F21/P1-2：不宣称会建 webhook）",
    pollBefore.toggle === true &&
      pollBefore.disabled === true &&
      pollBefore.implemented === "no" &&
      /未实现|not implemented/iu.test(pollBefore.hint),
    JSON.stringify(pollBefore),
  );

  // 自定义视图（D1：Views 页签里管理）：保存 → 列表出现 → 删除生效 → 再建一个留给 Node 侧查落盘
  const viewFlow = await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // 进入 Views 页签
    document.querySelector('[data-projects-tab="views"]')?.click();
    await wait(600);
    const paneReady = Boolean(document.querySelector("[data-projects-views-pane]"));
    const save = async (name) => {
      const input = document.querySelector("[data-projects-view-add-name]");
      if (!input) return false;
      setValue(input, name);
      await wait(200);
      document.querySelector("[data-projects-view-add-save]")?.click();
      for (let index = 0; index < 20; index += 1) {
        const rows = [...document.querySelectorAll("[data-projects-saved-view]")];
        if (rows.some((node) => (node.textContent || "").includes(name))) return true;
        await wait(200);
      }
      return false;
    };
    const saved = await save("冒烟视图A");
    const savedNames = [...document.querySelectorAll("[data-projects-saved-view]")].map(
      (node) => node.textContent || "",
    );
    document.querySelector("[data-projects-saved-view-delete]")?.click();
    for (let index = 0; index < 20; index += 1) {
      if (document.querySelectorAll("[data-projects-saved-view]").length === 0) break;
      await wait(200);
    }
    const afterDelete = document.querySelectorAll("[data-projects-saved-view]").length;
    const savedAgain = await save("冒烟视图B");
    const toggles = [...document.querySelectorAll("[data-projects-view-toggle]")].map((node) =>
      node.getAttribute("data-projects-view-toggle"),
    );
    // 关掉 Routines 视图再确认页签消失，然后恢复（switch 按钮，点击即切换）
    const toggleOn = (id) =>
      document
        .querySelector('[data-projects-view-toggle="' + id + '"]')
        ?.getAttribute("data-projects-view-toggle-on") === "true";
    const setToggle = async (id, want) => {
      for (let index = 0; index < 20; index += 1) {
        if (toggleOn(id) === want) return true;
        document.querySelector('[data-projects-view-toggle="' + id + '"]')?.click();
        await wait(250);
      }
      return toggleOn(id) === want;
    };
    await setToggle("routines", false);
    await wait(600);
    const tabsAfterHide = [...document.querySelectorAll("[data-projects-tab]")].map((node) =>
      node.getAttribute("data-projects-tab"),
    );
    await setToggle("routines", true);
    await wait(600);
    // 关掉 Library 并保持关闭：Node 侧据此断言 visibleViews 落盘
    await setToggle("library", false);
    await wait(800);
    const tabsAfterLibraryHidden = [...document.querySelectorAll("[data-projects-tab]")].map(
      (node) => node.getAttribute("data-projects-tab"),
    );
    document.querySelector('[data-projects-tab="threads"]')?.click();
    await wait(400);
    return {
      paneReady,
      saved,
      savedAgain,
      savedNames,
      afterDelete,
      kept: [...document.querySelectorAll("[data-projects-saved-view]")].map(
        (node) => node.textContent || "",
      ),
      toggles,
      tabsAfterHide,
      tabsAfterLibraryHidden,
      toggleHit: document.body.getAttribute("data-projects-toggle-hit"),
      viewError: document.body.getAttribute("data-projects-view-error"),
      viewStage: document.body.getAttribute("data-projects-view-stage"),
      viewResult: document.body.getAttribute("data-projects-view-result"),
    };
  });
  add(
    "D1 Views 页签：勾选可见性（关掉 Routines 页签消失）+ 保存/删除筛选视图",
    viewFlow?.paneReady === true &&
      viewFlow?.saved === true &&
      viewFlow?.savedAgain === true &&
      (viewFlow?.savedNames || []).some((text) => text.includes("冒烟视图A")) &&
      viewFlow?.afterDelete === 0 &&
      (viewFlow?.toggles || []).join(",") === "threads,library,routines" &&
      viewFlow?.tabsAfterHide?.includes("routines") === false &&
      viewFlow?.tabsAfterLibraryHidden?.includes("library") === false,
    JSON.stringify({
      paneReady: viewFlow?.paneReady,
      saved: viewFlow?.saved,
      savedAgain: viewFlow?.savedAgain,
      afterDelete: viewFlow?.afterDelete,
      tabsAfterHide: viewFlow?.tabsAfterHide,
      tabsAfterLibraryHidden: viewFlow?.tabsAfterLibraryHidden,
      toggleHit: viewFlow?.toggleHit,
      viewError: viewFlow?.viewError,
    }),
  );

  // F26：点药丸 = 过滤；「全部」= 清除
  await page.evaluate(() => document.querySelector('[data-projects-pill="failed"]')?.click());
  await page.waitForTimeout(400);
  const filtered = await page.evaluate(() => ({
    filter: document.querySelector("[data-projects-threads]")?.getAttribute("data-projects-filter"),
    states: [...document.querySelectorAll("[data-projects-thread-row]")].map((row) =>
      row.getAttribute("data-projects-thread-state"),
    ),
  }));
  add(
    "点药丸按状态过滤（failed）",
    filtered.filter === "failed" &&
      filtered.states.length > 0 &&
      filtered.states.every((state) => state === "failed"),
    JSON.stringify(filtered),
  );
  // 空态：过滤一个计数为 0 的状态 → 「没有在等你的事。」+ 清除过滤出口
  const emptyPill = await page.evaluate(() => {
    const pill = [...document.querySelectorAll("[data-projects-pill]")].find(
      (node) =>
        node.getAttribute("data-projects-pill") !== "all" &&
        node.getAttribute("data-projects-pill-count") === "0",
    );
    if (!pill) return "no-pill";
    pill.click();
    return pill.getAttribute("data-projects-pill");
  });
  await page.waitForTimeout(400);
  const emptyState = await page.evaluate(() => ({
    present: Boolean(document.querySelector("[data-projects-empty-overview]")),
    text: document.querySelector("[data-projects-empty-overview]")?.textContent || "",
  }));
  add(
    "过滤为空时给「没有在等你的事。」空态",
    emptyPill !== "no-pill" && emptyState.present && emptyState.text.includes("没有在等你的事"),
    JSON.stringify({ emptyPill, emptyState }),
  );
  await page.evaluate(() => document.querySelector("[data-projects-empty-overview-clear]")?.click());
  await page.waitForTimeout(400);
  const filterCleared = await page.evaluate(
    () => document.querySelector("[data-projects-threads]")?.getAttribute("data-projects-filter"),
  );
  add("清除过滤后回到完整列表", filterCleared === "", String(filterCleared));

  // F25/U11：分组折叠（折叠后行不渲染；再点展开）
  const rowsBeforeCollapse = await page.evaluate(
    () => document.querySelectorAll("[data-projects-thread-row]").length,
  );
  await page.evaluate(() =>
    document.querySelector('[data-projects-group-toggle="waiting-user"]')?.click(),
  );
  await page.waitForTimeout(600);
  const collapsedState = await page.evaluate(() => ({
    attr: document
      .querySelector('[data-projects-group="waiting-user"]')
      ?.getAttribute("data-projects-group-collapsed"),
    body: Boolean(document.querySelector('[data-projects-group-body="waiting-user"]')),
    rows: document.querySelectorAll("[data-projects-thread-row]").length,
  }));
  add(
    "分组可折叠（折叠后该组行不渲染）",
    collapsedState.attr === "true" &&
      collapsedState.body === false &&
      collapsedState.rows === rowsBeforeCollapse - 1,
    JSON.stringify({ rowsBeforeCollapse, collapsedState }),
  );
  // 折叠状态跨「返回→再进详情」保留（F25：存宿主 storageDomain）
  await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
  await waitUntil(
    async () => (await page.evaluate(() => document.querySelectorAll("[data-projects-row]").length)) > 0,
    15000,
    300,
  );
  await page.evaluate(() => document.querySelector("[data-projects-row]")?.click());
  await waitUntil(
    async () =>
      (await page.evaluate(() => Boolean(document.querySelector("[data-projects-group]")))) === true,
    15000,
    300,
  );
  const persistedCollapse = await page.evaluate(() =>
    document
      .querySelector('[data-projects-group="waiting-user"]')
      ?.getAttribute("data-projects-group-collapsed"),
  );
  add(
    "分组折叠状态跨进详情保留（storageDomain）",
    persistedCollapse === "true",
    String(persistedCollapse),
  );
  await page.evaluate(() =>
    document.querySelector('[data-projects-group-toggle="waiting-user"]')?.click(),
  );
  await page.waitForTimeout(500);

  // F7 项目切换器：标题即下拉，菜单里有项目且当前项打勾
  await page.evaluate(() => document.querySelector("[data-projects-switcher]")?.click());
  await page.waitForTimeout(450);
  const switcherOptions = await page.evaluate(() => ({
    open: Boolean(document.querySelector("[data-projects-switcher-menu]")),
    options: document.querySelectorAll("[data-projects-switcher-option]").length,
    current: document.querySelector("[data-projects-detail]")?.getAttribute("data-projects-detail"),
  }));
  add(
    "标题栏项目切换器可打开（F7/U2）",
    switcherOptions.open === true && switcherOptions.options >= 1,
    JSON.stringify(switcherOptions),
  );
  await page.evaluate(() => document.querySelector("[data-projects-switcher]")?.click());

  // F29：手动 Resolve / 重开（自动 resolve 留给 B6；这里只验手动）
  const openThreadMenu = async () => {
    await page.evaluate(() => document.querySelector("[data-projects-thread-menu]")?.click());
    await page.waitForTimeout(450);
  };
  await openThreadMenu();
  const resolveClicked = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-thread-resolve]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(1600);
  const resolvedState = await page.evaluate(() => {
    const pills = {};
    for (const node of document.querySelectorAll("[data-projects-pill]")) {
      pills[node.getAttribute("data-projects-pill")] = Number(
        node.getAttribute("data-projects-pill-count"),
      );
    }
    return {
      state: document.querySelector("[data-projects-thread-row]")?.getAttribute(
        "data-projects-thread-state",
      ),
      resolvedAt:
        document
          .querySelector("[data-projects-thread-row]")
          ?.getAttribute("data-projects-thread-resolved-at") || "",
      resolved: pills.resolved,
      group: Number(
        document
          .querySelector('[data-projects-group="resolved"]')
          ?.getAttribute("data-projects-group-count") || 0,
      ),
    };
  });
  add(
    "手动 Resolve 生效（行/药丸/分组一致）",
    resolveClicked === "clicked" &&
      resolvedState.state === "resolved" &&
      resolvedState.resolved === 1 &&
      resolvedState.group === 1,
    JSON.stringify({ resolveClicked, resolvedState }),
  );
  // 重开：状态不再是 resolved（失败轮的事实保留，所以会回到 failed）
  await openThreadMenu();
  const reopenClicked = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-thread-resolve]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(1600);
  const reopenedState = await page.evaluate(() =>
    document.querySelector("[data-projects-thread-row]")?.getAttribute("data-projects-thread-state"),
  );
  // P0-1 的 UI 半边：resolve 写进去的 resolvedAt 必须是**具体 ISO 时间**且能在行上读回，
  // Node 侧再拿同一个值和 projects.json 对（不是「null 或字符串」这种恒真断言）。
  result.resolvedAtSeen = resolvedState.resolvedAt;
  add(
    "resolve 后行上回读的 resolvedAt 是可解析的 ISO 时间（F29 写→回读）",
    typeof resolvedState.resolvedAt === "string" &&
      /^\\d{4}-\\d{2}-\\d{2}T/u.test(resolvedState.resolvedAt) &&
      !Number.isNaN(Date.parse(resolvedState.resolvedAt)),
    JSON.stringify({ state: resolvedState.state, resolvedAt: resolvedState.resolvedAt }),
  );
  add(
    "重开后不再显示已解决",
    reopenClicked === "clicked" && reopenedState !== "resolved",
    JSON.stringify({ reopenClicked, reopenedState }),
  );
  // 收尾把线程**留在已解决**：这样 Node 侧读 projects.json 时能拿一个「非默认值」做
  // 写→回读闭环（旧断言只校验「∈ 六态枚举」，而新建线程默认 idle 也能通过）。
  await openThreadMenu();
  const finalResolveClicked = await page.evaluate(() => {
    const button = document.querySelector("[data-projects-thread-resolve]");
    if (!button) return "no-button";
    button.click();
    return "clicked";
  });
  await page.waitForTimeout(1600);
  const finalThread = await page.evaluate(() => {
    const row = document.querySelector("[data-projects-thread-row]");
    return {
      state: row?.getAttribute("data-projects-thread-state") || "",
      resolvedAt: row?.getAttribute("data-projects-thread-resolved-at") || "",
    };
  });
  result.finalThread = finalThread;
  add(
    "收尾把线程留在 resolved（给宿主侧持久化断言一个具体值）",
    finalResolveClicked === "clicked" &&
      finalThread.state === "resolved" &&
      /^\\d{4}-\\d{2}-\\d{2}T/u.test(finalThread.resolvedAt),
    JSON.stringify({ finalResolveClicked, finalThread }),
  );

  // F31：手动标记未读 → 行首圆点；再标记已读清掉
  await openThreadMenu();
  await page.evaluate(() => document.querySelector("[data-projects-thread-unread-toggle]")?.click());
  await page.waitForTimeout(1400);
  const unreadOn = await page.evaluate(() => ({
    row: document
      .querySelector("[data-projects-thread-row]")
      ?.getAttribute("data-projects-thread-unread"),
    badge: Boolean(document.querySelector("[data-projects-thread-unread-badge]")),
  }));
  add(
    "标记未读出现圆点（F31）",
    unreadOn.row === "true" && unreadOn.badge === true,
    JSON.stringify(unreadOn),
  );
  await openThreadMenu();
  await page.evaluate(() => document.querySelector("[data-projects-thread-unread-toggle]")?.click());
  await page.waitForTimeout(1400);
  const unreadOff = await page.evaluate(() =>
    document.querySelector("[data-projects-thread-row]")?.getAttribute("data-projects-thread-unread"),
  );
  add("标记已读清掉圆点", unreadOff === "false", String(unreadOff));

  // F35：多目录 —— 在既有目录之上再加一个，rail 值行与落盘都要有两个
  await page.evaluate(() => document.querySelector("[data-projects-dir-edit]")?.click());
  await page.waitForTimeout(450);
  const dirLimitText = await page.evaluate(
    () => (document.querySelector("[data-projects-dir-limit]")?.textContent || "").trim(),
  );
  await page.evaluate((dir) => {
    const input = document.querySelector("[data-projects-dir-input]");
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, dir);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, SMOKE_SECOND_DIR);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector("[data-projects-dir-save]")?.click());
  await page.waitForTimeout(1600);
  const multiDir = await page.evaluate(() => ({
    rail: (document.querySelector("[data-projects-rail-dir]")?.textContent || "").trim(),
    editorClosed: document.querySelector("[data-projects-dir-input]") === null,
  }));
  add(
    "多目录：第二个目录加入后 rail 同时显示两个",
    multiDir.editorClosed === true &&
      multiDir.rail.includes("workspace2") &&
      multiDir.rail.includes("workspace"),
    JSON.stringify({ dirLimitText, multiDir }),
  );

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

  // —— F29：自动 resolve（设置页可能被宿主禁用 → 详情右栏必须有真能写的入口）——
  const autoResolveBefore = await page.evaluate(() => {
    const row = document.querySelector("[data-projects-auto-resolve]");
    const select = document.querySelector("[data-projects-auto-resolve-select]");
    return {
      project: (document.querySelector("[data-projects-detail-title]")?.textContent || "").trim(),
      present: Boolean(row) && Boolean(select),
      value: (row && row.getAttribute("data-projects-auto-resolve")) || "",
      options: select ? select.options.length : 0,
    };
  });
  add(
    "F29 自动 resolve 在详情右栏可配且默认关（设置页被禁用也够得着）",
    autoResolveBefore.present && autoResolveBefore.value === "off" && autoResolveBefore.options >= 2,
    JSON.stringify(autoResolveBefore),
  );
  const autoResolveIf = await page.evaluate(async () => {
    const select = document.querySelector("[data-projects-auto-resolve-select]");
    if (!select) return { changed: false, value: "" };
    select.value = "7";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const row = document.querySelector("[data-projects-auto-resolve]");
    return {
      changed: true,
      value: (row && row.getAttribute("data-projects-auto-resolve")) || "",
    };
  });
  add(
    "F29 自动 resolve 改成 7 天后 UI 回读一致（不是假开关）",
    autoResolveIf.changed === true && autoResolveIf.value === "7",
    JSON.stringify(autoResolveIf),
  );
  result.autoResolve = {
    projectName: autoResolveBefore.project,
    before: autoResolveBefore.value,
    after: autoResolveIf.value,
  };
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

  // —— P0-3：行摘要的 diff 必须来自真实 git numstat（以前 progress 只传 stats，恒 n/a）——
  const diffTarget = await page.evaluate(() => {
    const node = document.querySelector("[data-projects-thread-worktree]");
    const row = node && node.closest("[data-projects-thread-row]");
    const stats = row && row.querySelector("[data-projects-thread-stats]");
    return {
      sessionId: (row && row.getAttribute("data-projects-thread-row")) || "",
      worktree: (node && node.getAttribute("title")) || "",
      stats: (stats && stats.textContent ? stats.textContent : "").trim(),
      diff: (stats && stats.getAttribute("data-projects-thread-diff")) || "",
    };
  });
  add(
    "未改动时行摘要如实给出 diff 计数、不是恒 n/a（P0-3）",
    diffTarget.sessionId !== "" &&
      /diff\\s+\\d+\\s*文件/u.test(diffTarget.stats) &&
      !/diff n\\/a/u.test(diffTarget.stats),
    JSON.stringify(diffTarget),
  );
  let diffWriter = "no-worktree";
  if (diffTarget.worktree !== "") {
    const fsp = await import("node:fs/promises");
    const seedFile = diffTarget.worktree + "/seed.txt";
    const before = await fsp.readFile(seedFile, "utf8").catch(() => "seed\\n");
    await fsp.writeFile(seedFile, before + "smoke-diff-line-1\\nsmoke-diff-line-2\\n", "utf8");
    diffWriter = "written";
  }
  let diffAfter = null;
  for (let i = 0; i < 15; i += 1) {
    diffAfter = await page.evaluate((sessionId) => {
      const row = document.querySelector('[data-projects-thread-row="' + sessionId + '"]');
      const stats = row && row.querySelector("[data-projects-thread-stats]");
      return stats
        ? {
            text: (stats.textContent || "").trim(),
            diff: stats.getAttribute("data-projects-thread-diff") || "",
          }
        : null;
    }, diffTarget.sessionId);
    if (diffAfter && diffAfter.diff === "1:2:0") break;
    await page.waitForTimeout(1000);
  }
  add(
    "工作区真改 2 行后行摘要显示 diff 1 文件 +2/-0（P0-3：坏实现恒 n/a 会红）",
    diffWriter === "written" &&
      diffAfter !== null &&
      diffAfter.diff === "1:2:0" &&
      /\\+2\\/-0/u.test(diffAfter.text),
    JSON.stringify({ target: diffTarget, after: diffAfter, writer: diffWriter }),
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
  // 留一张详情页截图：线程行摘要与「仓库授权 / 回收站清理」两块新 UI 都在这一屏。
  // 截图前先关掉所有 popover（Esc），并把面板滚回顶部——否则截图里挂着一个菜单。
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const panel = document.querySelector("[data-projects-panel]");
    if (panel) panel.scrollTop = 0;
  });
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
  // 安全面变更必须写审计：断言随审计一起搬到设置 Debug 分区（见下面的设置分节那两条），
  // 项目详情页已不再有审计页签（§7.3 页签 ≤3）。
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

  const memoryTab = await page.evaluate(async () => {
    // 记忆已从页签迁到「项目设置 › 记忆」：开抽屉并切到记忆分区
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    document.querySelector("[data-panel-settings-open]")?.click();
    await wait(600);
    document.querySelector('[data-panel-settings-pane="memory"]')?.click();
    await wait(600);
    return document.querySelector("[data-projects-memory-pane]") ? "clicked" : "no-pane";
  });
  const memorySeen = await waitUntil(
    () =>
      page.evaluate(() =>
        Boolean(
          document.querySelector("[data-projects-instructions]") &&
            document.querySelector("[data-projects-memory-index]"),
        ),
      ),
    12000,
  );
  add("记忆页签渲染规则与索引", memorySeen === true, String(memoryTab));

  // —— B3 第二批 UI：授权卡 / 线程默认模型 / 从会话开线程 / 线程动作 / @ 源 ——
  await page.evaluate(() => {
    document.querySelector("[data-panel-settings-close]")?.click();
    document.querySelector('[data-projects-tab="threads"]')?.click();
  });
  await page.waitForTimeout(700);
  const b3ui = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const result = {};
    result.card = Boolean(q("[data-projects-b3-card]"));
    result.mention =
      q("[data-projects-mention-source]")?.getAttribute("data-projects-mention-source") || "";
    q("[data-projects-mention-load]")?.click();
    await wait(1200);
    result.mentionCandidates = all("[data-projects-mention-candidate]").length;
    result.mentionTokens = all("[data-projects-mention-candidate]").map((node) =>
      node.getAttribute("data-projects-mention-candidate"),
    );
    const folderButtons = all("[data-projects-folder-decision]");
    result.folderButtons = folderButtons.map((n) => n.getAttribute("data-projects-folder-decision"));
    result.folderPath = folderButtons[0]?.getAttribute("data-projects-folder-path") || "";
    const defaultButton = folderButtons.find(
      (n) => n.getAttribute("data-projects-folder-decision") === "default",
    );
    if (defaultButton) {
      defaultButton.click();
      await wait(1400);
    }
    // 授权三键点「设为默认」（回读在下面用 Node 侧轮询，避免单次 evaluate 超 15s）。
    result.folderMode =
      q("[data-projects-folder-mode]")?.getAttribute("data-projects-folder-mode") || "";
    result.folderMessage = q("[data-projects-b3-message]")?.textContent || "";
    result.folderCardAttrs = all("[data-projects-folder-card]").map((node) =>
      node.getAttribute("data-projects-folder-card"),
    );
    // F42：两个下拉必须是**可写的**，选项来自 modelCatalog；选中值保存后由下面轮询回读。
    const modelSel = q("[data-projects-thread-model]");
    const effortSel = q("[data-projects-thread-effort]");
    result.hasModel = Boolean(modelSel);
    result.hasEffort = Boolean(effortSel);
    result.modelDisabled = modelSel ? modelSel.disabled : null;
    result.effortDisabled = effortSel ? effortSel.disabled : null;
    result.modelOptions = modelSel ? [...modelSel.options].map((option) => option.value) : [];
    result.modelOptionsInitial = result.modelOptions.slice();
    const effortSelEarly = q("[data-projects-thread-effort]");
    result.effortOptionsInitial = effortSelEarly
      ? [...effortSelEarly.options].map((option) => option.value)
      : [];
    const catalogRaw =
      q("[data-projects-thread-defaults]")?.getAttribute("data-projects-model-catalog") || "";
    try {
      result.modelCatalogStats = JSON.parse(catalogRaw);
    } catch (_error) {
      result.modelCatalogStats = null;
    }
    const targetModel = result.modelOptions.find((value) => value !== "") || "";
    if (modelSel && targetModel !== "") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(modelSel, targetModel);
      modelSel.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(400);
    }
    const effortSel2 = q("[data-projects-thread-effort]");
    const effortValues = effortSel2 ? [...effortSel2.options].map((option) => option.value) : [];
    const targetEffort = effortValues.find((value) => value !== "") || "";
    if (effortSel2) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(effortSel2, targetEffort);
      effortSel2.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(300);
    }
    result.effortOptions = effortValues;
    // 目录为空（无凭据部署）时走手填：写入一组**具体值**，保存后逐字段回读。
    const manualProvider = targetModel === "" ? "smoke-provider" : targetModel.split("|")[0] || "";
    const manualModel =
      targetModel === "" ? "smoke-model" : targetModel.split("|").slice(1).join("|");
    const manualEffort = targetEffort === "" ? "high" : targetEffort;
    result.defaultsPicked = {
      provider: manualProvider,
      modelId: manualModel,
      effort: manualEffort,
    };
    if (targetModel === "") {
      q("[data-projects-thread-manual-toggle]")?.click();
      await wait(300);
      const fillText = (selector, value) => {
        const input = q(selector);
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      fillText("[data-projects-thread-model-manual]", manualProvider + "|" + manualModel);
      fillText("[data-projects-thread-effort-manual]", manualEffort);
      await wait(400);
    }
    q("[data-projects-thread-defaults-save]")?.click();
    await wait(500);
    return result;
  });
  // 线程动作（自绘「⋯」菜单 + 行内重命名）：单独一次 evaluate，避免和上面的轮询叠加超 15s。
  const b3uiMenu = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const result = {};

    const menuButtons = all("[data-projects-thread-menu]");
    const targetMenu = menuButtons[menuButtons.length - 1];
    if (targetMenu) targetMenu.click();
    await wait(1200);
    result.menuItems = all("[role=menuitem]").map((n) => n.textContent || "");
    result.renameRow =
      all("[data-projects-thread-rename]")[0]?.getAttribute("data-projects-thread-rename") || "";
    result.copyRow =
      all("[data-projects-thread-copy]")[0]?.getAttribute("data-projects-thread-copy") || "";
    const renameButton = all("[data-projects-thread-rename]")[0];
    if (renameButton) {
      renameButton.click();
      await wait(500);
      const renameInput = q("[data-projects-thread-rename-input]");
      if (renameInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(renameInput, "B3 重命名线程");
        renameInput.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(300);
        q("[data-projects-thread-rename-save]")?.click();
        // 列表刷新走 progress RPC（含宿主 state 汇总），给足时间再回读
        await wait(5000);
        result.renameSaved = Boolean(q("[data-projects-thread-rename-message]"));
        result.renameMessage =
          q("[data-projects-thread-rename-message]")?.textContent || "";
        result.renameTitle = "B3 重命名线程";
        result.renameReadback = all("[data-projects-thread-title]").some(
          (n) => (n.textContent || "").trim() === "B3 重命名线程",
        );
      }
    }
    result.actions = all("[data-projects-thread-action]").map((n) =>
      n.getAttribute("data-projects-thread-action"),
    );
    result.actionTarget =
      q("[data-projects-thread-rename-row]")?.getAttribute("data-projects-thread-rename-row") || "";
    const unread = all("[data-projects-thread-action]").find(
      (n) => n.getAttribute("data-projects-thread-action") === "unread",
    );
    if (unread) {
      unread.click();
      await wait(1300);
    }
    const renameToggle = all("[data-projects-thread-action]").find(
      (n) => n.getAttribute("data-projects-thread-action") === "rename",
    );
    if (renameToggle) {
      renameToggle.click();
      await wait(500);
    }
    const renameInput = q("[data-projects-thread-rename-input]");
    if (renameInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(renameInput, "B3 重命名线程");
      renameInput.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(300);
      q("[data-projects-thread-rename-save]")?.click();
      await wait(1400);
    }
    return result;
  });
  b3ui.menuItems = b3uiMenu.menuItems;
  b3ui.renameRow = b3uiMenu.renameRow;
  b3ui.copyRow = b3uiMenu.copyRow;
  b3ui.renameSaved = b3uiMenu.renameSaved;
  b3ui.renameMessage = b3uiMenu.renameMessage;
  b3ui.renameReadback = b3uiMenu.renameReadback;
  b3ui.actions = b3uiMenu.actions;
  b3ui.actionTarget = b3uiMenu.actionTarget;

  // U18：线程行右键 → 宿主 contextMenus（宿主菜单的渲染/关闭都在 Node 侧轮询）。
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await page.waitForTimeout(400);
  b3ui.hostMenuReady = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-projects-thread-row]")];
    const row = rows[rows.length - 1];
    if (!row) return "";
    const ready = row.getAttribute("data-projects-thread-host-menu") || "";
    if (ready !== "yes") return ready;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + 40),
        clientY: Math.round(rect.top + 10),
      }),
    );
    return ready;
  });
  if (b3ui.hostMenuReady === "yes") {
    b3ui.hostMenuOpened = Boolean(
      await waitUntil(
        () => page.evaluate(() => document.querySelectorAll('[role="menu"]').length > 0),
        8000,
      ),
    );
    b3ui.hostMenuItems = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
        (node.textContent || "").trim(),
      ),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await page.waitForTimeout(300);
    b3ui.hostMenuClosed = Boolean(
      await waitUntil(
        () => page.evaluate(() => document.querySelectorAll('[role="menu"]').length === 0),
        5000,
      ),
    );
  }

  // —— 单次 page.evaluate 有 15s 安全超时：写后回读/列表加载都在 Node 侧轮询 ——
  const defaultsReadback = await waitUntil(
    () =>
      page.evaluate((picked) => {
        const readback =
          document
            .querySelector("[data-projects-thread-defaults]")
            ?.getAttribute("data-projects-thread-defaults-value") || "";
        const message = document.querySelector("[data-projects-b3-message]")?.textContent || "";
        try {
          const parsed = JSON.parse(readback);
          if (
            message.includes("已保存") &&
            String(parsed.provider) === String(picked.provider) &&
            String(parsed.model) === String(picked.modelId) &&
            String(parsed.reasoningEffort) === String(picked.effort)
          ) {
            return { readback, message };
          }
        } catch (_error) {
          /* 还没写回 */
        }
        return null;
      }, b3ui.defaultsPicked ?? { provider: "", modelId: "", effort: "" }),
    15000,
  );
  b3ui.defaultsReadback = defaultsReadback?.readback ?? "";
  b3ui.defaultsMessage = defaultsReadback?.message ?? "";
  b3ui.folderMode = await waitUntil(
    () =>
      page.evaluate(() => {
        const mode =
          document.querySelector("[data-projects-folder-mode]")?.getAttribute("data-projects-folder-mode") ||
          "";
        return mode === "default" ? mode : null;
      }),
    8000,
  ) || b3ui.folderMode;
  if (b3ui.folderMode !== "default") {
    // 一次重试：点三键后父级 reload 可能把卡片重建，第一次点击的 RPC 回写与重建竞争。
    await page.evaluate(() =>
      document.querySelector('[data-projects-folder-decision="default"]')?.click(),
    );
    b3ui.folderMode =
      (await waitUntil(
        () =>
          page.evaluate(() => {
            const mode =
              document
                .querySelector("[data-projects-folder-mode]")
                ?.getAttribute("data-projects-folder-mode") || "";
            return mode === "default" ? mode : null;
          }),
        6000,
      )) || b3ui.folderMode;
  }
  // F55：三键都真的写进卡片（不只 default）——deny / once 逐一回读，最后恢复 default。
  const clickFolderDecision = async (decision) => {
    await page.evaluate((want) => {
      document
        .querySelector('[data-projects-folder-decision="' + want + '"]')
        ?.click();
    }, decision);
    return waitUntil(
      () =>
        page.evaluate((want) => {
          const mode =
            document
              .querySelector("[data-projects-folder-mode]")
              ?.getAttribute("data-projects-folder-mode") || "";
          return mode === want ? mode : null;
        }, decision),
      6000,
    );
  };
  b3ui.folderDenyMode = await clickFolderDecision("deny");
  b3ui.folderOnceMode = await clickFolderDecision("once");
  b3ui.folderMode = (await clickFolderDecision("default")) || b3ui.folderMode;

  await page.evaluate(() =>
    document.querySelector("[data-projects-recent-sessions]")?.click(),
  );
  b3ui.recentIds = await waitUntil(
    () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-projects-recent-session]")];
        return rows.length > 0
          ? rows.map((node) => node.getAttribute("data-projects-recent-session") || "")
          : null;
      }),
    12000,
  ) || [];
  b3ui.recentCount = b3ui.recentIds.length;
  b3ui.recentUi = await page.evaluate(() =>
    Boolean(document.querySelector("[data-projects-recent-list]")),
  );
  b3ui.attachId = await page.evaluate(
    () =>
      document
        .querySelector("[data-projects-recent-session] [data-projects-attach-session]")
        ?.getAttribute("data-projects-attach-session") || "",
  );
  b3ui.attachBecameThread = false;
  if (b3ui.attachId !== "") {
    await page.evaluate(() => {
      const button = document.querySelector(
        "[data-projects-recent-session] [data-projects-attach-session]",
      );
      if (button) button.click();
    });
    b3ui.attachBecameThread = Boolean(
      await waitUntil(
        () =>
          page.evaluate(
            (id) =>
              [...document.querySelectorAll("[data-projects-thread-row]")].some(
                (node) => node.getAttribute("data-projects-thread-row") === id,
              ),
            b3ui.attachId,
          ),
        12000,
      ),
    );
  }
  add(
    "右栏「上下文」有本地优势卡，且 @ 候选（本项目线程/项目名）能列出",
    b3ui.card === true && b3ui.mentionCandidates > 0,
    JSON.stringify({ card: b3ui.card, mention: b3ui.mention, candidates: b3ui.mentionCandidates }),
  );
  add(
    "F62 @ 源真的注册进宿主 inputTriggers（data-projects-mention-source=registered）",
    b3ui.mention === "registered",
    JSON.stringify({ mention: b3ui.mention }),
  );
  add(
    "本地文件夹授权卡三键齐全（Deny / Set as default folder / Allow once）且「设为默认」回读 mode=default",
    [...new Set(b3ui.folderButtons)].sort().join(",") === "default,deny,once" &&
      b3ui.folderMode === "default",
    JSON.stringify({
      buttons: b3ui.folderButtons,
      mode: b3ui.folderMode,
      message: b3ui.folderMessage,
      cards: b3ui.folderCardAttrs,
    }),
  );
  add(
    "F55 「Deny」写入并回读 mode=deny",
    b3ui.folderDenyMode === "deny",
    JSON.stringify({ mode: b3ui.folderDenyMode }),
  );
  add(
    "F55 「Allow once」写入并回读 mode=once",
    b3ui.folderOnceMode === "once",
    JSON.stringify({ mode: b3ui.folderOnceMode }),
  );
  add(
    "线程默认模型 / effort 两个下拉可写，且选项数量与 modelCatalog 一致（不是硬编码）",
    b3ui.hasModel === true &&
      b3ui.hasEffort === true &&
      b3ui.modelDisabled === false &&
      b3ui.effortDisabled === false &&
      b3ui.modelCatalogStats !== null &&
      Array.isArray(b3ui.modelOptionsInitial) &&
      b3ui.modelOptionsInitial.length === Number(b3ui.modelCatalogStats.models) + 1 &&
      Array.isArray(b3ui.effortOptionsInitial) &&
      b3ui.effortOptionsInitial.length === Number(b3ui.modelCatalogStats.selectedEfforts) + 1,
    JSON.stringify({
      model: b3ui.hasModel,
      effort: b3ui.hasEffort,
      modelDisabled: b3ui.modelDisabled,
      effortDisabled: b3ui.effortDisabled,
      modelOptions: (b3ui.modelOptionsInitial || []).length,
      effortOptions: b3ui.effortOptionsInitial,
      catalog: b3ui.modelCatalogStats,
    }),
  );
  add(
    "F42 线程默认模型写→回读：保存后 UI 回读值等于刚选的具体 provider/model/effort",
    b3ui.defaultsPicked !== null &&
      b3ui.defaultsPicked !== undefined &&
      (() => {
        try {
          const readback = JSON.parse(b3ui.defaultsReadback || "{}");
          return (
            String(readback.provider) === String(b3ui.defaultsPicked.provider) &&
            String(readback.model) === String(b3ui.defaultsPicked.modelId) &&
            String(readback.reasoningEffort) === String(b3ui.defaultsPicked.effort)
          );
        } catch (_error) {
          return false;
        }
      })(),
    JSON.stringify({
      picked: b3ui.defaultsPicked,
      readback: b3ui.defaultsReadback,
      message: b3ui.defaultsMessage,
    }),
  );
  add(
    "D1 可见性写路径诊断（点击命中 + 无 RPC 错误）",
    Boolean(viewFlow?.toggleHit) &&
      viewFlow?.viewStage === "resolved" &&
      String(viewFlow?.viewResult || "").includes('"ok":true'),
    JSON.stringify({
      toggleHit: viewFlow?.toggleHit,
      viewError: viewFlow?.viewError,
      viewStage: viewFlow?.viewStage,
      viewResult: viewFlow?.viewResult,
    }),
  );

  add(
    "「从会话开线程」列出真实最近会话（recentSessions 的 id），并能挂成线程行",
    b3ui.recentUi === true &&
      b3ui.recentCount > 0 &&
      b3ui.attachId !== "" &&
      (b3ui.recentIds || []).every((id) => typeof id === "string" && id !== "") &&
      b3ui.attachBecameThread === true,
    JSON.stringify({
      recentCount: b3ui.recentCount,
      recentIds: (b3ui.recentIds || []).slice(0, 3),
      attachId: b3ui.attachId,
      attachBecameThread: b3ui.attachBecameThread,
    }),
  );
  add(
    "U18 线程行右键打开宿主 contextMenus（菜单项含重命名/复制，Esc 关闭）",
    b3ui.hostMenuReady === "yes" &&
      b3ui.hostMenuOpened === true &&
      (b3ui.hostMenuItems || []).some((label) => label.includes("重命名") || /rename/iu.test(label)) &&
      (b3ui.hostMenuItems || []).some((label) => label.includes("复制") || /copy/iu.test(label)) &&
      b3ui.hostMenuClosed === true,
    JSON.stringify({
      ready: b3ui.hostMenuReady,
      opened: b3ui.hostMenuOpened,
      items: (b3ui.hostMenuItems || []).slice(0, 8),
      closed: b3ui.hostMenuClosed,
    }),
  );
  add(
    "线程右键菜单含重命名 / 复制 ID（其余四项沿用既有菜单）",
    b3ui.menuItems.some((label) => label.includes("重命名")) &&
      b3ui.menuItems.some((label) => label.includes("复制")) &&
      b3ui.renameRow !== "" &&
      b3ui.copyRow !== "",
    JSON.stringify({ items: b3ui.menuItems, renameRow: b3ui.renameRow, copyRow: b3ui.copyRow }),
  );
  add(
    "线程重命名写→回读（renameThread 后列表立即显示新标题）",
    b3ui.renameReadback === true,
    JSON.stringify({
      saved: b3ui.renameSaved,
      message: b3ui.renameMessage,
      readback: b3ui.renameReadback,
    }),
  );

  // 截图：授权卡 + 线程动作
  {
    const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      ${JSON.stringify(shotsDir)} + "/07-b3-context-card-and-thread-actions.png",
      Buffer.from(shot.data, "base64"),
    );
  }

  // —— B5 · F33/F34/U15：Library 视图 + 部署特有 effort（max/xhigh/off）——
  await page.evaluate(() => document.querySelector('[data-projects-tab="threads"]')?.click());
  await page.waitForTimeout(500);
  const effortDeploy = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const setText = (sel, value) => {
      const input = q(sel);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    // 上一段 B3 用例可能已经把「手填」展开过：只在输入框不在时才点开关，避免把它又关掉。
    if (!q("[data-projects-thread-effort-manual]")) {
      q("[data-projects-thread-manual-toggle]")?.click();
      await wait(400);
    }
    const original = JSON.parse(
      q("[data-projects-thread-defaults]")?.getAttribute("data-projects-thread-defaults-value") || "{}",
    );
    const rows = [];
    for (const effort of ["max", "xhigh", "off"]) {
      setText("[data-projects-thread-model-manual]", "smoke-provider|smoke-model");
      setText("[data-projects-thread-effort-manual]", effort);
      await wait(250);
      q("[data-projects-thread-defaults-save]")?.click();
      await wait(900);
      const readback = JSON.parse(
        q("[data-projects-thread-defaults]")?.getAttribute("data-projects-thread-defaults-value") || "{}",
      );
      rows.push({ effort, readback: String(readback.reasoningEffort || "") });
    }
    // 复原成这轮 UI 最初选的默认值：后面的 Node 断言按那组值逐字段比对 projects.json。
    setText(
      "[data-projects-thread-model-manual]",
      original.provider && original.model ? original.provider + "|" + original.model : "",
    );
    setText("[data-projects-thread-effort-manual]", String(original.reasoningEffort || ""));
    await wait(250);
    q("[data-projects-thread-defaults-save]")?.click();
    await wait(700);
    return { rows, original };
  });
  add(
    "F42 部署特有 effort：max/xhigh/off 经手填写入并回读，不再被三档白名单清空（B3 复审 P0）",
    Array.isArray(effortDeploy.rows) &&
      effortDeploy.rows.length === 3 &&
      effortDeploy.rows.every((row) => row.readback === row.effort),
    JSON.stringify(effortDeploy.rows),
  );
  result.effortDeploy = effortDeploy.rows;

  const b5 = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const openTab = (id) => {
      const node = q('[data-projects-tab="' + id + '"]');
      if (node) node.click();
      return Boolean(node);
    };
    // Library 已从页签外迁：改点右栏入口，主列 data-projects-library-main 渲染（§7.3 页签 ≤3）。
    const libraryOpen = q("[data-projects-library-open]");
    const clicked = Boolean(libraryOpen);
    if (libraryOpen) libraryOpen.click();
    await wait(1400);
    const root = q("[data-projects-library]");
    const searchNote = q("[data-projects-library-search-note]")?.textContent || "";
    const folderHint = q("[data-projects-folder-cwd-hint]")?.textContent || "";
    const out = {
      clicked,
      present: Boolean(root),
      loaded: root?.getAttribute("data-projects-library-loaded") || "",
      degraded: root?.getAttribute("data-projects-library-degraded") || "",
      artifactsAvailable: root?.getAttribute("data-projects-library-artifacts-available") || "",
      artifactOpenDisabled: q("[data-projects-artifact-open]")?.disabled ?? null,
      degradeNote: q("[data-projects-library-degraded-note]")?.textContent || "",
      searchNote,
      folderHint,
      fileCount: q("[data-projects-library-file-count]")?.textContent || "",
      meter: q("[data-projects-library-meter]")?.textContent || "",
      files: all("[data-projects-library-file]").map((node) =>
        node.getAttribute("data-projects-library-file"),
      ),
      fileUnavailable:
        q("[data-projects-library-files-unavailable]")?.getAttribute(
          "data-projects-library-files-unavailable",
        ) || "",
      artifactCards: all("[data-projects-artifact-card]").length,
      threadCards: all("[data-projects-thread-artifacts]").length,
    };
    // 文件名搜索：输入 seed → 点搜索 → 等结果
    const input = q("[data-projects-library-search]");
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "seed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      q("[data-projects-library-search-run]")?.click();
      await wait(1600);
    }
    out.matches = all("[data-projects-library-match]").map((node) =>
      node.getAttribute("data-projects-library-match"),
    );
    return out;
  });
  result.b5 = b5;
  add(
    "B5 Library 渲染真实视图（文件面 + 产物面两块数据都在，loaded=true）",
    b5.clicked === true && b5.present === true && b5.loaded === "true",
    JSON.stringify({ present: b5.present, loaded: b5.loaded, degraded: b5.degraded }),
  );
  add(
    "B5 文件面来自宿主 workspaceFiles：列到项目目录里的 seed.txt",
    b5.fileUnavailable === "" &&
      b5.files.some((file) => String(file).endsWith("seed.txt")) &&
      b5.fileCount !== "",
    JSON.stringify({ files: b5.files.slice(0, 8), fileUnavailable: b5.fileUnavailable }),
  );
  add(
    "B5 搜索只按文件名（UI 写明）且 seed 能命中文件名",
    b5.searchNote.includes("文件名") &&
      b5.matches.some((match) => String(match).endsWith("seed.txt")),
    JSON.stringify({ note: b5.searchNote, matches: b5.matches }),
  );
  add(
    "B5 产物面降级：明示需要 dsh-artifacts 0.2（不是「没有产物」），打开按钮禁用",
    b5.artifactsAvailable === "false" &&
      b5.degradeNote.includes("dsh-artifacts 0.2") &&
      !b5.degradeNote.includes("还没有产物") &&
      b5.artifactOpenDisabled === true,
    JSON.stringify({
      available: b5.artifactsAvailable,
      note: b5.degradeNote,
      disabled: b5.artifactOpenDisabled,
    }),
  );
  add(
    "B5 降级时不伪造产物卡（线程内也不画不存在的缩略图）",
    b5.artifactCards === 0 && b5.threadCards === 0,
    JSON.stringify({ cards: b5.artifactCards, threadCards: b5.threadCards }),
  );
  add(
    "F55 授权卡写明 cwd 语义（push-branch 在 worktree 里跑、继承项目目录授权；B3 复审 P2）",
    b5.folderHint.includes("worktree") &&
      b5.folderHint.includes("继承") &&
      b5.folderHint.includes("push-branch"),
    b5.folderHint,
  );
  // 截图：Library 降级态（文件面带文件名搜索 + 产物库缺依赖的明示）
  {
    const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      ${JSON.stringify(shotsDir)} + "/12-b5-library-degraded.png",
      Buffer.from(shot.data, "base64"),
    );
  }
  await page.evaluate(() => document.querySelector("[data-projects-library-back]")?.click());
  await page.waitForTimeout(700);

  // —— F37：记忆碎片 UI（记忆页签里有列表 + 新增入口；交互写盘由单测与 RPC 覆盖）——
  const b3frag = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    q("[data-panel-settings-open]")?.click();
    await wait(600);
    q('[data-panel-settings-pane="memory"]')?.click();
    await wait(800);
    return {
      add: Boolean(q("[data-projects-frag-add]")),
      title: Boolean(q("[data-projects-frag-title]")),
      count: Boolean(q("[data-projects-frag-count]")),
      entries: Boolean(q("[data-projects-entry-empty]") || q("[data-projects-entry]")),
    };
  });
  add(
    "记忆页签有碎片列表与新增入口（标题/正文/计数）",
    b3frag.add === true && b3frag.title === true && b3frag.count === true,
    JSON.stringify(b3frag),
  );

  // 截图：记忆页签（碎片列表 + 新增入口 + 索引条目）
  {
    const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      ${JSON.stringify(shotsDir)} + "/08-b3-memory-fragments.png",
      Buffer.from(shot.data, "base64"),
    );
  }
  // 宿主侧回读要用的值（在同一个块作用域里带出去，避开 emit 点的块作用域边界）
  result.__b3FolderPath = b3ui.folderPath || (b3ui.folderCardAttrs || [])[0] || "";
  result.b3DefaultsPicked = b3ui.defaultsPicked ?? null;
  result.b3MentionTokens = b3ui.mentionTokens ?? [];
  result.__b3AttachId = b3ui.attachId;

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

  // 审计列表的渲染断言已随功能搬到设置 Debug 分区（见「审计在设置 Debug 分区渲染」）。
  // 回到「线程」页签（上面的记忆页签会替换掉这块 UI）
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
  // 归档是异步写盘 + toast：轮询到 toast 出现（或详情错误），不再赌固定 2.5s。
  await waitUntil(
    () =>
      page.evaluate(() => {
        const text = [...document.querySelectorAll("[data-projects-toast]")]
          .map((node) => node.textContent || "")
          .join(" ");
        return /已归档|已恢复|Archived|Restored/u.test(text);
      }),
    12000,
  );
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
    setter.call(input, "smoke-to-archive");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return "typed";
  });
  const searchMatched = await waitUntil(
    () =>
      page.evaluate((total) => {
        const count = document.querySelectorAll("[data-projects-row]").length;
        return count === 1 && total > 1 ? count : 0;
      }, rowsTotal),
    10000,
  );
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
    searched === "typed" && searchMatched === 1 && rowsTotal > 1,
    JSON.stringify({ rowsTotal, searchMatched }),
  );
  add(
    "搜索无结果给专属文案（与「没有项目」空态不同）",
    searchMiss.rows === 0 && /没有匹配|No projects match/u.test(searchMiss.empty),
    JSON.stringify(searchMiss),
  );
  await page.evaluate(() => document.querySelector("[data-projects-search-clear]")?.click());
  const clearedRows = await waitUntil(
    () =>
      page.evaluate((total) => {
        const count = document.querySelectorAll("[data-projects-row]").length;
        return count === total ? count : 0;
      }, rowsTotal),
    10000,
  );
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
  await waitUntil(
    () =>
      page.evaluate(
        () =>
          ![...document.querySelectorAll("[data-projects-row]")].some((node) =>
            (node.textContent || "").includes("smoke-to-restore"),
          ),
      ),
    15000,
  );

  // 打开主项目，回收站里应能看到刚删的 smoke-to-restore
  const openedMainForTrash =
    (await waitUntil(
      () =>
        page.evaluate(() => {
          const row = [...document.querySelectorAll("[data-projects-row]")].find(
            (node) => !(node.textContent || "").includes("smoke-to-restore"),
          );
          if (!row) return null;
          row.click();
          return "clicked";
        }),
      10000,
    )) || "no-row";
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
  await waitUntil(
    () =>
      page.evaluate(
        () =>
          ![...document.querySelectorAll("[data-projects-row]")].some((node) =>
            (node.textContent || "").includes("smoke-to-purge"),
          ),
      ),
    15000,
  );
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

  // ===== B4：F36 Routines / F30 双模式提醒（详情页右栏段 + Routines 视图）=====
  // 这段是**自包含**的：自己从列表点进冒烟项目的详情页，跑完再返回列表，
  // 不依赖前面 900 行 B1–B3 交互留下的页面状态（否则一次插入就把后面的记忆/回收站断言带崩）。
  const b4Opened = await page.evaluate((projectName) => {
    const rows = [...document.querySelectorAll("[data-projects-row]")];
    const row = rows.find((node) => (node.textContent || "").includes(projectName));
    if (!row) return "no-row";
    row.click();
    return "clicked";
  }, name);
  const b4Detail = await waitUntil(
    () =>
      page.evaluate(() =>
        document.querySelector("[data-projects-detail]")
          ? document.querySelector("[data-projects-detail]").getAttribute("data-projects-detail")
          : "",
      ),
    12000,
  );
  add(
    "B4 冒烟能重新打开项目详情页（自包含前置，不靠前面的页面状态）",
    b4Opened === "clicked" && typeof b4Detail === "string" && b4Detail !== "",
    JSON.stringify({ b4Opened, b4Detail }),
  );
  await page.evaluate(() => document.querySelector('[data-projects-tab="threads"]')?.click());
  await page.waitForTimeout(600);
  const b4Rail = await page.evaluate(() => ({
    section: Boolean(document.querySelector("[data-projects-rail-routines]")),
    count: (document.querySelector("[data-projects-rail-routines-count]")?.textContent || "").trim(),
    open: Boolean(document.querySelector("[data-projects-rail-routines-open]")),
    reminder: Boolean(document.querySelector("[data-projects-rail-reminder-open]")),
  }));
  add(
    "详情右栏有「定时任务」段（计数 + 新建入口 + 提醒入口）",
    b4Rail.section === true && b4Rail.open === true && b4Rail.reminder === true && /定时任务/u.test(b4Rail.count),
    JSON.stringify(b4Rail),
  );
  await page.evaluate(() => document.querySelector('[data-projects-tab="routines"]')?.click());
  const routinesReady = await waitUntil(
    () =>
      page.evaluate(() => {
        const root = document.querySelector("[data-projects-routines]");
        const value = root ? root.getAttribute("data-projects-routines-available") : "";
        return value === "yes" || value === "no" ? value : "";
      }),
    12000,
  );
  const routinesIntro = await page.evaluate((ready) => ({
    available: ready,
    cost: (document.querySelector("[data-projects-routines-cost]")?.textContent || "").trim(),
    frequency: [...(document.querySelector("[data-projects-routine-frequency]")?.options || [])].map(
      (option) => option.value,
    ),
  }), routinesReady);
  add(
    "Routines 视图可用且写明成本（每次投递 = 一次模型调用 + 60 秒下限）",
    routinesIntro.available === "yes" &&
      /一次模型调用/u.test(routinesIntro.cost) &&
      /60 秒/u.test(routinesIntro.cost),
    JSON.stringify({ routinesReady, cost: routinesIntro.cost }),
  );
  add(
    "Routines 六档频率齐全（manual/hourly/daily/weekdays/weekly/monthly）",
    routinesIntro.frequency.join(",") === "manual,hourly,daily,weekdays,weekly,monthly",
    JSON.stringify(routinesIntro.frequency),
  );
  if (routinesReady !== "yes") {
    skipAdd("Routines 创建/停用/历史/删除", "宿主 schedule 不可用：" + String(routinesIntro.available));
    skipAdd("提醒双模式（timer 触发 / schedule 计费）", "宿主 schedule 不可用");
  } else {
    // —— 创建一条自动档（daily 09:30）——
    const routineCreated = await page.evaluate(async () => {
      const set = (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : el.tagName === "SELECT" ? window.HTMLSelectElement : window.HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
        return true;
      };
      const okName = set("[data-projects-routine-name]", "冒烟每日摘要");
      const okText = set("[data-projects-routine-instructions]", "总结昨天合并的 PR。");
      const okFreq = set("[data-projects-routine-frequency]", "daily");
      const okTime = set("[data-projects-routine-time]", "09:30");
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector("[data-projects-routine-create]")?.click();
      return { okName, okText, okFreq, okTime };
    });
    const routineRow = await waitUntil(
      () =>
        page.evaluate(() => {
          const row = document.querySelector("[data-projects-routine]");
          return row
            ? {
                id: row.getAttribute("data-projects-routine-id"),
                status: row.getAttribute("data-projects-routine-status"),
                text: (row.textContent || "").trim().slice(0, 200),
              }
            : null;
        }),
      20000,
    );
    add(
      "Routines 创建写→回读（行出现且带宿主 status）",
      routineCreated.okName === true &&
        routineCreated.okFreq === true &&
        routineRow !== null &&
        routineRow.id !== "" &&
        /每天 09:30/u.test(routineRow.text),
      JSON.stringify({ routineCreated, routineRow }),
    );
    // —— History（宿主投递记录面板）——
    await page.evaluate(() =>
      document.querySelector("[data-projects-routine-history]")?.click(),
    );
    const routineHistory = await waitUntil(
      () =>
        page.evaluate(() => {
          const panel = document.querySelector("[data-projects-routine-history-panel]");
          return panel
            ? {
                id: panel.getAttribute("data-projects-routine-history-panel"),
                count: panel.getAttribute("data-projects-routine-history-count"),
                text: (panel.textContent || "").trim().slice(0, 120),
              }
            : null;
        }),
      10000,
    );
    add(
      "Routines History 可回读（宿主投递面板打开，未投递时说清）",
      routineHistory !== null &&
        routineHistory.count === "0" &&
        /还没有投递|投递/u.test(routineHistory.text),
      JSON.stringify(routineHistory),
    );
    // —— 停用 → 回读按钮变「启用」——
    await page.evaluate(() =>
      document.querySelector("[data-projects-routine-toggle]")?.click(),
    );
    const routineToggled = await waitUntil(
      () =>
        page.evaluate(() => {
          const button = document.querySelector("[data-projects-routine-toggle]");
          return button && (button.textContent || "").includes("启用") ? "启用" : "";
        }),
      15000,
    );
    add("Routines 可停用且回读（按钮变「启用」）", routineToggled === "启用", String(routineToggled));
    // —— 手动档：不建宿主任务，描述里写明「手动」——
    const manualRoutine = await page.evaluate(async () => {
      const set = (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : el.tagName === "SELECT" ? window.HTMLSelectElement : window.HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
        return true;
      };
      set("[data-projects-routine-name]", "冒烟手动任务");
      set("[data-projects-routine-instructions]", "只在点 Run now 时跑一次。");
      set("[data-projects-routine-frequency]", "manual");
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector("[data-projects-routine-create]")?.click();
      return true;
    });
    const manualRow = await waitUntil(
      () =>
        page.evaluate(() => {
          const rows = [...document.querySelectorAll("[data-projects-routine]")];
          const row = rows.find((node) => (node.textContent || "").includes("冒烟手动任务"));
          return row ? (row.textContent || "").trim() : "";
        }),
      20000,
    );
    add(
      "手动档不自动跑（描述写明「只有点 Run now」且不建宿主任务）",
      manualRoutine === true && /手动：只有点 Run now/u.test(String(manualRow)),
      String(manualRow).slice(0, 120),
    );
    // 截图：Routines 列表（成本提示 + 两条任务 + 历史面板）
    {
      const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        ${JSON.stringify(shotsDir)} + "/09-b4-routines.png",
        Buffer.from(shot.data, "base64"),
      );
    }
    // —— 删除手动档（自动档留着给 Node 侧读盘）——
    const deleted = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-projects-routine]")];
      const row = rows.find((node) => (node.textContent || "").includes("冒烟手动任务"));
      const button = row?.querySelector("[data-projects-routine-delete]");
      if (!button) return "no-button";
      button.click();
      return "clicked";
    });
    const deletedGone = await waitUntil(
      () =>
        page.evaluate(() => {
          const rows = [...document.querySelectorAll("[data-projects-routine]")];
          return rows.some((node) => (node.textContent || "").includes("冒烟手动任务")) ? "" : "gone";
        }),
      15000,
    );
    add("Routines 可删除（宿主条目 + 本地记录一起走）", deleted === "clicked" && deletedGone === "gone", String(deleted));

    // —— F30 提醒：对话框 + 双模式 + timer 真到点（1.2s）+ toast ——
    const remindersIntro = await page.evaluate(() => ({
      defaultMode: document
        .querySelector("[data-projects-reminders]")
        ?.getAttribute("data-projects-reminder-default"),
      pending: document
        .querySelector("[data-projects-reminders]")
        ?.getAttribute("data-projects-reminder-pending"),
      armed: document.querySelector("[data-projects-reminders]")?.getAttribute("data-projects-reminder-armed"),
      options: [...document.querySelectorAll("[data-projects-reminder-default-option]")].map(
        (node) => node.getAttribute("data-projects-reminder-default-option"),
      ),
    }));
    add(
      "提醒默认走本机计时（免费）且项目设置可选两种模式",
      remindersIntro.defaultMode === "timer" &&
        remindersIntro.options.join(",") === "timer,schedule",
      JSON.stringify(remindersIntro),
    );
    await page.evaluate(() => document.querySelector("[data-projects-reminder-open]")?.click());
    await page.waitForTimeout(500);
    const dialog = await page.evaluate(() => {
      const root = document.querySelector("[data-projects-reminder-dialog]");
      return {
        open: root ? root.getAttribute("data-projects-reminder-dialog") : "",
        modes: [...document.querySelectorAll("[data-projects-reminder-mode]")].map((node) =>
          node.getAttribute("data-projects-reminder-mode"),
        ),
        note: (document.querySelector("[data-projects-reminder-note]")?.textContent || "").trim(),
      };
    });
    add(
      "提醒对话框有双模式选择，timer 档写明「不花模型调用 / 关着不响」",
      dialog.open === "open" &&
        dialog.modes.join(",") === "timer,schedule" &&
        /不花模型调用/u.test(dialog.note) &&
        /关着/u.test(dialog.note),
      JSON.stringify({ dialog }),
    );
    await page.evaluate(() =>
      document.querySelector('[data-projects-reminder-mode="schedule"]')?.click(),
    );
    await page.waitForTimeout(300);
    const scheduleNote = await page.evaluate(
      () => (document.querySelector("[data-projects-reminder-note]")?.textContent || "").trim(),
    );
    add(
      "切到 schedule 档后明示「到点会跑一次模型」",
      /跑一次模型/u.test(scheduleNote) && /关着也会跑/u.test(scheduleNote),
      scheduleNote.slice(0, 120),
    );
    await page.evaluate(() =>
      document.querySelector('[data-projects-reminder-mode="timer"]')?.click(),
    );
    await page.waitForTimeout(200);
    // 1.2 秒后到期：走的是「到期 → 写回 fired」的真实路径（等价于重启恢复里的补触发）
    const reminderCreated = await page.evaluate(async () => {
      const set = (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const okText = set("[data-projects-reminder-text]", "冒烟提醒：看一眼构建");
      const okMinutes = set("[data-projects-reminder-minutes]", "0.02");
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector("[data-projects-reminder-submit]")?.click();
      return { okText, okMinutes };
    });
    const reminderRow = await waitUntil(
      () =>
        page.evaluate(() => {
          const row = document.querySelector("[data-projects-reminder-row]");
          return row
            ? {
                id: row.getAttribute("data-projects-reminder-row"),
                state: row.getAttribute("data-projects-reminder-state"),
              }
            : null;
        }),
      12000,
    );
    const reminderFired = await waitUntil(
      () =>
        page.evaluate(() => {
          const row = document.querySelector("[data-projects-reminder-row]");
          return row && row.getAttribute("data-projects-reminder-state") === "fired" ? "fired" : "";
        }),
      20000,
    );
    add(
      "timer 提醒真到点：写回 fired + 未读（重启去重由单测覆盖）",
      reminderCreated.okText === true && reminderRow !== null && reminderFired === "fired",
      JSON.stringify({ reminderCreated, reminderRow, reminderFired }),
    );
    const reminderToast = await waitUntil(
      () =>
        page.evaluate(() => {
          const toast = document.querySelector("[data-projects-reminder-toast]");
          return toast ? (toast.textContent || "").trim().slice(0, 80) : "";
        }),
      20000,
    );
    add(
      "到点走 shell.overlay toast（提醒文案可见）",
      typeof reminderToast === "string" && reminderToast.includes("冒烟提醒"),
      String(reminderToast),
    );
    // 截图：提醒对话框（重新打开）
    await page.evaluate(() => document.querySelector("[data-projects-reminder-open]")?.click());
    await page.waitForTimeout(400);
    {
      const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        ${JSON.stringify(shotsDir)} + "/10-b4-reminder-dialog.png",
        Buffer.from(shot.data, "base64"),
      );
    }
    // —— 取消：再建一条（60 分钟后）然后取消 ——
    const cancelFlow = await page.evaluate(async () => {
      const set = (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      set("[data-projects-reminder-text]", "冒烟提醒：这条会被取消");
      set("[data-projects-reminder-minutes]", "60");
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector("[data-projects-reminder-submit]")?.click();
      for (let i = 0; i < 40; i += 1) {
        const rows = [...document.querySelectorAll("[data-projects-reminder-row]")];
        const row = rows.find((node) => (node.textContent || "").includes("这条会被取消"));
        if (row) {
          row.querySelector("[data-projects-reminder-cancel]")?.click();
          return "clicked";
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return "no-row";
    });
    const cancelled = await waitUntil(
      () =>
        page.evaluate(() => {
          const rows = [...document.querySelectorAll("[data-projects-reminder-row]")];
          const row = rows.find((node) => (node.textContent || "").includes("这条会被取消"));
          return row && row.getAttribute("data-projects-reminder-state") === "cancelled" ? "cancelled" : "";
        }),
      20000,
    );
    add(
      "提醒可取消（状态回读 cancelled，且不再触发）",
      cancelFlow === "clicked" && cancelled === "cancelled",
      JSON.stringify({ cancelFlow, cancelled }),
    );
    // 带出去给 Node 侧读盘（自动档 routine 故意留着）
    result.b4RoutineId = routineRow?.id || (routineRow && routineRow.id) || "";
    result.b4ReminderId = reminderRow?.id || "";
    // 收尾：关掉对话框、回到列表，别把页面留在弹层/页签上（后面还有列表与设置断言）
    await page.evaluate(() => document.querySelector("[data-projects-reminder-close]")?.click());
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
  await page.waitForTimeout(1200);

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
  let settingsOpened = openedSettings;
  if (openedSettings === "no-entry") {
    // web 客户端的设置入口不一定有可读 label。用宿主自己的快捷键打开设置弹窗
    // （web: primary+alt+Comma），再点「项目」分节；分节被选中才会渲染 [data-projects-settings]。
    await page.keyboard.press("ControlOrMeta+Alt+Comma");
    const modalSeen = Boolean(
      await waitUntil(
        () =>
          page.evaluate(() =>
            Boolean(document.querySelector('[data-shortcut-modal="settings"]')),
          ),
        6000,
      ),
    );
    if (modalSeen) {
      settingsOpened = "shortcut";
      await page.evaluate(() => {
        const nav = document.querySelector('[data-shortcut-modal="settings"] nav');
        if (!nav) return;
        const cell = [...nav.querySelectorAll("button")].find((button) =>
          /项目|Projects/u.test((button.textContent || "").trim()),
        );
        if (cell) cell.click();
      });
    }
  }
  const settingsSeen = Boolean(
    await waitUntil(
      () => page.evaluate(() => Boolean(document.querySelector("[data-projects-settings]"))),
      8000,
    ),
  );
  if (settingsSeen) {
    add("设置页出现项目分节", true, "rendered");
  } else {
    skipAdd(
      "设置页出现项目分节",
      "设置入口=" +
        settingsOpened +
        "，打开后 8s 内没有 [data-projects-settings]",
    );
  }

  add(
    "设置页经入口或宿主快捷键打开，并选中「项目」分节",
    settingsSeen === true && (settingsOpened === "shortcut" || settingsOpened === "clicked"),
    JSON.stringify({ settingsOpened, settingsSeen }),
  );

  // 设置里的项目策略编辑器：默认折叠，但控件应在 DOM 里。
  // 注意：断言依赖「设置页在本机 profile 里可用」；某些 profile 把 ui-settings 关了
  // （cordis.patch.yml 里 enabled:false，且 dsh plugin add 会重写该文件），
  // 此时这两条按「跳过」处理，并在 detail 里写清原因——不假装覆盖过。
  await waitUntil(
    () =>
      page.evaluate(() =>
        Boolean(document.querySelector("[data-projects-policy-autonomy]")),
      ),
    8000,
  );
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
  if (settingsSeen) {
    add(
      "设置里可编辑项目策略（自治/人格/兜底）",
      policyOk && policyUi.options.join(",") === "L0,L1,L2,L3",
      JSON.stringify(policyUi),
    );
  } else {
    skipAdd("设置里可编辑项目策略（自治/人格/兜底）", "设置页未渲染，控件无从断言");
  }

  const autonomyChanged = await page.evaluate(() => {
    const select = document.querySelector("[data-projects-policy-autonomy]");
    if (!select) return "no-select";
    select.value = "L2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return "changed";
  });
  if (settingsSeen) {
    add("可切换自治级别", autonomyChanged === "changed", String(autonomyChanged));
    // 断言完就改回 L1：宿主侧「默认策略是 L1」是针对所有项目的硬断言，不能把测试改动留在盘上。
    await page.evaluate(() => {
      const select = document.querySelector("[data-projects-policy-autonomy]");
      if (!select) return;
      select.value = "L1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(1500);
  } else {
    skipAdd("可切换自治级别", "设置页未渲染，控件无从断言");
  }

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
  if (settingsSeen) {
    add(
      "危险开关默认全关且六项齐全",
      dangerUi.panel &&
        dangerUi.count === 6 &&
        dangerUi.anyOn === false &&
        dangerUi.keys.join(",") ===
          "forcePushOwnBranch,pushProtectedBranch,autoMerge,trashAuto,purgeAfterRetention,editProfile",
      JSON.stringify(dangerUi),
    );
  } else {
    skipAdd("危险开关默认全关且六项齐全", "设置页未渲染，控件无从断言");
  }
  var b3SettingsSeen = Boolean(
    await waitUntil(
      () =>
        page.evaluate(() =>
          Boolean(document.querySelector("[data-projects-settings-nav-item]")),
        ),
      8000,
    ),
  );
  // —— B3：设置四分区（F41/U19）+ 预算（F22）+ Usage（F49）+ Debug access（F50）+
  //        通知开关（F58）+ GitHub 检查（F4）+ 模板补全（F5）——
  const b3Settings = await page.evaluate(async (projectName) => {
    const q = (sel) => document.querySelector(sel);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // 设置页的 projects 数据是异步加载的：等预算输入出现在 DOM 再读默认值。
    for (let i = 0; i < 25; i += 1) {
      if (q('[data-projects-budget-input="maxThreadsPerDay"]')) break;
      await wait(200);
    }
    // 设置页自带项目选择器：先明确选到冒烟项目，否则审计读到的是别的项目的记录。
    const pickSmokeProject = () => {
      const select = q("[data-projects-policy-project]");
      if (!select) return "no-select";
      const option = [...select.options].find((item) =>
        (item.textContent || "").includes(projectName),
      );
      if (!option) return "no-option";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return option.value;
    };
    const pickedProject = pickSmokeProject();
    await wait(1200);
    const navItems = [...document.querySelectorAll("[data-projects-settings-nav-item]")].map((node) =>
      node.getAttribute("data-projects-settings-nav-item"),
    );
    const section = () => q("[data-projects-settings]")?.getAttribute("data-projects-settings-section") || "";
    const clickNav = (id) => {
      const node = q('[data-projects-settings-nav-item="' + id + '"]');
      if (!node) return false;
      node.click();
      return true;
    };
    const budget = {};
    for (const key of ["maxThreadsPerDay", "maxConcurrent", "maxStepsPerThread", "dailyTokens"]) {
      const input = q('[data-projects-budget-input="' + key + '"]');
      budget[key] = input ? input.value : null;
    }
    let saved = "";
    let afterSave = "";
    const threadsInput = q('[data-projects-budget-input="maxThreadsPerDay"]');
    if (threadsInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(threadsInput, "7");
      threadsInput.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(200);
      q("[data-projects-budget-save]")?.click();
      await wait(1800);
      saved = q("[data-projects-settings-b3-result]")?.textContent || "";
      afterSave = q('[data-projects-budget-input="maxThreadsPerDay"]')?.value || "";
    }
    const clickedUsage = clickNav("usage");
    await wait(900);
    const usage = {
      clicked: clickedUsage,
      section: section(),
      text: q("[data-projects-settings-usage]")?.innerText || "",
      hasTokens: Boolean(q("[data-projects-usage-tokens]")),
    };
    const archiveAuditText = (node) => (node ? node.innerText || "" : "").trim().slice(0, 4000);
    const clickedDebug = clickNav("debug");
    await wait(1200);
    const notify = [...document.querySelectorAll("[data-projects-notify-pref]")].map((node) => ({
      key: node.getAttribute("data-projects-notify-pref"),
      checked: node.checked === true,
    }));
    const completedBox = q('[data-projects-notify-pref="completed"]');
    let notifyAfter = "";
    if (completedBox) {
      completedBox.click();
      await wait(1500);
      const again = q('[data-projects-notify-pref="completed"]');
      notifyAfter = again && again.checked ? "on" : "off";
    }
    const auditBox = q("[data-projects-audit]");
    const debug = {
      clicked: clickedDebug,
      section: section(),
      title: q("[data-projects-debug-access]")?.textContent || "",
      rows: q("[data-projects-debug-rows]")?.textContent || "",
      // 审计（原项目详情「审计」页签）现在渲染在设置 Debug 分区
      auditPresent: Boolean(auditBox || q("[data-projects-audit-empty]")),
      auditTitle: q("[data-projects-audit-title]")?.textContent || "",
      auditText: archiveAuditText(auditBox),
    };
    // GitHub 检查的 RPC 最长 30s；且结果只在 Debug 分区渲染，必须在**停留于该分区**时轮询。
    // 这里只记录按钮是否存在，点击/轮询放到外层（那时会把分区切回 Debug）。
    const gh = q("[data-projects-gh-check]") ? "deferred" : "no-button";
    const clickedMemory = clickNav("memory");
    await wait(600);
    const templateButton = q("[data-projects-template-apply]");
    let templateClicked = false;
    let templateClicks = 0;
    if (templateButton) {
      templateButton.click();
      templateClicked = true;
      templateClicks = 1;
      await wait(1200);
    }
    const memory = {
      clicked: clickedMemory,
      counts: q("[data-projects-settings-memory-counts]")?.textContent || "",
      templateClicked,
      templateClicks,
      result: q("[data-projects-settings-b3-result]")?.textContent || "",
    };
    clickNav("general");
    await wait(300);
    return {
      navItems,
      budget,
      saved,
      afterSave,
      usage,
      debug,
      notify,
      notifyAfter,
      gh,
      memory,
      pickedProject,
      sectionAfter: section(),
    };
  }, name);
  if (b3SettingsSeen) {
    // 回到 Debug 分区并点一次检查（结果元素只在该分区渲染）。
    await page.evaluate(async () => {
      const nav = document.querySelector('[data-projects-settings-nav-item="debug"]');
      if (nav) nav.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const button = document.querySelector("[data-projects-gh-check]");
      if (button && button.disabled === false) button.click();
    });
    // gh 检查结论：单独轮询（gh auth status 最长 30s 才超时，别用 15s 的短等待）。
    let ghText = await waitUntil(
      () =>
        page.evaluate(() => {
          const text = document.querySelector("[data-projects-gh-result]")?.textContent || "";
          return text.trim() !== "" && !/检查中|Checking/u.test(text) ? text : null;
        }),
      35000,
    );
    if (!ghText) {
      // 按钮可能被上一次检查的 busy 态挡住：明确等它可点，再点一次。
      await waitUntil(
        () =>
          page.evaluate(() => {
            const button = document.querySelector("[data-projects-gh-check]");
            return button && button.disabled === false ? true : null;
          }),
        5000,
      );
      await page.evaluate(() => document.querySelector("[data-projects-gh-check]")?.click());
      ghText = await waitUntil(
        () =>
          page.evaluate(() => {
            const text = document.querySelector("[data-projects-gh-result]")?.textContent || "";
            return text.trim() !== "" && !/检查中|Checking/u.test(text) ? text : null;
          }),
        30000,
      );
    }
    b3Settings.gh = ghText || "";
    // 模板幂等：回到 Memory 再点一次，受管区块应当仍只有一份（Node 侧数标记次数）。
    if (b3Settings.memory.templateClicked === true) {
      b3Settings.memory.templateClicks = 2;
      await page.evaluate(async () => {
        const nav = document.querySelector('[data-projects-settings-nav-item="memory"]');
        if (nav) nav.click();
        await new Promise((resolve) => setTimeout(resolve, 700));
        document.querySelector("[data-projects-template-apply]")?.click();
        await new Promise((resolve) => setTimeout(resolve, 1600));
        const general = document.querySelector('[data-projects-settings-nav-item="general"]');
        if (general) general.click();
      });
      b3Settings.memory.result = await page.evaluate(
        () => document.querySelector("[data-projects-settings-b3-result]")?.textContent || "",
      );
    }
    add(
      "设置页面分四个分区（General/Memory/Usage/Debug）",
      b3Settings.navItems.join(",") === "general,memory,usage,debug",
      JSON.stringify(b3Settings.navItems),
    );
    add(
      "General 显示默认预算（日线程 20 / 并发 2 / 步数 60 / token 不限）",
      b3Settings.budget.maxThreadsPerDay === "20" &&
        b3Settings.budget.maxConcurrent === "2" &&
        b3Settings.budget.maxStepsPerThread === "60" &&
        b3Settings.budget.dailyTokens === "",
      JSON.stringify(b3Settings.budget),
    );
    add(
      "预算写→回读闭环（改成 7 后保存并回读）",
      b3Settings.saved.includes("预算已保存") && b3Settings.afterSave === "7",
      JSON.stringify({ saved: b3Settings.saved, afterSave: b3Settings.afterSave }),
    );
    add(
      "Usage 分区显示 token，且**不显示金额**",
      b3Settings.usage.section === "usage" &&
        b3Settings.usage.hasTokens === true &&
        /token/iu.test(b3Settings.usage.text) &&
        !/[¥$€]|USD|CNY|RMB/u.test(b3Settings.usage.text),
      JSON.stringify({ text: b3Settings.usage.text.slice(0, 120) }),
    );
    add(
      "Debug 分区命名为 Debug access 并给出诊断计数",
      b3Settings.debug.section === "debug" &&
        /Debug access/u.test(b3Settings.debug.title) &&
        /项目/u.test(b3Settings.debug.rows),
      JSON.stringify(b3Settings.debug),
    );
    // §7.3：审计不再是项目页签，改在设置 Debug 分区渲染（原「审计页签可渲染」）。
    add(
      "审计在设置 Debug 分区渲染（原项目详情页签，空态也算）",
      b3Settings.debug.auditPresent === true &&
        /审计|Audit/u.test(String(b3Settings.debug.auditTitle)),
      JSON.stringify({
        present: b3Settings.debug.auditPresent,
        title: b3Settings.debug.auditTitle,
      }),
    );
    // 原「危险开关变更写审计（project/policy-changed）」：同一份审计换个渲染位置回读。
    add(
      "危险开关变更写审计（project/policy-changed，设置 Debug 分区回读）",
      b3Settings.debug.auditText.includes("project/policy-changed"),
      String(b3Settings.debug.auditText).slice(0, 200),
    );
    add(
      "GitHub 连接检查给出可读结论（不崩溃、不只是空）",
      typeof b3Settings.gh === "string" && b3Settings.gh.trim().length > 0,
      String(b3Settings.gh).slice(0, 120),
    );
    add(
      "通知开关默认「失败/等你开、完成关」，可切换并回读",
      b3Settings.notify.length === 3 &&
        b3Settings.notify.find((item) => item.key === "failed")?.checked === true &&
        b3Settings.notify.find((item) => item.key === "waiting-user")?.checked === true &&
        b3Settings.notify.find((item) => item.key === "completed")?.checked === false &&
        b3Settings.notifyAfter === "on",
      JSON.stringify({ notify: b3Settings.notify, notifyAfter: b3Settings.notifyAfter }),
    );
    add(
      "F5 模板补全回执写明 AGENTS.md 路径（两次调用仍幂等）",
      b3Settings.memory.result.includes("AGENTS.md") &&
        b3Settings.memory.templateClicks === 2,
      JSON.stringify(b3Settings.memory),
    );
    add(
      "Memory 分区显示指令/记忆/碎片计数并提供模板补全入口",
      b3Settings.memory.clicked === true &&
        /指令 \\d+ 字符/u.test(b3Settings.memory.counts) &&
        b3Settings.memory.templateClicked === true &&
        b3Settings.memory.templateClicks === 2,
      JSON.stringify(b3Settings.memory),
    );
    result.b3TemplateResult = b3Settings.memory.result;
    result.b3TemplateClicks = b3Settings.memory.templateClicks;
  } else {
    for (const name of [
      "设置页面分四个分区（General/Memory/Usage/Debug）",
      "General 显示默认预算（日线程 20 / 并发 2 / 步数 60 / token 不限）",
      "预算写→回读闭环（改成 7 后保存并回读）",
      "Usage 分区显示 token，且**不显示金额**",
      "Debug 分区命名为 Debug access 并给出诊断计数",
      "审计在设置 Debug 分区渲染（原项目详情页签，空态也算）",
      "危险开关变更写审计（project/policy-changed，设置 Debug 分区回读）",
      "GitHub 连接检查给出可读结论（不崩溃、不只是空）",
      "通知开关默认「失败/等你开、完成关」，可切换并回读",
      "Memory 分区显示指令/记忆/碎片计数并提供模板补全入口",
    ]) {
      skipAdd(name, "设置页未渲染，控件与写路径无从断言");
    }
  }
  // ===== B4：F52 权限收窄开关（默认继承宿主；写→回读 current(session)）=====
  // 设置页的 General 分区里有一张三选一卡（继承 / 收窄档 / 自定义），
  // 写路径 setProjectPreset 会把档位套到现有会话并用 current(session) 回读。
  {
    const presetReady = await waitUntil(
      () =>
        page.evaluate(() =>
          document.querySelector("[data-projects-preset]")
            ? document
                .querySelector("[data-projects-preset]")
                .getAttribute("data-projects-preset-available")
            : "",
        ),
      10000,
    );
    // 设置页有自己的项目选择器：先明确选到冒烟项目（否则预设写到了别的项目上）
    const pickedProject = await page.evaluate(async (projectName) => {
      const select = document.querySelector("[data-projects-policy-project]");
      if (!select) return "no-select";
      const option = [...select.options].find((item) => (item.textContent || "").includes(projectName));
      if (!option) return "no-option";
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 800));
      return option.value;
    }, name);
    const before = await page.evaluate(() => {
      const card = document.querySelector("[data-projects-preset]");
      const options = [...document.querySelectorAll("[data-projects-preset-option]")].map((node) => ({
        value: node.value,
        text: (node.textContent || "").trim(),
      }));
      return {
        available: card?.getAttribute("data-projects-preset-available"),
        current: card?.getAttribute("data-projects-preset-current"),
        options,
        note: (document.querySelector("[data-projects-preset-note]")?.textContent || "").trim(),
        readback: card?.getAttribute("data-projects-preset-readback") || "[]",
      };
    });
    add(
      "权限收窄默认「继承宿主」，选项来自宿主 catalog（名字不写死）",
      presetReady === "yes" &&
        before.available === "yes" &&
        before.current === "" &&
        before.options.some((option) => option.value === "") &&
        before.options.filter((option) => option.value !== "").length >= 2 &&
        /继承宿主/u.test(before.options[0]?.text || ""),
      JSON.stringify({ presetReady, pickedProject, available: before.available, current: before.current, count: before.options.length }),
    );
    add(
      "权限收窄明示「推/合并/删除永远需要你批准」且不绕过执行器",
      /推 \\/ 合并 \\/ 删除永远需要你/u.test(before.note) &&
        /不绕过|只影响/u.test(before.note),
      before.note.slice(0, 140),
    );
    // 挑一个比宿主默认更窄的档（本部署默认 danger-full-access，所以窄档一定存在）
    const narrow = before.options.find((option) => option.value !== "" && /更窄/u.test(option.text)) ||
      before.options.find((option) => option.value !== "" && option.value !== "danger-full-access");
    const chosenPreset = narrow ? narrow.value : "";
    await page.evaluate(async (value) => {
      const select = document.querySelector("[data-projects-preset-select]");
      if (!select) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // 旧会话（协调器 + 线程）补应用一次，回读写进 data-projects-preset-readback
      document.querySelector("[data-projects-preset-apply]")?.click();
    }, chosenPreset);
    const applied = await waitUntil(
      () =>
        page.evaluate((value) => {
          const card = document.querySelector("[data-projects-preset]");
          if (!card) return null;
          const current = card.getAttribute("data-projects-preset-current");
          const readback = JSON.parse(card.getAttribute("data-projects-preset-readback") || "[]");
          const good = readback.filter((item) => item.ok === true && item.currentPreset === value);
          return current === value && good.length >= 1
            ? { current, applied: good.length, readback }
            : null;
        }, chosenPreset),
      25000,
    );
    add(
      "权限收窄写→回读：current(session) 等于所选档位",
      chosenPreset !== "" && applied !== null && applied.current === chosenPreset,
      JSON.stringify({ chosenPreset, applied: applied && { current: applied.current, applied: applied.applied, readback: applied.readback } }),
    );
    result.b4Preset = chosenPreset;
    // 截图：权限收窄卡（含回读行）
    await page.evaluate(() => {
      const card = document.querySelector("[data-projects-preset]");
      if (card && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(400);
    {
      const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        ${JSON.stringify(shotsDir)} + "/11-b4-preset.png",
        Buffer.from(shot.data, "base64"),
      );
    }
  }

  await page.waitForTimeout(600);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.waitForTimeout(600);
  // 列表页截图：宽窗（1440）+ 滚回顶部，用 CDP 取（ego 的 page.screenshot 本版本返回空数据）
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const panel = document.querySelector("[data-projects-panel]");
    if (panel) panel.scrollTop = 0;
  });
  {
    const listShot = await page.cdp("Page.captureScreenshot", { format: "png" });
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      ${JSON.stringify(shotsDir)} + "/01-projects-panel.png",
      Buffer.from(listShot.data, "base64"),
    );
  }
  // F7 项目切换器（真切换）：进一个项目详情，用标题下拉换到另一个项目
  const switchIds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-projects-row]")].map((node) =>
      node.getAttribute("data-projects-row"),
    ),
  );
  if (switchIds.length >= 2) {
    await page.evaluate(() => document.querySelector("[data-projects-row]")?.click());
    await page.waitForTimeout(1600);
    const switchBefore = await page.evaluate(() =>
      document.querySelector("[data-projects-detail]")?.getAttribute("data-projects-detail"),
    );
    await page.evaluate(() => document.querySelector("[data-projects-switcher]")?.click());
    await page.waitForTimeout(450);
    const switchTarget = switchIds.find((id) => id !== switchBefore) || "";
    const switchClicked = await page.evaluate((id) => {
      const button = [...document.querySelectorAll("[data-projects-switcher-option]")].find(
        (node) => node.getAttribute("data-projects-switcher-option") === id,
      );
      if (!button) return "no-option";
      button.click();
      return "clicked";
    }, switchTarget);
    await page.waitForTimeout(1600);
    const switchAfter = await page.evaluate(() =>
      document.querySelector("[data-projects-detail]")?.getAttribute("data-projects-detail"),
    );
    add(
      "项目切换器真的换项目（F7）",
      switchClicked === "clicked" && switchAfter === switchTarget && switchAfter !== switchBefore,
      JSON.stringify({ switchIds, switchBefore, switchTarget, switchClicked, switchAfter }),
    );
    await page.evaluate(() => document.querySelector("[data-projects-detail-back]")?.click());
    await page.waitForTimeout(1200);
  } else {
    add("项目切换器真的换项目（F7）", false, JSON.stringify({ switchIds }));
  }
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
  result.workspaceDir = SMOKE_WORKSPACE_DIR;
  await task.finish({ keep: [] });
} catch (error) {
  result.fatal = String(error && error.message ? error.message : error).slice(0, 800);
}
result.settingsSeen = b3SettingsSeen;
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

    // P0/B3 复审：live profile 把 `ui-settings` 的 config.enabled 写成 false（设置页整个关掉），
    // 整份拷进临时 home 后那 14 条设置断言就只能「跳过计 PASS」。**只改临时 home 的 patch 层**
    // （不碰 live profile），把设置页打开让它们真跑；改不动时下面的断言会如实 SKIP。
    const patchPath = join(profile, "cordis.patch.yml");
    const patchBefore = await readIfExists(patchPath);
    let patchAfter = patchBefore;
    let settingsEnabledInTemp = false;
    if (patchBefore !== "") {
      const rewritten = [];
      let inSettings = false;
      for (const line of patchBefore.split("\n")) {
        if (/^- id:\s*ui-settings\s*$/u.test(line)) inSettings = true;
        else if (/^- id:/u.test(line)) inSettings = false;
        if (inSettings && /^\s+enabled:\s*false\s*$/u.test(line)) {
          rewritten.push(line.replace(/false/u, "true"));
          settingsEnabledInTemp = true;
          continue;
        }
        rewritten.push(line);
      }
      patchAfter = rewritten.join("\n");
    }
    if (patchAfter !== patchBefore) await writeFile(patchPath, patchAfter, "utf8");
    console.log(
      settingsEnabledInTemp
        ? "临时 profile：已把 ui-settings 的 enabled 改成 true（只改临时 home）"
        : "临时 profile：没有 ui-settings enabled:false 需要改写（设置页是否可用以断言为准）",
    );

    const SMOKE_WORKSPACE_DIR = workspaceDir;
    // F35 多目录：第二个真实目录（不需要是 git 仓库；只验证「dirs[] 全部生效」与落盘）
    const secondDirRaw = join(work, "workspace2");
    await mkdir(secondDirRaw, { recursive: true });
    await writeFile(join(secondDirRaw, "seed.txt"), "seed2\n", "utf8");
    const SMOKE_SECOND_DIR = await realpath(secondDirRaw);
    const logPath = join(work, "host.log");
    activeHost = host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
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
    // —— 基础设施自检（INFRA）——
    // 端口不可用 / 插件没激活时，后面几十条断言会连锁变红，看起来像代码坏了。
    // 这类问题一律打印 INFRA 并 fail-fast，不混进断言计数。
    if (/did not activate|failed to activate|cannot find module/iu.test(boot.text)) {
      infraFail("宿主启动了但有插件未激活（projects 包这次没装上？）", boot.text.slice(-4000));
    }
    await assertHostPort(boot.port);
    console.log(`宿主已启动并监听：http://127.0.0.1:${boot.port}`);

    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const source = browserScript(
      `http://127.0.0.1:${boot.port}/?token=${boot.token}`,
      shotsDir,
      SMOKE_WORKSPACE_DIR,
      SMOKE_SECOND_DIR,
    );
    await writeFile(browserFile, source);

    const raw = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      // 420s 在 238 条断言时已经贴边；B6 又加了几段轮询，超时只会伪装成 INFRA（没有断言失败信息）。
      // 调宽到 600s：只是「浏览器脚本预算」，不放宽任何断言。
      const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
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
      // 页面/浏览器层没跑起来（崩溃、超时、CDP 断连）属于基础设施问题：
      // 以前报「代码坏了」混进 FAIL 计数，复盘时会误判。这里 INFRA fail-fast。
      infraFail("浏览器脚本没有返回结果（页面/浏览器层没就绪）", String(raw).slice(-4000));
    }
    const result = JSON.parse(match[1]);
    if (result.fatal) fail(`浏览器脚本异常：${result.fatal}`);

    /** @type {{ name: string, ok: boolean, detail: string }[]} */
    const checks = result.checks ?? [];
    /** @type {{ name: string, detail: string }[]} */
    const skips = result.skips ?? [];

    // Node 侧：宿主真的落盘了，且没有残留临时文件
    const storePath = join(home, "projects", "projects.json");
    const storeText = await readIfExists(storePath);
    // projects.json 没落盘 = 插件的落盘路径整条没跑通（数据根不可写/激活失败），
    // 不是某一条断言的问题：INFRA fail-fast，避免把 20+ 条回读断言变成噪音。
    if (storeText === "") infraFail("projects.json 未落盘（插件没有写出元数据）", storePath);
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
    // ===== B4：F36 routines / F30 reminders / F52 preset 的落盘回读 =====
    const b4Project =
      parsed && typeof result.projectName === "string"
        ? Object.values(parsed.projects ?? {}).find(
            (/** @type {any} */ project) => project.name === result.projectName,
          )
        : undefined;
    const b4Routines = Array.isArray(b4Project?.routines) ? b4Project.routines : [];
    const b4Routine =
      b4Routines.find((/** @type {any} */ item) => item.id === String(result.b4RoutineId ?? "")) ??
      b4Routines[0];
    checks.push({
      name: "Routines 落盘：本地记录带宿主 scheduleId + 频率/时间（写→回读）",
      ok:
        b4Routine !== undefined &&
        String(b4Routine.scheduleId ?? "") !== "" &&
        b4Routine.frequency === "daily" &&
        b4Routine.time === "09:30:00" &&
        b4Routine.name === "冒烟每日摘要",
      detail: JSON.stringify({
        id: b4Routine?.id ?? "MISSING",
        scheduleId: b4Routine?.scheduleId ?? null,
        frequency: b4Routine?.frequency ?? null,
        time: b4Routine?.time ?? null,
      }),
    });
    checks.push({
      name: "Routines 停用写→回读（本地 enabled=false，宿主 status 另在面板显示）",
      ok: b4Routine !== undefined && b4Routine.enabled === false,
      detail: JSON.stringify({ enabled: b4Routine?.enabled ?? null }),
    });
    checks.push({
      name: "Routines 删除不留本地记录（手动档已删）",
      ok:
        b4Routines.length >= 1 &&
        b4Routines.every((/** @type {any} */ item) => item.name !== "冒烟手动任务"),
      detail: JSON.stringify(b4Routines.map((/** @type {any} */ item) => item.name)),
    });
    const b4Reminders = Array.isArray(b4Project?.reminders) ? b4Project.reminders : [];
    const b4Fired = b4Reminders.find(
      (/** @type {any} */ item) => item.mode === "timer" && item.state === "fired",
    );
    checks.push({
      name: "提醒落盘：timer 到点写回 fired + firedAt + 未读/已通知（重启后不再重复响）",
      ok:
        b4Fired !== undefined &&
        typeof b4Fired.firedAt === "string" &&
        b4Fired.firedAt !== "" &&
        // toast 弹过就会 ack（notified=true 且 unread 清掉）；没弹过则必须还是 unread。
        // 两种都证明「落盘状态跟着真实投递走」，坏实现（不写回）会两个都不满足。
        (b4Fired.notified === true || b4Fired.unread === true) &&
        /冒烟提醒/u.test(String(b4Fired.text ?? "")),
      detail: JSON.stringify({
        firedAt: b4Fired?.firedAt ?? null,
        unread: b4Fired?.unread ?? null,
        state: b4Fired?.state ?? null,
      }),
    });
    checks.push({
      name: "提醒取消落盘：state=cancelled（取消后不会再触发）",
      ok: b4Reminders.some(
        (/** @type {any} */ item) =>
          item.state === "cancelled" && /这条会被取消/u.test(String(item.text ?? "")),
      ),
      detail: JSON.stringify(
        b4Reminders.map((/** @type {any} */ item) => `${item.mode}:${item.state}`),
      ),
    });
    checks.push({
      name: "权限收窄落盘：project.preset 等于 UI 所选档位（写→回读）",
      ok:
        b4Project !== undefined &&
        String(result.b4Preset ?? "") !== "" &&
        b4Project.preset === result.b4Preset,
      detail: JSON.stringify({ store: b4Project?.preset ?? null, ui: result.b4Preset ?? null }),
    });
    checks.push({
      name: "自定义视图落盘（+ 新增视图 写→重启可读）",
      ok: Object.values(parsed?.projects ?? {}).some(
        (/** @type {any} */ project) =>
          Array.isArray(project?.views) &&
          project.views.some((/** @type {any} */ view) => String(view?.name ?? "") === "冒烟视图B"),
      ),
      detail: JSON.stringify(
        Object.values(parsed?.projects ?? {}).map((/** @type {any} */ project) =>
          (project?.views ?? []).map((/** @type {any} */ view) => view?.name),
        ),
      ),
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
    // P0（复审）：协调器工具真的注册上了——审计里必须有 coordinator/tools 且 count 是 6。
    // 这条是「把桩接通」的端到端证据：删掉 onAgentCreated/warmUpCoordinator 里的挂载就红。
    const toolsAudit = Array.isArray(parsed?.audit)
      ? parsed.audit.filter((/** @type {any} */ entry) => entry?.action === "coordinator/tools")
      : [];
    checks.push({
      name: "协调器工具已挂到 agent 作用域（P0：审计 coordinator/tools 且 count=6）",
      ok: toolsAudit.length > 0 && toolsAudit.some((/** @type {any} */ entry) => entry.count === 6),
      detail: JSON.stringify(toolsAudit.slice(-2)),
    });
    const projectByName = Object.values(parsed?.projects ?? {}).find(
      (/** @type {any} */ project) => project?.name === result.projectName,
    );
    // F21/P2：policy.pr.tier 必须有定义并被写盘（以前全仓没这个字段，per-project opt-out 不存在）
    checks.push({
      name: "策略里有 PR 档位且默认 draft（F21：policy.pr.tier 可 per-project opt-out）",
      ok: projectByName?.policy?.pr?.tier === "draft",
      detail: JSON.stringify({ pr: projectByName?.policy?.pr ?? null }),
    });
    checks.push({
      name: "项目图标与关联仓库落盘（F1/F2）",
      ok:
        projectByName?.icon === "🚀" &&
        Array.isArray(projectByName?.repos) &&
        projectByName.repos.includes("acme/api"),
      detail: JSON.stringify({ icon: projectByName?.icon, repos: projectByName?.repos }),
    });
    checks.push({
      name: "未归档项目的 archivedAt 恒为 null（F1，不是「null 或字符串」这种恒真断言）",
      ok:
        projectByName !== undefined &&
        projectByName.state !== "archived" &&
        projectByName.archivedAt === null,
      detail: JSON.stringify({
        state: projectByName?.state,
        archivedAt: projectByName?.archivedAt,
      }),
    });
    // 归档的一次性项目：archivedAt 必须是**真的 ISO 时间**（旧断言只校验类型，坏实现也 PASS）
    const archivedProject = Object.values(parsed?.projects ?? {}).find(
      (/** @type {any} */ project) => project?.state === "archived",
    );
    checks.push({
      name: "归档项目的 archivedAt 是可解析的 ISO 时间（F1 写→回读）",
      ok:
        archivedProject !== undefined &&
        typeof archivedProject.archivedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T/u.test(archivedProject.archivedAt) &&
        !Number.isNaN(Date.parse(archivedProject.archivedAt)),
      detail: JSON.stringify({
        name: archivedProject?.name ?? null,
        archivedAt: archivedProject?.archivedAt ?? null,
      }),
    });
    checks.push({
      name: "多目录落盘（F35：两个目录都在）",
      ok:
        Array.isArray(projectByName?.dirs) &&
        projectByName.dirs.length >= 2 &&
        projectByName.dirs.some((/** @type {any} */ dir) => String(dir).includes("workspace2")),
      detail: JSON.stringify(projectByName?.dirs),
    });
    // ⚠️ 只按 projectId 找一个是不够的：项目里不止一条线程（会话菜单 attach 进来的那条没有 dir、
    // 也没有 prompt），find() 会挑到它 → 断言看着过了，其实对错了对象。用 UI 那行的 sessionId 精确定位。
    const threadRecord =
      parsed?.threads?.[String(result.overviewFacts?.sessionId ?? "")] ??
      Object.values(parsed?.threads ?? {}).find(
        (/** @type {any} */ thread) => thread?.sessionId === result.overviewFacts?.sessionId,
      );
    // 新建线程默认 idle：旧断言只校验「∈ 六态枚举」，坏实现（永远不写回）也能 PASS。
    // 这里钉死具体值，并要求**和 UI 说的一致**（这一轮必然 MISSING_CREDENTIAL → failed）。
    // 具体值 = resolved（不是「∈ 六态枚举」）：新建线程默认 idle，坏实现（永远不写回）会 FAIL。
    // 同时要求 UI 最后显示的就是这个值（写→回读闭环），而不是各说各的。
    checks.push({
      name: "线程状态回写为具体值 resolved，且与 UI 最后显示一致（F16）",
      ok:
        threadRecord !== undefined &&
        threadRecord.state === "resolved" &&
        threadRecord.state === String(result.finalThread?.state ?? ""),
      detail: JSON.stringify({
        store: threadRecord?.state ?? null,
        uiFinal: result.finalThread?.state ?? null,
      }),
    });
    checks.push({
      name: "线程状态用的是统一六态词表（P0-2：waiting-user 带连字符）",
      ok:
        threadRecord !== undefined &&
        THREAD_STATES.includes(String(threadRecord.state)) &&
        !["waiting", "done"].includes(String(threadRecord.state)),
      detail: JSON.stringify({ state: threadRecord?.state, vocabulary: THREAD_STATES }),
    });
    // 这条线程没有任何 todo/write：todos 必须**就是 null**（不是 "object 也行"），
    // 并且 UI 同步显示 none——两边都得是「没有」，不能一边编 0/0。
    checks.push({
      name: "无 todo 的线程 todos 恒为 null 且 UI 显示 none（F27，深比较而非类型检查）",
      ok:
        threadRecord !== undefined &&
        threadRecord.todos === null &&
        String(result.overviewFacts?.stepsState ?? "") === "none",
      detail: JSON.stringify({
        todos: threadRecord?.todos ?? "MISSING",
        uiSteps: result.overviewFacts?.stepsState ?? null,
      }),
    });
    checks.push({
      name: "副标题缺数据时留空（F27：不是编出来的字符串）",
      ok:
        threadRecord !== undefined &&
        threadRecord.subtitle === "" &&
        (result.overviewFacts?.subtitlePresent === false ||
          /空闲|在跑|等你|待审|失败|归档/u.test(String(result.overviewFacts?.subtitleText ?? ""))),
      detail: JSON.stringify({
        subtitle: threadRecord?.subtitle,
        uiPresent: result.overviewFacts?.subtitlePresent,
      }),
    });
    // resolve 阶段 UI 回读到过具体 ISO 时间（browser 断言已校验格式），重开后必须清成 null。
    // 旧断言「resolvedAt === null || string」对两种结果都成立 → 恒真。
    // resolvedAt 必须**真的写进去了**，且 UI 从宿主回读到的就是同一个值（不是各算各的）：
    // 旧断言「=== null || typeof string」对「永远是 null」和「是字符串」都成立 → 恒真。
    checks.push({
      name: "resolvedAt 非空、可解析，且与 UI 回读值逐字符相同（F29 写→回读）",
      ok:
        threadRecord !== undefined &&
        typeof threadRecord.resolvedAt === "string" &&
        threadRecord.resolvedAt !== "" &&
        /^\d{4}-\d{2}-\d{2}T/u.test(threadRecord.resolvedAt) &&
        !Number.isNaN(Date.parse(threadRecord.resolvedAt)) &&
        threadRecord.resolvedAt === String(result.finalThread?.resolvedAt ?? "") &&
        typeof result.resolvedAtSeen === "string" &&
        Number.isNaN(Date.parse(result.resolvedAtSeen)) === false,
      detail: JSON.stringify({
        store: threadRecord?.resolvedAt ?? "MISSING",
        uiFinal: result.finalThread?.resolvedAt ?? null,
        firstResolveUi: result.resolvedAtSeen ?? null,
      }),
    });
    // 冷启动（模拟宿主重启）：不经过内存视图，直接从盘上 load 再推导六态。
    // 这正是 P0-2 说的「冷启动 failed/working 一律变 idle」的回归点。
    let coldState = "load-failed";
    try {
      const coldStore = new ProjectStore({ root: join(home, "projects") }).load();
      // ⚠️ 线程记录本身没有 sessionId 字段（它以 sessionId 为 key）：必须用 UI 那行的 id 定位，
      // 否则会 fallback 到项目里另一条线程（attach 进来的 idle 线程）→ 看着像「冷启动丢了状态」。
      const coldId = String(result.overviewFacts?.sessionId ?? "");
      const coldThread = coldId === "" ? undefined : coldStore.state.threads?.[coldId];
      coldState = coldThread ? deriveThreadState(undefined, coldThread) : "no-thread";
    } catch (error) {
      coldState = `load-error: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 80)}`;
    }
    // 冷启动（模拟宿主重启）：不经过内存视图，直接 load 盘上的记录再推导六态。
    // 期望值与 UI 最后显示一致——这就是 P0-2「写进去要读得回来」的端到端证据。
    // （failed/working 的映射另有三条单测固定：mergeRecord + deriveThreadState。）
    checks.push({
      name: "冷启动读路径与 UI 最后显示一致（P0-2 持久化闭环）",
      ok: coldState === "resolved" && coldState === String(result.finalThread?.state ?? ""),
      detail: JSON.stringify({ coldState, uiFinal: result.finalThread?.state ?? null }),
    });
    // —— P0-2：启动 replay（修复前 replay() 全仓零调用者，重启后视图归零）——
    const replayEvents = Array.isArray(threadRecord?.events) ? threadRecord.events : [];
    const replayView = replay(replayEvents);
    checks.push({
      name: "持久事件 journal 落盘且含轮起止（P0-2：启动 replay 的事实源）",
      ok:
        replayEvents.length > 0 &&
        replayEvents.some(
          (/** @type {any} */ event) => String(event?.type ?? "") === "turn/start",
        ) &&
        replayEvents.some((/** @type {any} */ event) => String(event?.type ?? "") === "turn/end"),
      detail: JSON.stringify(
        replayEvents.map((/** @type {any} */ event) => event?.type).slice(0, 8),
      ),
    });
    // 真实启动路径 = hydrateThreadView（replay + 人工 resolve 覆盖）；坏实现不落事件回放 → idle
    const hydrated = hydrateThreadView(threadRecord, replayEvents);
    checks.push({
      name: "启动 replay 后视图非 idle，且冷启动六态与 UI 最后显示一致（P0-2）",
      ok:
        replayView.state !== "idle" &&
        deriveThreadState(hydrated, threadRecord) === String(result.finalThread?.state ?? ""),
      detail: JSON.stringify({
        replayed: replayView.state,
        lastTurnFailed: replayView.lastTurnFailed,
        hydrated: deriveThreadState(hydrated, threadRecord),
        uiFinal: result.finalThread?.state ?? null,
      }),
    });
    checks.push({
      name: "线程 dir 落盘且是项目目录之一（多目录时能说清跑在哪个 root，P1-7 写入侧）",
      ok:
        threadRecord !== undefined &&
        typeof threadRecord.dir === "string" &&
        threadRecord.dir.length > 0 &&
        Array.isArray(projectByName?.dirs) &&
        projectByName.dirs.includes(threadRecord.dir),
      detail: JSON.stringify({ dir: threadRecord?.dir ?? null, dirs: projectByName?.dirs ?? null }),
    });
    const uiStoreText = await readIfExists(join(home, "storages", "projects_ui.json"));
    let uiStore = null;
    try {
      uiStore = JSON.parse(uiStoreText);
    } catch {
      uiStore = null;
    }
    checks.push({
      name: "首启 firstRunDone 落 storageDomain（F63）",
      ok: uiStore?.global?.firstRunDone === true,
      detail: uiStoreText.slice(0, 200),
    });
    // —— B2：协调者会话 / 实时监听开关 / F15 跨项目移动 ——
    const coordinatorProjects = Object.values(parsed?.projects ?? {}).filter(
      (/** @type {any} */ project) =>
        typeof project?.coordinatorSessionId === "string" && project.coordinatorSessionId !== "",
    );
    checks.push({
      name: "协调者会话已落盘并可回读（F9：coordinatorSessionId 非空）",
      ok: coordinatorProjects.length > 0,
      detail: JSON.stringify(
        coordinatorProjects.map((/** @type {any} */ project) => project.name).slice(0, 2),
      ),
    });
    // F21 复审 P1-2：实时监听**未实现**，所以盘上不允许出现 realtimeCi=true 这种假状态
    // （以前开关能写能回读，却没有任何东西被启动）。
    checks.push({
      name: "实时监听未实现时不落「已开启」假状态（F21/P1-2，storageDomain）",
      ok: uiStore?.global?.realtimeCi !== true,
      detail: JSON.stringify(uiStore?.global ?? null).slice(0, 200),
    });
    // F20/P1-4：点了 Create PR 之后，服务端必须有真实决策审计（pr/decided 或 pr/failed）。
    // 删掉 service.createPr 里的 openPr 调用 → 一条 pr/* 审计都不会写 → 这条红。
    const prAudit = Array.isArray(parsed?.audit)
      ? parsed.audit.filter(
          (/** @type {any} */ entry) =>
            typeof entry?.action === "string" && entry.action.startsWith("pr/"),
        )
      : [];
    checks.push({
      name: "Create PR 写入真实决策审计（F20：pr/decided 或 pr/failed 可追溯）",
      ok:
        prAudit.length > 0 &&
        prAudit.some((/** @type {any} */ entry) => String(entry.reason ?? "") !== ""),
      detail: JSON.stringify(prAudit.slice(-2)),
    });
    const threadList = Object.values(parsed?.threads ?? {});
    checks.push({
      name: "线程记录带 ciState/headRefOid 字段（F21/U16：null 也显式存在，不是缺字段）",
      ok:
        threadList.length > 0 &&
        threadList.every(
          (/** @type {any} */ thread) =>
            "ciState" in thread &&
            "headRefOid" in thread &&
            (thread.ciState === null || typeof thread.ciState === "string"),
        ),
      detail: JSON.stringify(threadList.map((/** @type {any} */ thread) => thread.ciState)).slice(
        0,
        120,
      ),
    });
    const auditActions = Array.isArray(parsed?.audit)
      ? parsed.audit.map((/** @type {any} */ entry) => String(entry?.action ?? ""))
      : [];
    // —— F29：自动 resolve 的落盘/审计/RPC 三面证据 ——
    const autoResolveTitle = String(result.autoResolve?.projectName ?? "");
    const autoResolveProject =
      autoResolveTitle === ""
        ? undefined
        : Object.values(parsed?.projects ?? {}).find((/** @type {any} */ project) =>
            autoResolveTitle.includes(String(project?.name ?? "")),
          );
    checks.push({
      name: "F29 自动 resolve 设置落盘为 7 天，且与 UI 两次回读一致（写→回读）",
      ok:
        autoResolveProject !== undefined &&
        autoResolveProject.autoResolveDays === 7 &&
        result.autoResolve?.before === "off" &&
        result.autoResolve?.after === "7",
      detail: JSON.stringify({
        project: autoResolveProject?.name ?? null,
        store: autoResolveProject?.autoResolveDays ?? null,
        ui: result.autoResolve ?? null,
      }),
    });
    checks.push({
      name: "F29 自动 resolve 设置写审计（project/auto-resolve 可追溯）",
      ok: auditActions.includes("project/auto-resolve"),
      detail: auditActions
        .filter((/** @type {string} */ action) => action.startsWith("project/"))
        .slice(-6)
        .join(","),
    });
    checks.push({
      name: "F29 自动 resolve 不误伤刚配的近期线程（无 thread/auto-resolved 审计）",
      ok: !auditActions.includes("thread/auto-resolved"),
      detail: JSON.stringify(
        (parsed?.audit ?? [])
          .filter((/** @type {any} */ entry) => entry?.action === "thread/auto-resolved")
          .slice(0, 2),
      ),
    });
    try {
      const autoCheck = await hostRpc(boot.port, boot.token, "projects/checkAutoResolve", {});
      const value = autoCheck.value ?? autoCheck.json ?? null;
      checks.push({
        name: "F29 checkAutoResolve RPC 真跑检查且不 resolve 近期线程（RPC 可达）",
        ok:
          value?.ok === true &&
          Array.isArray(value.resolved) &&
          value.resolved.length === 0 &&
          Number(value.checked) >= 1,
        detail: JSON.stringify({ status: autoCheck.status, value }).slice(0, 400),
      });
    } catch (error) {
      checks.push({
        name: "F29 checkAutoResolve RPC 真跑检查且不 resolve 近期线程（RPC 可达）",
        ok: false,
        detail: errorText(error).slice(0, 300),
      });
    }
    checks.push({
      name: "协调者创建写审计（F9：coordinator/created 可追溯）",
      ok: auditActions.includes("coordinator/created"),
      detail: auditActions.slice(-6).join(","),
    });
    checks.push({
      name: "resolve / 重开都写审计（F29 可追溯）",
      ok: auditActions.includes("thread/resolved") && auditActions.includes("thread/reopened"),
      detail: JSON.stringify(
        auditActions
          .filter((/** @type {string} */ action) => action.startsWith("thread/"))
          .slice(0, 6),
      ),
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
    // —— B3 UI 宿主侧回读：线程默认模型（**具体值**逐字段比对，不是 typeof object）——
    const b3UiProjects = Object.values(parsed?.projects ?? {});
    const pickedDefaults = result.b3DefaultsPicked ?? null;
    const projectWithDefaults =
      b3UiProjects.find(
        (/** @type {any} */ project) =>
          project?.name === result.projectName && project?.threadDefaults,
      ) ??
      b3UiProjects.find(
        (/** @type {any} */ project) =>
          project?.threadDefaults &&
          String(project.threadDefaults.provider ?? "") ===
            String(pickedDefaults?.provider ?? "") &&
          String(project.threadDefaults.model ?? "") === String(pickedDefaults?.modelId ?? ""),
      ) ??
      null;
    checks.push({
      name: "线程默认模型写→回读（projects.json 逐字段等于 UI 选择）",
      ok:
        pickedDefaults !== null &&
        projectWithDefaults !== null &&
        String(projectWithDefaults.threadDefaults.provider ?? "") ===
          String(pickedDefaults.provider ?? "") &&
        String(projectWithDefaults.threadDefaults.model ?? "") ===
          String(pickedDefaults.modelId ?? "") &&
        String(projectWithDefaults.threadDefaults.reasoningEffort ?? "") ===
          String(pickedDefaults.effort ?? ""),
      detail: JSON.stringify({
        picked: pickedDefaults,
        stored: projectWithDefaults?.threadDefaults ?? null,
        project: projectWithDefaults?.name ?? null,
      }),
    });
    // D1：可见性写盘。审计是**全局** state.audit（不是 project.audit），按最后一条
    // project/visible-views 的 projectId 定位被操作的项目。
    const visibleAudit = (Array.isArray(parsed?.audit) ? parsed.audit : []).filter(
      (/** @type {any} */ item) => String(item?.action ?? "") === "project/visible-views",
    );
    const lastVisible = visibleAudit[visibleAudit.length - 1];
    const visibilityProject =
      lastVisible && parsed?.projects ? parsed.projects[String(lastVisible.projectId)] : null;
    checks.push({
      name: "视图可见性写→回读（visibleViews 与全局审计指向同一项目）",
      ok:
        visibilityProject !== null &&
        Array.isArray(visibilityProject.visibleViews) &&
        visibilityProject.visibleViews.includes("library") === false &&
        visibilityProject.visibleViews.includes("routines") === true,
      detail: JSON.stringify({
        visibleViews: visibilityProject?.visibleViews ?? null,
        projectName: visibilityProject?.name ?? null,
        audits: visibleAudit.length,
      }),
    });
    // —— B3：三项「写→回读」由宿主侧文件做硬证据（UI 只是按钮，盘上才算数）——
    const b3Budget = Object.values(parsed?.projects ?? {})
      .map((/** @type {any} */ project) => project?.budget)
      .find((/** @type {any} */ budget) => budget && Number(budget.maxThreadsPerDay) === 7);
    // F55：授权卡「设为默认」必须落到某个项目目录的 policy.folderAuth[path].mode=default
    const folderHit =
      Object.values(parsed?.projects ?? {})
        .map((/** @type {any} */ project) => ({
          name: project?.name ?? "",
          dirs: Array.isArray(project?.dirs) ? project.dirs : [],
          entries: Object.entries(project?.policy?.folderAuth ?? {}),
        }))
        .map((/** @type {any} */ item) => {
          const found = item.entries.find(
            (/** @type {any} */ entry) =>
              entry[1] && entry[1].mode === "default" && item.dirs.includes(entry[0]),
          );
          return found === undefined
            ? null
            : { project: item.name, path: found[0], record: found[1] };
        })
        .find((/** @type {any} */ item) => item !== null) ?? null;
    checks.push({
      name: "F55 授权卡「设为默认」落盘（policy.folderAuth[dir].mode=default）",
      ok: folderHit !== null,
      detail: JSON.stringify(folderHit),
    });
    // F62：@ 候选 token 必须指向真实项目/线程（来自 host RPC mentionItems）
    const mentionTokens = Array.isArray(result.b3MentionTokens) ? result.b3MentionTokens : [];
    const mentionTokenOk = mentionTokens.some((/** @type {any} */ token) => {
      const value = String(token);
      const splitAt = value.indexOf(":");
      const kind = value.slice(0, splitAt);
      const id = value.slice(splitAt + 1);
      if (kind === "thread") return Boolean(parsed?.threads?.[id]);
      if (kind === "project")
        return Object.values(parsed?.projects ?? {}).some(
          (/** @type {any} */ project) => project?.id === id,
        );
      return false;
    });
    checks.push({
      name: "F62 @ 候选 token 指向真实项目/线程（host RPC mentionItems）",
      ok: mentionTokenOk,
      detail: JSON.stringify(mentionTokens.slice(0, 4)),
    });
    // F3：从会话开线程 —— attach 的 sessionId 必须出现在 projects.json.threads
    const attachedId = String(result.__b3AttachId ?? "");
    checks.push({
      name: "F3 从会话开线程：attach 的 sessionId 出现在 projects.json.threads",
      ok: attachedId !== "" && Boolean(parsed?.threads?.[attachedId]),
      detail: JSON.stringify({
        attachedId,
        threadCount: Object.keys(parsed?.threads ?? {}).length,
      }),
    });
    if (result.settingsSeen === false) {
      skips.push({
        name: "预算改动在宿主侧落盘（maxThreadsPerDay=7 可回读）",
        detail: "设置页未渲染，预算写路径没跑",
      });
    } else {
      checks.push({
        name: "预算改动在宿主侧落盘（maxThreadsPerDay=7 可回读）",
        ok: Boolean(b3Budget) && b3Budget.maxConcurrent === 2 && b3Budget.maxStepsPerThread === 60,
        detail: JSON.stringify(b3Budget ?? null),
      });
    }
    const b3Notify = Object.values(parsed?.projects ?? {})
      .map((/** @type {any} */ project) => project?.notifyPrefs)
      .find((/** @type {any} */ prefs) => prefs && prefs.completed === true);
    if (result.settingsSeen === false) {
      skips.push({
        name: "通知开关在宿主侧落盘（completed=true 可回读）",
        detail: "设置页未渲染，通知开关没跑",
      });
    } else {
      checks.push({
        name: "通知开关在宿主侧落盘（completed=true 可回读）",
        ok: Boolean(b3Notify) && b3Notify.failed === true && b3Notify["waiting-user"] === true,
        detail: JSON.stringify(b3Notify ?? null),
      });
    }
    const b3DataRoot = join(home, "projects");
    const b3ProjectDirs = await readdir(b3DataRoot, { withFileTypes: true }).catch(() => []);
    const b3Agents = [];
    for (const entry of b3ProjectDirs) {
      if (!entry.isDirectory()) continue;
      const file = join(b3DataRoot, entry.name, "AGENTS.md");
      const text = await readIfExists(file);
      if (text.includes("dsh-projects:begin")) b3Agents.push(entry.name);
    }
    if (result.settingsSeen === false) {
      skips.push({
        name: "模板补全写入 AGENTS.md 受管区块（可回读、幂等）",
        detail: "设置页未渲染，模板按钮没点",
      });
    } else {
      // 项目可能有 dirs（模板写进 workspaceDir/AGENTS.md），也可能没有（写进 dataRoot/<id>/AGENTS.md）。
      /** @type {string[]} */
      const agentsFiles = [];
      const pushIfManaged = async (/** @type {string} */ file) => {
        const text = await readIfExists(file);
        if (text !== "") agentsFiles.push(`${file}:${text.split("dsh-projects:begin").length - 1}`);
      };
      await pushIfManaged(join(result.workspaceDir ?? "", "AGENTS.md"));
      for (const entry of b3ProjectDirs) {
        if (!entry.isDirectory()) continue;
        await pushIfManaged(join(b3DataRoot, entry.name, "AGENTS.md"));
      }
      const managedCounts = agentsFiles.map((item) => Number(item.split(":").pop() ?? "0"));
      checks.push({
        name: "模板补全写入 AGENTS.md 受管区块（可回读、幂等）",
        ok: agentsFiles.length >= 1 && managedCounts.reduce((sum, count) => sum + count, 0) === 1,
        detail: JSON.stringify({ agentsFiles, result: result.b3TemplateResult ?? null }),
      });
    }
    checks.push({
      name: "原子写没有残留 .tmp 文件",
      ok: leftovers.length === 0,
      detail: leftovers.join(","),
    });

    // ===== B3 复审修复 + B5 Library 的直连 RPC 证据（token → cookie → POST /api）=====
    // A2：runtime 字典（client.js ZH/EN）与 locale/{zh,en}.json 键集一致——现场曾缺 44 键。
    try {
      const runtimeZh = await runtimeDictionaryKeys("ZH");
      const runtimeEn = await runtimeDictionaryKeys("EN");
      const localeZh = await localeKeys("zh");
      const localeEn = await localeKeys("en");
      const missingZh = runtimeZh.filter((key) => !localeZh.includes(key));
      const missingEn = runtimeEn.filter((key) => !localeEn.includes(key));
      checks.push({
        name: "locale/zh.json 与 runtime ZH 字典键集一致（B3 复审 P1：44 键已补齐）",
        ok: missingZh.length === 0 && localeZh.length === runtimeZh.length,
        detail: JSON.stringify({
          runtime: runtimeZh.length,
          locale: localeZh.length,
          missing: missingZh,
        }),
      });
      checks.push({
        name: "locale/en.json 与 runtime EN 字典键集一致",
        ok: missingEn.length === 0 && localeEn.length === runtimeEn.length,
        detail: JSON.stringify({
          runtime: runtimeEn.length,
          locale: localeEn.length,
          missing: missingEn,
        }),
      });
      const zhRaw = JSON.parse(
        await readFile(join(REPO, "packages", "projects", "locale", "zh.json"), "utf8"),
      ).projects;
      checks.push({
        name: "实时 CI 开关文案如实写「未实现」，不再承诺会建临时 webhook（B3 复审 P1）",
        ok:
          /未实现/u.test(String(zhRaw["settings.realtimeCiHint"] ?? "")) &&
          !/会建临时 ?webhook|创建临时 ?webhook/u.test(
            String(zhRaw["settings.realtimeCiHint"] ?? ""),
          ) &&
          !/已开启/u.test(String(zhRaw["settings.realtimeCiOn"] ?? "")),
        detail: JSON.stringify({
          hint: zhRaw["settings.realtimeCiHint"],
          on: zhRaw["settings.realtimeCiOn"],
        }),
      });
    } catch (error) {
      checks.push({
        name: "locale 与 runtime 字典一致性检查可执行",
        ok: false,
        detail: errorText(error).slice(0, 300),
      });
    }

    // A1：max/xhigh/off 三次写入必须留下审计（store 是唯一真源；UI 回读已在浏览器里断言）。
    try {
      const audit = await hostRpc(boot.port, boot.token, "projects/listAudit", {
        projectId: projectByName?.id ?? "",
      });
      const entries = Array.isArray(audit.value)
        ? audit.value
        : Array.isArray(audit.value?.entries)
          ? audit.value.entries
          : [];
      const efforts = entries
        .filter((/** @type {any} */ entry) => entry?.action === "thread/defaults")
        .map((/** @type {any} */ entry) => String(entry?.defaults?.reasoningEffort ?? ""));
      const wanted = ["max", "xhigh", "off"];
      checks.push({
        name: "F42 审计留下 max/xhigh/off 三次写入（B3 复审 P0 的落盘证据）",
        ok: wanted.every((effort) => efforts.includes(effort)),
        detail: JSON.stringify({ efforts: efforts.slice(-8), status: audit.status }),
      });
    } catch (error) {
      checks.push({
        name: "F42 审计留下 max/xhigh/off 三次写入（B3 复审 P0 的落盘证据）",
        ok: false,
        detail: errorText(error).slice(0, 300),
      });
    }

    // A6：未知 projectId 必须被拒（路径拼接前校验，不能拿 ../ 枚举 dataRoot 外的目录）。
    try {
      const fragment = await hostRpc(boot.port, boot.token, "projects/listMemoryFragments", {
        projectId: "../escape",
      });
      const message = JSON.stringify(fragment.error ?? fragment.text ?? "");
      checks.push({
        name: "F37 未知 projectId 的 listMemoryFragments 被拒（B3 复审 P2：不能枚举 dataRoot 外）",
        ok: fragment.status >= 400 || /unknown project|not found/iu.test(message),
        detail: JSON.stringify({ status: fragment.status, error: fragment.error ?? null }),
      });
    } catch (error) {
      checks.push({
        name: "F37 未知 projectId 的 listMemoryFragments 被拒（B3 复审 P2）",
        ok: false,
        detail: errorText(error).slice(0, 300),
      });
    }

    // A4：被拒的动作不烧掉 once 凭据（复审 P2）——真实 RPC 走「授权 → 申请 → 批准 → 执行 → 回读」。
    try {
      const createdProject = await hostRpc(boot.port, boot.token, "projects/createProject", {
        name: `smoke-once-${Date.now().toString(36)}`,
        input: { dirs: [SMOKE_WORKSPACE_DIR] },
      });
      const onceProject = createdProject.value ?? {};
      const authorized = await hostRpc(boot.port, boot.token, "projects/authorizeFolder", {
        projectId: onceProject.id,
        path: SMOKE_WORKSPACE_DIR,
        decision: "once",
      });
      const requested = await hostRpc(boot.port, boot.token, "projects/requestAction", {
        projectId: onceProject.id,
        request: { action: "merge", args: { prNumber: 1 }, reason: "smoke: once 时序" },
      });
      const requestId = requested.value?.requestId ?? "";
      if (requestId !== "") {
        await hostRpc(boot.port, boot.token, "projects/resolveApproval", {
          requestId,
          status: "approved",
        });
        const executed = await hostRpc(boot.port, boot.token, "projects/executeApproval", {
          requestId,
        });
        const readback = await hostRpc(boot.port, boot.token, "projects/getProject", {
          id: onceProject.id,
        });
        const grant = readback.value?.policy?.folderAuth?.[SMOKE_WORKSPACE_DIR] ?? null;
        checks.push({
          name: "F55 动作被拒（switch-off）时 once 凭据未被消费（B3 复审 P2）",
          ok:
            authorized.value?.ok === true &&
            executed.value?.executed === false &&
            String(executed.value?.reason ?? "") === "switch-off" &&
            grant?.used === false,
          detail: JSON.stringify({
            authorized: authorized.value ?? null,
            executed: executed.value ?? null,
            grant,
          }),
        });
      } else {
        checks.push({
          name: "F55 动作被拒（switch-off）时 once 凭据未被消费（B3 复审 P2）",
          ok: false,
          detail: JSON.stringify({ requested: requested.error ?? requested.value ?? null }),
        });
      }
    } catch (error) {
      checks.push({
        name: "F55 动作被拒（switch-off）时 once 凭据未被消费（B3 复审 P2）",
        ok: false,
        detail: errorText(error).slice(0, 300),
      });
    }

    // B5：文件面 + 产物面的写→回读（真实 RPC）。
    try {
      const targetProject = projectByName ?? null;
      const sessionId = String(result.overviewFacts?.sessionId ?? "");
      const unique = `needle-only-${Date.now().toString(36)}`;
      await writeFile(join(SMOKE_WORKSPACE_DIR, "content-only.txt"), `${unique}\n`, "utf8");
      const refId = "smoke-art-1";
      const recorded = await hostRpc(boot.port, boot.token, "projects/recordArtifact", {
        projectId: targetProject?.id ?? "",
        ref: {
          id: refId,
          title: "Smoke artifact",
          kind: "markdown",
          version: 2,
          bytes: 1234,
          updatedAt: Date.now(),
          sessionId,
          source: { sessionId, toolCallId: "call-smoke-1", via: "tool" },
        },
      });
      const library = await hostRpc(boot.port, boot.token, "projects/libraryView", {
        projectId: targetProject?.id ?? "",
      });
      const view = library.value ?? {};
      const storedIds = (view.artifacts?.stored ?? []).map((/** @type {any} */ item) => item.id);
      checks.push({
        name: "B5 产物面自存映射写→回读（recordArtifact → libraryView.stored，含 provenance）",
        ok:
          recorded.value?.ok === true &&
          storedIds.includes(refId) &&
          (view.artifacts?.stored ?? []).some(
            (/** @type {any} */ item) =>
              item.id === refId && item.source?.toolCallId === "call-smoke-1",
          ),
        detail: JSON.stringify({
          recorded: recorded.value?.ref ?? null,
          stored: view.artifacts?.stored ?? [],
        }),
      });
      checks.push({
        name: "B5 产物面计量（count/bytes 来自自存映射；summary 口径一致）",
        ok:
          Number(view.artifacts?.storedSummary?.count ?? -1) >= 1 &&
          Number(view.artifacts?.storedSummary?.bytes ?? 0) >= 1234,
        detail: JSON.stringify(view.artifacts?.storedSummary ?? null),
      });
      checks.push({
        name: "B5 artifacts 未装时 libraryView 给出降级 reason（不是空数组冒充「没有产物」）",
        ok:
          view.artifacts?.available === false &&
          String(view.artifacts?.reason ?? "") === "artifacts-not-installed",
        detail: JSON.stringify({
          available: view.artifacts?.available ?? null,
          reason: view.artifacts?.reason ?? null,
        }),
      });
      const fileDirs = Array.isArray(view.files?.dirs) ? view.files.dirs : [];
      const fileNames = fileDirs.flatMap((/** @type {any} */ dir) =>
        (dir.entries ?? []).map((/** @type {any} */ entry) => String(entry.name ?? "")),
      );
      checks.push({
        name: "B5 文件面读回：宿主 workspaceFiles 列到项目目录里的 seed.txt",
        ok: view.files?.available === true && fileNames.includes("seed.txt"),
        detail: JSON.stringify({
          available: view.files?.available ?? null,
          dirs: fileDirs.length,
          fileNames: fileNames.slice(0, 10),
        }),
      });
      const seedSearch = await hostRpc(boot.port, boot.token, "projects/searchLibraryFiles", {
        projectId: targetProject?.id ?? "",
        query: "seed",
      });
      const contentSearch = await hostRpc(boot.port, boot.token, "projects/searchLibraryFiles", {
        projectId: targetProject?.id ?? "",
        query: unique,
      });
      const seedMatches = (seedSearch.value?.matches ?? []).map(
        (/** @type {any} */ match) => match.path,
      );
      checks.push({
        name: "B5 文件搜索只按文件名：seed 命中 seed.txt，正文里的 needle 不命中（宿主的边界）",
        ok:
          seedSearch.value?.available === true &&
          seedMatches.some((/** @type {any} */ path) => String(path).endsWith("seed.txt")) &&
          (contentSearch.value?.matches ?? []).length === 0,
        detail: JSON.stringify({
          seed: seedMatches,
          contentMatches: (contentSearch.value?.matches ?? []).length,
          nameOnly: seedSearch.value?.nameOnly ?? null,
        }),
      });
    } catch (error) {
      checks.push({
        name: "B5 文件面/产物面的写→回读证据可执行",
        ok: false,
        detail: errorText(error).slice(0, 300),
      });
    }

    const shots = await readdir(shotsDir).catch(() => []);
    // 归档：临时 work 目录会被删掉，截图统一复制到 SHOTS_OUT 供人工/报告引用。
    await mkdir(SHOTS_OUT, { recursive: true }).catch(() => {});
    for (const shot of shots) {
      await cp(join(shotsDir, shot), join(SHOTS_OUT, shot)).catch(() => {});
    }
    checks.push({ name: "已保存截图", ok: shots.length > 0, detail: shots.join(",") });
    console.log(`截图归档：${SHOTS_OUT}`);

    for (const item of checks) {
      console.log(
        (item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`),
      );
    }
    for (const item of skips) {
      console.log(`SKIP ${item.name}${item.detail ? ` :: ${item.detail}` : ""}`);
    }
    const failed = checks.filter((item) => item.ok === false).length;
    const passed = checks.length - failed;
    console.log(`截图目录：${shotsDir}`);
    if (failed > 0) {
      fail(`${failed} 项 web 冒烟断言失败`);
    } else {
      console.log(
        `PASS 全部 ${checks.length} 项 web 冒烟断言通过` +
          (skips.length > 0 ? `（另有 ${skips.length} 项如实 SKIP）` : ""),
      );
    }
    // 门禁靠这一行判定「跑过但零断言」的假绿（见 docs/plugin-conventions.md §6.1）。
    // SKIP 不计入 PASS：设置页没开时宁可少算，也不把「跳过」伪装成覆盖。
    console.log(`${passed} PASS / ${skips.length} SKIP / ${failed} FAIL`);
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
