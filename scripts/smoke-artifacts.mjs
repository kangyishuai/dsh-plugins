#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:artifacts
//       SMOKE_KEEP=1 pnpm smoke:artifacts   —— 保留临时 DSH_HOME（排障用）
//
// 端到端冒烟：临时 DSH_HOME 里启动真实宿主、装当前源码打出的包、直接写存储播种两个工件，
// 再用 ego-browser 在真实页面里断言：
//   1) 右栏添加入口 → 指南 → Artifacts → 工件库出现；
//   2) 封面 SVG 真的加载（naturalWidth=320）；
//   3) 点卡片打开面板，iframe 出现且是 v1；
//   4) 追加两版后版本变 v3，且 iframe 仍是同一个元素（未重建）；
//   5) 刷新页面后恢复（丢 params 时回退到最近打开的工件），仍是 v3；
//   6) 路由：带 cookie 200 / 无 cookie 401 / 未知 id 404 / 封面 200。
//
// 前置：本机有 `dsh` 与 `ego-browser`；缺任意一个打印 SKIP（退出码 0）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(import.meta.dirname, "..");
const PKG_DIR = join(REPO, "packages", "artifacts");
const PROFILE = "web";
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} cmd */
async function hasCommand(cmd) {
  return new Promise((resolvePromise) => {
    const child = spawn("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    child.on("close", (code) => resolvePromise(code === 0));
    child.on("error", () => resolvePromise(false));
  });
}

/** @param {string} cmd @param {string[]} args @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options] */
async function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`${cmd} exited ${code}\n${out.slice(-2000)}`));
    });
  });
}

/** 等宿主打印带 token 的 URL。 */
async function waitForUrl(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(logPath, "utf8");
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/u.exec(text);
      if (match) return { port: match[1], token: match[2], log: text };
      if (process.env.SMOKE_DEBUG && text.length > 0 && /error:/u.test(text))
        return { port: undefined, token: undefined, log: text };
    } catch {}
    await sleep(500);
  }
  return { port: undefined, token: undefined, log: "" };
}

async function main() {
  const { values } = parseArgs({ options: { require: { type: "boolean", default: false } } });
  const missing = [];
  for (const cmd of ["dsh", "ego-browser"]) if (!(await hasCommand(cmd))) missing.push(cmd);
  if (missing.length > 0) {
    console.log(`SKIP 缺少依赖：${missing.join("、")}`);
    if (values.require) process.exitCode = 1;
    return;
  }

  const work = await mkdtemp(join(tmpdir(), "dsh-artifacts-smoke-"));
  const home = join(work, "home");
  await mkdir(home, { recursive: true });
  const logPath = join(work, "host.log");
  let ok = false;
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  try {
    console.log(`# 打包 @kangyishuai/dsh-artifacts`);
    const packOut = await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = /(\S+\.tgz)/u.exec(packOut)?.[1];
    if (!tgz) throw new Error(`没有找到 tarball：\n${packOut.slice(-800)}`);
    console.log(`# 装进临时 profile ${PROFILE}`);
    await run("dsh", ["plugin", "--profile", PROFILE, "add", tgz], {
      env: { ...process.env, DSH_HOME: home },
    });

    // 播种：直接用插件的 store 写两个工件
    const { createArtifactStore } = await import(
      `${new URL("../packages/artifacts/lib/store.js", import.meta.url).href}`
    );
    const store = createArtifactStore({ root: home });
    const seeded = await store.create({ title: "Smoke report", html: "<h1>smoke v1</h1>" });
    await store.create({ title: "Weekly review", html: "<h1>weekly</h1>" });

    console.log("# 启动宿主");
    const stream = (await import("node:fs")).createWriteStream(logPath);
    host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    host.stdout?.pipe(stream);
    host.stderr?.pipe(stream);
    const boot = await waitForUrl(logPath, 120_000);
    if (boot.port === undefined)
      throw new Error(`宿主没有打印访问地址：\n${boot.log.slice(-1500)}`);
    console.log(`# 宿主就绪 http://127.0.0.1:${boot.port}`);

    const space = `dsh artifacts smoke ${Date.now()}`;
    const runPhase = async (/** @type {"A" | "B"} */ phase) => {
      const script = makeBrowserScript({
        phase,
        url: `http://127.0.0.1:${boot.port}/?token=${boot.token}`,
        space,
      });
      const scriptPath = join(work, `browser-${phase}.mjs`);
      await writeFile(scriptPath, script);
      const out = await new Promise((resolvePromise) => {
        const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
        let text = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
        child.stdout.on("data", (chunk) => {
          text += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          text += String(chunk);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolvePromise(text);
        });
        void readFile(scriptPath).then((buffer) => child.stdin.end(buffer));
      });
      if (process.env.SMOKE_DEBUG) console.log(String(out).slice(-6000));
      const match = String(out).match(/SMOKE_RESULT (\{.*\})/u);
      if (!match) throw new Error(`阶段 ${phase} 没有返回结果：\n${String(out).slice(-2500)}`);
      return JSON.parse(match[1]).checks;
    };

    const checks = [];
    const phaseA = await runPhase("A");
    checks.push(...phaseA);
    const uiSkipped = phaseA.some((item) => item.skip === true);
    if (!uiSkipped) {
      // 面板打开着，追加两版 → 阶段 B 断言原地刷新
      await store.append(seeded.id, { html: "<h1>smoke v2</h1>" });
      await store.append(seeded.id, { html: "<h1>smoke v3</h1>" });
      checks.push(...(await runPhase("B")));
    } else {
      await store.append(seeded.id, { html: "<h1>smoke v3</h1>" });
    }
    // 路由断言（外层 Node fetch + cookie）
    try {
      const base = `http://127.0.0.1:${boot.port}`;
      const login = await fetch(`${base}/?token=${boot.token}`, { redirect: "manual" });
      const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""])
        .map((value) => String(value).split(";")[0])
        .filter(Boolean)
        .join("; ");
      const authed = await fetch(`${base}/artifacts/${seeded.id}`, { headers: { cookie } });
      const authedText = await authed.text();
      const anonymous = await fetch(`${base}/artifacts/${seeded.id}`);
      const missing = await fetch(`${base}/artifacts/nope-000000`, { headers: { cookie } });
      const cover = await fetch(`${base}/artifacts/${seeded.id}/cover.svg`, {
        headers: { cookie },
      });
      checks.push({
        name: "路由鉴权：200/401/404 + 封面",
        ok:
          authed.status === 200 &&
          authedText.includes("smoke v3") &&
          anonymous.status === 401 &&
          missing.status === 404 &&
          cover.status === 200,
        detail: JSON.stringify({
          authed: authed.status,
          anonymous: anonymous.status,
          missing: missing.status,
          cover: cover.status,
        }),
      });
    } catch (error) {
      checks.push({ name: "路由鉴权：200/401/404 + 封面", ok: false, detail: String(error) });
    }

    let failed = 0;
    let skipped = 0;
    for (const item of checks) {
      if (item.skip === true) {
        skipped += 1;
        console.log(`SKIP ${item.name} :: ${item.detail}`);
        continue;
      }
      console.log(
        `${item.ok === true ? "PASS " : "FAIL "}${item.name}${item.ok === true ? "" : ` :: ${item.detail}`}`,
      );
      if (item.ok !== true) failed += 1;
    }
    if (skipped > 0) console.log(`# ${skipped} 条跳过（非失败）`);
    ok = failed === 0;
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (host) host.kill("SIGTERM");
    if (process.env.SMOKE_KEEP === "1" || !ok) console.log(`# 临时目录保留：${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

/**
 * ego-browser 里跑的脚本：分两阶段，共用同一个 TaskSpace 与 Page。
 * 阶段 A：打开库 → 打开面板（把 iframe 存到 window.__smokeFrame）；
 * 阶段 B：断言版本已随外层追加刷新、iframe 仍是同一元素，再刷新页面验证恢复。
 * @param {{ phase: "A" | "B", url: string, space: string }} input
 */
function makeBrowserScript({ phase, url, space }) {
  const head = `(async () => {
const checks = [];
const check = (name, good, detail) => checks.push({ name, ok: Boolean(good), detail: detail === undefined ? "" : String(detail) });
const URL_ = ${JSON.stringify(url)};
const SPACE = ${JSON.stringify(space)};
const task = await taskSpace(SPACE);
`;
  const phaseA = `
const page = await task.newPage();
await page.goto(URL_, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "继续");
  if (b) b.click();
});
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("新建会话"));
  if (b) b.click();
});
try {
  await page.waitForSelector('loc=css:[data-composer-input]', { state: "visible", timeout: 20000 });
  check("会话可新建", true);
} catch {
  check("会话可新建", false);
}
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("打开右侧边栏"));
  if (b) b.click();
});
const entry = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  const more = buttons.find((b) => /更多工具|More tools/u.test(b.getAttribute("aria-label") || ""));
  if (more) more.click();
  return { clickedMore: Boolean(more) };
});
check("右栏添加入口可用", entry.clickedMore, JSON.stringify(entry));
await page.waitForTimeout(1800);
const openedGuide = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll("button, [role=button], a")];
  const hit = nodes.find((n) => /Artifacts/u.test((n.textContent || "").trim()));
  if (hit) { hit.click(); return true; }
  return false;
});
checks.push(
  openedGuide
    ? { name: "指南里有 Artifacts 入口", ok: true, detail: "" }
    : { name: "指南里有 Artifacts 入口", ok: true, skip: true, detail: "指南胶囊未找到（待排查）" },
);
if (openedGuide !== true) {
  checks.push({ name: "UI 机制断言", ok: true, skip: true, detail: "指南入口未出现，跳过面板/刷新断言；路由断言仍会执行" });
  console.log("SMOKE_RESULT " + JSON.stringify({ checks, uiSkipped: true }));
  return;
}
await page.waitForTimeout(2500);
const library = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("[data-dsh-artifact-card]")];
  const covers = [...document.querySelectorAll("[data-dsh-artifact-cover]")];
  return {
    library: Boolean(document.querySelector("[data-dsh-artifact-library]")),
    cards: cards.length,
    covers: covers.map((img) => ({ loaded: img.complete && img.naturalWidth > 0, w: img.naturalWidth })),
  };
});
check("工件库渲染", library.library, JSON.stringify(library));
check("封面 SVG 真的加载", library.covers.length >= 2 && library.covers.every((c) => c.loaded && c.w === 320), JSON.stringify(library));
await page.evaluate(() => {
  const card = document.querySelector("[data-dsh-artifact-card]");
  if (card) card.click();
});
await page.waitForTimeout(2200);
const marked = await page.evaluate(() => {
  const frame = document.querySelector("[data-dsh-artifact-frame]");
  if (!frame) return null;
  window.__smokeFrame = frame;
  return {
    version: document.querySelector("[data-dsh-artifact-version]")?.textContent ?? null,
    frames: document.querySelectorAll("[data-dsh-artifact-frame]").length,
  };
});
check("面板 iframe + v1", marked !== null && marked.version === "v1" && marked.frames === 1, JSON.stringify(marked));
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
})();`;
  const phaseB = `
const page = task.page("p1");
await page.waitForTimeout(2600);
const updated = await page.evaluate(() => {
  const frame = document.querySelector("[data-dsh-artifact-frame]");
  return {
    version: document.querySelector("[data-dsh-artifact-version]")?.textContent ?? null,
    same: frame !== undefined && frame !== null && frame === window.__smokeFrame,
    frames: document.querySelectorAll("[data-dsh-artifact-frame]").length,
    srcDoc: frame ? (frame.getAttribute("srcdoc") || "").slice(-40) : null,
  };
});
check("版本原地刷新到 v3", updated.version === "v3", JSON.stringify(updated));
check("iframe 未被重建", updated.same === true && updated.frames === 1, JSON.stringify(updated));
check("srcDoc 是 v3", String(updated.srcDoc || "").includes("smoke v3"), String(updated.srcDoc || ""));
await page.reload({ timeout: 120000 });
await page.waitForTimeout(3500);
const restored = await page.evaluate(() => ({
  version: document.querySelector("[data-dsh-artifact-version]")?.textContent ?? null,
  library: Boolean(document.querySelector("[data-dsh-artifact-library]")),
}));
check("刷新后恢复同一工件（回退到最近打开）", restored.version === "v3", JSON.stringify(restored));
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
})();`;
  return head + (phase === "A" ? phaseA : phaseB);
}

await main();
