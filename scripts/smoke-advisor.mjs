#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:advisor
//       SMOKE_DEBUG=1 pnpm smoke:advisor    —— 打印浏览器脚本完整输出
//       SMOKE_KEEP=1 pnpm smoke:advisor     —— 保留临时 DSH_HOME（排障用）
//
// web 端到端冒烟：`mkdtemp` 出来的临时 DSH_HOME 里启动**真实宿主**，装当前源码打出的包，
// 再用 ego-browser 在真实页面里验证「插件装得上、命令注册了、设置卡渲染了、且什么都没花」。
//
// 边界（有意为之）：
// - **不发起任何模型调用**：本脚本不运行工具、不点「保存」，因此不会产生账本行。
//   命令输出以会话日志的 `command/done.data.text` 为准（宿主的命令卡片在 DOM 里是折叠的）。
// - 无模型凭据也能跑：只验证插件接线与设置面。
// - 临时 home 里只放一个临时工作区；跑完删除（SMOKE_KEEP=1 除外）。
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { NOTICE_DISMISS_SOURCE } from "./lib/browser-helpers.mjs";
import {
  isFailedRun,
  reclaimTimedOutTaskSpace,
  reportBrowserFailureHint,
  reportFailureScene,
} from "./lib/smoke-failure.mjs";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-advisor-shots");
const PKG_DIR = join(REPO, "packages", "advisor");
const PACKAGE = "@kangyishuai/dsh-advisor";
const PROFILE = "adv";
const WORKSPACE_TITLE = "advisor-smoke";
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
 * @param {string} logPath
 * @param {number} timeoutMs
 */
async function waitForBoot(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readIfExists(logPath);
    const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/u);
    if (match) {
      return { port: Number(match[1]), token: match[2], activationFailures: 0, text };
    }
    if (/error:/u.test(text)) return { port: 0, token: "", activationFailures: 1, text };
    await sleep(500);
  }
  throw new Error(
    `宿主没有在超时时间内打印访问地址：${(await readIfExists(logPath)).slice(-2000)}`,
  );
}

/**
 * 浏览器脚本（ego-browser nodejs 里执行）。注意内层不能出现 `${}`，一律用字符串拼接。
 * @param {string} url @param {string} shots
 */
function browserScript(url, shots) {
  return `(async () => {
// 失败/超时也必须关掉 TaskSpace：漏掉的 Page 会占满页面额度，把后续所有 web 冒烟卡到超时。
// 主体放进 try，finish 放 finally；错误输出仍然带结果行，Node 侧按 fatal 判失败。
const checks = [];
let task = null;
let taskFinished = false;
const finishTask = async () => {
  if (taskFinished) return;
  taskFinished = true;
  await task?.finish({ keep: [] }).catch(() => {});
};
try {
task = await taskSpace("dsh smoke: advisor");
const page = task.page("p1");
const SHOTS = ${JSON.stringify(shots)};
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
const skip = (name, reason) => checks.push({ name, ok: true, skip: true, detail: reason });
const shot = (name) => page.screenshot({ path: SHOTS + "/" + name + ".png" }).catch(() => {});

await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
// 首启引导：能点掉的按钮都点掉（不点会挡住输入框）
for (const label of ["继续", "开始使用", "跳过", "关闭", "知道了"]) {
  await page.evaluate((text) => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
    if (btn) btn.click();
  }, label).catch(() => {});
  await page.waitForTimeout(150);
}
// 2026-11-20 实测：弹窗可能比第一次点击晚一拍出现，一次性点会漏关，然后输入框被盖住 →
// 斜杠菜单空、设置打不开（5 条断言连环红）。改成轮询到它真正消失，并单独断言（与索引冒烟同一修法）。
${NOTICE_DISMISS_SOURCE}

// 等页面可交互
let ready = false;
for (let i = 0; i < 40; i += 1) {
  ready = await page.evaluate(() => document.readyState === "complete" && !!document.querySelector('[contenteditable="true"]'));
  if (ready) break;
  await page.waitForTimeout(500);
}
check("页面可交互（输入框存在）", ready, "");
if (!ready) { console.log("SMOKE_RESULT " + JSON.stringify({ checks })); return; }
const noticeClosed = await dismissNotice();
check("首启「预览版说明」已关闭（不挡输入框）", noticeClosed, "");
await page.waitForTimeout(300);

// 1) 插件 client 半已加载
const pluginStyles = await page.evaluate(() => [...document.querySelectorAll("style[data-plugin]")].map((s) => s.getAttribute("data-plugin")).filter((v) => v && v.indexOf("advisor") >= 0));
check("插件 client 半已加载（style[data-plugin]）", pluginStyles.length > 0, JSON.stringify(pluginStyles));
await shot("01-loaded");

// 2) 斜杠菜单里有 advisor（证明 commands.register 生效）
const focusComposer = async () => {
  await page.evaluate(() => {
    const el = document.querySelector('[contenteditable="true"]');
    if (el) { el.focus(); el.click(); }
  });
  await page.waitForTimeout(250);
};
const clearComposer = async () => {
  await focusComposer();
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
};
await focusComposer();
await page.keyboard.type("/");
await page.waitForTimeout(900);
let menuItems = await page.evaluate(() => [...document.querySelectorAll('[role="option"],[role="menuitem"]')].map((n) => (n.innerText || "").replace(/\\s+/g, " ").slice(0, 60)));
if (!menuItems.some((t) => /advisor/i.test(t))) {
  // 手势断言留一次重试：刚关掉弹窗时焦点可能还差一拍（不降低断言，仍要求菜单真的出现）。
  await page.keyboard.press("Escape").catch(() => {});
  await clearComposer();
  await dismissNotice().catch(() => false);
  await focusComposer();
  await page.keyboard.type("/");
  await page.waitForTimeout(1200);
  menuItems = await page.evaluate(() => [...document.querySelectorAll('[role="option"],[role="menuitem"]')].map((n) => (n.innerText || "").replace(/\\s+/g, " ").slice(0, 60)));
}
check("/ 菜单里出现 advisor（命令已注册）", menuItems.some((t) => /advisor/i.test(t)), JSON.stringify(menuItems.slice(0, 12)));
await page.keyboard.press("Escape");
await clearComposer();
await shot("02-command-menu");

// 3) 开一个会话（命令需要 agent），再逐条跑命令；输出以会话日志为准
const newSession = async () => page.evaluate(() => {
  const b = [...document.querySelectorAll("button,[role=button]")].find((x) => (x.getAttribute("aria-label") || "") === "新建会话");
  if (b) { b.click(); return true; }
  return false;
});
const created = await newSession();
await page.waitForTimeout(2500);
await focusComposer();
const draftOk = await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  return el ? (el.textContent || "").length === 0 : false;
});
check("可以新建会话并拿到空输入框", created && draftOk, JSON.stringify({ created, draftOk }));

const runCommand = async (line) => {
  await clearComposer();
  await focusComposer();
  await page.keyboard.type(line);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1800);
};
if (created) {
  for (const line of ["/advisor doctor", "/advisor preview", "/advisor report all", "/advisor confirm"]) {
    await runCommand(line);
  }
  await shot("03-commands");
} else {
  skip("命令执行（doctor/preview/report/confirm）", "没有新建出会话，命令会被丢弃");
}

// 4) 设置页卡片
const openSettings = async () => {
  const openedMenu = await page.evaluate(() => {
    const acc = [...document.querySelectorAll("button,[role=button]")].find((b) => (b.textContent || "").trim().startsWith("nano"))
      || [...document.querySelectorAll("[aria-label]")].find((b) => /账号|Account/.test(b.getAttribute("aria-label") || ""));
    if (!acc) return false;
    acc.click();
    return true;
  });
  if (!openedMenu) return "no-account";
  await page.waitForTimeout(600);
  const clicked = await page.evaluate(() => {
    const s = [...document.querySelectorAll("[role=menuitem],button")].find((x) => (x.textContent || "").trim().startsWith("设置"));
    if (!s) return false;
    s.click();
    return true;
  });
  if (!clicked) return "no-settings";
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[role=tab],button")].find((x) => (x.textContent || "").trim() === "顾问");
    if (tab) tab.click();
  });
  await page.waitForTimeout(1800);
  return "ok";
};
const settingsState = await openSettings();
if (settingsState !== "ok") {
  skip("设置卡渲染", "打不开设置：" + settingsState);
} else {
  const card = await page.evaluate(() => {
    const root = document.querySelector("[data-advisor-settings]");
    if (!root) return { found: false };
    return {
      found: true,
      error: !!root.querySelector("[data-advisor-error]"),
      compact: root.querySelector("[data-advisor-off]") !== null,
      configure: root.querySelector("[data-advisor-configure]") !== null,
      providerVisible: root.querySelector("[data-advisor-provider]") !== null,
      advancedClosed: root.querySelector('[data-advisor-disclosure="advanced"]') === null,
      summaryRows: root.querySelectorAll("[data-advisor-summary] .dsh-advisor-summary-row").length,
      moreClosed: root.querySelector('[data-advisor-disclosure="more"]') === null,
    };
  });
  check(
    "设置卡默认是 off 紧凑态（不铺开 provider / 预算 / 隐私）",
    card.found &&
      card.error === false &&
      card.compact === true &&
      card.configure === true &&
      card.providerVisible === false &&
      card.advancedClosed === true &&
      card.moreClosed === true &&
      card.summaryRows === 3,
    JSON.stringify(card),
  );
  await page.evaluate(() => {
    const root = document.querySelector("[data-advisor-settings]");
    if (root) root.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
  await shot("04-settings-compact");

  // 只展开，不改任何值：点「配置顾问」显示表单，再点开高级与状态两个折叠区。
  await page.evaluate(() => {
    const configure = document.querySelector("[data-advisor-configure]");
    if (configure) configure.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    // 「更多设置」默认收起（首屏只留模式/路由/预算三行），先展开它。
    const more = document.querySelector('[data-advisor-disclosure-toggle="more"]');
    if (more) more.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const key of ["advanced", "status"]) {
      const toggle = document.querySelector('[data-advisor-disclosure-toggle="' + key + '"]');
      if (toggle) toggle.click();
    }
  });
  await page.waitForTimeout(500);

  const expanded = await page.evaluate(() => {
    const root = document.querySelector("[data-advisor-settings]");
    if (!root) return { found: false };
    const text = root.innerText || "";
    return {
      found: true,
      error: !!root.querySelector("[data-advisor-error]"),
      providers: root.querySelectorAll("[data-advisor-provider] option").length,
      hasBudget: text.indexOf("每日预算") >= 0,
      hasPrivacy: text.indexOf("发送范围") >= 0,
      hasPreview: text.indexOf("预览") >= 0,
      hasWorkspace: text.indexOf("工作区每日调用上限") >= 0,
      hasAllowlist: text.indexOf("模型白名单") >= 0,
      helpButtons: root.querySelectorAll(".dsh-advisor-help-btn").length,
    };
  });
  check(
    "设置卡展开后有 provider 候选、基础/高级/状态字段与按需帮助",
    expanded.found &&
      expanded.error === false &&
      expanded.providers > 0 &&
      expanded.hasBudget &&
      expanded.hasPrivacy &&
      expanded.hasPreview &&
      expanded.hasWorkspace &&
      expanded.hasAllowlist &&
      expanded.helpButtons > 0,
    JSON.stringify(expanded),
  );
  await page.evaluate(() => {
    const root = document.querySelector("[data-advisor-settings]");
    if (root) root.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
  await shot("05-settings-expanded");

  // 点开第一个「?」：说明必须真的展开，且是内联块，不是只靠 title 悬停。
  await page.evaluate(() => {
    const button = document.querySelector("[data-advisor-settings] .dsh-advisor-help-btn");
    if (button) button.click();
  });
  await page.waitForTimeout(300);
  const help = await page.evaluate(() => {
    const body = document.querySelector("[data-advisor-settings] .dsh-advisor-help-body");
    return {
      open: body !== null,
      text: body === null ? "" : (body.innerText || "").replace(/\\s+/gu, " ").trim().slice(0, 160),
    };
  });
  check("高级字段的「?」能展开内联说明", help.open === true && help.text.length > 0, JSON.stringify(help));
  await shot("06-settings-help");
  await page.evaluate(() => {
    const d = document.querySelector("[role=dialog]");
    const close = d ? [...d.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
    if (close) close.click();
  });
  // 关闭是异步的（动画 + 焦点归还）：轮询 3s，仍不开再按 Esc，最后按「卡片是否还在」判定。
  let closed = false;
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(300);
    // 只判定「设置卡片消失」：临时 profile 没有凭据时，宿主会紧接着弹首次配置凭据的对话框，
    // 那是宿主的正常行为，不该算本插件的失败。
    closed = await page.evaluate(() => !document.querySelector("[data-advisor-settings]"));
    if (closed) break;
    if (i === 5) await page.keyboard.press("Escape").catch(() => {});
  }
  const closeState = await page.evaluate(() => {
    const d = document.querySelector("[role=dialog]");
    return {
      otherDialog: !!d,
      card: !!document.querySelector("[data-advisor-settings]"),
      buttons: d ? [...d.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 8) : [],
    };
  });
  check("设置卡片已关闭（其他对话框由宿主自己决定）", closed, JSON.stringify(closeState));
}

console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
} catch (error) {
console.log("SMOKE_RESULT " + JSON.stringify({ checks, fatal: String((error && error.stack) || error).slice(0, 1200) }));
} finally {
await finishTask();
}
})();`;
}

/**
 * 从临时 DSH_HOME 里读会话日志，抽出 `command/done` 的文本，并带回**读取诊断**。
 *
 * 为什么带诊断：本轮回归出现过「命令确实执行了（页面里有卡片）但这里读出来是空」。
 * 记下扫到的日志文件、事件数、日志尾部，失败时才能分清「命令没执行」还是「日志没 flush /
 * 扫错目录 / 解压失败」。文件名按 `session.v*` 前缀匹配，不写死 v4（AGENTS.md 硬性约定 1）。
 * @param {string} home
 * @returns {Promise<{ outputs: string[], files: string[], events: number, tail: string }>}
 */
async function readCommandOutputs(home) {
  const root = join(home, "sessions");
  /** @type {string[]} */
  const files = [];
  const walk = async (/** @type {string} */ dir, /** @type {number} */ depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (/^session\.v\d+\.jsonl.*$/u.test(entry.name)) files.push(path);
    }
  };
  await walk(root, 0);
  /** @type {string[]} */
  const outputs = [];
  /** @type {string[]} */
  const scanned = [];
  let events = 0;
  /** @type {string} */
  let raw = "";
  for (const file of files) {
    scanned.push(file.slice(root.length + 1));
    let text = "";
    try {
      const buffer = await readFile(file);
      if (file.endsWith(".zstd")) {
        // DSH 的日志是「一帧头 + 每批事件一帧」，按 zstd 魔数切帧逐帧解。
        const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
        let start = buffer.indexOf(magic);
        while (start >= 0) {
          const next = buffer.indexOf(magic, start + 4);
          const frame = buffer.subarray(start, next < 0 ? buffer.length : next);
          try {
            text += zstdDecompressSync(frame).toString("utf8");
          } catch {
            /* 跳过坏帧 */
          }
          if (next < 0) break;
          start = next;
        }
      } else {
        text = buffer.toString("utf8");
      }
    } catch {
      continue;
    }
    raw += text;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      /** @type {any} */
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events += 1;
      if (event?.type !== "command/done") continue;
      const value = event?.data?.text;
      if (typeof value === "string" && value !== "") outputs.push(value);
    }
  }
  const trimmed = raw.trim();
  return {
    outputs,
    files: scanned,
    events,
    tail: trimmed.length > 600 ? trimmed.slice(-600) : trimmed,
  };
}

/**
 * 一行日志读取诊断：files/events/tail，便于判「命令没执行」还是「日志读不到」。
 * @param {{ files: string[], events: number, tail: string }} log
 * @returns {string}
 */
function commandLogDiagnostics(log) {
  return `files=[${log.files.join(",")}] events=${log.events} tail=${JSON.stringify(
    String(log.tail).replace(/\s+/gu, " ").slice(-260),
  )}`;
}

const main = async () => {
  // 早退也必须打印计数行：gate <plugin> 与 gate:all 都按它判「跑过但零断言」的假绿
  // （docs/plugin-conventions.md §6.1 / AUD-XCT-05）。缺环境时这里是 0 PASS / 1 SKIP。
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

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-advisor-"));
  const realHome = process.env.HOME ?? "";
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  /** @type {import("node:fs").WriteStream | undefined} */
  let hostLog;
  try {
    const home = join(work, "home");
    const profile = join(home, "profiles", PROFILE);
    const workspaceDirRaw = join(work, "workspace");
    await mkdir(workspaceDirRaw, { recursive: true });
    const workspaceDir = await realpath(workspaceDirRaw);
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

    // 只放一个工作区，指向临时目录
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

    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");

    const env = { ...process.env, DSH_HOME: home };
    await run("dsh", ["plugin", "--profile", PROFILE, "install"], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", PROFILE, "remove", PACKAGE], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", PROFILE, "add", join(work, tgz)], { env });

    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    hostLog = createWriteStream(logPath, { flags: "w" });
    host.stdout?.on("data", (/** @type {any} */ c) => {
      hostLog?.write(String(c));
    });
    host.stderr?.on("data", (/** @type {any} */ c) => {
      hostLog?.write(String(c));
    });

    const boot = await waitForBoot(logPath, 120_000);
    if (boot.activationFailures > 0) {
      fail("宿主启动失败或有插件未激活");
      console.error(boot.text.slice(-3000));
      return;
    }
    console.log(`宿主已启动：http://127.0.0.1:${boot.port}`);

    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const source = browserScript(`http://127.0.0.1:${boot.port}/?token=${boot.token}`, shotsDir);
    if (process.env.SMOKE_DEBUG)
      console.log(
        "browserScript:",
        typeof source,
        typeof source === "string" ? source.length : String(source),
      );
    await writeFile(browserFile, source);

    // 外部超时标记：ego-browser 被 kill 时浏览器脚本没机会跑 finally，需要 Node 侧兜底回收。
    let timedOut = false;
    const raw = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 300_000);
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
    if (timedOut) await reclaimTimedOutTaskSpace("dsh smoke: advisor");
    if (process.env.SMOKE_DEBUG) console.log(String(raw).slice(-12000));

    const match = String(raw).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果（页面/浏览器层没就绪）");
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

    // Node 侧断言：命令输出（以会话日志为准）与「什么都没花」
    const log = await readCommandOutputs(home);
    const joined = log.outputs.join("\n");
    /** 读取为空时的可诊断明细：命令执行了但日志读不到，是本轮回归出现过的形态。 */
    const logDetail = joined === "" ? `；日志读取诊断：${commandLogDiagnostics(log)}` : "";
    if (joined === "") {
      console.log(`日志读取诊断（命令输出为空）：${commandLogDiagnostics(log)}`);
      console.log(
        "      （页面里有命令卡片但这里读不到 = 日志没 flush / 扫错目录；页面也没有 = 命令没执行）",
      );
    }
    checks.push({
      name: "/advisor doctor 有结论（日志）",
      ok: /(✅|⚠️|❌)/u.test(joined),
      detail: joined.slice(0, 200) + logDetail,
    });
    checks.push({
      name: "/advisor preview 有预览（日志）",
      ok: /目标[:：]|将发送/u.test(joined),
      detail: logDetail,
    });
    checks.push({
      name: "/advisor confirm 有回执（日志）",
      ok: /已允许|还没选顾问模型/u.test(joined),
      detail: logDetail,
    });
    checks.push({
      name: "/advisor report all 有输出（日志）",
      ok: /顾问报告|还没有任何建议记录/u.test(joined),
      detail: logDetail,
    });
    const ledger = await readIfExists(join(home, "advisor", "usage.jsonl"));
    const advice = await readIfExists(join(home, "advisor", "advice.jsonl"));
    checks.push({
      name: "整段冒烟没有产生账本行（未发起模型调用）",
      ok: ledger === "" && advice === "",
      detail: `usage=${ledger.length}B advice=${advice.length}B`,
    });

    // 决策日志：一个回合一行。本冒烟不发真实回合，所以文件可能不存在；
    // 这里只守住「存在就必须是每行一个合法 JSON」这个格式约定。
    const decisions = await readIfExists(join(home, "advisor", "decisions.jsonl"));
    let decisionsValid = true;
    if (decisions !== "") {
      for (const line of decisions.split("\n")) {
        if (line.trim() === "") continue;
        try {
          JSON.parse(line);
        } catch (_error) {
          decisionsValid = false;
        }
      }
    }
    checks.push({
      name: "决策日志格式合法（每行一个 JSON）",
      ok: decisionsValid,
      detail:
        decisions === "" ? "本冒烟未产生回合，文件不存在（符合预期）" : `${decisions.length}B`,
    });

    for (const check of checks) {
      if (check.skip) console.log(`SKIP ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`);
      else if (check.ok)
        console.log(`PASS ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`);
      else fail(`${check.name} :: ${check.detail}`);
    }
    const failed = checks.filter((c) => !c.ok && !c.skip).length;
    const skipped = checks.filter((c) => c.skip).length;
    console.log(`截图目录：${shotsDir}`);
    if (failed > 0) fail(`${failed} 项失败（共 ${checks.length} 项，SKIP ${skipped}）`);
    else
      console.log(
        `PASS 全部 ${checks.length - skipped} 项 web 冒烟断言通过${skipped ? `（另有 ${skipped} 项 SKIP）` : ""}`,
      );
    // 门禁靠这一行判定「跑过但零断言」的假绿（见 docs/plugin-conventions.md §6.1）。
    console.log(`${checks.length - skipped} PASS / ${skipped} SKIP / ${failed} FAIL`);
  } catch (error) {
    if (process.env.SMOKE_DEBUG) console.error(error);
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    hostLog?.end();
    await sleep(500);
    const failedRun = isFailedRun();
    if (process.env.SMOKE_KEEP === "1" || failedRun) {
      // §6.4：失败必须留现场——先打宿主日志尾部，再报保留路径。
      if (failedRun) await reportFailureScene(join(work, "host.log"));
      console.log(
        `临时目录已保留${failedRun ? "（因为这次失败，方便排查；删掉即可）" : "（SMOKE_KEEP=1）"}：${work}（host.log 在里面）`,
      );
    } else {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
};

await main();
