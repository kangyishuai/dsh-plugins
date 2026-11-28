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
import { NOTICE_DISMISS_SOURCE } from "./lib/browser-helpers.mjs";
import {
  isFailedRun,
  reclaimTimedOutTaskSpace,
  reportBrowserFailureHint,
  reportFailureScene,
} from "./lib/smoke-failure.mjs";

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
 * @param {string} home 临时 DSH_HOME（召回断言从这里读会话日志）
 */
function browserScript(url, shots, home) {
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
task = await taskSpace("dsh smoke: session-rewind");
// ego 的 TaskSpace 有页面额度（8）。历史失败运行可能留下没关的页面，
// 攒满后所有断言都会以 "Page budget reached" 失败 —— 开跑前先清场。
for (const stale of await task.pages().catch(() => [])) {
  await stale.close().catch(() => {});
}
// task.page() 只能引用已存在的页面；本次运行自己新建一个，跑完关掉。
const page = await task.newPage();
const SHOTS = ${JSON.stringify(shots)};
const HOME = ${JSON.stringify(home)};
// 期望文本从会话日志读：ego-browser 的 nodejs 运行时是完整 Node，可以直接 fs。
const { readFile, readdir } = await import("node:fs/promises");
const { join } = await import("node:path");
const { zstdDecompressSync, gunzipSync } = await import("node:zlib");
const decodeZstdFrames = ${decodeZstdFrames.toString()};
const readSessionDigest = ${readSessionDigest.toString()};
const digestDeps = {
  readFile: readFile,
  readdir: readdir,
  join: join,
  gunzipSync: gunzipSync,
  decodeZstdFrames: decodeZstdFrames,
};
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
const shot = (name) => page.screenshot({ path: SHOTS + "/" + name + ".png" });
// ego 的浏览器 profile 会跨任务累积每个**临时宿主**的 dsh-auth cookie；请求头超限会返回 HTTP 431。
// 但绝不能清空整个浏览器：那是用户真实的浏览器 profile（.github.com / .claude.ai 等都在里面）。
// 只删 host 是 loopback 的 cookie（127.0.0.1 / localhost），也就是本脚本自己攒下来的那些。
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
const cookieScope = await purgeLoopbackCookies();
console.log("SMOKE_COOKIES " + JSON.stringify(cookieScope));
const LABELS = {
  rewind: ["回退到此处", "Rewind to here"],
  dialogList: ["回溯", "Rewind"],
  dialogConfirm: ["回退到此处", "Rewind to here"],
  cancel: ["取消", "Cancel"],
  confirm: ["开始回退", "Start rewind"],
};
const matches = (text, list) => list.some((item) => String(text || "").trim() === item);
${NOTICE_DISMISS_SOURCE}
const dismiss = async () => {
  await dismissNoticesOn(page);
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
// —— 输入框召回断言用的浏览器侧辅助（↑/↓ 历史召回，非破坏性）——
// 统一用 textContent 判文本：Lexical 的空草稿渲染成空段落，innerText 只有一个换行，textContent 是空串。
const composerDetail = () => page.evaluate(() => {
  const el = document.querySelector("[data-composer-input]");
  if (!el) return { present: false, text: "", innerText: "", active: false, sessionAttr: null, caret: null, box: null, lineHeight: null };
  const selection = document.getSelection();
  let caret = null;
  const box = el.getBoundingClientRect();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    caret = { top: rect.top, bottom: rect.bottom, height: rect.height };
  }
  const occurrence = el.closest ? el.closest("[data-conversation-session]") : null;
  const style = getComputedStyle(el);
  return {
    present: true,
    text: el.textContent || "",
    innerText: el.innerText || "",
    active: document.activeElement === el,
    collapsed: selection ? selection.isCollapsed : null,
    sessionAttr: occurrence ? occurrence.getAttribute("data-conversation-session") : null,
    caret: caret,
    box: { top: box.top, bottom: box.bottom, height: box.height },
    lineHeight: style.lineHeight,
  };
});
const selectRecallComposerContents = () => page.evaluate(() => {
  const el = document.querySelector("[data-composer-input]");
  if (!el) return false;
  el.focus();
  const selection = document.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
});
// 清空草稿必须走真实按键：document.execCommand("delete") 只改 DOM、不改 Lexical 编辑器状态，
// 下一次宿主重渲染会把旧草稿“还”回来（实测会让后面「回溯回填」的既有断言失败）。
const clearRecallDraft = async () => {
  let state = await composerDetail();
  if (state.text.trim() === "") return { ok: true, text: state.text, attempts: 0 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const selected = await selectRecallComposerContents();
    if (!selected) return { ok: false, text: state.text, attempts: attempt };
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(220);
    state = await composerDetail();
    if (state.text.trim() === "") return { ok: true, text: state.text, attempts: attempt + 1 };
  }
  return { ok: false, text: state.text, attempts: 3 };
};
const focusRecallComposer = async () => {
  await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    if (!el) return false;
    el.focus();
    const selection = document.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  });
  await page.waitForTimeout(200);
};
const putRecallCaretOnFirstLine = () => page.evaluate(() => {
  const el = document.querySelector("[data-composer-input]");
  if (!el) return false;
  el.focus();
  const selection = document.getSelection();
  if (!selection) return false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  const range = document.createRange();
  if (first) range.setStart(first, 0);
  else range.selectNodeContents(el);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
});
const collapseRecallText = (value) => String(value === null || value === undefined ? "" : value).replace(/\\s+/gu, " ").trim();
const sameRecallText = (left, right) => {
  const a = collapseRecallText(left);
  const b = collapseRecallText(right);
  return a.length > 0 && a === b;
};
const waitForRecallDraft = async (expected, timeoutMs) => {
  const deadline = Date.now() + (typeof timeoutMs === "number" ? timeoutMs : 3000);
  let state = await composerDetail();
  while (Date.now() < deadline) {
    if (sameRecallText(state.text, expected)) return state;
    await page.waitForTimeout(120);
    state = await composerDetail();
  }
  return state;
};
const recallDetail = (expected, state) => JSON.stringify({
  expected: collapseRecallText(expected).slice(0, 60),
  got: collapseRecallText(state && state.text).slice(0, 60),
  gotLen: String((state && state.text) || "").length,
  expectedLen: String(expected || "").length,
  caret: state ? state.caret : null,
  box: state ? state.box : null,
  lineHeight: state ? state.lineHeight : null,
});
// 观察 ↑/↓ 在各阶段是否被 consume：element/document 冒泡（宿主 composer 内部）→ window-late
// （宿主 fixed input 派发之后，也就是插件观察者跑过之后）。用来断言「关掉设置后不再吞键」。
const installRecallKeyProbe = () => page.evaluate(() => {
  window.__recallStages = [];
  const record = (stage) => (event) => {
    if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
    window.__recallStages.push({ stage: stage, code: event.code, prevented: event.defaultPrevented });
  };
  const el = document.querySelector("[data-composer-input]");
  if (!el) return false;
  if (window.__recallKeyProbeBound !== true) {
    window.__recallKeyProbeBound = true;
    el.addEventListener("keydown", record("element"));
    document.addEventListener("keydown", record("document"));
    window.addEventListener("keydown", record("window-late"));
  }
  return true;
});
const readRecallStages = () => page.evaluate(() => (window.__recallStages || []).slice());
const lastRecallStage = (stages, code, stage) => {
  const hits = (stages || []).filter((item) => item.code === code && item.stage === stage);
  return hits.length > 0 ? hits[hits.length - 1].prevented : null;
};

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
  await finishTask();
  console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
  return;
}
await shot("02-session-open");

// 0) 输入框 ↑/↓ 召回历史输入（非破坏性）：必须放在任何回溯之前，会话历史才完整。
//    期望文本从**会话日志**里读（不硬编码句子），并剔除已被既有 cuts 遮蔽的消息。
//    注意：上面选中的 picked 会话可能整段已经被回溯过（用户消息都被 cuts 遮蔽），召回历史为空；
//    所以这里单独挑一个「≥2 条未回滚用户消息」的会话，测完再切回 picked，不干扰后续流程。
const recallDigestOf = (sessionId) => readSessionDigest({ home: HOME, sessionId: sessionId }, digestDeps);
const recallCandidates = [picked.rowKey].concat(rows.filter((key) => key !== picked.rowKey));
let recallPickRow = null;
let recallDigestBefore = null;
for (let i = 0; i < recallCandidates.length; i += 1) {
  let candidateDigest = null;
  try {
    candidateDigest = await recallDigestOf(recallCandidates[i].replace("session:", ""));
  } catch (_error) {
    candidateDigest = null;
  }
  if (candidateDigest && Array.isArray(candidateDigest.visibleTexts) && candidateDigest.visibleTexts.length >= 2) {
    recallPickRow = recallCandidates[i];
    recallDigestBefore = candidateDigest;
    break;
  }
}
check(
  "召回：找到含 ≥2 条未回滚用户消息的会话",
  recallPickRow !== null && recallDigestBefore !== null,
  recallDigestBefore ? "visible=" + recallDigestBefore.visibleTexts.length : "临时 profile 里没有可召回的会话",
);
const recallPrompts = recallDigestBefore && Array.isArray(recallDigestBefore.visibleTexts) ? recallDigestBefore.visibleTexts : [];
const recallNewest = recallPrompts.length > 0 ? recallPrompts[recallPrompts.length - 1] : "";
const recallPrevious = recallPrompts.length > 1 ? recallPrompts[recallPrompts.length - 2] : "";
const recallSessionId = recallPickRow === null ? "" : recallPickRow.replace("session:", "");
const recallSameSession = recallPickRow === picked.rowKey;
if (recallPickRow !== null && !recallSameSession) {
  await openSession(recallPickRow);
  await page.waitForTimeout(1400);
}
if (recallPickRow !== null) {
  const recallBubblesBefore = await userBubbles();
  // A1：空草稿按 ↑ → 最新一条用户输入
  const clearedForA1 = await clearRecallDraft();
  await focusRecallComposer();
  const composerReady = await composerDetail();
  check(
    "召回前提：输入框已聚焦、草稿为空、能定位当前会话",
    clearedForA1.ok === true &&
      composerReady.present === true &&
      composerReady.active === true &&
      composerReady.text.trim() === "" &&
      composerReady.sessionAttr === recallSessionId,
    JSON.stringify({
      cleared: clearedForA1.ok,
      active: composerReady.active,
      sessionAttr: composerReady.sessionAttr,
      expectedSession: recallSessionId,
      draft: composerReady.text.slice(0, 40),
    }),
  );
  await installRecallKeyProbe();
  await page.keyboard.press("ArrowUp");
  const afterA1 = await waitForRecallDraft(recallNewest, 3000);
  const stagesA1 = await readRecallStages();
  check(
    "空草稿按 ↑ 召回最新一条用户输入",
    sameRecallText(afterA1.text, recallNewest),
    recallDetail(recallNewest, afterA1) + " stages=" + JSON.stringify(stagesA1),
  );
  // A2：再按 ↑ → 上一条
  await page.keyboard.press("ArrowUp");
  const afterA2 = await waitForRecallDraft(recallPrevious, 3000);
  check(
    "再按 ↑ 往前走一条用户输入",
    sameRecallText(afterA2.text, recallPrevious),
    recallDetail(recallPrevious, afterA2),
  );
  // A3：↓ → 最新一条；再 ↓ → 还原原来的空草稿
  await page.keyboard.press("ArrowDown");
  const afterA3a = await waitForRecallDraft(recallNewest, 3000);
  await page.keyboard.press("ArrowDown");
  const afterA3b = await waitForRecallDraft("", 3000);
  check(
    "按 ↓ 回到最新一条、再按 ↓ 还原原来的空草稿",
    sameRecallText(afterA3a.text, recallNewest) && afterA3b.text.trim() === "",
    JSON.stringify({
      forward: recallDetail(recallNewest, afterA3a),
      restoredText: afterA3b.text.slice(0, 20),
      restoredInnerText: afterA3b.innerText.slice(0, 20),
    }),
  );
  // A4：非空草稿 + 光标在第一行 → ↑ 召回；一路 ↓ 到底原样还回草稿
  const ownDraft = "召回草稿 keep-me " + Date.now();
  const clearedForA4 = await clearRecallDraft();
  await page.keyboard.insertText(ownDraft);
  await page.waitForTimeout(300);
  await putRecallCaretOnFirstLine();
  await page.waitForTimeout(200);
  const beforeA4 = await composerDetail();
  await page.keyboard.press("ArrowUp");
  const afterA4recall = await waitForRecallDraft(recallNewest, 3000);
  let afterA4restore = await composerDetail();
  for (let i = 0; i <= recallPrompts.length + 1; i += 1) {
    if (afterA4restore.text.trim() === ownDraft) break;
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    afterA4restore = await composerDetail();
    if (afterA4restore.text.trim() === ownDraft) break;
  }
  check(
    "非空草稿（光标在第一行）按 ↑ 也能召回",
    clearedForA4.ok === true && beforeA4.text.trim() === ownDraft && sameRecallText(afterA4recall.text, recallNewest),
    recallDetail(recallNewest, afterA4recall) + " draft=" + JSON.stringify(beforeA4.text.slice(0, 40)),
  );
  check(
    "按 ↓ 到底原样还回用户自己的草稿（stash/restore）",
    afterA4restore.text.trim() === ownDraft,
    JSON.stringify({ expected: ownDraft, restored: afterA4restore.text.slice(0, 60), caret: afterA4restore.caret }),
  );
  // A5：非破坏性——没有新增 user/message、没有回溯标记、对话行数不变
  const clearedAfterA4 = await clearRecallDraft();
  await page.waitForTimeout(1200);
  let digestAfterRecall = await recallDigestOf(recallSessionId);
  await page.waitForTimeout(900);
  const digestAfterRecallLate = await recallDigestOf(recallSessionId);
  const sameSeqList = (left, right) => JSON.stringify(left || []) === JSON.stringify(right || []);
  const bubblesAfterRecall = await userBubbles();
  const dialogAfterRecall = await dialogInfo();
  const toastAfterRecall = await page.evaluate(() => {
    const el = document.querySelector(".dsh-srw-toast");
    return el ? (el.textContent || "").trim() : "";
  });
  const nonDestructive =
    clearedAfterA4.ok === true &&
    digestAfterRecall !== null &&
    digestAfterRecallLate !== null &&
    sameSeqList(digestAfterRecall.userMessageSeqs, recallDigestBefore.userMessageSeqs) &&
    sameSeqList(digestAfterRecallLate.userMessageSeqs, recallDigestBefore.userMessageSeqs) &&
    sameSeqList(digestAfterRecallLate.humanSeqs, recallDigestBefore.humanSeqs) &&
    digestAfterRecall.markerCount === recallDigestBefore.markerCount &&
    digestAfterRecallLate.markerCount === recallDigestBefore.markerCount &&
    bubblesAfterRecall.length === recallBubblesBefore.length &&
    dialogAfterRecall === null &&
    toastAfterRecall === "";
  check(
    "召回全程非破坏：无新 user/message、无回溯标记、对话行数不变",
    nonDestructive,
    JSON.stringify({
      userMessagesBefore: (recallDigestBefore.userMessageSeqs || []).length,
      userMessagesAfter: digestAfterRecall ? (digestAfterRecall.userMessageSeqs || []).length : null,
      humanBefore: (recallDigestBefore.humanSeqs || []).length,
      humanAfterLate: digestAfterRecallLate ? (digestAfterRecallLate.humanSeqs || []).length : null,
      maxSeqBefore: recallDigestBefore.maxSeq,
      maxSeqAfter: digestAfterRecall ? digestAfterRecall.maxSeq : null,
      markersBefore: recallDigestBefore.markerCount,
      markersAfter: digestAfterRecall ? digestAfterRecall.markerCount : null,
      bubblesBefore: recallBubblesBefore.length,
      bubblesAfter: bubblesAfterRecall.length,
      dialogOpen: dialogAfterRecall !== null,
      toast: toastAfterRecall,
    }),
  );
  // A6：关掉设置里的召回开关后，↑ 既不吞键也不填草稿（降级为纯光标移动）
// 打开 设置 → 会话回溯 分节（偏好与诊断都在这里；抽屉里已不再有「设置」页签）。
const openRewindSettings = () =>
  page.evaluate(async () => {
    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const opener = '[data-shortcut-modal="settings"]';
    const isOpen = () => Boolean(document.querySelector(opener));
    if (!isOpen()) {
      const account = [...document.querySelectorAll("button")].find(
        (b) => (b.getAttribute("aria-label") || "") === "账号菜单",
      );
      if (account) {
        account.click();
        await sleepMs(700);
        const item = [...document.querySelectorAll('[role="menu"] button, [role="menuitem"]')].find(
          (el) => (el.textContent || "").trim().startsWith("设置"),
        );
        if (item) {
          item.click();
          await sleepMs(900);
        }
      }
    }
    if (!isOpen()) return "no-settings-panel";
    const shell = document.querySelector(opener);
    const nav = [...shell.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "会话回溯",
    );
    if (!nav) return "no-section-nav";
    nav.click();
    await sleepMs(1200);
    return "ok";
  });

const closeRewindSettings = () =>
  page.evaluate(async () => {
    const panel = document.querySelector('[data-shortcut-modal="settings"]');
    if (!panel) return;
    const close = [...panel.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "关闭",
    );
    if (close) close.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  const drawerOpenedForRecall = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  const settingsOpenedForRecall = await openRewindSettings();
  const recallToggleOff = await page.evaluate(() => {
    const panel = document.querySelector("[data-srw-settings]");
    if (!panel) return "no-section";
    const label = [...panel.querySelectorAll("label")].find((el) => /召回|recalls earlier/iu.test(el.textContent || ""));
    const box = label ? label.querySelector('input[type="checkbox"]') : null;
    if (!box) return "no-checkbox";
    if (box.checked) box.click();
    return box.checked ? "still-checked" : "unchecked";
  });
  await page.waitForTimeout(500);
  await closeRewindSettings();
  const recallPrefsOff = await page.evaluate(() => localStorage.getItem("dsh-session-rewind.prefs.v1"));
  const clearedForA6 = await clearRecallDraft();
  await focusRecallComposer();
  await installRecallKeyProbe();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(1200);
  const afterA6 = await composerDetail();
  const stagesA6 = await readRecallStages();
  const consumedA6 = lastRecallStage(stagesA6, "ArrowUp", "window-late");
  check(
    "关掉召回设置后 ↑ 既不填草稿也不吞键",
    drawerOpenedForRecall === true &&
      recallToggleOff === "unchecked" &&
      /"recallEnabled":false/u.test(recallPrefsOff || "") &&
      clearedForA6.ok === true &&
      afterA6.text.trim() === "" &&
      consumedA6 === false,
    JSON.stringify({
      drawerOpened: drawerOpenedForRecall,
      toggle: recallToggleOff,
      prefs: (recallPrefsOff || "").slice(0, 120),
      draft: afterA6.text.slice(0, 40),
      consumedAtWindow: consumedA6,
      stages: stagesA6,
    }),
  );
  // 恢复开关，免得污染后面的既有断言（设置页偏好恢复那段）
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
    if (btn) btn.click();
  });
  await openRewindSettings();
  const recallToggleOn = await page.evaluate(() => {
    const panel = document.querySelector("[data-srw-settings]");
    if (!panel) return "no-section";
    const label = [...panel.querySelectorAll("label")].find((el) => /召回|recalls earlier/iu.test(el.textContent || ""));
    const box = label ? label.querySelector('input[type="checkbox"]') : null;
    if (!box) return "no-checkbox";
    if (!box.checked) box.click();
    return box.checked ? "checked" : "still-unchecked";
  });
  await page.waitForTimeout(500);
  const recallPrefsOn = await page.evaluate(() => localStorage.getItem("dsh-session-rewind.prefs.v1"));
  check(
    "召回设置可以恢复为开启",
    recallToggleOn === "checked" && /"recallEnabled":true/u.test(recallPrefsOn || ""),
    JSON.stringify({ toggle: recallToggleOn, prefs: (recallPrefsOn || "").slice(0, 120) }),
  );
  await closeRewindSettings();
  await clearRecallDraft();
  // 关掉设置面板后焦点不一定回到输入框（原来关的是抽屉，焦点会还回去）。
  await focusRecallComposer();
  const leftoverRecallDraft = await composerDetail();
  check(
    "召回测试后草稿清空（不残留影响后续回溯回填）",
    leftoverRecallDraft.text.trim() === "" && leftoverRecallDraft.active === true,
    JSON.stringify({ draft: leftoverRecallDraft.text.slice(0, 40), active: leftoverRecallDraft.active }),
  );
  await shot("02b-composer-recall");
}
if (recallPickRow !== null && !recallSameSession) {
  await openSession(picked.rowKey);
  await page.waitForTimeout(1200);
}

// 多视图一致性：在**另一个真实标签页**里打开同一个会话（它会在挂载时 seed 一次宿主 cuts），
// 然后在主标签页回溯，检查它不用刷新也会把这些行隐藏掉。
let page2 = null;
let tab2Before = -1;
try {
  page2 = await task.newPage();
  await page2.goto(${JSON.stringify(url)});
  await page2.waitForTimeout(4500);
  await dismissNoticesOn(page2);
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
} catch (_error) {
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
// B1：新文案是「将截断 N 条上下文记录（撤回 M 条用户/助手消息）」；同时接受旧口径。
check(
  "确认框展示预览（截断上下文记录 / 撤回用户或助手消息）",
  confirmDialog !== null && /将截断|将撤回|truncates|withdraws/iu.test(confirmDialog.text),
  confirmDialog && confirmDialog.text.slice(0, 160),
);
const modeInfo = await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dialog) return null;
  const radios = [...dialog.querySelectorAll('input[type="radio"]')].map((r) => ({ value: r.value, disabled: r.disabled, checked: r.checked }));
  return { radios, text: (dialog.textContent || "").replace(/s+/g, " ") };
});
check("确认框有仅对话/对话+文件两个范围", modeInfo !== null && modeInfo.radios.length === 2, JSON.stringify(modeInfo && modeInfo.radios));
// B1：新文案是「本轮没有可追踪的文件改动」；同时接受旧口径。
check(
  "没有可追踪的文件改动时文件模式被禁用",
  modeInfo !== null &&
    modeInfo.radios.some((r) => r.value === "both" && r.disabled) &&
    /没有可追踪|No trackable|无文件变更|No file changes/iu.test(modeInfo.text),
  JSON.stringify(modeInfo && modeInfo.radios),
);
const recoveryInfo = await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dialog) return null;
  const recoverable = dialog.querySelector("[data-rewind-recoverable]");
  const primary = dialog.querySelector(".dsh-srw-btn-primary");
  const autofocus = dialog.querySelector("[data-modal-autofocus]");
  return {
    recoverable: recoverable ? (recoverable.textContent || "").trim() : "",
    primaryPresent: !!primary,
    autofocusPresent: !!autofocus,
    autofocusIsPrimary: !!autofocus && autofocus === primary,
    focusInDialog: dialog.contains(document.activeElement),
    focusOnAutofocus: autofocus === document.activeElement,
  };
});
// B1：默认 chat 模式只有「撤回不可撤销、内容留在已撤回页签」这一行；只有 both（且该会话
// 有 tracked 文件）才追加「救援点/回收站」那一行。断言按当前选中的模式分档。
const recoverableHasFileLine = recoveryInfo !== null && /救援点|rescue|回收站|trash/iu.test(recoveryInfo.recoverable);
const bothSelected = modeInfo !== null && modeInfo.radios.some((r) => r.value === "both" && r.checked === true);
check(
  "确认框写明「撤回不可撤销、内容留在已撤回页签」（可恢复性基础行）",
  recoveryInfo !== null && /撤回|withdrawn/iu.test(recoveryInfo.recoverable),
  JSON.stringify(recoveryInfo),
);
check(
  "可恢复性文案按模式分档（chat 不出现文件救援点 / both 必含）",
  bothSelected ? recoverableHasFileLine : !recoverableHasFileLine,
  JSON.stringify({ bothSelected, recoverable: recoveryInfo && recoveryInfo.recoverable }),
);
const trackingScope = await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dialog) return null;
  const el = dialog.querySelector("[data-srw-tracking-scope]");
  return {
    present: !!el,
    text: el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "",
  };
});
check(
  "确认框写明文件追踪范围（write/edit/apply_patch；bash/子代理不追踪，USIM-U2-03/U3-08）",
  trackingScope !== null &&
    trackingScope.present === true &&
    /write/iu.test(trackingScope.text) &&
    /apply_patch|编辑|edit/iu.test(trackingScope.text),
  JSON.stringify(trackingScope).slice(0, 240),
);
check(
  "确认框默认聚焦主按钮（data-modal-autofocus，AUD-REW-07）",
  recoveryInfo !== null && recoveryInfo.autofocusIsPrimary === true && recoveryInfo.focusOnAutofocus === true,
  JSON.stringify(recoveryInfo),
);
const tabTrap = await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"));
  if (!dialog) return null;
  const nodes = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
  const last = nodes[nodes.length - 1];
  if (!last) return null;
  last.focus();
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  return {
    inside: dialog.contains(document.activeElement),
    active: (document.activeElement && document.activeElement.textContent || "").trim(),
  };
});
check("确认框 Tab 不穿透（焦点在框内环绕，AUD-REW-07）", tabTrap?.inside === true, JSON.stringify(tabTrap));
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
// 断言的是「重新求值没有坏、且不会再显示更多行」，不是「行数等于广播前的快照」——
// 收到的广播会让客户端按**宿主** cuts 重算，宿主可能知道比本地更多的折叠区间（例如这个临时
// 会话本身就是从已有回溯的真实会话复制来的），此时多隐藏几行才是正确的。
check(
  "收到其它视图广播后按宿主 cuts 重新求值且不报错",
  afterBroadcast?.ok === true && afterBroadcast.users <= after.length,
  JSON.stringify({ after: after.length, ...afterBroadcast }),
);
// 真两标签页：第二个标签页没刷新，也应靠广播 + 宿主 cuts 自动同步。
// 判据是「两个视图看到的一致」，而不是「等于某个快照」。
let tab2After = -1;
let tab1After = -1;
if (page2 !== null) {
  await page.waitForTimeout(2500);
  tab2After = await page2.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
  tab1After = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
  await page2.screenshot({ path: SHOTS + "/05-second-tab-synced.png" }).catch(() => {});
}
check(
  "另一个标签页无需刷新即同步（真两标签页，两视图一致）",
  page2 !== null && tab2Before > 0 && tab2After === tab1After,
  JSON.stringify({ tab2Before, tab2After, tab1After }),
);
await shot("04-after-button-rewind");
// 关掉第二个标签页：ego 的 TaskSpace 有页面额度（8），不关会随每轮冒烟累积，
// 最终 "Page budget reached" 让后面的断言全部失败（本次排查就是这样踩到的）。
if (page2) {
  await page2.close().catch(() => {});
  page2 = null;
}

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
check("回溯面板包含三个页签（设置已迁出）", drawer !== null && ["已撤回", "回溯记录", "救援点"].every((tab) => drawer.tabs.includes(tab)) && !drawer.tabs.includes("设置"), JSON.stringify(drawer && drawer.tabs));
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
const rescuesTab = await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".dsh-srw-tab")].find((t) => (t.textContent || "").trim() === "救援点");
  if (!tab) return { clicked: false };
  tab.click();
  return { clicked: true };
});
await page.waitForTimeout(900);
const trashSection = await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-drawer");
  const section = root ? root.querySelector("[data-srw-trash]") : null;
  return {
    present: !!section,
    text: section ? (section.textContent || "").replace(/s+/g, " ") : "",
  };
});
check(
  "救援点页签里能看到回收站入口（可恢复/可清空，AUD-REW-08）",
  rescuesTab.clicked === true && trashSection.present === true && /回收站|Trash/iu.test(trashSection.text),
  JSON.stringify(trashSection).slice(0, 200),
);
// 时间线只在「回溯记录」页签渲染；前面切到「救援点」后要切回来再读。
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".dsh-srw-tab")].find(
    (t) => (t.textContent || "").trim() === "回溯记录",
  );
  if (tab) tab.click();
});
await page.waitForTimeout(600);
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
  // USIM-U2-26：裸 /rewind 现在直接打开本插件自己的候选对话框（不再用宿主 popupSelect，
  // 它的 ↑/↓/Enter 在本插件这条路径上实测失效）。
  const commandListDialog = await dialogInfo();
  check(
    "/rewind 命令打开插件候选对话框（只列会话消息）",
    filled.filled &&
      commandListDialog !== null &&
      matches(commandListDialog.title, LABELS.dialogList) &&
      commandListDialog.rows.length > 0,
    JSON.stringify({ filled, dialog: commandListDialog && { title: commandListDialog.title, rows: commandListDialog.rows.length } }),
  );
  if (commandListDialog !== null && commandListDialog.rows.length > 0) {
    // 键盘路径：↑/↓ 移动选中、Enter 打开确认框（与 Esc Esc 完全同一套交互）。
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const commandConfirm = await dialogInfo();
    check(
      "/rewind 候选可用 ↑/↓ 选择 + Enter 进入确认框",
      commandConfirm !== null && matches(commandConfirm.title, LABELS.dialogConfirm),
      commandConfirm && commandConfirm.title,
    );
    await clickDialogButton(LABELS.cancel);
    await page.waitForTimeout(400);
  }
}

// /rewind @<seq> both 必须显式 confirm（AUD-REW-09）：无 confirm 时只回执影响面，绝不写文件。
// 注意：本段代码在浏览器侧模板字符串里，避免反斜杠/模板插值（见脚本头部转义约定）。
if (commandSession !== null) {
  // 先清掉上一步（/rewind 候选键盘测试）可能遗留的弹层：弹层在时输入框拿不到焦点，
  // 命令不会提交，body.innerText 会把弹层误当回执（2026-11-28 残余失败的根因）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    });
    await page.waitForTimeout(250);
    const open = await page.evaluate(() => document.querySelector(".dsh-srw-dialog") !== null);
    if (!open) break;
  }
  const leftoverDialog = await page.evaluate(() => document.querySelector(".dsh-srw-dialog") !== null);
  if (leftoverDialog) {
    await page.evaluate(() => {
      const dlg = document.querySelector(".dsh-srw-dialog");
      const cancel = [...dlg.querySelectorAll("button")].find((b) => /取消|Cancel/u.test((b.textContent || "").trim()));
      if (cancel) cancel.click();
    });
    await page.waitForTimeout(400);
  }
  const bothSessionId = String(commandSession).replace("session:", "");
  let beforeBoth = null;
  try {
    beforeBoth = await readSessionDigest({ home: HOME, sessionId: bothSessionId }, digestDeps);
  } catch (_error) {
    beforeBoth = null;
  }
  const bothTarget =
    beforeBoth && Array.isArray(beforeBoth.visibleHumanSeqs) && beforeBoth.visibleHumanSeqs.length > 0
      ? beforeBoth.visibleHumanSeqs[0]
      : null;
  await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    if (!el) return;
    el.focus();
    const sel = document.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false);
  });
  await page.waitForTimeout(200);
  let receiptText = "";
  if (bothTarget !== null) {
    await page.evaluate(() => {
      const el = document.querySelector("[data-composer-input]");
      if (el && el.focus) el.focus();
    });
    await page.keyboard.insertText("/rewind @" + bothTarget + " both");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    receiptText = await page.evaluate(() => document.body.innerText || "");
  }
  let afterBoth = null;
  try {
    afterBoth = await readSessionDigest({ home: HOME, sessionId: bothSessionId }, digestDeps);
  } catch (_error) {
    afterBoth = null;
  }
  const receiptLike =
    /Nothing has been written yet|nothing was written|还没有写入任何东西|尚未写入|没有写入/iu.test(receiptText) ||
    (/Nothing has been written yet|nothing was written|还没有写入任何东西|尚未写入|没有写入/iu.test(
      (afterBoth && afterBoth.rawText) || "",
    ));
  check(
    "/rewind @<seq> both 无 confirm 时只回执影响面、不写文件（AUD-REW-09）",
    bothTarget !== null &&
      beforeBoth !== null &&
      afterBoth !== null &&
      afterBoth.markerCount === beforeBoth.markerCount &&
      receiptLike,
    JSON.stringify({
      bothTarget: bothTarget,
      before: beforeBoth && beforeBoth.markerCount,
      after: afterBoth && afterBoth.markerCount,
      receipt: receiptText.slice(-240),
    }),
  );
}

// 抽屉页签：设置已迁到独立设置分节，抽屉里应当只剩 3 个会话级页签
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
  if (btn) btn.click();
});
await page.waitForTimeout(900);
const drawerTabs = await page.evaluate(() =>
  [...document.querySelectorAll(".dsh-srw-tab")].map((t) => (t.textContent || "").trim()),
);
check(
  "回溯抽屉只剩 3 个会话级页签（设置已迁出）",
  drawerTabs.length === 3 && drawerTabs.includes("已撤回") && drawerTabs.includes("回溯记录") && drawerTabs.includes("救援点"),
  JSON.stringify(drawerTabs),
);
const drawerHint = await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-drawer");
  if (!root) return null;
  const hint = root.querySelector(".dsh-srw-drawer-hint");
  const buttons = [...root.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
  return {
    present: !!hint,
    text: hint ? (hint.textContent || "").replace(/\\s+/g, " ").trim() : "",
    hasPick: buttons.some((text) => /选择消息回退|Pick a message/iu.test(text)),
  };
});
check(
  "回溯面板提供「选择消息回退」入口（不再必须先关面板，USIM-U2-10）",
  drawerHint !== null && drawerHint.present === true && drawerHint.hasPick === true,
  JSON.stringify(drawerHint).slice(0, 240),
);
const pickOpened = await page.evaluate(() => {
  const root = document.querySelector(".dsh-srw-drawer");
  const btn = root ? [...root.querySelectorAll("button")].find((b) => /选择消息回退|Pick a message/iu.test((b.textContent || "").trim())) : null;
  if (!btn) return false;
  btn.click();
  return true;
});
await page.waitForTimeout(900);
const pickDialog = await dialogInfo();
check(
  "「选择消息回退」会关闭面板并打开候选对话框",
  pickOpened === true && pickDialog !== null && matches(pickDialog.title, LABELS.dialogList),
  pickDialog && pickDialog.title,
);
await clickDialogButton(LABELS.cancel);
await page.waitForTimeout(400);
check("抽屉里不再有「设置」页签", !drawerTabs.includes("设置"), JSON.stringify(drawerTabs));

// 关抽屉，改到 设置 → 会话回溯 里验证偏好与诊断
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dsh-srw-drawer button")].find((b) => (b.textContent || "").trim() === "关闭");
  if (btn) btn.click();
});
await page.waitForTimeout(400);

const openRewindSettings = () =>
  page.evaluate(async () => {
    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const opener = '[data-shortcut-modal="settings"]';
    const isOpen = () => Boolean(document.querySelector(opener));
    if (!isOpen()) {
      const account = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "账号菜单");
      if (account) {
        account.click();
        await sleepMs(700);
        const item = [...document.querySelectorAll('[role="menu"] button, [role="menuitem"]')].find((el) => (el.textContent || "").trim().startsWith("设置"));
        if (item) {
          item.click();
          await sleepMs(900);
        }
      }
    }
    if (!isOpen()) return "no-settings-panel";
    const shell = document.querySelector(opener);
    const nav = [...shell.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "会话回溯");
    if (!nav) return "no-section-nav";
    nav.click();
    await sleepMs(1500);
    return "ok";
  });

const settingsOpened = await openRewindSettings();
check("设置里出现「会话回溯」分节", settingsOpened === "ok", String(settingsOpened));

const moreSettings = await page.evaluate(() => {
  const details = document.querySelector("[data-srw-settings] details[data-srw-more-settings]");
  if (!details) return null;
  return {
    open: details.open === true,
    summary: (details.querySelector("summary")?.textContent || "").trim(),
  };
});
check(
  "低频设置与诊断收进「更多设置」且默认收起（AUD-REW-17）",
  moreSettings !== null && moreSettings.open === false && /更多设置|More settings/iu.test(moreSettings.summary),
  JSON.stringify(moreSettings),
);
// 展开后再改偏好 / 读诊断（后续断言依赖这些输入）。
await page.evaluate(() => {
  const details = document.querySelector("[data-srw-settings] details[data-srw-more-settings]");
  if (details) details.open = true;
});

const sectionHealth = await page.evaluate(async () => {
  const panel = document.querySelector('[data-srw-settings]');
  if (!panel) return { ok: false, reason: "no-section" };
  const refresh = [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "刷新");
  if (refresh) refresh.click();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { ok: true, text: (panel.textContent || "").replace(/s+/g, " ") };
});
check(
  "设置分节的诊断报告只读工具已注册",
  sectionHealth.ok === true && /只读工具/u.test(sectionHealth.text || "") && /已启用|已关闭|enabled|disabled/u.test(sectionHealth.text || ""),
  String(sectionHealth.text || "").slice(0, 400),
);
const auditCountMatch = String(sectionHealth.text || "").match(/可读\\s*(\\d+)\\s*条记录|(\\d+)\\s*record\\(s\\) readable/u);
const auditCount = auditCountMatch ? Number(auditCountMatch[1] || auditCountMatch[2]) : null;
check(
  "诊断的审计条数按真实行数统计（不是恒为 1，USIM-U3-06）",
  auditCount !== null && auditCount >= 2,
  JSON.stringify({ auditCount, text: String(sectionHealth.text || "").slice(0, 240) }),
);

const changed = await page.evaluate(() => {
  const panel = document.querySelector('[data-srw-settings]');
  if (!panel) return "no-section";
  const radios = [...panel.querySelectorAll('input[type="radio"]')];
  const both = radios.find((r) => (r.parentElement && (r.parentElement.textContent || "").includes("回退对话和文件"))) || radios[radios.length - 1];
  if (!both) return "no-radio";
  both.click();
  const number = panel.querySelector('input[type="number"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setValue.call(number, "20");
  number.dispatchEvent(new Event("input", { bubbles: true }));
  // 设置项顺序会随布局调整变化：按文案找「从候选列表选择时先确认」的 checkbox（confirmOnList），
  // 不要盲取第一个（新布局第一个是「↑/↓ 召回历史输入」，会误关另一个开关）。
  const pickCheckbox = () => {
    const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
    return (
      boxes.find((b) =>
        /先确认|confirm/i.test((b.closest("label") || b.parentElement || {}).textContent || ""),
      ) || boxes[0]
    );
  };
  const checkbox = pickCheckbox();
  if (checkbox && checkbox.checked) checkbox.click();
  return "changed";
});
await page.waitForTimeout(500);
const savedPrefs = await page.evaluate(() => localStorage.getItem("dsh-session-rewind.prefs.v1"));
check(
  "设置分节修改默认范围/每页数量/列表确认并持久化",
  changed === "changed" && /"defaultMode":"both"/u.test(savedPrefs || "") && /"pageSize":20/u.test(savedPrefs || "") && /"confirmOnList":false/u.test(savedPrefs || ""),
  savedPrefs || "",
);

await page.evaluate(() => {
  const panel = document.querySelector('[data-srw-settings]');
  if (!panel) return;
  const radios = [...panel.querySelectorAll('input[type="radio"]')];
  const chat = radios.find((r) => (r.parentElement && (r.parentElement.textContent || "").includes("仅回退对话"))) || radios[0];
  if (chat) chat.click();
  const number = panel.querySelector('input[type="number"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setValue.call(number, "100");
  number.dispatchEvent(new Event("input", { bubbles: true }));
  const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
  const checkbox =
    boxes.find((b) =>
      /先确认|confirm/i.test((b.closest("label") || b.parentElement || {}).textContent || ""),
    ) || boxes[0];
  if (checkbox && !checkbox.checked) checkbox.click();
});
await page.waitForTimeout(400);
const restoredPrefs = await page.evaluate(() => localStorage.getItem("dsh-session-rewind.prefs.v1"));
check(
  "设置分节可以恢复默认偏好",
  /"defaultMode":"chat"/u.test(restoredPrefs || "") && /"pageSize":100/u.test(restoredPrefs || ""),
  restoredPrefs || "",
);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dsh-srw-drawer button")].find((b) => (b.textContent || "").trim() === "关闭");
  if (btn) btn.click();
});

await page.close().catch(() => {});
await finishTask();
console.log("SMOKE_STATE " + JSON.stringify({ sessionId: picked.rowKey.replace("session:", ""), userCountBefore: picked.bubbles.length }));
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
} catch (error) {
console.log("SMOKE_RESULT " + JSON.stringify({ checks, fatal: String((error && error.stack) || error).slice(0, 1200) }));
} finally {
await finishTask();
}
})();
`;
}

/**
 * Node 的 zstdDecompressSync 只解第一帧；DSH 的 JSONL 日志是「一帧头 + 每批事件一帧」。
 * 按 zstd 魔数切帧后逐帧解压（真实日志实测 482/482 帧可解）。
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeZstdFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  /** @type {number[]} */
  const starts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const index = buffer.indexOf(magic, cursor);
    if (index < 0) break;
    starts.push(index);
    cursor = index + magic.length;
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
 * 直接读会话日志，得到「输入框召回历史」的期望值。
 *
 * 为什么读日志而不是读 DOM：召回要还原文案（多行、markdown 原样），DOM 里是渲染后的文本；
 * 而且会话日志是唯一能同时给出「未回滚的真人消息」与「user/message 事件计数」的来源。
 * 同一份实现要跑在 Node 与浏览器脚本（ego-browser 的 nodejs 运行时）两处，用 toString()
 * 内联进浏览器脚本，所以只能依赖 deps 里传进来的能力，不能引用模块级变量。
 * @param {{ home?: string, sessionId?: string }} args
 * @param {{ readFile: any, readdir: any, join: any, gunzipSync: any, decodeZstdFrames: any }} deps
 * @returns {Promise<null | { logName: string, eventCount: number, maxSeq: number, humanSeqs: number[], userMessageSeqs: number[], visibleTexts: string[], visibleHumanSeqs: number[], markerCount: number, cutCount: number, rawText: string }>}
 */
async function readSessionDigest(args, deps) {
  const home = args && typeof args.home === "string" ? args.home : "";
  const sessionId = args && typeof args.sessionId === "string" ? args.sessionId : "";
  if (home === "" || sessionId === "") return null;
  const readFile = deps.readFile;
  const readdir = deps.readdir;
  const join = deps.join;
  const gunzipSync = deps.gunzipSync;
  const decodeZstdFrames = deps.decodeZstdFrames;
  let roots = [];
  try {
    roots = await readdir(join(home, "sessions"), { withFileTypes: true });
  } catch (_error) {
    return null;
  }
  let logPath = null;
  for (let i = 0; i < roots.length && logPath === null; i += 1) {
    const entry = roots[i];
    if (!entry || typeof entry.isDirectory !== "function" || !entry.isDirectory()) continue;
    const dir = join(home, "sessions", entry.name, sessionId);
    let files = [];
    try {
      files = await readdir(dir);
    } catch (_error) {
      files = [];
    }
    for (let j = 0; j < files.length; j += 1) {
      if (/^session\.v\d+\.jsonl(\.(zst|zstd|gz))?$/u.test(files[j])) {
        logPath = join(dir, files[j]);
        break;
      }
    }
  }
  if (logPath === null) return null;
  let buffer;
  try {
    buffer = await readFile(logPath);
  } catch (_error) {
    return null;
  }
  let text = "";
  try {
    if (/\.(zst|zstd)$/u.test(logPath)) text = decodeZstdFrames(buffer);
    else if (/\.gz$/u.test(logPath)) text = gunzipSync(buffer).toString("utf8");
    else text = buffer.toString("utf8");
  } catch (_error) {
    return null;
  }
  /** @type {any[]} */
  const events = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    try {
      events.push(JSON.parse(lines[i]));
    } catch (_error) {
      /* 尾部不完整行忽略 */
    }
  }
  const textOf = (/** @type {any} */ event) => {
    const content = Array.isArray(event?.data?.content) ? event.data.content : [];
    let out = "";
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (block && block.type === "text" && typeof block.text === "string") out += block.text;
    }
    return out;
  };
  const userMessages = events.filter((event) => event?.type === "user/message");
  const human = userMessages.filter(
    (event) => event?.data?.source?.kind === "user" && typeof event.seq === "number",
  );
  const markers = userMessages.filter(
    (event) =>
      event?.data?.source?.kind === "session-rewind" &&
      typeof event.data.source.targetSeq === "number" &&
      typeof event.seq === "number",
  );
  /* cuts 与客户端一致：[targetSeq, markerSeq] 闭区间内的真人消息算被回滚掉。 */
  const cuts = markers.map((event) => ({
    targetSeq: event.data.source.targetSeq,
    markerSeq: event.seq,
  }));
  const visible = human.filter((event) => {
    for (let i = 0; i < cuts.length; i += 1) {
      if (cuts[i].targetSeq <= event.seq && event.seq <= cuts[i].markerSeq) return false;
    }
    return true;
  });
  let maxSeq = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i] && typeof events[i].seq === "number" && events[i].seq > maxSeq)
      maxSeq = events[i].seq;
  }
  return {
    logName: logPath.split("/").pop() || logPath,
    eventCount: events.length,
    maxSeq: maxSeq,
    // 命令输出只在会话日志里（宿主命令卡片/面板不保证可见），断言用它在防"啥都没发生"。
    rawText: text,
    humanSeqs: human.map((event) => event.seq),
    userMessageSeqs: userMessages
      .filter((event) => typeof event.seq === "number")
      .map((event) => event.seq),
    visibleTexts: visible.map(textOf).filter((value) => value.trim() !== ""),
    visibleHumanSeqs: visible.map((event) => event.seq),
    markerCount: markers.length,
    cutCount: cuts.length,
  };
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
  // 早退也必须打印计数行：gate <plugin> 与 gate:all 都按它判「跑过但零断言」的假绿
  // （docs/plugin-conventions.md §6.1 / AUD-XCT-05）。缺环境时这里是 0 PASS / 1 SKIP。
  if (!(await hasCommand("dsh"))) {
    console.log("SKIP 未找到 dsh");
    console.log("0 PASS / 1 SKIP / 0 FAIL");
    return;
  }
  if (!(await hasCommand("ego-browser"))) {
    console.log("SKIP 未找到 ego-browser（GUI 冒烟需要本机浏览器环境）");
    console.log("0 PASS / 1 SKIP / 0 FAIL");
    return;
  }

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-rewind-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  // host 输出累积：失败时要把它落盘当现场（poll 在启动后会被清掉，末尾再写一次）。
  /** @type {string[]} */
  const chunks = [];
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
    const browserSource = browserScript(url, shotsDir, home);
    await writeFile(browserFile, browserSource);
    await writeFile(join(shotsDir, "browser.mjs"), browserSource);

    // 外部超时标记：ego-browser 被 kill 时浏览器脚本没机会跑 finally，需要 Node 侧兜底回收。
    let timedOut = false;
    const result = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 240_000);
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
    if (timedOut) await reclaimTimedOutTaskSpace("dsh smoke: session-rewind");

    if (process.env.SMOKE_DEBUG) console.log(String(result).slice(-8000));
    const match = String(result).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果（页面/浏览器层没就绪）");
      console.error(String(result).slice(-4000));
      reportBrowserFailureHint();
      return;
    }
    /** @type {{ checks: { name: string, ok: boolean, detail: string }[], fatal?: string }} */
    const parsed = JSON.parse(match[1]);
    // fatal 不能只设 exitCode 就继续算 PASS：把它记成一条失败断言，计数行才诚实。
    if (parsed.fatal) {
      reportBrowserFailureHint();
      parsed.checks.push({
        name: "浏览器脚本异常（未预期）",
        ok: false,
        detail: String(parsed.fatal).slice(0, 1200),
      });
    }
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
    const skipped = parsed.checks.filter((item) => /** @type {any} */ (item).skip === true).length;
    // 门禁靠这一行判定「跑过但零断言」的假绿（见 docs/plugin-conventions.md §6.1）。
    console.log(
      `${parsed.checks.length - failed - skipped} PASS / ${skipped} SKIP / ${failed} FAIL`,
    );
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
    const failedRun = isFailedRun();
    if (failedRun) {
      // 启动后 poll 被清掉了，这里补最后一次落盘，host.log 尾部才有后续日志。
      await writeFile(join(work, "host.log"), chunks.join("")).catch(() => {});
      // §6.4：失败必须留现场——先打宿主日志尾部，再保留临时 home（host.log/profile 在里面）。
      await reportFailureScene(join(work, "host.log"));
    }
    if (process.env.SMOKE_KEEP === "1" || failedRun) {
      console.log(
        `临时 home 已保留${failedRun ? "（因为这次失败，方便排查；删掉即可）" : "（SMOKE_KEEP=1）"}：${work}`,
      );
      console.log("      host.log、profile、sessions、shots 都在这个目录里");
    } else {
      await rm(work, { recursive: true, force: true });
    }
  }
};

await main();
