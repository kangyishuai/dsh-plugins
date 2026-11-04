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
function browserScript(url) {
  return `
const task = await taskSpace("dsh smoke: session-delete");
const page = task.page("p1");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });

await page.goto(${JSON.stringify(url)});
await page.waitForTimeout(4500);
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

const slotErrors = await page.evaluate(() =>
  [...document.querySelectorAll("[data-slot-error]")].map((el) => el.getAttribute("data-slot-error")),
);
check("无 slot 渲染错误", slotErrors.length === 0, JSON.stringify(slotErrors));

const footer = await page.evaluate(() =>
  [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") || "").includes("回收站")),
);
check("侧栏页脚存在回收站入口", footer);

// 1) 页脚 → 回收站面板
const panel = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  if (!btn) return { ok: false, text: "no-footer" };
  btn.click();
  await new Promise((r) => setTimeout(r, 1200));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return { ok: !!dlg, text: dlg ? (dlg.textContent || "").replace(/\\s+/g, " ").slice(0, 120) : "missing" };
});
check("点击页脚可打开回收站面板", panel.ok, panel.text);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 2) 会话菜单 → 确认框
const confirm = await page.evaluate(async () => {
  const row = document.querySelector("[data-row-key^='session:']");
  if (!row) return { ok: false, text: "no-session-row" };
  row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const menuBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("会话“"));
  if (!menuBtn) return { ok: false, text: "no-menu-button" };
  menuBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  const item = [...document.querySelectorAll("button, [role=menuitem]")].find((el) => (el.textContent || "").trim() === "删除会话…");
  if (!item) return { ok: false, text: "no-delete-item" };
  item.click();
  await new Promise((r) => setTimeout(r, 2200));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("移入回收站"));
  const text = dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "";
  return { ok: !!dlg && text.includes("会话日志约"), text: text.slice(0, 200) };
});
check("会话菜单可打开确认框并渲染 plan", confirm.ok, confirm.text);

// 3) 执行删除 → 行消失
const beforeRows = await page.evaluate(() => [...document.querySelectorAll("[data-row-key^='session:']")].map((e) => e.getAttribute("data-row-key")));
const confirmed = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "移入回收站");
  if (!btn || btn.disabled) return false;
  btn.click();
  await new Promise((r) => setTimeout(r, 2600));
  return true;
});
const afterRows = await page.evaluate(() => [...document.querySelectorAll("[data-row-key^='session:']")].map((e) => e.getAttribute("data-row-key")));
check("确认后会话行消失", confirmed && afterRows.length === beforeRows.length - 1, beforeRows.length + " -> " + afterRows.length);

// 4) 刷新页面后不复活
await page.reload();
await page.waitForTimeout(4500);
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}
const reloadRows = await page.evaluate(() => [...document.querySelectorAll("[data-row-key^='session:']")].map((e) => e.getAttribute("data-row-key")));
const resurrected = beforeRows.filter((id) => !afterRows.includes(id)).filter((id) => reloadRows.includes(id));
check("刷新页面后已删会话不复活", resurrected.length === 0, JSON.stringify(resurrected));

// 5) 面板里有刚删的条目
const listState = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  if (!btn) return { ok: false, text: "no-footer" };
  btn.click();
  await new Promise((r) => setTimeout(r, 1400));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  const text = dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "";
  return { ok: text.includes("恢复") && text.includes("彻底删除"), text: text.slice(0, 200) };
});
check("回收站面板列出条目", listState.ok, listState.text);

// 6) 彻底删除 → 面板变空
const purge = await page.evaluate(async () => {
  const del = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === "彻底删除");
  if (!del) return { ok: false, text: "no-purge-button" };
  del.click();
  await new Promise((r) => setTimeout(r, 400));
  const confirmBtn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim().includes("彻底删除？"));
  if (!confirmBtn) return { ok: false, text: "no-confirm" };
  confirmBtn.click();
  await new Promise((r) => setTimeout(r, 1600));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  const text = dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "";
  return { ok: text.includes("回收站是空的"), text: text.slice(0, 160) };
});
check("彻底删除后面板立即变空", purge.ok, purge.text);

await task.finish({ keep: false }).catch(() => {});
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
`;
}

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser")))
    return console.log("SKIP 未找到 ego-browser（GUI 冒烟需要本机浏览器环境）");

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
    const browserFile = join(work, "browser.mjs");
    await writeFile(browserFile, browserScript(url));

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

    const match = String(result).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果");
      console.error(String(result).slice(-4000));
      return;
    }
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
    await rm(work, { recursive: true, force: true });
  }
};

await main();
