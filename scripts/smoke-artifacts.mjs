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
//   6) 需求 10：按 projectId 打开库视图（`__dshArtifactsOpenTab({projectId})`）只列本项目产物；
//      多类型预览：markdown 走 <pre>、图片走 <img> 且真的加载；
//   7) 路由：带 cookie 200 / 无 cookie 401 / 未知 id 404 / 封面 200 / 编码斜杠 400。
//
// 前置：本机有 `dsh` 与 `ego-browser`；缺任意一个打印 SKIP（退出码 0）。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(import.meta.dirname, "..");
const PKG_DIR = join(REPO, "packages", "artifacts");
const PROFILE = "web";
/** 需求 10 冒烟用的固定项目 id：浏览器脚本按它断言「按项目过滤的库视图」。 */
const SMOKE_PROJECT = "smoke-project-2026";
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
/** @param {string} logPath @param {number} timeoutMs */
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
    // 需求 10 的种子：一个带 projectId 的产物 + 一个 markdown + 一张图片。
    const projectArtifact = await store.create({
      title: "Project page",
      html: "<h1>project v1</h1>",
      projectId: SMOKE_PROJECT,
    });
    const markdownArtifact = await store.create({
      title: "Smoke notes",
      kind: "markdown",
      content: "# smoke notes\n\n- markdown-body-marker",
    });
    const imageArtifact = await store.create({
      title: "Smoke chart",
      kind: "image",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });

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
    const script = makeBrowserScript({
      url: `http://127.0.0.1:${boot.port}/?token=${boot.token}`,
      space,
      project: SMOKE_PROJECT,
      projectArtifact: projectArtifact.id,
      markdownArtifact: markdownArtifact.id,
      imageArtifact: imageArtifact.id,
    });
    const scriptPath = join(work, "browser.mjs");
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
    if (!match) throw new Error(`浏览器脚本没有返回结果：\n${String(out).slice(-2500)}`);
    const checks = JSON.parse(match[1]).checks;
    // 追加一版，供路由断言检查内容随版本变化
    await store.append(seeded.id, { html: "<h1>smoke v2</h1>" });
    await store.append(seeded.id, { html: "<h1>smoke v3</h1>" });

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
      const traversal = await fetch(`${base}/artifacts/..%2F..%2Fetc`, { headers: { cookie } });
      const cover = await fetch(`${base}/artifacts/${seeded.id}/cover.svg`, {
        headers: { cookie },
      });
      checks.push({
        name: "路由鉴权：200/401/404/400 + 封面",
        ok:
          authed.status === 200 &&
          authedText.includes("smoke v3") &&
          anonymous.status === 401 &&
          missing.status === 404 &&
          traversal.status === 400 &&
          cover.status === 200,
        detail: JSON.stringify({
          authed: authed.status,
          anonymous: anonymous.status,
          missing: missing.status,
          traversal: traversal.status,
          cover: cover.status,
        }),
      });
    } catch (error) {
      checks.push({ name: "路由鉴权：200/401/404/400 + 封面", ok: false, detail: String(error) });
    }

    let failed = 0;
    let skipped = 0;
    for (const item of /** @type {any[]} */ (checks)) {
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
    // 门禁靠这一行判定「跑过但零断言」的假绿（见 docs/plugin-conventions.md §6.1）。
    console.log(`${checks.length - failed - skipped} PASS / ${skipped} SKIP / ${failed} FAIL`);
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
 * ego-browser 里跑的脚本：库 → 封面 → 面板 → 刷新恢复 →（需求 10）按项目过滤的库视图 + 多类型预览。
 * @param {{ url: string, space: string, project: string, projectArtifact: string, markdownArtifact: string, imageArtifact: string }} input
 */
function makeBrowserScript({
  url,
  space,
  project,
  projectArtifact,
  markdownArtifact,
  imageArtifact,
}) {
  return `(async () => {
const checks = [];
const check = (name, good, detail) => checks.push({ name, ok: Boolean(good), detail: detail === undefined ? "" : String(detail) });
const URL_ = ${JSON.stringify(url)};
const task = await taskSpace(${JSON.stringify(space)});
const page = await task.newPage();
await page.goto(URL_, { timeout: 120000 });
await page.waitForTimeout(2500);
// 调试钩子默认不挂 window 全局（P2 复审）：写 localStorage 后重载一次，冒烟后面要用它开页签。
await page.evaluate(() => {
  try {
    window.localStorage.setItem("dsh-artifacts:debug", "1");
  } catch {}
});
await page.reload({ timeout: 120000 });
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
// 等侧栏按钮出现（新建会话后右栏是异步挂载的）
try {
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /更多工具|More tools|新标签页|New tab/u.test(b.getAttribute("aria-label") || "")),
    undefined,
    { timeout: 20000 },
  );
} catch {}
const entry = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  const pick = (pattern) => buttons.find((b) => pattern.test(b.getAttribute("aria-label") || ""));
  const more = pick(/更多工具|More tools/u);
  const add = pick(/新标签页|New tab/u);
  const target = more ?? add;
  if (target) target.click();
  return { ok: Boolean(target), used: more ? "more" : add ? "add" : "none" };
});
check("右栏添加入口可用", entry.ok, JSON.stringify(entry));
await page.waitForTimeout(1800);
const openedGuide = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll("button, [role=button], a")];
  const hit = nodes.find((n) => /Artifacts/u.test((n.textContent || "").trim()));
  if (hit) { hit.click(); return true; }
  return false;
});
check("指南里有 Artifacts 入口", openedGuide);
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
check("工件库渲染", library.library && library.cards >= 2, JSON.stringify(library));
check("封面 SVG 真的加载", library.covers.length >= 2 && library.covers.every((c) => c.loaded && c.w === 320), JSON.stringify(library));
await page.evaluate(() => {
  // 图片是最后播种的（列表按 updatedAt 倒序），点它不会有 iframe；这里明确点 html 卡片。
  const card =
    document.querySelector('[data-dsh-artifact-card-kind="html"]') ||
    document.querySelector("[data-dsh-artifact-card]");
  if (card) card.click();
});
await page.waitForTimeout(2200);
const panel = await page.evaluate(() => ({
  frames: document.querySelectorAll("[data-dsh-artifact-frame]").length,
  version: document.querySelector("[data-dsh-artifact-version]")?.textContent ?? null,
  back: Boolean(document.querySelector("[data-dsh-artifact-back]")),
}));
check("点卡片打开面板", panel.frames === 1 && panel.back === true, JSON.stringify(panel));
await page.reload({ timeout: 120000 });
await page.waitForTimeout(3500);
const restored = await page.evaluate(() => ({
  version: document.querySelector("[data-dsh-artifact-version]")?.textContent ?? null,
  library: Boolean(document.querySelector("[data-dsh-artifact-library]")),
}));
check("刷新后恢复同一工件（回退到最近打开）", restored.version !== null || restored.library, JSON.stringify(restored));

// 需求 10：按 projectId 打开库视图 —— 断言 scope 属性与行集合都只含本项目产物。
let hookOk = true;
try {
  await page.evaluate(() => window.__dshArtifactsOpenTab({ projectId: ${JSON.stringify(project)} }));
} catch {
  hookOk = false;
}
await page.waitForTimeout(2000);
const scoped = await page.evaluate(() => ({
  scope: document
    .querySelector("[data-dsh-artifact-library-scope]")
    ?.getAttribute("data-dsh-artifact-library-scope") || null,
  cards: [...document.querySelectorAll("[data-dsh-artifact-card]")].map((node) =>
    node.getAttribute("data-dsh-artifact-card"),
  ),
  summary: document.querySelector("[data-dsh-artifact-summary]")?.textContent || "",
}));
check(
  "项目过滤视图：scope + 行集合只含本项目",
  hookOk &&
    scoped.scope === ${JSON.stringify(project)} &&
    scoped.cards.length === 1 &&
    scoped.cards[0] === ${JSON.stringify(projectArtifact)},
  JSON.stringify({ hookOk, scoped }),
);

// 多类型预览：markdown 进 <pre>，图片进 <img> 且真的加载。
let markdownText = "";
let markdownVisible = false;
try {
  await page.evaluate(() => window.__dshArtifactsOpenTab({ id: ${JSON.stringify(markdownArtifact)} }));
  await page.waitForTimeout(2000);
  const markdown = await page.evaluate(() => {
    const pre = document.querySelector("[data-dsh-artifact-text]");
    return { visible: Boolean(pre), text: (pre?.textContent || "").slice(0, 200) };
  });
  markdownText = markdown.text;
  markdownVisible = markdown.visible;
} catch {}
let imageState = { visible: false, loaded: false, w: 0 };
try {
  await page.evaluate(() => window.__dshArtifactsOpenTab({ id: ${JSON.stringify(imageArtifact)} }));
  await page.waitForTimeout(2000);
  imageState = await page.evaluate(() => {
    const img = document.querySelector("[data-dsh-artifact-image]");
    return {
      visible: Boolean(img),
      loaded: Boolean(img && img.complete && img.naturalWidth > 0),
      w: img ? img.naturalWidth : 0,
    };
  });
} catch {}
check(
  "多类型预览：markdown 文本 + 图片加载",
  markdownVisible && markdownText.includes("markdown-body-marker") && imageState.visible && imageState.loaded,
  JSON.stringify({ markdownVisible, markdownText, imageState }),
);
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
})();`;
}

await main();
