// @ts-check
// 用法：pnpm shots:session-rewind
//
// 重新生成 README 里的效果图（packages/session-rewind/assets/*.png）。
//
// 安全前提（重要）：
//   1. 临时 DSH_HOME 里**只**放一个合成工作区 + 一个合成会话，不复制任何真实会话；
//   2. 截完图按 DOM 矩形裁剪，只保留对话框/面板本身，侧栏账号区与其它工作区都不在画面里；
//   3. 脚本会把裁剪矩形内的可见文本 dump 出来，便于程序化核对（本次核对：只出现合成句子）。
//
// 会话日志是按宿主的 v4 格式**逐条**手写的（每条一行、每行一个 zstd 帧）。格式校验很严
// （source 需要 producer-owned kind、tool/result 需要 toolCallId、title 需引用真实人类消息…），
// 所以这里刻意只用 user/message + turn/step 事件，够截图、且不会写出非法日志。
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const PKG = join(REPO, "packages/session-rewind");
const OUT = join(REPO, "packages/session-rewind/assets");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORKSPACE_PATH = "/tmp/atlas-shots-workspace";
const SESSION_ID = "session-6f1b0c3a-2c4d-4f0e-9a11-7b2c5d8e4a10";

/** @type {any[]} */
const events = [];
let seq = -1;
let clock = Date.now() - 1000 * 60 * 95; // 95 分钟前开始，显示为「刚刚 / 1 小时前」

const tick = (/** @type {number} */ seconds = 40) => {
  clock += seconds * 1000;
  return clock;
};
const push = (/** @type {any} */ event) => events.push(event);

const header = {
  type: "session",
  version: 4,
  id: SESSION_ID,
  createdAt: clock,
  cwd: WORKSPACE_PATH,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: "standard",
};
push(header);

push({ type: "permission/preset", seq: ++seq, time: tick(1), data: { preset: "full" } });
push({ type: "sandbox/mode", seq: ++seq, time: tick(1), data: { mode: "danger-full-access" } });

/**
 * @param {string} text
 */
const userMessage = (text) => {
  const envelope = {
    type: "user/message",
    seq: ++seq,
    time: tick(55),
    data: {
      content: [{ type: "text", text }],
      source: { kind: "user", rpcId: `rpc-${seq}`, clientTimeZone: "UTC" },
      role: "user",
      id: `msg-user-${seq}`,
    },
    surfaceOp: "append",
  };
  push(envelope);
  return seq;
};

/** @param {number} turn */
const turnStart = (/** @type {number} */ turn) => {
  push({ type: "turn/start", seq: ++seq, time: tick(1), data: { turn } });
  push({ type: "step/start", seq: ++seq, time: tick(1), data: { turn, step: 1 } });
};

// ---- 合成对话：一个假想项目 atlas 的小功能开发 ----
turnStart(1);
userMessage("给 atlas 的 report 命令加一个 --json 输出，先不要动默认的表格输出。");

push({ type: "step/end", seq: ++seq, time: tick(5), data: { turn: 1, step: 1 } });
push({ type: "turn/end", seq: ++seq, time: tick(2), data: { turn: 1, reason: "complete" } });

turnStart(2);
userMessage("顺便把表头对齐的 bug 也修一下，用户反馈列宽会跳。");

push({ type: "step/end", seq: ++seq, time: tick(5), data: { turn: 2, step: 1 } });
push({ type: "turn/end", seq: ++seq, time: tick(2), data: { turn: 2, reason: "complete" } });

turnStart(3);
userMessage("加个 --pretty 开关，默认压缩输出。再补两个测试。");

push({ type: "step/end", seq: ++seq, time: tick(5), data: { turn: 3, step: 1 } });
push({ type: "turn/end", seq: ++seq, time: tick(2), data: { turn: 3, reason: "complete" } });

turnStart(4);
userMessage("再顺便把 README 里的用法补一下，然后跑一遍完整测试。");

push({ type: "step/end", seq: ++seq, time: tick(5), data: { turn: 4, step: 1 } });
push({ type: "turn/end", seq: ++seq, time: tick(2), data: { turn: 4, reason: "complete" } });

turnStart(5);
userMessage("帮助文本先不用。我改主意了：--pretty 不要了，默认就输出可读 JSON。");

push({ type: "step/end", seq: ++seq, time: tick(5), data: { turn: 5, step: 1 } });
push({ type: "turn/end", seq: ++seq, time: tick(2), data: { turn: 5, reason: "complete" } });

/**
 * 去掉 PNG 里的 eXIf / tEXt / iTXt / zTXt / tIME 块：截图流水线（sips）会带时间戳等元数据，
 * 进公开仓库前应清掉。只重算块结构，不动像素。
 * @param {string} path
 */
function stripPngMetadata(path) {
  const strip = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
  const buffer = readFileSync(path);
  /** @type {Buffer[]} */
  const chunks = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const total = 12 + length;
    if (!strip.has(type)) chunks.push(buffer.subarray(offset, offset + total));
    if (type === "IEND") break;
    offset += total;
  }
  writeFileSync(path, Buffer.concat(chunks));
}

const main = async () => {
  await mkdir(WORKSPACE_PATH, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "dsh-readme-shots-"));
  const home = join(work, "home");
  const profileName = "atlas-shots";
  const profile = join(home, "profiles", profileName);
  await mkdir(join(home, "profiles"), { recursive: true });
  await cp(join(process.env.HOME ?? "", ".dsh", "profiles", "desktop"), profile, {
    recursive: true,
  });

  // 合成会话
  const slug = `--${WORKSPACE_PATH.replace(/^\//u, "").replace(/\//gu, "-")}--`;
  const sessionDir = join(home, "sessions", slug, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const lines = [JSON.stringify(header), ...events.slice(1).map((e) => JSON.stringify(e))];
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, "utf8")));
  await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), Buffer.concat(frames));

  // 合成工作区（只有这一个，侧栏不会出现真实工作区）
  await mkdir(join(home, "storages"), { recursive: true });
  await writeFile(
    join(home, "storages", "workspace.json"),
    JSON.stringify(
      {
        unit: { name: "workspace", version: 2 },
        global: {
          initialized: true,
          defaultWorkspaceId: "11111111-2222-4333-8444-555555555555",
          workspaceIds: ["11111111-2222-4333-8444-555555555555"],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
        tables: {
          workspaces: {
            "11111111-2222-4333-8444-555555555555": {
              path: WORKSPACE_PATH,
              title: "atlas",
              sessionIds: [SESSION_ID],
              createdAt: new Date(clock).toISOString(),
              updatedAt: new Date(clock).toISOString(),
            },
          },
        },
      },
      null,
      1,
    ),
  );

  // 装当前源码打的包
  await exec("pnpm", ["pack", "--pack-destination", work], { cwd: PKG });
  const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
  if (!tgz) throw new Error("pnpm pack 没有产出 tgz");
  const env = { ...process.env, DSH_HOME: home };
  await exec("dsh", ["plugin", "--profile", profileName, "add", join(work, tgz)], { env });

  const logPath = join(work, "host.log");
  const host = spawn("dsh", ["--profile", profileName, "--port", "0", "--no-open"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @type {string[]} */
  const chunks = [];
  host.stdout?.on("data", (c) => chunks.push(String(c)));
  host.stderr?.on("data", (c) => chunks.push(String(c)));
  const flush = () => writeFile(logPath, chunks.join(""));

  let url = "";
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await flush();
    const text = chunks.join("");
    const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/u);
    if (match) {
      url = `http://127.0.0.1:${match[1]}/?token=${match[2]}`;
      break;
    }
    await sleep(400);
  }
  await flush();
  if (url === "") {
    console.error("宿主没有打印访问地址：", chunks.join("").slice(-2000));
    host.kill("SIGTERM");
    return;
  }

  // 驱动浏览器：打开会话 → ↶ 确认框截图 → 执行回溯 → 面板截图
  const browser = `(async () => {
const task = await taskSpace("dsh readme shots");
const page = task.page("p1");
const OUT = ${JSON.stringify(join(work, "shots"))};
// 只清掉本脚本自己那个临时宿主留下的 loopback cookie；清空整个浏览器会毁掉用户真实登录态。
const purgeLoopbackCookies = async () => {
  try {
    await page.cdp("Network.enable");
    const all = await page.cdp("Network.getAllCookies");
    const cookies = Array.isArray(all) ? all : all?.cookies ?? [];
    const loopback = cookies.filter((c) => {
      const domain = String(c.domain || "").replace(/^./u, "");
      return domain === "127.0.0.1" || domain === "localhost" || domain === "[::1]";
    });
    for (const cookie of loopback) {
      await page.cdp("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path || "/",
      }).catch(() => {});
    }
    return { removed: loopback.length, total: cookies.length };
  } catch (_error) {
    return { removed: 0, total: 0 };
  }
};
await purgeLoopbackCookies();
await page.goto(${JSON.stringify(url)});
await page.waitForTimeout(5000);
for (const label of ["继续", "开始使用", "跳过", "关闭"]) {
  await page.evaluate((text) => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
    if (btn) btn.click();
  }, label).catch(() => {});
  await page.waitForTimeout(150);
}
for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
await page.evaluate(() => {
  for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
});
await page.waitForTimeout(700);
const opened = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')][0];
  if (!row) return false;
  row.click();
  return true;
});
await page.waitForTimeout(1600);
const rows = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);

// 确认框：点第 3 条用户消息的 ↶
const clicked = await page.evaluate(() => {
  const list = [...document.querySelectorAll('[data-chat-flow-kind="user"]')];
  const row = list[2] || list[list.length - 1];
  if (!row) return false;
  const btn = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回退到此处"));
  if (!btn) return false;
  btn.click();
  return true;
});
await page.waitForTimeout(2200);
const rectOf = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, selector);
const dialogRect = await rectOf('[role="dialog"][aria-modal="true"][class*="dsh-srw"], .dsh-srw-dialog');
// 导出裁剪区域内的全部可见文本，供调用方程序化核对（不靠人眼看图）
const textInRect = (rect) => page.evaluate((r) => {
  if (!r) return [];
  const root = document.querySelector(".dsh-srw-drawer") || document.querySelector(".dsh-srw-dialog");
  if (!root) return [];
  const lines = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.left < r.x - 4 || box.top < r.y - 4 || box.right > r.x + r.width + 4 || box.bottom > r.y + r.height + 4) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (own) lines.push(own);
  }
  return [...new Set(lines)];
}, rect);
const dialogText = await textInRect(dialogRect);
await page.screenshot({ path: OUT + "/dialog-full.png" });

// 执行回溯（仅对话）
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dsh-srw-dialog button")].find((b) => (b.textContent || "").trim() === "开始回退");
  if (btn) btn.click();
});
await page.waitForTimeout(2600);
// 面板：已撤回
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
  if (btn) btn.click();
});
await page.waitForTimeout(1400);
const drawerRect = await rectOf(".dsh-srw-drawer");
const drawerText = await textInRect(drawerRect);
await page.screenshot({ path: OUT + "/panel-full.png" });
// 候选列表
await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-drawer");
  const btn = root ? [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
  if (btn) btn.click();
});
await page.waitForTimeout(500);
await page.evaluate(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); });
await page.waitForTimeout(200);
await page.keyboard.press("Escape");
await page.waitForTimeout(120);
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
const listRect = await rectOf('[role="dialog"][aria-modal="true"][class*="dsh-srw"], .dsh-srw-dialog');
const listText = await textInRect(listRect);
await page.screenshot({ path: OUT + "/candidates-full.png" });
console.log("SHOT_STATE " + JSON.stringify({ opened, rows, clicked, dialogRect, drawerRect, listRect, dialogText, drawerText, listText }));
})();
`;
  await mkdir(join(work, "shots"), { recursive: true });
  const browserFile = join(work, "browser.mjs");
  await writeFile(browserFile, browser);
  const result = await new Promise((resolve) => {
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    void readFile(browserFile).then((buffer) => child.stdin.end(buffer));
  });
  const stateMatch = String(result).match(/SHOT_STATE (\{.*\})/u);
  if (!stateMatch) {
    console.error("浏览器脚本没有返回截图状态：", String(result).slice(-3000));
    host.kill("SIGTERM");
    return;
  }
  const state = JSON.parse(stateMatch[1]);
  if (state.rows === 0 || !state.dialogRect) {
    console.error("合成会话没有渲染出消息，放弃生成：", JSON.stringify(state).slice(0, 400));
    host.kill("SIGTERM");
    return;
  }
  host.kill("SIGTERM");
  await sleep(400);

  // 裁剪：只保留对话框/面板本身（用 macOS 的 sips，不引入图片依赖）。
  await mkdir(OUT, { recursive: true });
  /** @type {Array<[string, string, any]>} */
  const jobs = [
    ["dialog-full.png", "session-rewind-confirm.png", state.dialogRect],
    ["panel-full.png", "session-rewind-panel.png", state.drawerRect],
  ];
  for (const [sourceName, targetName, rect] of jobs) {
    if (!rect) continue;
    const pad = 8;
    const width = Math.round(rect.width + pad * 2);
    const height = Math.round(rect.height + pad * 2);
    const offsetY = Math.max(0, Math.round(rect.y - pad));
    const offsetX = Math.max(0, Math.round(rect.x - pad));
    const source = join(work, "shots", sourceName);
    const target = join(OUT, targetName);
    // sips: 先按偏移裁剪需要两步——用 --cropOffset 只在 -c 时生效，顺序为 y x
    await exec("sips", [
      "-c",
      String(height),
      String(width),
      "--cropOffset",
      String(offsetY),
      String(offsetX),
      source,
      "--out",
      target,
    ]);
    stripPngMetadata(target);
    console.log("wrote", target);
  }
  console.log("raw shots（临时，未提交）:", join(work, "shots"));
  console.log("裁剪区文本核对照（应只含合成内容）：");
  for (const key of ["dialogText", "drawerText", "listText"]) {
    const lines = Array.isArray(state[key]) ? state[key] : [];
    console.log(` ${key}: ${lines.join(" | ").slice(0, 300)}`);
  }
};

await main();
