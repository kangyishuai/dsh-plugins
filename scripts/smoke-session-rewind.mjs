#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:session-rewind
//       SMOKE_DEBUG=1 pnpm smoke:session-rewind   —— 打印浏览器脚本的完整输出
// 端到端冒烟：临时 DSH_HOME 启动真实宿主，装当前源码打出的包，再用 ego-browser
// 点一遍「回溯」的两条主链路：
//   1. 用户消息操作行里的 ↶ 按钮 → 确认框 → 对话截断 + 输入框回填；
//   2. Esc Esc → 候选对话框 → 选一条 → 同样的效果；
//   3. 页面重载后，被撤回的行仍然隐藏（cuts 兜底路径）。
// 需要本机有 dsh 与 ego-browser；缺任意一个就跳过（退出码 0，打印 SKIP）。
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-rewind-shots");
const PKG_DIR = join(REPO, "packages", "session-rewind");
const PACKAGE = "@kangyishuai/dsh-session-rewind";

/** @param {string} message */
function fail(message) {
  console.error(`FAIL ${message}`);
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
    `宿主没有在超时时间内打印访问地址：\n${(await readIfExists(logPath)).slice(-2000)}`,
  );
}

/**
 * ego-browser 里跑的脚本：返回 { checks }，并把截图存到 shots。
 * @param {string} url
 * @param {string} shots
 */
function browserScript(url, shots) {
  return `(async () => {
const task = await taskSpace("dsh smoke: session-rewind");
const page = task.page("p1");
const SHOTS = ${JSON.stringify(shots)};
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
const shot = (name) => page.screenshot({ path: SHOTS + "/" + name + ".png" });
const LABELS = {
  rewind: ["回退到此处", "Rewind to here"],
  dialogList: ["回溯", "Rewind"],
  dialogConfirm: ["回退到此处", "Rewind to here"],
  cancel: ["取消", "Cancel"],
  confirm: ["回退", "Rewind"],
};
const matches = (text, list) => list.some((item) => String(text || "").trim() === item);
const dismiss = async () => {
  for (const label of ["继续", "开始使用", "跳过", "关闭"]) {
    await page.evaluate((text) => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
      if (btn) btn.click();
    }, label).catch(() => {});
    await page.waitForTimeout(200);
  }
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
};
const expandWorkspaces = () => page.evaluate(() => {
  for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
});
const sessionRows = () => page.evaluate(() =>
  [...document.querySelectorAll("[data-row-key^='session:']")].map((el) => el.getAttribute("data-row-key")));
const openSession = async (rowKey) => {
  const ok = await page.evaluate((key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    if (!row) return false;
    row.scrollIntoView({ block: "center" });
    row.click();
    return true;
  }, rowKey);
  await page.waitForTimeout(1100);
  return ok;
};
const userBubbles = () => page.evaluate(() =>
  [...document.querySelectorAll('[data-chat-flow-kind="user"]')].map((row) => {
    const content = row.querySelector('[data-slot="conversation.chat.user.content"]');
    const buttons = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "").filter(Boolean);
    return { text: ((content || row).textContent || "").trim(), buttons };
  }));
const rewindButtons = () => page.evaluate((labels) => {
  const rows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')];
  return rows.map((row) => [...row.querySelectorAll("button")].some((b) => labels.includes((b.getAttribute("aria-label") || "").trim())));
}, LABELS.rewind);
const clickRewindOn = (index) => page.evaluate(({ labels, target }) => {
  const rows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')];
  const row = rows[target];
  if (!row) return false;
  const btn = [...row.querySelectorAll("button")].find((b) => labels.includes((b.getAttribute("aria-label") || "").trim()));
  if (!btn) return false;
  btn.click();
  return true;
}, { labels: LABELS.rewind, target: index });
const dialogInfo = () => page.evaluate(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dlg) return null;
  const rows = [...dlg.querySelectorAll(".dsh-srw-row")];
  const footerButtons = [...dlg.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean);
  return {
    title: dlg.getAttribute("aria-label") || "",
    text: (dlg.textContent || "").replace(/\\s+/g, " "),
    rows: rows.map((row) => (row.textContent || "").trim()),
    preview: (() => { const el = dlg.querySelector(".dsh-srw-preview"); return el ? (el.textContent || "").trim() : ""; })(),
    buttons: footerButtons,
  };
});
const clickDialogButton = (labels) => page.evaluate((list) => {
  const dlg = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dlg) return false;
  const btn = [...dlg.querySelectorAll("button")].find((b) => list.includes((b.textContent || "").trim()) && !b.disabled);
  if (!btn) return false;
  btn.click();
  return true;
}, labels);
const clickDialogRow = (index) => page.evaluate((target) => {
  const dlg = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dlg) return false;
  const rows = [...dlg.querySelectorAll(".dsh-srw-row")];
  if (!rows[target]) return false;
  rows[target].click();
  return true;
}, index);
const composerText = () => page.evaluate(() => {
  const el = document.querySelector("[data-composer-input]");
  return el ? (el.textContent || "") : "";
});

await page.goto(${JSON.stringify(url)});
await page.waitForTimeout(5000);
await dismiss();
await expandWorkspaces();
await page.waitForTimeout(600);
await shot("01-home");

// 找一个至少有两条用户消息、且带 ↶ 按钮的会话
const rows = await sessionRows();
let picked = null;
let probe = "no-session";
for (const rowKey of rows) {
  if (!(await openSession(rowKey))) continue;
  const bubbles = await userBubbles();
  const hasButton = (await rewindButtons()).some(Boolean);
  probe = rowKey + ":" + bubbles.length + ":" + hasButton;
  if (bubbles.length >= 2 && hasButton) {
    picked = { rowKey, bubbles };
    break;
  }
}
check("找到可回溯的会话（≥2 条用户消息且出现 ↶ 按钮）", picked !== null, probe);
if (picked === null) {
  await shot("02-no-candidate");
  await task.finish({ keep: false }).catch(() => {});
  console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
  return;
}
await shot("02-session-open");

// 1) ↶ 按钮 → 确认框 → 回退到倒数第二条用户消息
const composerBefore = await composerText();
const clicked = await clickRewindOn(picked.bubbles.length - 2);
await page.waitForTimeout(700);
const confirmDialog = await dialogInfo();
check("点击 ↶ 打开确认框", clicked && confirmDialog !== null && matches(confirmDialog.title, LABELS.dialogConfirm), JSON.stringify(confirmDialog && confirmDialog.title));
check("确认框写明影响面", confirmDialog !== null && /移除|Remove/u.test(confirmDialog.text), confirmDialog && confirmDialog.text.slice(0, 120));
const targetHead = confirmDialog && confirmDialog.preview ? confirmDialog.preview.slice(0, 6) : "";
await shot("03-confirm-dialog");
const confirmed = await clickDialogButton(LABELS.confirm);
await page.waitForTimeout(2200);
const after = await userBubbles();
const composerAfter = await composerText();
const toastAfter = await page.evaluate(() => {
  const el = document.querySelector(".dsh-srw-toast");
  return el ? (el.textContent || "").trim() : "";
});
check("确认后对话被截断（目标行消失）", after.length === picked.bubbles.length - 2, after.length + "/" + (picked.bubbles.length - 2));
check(
  "确认后输入框回填目标消息文本",
  targetHead.length >= 2 && composerAfter.includes(targetHead),
  JSON.stringify({ targetHead, composerBefore, composerAfter: composerAfter.slice(0, 80), toast: toastAfter }),
);
check("标记占位行没有出现在对话里", !after.some((item) => (item.text || "").includes("(empty message)")), "");
await shot("04-after-button-rewind");

// 2) Esc Esc → 候选对话框 → 选一条 → 回退
await page.evaluate(() => {
  const el = document.querySelector("[data-composer-input]");
  if (el && typeof el.focus === "function") el.focus();
});
await page.waitForTimeout(200);
await page.keyboard.press("Escape");
await page.waitForTimeout(120);
await page.keyboard.press("Escape");
await page.waitForTimeout(900);
const listDialog = await dialogInfo();
check("Esc Esc 打开回溯对话框", listDialog !== null && matches(listDialog.title, LABELS.dialogList), listDialog && listDialog.title);
check("候选列表列出可回溯消息", listDialog !== null && listDialog.rows.length >= 1, listDialog && String(listDialog.rows.length));
await shot("05-esc-dialog");
const selected = await clickDialogRow(0);
await page.waitForTimeout(700);
const escConfirm = await dialogInfo();
check("选择候选后进入确认框", selected && escConfirm !== null && matches(escConfirm.title, LABELS.dialogConfirm), escConfirm && escConfirm.title);
const escConfirmed = await clickDialogButton(LABELS.confirm);
await page.waitForTimeout(2200);
const afterEsc = await userBubbles();
const composerEsc = await composerText();
check("Esc 流程确认后对话继续截断", escConfirmed && afterEsc.length < Math.max(after.length, 1), afterEsc.length + "/" + after.length);
check("Esc 流程回填输入框", composerEsc.trim() !== "", composerEsc.slice(0, 60));
await shot("06-after-esc-rewind");

// 3) 页面重载后隐藏仍然生效（cuts 兜底路径）
await page.reload();
await page.waitForTimeout(4500);
await dismiss();
await expandWorkspaces();
await page.waitForTimeout(600);
await openSession(picked.rowKey);
const afterReload = await userBubbles();
const expected = afterEsc.length;
check("重载后仍隐藏被撤回的行", afterReload.length === expected, afterReload.length + "/" + expected);
await shot("07-after-reload");

// 切到别的会话再切回来：每个会话挂载时都会重新 seed 一次 host cuts
const otherRows = (await sessionRows()).filter((key) => key !== picked.rowKey);
if (otherRows.length === 0) {
  check("切走再切回后仍隐藏被撤回的行", false, "临时 profile 里没有第二个会话");
} else {
  await openSession(otherRows[0]);
  await page.waitForTimeout(800);
  await openSession(picked.rowKey);
  const afterSwitch = await userBubbles();
  check("切走再切回后仍隐藏被撤回的行", afterSwitch.length === expected, afterSwitch.length + "/" + expected);
}
await shot("08-after-switch");

await task.finish({ keep: false }).catch(() => {});
console.log("SMOKE_STATE " + JSON.stringify({ sessionId: picked.rowKey.replace("session:", ""), userCountBefore: picked.bubbles.length }));
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
})();
`;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Node 的 zstdDecompressSync 只解第一帧；DSH 的 JSONL 日志是「一帧头 + 每批事件一帧」。
 * 按 zstd 魔数切帧后逐帧解压（真实日志实测 482/482 帧可解）。
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeZstdFrames(buffer) {
  /** @type {number[]} */
  const starts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const index = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (index < 0) break;
    starts.push(index);
    cursor = index + ZSTD_MAGIC.length;
  }
  if (starts.length === 0) return zstdDecompressSync(buffer).toString("utf8");
  let text = "";
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    } catch (_error) {
      /* 撕裂的尾帧忽略 */
    }
  }
  return text;
}

/**
 * 直接读临时 DSH_HOME 里的会话日志，验证回溯只追加了 marker、没有删改历史。
 * @param {string} home
 * @param {{ sessionId?: string, userCountBefore?: number }} state
 * @returns {Promise<{ name: string, ok: boolean, detail: string }[]>}
 */
async function verifySessionLog(home, state) {
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = [];
  /**
   * @param {string} name
   * @param {boolean} ok
   * @param {string} [detail]
   */
  const push = (name, ok, detail = "") => checks.push({ name, ok, detail });
  const sessionId = state.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    push("读会话日志：拿到 sessionId", false, "SMOKE_STATE 缺失");
    return checks;
  }
  /** @type {string | null} */
  let logPath = null;
  const roots = await readdir(join(home, "sessions"), { withFileTypes: true }).catch(() => []);
  for (const entry of roots) {
    if (!entry.isDirectory()) continue;
    const dir = join(home, "sessions", entry.name, sessionId);
    if (!existsSync(dir)) continue;
    const files = await readdir(dir).catch(() => []);
    const hit = files.find((name) => /^session\.v\d+\.jsonl(\.(zst|zstd|gz))?$/u.test(name));
    if (hit) logPath = join(dir, hit);
  }
  if (logPath === null) {
    push(
      "读会话日志：找到当前格式的日志文件",
      false,
      "没有匹配 session.v<N>.jsonl[.zstd|.gz] 的文件",
    );
    return checks;
  }
  let text;
  try {
    const buffer = await readFile(logPath);
    if (logPath.endsWith(".zstd") || logPath.endsWith(".zst"))
      text = zstdDecompressSync(buffer).toString("utf8");
    else if (logPath.endsWith(".gz")) text = gunzipSync(buffer).toString("utf8");
    else text = buffer.toString("utf8");
  } catch (error) {
    push("读会话日志：解压", false, String(error));
    return checks;
  }
  /** @type {any[]} */
  let events = [];
  const parseLines = (/** @type {string} */ value) => {
    /** @type {any[]} */
    const list = [];
    for (const line of value.split("\n")) {
      if (line.trim() === "") continue;
      try {
        list.push(JSON.parse(line));
      } catch (_error) {
        /* 尾部不完整行忽略 */
      }
    }
    return list;
  };
  events = parseLines(text);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const marked = events.some(
      (event) => event?.type === "user/message" && event?.data?.source?.kind === "session-rewind",
    );
    if (marked) break;
    await sleep(500);
    try {
      const buffer = await readFile(logPath);
      if (logPath.endsWith(".zstd") || logPath.endsWith(".zst")) text = decodeZstdFrames(buffer);
      else if (logPath.endsWith(".gz")) text = gunzipSync(buffer).toString("utf8");
      else text = buffer.toString("utf8");
      events = parseLines(text);
    } catch (_error) {
      /* 继续重试 */
    }
  }
  const human = events.filter(
    (event) => event?.type === "user/message" && event?.data?.source?.kind === "user",
  );
  const markers = events.filter(
    (event) => event?.type === "user/message" && event?.data?.source?.kind === "session-rewind",
  );
  const before = typeof state.userCountBefore === "number" ? state.userCountBefore : 0;
  push(
    "日志只追加：原始用户消息都还在",
    human.length >= before && before > 0,
    `human=${human.length} expectation>=${before}`,
  );
  push("两次回溯写了两条 marker", markers.length >= 2, `markers=${markers.length}`);
  const shaped = markers.filter(
    (event) =>
      event?.surfaceOp?.op === "replace" &&
      Number.isSafeInteger(event.surfaceOp.startSeq) &&
      Number.isSafeInteger(event.surfaceOp.endSeq) &&
      Array.isArray(event.sourceEventSeqs) &&
      event.sourceEventSeqs.length > 0 &&
      event.data.source.targetSeq === event.surfaceOp.startSeq &&
      event.surfaceOp.startSeq < event.seq &&
      event.surfaceOp.endSeq < event.seq,
  );
  push(
    "marker 形状正确（replace + 覆盖 shadowed 节点）",
    shaped.length === markers.length && markers.length > 0,
    `${shaped.length}/${markers.length}`,
  );
  const tail = markers[markers.length - 1];
  push(
    "marker 内容为非空占位文本",
    typeof tail?.data?.content?.[0]?.text === "string" && tail.data.content[0].text.length > 0,
    JSON.stringify(tail?.data?.content ?? null).slice(0, 80),
  );
  return checks;
}

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser")))
    return console.log("SKIP 未找到 ego-browser（GUI 冒烟需要本机浏览器环境）");

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-rewind-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  try {
    const profileSrc = join(process.env.HOME ?? "", ".dsh", "profiles", "desktop");
    const home = join(work, "home");
    const profile = join(home, "profiles", "srw");
    await mkdir(join(home, "profiles"), { recursive: true });
    await cp(profileSrc, profile, { recursive: true });
    for (const dir of ["sessions", "storages"]) {
      await cp(join(process.env.HOME ?? "", ".dsh", dir), join(home, dir), {
        recursive: true,
      }).catch(() => {});
    }
    const profileJson = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
    profileJson.name = "dsh-profile-srw-smoke";
    await writeFile(join(profile, "package.json"), JSON.stringify(profileJson, null, 2));

    // 没有会话就没东西可回溯，直接跳过而不是误报失败
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
    await run("dsh", ["plugin", "--profile", "srw", "install"], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", "srw", "remove", PACKAGE], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", "srw", "add", join(work, tgz)], { env });

    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", "srw", "--port", "0", "--no-open"], {
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
    if (boot.activationFailures > 0) {
      fail(`宿主报告 ${boot.activationFailures} 个插件未激活`);
      console.error(boot.text.slice(-3000));
      return;
    }

    const url = `http://127.0.0.1:${boot.port}/?token=${boot.token}`;
    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const browserSource = browserScript(url, shotsDir);
    await writeFile(browserFile, browserSource);
    await writeFile(join(shotsDir, "browser.mjs"), browserSource);

    const result = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
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

    if (process.env.SMOKE_DEBUG) console.log(String(result).slice(-8000));
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
        (item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`),
      );
      if (!item.ok) failed += 1;
    }
    // 停宿主，等它把会话日志 flush 落盘，然后直接读日志验证「只追加」与 marker 形状。
    host.kill("SIGTERM");
    await sleep(1200);
    host = undefined;
    const stateMatch = String(result).match(/SMOKE_STATE (\{.*\})/u);
    const state = stateMatch ? JSON.parse(stateMatch[1]) : {};
    const logChecks = await verifySessionLog(home, state);
    for (const item of logChecks) {
      console.log(
        (item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`),
      );
      parsed.checks.push(item);
      if (!item.ok) failed += 1;
    }
    if (failed > 0) {
      fail(`${failed} 项断言失败`);
      return;
    }
    console.log(`PASS 全部 ${parsed.checks.length} 项冒烟断言通过`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    await sleep(500);
    await cp(join(work, "shots"), SHOTS_OUT, { recursive: true }).catch(() => {});
    console.log(`截图目录：${SHOTS_OUT}`);
    await rm(work, { recursive: true, force: true });
  }
};

await main();
