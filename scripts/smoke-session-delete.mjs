#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:session-delete
// 端到端冒烟：临时 DSH_HOME 启动真实宿主 → 浏览器点一遍主链路 → 断言。
// 需要本机有 dsh 与 ego-browser；缺任意一个就跳过（退出码 0，打印 SKIP），方便在没有浏览器的 CI 上跑。
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-shots");
const PKG_DIR = join(REPO, "packages", "session-delete");

/** @param {string} message */
function fail(message) {
  console.error("FAIL " + message);
  process.exitCode = 1;
}

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnOptions} [opts] */
async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** @param {string} cmd */
async function hasCommand(cmd) {
  try {
    await run("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} file @returns {Promise<string>} */
async function readIfExists(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 轮询启动日志，等 URL 与「是否激活失败」。
 * @param {string} logPath
 * @param {number} timeoutMs
 */
async function waitForBoot(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readIfExists(logPath);
    const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/u);
    if (match) {
      const activationFailures = (text.match(/did not activate/gu) ?? []).length;
      return { port: Number(match[1]), token: match[2], activationFailures, text };
    }
    if (/error:/u.test(text)) break;
    await sleep(500);
  }
  throw new Error(
    "宿主没有在超时时间内打印访问地址：\n" + (await readIfExists(logPath)).slice(-2000),
  );
}

/**
 * ego-browser 里跑的脚本：返回 { ok, checks }。
 * @param {string} url
 */
/**
 * ego-browser 里跑的脚本：返回 { ok, checks }，并把关键状态截图存到 SHOTS。
 * @param {string} url
 * @param {string} shots
 * @param {string} home
 */
function browserScript(url, shots, home) {
  return `
const task = await taskSpace("dsh smoke: session-delete");
const page = task.page("p1");
const SHOTS = ${JSON.stringify(shots)};
const HOME_DIR = ${JSON.stringify(home)};
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
const shot = async (name) => { await page.screenshot({ path: SHOTS + "/" + name + ".png" }); };
const dismiss = async () => {
  // 首启的「预览版说明 / 登录」弹层要点按钮关掉，Esc 不一定管用；
  // 它们的遮罩会把我们的浮层压暗，也会挡住真实指针事件。
  for (const label of ["继续", "开始使用", "跳过", "关闭"]) {
    await page.evaluate((text) => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
      if (btn) btn.click();
    }, label).catch(() => {});
    await page.waitForTimeout(250);
  }
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(200); }
};
const rows = () => page.evaluate(() =>
  [...document.querySelectorAll("[data-row-key^='session:']")].map((el) => el.getAttribute("data-row-key")));
const openPanel = () => page.evaluate(async () => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  if (!btn) return "no-footer";
  btn.click();
  await new Promise((r) => setTimeout(r, 1300));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "missing";
});
const openConfirm = () => page.evaluate(async () => {
  const row = document.querySelector("[data-row-key^='session:']");
  if (!row) return "no-session-row";
  row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const menuBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("会话“"));
  if (!menuBtn) return "no-menu-button";
  menuBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  const item = [...document.querySelectorAll("button, [role=menuitem]")].find((el) => (el.textContent || "").trim() === "删除会话…");
  if (!item) return "no-delete-item";
  item.click();
  await new Promise((r) => setTimeout(r, 2200));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("移入回收站"));
  return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "missing";
});
const clickDialogButton = (text) => page.evaluate(async (label) => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === label);
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}, text);
const dialogOpen = (needle) => page.evaluate((text) =>
  [...document.querySelectorAll('[role="dialog"]')].some((d) => (d.textContent || "").includes(text)), needle);

await page.goto(${JSON.stringify(url)});
await page.waitForTimeout(4500);
await dismiss();

// 1) slot 渲染
const slotErrors = await page.evaluate(() =>
  [...document.querySelectorAll("[data-slot-error]")].map((el) => el.getAttribute("data-slot-error")));
check("无 slot 渲染错误", slotErrors.length === 0, JSON.stringify(slotErrors));

// 2) 页脚入口 + hover 背景变化
const footerRect = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2,
    bg: getComputedStyle(btn).backgroundColor,
    label: btn.getAttribute("aria-label") };
});
check("侧栏页脚存在回收站入口", !!footerRect, footerRect && footerRect.label);
if (footerRect) {
  await page.hover('button[aria-label^="回收站"]').catch((error) => console.log("DEBUG hover-miss", String(error).slice(0, 120)));
  await page.waitForTimeout(500);
  const hoverProbe = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
    if (!btn) return "no-button";
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return JSON.stringify({
      bg: getComputedStyle(btn).backgroundColor,
      inline: (btn.getAttribute("style") || "").includes("background"),
      topTag: top && top.tagName,
      topLabel: top && top.getAttribute && top.getAttribute("aria-label"),
      focused: document.hasFocus(),
    });
  });
  let hoverBg = "";
  try {
    hoverBg = JSON.parse(hoverProbe).bg;
  } catch (error) {
    hoverBg = "";
  }
  check("页脚按钮 hover 有背景变化", hoverBg !== footerRect.bg, footerRect.bg + " -> " + hoverProbe);
  await shot("01-footer-hover");
}

// 3) 页脚 → 面板；Esc 关闭
const emptyPanel = await openPanel();
check("点击页脚可打开回收站面板", emptyPanel.includes("会话回收站"), emptyPanel.slice(0, 60));
check("空回收站显示空态", emptyPanel.includes("回收站是空的"), emptyPanel.slice(0, 60));
await shot("02-panel-empty");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("Esc 可关闭回收站面板", !(await dialogOpen("会话回收站")));

// 4) 菜单 → 确认框（含 plan）；Esc 关闭
const planText = await openConfirm();
check("会话菜单可打开确认框并渲染 plan", planText.includes("会话日志约"), planText.slice(0, 120));
await shot("03-confirm-dialog");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("Esc 可关闭确认框", !(await dialogOpen("移入回收站")));

// 5) 执行删除 → 行消失 + toast
const beforeRows = await rows();
await openConfirm();
const confirmed = await clickDialogButton("移入回收站");
await page.waitForTimeout(2600);
const afterRows = await rows();
check("确认后会话行消失", confirmed && afterRows.length === beforeRows.length - 1,
  beforeRows.length + " -> " + afterRows.length);
const toastVisible = await page.evaluate(() => document.body.innerText.includes("已移入回收站"));
check("删除后出现回执 toast", toastVisible);
await shot("04-after-delete");

// 6) 刷新不复活 + 角标
await page.reload();
await page.waitForTimeout(4500);
await dismiss();
const reloadRows = await rows();
const resurrected = beforeRows.filter((id) => !afterRows.includes(id)).filter((id) => reloadRows.includes(id));
check("刷新页面后已删会话不复活", resurrected.length === 0, JSON.stringify(resurrected));
const badge = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  return btn ? btn.getAttribute("aria-label") : "";
});
check("角标反映待恢复条目数", /\\(1\\)/.test(badge || ""), badge);

// 7) 面板条目 + 键盘导航
const withEntry = await openPanel();
check("回收站面板列出条目", withEntry.includes("恢复") && withEntry.includes("彻底删除"), withEntry.slice(0, 100));
check(
  "回收站支持全选与批量恢复/彻底删除",
  withEntry.includes("全选") && withEntry.includes("批量恢复") && withEntry.includes("批量彻底删除"),
  withEntry.slice(0, 160),
);
await shot("05-panel-with-entry");
const keyboard = await page.evaluate(async () => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  if (!dlg) return "no-dialog";
  const restore = [...dlg.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "恢复");
  if (!restore) return "no-restore-button";
  restore.focus();
  const start = (document.activeElement && document.activeElement.textContent) || "";
  restore.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const end = (document.activeElement && document.activeElement.textContent) || "";
  return start !== end ? "moved" : "unchanged:" + start;
});
check("面板方向键可移动焦点", keyboard === "moved", keyboard);

// 8) 恢复
const restored = await clickDialogButton("恢复");
await page.waitForTimeout(2200);
const rowsAfterRestore = await rows();
const panelAfterRestore = await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "") : "";
});
check("恢复后会话回到列表", restored && rowsAfterRestore.length === beforeRows.length,
  rowsAfterRestore.length + "/" + beforeRows.length);
check("恢复后回收站清空", panelAfterRestore.includes("回收站是空的"));
await shot("06-after-restore");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 9) 再次删除 → 彻底删除
await openConfirm();
await clickDialogButton("移入回收站");
await page.waitForTimeout(2600);
await openPanel();
const purge = await clickDialogButton("彻底删除");
await page.waitForTimeout(400);
const purgeConfirm = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim().includes("彻底删除？"));
  if (!btn) return false;
  btn.click();
  await new Promise((r) => setTimeout(r, 1600));
  return true;
});
const afterPurge = await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "") : "";
});
check("彻底删除后面板立即变空", purge && purgeConfirm && afterPurge.includes("回收站是空的"));
const badgeAfterPurge = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  return btn ? btn.getAttribute("aria-label") : "";
});
check("彻底删除后角标归零", !/\\(\\d\\)/.test(badgeAfterPurge || ""), badgeAfterPurge);

// 10) 审计页签
const audit = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "审计");
  if (!tab) return "no-audit-tab";
  tab.click();
  await new Promise((r) => setTimeout(r, 1600));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  if (!dlg) return "missing";
  const text = dlg.textContent || "";
  return text.replace(/\\s+/g, " ");
});
console.log("AUDIT_DEBUG " + audit);
  check("审计页签记录 trash/restore/purge", audit.includes("trash") && audit.includes("restore") && audit.includes("purge"), audit.slice(0, 160));
await shot("07-audit-tab");

// 11) 体检页签
const health = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "体检");
  if (!tab) return "no-health-tab";
  tab.click();
  await new Promise((r) => setTimeout(r, 1600));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "missing";
});
check(
  "体检页签给出库存与结论",
  health.includes("已存") && (health.includes("未发现") || health.includes("条")),
  health.slice(0, 160),
);
check("体检页签显示 agent 工具已注册", /模型工具 session_delete：已注册/.test(health), health.slice(0, 200));
await shot("08-health-tab");

// 12) 回执页签
const receiptText = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "回执");
  if (!tab) return "no-receipts-tab";
  tab.click();
  await new Promise((r) => setTimeout(r, 1200));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "missing";
});
check("回执页签列出 trash/restore/purge 记录", /trash/.test(receiptText) && /purge/.test(receiptText), receiptText.slice(0, 160));
await shot("09-receipts-tab");


// 12) 级联勾选框：遍历非选中会话行，找到带子会话的那一条（不改动任何东西）
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const ensureVictim = async () => {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
  });
  await page.waitForTimeout(900);
  const hasNonSelected = await page.evaluate(() =>
    [...document.querySelectorAll("[data-row-key^='session:']")].some(
      (el) => el.getAttribute("aria-selected") !== "true" && !String(el.className).includes("_selected")));
  if (hasNonSelected) return;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "新建会话");
    if (btn) btn.click();
  });
  await page.waitForTimeout(1600);
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
};
await ensureVictim();
const sessionRows = await page.evaluate(() =>
  [...document.querySelectorAll("[data-row-key^='session:']")]
    .filter((el) => el.getAttribute("aria-selected") !== "true" && !String(el.className).includes("_selected"))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => el.getAttribute("data-row-key")));
let cascadeDetail = "no-parent-session";
for (const rowKey of sessionRows) {
  const rect = await page.evaluate((key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, rowKey);
  if (!rect) continue;
  await page.mouse.move(rect.x, rect.y);
  await page.waitForTimeout(600);
  await page.evaluate((key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    if (!row) return;
    row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    row.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  }, rowKey);
  await page.waitForTimeout(300);
  const probeResult = await page.evaluate(async (key) => {
    const rowEl = document.querySelector('[data-row-key="' + key + '"]');
    const rowButtons = rowEl ? [...rowEl.querySelectorAll("button")] : [];
    const menuBtn =
      rowButtons.find((b) => (b.getAttribute("aria-label") || "").includes("操作")) ||
      rowButtons[rowButtons.length - 1];
    if (!menuBtn) return "no-menu";
    menuBtn.click();
    await new Promise((r) => setTimeout(r, 450));
    const item = [...document.querySelectorAll("button, [role=menuitem]")].find(
      (el) => (el.textContent || "").trim() === "删除会话…");
    if (!item) return "no-item";
    item.click();
    await new Promise((r) => setTimeout(r, 1800));
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      (d.textContent || "").includes("移入回收站"));
    if (!dlg) return "no-dialog";
    const hasCheckbox =
      Boolean(dlg.querySelector('input[type="checkbox"]')) ||
      /同时删除|Also delete these/.test(dlg.textContent || "");
    return hasCheckbox ? "found:" + key : "none";
  }, rowKey);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  cascadeDetail = String(probeResult);
  if (cascadeDetail.startsWith("found:")) break;
}
check("有子会话的确认框出现级联勾选框", cascadeDetail.startsWith("found:"), cascadeDetail);
await shot("10-cascade-checkbox");

await task.finish({ keep: false }).catch(() => {});
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
`;
}

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser")))
    return console.log("SKIP 未找到 ego-browser（GUI 冒烟需要本机浏览器环境）");

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  try {
    const profileSrc = join(process.env.HOME ?? "", ".dsh", "profiles", "desktop");
    const home = join(work, "home");
    const profile = join(home, "profiles", "sdel");
    await mkdir(join(home, "profiles"), { recursive: true });
    await cp(profileSrc, profile, { recursive: true });
    for (const dir of ["sessions", "storages"]) {
      await cp(join(process.env.HOME ?? "", ".dsh", dir), join(home, dir), {
        recursive: true,
      }).catch(() => {});
    }
    const profileJson = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
    profileJson.name = "dsh-profile-sdel-smoke";
    await writeFile(join(profile, "package.json"), JSON.stringify(profileJson, null, 2));

    // 没有会话就没什么可删的，直接跳过而不是误报失败
    const sessionRoots = await readdir(join(home, "sessions"), { withFileTypes: true }).catch(
      () => [],
    );
    let hasSession = false;
    for (const entry of sessionRoots) {
      if (!entry.isDirectory()) continue;
      const inner = await readdir(join(home, "sessions", entry.name), {
        withFileTypes: true,
      }).catch(() => []);
      if (inner.some((item) => item.isDirectory())) {
        hasSession = true;
        break;
      }
    }
    if (!hasSession) {
      console.log("SKIP 临时 profile 里没有会话，先随便开一个会话再跑");
      return;
    }

    // 打当前源码的包，装进临时 profile
    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");

    const env = { ...process.env, DSH_HOME: home };
    await run("dsh", ["plugin", "--profile", "sdel", "install"], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", "sdel", "remove", "@kangyishuai/dsh-session-delete"], {
      env,
    }).catch(() => {});
    await run("dsh", ["plugin", "--profile", "sdel", "add", join(work, tgz)], { env });

    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", "sdel", "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {string[]} */
    const chunks = [];
    host.stdout?.on("data", (/** @type {any} */ c) => chunks.push(String(c)));
    host.stderr?.on("data", (/** @type {any} */ c) => chunks.push(String(c)));
    void writeFile(logPath, "");
    const flush = async () => writeFile(logPath, chunks.join(""));
    const poll = setInterval(flush, 300);

    /** @type {{ port: number, token: string, activationFailures: number, text: string }} */
    let boot;
    try {
      boot = await waitForBoot(logPath, 60_000);
    } finally {
      clearInterval(poll);
      await flush();
    }
    await run("dsh", ["--version"], { env }).catch(() => {});
    if (boot.activationFailures > 0) {
      fail("宿主报告 " + boot.activationFailures + " 个插件未激活");
      console.error(boot.text.slice(-3000));
      return;
    }

    const url = "http://127.0.0.1:" + boot.port + "/?token=" + boot.token;
    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const browserSource = browserScript(url, shotsDir, home);
    await writeFile(browserFile, browserSource);
    await writeFile(join(shotsDir, "browser.mjs"), browserSource);

    const result = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
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

    if (process.env.SMOKE_DEBUG) console.log(String(result).slice(-5000));
    const match = String(result).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果");
      console.error(String(result).slice(-4000));
      return;
    }
    /** @type {{ checks: { name: string, ok: boolean, detail: string }[] }} */
    /** @type {{ checks: { name: string, ok: boolean, detail: string }[] }} */
    const parsed = JSON.parse(match[1]);
    let failed = 0;
    for (const item of parsed.checks) {
      console.log(
        (item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : " :: " + item.detail),
      );
      if (!item.ok) failed += 1;
    }
    if (failed > 0) {
      fail(failed + " 项断言失败");
      return;
    }
    console.log("PASS 全部 " + parsed.checks.length + " 项冒烟断言通过");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    await sleep(500);
    // 把截图留在固定路径，失败时也能看现场
    await cp(join(work, "shots"), SHOTS_OUT, { recursive: true }).catch(() => {});
    console.log("截图目录：" + SHOTS_OUT);
    await rm(work, { recursive: true, force: true });
  }
};

await main();
