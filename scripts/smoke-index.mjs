#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:index
//       SMOKE_INDEX_URL=<url> pnpm smoke:index  —— 不构建本地索引，直接验**线上**索引源
//                                                 （发版后用；例：jsDelivr 上的 index.json）
//       SMOKE_DEBUG=1 pnpm smoke:index          —— 打印浏览器脚本完整输出
//       SMOKE_KEEP=1 pnpm smoke:index           —— 保留临时 DSH_HOME 与索引文件（排障用）
//
// 索引源的真机验收：`mkdtemp` 出来的临时 DSH_HOME 里启动**真实宿主**，用本仓库的
// 生成器从 npm registry 现场构建索引，再用 ego-browser 在真实「插件 → 发现」页面里
// 验证三件事——
//   1. 添加索引源之后，4 个插件真的出现在发现页，分类、版本都正确；
//   2. 搜索与条目详情可用（详情读的是 npm 上的 README）；
//   3. 格式坏掉的索引会被宿主拒收（`plugin-market/invalid-index`），而不是静默显示空列表。
//
// 环境前提（2026-11-20 实测补充，踩过两次）：
// - **发现页必须是全新的**：临时 profile 是从真实 desktop profile 复制的，而真实 profile 的
//   `cordis.patch.yml` 里可能已经有 `plugin-market` 的 `config.indexes`（用户自己加过索引源）。
//   继承下来会让「发现页空状态 / 添加索引源」两步全部错位（URL 被填进搜索框，后面连环红），
//   所以下面会把这条行整条删掉。
// - **首启「预览版说明」必须关掉**：它会盖住发现页。早先只在页面刚加载时点一次「继续」，
//   弹窗稍晚出现就漏关；现在用 dismissNotice() 轮询到它消失，并作为一条断言。
//
// 边界（有意为之）：
// - **不点「安装」**：本冒烟只读，不会往临时 profile 里装任何东西，也不会发起模型调用。
// - 需要联网：要读 npm registry 的 packument 与 jsDelivr 上的 README。
// - 前置：本机有 `dsh` 与 `ego-browser`；缺任意一个打印 SKIP（退出码 0）。
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildIndex, collectPackages, fetchPackument } from "./build-index.mjs";
import { REPO_ROOT } from "./lib/repo.mjs";
import {
  isFailedRun,
  reclaimTimedOutTaskSpace,
  reportBrowserFailureHint,
  reportFailureScene,
} from "./lib/smoke-failure.mjs";

const exec = promisify(execFile);
const PROFILE = "idx";
const WORKSPACE_TITLE = "index-smoke";
const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
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
    if (/error:/u.test(text)) return { port: 0, token: "", text };
    await sleep(500);
  }
  throw new Error(
    `宿主没有在超时时间内打印访问地址：${(await readIfExists(logPath)).slice(-2000)}`,
  );
}

/**
 * 浏览器脚本（ego-browser nodejs 里执行）。注意内层不能出现 `${}`，一律用字符串拼接。
 * @param {string} url @param {string} shots @param {string} goodIndexUrl @param {string} brokenIndexUrl
 * @param {{ title: string, titles: string[], versions: string[], rewindTitle: string, deleteTitle: string }} expected
 */
function browserScript(url, shots, goodIndexUrl, brokenIndexUrl, expected) {
  return `(async () => {
// 失败/超时也必须关掉 TaskSpace：漏掉的 Page 会占满页面额度，把后续所有 web 冒烟卡到超时。
const checks = [];
let task = null;
let taskFinished = false;
const finishTask = async () => {
  if (taskFinished) return;
  taskFinished = true;
  await task?.finish({ keep: [] }).catch(() => {});
};
try {
task = await taskSpace("dsh smoke: plugin index");
// ego-browser 0.6.3.17 起 task.page(label) 只引用已存在的页；复用的空 space 没有 p1。
// 先拿本 space 的第一个页，没有再新建（旧版本也兼容）。
const page = (await task.pages())[0] ?? (await task.newPage());
const SHOTS = ${JSON.stringify(shots)};
const GOOD = ${JSON.stringify(goodIndexUrl)};
const BROKEN = ${JSON.stringify(brokenIndexUrl)};
// 标题与默认版本从**当前索引文档**派生（线上源会随时间前进，写死版本号会让发版后误报）。
const EXPECTED = ${JSON.stringify(expected)};
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
const skip = (name, reason) => checks.push({ name, ok: true, skip: true, detail: reason });
const shot = (name) => page.screenshot({ path: SHOTS + "/" + name + ".png" }).catch(() => {});
const sleep = (ms) => page.waitForTimeout(ms);
const bodyText = () => page.evaluate(() => document.body.innerText || "");
const hasText = async (needle) => (await bodyText()).indexOf(needle) >= 0;
const waitText = async (needle, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasText(needle)) return true;
    await sleep(250);
  }
  return false;
};
const clickByText = (label, selector) => page.evaluate((arg) => {
  const nodes = [...document.querySelectorAll(arg.selector)];
  const norm = (n) => (n.innerText || n.textContent || "").replace(/\\s+/gu, " ").trim();
  const target =
    nodes.find((n) => norm(n) === arg.label) ||
    nodes.find((n) => norm(n).startsWith(arg.label)) ||
    nodes.find((n) => norm(n).indexOf(arg.label) >= 0);
  if (!target) return false;
  target.click();
  return true;
}, { label, selector });
const CLICKABLE = "a,button,[role=button],[role=tab],[role=menuitem],[role=link],[role=option]";
const click = (label) => clickByText(label, CLICKABLE);
const dialogClick = (label) => page.evaluate((arg) => {
  // 顶层对话框优先（DOM 里最后出现的那个）；先全量找完全匹配，再退回前缀/包含。
  // 不能按「包含」先命中：首启的「开始使用」对话框里有个「添加 API Key」。
  const dialogNodes = [...document.querySelectorAll("[role=dialog],[aria-modal=true]")];
  const scopes = (dialogNodes.length > 0 ? dialogNodes : [document]).reverse();
  const norm = (n) => (n.innerText || n.textContent || "").replace(/\\s+/gu, " ").trim();
  const pick = (predicate) => {
    for (const scope of scopes) {
      const found = [...scope.querySelectorAll("button,[role=button]")].find(predicate);
      if (found) return found;
    }
    return null;
  };
  const target = pick((n) => norm(n) === arg) || pick((n) => norm(n).indexOf(arg) === 0);
  if (!target) return false;
  target.click();
  return true;
}, label);
const waitAnyText = async (needles, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await bodyText();
    const hit = needles.find((needle) => text.indexOf(needle) >= 0);
    if (hit) return hit;
    await sleep(250);
  }
  return "";
};
const closeDialog = () => page.evaluate(() => {
  const dialogs = [...document.querySelectorAll("[role=dialog],[aria-modal=true]")];
  const top = dialogs[dialogs.length - 1];
  if (!top) return false;
  const button = [...top.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "");
  if (!button) return false;
  button.click();
  return true;
});
const fillIndexInput = (value) => page.evaluate((v) => {
  const inputs = [...document.querySelectorAll("input")].filter((i) => !i.disabled && i.type !== "checkbox" && i.type !== "radio");
  const input = inputs.find((i) => i.type === "url" || /索引|index/i.test(i.placeholder || "") || /索引|index/i.test(i.getAttribute("aria-label") || "")) || inputs[inputs.length - 1];
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, v);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.focus();
  return true;
}, value);
const fillSearch = (value) => page.evaluate((v) => {
  // 侧栏也有一个「搜索会话名称」的输入框：先精确找「搜索插件」，别把会话搜索当成市场搜索。
  const inputs = [...document.querySelectorAll("input")];
  const input =
    inputs.find((i) => /搜索插件/u.test(i.placeholder || "")) ||
    inputs.find((i) => /搜索|search/iu.test(i.getAttribute("aria-label") || "")) ||
    inputs.find((i) => /搜索|search/iu.test(i.placeholder || "") && !/会话|session/iu.test(i.placeholder || ""));
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, v);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}, value);

await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });
await sleep(1200);
for (const label of ["继续", "开始使用", "跳过", "关闭", "知道了", "稍后", "稍后配置"]) {
  await click(label).catch(() => {});
  await sleep(120);
}
let ready = false;
for (let i = 0; i < 40; i += 1) {
  ready = await page.evaluate(() => document.readyState === "complete" && !!document.querySelector('[contenteditable="true"]'));
  if (ready) break;
  await sleep(500);
}
check("页面可交互", ready, "");
if (!ready) { console.log("SMOKE_RESULT " + JSON.stringify({ checks }) + " END"); return; }
// 临时 profile 没有模型凭据，首启会弹「开始使用」；关掉它，截图才不被挡住。
await closeDialog().catch(() => {});
await sleep(400);
// 首启「预览版说明」可能比第一次点击晚一拍出现：轮询关掉它，并单独断言。
const dismissNotice = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const present = await page.evaluate(() => /预览版说明/.test(document.body ? document.body.innerText : ""));
    if (!present) return true;
    const clicked = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
      const top = dialogs.find((d) => /预览版说明/.test(d.textContent || "")) || dialogs[dialogs.length - 1];
      if (!top) return false;
      const buttons = [...top.querySelectorAll("button")];
      const button = buttons.find((b) => /继续|知道了|关闭/.test((b.textContent || "").trim()))
        || buttons.find((b) => (b.textContent || "").trim() === "");
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) await click("继续").catch(() => {});
    await sleep(500);
  }
  return !(await page.evaluate(() => /预览版说明/.test(document.body ? document.body.innerText : "")));
};
const noticeClosed = await dismissNotice();
check("首启「预览版说明」已关闭（不挡发现页）", noticeClosed, "");

// 打开侧栏的「插件」页
const openedPlugins = await click("插件");
await sleep(1500);
check(
  "侧栏能打开「插件」页",
  (await waitText("已安装", 8000)) && (await waitText("发现", 5000)),
  JSON.stringify({ openedPlugins }),
);
await shot("01-plugins");

// 切到「发现」：市场 bundle 已启用才有这个页签
await click("发现");
await sleep(1200);
await click("稍后配置").catch(() => {});
await sleep(300);
await dismissNotice();
const emptyState = await waitText("添加索引源", 8000);
check("发现页有空状态与「添加索引源」入口", emptyState, "");
await shot("02-empty");

// 负向用例先做：在同一个「索引源」对话框里加一个版本号写坏的索引，宿主必须拒收。
// 添加成功后对话框不会自己关，所以两个源都在同一个对话框里连续填。
const openDialog = async () => {
  for (const label of ["添加索引源", "管理索引源…"]) {
    if (await click(label)) return true;
    await sleep(300);
  }
  return false;
};
const dialogOpen = await openDialog();
await sleep(600);
const filledBroken = await fillIndexInput(BROKEN);
check("添加索引源的对话框能填 URL", dialogOpen && filledBroken, JSON.stringify({ dialogOpen, filledBroken }));
await dialogClick("添加");
await sleep(500);
const brokenReason = await waitAnyText(["格式无效", "无法读取此索引", "无法读取索引源", "无法读取此索引源"], 10000);
check("坏索引被宿主拒收（invalid-index 而不是空列表）", brokenReason !== "", JSON.stringify({ brokenReason }));
await shot("03-broken");

// 正向：同一个对话框里再填真正的索引源，4 个插件都要出现
const filledGood = await fillIndexInput(GOOD);
await dialogClick("添加");
await sleep(800);
await closeDialog();
await sleep(800);
const listReady = await waitText(EXPECTED.title, 20000);
check("索引标题出现在发现页", listReady, JSON.stringify({ filledGood, title: EXPECTED.title }));
await shot("04-list");

const titles = EXPECTED.titles;
const present = [];
for (const title of titles) present.push(await hasText(title));
check("4 个插件都在列表里", present.every(Boolean), JSON.stringify({ present }));
check("分类 pill 有 会话 / 工作流 / 工具", (await hasText("会话")) && (await hasText("工作流")) && (await hasText("工具")), "");
const versions = EXPECTED.versions;
const versionChecks = [];
for (const version of versions) versionChecks.push(await hasText(version));
check("卡片展示默认版本（4 个都在）", versionChecks.every(Boolean), JSON.stringify({ versionChecks }));

// 搜索：输入 rewind 只该剩 session-rewind
await fillSearch("rewind");
await sleep(1200);
const searched = await page.evaluate(() => document.body.innerText || "");
check(
  "搜索 rewind 只剩 会话回滚",
  searched.indexOf(EXPECTED.rewindTitle) >= 0 && searched.indexOf(EXPECTED.deleteTitle) < 0,
  JSON.stringify(searched.slice(0, 200)),
);
await shot("05-search");
await fillSearch("");
await sleep(1200);

// 打开条目详情：来源事实与安装入口都要在，正文来自 npm 上的 README
await click("会话删除");
await sleep(2500);
const detail = await waitText("安装", 15000);
const detailFacts = await hasText("仓库") || await hasText("软件包");
check("条目详情页有安装入口与来源事实", detail && detailFacts, JSON.stringify({ detail, detailFacts }));
check("详情正文来自 README（出现 session 相关文字）", /session/iu.test(await bodyText()), "");
await shot("06-detail");

console.log("SMOKE_RESULT " + JSON.stringify({ checks }) + " END");
} catch (error) {
console.log("SMOKE_RESULT " + JSON.stringify({ checks, fatal: String((error && error.stack) || error).slice(0, 1200) }) + " END");
} finally {
await finishTask();
}
})();`;
}

const main = async () => {
  // 早退也必须打印计数行（pnpm check 的静态规则会拦；见 docs/plugin-conventions.md §6.1）。
  if (!(await hasCommand("dsh"))) {
    console.log("SKIP 未找到 dsh");
    console.log("0 PASS / 1 SKIP / 0 FAIL");
    return;
  }
  if (!(await hasCommand("ego-browser"))) {
    console.log("SKIP 未找到 ego-browser");
    console.log("0 PASS / 1 SKIP / 0 FAIL");
    return;
  }

  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-index-"));
  const realHome = process.env.HOME ?? "";
  /** @type {import("node:http").Server | undefined} */
  let server;
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  /** @type {import("node:fs").WriteStream | undefined} */
  let hostLog;
  try {
    // 1) 索引来源：默认现场构建（生成器是对外承诺的一部分）；SMOKE_INDEX_URL 则直接验线上源
    //    （发版后用它验证 registry → jsDelivr 这条真实链路）。
    const liveUrl = (process.env.SMOKE_INDEX_URL ?? "").trim();
    /** @type {any} */
    let index;
    /** @type {string} */
    let goodBody;
    if (liveUrl !== "") {
      let response;
      try {
        response = await fetch(liveUrl, { signal: AbortSignal.timeout(20_000) });
      } catch (error) {
        throw new Error(
          `SMOKE_INDEX_URL 取不到（${liveUrl}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) throw new Error(`SMOKE_INDEX_URL 返回 HTTP ${response.status}：${liveUrl}`);
      goodBody = await response.text();
      try {
        index = JSON.parse(goodBody);
      } catch {
        throw new Error(`SMOKE_INDEX_URL 返回的不是 JSON：${liveUrl}`);
      }
      if (!Array.isArray(index?.plugins) || index.plugins.length === 0) {
        throw new Error(`SMOKE_INDEX_URL 的文档里没有 plugins：${liveUrl}`);
      }
      console.log(`索引来源：线上地址 ${liveUrl}（${index.plugins.length} 个插件）`);
    } else {
      const meta = JSON.parse(
        await readFile(join(REPO_ROOT, "scripts", "index-meta.json"), "utf8"),
      );
      const manifests = collectPackages(REPO_ROOT);
      /** @type {Map<string, any>} */
      const packuments = new Map();
      for (const manifest of manifests)
        packuments.set(manifest.name, await fetchPackument(manifest.name));
      index = buildIndex({ manifests, meta, packuments });
      goodBody = `${JSON.stringify(index)}\n`;
      console.log(`索引已构建：${index.plugins.length} 个插件`);
    }

    /** 文档里每个插件：name + title + versions（默认版本 = versions[0]）。 @param {string} name @returns {any} */
    const pluginEntry = (name) =>
      /** @type {any[]} */ (index.plugins).find((/** @type {any} */ item) => item?.name === name);
    /** @type {Record<string, string>} */
    const EXPECTED_NAMES = {
      delete: "@kangyishuai/dsh-session-delete",
      rewind: "@kangyishuai/dsh-session-rewind",
      nextStep: "@kangyishuai/dsh-next-step",
      advisor: "@kangyishuai/dsh-advisor",
    };
    /** @type {Record<string, { title: string, version: string }>} */
    const derived = {};
    for (const [key, name] of Object.entries(
      /** @type {Record<string, string>} */ (EXPECTED_NAMES),
    )) {
      const entry = pluginEntry(name);
      if (entry === undefined) {
        throw new Error(
          `索引里没有 ${name}（现有：${/** @type {any[]} */ (index.plugins).map((/** @type {any} */ item) => item?.name).join(", ")}）`,
        );
      }
      const zhTitle = entry.title?.zh ?? entry.title?.en ?? "";
      const version = entry.versions?.[0]?.version ?? "";
      if (zhTitle === "" || version === "")
        throw new Error(
          `${name} 缺少标题或版本：${JSON.stringify(entry.title)} / ${JSON.stringify(entry.versions?.[0])}`,
        );
      derived[key] = { title: zhTitle, version };
    }
    const expected = {
      title: index.title?.zh ?? index.title?.en ?? "",
      titles: [
        derived.delete.title,
        derived.rewind.title,
        derived.nextStep.title,
        derived.advisor.title,
      ],
      versions: [
        derived.delete.version,
        derived.rewind.version,
        derived.nextStep.version,
        derived.advisor.version,
      ],
      rewindTitle: derived.rewind.title,
      deleteTitle: derived.delete.title,
    };
    if (expected.title === "") throw new Error("索引文档缺少 title");

    const broken = JSON.parse(goodBody);
    broken.plugins[0].versions[0].version = "1.0"; // 非精确 SemVer：宿主必须拒收整份文档
    const brokenBody = `${JSON.stringify(broken)}\n`;

    // 2) 本地 http 服务：宿主接受 http: 索引源，正好省掉一次外部部署
    /** @type {{ good: string, broken: string }} */
    const urls = { good: "", broken: "" };
    server = createServer((request, response) => {
      if (request.url === "/index.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(goodBody);
        return;
      }
      if (request.url === "/broken.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(brokenBody);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    });
    await new Promise((/** @type {(value?: unknown) => void} */ done) =>
      server?.listen(0, "127.0.0.1", done),
    );
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    // 线上模式：GOOD 直接用 SMOKE_INDEX_URL；坏索引仍由本地服务提供（格式错乱只用于拒收断言）。
    urls.good = liveUrl !== "" ? liveUrl : `http://127.0.0.1:${address.port}/index.json`;
    urls.broken = `http://127.0.0.1:${address.port}/broken.json`;
    await writeFile(join(work, "index.json"), goodBody);
    console.log(`索引地址：${urls.good}`);

    // 3) 临时 DSH_HOME：复制 desktop profile，只保留宿主自带的 bundle
    const home = join(work, "home");
    const profile = join(home, "profiles", PROFILE);
    const workspaceDirRaw = join(work, "workspace");
    await mkdir(workspaceDirRaw, { recursive: true });
    const workspaceDir = await realpath(workspaceDirRaw);
    await mkdir(profile, { recursive: true });
    await cp(join(realHome, ".dsh", "profiles", "desktop"), profile, { recursive: true });
    await rm(join(profile, "node_modules"), { recursive: true, force: true });
    await rm(join(profile, "pnpm-lock.yaml"), { force: true });
    // 真实 profile 的 patch 可能带 `- id: plugin-market` + `config.indexes`（用户加过索引源）。
    // 继承下来会让「全新发现页」这一前提不成立：整条删掉，交给 market bundle 用默认配置挂载。
    const patchPath = join(profile, "cordis.patch.yml");
    const patchText = await readFile(patchPath, "utf8").catch(() => "");
    if (patchText.includes("plugin-market")) {
      const kept = [];
      let skipping = false;
      for (const line of patchText.split("\n")) {
        if (/^- id: plugin-market\s*$/.test(line)) {
          skipping = true;
          continue;
        }
        if (skipping && /^- /.test(line)) skipping = false;
        if (!skipping) kept.push(line);
      }
      await writeFile(patchPath, kept.join("\n"), "utf8");
      console.log("已从临时 profile 的 patch 里删掉 plugin-market 行（避免继承用户的索引源）");
    }

    const profilePath = join(profile, "package.json");
    const profileJson = JSON.parse(await readFile(profilePath, "utf8"));
    profileJson.name = `dsh-profile-${PROFILE}-smoke`;
    profileJson.dependencies = {};
    const bundles = Array.isArray(profileJson.dsh?.profile?.bundles)
      ? profileJson.dsh.profile.bundles.filter(
          (/** @type {unknown} */ entry) =>
            typeof entry === "string" && entry.startsWith("@deepseek-ai/"),
        )
      : [];
    // 发现页由这个实验性 bundle 提供；桌面 profile 若没开，就在临时 profile 里补上。
    const MARKET = "@deepseek-ai/dsh-experimental-plugin-market-bundle";
    if (!bundles.includes(MARKET)) bundles.push(MARKET);
    profileJson.dsh = { ...profileJson.dsh, profile: { ...profileJson.dsh?.profile, bundles } };
    await writeFile(profilePath, `${JSON.stringify(profileJson, null, 2)}\n`);

    // 4) 工作区存储指向临时目录
    await mkdir(join(home, "storages"), { recursive: true });
    /** @type {any} */
    let unit = { name: "workspace", version: 2 };
    try {
      const real = JSON.parse(
        await readFile(join(realHome, ".dsh", "storages", "workspace.json"), "utf8"),
      );
      if (real?.unit) unit = real.unit;
    } catch {
      /* 用默认 unit */
    }
    const now = new Date().toISOString();
    await writeFile(
      join(home, "storages", "workspace.json"),
      `${JSON.stringify(
        {
          unit,
          global: {
            initialized: true,
            defaultWorkspaceId: WORKSPACE_ID,
            workspaceIds: [WORKSPACE_ID],
            archivedSessionIds: [],
            pinnedSessionIds: [],
          },
          tables: {
            workspaces: {
              [WORKSPACE_ID]: {
                path: workspaceDir,
                title: WORKSPACE_TITLE,
                sessionIds: [],
                createdAt: now,
                updatedAt: now,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // 5) 启动真实宿主
    const env = { ...process.env, DSH_HOME: home };
    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    hostLog = createWriteStream(logPath, { flags: "w" });
    host.stdout?.on("data", (/** @type {any} */ chunk) => hostLog?.write(String(chunk)));
    host.stderr?.on("data", (/** @type {any} */ chunk) => hostLog?.write(String(chunk)));
    const boot = await waitForBoot(logPath, 120_000);
    if (boot.port === 0) {
      fail("宿主启动失败");
      console.error(boot.text.slice(-3000));
      return;
    }
    console.log(`宿主已启动：http://127.0.0.1:${boot.port}`);

    // 6) 用 ego-browser 在真实页面里验收
    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    await writeFile(
      browserFile,
      browserScript(
        `http://127.0.0.1:${boot.port}/?token=${boot.token}`,
        shotsDir,
        urls.good,
        urls.broken,
        expected,
      ),
    );
    // 外部超时标记：ego-browser 被 kill 时浏览器脚本没机会跑 finally，需要 Node 侧兜底回收。
    let timedOut = false;
    const raw = await new Promise((/** @type {(value: string) => void} */ done) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 420_000);
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (out += String(chunk)));
      child.on("close", () => {
        clearTimeout(timer);
        done(out);
      });
      void readFile(browserFile).then((buffer) => child.stdin.end(buffer));
    });
    if (timedOut) await reclaimTimedOutTaskSpace("dsh smoke: plugin index");
    if (process.env.SMOKE_DEBUG) console.log(String(raw).slice(-12000));

    const match = String(raw).match(/SMOKE_RESULT (\{.*?\}) END/u);
    if (!match) {
      fail("浏览器脚本没有返回结果");
      console.error(String(raw).slice(-4000));
      reportBrowserFailureHint();
      return;
    }
    const result = JSON.parse(match[1]);
    /** @type {{ name: string, ok: boolean, detail: string, skip?: boolean }[]} */
    const checks = result.checks ?? [];
    // fatal 不能只设 exitCode 就继续算 PASS：把它记成一条失败断言，计数行才诚实。
    if (result.fatal) {
      reportBrowserFailureHint();
      checks.push({
        name: "浏览器脚本异常（未预期）",
        ok: false,
        detail: String(result.fatal).slice(0, 1200),
      });
    }
    for (const check of checks) {
      if (check.skip) console.log(`SKIP ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`);
      else if (check.ok)
        console.log(`PASS ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`);
      else fail(`${check.name} :: ${check.detail}`);
    }
    const failed = checks.filter((check) => !check.ok && !check.skip).length;
    const skipped = checks.filter((check) => check.skip).length;
    console.log(`截图目录：${shotsDir}`);
    if (failed > 0) fail(`${failed} 项失败（共 ${checks.length} 项，SKIP ${skipped}）`);
    else
      console.log(
        `PASS 全部 ${checks.length - skipped} 项真机断言通过${skipped ? `（另有 ${skipped} 项 SKIP）` : ""}`,
      );
    // 门禁靠这一行判定「跑过但零断言」的假绿（见 docs/plugin-conventions.md §6.1）。
    console.log(`${checks.length - skipped} PASS / ${skipped} SKIP / ${failed} FAIL`);
  } catch (error) {
    if (process.env.SMOKE_DEBUG) console.error(error);
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    hostLog?.end();
    await new Promise((/** @type {(value?: unknown) => void} */ done) =>
      server ? server.close(done) : done(),
    );
    await sleep(500);
    const keep = process.env.SMOKE_KEEP === "1" || isFailedRun();
    if (keep) {
      // §6.4：失败必须留现场——先把宿主日志尾部打出来，再报保留路径（host.log 在临时目录里）。
      if (isFailedRun()) await reportFailureScene(join(work, "host.log"));
      console.log(
        `临时目录已保留${isFailedRun() ? "（因为这次失败，方便排查；删掉即可）" : "（SMOKE_KEEP=1）"}：${work}`,
      );
      console.log("      host.log、index.json、shots 都在这个目录里");
    } else {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
};

await main();
