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
// ego 的浏览器 profile 会跨任务累积每个临时宿主的 dsh-auth cookie；请求头超限会返回 HTTP 431。
await page.cdp("Network.clearBrowserCookies").catch(() => {});
const LABELS = {
  rewind: ["回退到此处", "Rewind to here"],
  dialogList: ["回溯", "Rewind"],
  dialogConfirm: ["回退到此处", "Rewind to here"],
  cancel: ["取消", "Cancel"],
  confirm: ["开始回退", "Start rewind"],
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
    // 只接受「候选列表里至少有 2 条可达消息」的会话：最后一条作为按钮流程目标，
    // 剩余候选留给 Esc 流程，避免选中已被 compaction 遮蔽的目标。
    await page.evaluate(() => {
      const el = document.querySelector("[data-composer-input]");
      if (el && typeof el.focus === "function") el.focus();
    });
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const candidateDialog = await dialogInfo();
    const candidates = candidateDialog ? candidateDialog.rows.length : 0;
    if (candidates > 0) await clickDialogButton(LABELS.cancel);
    await page.waitForTimeout(300);
    probe += ":" + candidates;
    if (candidates >= 2) {
      picked = { rowKey, bubbles };
      break;
    }
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

// 多视图一致性：在**另一个真实标签页**里打开同一个会话（它会在挂载时 seed 一次宿主 cuts），
// 然后在主标签页回溯，检查它不用刷新也会把这些行隐藏掉。
let page2 = null;
let tab2Before = -1;
try {
  page2 = await task.newPage();
  await page2.goto(${JSON.stringify(url)});
  await page2.waitForTimeout(4500);
  for (const label of ["继续", "开始使用", "跳过", "关闭"]) {
    await page2.evaluate((text) => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
      if (btn) btn.click();
    }, label).catch(() => {});
    await page2.waitForTimeout(150);
  }
  await page2.evaluate(() => {
    for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
  });
  await page2.waitForTimeout(600);
  await page2.evaluate((key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    if (row) { row.scrollIntoView({ block: "center" }); row.click(); }
  }, picked.rowKey);
  await page2.waitForTimeout(1500);
  tab2Before = await page2.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
} catch (error) {
  page2 = null;
}
check("第二个标签页打开了同一个会话", tab2Before > 0, String(tab2Before));

// 1) ↶ 按钮 → 确认框 → 回退到倒数第二条用户消息
const composerBefore = await composerText();
const clicked = await clickRewindOn(picked.bubbles.length - 1);
await page.waitForTimeout(1400);
const confirmDialog = await dialogInfo();
check("点击 ↶ 打开确认框", clicked && confirmDialog !== null && matches(confirmDialog.title, LABELS.dialogConfirm), JSON.stringify(confirmDialog && confirmDialog.title));
check("确认框写明影响面", confirmDialog !== null && /移除|Remove/u.test(confirmDialog.text), confirmDialog && confirmDialog.text.slice(0, 120));
check("确认框展示预览（将撤回 N 条消息）", confirmDialog !== null && /将撤回|This withdraws/u.test(confirmDialog.text), confirmDialog && confirmDialog.text.slice(0, 160));
const modeInfo = await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dialog) return null;
  const radios = [...dialog.querySelectorAll('input[type="radio"]')].map((r) => ({ value: r.value, disabled: r.disabled, checked: r.checked }));
  return { radios, text: (dialog.textContent || "").replace(/s+/g, " ") };
});
check("确认框有仅对话/对话+文件两个范围", modeInfo !== null && modeInfo.radios.length === 2, JSON.stringify(modeInfo && modeInfo.radios));
check("没有文件变更时文件模式被禁用", modeInfo !== null && modeInfo.radios.some((r) => r.value === "both" && r.disabled) && /无文件变更|No file changes/u.test(modeInfo.text), JSON.stringify(modeInfo && modeInfo.radios));
const resendBox = await page.evaluate(() => {
  const box = document.querySelector('.dsh-srw-dialog input[data-rewind-resend="true"]');
  return box ? { present: true, checked: box.checked } : { present: false, checked: false };
});
check(
  "确认框提供「回退后立即重发」且默认不勾选",
  resendBox.present === true && resendBox.checked === false,
  JSON.stringify(resendBox),
);
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
check("确认后对话被截断（目标行消失）", after.length === picked.bubbles.length - 1, after.length + "/" + (picked.bubbles.length - 1));
check(
  "确认后输入框回填目标消息文本",
  targetHead.length >= 1 && composerAfter.includes(targetHead),
  JSON.stringify({ targetHead, composerBefore, composerAfter: composerAfter.slice(0, 80), toast: toastAfter }),
);
check("标记占位行没有出现在对话里", !after.some((item) => (item.text || "").includes("(empty message)")), "");

// 多视图一致性：回溯成功后要往 localStorage 写广播，其它标签页据此重新拉宿主 cuts。
const broadcast = await page.evaluate(() => {
  const raw = window.localStorage.getItem("dsh-session-rewind.cut-broadcast.v1");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return { broken: true };
  }
});
check(
  "回溯成功后写入跨视图广播（localStorage）",
  broadcast !== null && typeof broadcast.sessionId === "string" && broadcast.sessionId.length > 0,
  JSON.stringify(broadcast),
);
// 模拟另一个标签页收到 storage 事件：不应报错，且被撤回的行仍然隐藏。
const afterBroadcast = await page.evaluate(async (raw) => {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key: "dsh-session-rewind.cut-broadcast.v1", newValue: raw }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { ok: true, users: document.querySelectorAll('[data-chat-flow-kind="user"]').length };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}, JSON.stringify(broadcast));
check(
  "收到其它视图广播后重新隐藏且不报错",
  afterBroadcast?.ok === true && afterBroadcast.users === after.length,
  JSON.stringify(afterBroadcast),
);
// 真两标签页：第二个标签页没刷新，也应靠广播 + 宿主 cuts 自动同步。
let tab2After = -1;
if (page2 !== null) {
  await page.waitForTimeout(2500);
  tab2After = await page2.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
  await page2.screenshot({ path: SHOTS + "/05-second-tab-synced.png" }).catch(() => {});
}
check(
  "另一个标签页无需刷新即同步隐藏（真两标签页）",
  page2 !== null && tab2Before > 0 && tab2After === after.length,
  JSON.stringify({ tab2Before, tab2After, expected: after.length }),
);
await shot("04-after-button-rewind");

// 1b) 回溯面板：已撤回 / 回溯记录 / 救援点 / 设置
const drawerOpened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
  if (!btn) return false;
  btn.click();
  return true;
});
await page.waitForTimeout(900);
const drawer = await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-drawer");
  if (!root) return null;
  return {
    text: (root.textContent || "").replace(/s+/g, " "),
    tabs: [...root.querySelectorAll(".dsh-srw-tab")].map((t) => (t.textContent || "").trim()),
  };
});
check("会话头部图标打开回溯面板", drawerOpened && drawer !== null, JSON.stringify(drawer && drawer.tabs));
check("回溯面板包含四个页签", drawer !== null && ["已撤回", "回溯记录", "救援点", "设置"].every((tab) => drawer.tabs.includes(tab)), JSON.stringify(drawer && drawer.tabs));
const auditTab = await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".dsh-srw-tab")].find((t) => (t.textContent || "").trim() === "回溯记录");
  if (!tab) return false;
  tab.click();
  return true;
});
await page.waitForTimeout(900);
const auditText = await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-drawer");
  return root ? (root.textContent || "").replace(/s+/g, " ") : "";
});
check("回溯记录页签出现本次回执", auditTab && /仅对话|Conversation/u.test(auditText) && /条|message/u.test(auditText), auditText.slice(0, 160));
const timeline = await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-timeline");
  if (!root) return null;
  return {
    nodes: root.querySelectorAll(".dsh-srw-tl-node").length,
    kinds: [...root.querySelectorAll(".dsh-srw-tl-node")].map((n) => n.getAttribute("data-kind")),
    dots: root.querySelectorAll(".dsh-srw-tl-dot").length,
  };
});
check(
  "回溯记录以时间线渲染（节点 + 圆点）",
  timeline !== null && timeline.nodes >= 1 && timeline.dots === timeline.nodes,
  JSON.stringify(timeline),
);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dsh-srw-drawer button")].find((b) => (b.getAttribute("aria-label") || "").includes("关闭") || (b.textContent || "").trim() === "关闭");
  if (btn) btn.click();
});
await page.waitForTimeout(400);

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
const searchNeedle = listDialog !== null && listDialog.rows.length > 0 ? listDialog.rows[0].slice(0, 2) : "";
const searched = await page.evaluate((value) => {
  const input = document.querySelector('.dsh-srw-dialog input[type="search"]');
  if (!input) return false;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}, searchNeedle);
await page.waitForTimeout(800);
const filtered = await dialogInfo();
check(
  "候选列表可以搜索",
  searched && searchNeedle.length > 0 && filtered !== null && filtered.rows.length >= 1 && filtered.rows.every((row) => row.includes(searchNeedle)),
  JSON.stringify({ needle: searchNeedle, rows: filtered && filtered.rows.length }),
);
const loadOlder = await page.evaluate(async () => {
  const input = document.querySelector('.dsh-srw-dialog input[type="search"]');
  if (input) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  const btn = [...document.querySelectorAll(".dsh-srw-dialog button")].find((b) => (b.textContent || "").includes("加载更早"));
  if (!btn) return { available: false };
  const before = document.querySelectorAll(".dsh-srw-row").length;
  btn.click();
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { available: true, before, after: document.querySelectorAll(".dsh-srw-row").length };
});
check("候选列表可以加载更早（无更多候选时记为通过）", loadOlder.available === false || loadOlder.after > loadOlder.before, JSON.stringify(loadOlder));
const selected = await clickDialogRow(0);
await page.waitForTimeout(1400);
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

// 4) /rewind 命令 + 候选搜索 + 设置偏好（放在最后，避免影响主链路）
const candidateRows = (await sessionRows()).filter((key) => key !== picked.rowKey);
let commandSession = null;
// 不假设「前 6 个会话里一定有空草稿」：临时 home 是从真实 profile 复制的，会话数量和草稿
// 状态都会随使用变化。这里遍历全部会话，必要时先把草稿清空再按 Esc。
for (const rowKey of candidateRows) {
  await openSession(rowKey);
  await page.waitForTimeout(700);
  const composer = await composerText();
  if (composer.trim() !== "") {
    const cleared = await page.evaluate(() => {
      const el = document.querySelector("[data-composer-input]");
      if (!el) return false;
      el.focus();
      const sel = document.getSelection();
      if (!sel) return false;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return document.execCommand("delete", false) === true;
    });
    if (!cleared) continue;
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    if (el && typeof el.focus === "function") el.focus();
  });
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const list = await dialogInfo();
  const rows = list ? list.rows.length : 0;
  if (rows > 0) {
    await clickDialogButton(LABELS.cancel);
    await page.waitForTimeout(300);
    commandSession = rowKey;
    break;
  }
  await clickDialogButton(LABELS.cancel).catch(() => {});
  await page.waitForTimeout(300);
}
if (commandSession === null) {
  check("/rewind 命令打开候选", false, "没有空闲草稿且候选可达的会话");
} else {
  await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    if (el && typeof el.focus === "function") el.focus();
  });
  await page.keyboard.insertText("/rewind");
  await page.waitForTimeout(300);
  const filled = await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    const text = el ? (el.textContent || "").trim() : "";
    return { filled: text === "/rewind", text };
  });
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1400);
  const popup = await page.evaluate(() => {
    const root = document.querySelector('[role="listbox"], [role="menu"], [class*="popup"]');
    if (!root) return { open: false, options: [] };
    const options = [...root.querySelectorAll('[role="option"], [role="menuitem"], button')].map((el) => (el.textContent || "").trim()).filter((text) => text !== "");
    return { open: true, options: options.slice(0, 6), html: (root.outerHTML || "").slice(0, 300) };
  });
  check("/rewind 命令打开候选", filled.filled && popup.open && popup.options.length > 0, JSON.stringify({ filled, popup }));
  if (popup.open && popup.options.length > 0) {
    await page.evaluate(() => {
      const root = document.querySelector('[role="listbox"], [role="menu"], [class*="popup"]');
      const option = root ? [...root.querySelectorAll('[role="option"], [role="menuitem"], button')].find((el) => (el.textContent || "").trim() !== "") : null;
      if (option) option.click();
    });
    await page.waitForTimeout(1200);
    const commandConfirm = await dialogInfo();
    check("/rewind 选择候选后进入确认框", commandConfirm !== null && matches(commandConfirm.title, LABELS.dialogConfirm), commandConfirm && commandConfirm.title);
    await clickDialogButton(LABELS.cancel);
    await page.waitForTimeout(400);
  }
}

// 设置偏好：改 → 持久化 → 恢复
const drawerOpen2 = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
  if (!btn) return false;
  btn.click();
  return true;
});
await page.waitForTimeout(700);
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".dsh-srw-tab")].find((t) => (t.textContent || "").trim() === "设置");
  if (tab) tab.click();
});
await page.waitForTimeout(1400);
const healthText = await page.evaluate(async () => {
  const drawer = document.querySelector(".dsh-srw-drawer");
  if (!drawer) return "";
  const refresh = [...drawer.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "刷新");
  if (refresh) refresh.click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return (drawer.textContent || "").replace(/s+/g, " ");
});
check(
  "诊断页报告只读工具已注册",
  /只读工具/u.test(healthText) && /enabled|disabled by config/u.test(healthText),
  healthText.slice(0, 400),
);
const changed = await page.evaluate(() => {
  const drawer = document.querySelector(".dsh-srw-drawer");
  if (!drawer) return "no-drawer";
  const radios = [...drawer.querySelectorAll('input[type="radio"]')];
  const both = radios.find((r) => (r.parentElement && (r.parentElement.textContent || "").includes("回退对话和文件"))) || radios[radios.length - 1];
  both.click();
  const number = drawer.querySelector('input[type="number"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setValue.call(number, "20");
  number.dispatchEvent(new Event("input", { bubbles: true }));
  const checkbox = drawer.querySelector('input[type="checkbox"]');
  if (checkbox && checkbox.checked) checkbox.click();
  return "changed";
});
await page.waitForTimeout(500);
const savedPrefs = await page.evaluate(() => localStorage.getItem("dsh-session-rewind.prefs.v1"));
check(
  "设置页修改默认范围/每页数量/列表确认并持久化",
  drawerOpen2 && changed === "changed" && /"defaultMode":"both"/u.test(savedPrefs || "") && /"pageSize":20/u.test(savedPrefs || "") && /"confirmOnList":false/u.test(savedPrefs || ""),
  savedPrefs || "",
);
await page.evaluate(() => {
  const drawer = document.querySelector(".dsh-srw-drawer");
  const radios = [...drawer.querySelectorAll('input[type="radio"]')];
  const chat = radios.find((r) => (r.parentElement && (r.parentElement.textContent || "").includes("仅回退对话"))) || radios[0];
  chat.click();
  const number = drawer.querySelector('input[type="number"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setValue.call(number, "100");
  number.dispatchEvent(new Event("input", { bubbles: true }));
  const checkbox = drawer.querySelector('input[type="checkbox"]');
  if (checkbox && !checkbox.checked) checkbox.click();
});
await page.waitForTimeout(400);
const restoredPrefs = await page.evaluate(() => localStorage.getItem("dsh-session-rewind.prefs.v1"));
check("设置页可以恢复默认偏好", /"defaultMode":"chat"/u.test(restoredPrefs || "") && /"pageSize":100/u.test(restoredPrefs || ""), restoredPrefs || "");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dsh-srw-drawer button")].find((b) => (b.textContent || "").trim() === "关闭");
  if (btn) btn.click();
});

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
  // 插件审计：每次回溯一行，sessionId 匹配，mode=chat（本轮没有文件变更）。
  /** @type {any[]} */
  let auditEntries = [];
  try {
    const auditText = await readFile(join(home, "session-rewind", "audit.jsonl"), "utf8");
    auditEntries = auditText
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch (_error) {
    auditEntries = [];
  }
  const ownAudit = auditEntries.filter((entry) => entry.sessionId === sessionId);
  push("审计日志记录了回溯", ownAudit.length >= 2, `entries=${ownAudit.length}`);
  push(
    "审计记录带 markerSeq 与 chat 模式",
    ownAudit.length > 0 &&
      ownAudit.every((entry) => Number.isSafeInteger(entry.markerSeq)) &&
      ownAudit.every((entry) => entry.mode === "chat"),
    JSON.stringify(
      ownAudit.map((entry) => ({ mode: entry.mode, markerSeq: entry.markerSeq })),
    ).slice(0, 160),
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
