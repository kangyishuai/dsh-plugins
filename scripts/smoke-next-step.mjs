#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:next-step
//       SMOKE_DEBUG=1 pnpm smoke:next-step      —— 打印浏览器脚本的完整输出
//       SMOKE_KEEP=1 pnpm smoke:next-step       —— 保留临时 DSH_HOME（排障用）
//       SMOKE_NO_MODEL=1 pnpm smoke:next-step   —— 强制按「没有模型凭据」跑（只验宿主/页面/插件加载）
//
// 端到端冒烟：临时 DSH_HOME 里启动**真实宿主**，装当前源码打出的包，再用 ego-browser
// 在真实页面里点一遍 next-step 的六条主链路：
//   1. 回答完成后，回合尾部出现决策卡；
//   2. 卡片有两粒胶囊（stance 互斥、label 非空）；
//   3. 点击胶囊发出**一条真实用户消息**（DOM + 会话日志双重断言）；
//   4. 点击后胶囊消失、卡片仍在并进入只读态；
//   5. 刷新页面后状态仍在（来自会话投影，不是客户端内存）；
//   6. 把开关写成 `{"enabled":false}` 后，新一轮不再产生新卡。
//
// 前置：本机有 `dsh` 与 `ego-browser`；缺任意一个打印 SKIP（退出码 0）。
// 模型：卡片由宿主一次真实模型调用生成。没有模型凭据时（既没有 DEEPSEEK_API_KEY /
// ZHINAO_API_KEY，临时 home 里也没有 .credentials.yaml）只跑「宿主启动 + 插件激活 +
// 页面可用」三项，其余六项打印 SKIP 并说明原因（退出码 0，不伪装成通过）。
//
// 隔离：会话、工作区、设置全部落在 `mkdtemp` 出来的临时目录里；临时工作区也是空目录，
// 模型即便写了文件也落不到真实工作区。跑完删掉整个临时目录（SMOKE_KEEP=1 除外）。
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-next-step-shots");
const PKG_DIR = join(REPO, "packages", "next-step");
const PACKAGE = "@kangyishuai/dsh-next-step";
const PROFILE = "nxt";
/** 临时工作区标题：侧栏里只出现这一个工作区，脚本不会碰到真实项目。 */
const WORKSPACE_TITLE = "next-step-smoke";
/** 临时工作区 id（固定值，方便断言与排障）。 */
const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";

/** @param {string} message */
function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnOptions} [opts] */
async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
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
 * ego-browser 里跑的脚本：返回 { checks } / SMOKE_STATE，并把截图存到 shots。
 * 注意：内层脚本不能出现 `${...}`（会与外层模板字符串插值冲突），一律用字符串拼接。
 * @param {string} url
 * @param {string} shots
 * @param {string} home 临时 DSH_HOME（写设置文件用）
 * @param {boolean} canModel 是否有模型凭据
 */
function browserScript(url, shots, home, canModel) {
  return `(async () => {
const task = await taskSpace("dsh smoke: next-step");
const page = task.page("p1");
const SHOTS = ${JSON.stringify(shots)};
const HOME = ${JSON.stringify(home)};
const CAN_MODEL = ${canModel ? "true" : "false"};
const WORKSPACE_TITLE = ${JSON.stringify(WORKSPACE_TITLE)};
const { writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
// 幽灵面默认关：冒烟一开始就在设置文件里打开它，顺带验证 B 面；后面的「关闭开关」段会覆盖成 enabled:false。
try {
  await writeFile(
    join(HOME, "next-step.settings.json"),
    JSON.stringify({ enabled: true, ghost: true }, null, 2) + "\\n",
    "utf8",
  );
} catch (_error) {
  /* 写不进去就让后面的幽灵断言红，不要静默通过 */
}
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
// SKIP 不是通过：单独标记，最后打印时用 SKIP 前缀和原因，不计入失败。
const skip = (name, reason) => checks.push({ name, ok: true, skip: true, detail: reason });
const shot = (name) => page.screenshot({ path: SHOTS + "/" + name + ".png" });

// —— 页面辅助（全部只读 DOM / 真实按键） ——
const dismissOnboarding = async () => {
  for (const label of ["继续", "开始使用", "跳过", "关闭"]) {
    await page.evaluate((text) => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
      if (btn) btn.click();
    }, label).catch(() => {});
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 2; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(120); }
};
const expandWorkspaces = () => page.evaluate(() => {
  for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
});
const composerDetail = () => page.evaluate(() => {
  const el = document.querySelector("[data-composer-input]");
  if (!el) return { present: false, editable: false, text: "" };
  const rect = el.getBoundingClientRect();
  return {
    present: true,
    editable: el.getAttribute("contenteditable") === "true" && rect.width > 0 && rect.height > 0,
    text: (el.textContent || ""),
  };
});
// 空草稿在 Lexical 里渲染成空段落：innerText 是换行，textContent 是空串。
const composerText = async () => (await composerDetail()).text;
const waitComposer = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await composerDetail()).editable) return true;
    await page.waitForTimeout(400);
  }
  return false;
};
const typeText = async (text) => {
  await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    if (el && typeof el.focus === "function") el.focus();
  });
  await page.waitForTimeout(150);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(300);
};
const sendMessage = async (text) => {
  await typeText(text);
  const typed = (await composerText()).trim();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  return typed;
};
// 输入框里还有「停止」按钮 = 回合仍在跑（与桌面回归同一套判据）。
const isRunning = () => page.evaluate(() => [...document.querySelectorAll("button")].some((b) => {
  const aria = (b.getAttribute("aria-label") || "").trim();
  const ttl = (b.getAttribute("title") || "").trim();
  return /停止|Stop/i.test(aria + " " + ttl);
}));
const waitTurnEnd = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunning())) {
      await page.waitForTimeout(1200);
      if (!(await isRunning())) return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
};
const countRows = (kind) => page.evaluate((k) => document.querySelectorAll('[data-chat-flow-kind="' + k + '"]').length, kind);
const sessionIdOf = () => page.evaluate(() => {
  const root = document.querySelector("[data-conversation-session]");
  return root ? root.getAttribute("data-conversation-session") : null;
});
// 卡片结构：data-* 契约见 packages/next-step/lib/client.js 文件头（与 Lead 定稿一致）。
const cardsNow = () => page.evaluate(() => [...document.querySelectorAll("[data-next-step-card]")].map((el) => {
  const text = (selector) => {
    const node = el.querySelector(selector);
    return node ? (node.textContent || "").trim() : "";
  };
  return {
    turn: Number(el.getAttribute("data-next-step-turn")),
    state: el.getAttribute("data-next-step-state") || "",
    summary: text("[data-next-step-summary]"),
    question: text("[data-next-step-question]"),
    hasDismiss: !!el.querySelector("button[data-next-step-dismiss]"),
    hasMore: !!el.querySelector("button[data-next-step-more]"),
    pills: [...el.querySelectorAll("button[data-next-step-pill]")].map((b) => ({
      label: (b.textContent || "").trim(),
      stance: b.getAttribute("data-stance") || "",
      index: Number(b.getAttribute("data-index")),
      disabled: b.disabled === true,
      title: b.getAttribute("title") || "",
      // 点下去真正发出去的指令（= option.text），DOM 侧直接断言用；没实现时是空串。
      text: b.getAttribute("data-text") || "",
    })),
    text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
  };
}));
const waitForCards = async (timeoutMs, minimum) => {
  const deadline = Date.now() + timeoutMs;
  let cards = await cardsNow();
  while (cards.length < minimum && Date.now() < deadline) {
    await page.waitForTimeout(700);
    cards = await cardsNow();
  }
  return cards;
};
// 卡片集合稳定（连续 quietMs 内数量与轮次不变）——用来等「点击触发的又一轮」的卡出炉，
// 免得把「新卡还没出现」误判成「关闭开关后不再出卡」。
const waitStableCards = async (timeoutMs, quietMs) => {
  const deadline = Date.now() + timeoutMs;
  let cards = await cardsNow();
  let signature = cards.map((c) => c.turn + ":" + c.state).join(",");
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(600);
    cards = await cardsNow();
    const next = cards.map((c) => c.turn + ":" + c.state).join(",");
    if (next !== signature) {
      signature = next;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) return cards;
  }
  return cards;
};
const describeCards = (cards) => JSON.stringify((cards || []).map((c) => ({ turn: c.turn, state: c.state, pills: c.pills.length })));

await page.goto(${JSON.stringify(url)});
await page.waitForTimeout(5000);
await dismissOnboarding();
await expandWorkspaces();
await page.waitForTimeout(700);
await shot("01-home");

// ---------- A. 宿主与页面（不需要模型凭据） ----------
const pageTitle = await page.evaluate(() => document.title);
check("页面能加载 DSH 会话界面", typeof pageTitle === "string" && pageTitle.length > 0, "document.title=" + JSON.stringify(pageTitle));
const composerBefore = await composerDetail();
check("输入框存在", composerBefore.present === true, JSON.stringify(composerBefore));

// ---------- 0. 在临时工作区新建会话（不碰真实工作区） ----------
const created = await page.evaluate((title) => {
  const buttons = [...document.querySelectorAll("button")];
  const arias = buttons.map((b) => (b.getAttribute("aria-label") || "").trim()).filter((aria) => aria !== "");
  const scoped = buttons.find((b) => {
    const aria = (b.getAttribute("aria-label") || "").trim();
    return aria.includes("新建会话") && aria.includes(title);
  });
  const fallback = buttons.find((b) => (b.getAttribute("aria-label") || "").trim() === "新建会话");
  const button = scoped || fallback;
  if (!button) return { ok: false, arias: arias.slice(0, 40) };
  button.click();
  return { ok: true, aria: (button.getAttribute("aria-label") || "").trim(), scoped: !!scoped };
}, WORKSPACE_TITLE);
await page.waitForTimeout(2500);
check(
  "在临时工作区里新建了会话",
  created.ok === true,
  created.ok === true
    ? "按钮=" + JSON.stringify(created.aria) + (created.scoped ? "（工作区已绑定）" : "（用了通用按钮，待下面输入框断言确认已绑定工作区）")
    : "没找到「新建会话」按钮；页面上现有 aria-label=" + JSON.stringify(created.arias),
);
const ready = await waitComposer(15000);
check(
  "新会话输入框可编辑（已绑定临时工作区）",
  ready === true,
  ready === true ? "" : "输入框不存在或 contenteditable!=true —— 宿主可能停在「选择一个工作区」",
);
const sessionId = await sessionIdOf();
check("拿到会话 id（后续读日志用）", typeof sessionId === "string" && sessionId.length > 0, JSON.stringify(sessionId));
const userCountBefore = await countRows("user");
check("新会话是空的（没有既有用户消息）", userCountBefore === 0, "期望=0 实际=" + userCountBefore);

const FIRST_PROMPT = "用一句话解释什么是二分查找。不要使用任何工具，直接回答。";
const THIRD_PROMPT = "用一句话解释什么是哈希表。不要使用任何工具，直接回答。";

if (!CAN_MODEL) {
  const reason = "没有模型凭据：未设置 DEEPSEEK_API_KEY / ZHINAO_API_KEY，临时 DSH_HOME 里也没有 .credentials.yaml —— 卡片由一次真实模型调用生成，没有凭据就无法产出";
  skip("卡片在答后出现", reason);
  skip("卡片有两粒胶囊（stance 互斥）", reason);
  skip("点击胶囊发送出一条用户消息", reason);
  skip("点击后胶囊消失而卡片仍在", reason);
  skip("刷新页面后卡片状态仍在", reason);
  skip("关闭开关后不再出现新卡", reason);
  await shot("02-skip-no-credentials");
  console.log("SKIP 卡片相关 6 项断言：" + reason);
  await task.finish({ keep: false }).catch(() => {});
  console.log("SMOKE_STATE " + JSON.stringify({ sessionId: sessionId, canModel: false }));
  console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
  return;
}

// ---------- 1. 发一条消息，等回答结束 ----------
const firstTyped = await sendMessage(FIRST_PROMPT);
check("提示词已进入输入框", firstTyped.length > 0, "输入框文本=" + JSON.stringify(firstTyped.slice(0, 60)));
// 发出去没有：等「用户行出现」或「回合开始」，二者任一成立即算发出（回合可能很快结束）。
let sentObserved = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  if ((await isRunning()) || (await countRows("user")) > userCountBefore) {
    sentObserved = true;
    break;
  }
  await page.waitForTimeout(250);
}
check(
  "消息已发出（出现用户消息行或回合开始运行）",
  sentObserved === true,
  sentObserved ? "" : "10s 内既没有新用户行，也没有「停止」按钮 —— 回车可能没提交",
);
const firstEnded = await waitTurnEnd(300000);
const userCountAfterFirst = await countRows("user");
// 宿主的 flow kind 是 user / turn-process / assistant-step / tool-call / turn-tail /
// model-retry / turn-trigger —— **没有** "assistant"，回答正文是 assistant-step
// （见 app.asar 里 dsh-client-ui-chat 的 data-chat-flow-kind=routedNode.kind）。
const answerStepsAfterFirst = await page.evaluate(
  () => document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
);
check(
  "首轮回答完成（有 assistant-step 正文行）",
  firstEnded === true && answerStepsAfterFirst >= 1,
  "turnEnded=" + firstEnded + " assistantStepRows=" + answerStepsAfterFirst + " userRows=" + userCountAfterFirst,
);
// 投影坏掉是「静默全灭」：消息能发、日志正常，只是整条历史加载失败、卡片永不渲染。
// 所以单独留一条健康检查，失败时的报错文案也一并打出来。
const projectionHealth = await page.evaluate(() => ({
  chatRows: document.querySelectorAll("[data-chat-flow-kind]").length,
  userRows: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
  assistantStepRows: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
  turnTailRows: document.querySelectorAll('[data-chat-flow-kind="turn-tail"]').length,
  errorText: (() => {
    for (const el of document.querySelectorAll('[role="alert"], [class*="error"], [class*="Error"]')) {
      const text = (el.textContent || "").trim();
      if (text !== "") return text.slice(0, 200);
    }
    return "";
  })(),
  bodyTail: (document.body.innerText || "").replace(/\\s+/g, " ").slice(-300),
}));
check(
  "投影健康：会话历史渲染出消息行（[data-chat-flow-kind] > 0）",
  projectionHealth.chatRows > 0 && projectionHealth.userRows >= 1,
  JSON.stringify(projectionHealth),
);
await shot("02-first-answer");

// ---------- 2. 卡片在答后出现 ----------
const cards = await waitForCards(90000, 1);
check(
  "卡片在答后出现（conversation.chat.turnTail）",
  cards.length >= 1,
  cards.length >= 1 ? describeCards(cards) : "等 90s 后没有任何 section[data-next-step-card]（宿主生成失败/被门挡/客户端没渲染）",
);
const card = cards.length === 0 ? null : cards[cards.length - 1];
if (card === null) {
  await shot("03-no-card");
  await task.finish({ keep: false }).catch(() => {});
  console.log("SMOKE_STATE " + JSON.stringify({ sessionId: sessionId, canModel: true, cards: 0 }));
  console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
  return;
}

check("卡片处于可交互态", card.state === "interactive", "期望=interactive 实际=" + JSON.stringify(card.state));
check(
  "卡片有两粒胶囊",
  card.pills.length === 2,
  "期望=2 实际=" + card.pills.length + " pills=" + JSON.stringify(card.pills.map((p) => p.label)),
);
check(
  "两粒胶囊 stance 互斥且文案非空",
  card.pills.length === 2 && card.pills[0].stance !== "" && card.pills[1].stance !== "" && card.pills[0].stance !== card.pills[1].stance && card.pills.every((p) => p.label.length > 0),
  JSON.stringify(card.pills.map((p) => ({ stance: p.stance, label: p.label }))),
);
check(
  "卡片带摘要与提问两段文本",
  card.summary.length > 0 && card.question.length > 0,
  JSON.stringify({ summary: card.summary.slice(0, 80), question: card.question.slice(0, 80) }),
);
check("卡片有 ✕ 关闭入口", card.hasDismiss === true, "期望有 button[data-next-step-dismiss]，实际=" + card.hasDismiss);
await shot("03-card");

// ---------- 2.5 幽灵提示（B 面；ghost 已在设置文件里打开） ----------
const ghostText = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-next-step-ghost]");
    if (!el) return "";
    return (el.getAttribute("data-next-step-ghost-text") || el.textContent || "").trim();
  });
const focusComposer = async () => {
  await page.evaluate(() => {
    const el = document.querySelector("[data-composer-input]");
    if (el && typeof el.focus === "function") el.focus();
  });
  await page.waitForTimeout(250);
};
const clearComposer = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await focusComposer();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(250);
    if ((await composerText()) === "") return true;
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(250);
    if ((await composerText()) === "") return true;
  }
  return false;
};

let ghostValue = "";
for (let attempt = 0; attempt < 40; attempt += 1) {
  await focusComposer();
  ghostValue = await ghostText();
  if (ghostValue !== "") break;
  await page.waitForTimeout(250);
}
const ghostDebug = await page.evaluate(() => {
  const off = document.querySelector("[data-next-step-ghost-off]");
  const anchor = document.querySelector(".overlayAnchor");
  const input = document.querySelector("[data-composer-input]");
  return {
    off: off ? off.getAttribute("data-next-step-ghost-off") : null,
    overlayChildren: anchor ? anchor.children.length : -1,
    draft: (input && input.textContent) || "",
  };
});
check(
  "幽灵提示出现（ghost 打开 + 输入框空 + 会话空闲）",
  ghostValue !== "",
  JSON.stringify({ ghost: ghostValue.slice(0, 80), debug: ghostDebug }),
);
await shot("03b-ghost");

const ghostBeforeTab = await ghostText();
await focusComposer();
await page.keyboard.press("Tab");
await page.waitForTimeout(700);
const draftAfterTab = (await composerText()).trim();
check(
  "Tab 接受幽灵提示进草稿（可编辑、不发送）",
  ghostBeforeTab !== "" && draftAfterTab === ghostBeforeTab,
  JSON.stringify({ draft: draftAfterTab.slice(0, 80), ghost: ghostBeforeTab.slice(0, 80) }),
);
const ghostAfterAccept = await ghostText();
check("接受后幽灵提示消失", ghostAfterAccept === "", "ghost=" + ghostAfterAccept.slice(0, 60));
const clearedOk = await clearComposer();
check(
  "清空草稿后可以继续点胶囊",
  clearedOk === true && (await composerText()) === "",
  "draft=" + (await composerText()).slice(0, 40),
);

// ---------- 3. 点胶囊 = 发送一条用户消息 ----------
const clicked = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("[data-next-step-card]")];
  const target = cards[cards.length - 1];
  if (!target) return { clicked: false, reason: "no-card" };
  const pill = target.querySelector("button[data-next-step-pill]");
  if (!pill) return { clicked: false, reason: "no-pill" };
  if (pill.disabled) return { clicked: false, reason: "disabled" };
  const info = {
    label: (pill.textContent || "").trim(),
    index: Number(pill.getAttribute("data-index")),
    stance: pill.getAttribute("data-stance") || "",
    title: pill.getAttribute("title") || "",
    text: pill.getAttribute("data-text") || "",
  };
  pill.click();
  return { clicked: true, captured: info };
});
const userCountAfterClick = userCountAfterFirst + 1;
let afterClick = await cardsNow();
let clickedCard = afterClick.find((c) => c.turn === card.turn) || null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const done = clickedCard !== null && clickedCard.pills.length === 0 && clickedCard.state !== "interactive" && clickedCard.state !== "sending";
  if (done) break;
  await page.waitForTimeout(400);
  afterClick = await cardsNow();
  clickedCard = afterClick.find((c) => c.turn === card.turn) || null;
}
// 轮询同时收集「用户行数量」与「最后一条用户行文本」：点击后新行是异步渲染的，
// 抢跑读一次会拿到点击前的数字（实测踩过：期望 2 实际 1）。
let actualUserCount = userCountAfterFirst;
let lastUserRowText = "";
for (let attempt = 0; attempt < 50; attempt += 1) {
  actualUserCount = await countRows("user");
  lastUserRowText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')];
    const last = rows[rows.length - 1];
    return last ? (last.textContent || "").replace(/\\s+/g, " ").trim() : "";
  });
  const countOk = actualUserCount >= userCountAfterClick;
  const textOk =
    clicked.clicked !== true || clicked.captured.text === ""
      ? lastUserRowText.length > 0
      : lastUserRowText.includes(clicked.captured.text.slice(0, 24));
  if (countOk && textOk) break;
  await page.waitForTimeout(300);
}
check(
  "点击胶囊发送出一条用户消息",
  clicked.clicked === true && actualUserCount >= userCountAfterClick,
  "clicked=" + JSON.stringify(clicked) + " 期望 userRows>=" + userCountAfterClick + " 实际=" + actualUserCount,
);
if (clicked.clicked === true && clicked.captured.text === "") {
  skip("发出去的用户消息文本 === option.text（DOM 侧）", "胶囊上没有 data-text（client 未实现该属性），改由会话日志断言覆盖");
} else {
  check(
    "发出去的用户消息文本 === option.text（DOM 侧，不是 label）",
    clicked.clicked === true &&
      clicked.captured.text !== "" &&
      lastUserRowText.includes(clicked.captured.text.slice(0, 24)) &&
      clicked.captured.text !== clicked.captured.label,
    JSON.stringify({
      optionText: clicked.clicked === true ? clicked.captured.text.slice(0, 80) : "",
      label: clicked.clicked === true ? clicked.captured.label : "",
      lastUserRowText: lastUserRowText.slice(0, 80),
    }),
  );
}
check(
  "点击后胶囊消失",
  clickedCard !== null && clickedCard.pills.length === 0,
  JSON.stringify(clickedCard === null ? "卡片消失了（不应消失）" : clickedCard.pills.map((p) => p.label)),
);
check(
  "点击后卡片仍在且进入只读态",
  clickedCard !== null && (clickedCard.state === "sent" || clickedCard.state === "readonly"),
  JSON.stringify(clickedCard === null ? "找不到该轮卡片" : { turn: clickedCard.turn, state: clickedCard.state }),
);
check(
  "只读态仍保留摘要与提问",
  clickedCard !== null && clickedCard.summary.length > 0 && clickedCard.question.length > 0,
  JSON.stringify(clickedCard === null ? null : { summary: clickedCard.summary.slice(0, 60), question: clickedCard.question.slice(0, 60) }),
);
await shot("04-after-click");

// 点击发出的那条消息会再跑一轮（并可能再生成一张新卡）；等它跑完且卡片集合稳定，
// 否则下面「关闭开关后不再出卡」会把这张迟到的卡算进去。
const secondEnded = await waitTurnEnd(300000);
check("点击触发的回合跑完", secondEnded === true, secondEnded ? "" : "300s 内没等到回合结束");
const stableCards = await waitStableCards(90000, 6000);
const interactiveCards = stableCards.filter((c) => c.state === "interactive");
check(
  "任何时刻最多一张可交互卡（更早的轮次都是只读态）",
  interactiveCards.length <= 1 && (stableCards.find((c) => c.turn === card.turn)?.state ?? "") !== "interactive",
  JSON.stringify({
    all: stableCards.map((c) => ({ turn: c.turn, state: c.state })),
    interactiveTurns: interactiveCards.map((c) => c.turn),
    clickedTurnState: stableCards.find((c) => c.turn === card.turn)?.state,
  }),
);
await shot("05-second-turn");

// ---------- 4. 刷新页面后状态仍在（投影，不是内存） ----------
await page.reload();
await page.waitForTimeout(5500);
await dismissOnboarding();
await expandWorkspaces();
await page.waitForTimeout(800);
const reopened = await page.evaluate((id) => {
  const row = document.querySelector('[data-row-key="session:' + id + '"]');
  if (!row) return false;
  row.scrollIntoView({ block: "center" });
  row.click();
  return true;
}, sessionId);
await page.waitForTimeout(2500);
const cardsAfterReload = await waitForCards(30000, 1);
const reloadedCard = cardsAfterReload.find((c) => c.turn === card.turn) || null;
check(
  "刷新页面后重新打开会话",
  reopened === true,
  reopened ? "" : "侧栏里找不到 session:" + sessionId + "（会话没落盘？）",
);
check(
  "刷新后已决策的卡片还在（来自会话投影）",
  reloadedCard !== null,
  reloadedCard === null ? "该轮卡片丢失；刷新后卡片=" + describeCards(cardsAfterReload) : describeCards([reloadedCard]),
);
check(
  "刷新后已决策卡片仍是只读态且无胶囊",
  reloadedCard !== null && reloadedCard.pills.length === 0 && reloadedCard.state !== "interactive",
  JSON.stringify(reloadedCard === null ? null : { state: reloadedCard.state, pills: reloadedCard.pills.length }),
);
await shot("06-after-reload");

// ---------- 5. 关闭开关后不再出现新卡 ----------
const cardsBeforeDisable = await waitStableCards(60000, 6000);
const turnsBeforeDisable = cardsBeforeDisable.map((c) => c.turn);
let settingsWritten = false;
try {
  // host 每次生成前重读设置文件（1s 缓存）：改文件即可让「关闭」生效，不需要重启宿主。
  await writeFile(join(HOME, "next-step.settings.json"), JSON.stringify({ enabled: false }, null, 2) + "\\n", "utf8");
  settingsWritten = true;
} catch (_error) {
  settingsWritten = false;
}
check(
  "关闭开关：写入 next-step.settings.json {enabled:false}",
  settingsWritten === true,
  settingsWritten ? "" : "写 " + join(HOME, "next-step.settings.json") + " 失败",
);
await page.waitForTimeout(2000);
const thirdTyped = await sendMessage(THIRD_PROMPT);
check("关闭开关后仍能发消息", thirdTyped.length > 0, "输入框文本=" + JSON.stringify(thirdTyped.slice(0, 60)));
const thirdEnded = await waitTurnEnd(300000);
// 卡片生成发生在回合结束后（超时 20s）；多等一会儿再判「没有新卡」。
const cardsAfterDisable = await waitStableCards(60000, 15000);
const newTurns = cardsAfterDisable.map((c) => c.turn).filter((turn) => turnsBeforeDisable.indexOf(turn) < 0);
check(
  "关闭开关后不再出现新卡",
  thirdEnded === true && newTurns.length === 0,
  "turnEnded=" + thirdEnded + " 关闭前轮次=" + JSON.stringify(turnsBeforeDisable) + " 关闭后新增轮次=" + JSON.stringify(newTurns) + " 全部卡片=" + describeCards(cardsAfterDisable),
);
await shot("07-disabled");

await task.finish({ keep: false }).catch(() => {});
console.log("SMOKE_STATE " + JSON.stringify({
  sessionId: sessionId,
  canModel: true,
  cardTurn: card.turn,
  clickedIndex: clicked.clicked === true ? clicked.captured.index : null,
  clickedLabel: clicked.clicked === true ? clicked.captured.label : null,
  clickedText: clicked.clicked === true ? clicked.captured.text : "",
  clickedTitle: clicked.clicked === true ? clicked.captured.title : "",
  cardsBeforeDisable: cardsBeforeDisable.length,
  cardsAfterDisable: cardsAfterDisable.length,
  userRows: actualUserCount,
}));
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
})();
`;
}

/**
 * Node 的 zstdDecompressSync 只解第一帧；DSH 的 JSONL 日志是「一帧头 + 每批事件一帧」。
 * 按 zstd 魔数切帧后逐帧解压（与 smoke-session-rewind 同一实现）。
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
 * 读临时 DSH_HOME 里某个会话的 JSONL 事件。
 *
 * 会话目录名不保证等于 `data-conversation-session` 给的 id：真实 home 里同一 workspace 下
 * 既有 `<uuid>` 也有 `session-<uuid>` 形式，前端可能还套了一层包装。所以：① 三种匹配都接受
 * （全等 / 去 `session-` 前缀后全等 / endsWith）；② **发现阶段也重试**（宿主刚退出时目录可能
 * 还没落盘）；③ 都匹配不到就兜底取最新的会话目录（临时 home 里只有本次会话），并让调用方
 * 在断言里标出 fallback，避免「悄悄读到别的会话」还当成通过。
 * @param {string} home
 * @param {string} sessionId
 * @returns {Promise<{ missing: boolean, logName: string, logPath?: string, dirName: string, candidates: string[], fallback: boolean, events: any[] }>}
 */
async function readSessionEvents(home, sessionId) {
  const sessionsRoot = join(home, "sessions");
  const normalize = (/** @type {string} */ name) => String(name).replace(/^session-/u, "");
  const wanted = normalize(sessionId);
  /** @type {{ logPath: string | null, dirName: string, candidates: string[], fallback: boolean }} */
  let located = { logPath: null, dirName: "", candidates: [], fallback: false };

  // 发现阶段也要重试：宿主刚退出时 session 目录/日志可能还没落盘。
  for (let attempt = 0; attempt < 20 && located.logPath === null; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
    /** @type {{ name: string, dir: string, mtime: number }[]} */
    const sessionDirs = [];
    for (const entry of workspaceDirs) {
      if (!entry.isDirectory()) continue;
      const workspaceDir = join(sessionsRoot, entry.name);
      const inner = await readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
      for (const item of inner) {
        if (!item.isDirectory()) continue;
        const dir = join(workspaceDir, item.name);
        const info = await stat(dir).catch(() => null);
        sessionDirs.push({ name: item.name, dir, mtime: info?.mtimeMs ?? 0 });
      }
    }
    located.candidates = sessionDirs.map((item) => item.name).slice(0, 20);
    if (sessionDirs.length === 0) {
      located.dirName = "";
      continue;
    }
    // 目录名可能是 `<uuid>` 或 `session-<uuid>`，也可能带前端包装；三种匹配都接受。
    const preferred =
      sessionDirs.find((item) => item.name === sessionId) ??
      sessionDirs.find((item) => normalize(item.name) === wanted) ??
      sessionDirs.find((item) => item.name.endsWith(sessionId) || sessionId.endsWith(item.name)) ??
      sessionDirs.find((item) => wanted !== "" && item.name.includes(wanted));
    // 兜底：临时 home 里只有本次会话，取最新的那个（并把 fallback=true 写进 detail）。
    const chosen = preferred ?? [...sessionDirs].sort((a, b) => b.mtime - a.mtime)[0];
    const files = await readdir(chosen.dir).catch(() => []);
    const hits = files
      .filter((name) => /^session\.v\d+\.jsonl(\.(zst|zstd|gz))?$/u.test(name))
      .sort();
    if (hits.length === 0) {
      located = {
        logPath: null,
        dirName: chosen.name,
        candidates: located.candidates,
        fallback: preferred === undefined,
      };
      continue;
    }
    located = {
      logPath: join(chosen.dir, hits[hits.length - 1]),
      dirName: chosen.name,
      candidates: located.candidates,
      fallback: preferred === undefined,
    };
  }

  if (located.logPath === null) {
    return {
      missing: true,
      logName: "",
      dirName: located.dirName,
      candidates: located.candidates,
      fallback: located.fallback,
      events: [],
    };
  }

  const logPath = located.logPath;
  /** @type {any[]} */
  let events = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const buffer = await readFile(logPath);
      const text =
        logPath.endsWith(".zstd") || logPath.endsWith(".zst")
          ? decodeZstdFrames(buffer)
          : logPath.endsWith(".gz")
            ? gunzipSync(buffer).toString("utf8")
            : buffer.toString("utf8");
      events = text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      if (events.length > 0) break;
    } catch (_error) {
      /* 继续重试 */
    }
    await sleep(500);
  }
  return {
    missing: false,
    logName: logPath.split("/").pop() ?? "",
    logPath,
    dirName: located.dirName,
    candidates: located.candidates,
    fallback: located.fallback,
    events,
  };
}

/**
 * 从会话事件里捞出某种插件记录（信封形状随宿主版本变化，这里按「任意嵌套里出现
 * `{ type: <记录类型>, data: {...} }`」递归找，不写死外层事件类型）。
 * @param {any[]} events
 * @param {string} recordType
 * @returns {{ data: any, seq: number | null }[]}
 */
function collectPluginRecords(events, recordType) {
  /** @type {{ data: any, seq: number | null }[]} */
  const out = [];
  for (const event of events) {
    /** @param {any} node @param {number} depth */
    const visit = (node, depth) => {
      if (node === null || typeof node !== "object" || depth > 8) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (node.type === recordType && node.data !== null && typeof node.data === "object") {
        out.push({ data: node.data, seq: typeof event?.seq === "number" ? event.seq : null });
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(event, 0);
  }
  // 同一记录可能在信封里出现两次（事件本体 + 冗余字段），按 seq+turn 去重。
  const seen = new Set();
  return out.filter((record) => {
    const key = `${String(record.seq)}:${String(record.data?.turn)}:${String(record.data?.phase ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 读会话日志验证「点击 = 真的发出一条用户消息」以及「关闭开关后没有 card 记录」。
 * @param {string} home
 * @param {{ sessionId?: string, canModel?: boolean, cardTurn?: number, clickedIndex?: number, cardsBeforeDisable?: number }} state
 * @returns {Promise<{ name: string, ok: boolean, detail: string, skip?: boolean }[]>}
 */
async function verifySessionLog(home, state) {
  /** @type {{ name: string, ok: boolean, detail: string, skip?: boolean }[]} */
  const checks = [];
  /** @param {string} name @param {boolean} ok @param {string} [detail] */
  const push = (name, ok, detail = "") => checks.push({ name, ok, detail });
  /** @param {string} name @param {string} reason */
  const skip = (name, reason) => checks.push({ name, ok: true, detail: reason, skip: true });
  const sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
  if (sessionId === "") {
    push("读会话日志：拿到 sessionId", false, "SMOKE_STATE 缺失");
    return checks;
  }
  const log = await readSessionEvents(home, sessionId);
  if (log.missing === true) {
    push(
      "读会话日志：找到当前格式的日志文件",
      false,
      `sessions/ 下没找到该会话的 session.v<N>.jsonl[.zstd|.gz]：sessionId=${JSON.stringify(sessionId)} 命中的目录=${JSON.stringify(log.dirName)} 候选目录=${JSON.stringify(log.candidates)} home=${home}`,
    );
    return checks;
  }
  // 目录名兜底（<uuid> / session-<uuid> / 包装层）命中时把证据写进 detail，避免「悄悄读到别的会话」。
  push(
    "读会话日志：会话目录与 sessionId 对得上",
    log.fallback !== true,
    log.fallback === true
      ? `sessionId=${JSON.stringify(sessionId)} 没能直接匹配，已兜底取最新的会话目录 ${JSON.stringify(log.dirName)}（候选=${JSON.stringify(log.candidates)}）；临时 home 里通常只有本次会话，但请留意`
      : `目录=${JSON.stringify(log.dirName)} 日志=${JSON.stringify(log.logName)}`,
  );
  if (state.canModel !== true) {
    skip("读会话日志：卡片/决策记录", "没有模型凭据，本轮不产生卡片记录");
    return checks;
  }
  const cardRecords = collectPluginRecords(log.events, "plugin:next-step/card");
  const decisionRecords = collectPluginRecords(log.events, "plugin:next-step/decision");
  push(
    "日志里有卡片记录（可跨重启重建）",
    cardRecords.length >= 1,
    `期望>=1 实际=${cardRecords.length}（日志=${log.logName}）`,
  );
  const targetTurn = typeof state.cardTurn === "number" ? state.cardTurn : null;
  const card = cardRecords.find((record) => record.data?.turn === targetTurn) ?? cardRecords[0];
  if (card === undefined) return checks;
  push(
    "卡片记录：turn 是整数、options 恰好 2 条、stance 互斥",
    Number.isSafeInteger(card.data?.turn) &&
      Array.isArray(card.data?.options) &&
      card.data.options.length === 2 &&
      card.data.options[0]?.stance !== card.data.options[1]?.stance,
    JSON.stringify({
      turn: card.data?.turn,
      options: card.data?.options?.map((/** @type {any} */ o) => ({
        stance: o?.stance,
        label: o?.label,
      })),
    }),
  );
  push(
    "卡片记录带 nextPrompt（幽灵提示的取数来源）",
    typeof card.data?.nextPrompt === "string" && card.data.nextPrompt.trim() !== "",
    JSON.stringify({ nextPrompt: String(card.data?.nextPrompt ?? "").slice(0, 80) }),
  );
  push(
    "卡片记录：summary/question 非空、nextPrompt 长度 ≤ 120",
    typeof card.data?.summary === "string" &&
      card.data.summary.trim() !== "" &&
      typeof card.data?.question === "string" &&
      card.data.question.trim() !== "" &&
      (card.data?.nextPrompt === undefined || String(card.data.nextPrompt).length <= 120),
    JSON.stringify({
      summary: String(card.data?.summary ?? "").slice(0, 40),
      nextPromptLength: String(card.data?.nextPrompt ?? "").length,
    }),
  );
  if (targetTurn === null) {
    skip(
      "读会话日志：决策记录与「点击=发消息」",
      "DOM 没出现卡片（浏览器侧断言已失败），日志侧不再级联断言",
    );
    return checks;
  }
  const decision = decisionRecords.find((record) => record.data?.turn === card.data?.turn);
  const clickedIndex = typeof state.clickedIndex === "number" ? state.clickedIndex : 0;
  push(
    "日志里有 sent 决策记录（phase=sent、index 与点击一致）",
    decision !== undefined &&
      decision.data?.phase === "sent" &&
      decision.data?.index === clickedIndex,
    `${JSON.stringify(decision?.data ?? null)} 期望 index=${clickedIndex}`,
  );
  // 核心：点击后原样发出的那条 option.text 必须作为**真人 user/message** 出现在决策记录之后。
  const optionText =
    Array.isArray(card.data?.options) && card.data.options[clickedIndex] !== undefined
      ? String(card.data.options[clickedIndex].text ?? "")
      : "";
  const decisionSeq = decision?.seq ?? -1;
  /** @type {{ seq: number, text: string }[]} */
  const humanMessages = [];
  for (const event of log.events) {
    if (event?.type !== "user/message") continue;
    if (event?.data?.source?.kind !== "user") continue;
    const content = Array.isArray(event.data.content) ? event.data.content : [];
    const text = content
      .filter(
        (/** @type {any} */ block) => block?.type === "text" && typeof block.text === "string",
      )
      .map((/** @type {any} */ block) => block.text)
      .join("");
    if (typeof event.seq === "number") humanMessages.push({ seq: event.seq, text });
  }
  push(
    "点击的胶囊文本作为真人用户消息发出（且晚于决策记录）",
    optionText !== "" &&
      humanMessages.some((message) => message.text === optionText && message.seq > decisionSeq),
    JSON.stringify({
      optionText: optionText.slice(0, 80),
      decisionSeq,
      matches: humanMessages
        .filter((message) => message.text === optionText)
        .map((message) => message.seq),
      humanCount: humanMessages.length,
    }),
  );
  // 硬约束：发出去的是 option.text（完整指令），不是 option.label（按钮文案）。
  const label = String(card.data?.options?.[clickedIndex]?.label ?? "");
  const lastHuman = humanMessages[humanMessages.length - 1];
  push(
    "最后一条用户消息文本 === option.text（不是 label）",
    lastHuman !== undefined && lastHuman.text === optionText && optionText !== label,
    JSON.stringify({
      expectedText: optionText.slice(0, 80),
      actualLastHuman: (lastHuman?.text ?? "").slice(0, 80),
      label,
      textDiffersFromLabel: optionText !== label,
    }),
  );
  push(
    "关闭开关后没有新的 card 记录（日志层面同样成立）",
    typeof state.cardsBeforeDisable === "number" && cardRecords.length === state.cardsBeforeDisable,
    `关闭前卡片数=${state.cardsBeforeDisable} 日志 card 记录数=${cardRecords.length}`,
  );
  return checks;
}

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser")))
    return console.log("SKIP 未找到 ego-browser（GUI 冒烟需要本机浏览器环境）");

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-next-step-"));
  const realHome = process.env.HOME ?? "";
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  try {
    const home = join(work, "home");
    const profile = join(home, "profiles", PROFILE);
    // macOS 的 /var 是 /private/var 的软链：宿主按 realpath 校验工作区归属，
    // 把没解析符号链接的路径写进 workspace.json 会让新会话 attach 失败
    // （错误：its cwd resolves to '/private/var/...'）。
    const workspaceDirRaw = join(work, "workspace");
    await mkdir(workspaceDirRaw, { recursive: true });
    const workspaceDir = await realpath(workspaceDirRaw);
    await mkdir(profile, { recursive: true });
    await cp(join(realHome, ".dsh", "profiles", "desktop"), profile, { recursive: true });

    const profileJson = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
    profileJson.name = `dsh-profile-${PROFILE}-smoke`;
    await writeFile(join(profile, "package.json"), JSON.stringify(profileJson, null, 2));

    // 只放**一个**工作区，指向临时目录：脚本绝不碰用户真实项目。
    await mkdir(join(home, "storages"), { recursive: true });
    const realWorkspaceFile = join(realHome, ".dsh", "storages", "workspace.json");
    /** @type {any} */
    let unit = { name: "workspace", version: 2 };
    try {
      const real = JSON.parse(await readFile(realWorkspaceFile, "utf8"));
      if (real?.unit) unit = real.unit;
    } catch (_error) {
      /* 没有真实 storages 时用默认 unit */
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

    // 模型凭据：有环境变量或真实 .credentials.yaml 才跑卡片断言。
    const envKeys = ["DEEPSEEK_API_KEY", "ZHINAO_API_KEY"].filter(
      (name) => typeof process.env[name] === "string" && process.env[name] !== "",
    );
    const credentialsSource = join(realHome, ".dsh", ".credentials.yaml");
    const credentialsCopied = existsSync(credentialsSource);
    if (credentialsCopied) {
      await cp(credentialsSource, join(home, ".credentials.yaml")).catch(() => {});
    }
    const canModel =
      process.env.SMOKE_NO_MODEL === "1" ? false : envKeys.length > 0 || credentialsCopied;
    console.log(
      canModel
        ? `模型凭据：${envKeys.length > 0 ? envKeys.join("+") : ""}${envKeys.length > 0 && credentialsCopied ? " + " : ""}${credentialsCopied ? "~/.dsh/.credentials.yaml" : ""}`
        : "模型凭据：无（卡片 6 项将 SKIP）",
    );

    // 打当前源码的包，装进临时 profile
    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");

    const env = { ...process.env, DSH_HOME: home };
    await run("dsh", ["plugin", "--profile", PROFILE, "install"], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", PROFILE, "remove", PACKAGE], { env }).catch(() => {});
    const added = await run("dsh", ["plugin", "--profile", PROFILE, "add", join(work, tgz)], {
      env,
    });
    if (/error|incompatible/u.test(added.stderr) && !/already/u.test(added.stderr)) {
      console.warn(`安装插件时宿主打印了告警：\n${added.stderr.slice(-800)}`);
    }

    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {string[]} */
    const chunks = [];
    host.stdout?.on("data", (/** @type {any} */ c) => chunks.push(String(c)));
    host.stderr?.on("data", (/** @type {any} */ c) => chunks.push(String(c)));
    await writeFile(logPath, "");
    const flush = async () => writeFile(logPath, chunks.join(""));
    const poll = setInterval(flush, 300);

    /** @type {{ port: number, token: string, activationFailures: number, text: string }} */
    let boot;
    try {
      boot = await waitForBoot(logPath, 90_000);
    } finally {
      clearInterval(poll);
      await flush();
    }
    if (boot.activationFailures > 0) {
      fail(`宿主报告 ${boot.activationFailures} 个插件未激活`);
      console.error(boot.text.slice(-3000));
      return;
    }
    console.log(`宿主已启动：http://127.0.0.1:${boot.port}`);

    const url = `http://127.0.0.1:${boot.port}/?token=${boot.token}`;
    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const browserSource = browserScript(url, shotsDir, home, canModel);
    await writeFile(browserFile, browserSource);
    await writeFile(join(shotsDir, "browser.mjs"), browserSource);

    const result = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      // 三轮模型调用 + 卡片生成，给足余量；超时直接 SIGTERM 并由下面的解析判失败。
      const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
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

    if (process.env.SMOKE_DEBUG) console.log(String(result).slice(-12000));
    const match = String(result).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果");
      console.error(String(result).slice(-5000));
      return;
    }
    /** @type {{ checks: { name: string, ok: boolean, detail: string, skip?: boolean }[] }} */
    const parsed = JSON.parse(match[1]);
    const stateMatch = String(result).match(/SMOKE_STATE (\{.*\})/u);
    /** @type {any} */
    const state = stateMatch ? JSON.parse(stateMatch[1]) : {};

    // 停宿主，等日志 flush 落盘，再直接读会话日志做「点击真的发了消息」的独立验证。
    host.kill("SIGTERM");
    await sleep(1500);
    host = undefined;
    const logChecks = await verifySessionLog(home, state);

    let failed = 0;
    let skipped = 0;
    for (const item of [...parsed.checks, ...logChecks]) {
      const tag = item.skip === true ? "SKIP " : item.ok ? "PASS " : "FAIL ";
      console.log(tag + item.name + (item.skip === true || !item.ok ? ` :: ${item.detail}` : ""));
      if (item.skip === true) skipped += 1;
      else if (!item.ok) failed += 1;
    }
    const total = parsed.checks.length + logChecks.length;
    console.log(`截图目录：${SHOTS_OUT}`);
    if (failed > 0) {
      fail(`${failed} 项断言失败（共 ${total} 项，SKIP ${skipped} 项）`);
      return;
    }
    if (skipped > 0) {
      console.log(`PASS 其余 ${total - skipped} 项冒烟断言通过；SKIP ${skipped} 项（原因见上）`);
      return;
    }
    console.log(`PASS 全部 ${total} 项冒烟断言通过`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    await sleep(500);
    // 先搬截图，再删临时目录（顺序反了会把证据一起删掉）。
    await mkdir(SHOTS_OUT, { recursive: true }).catch(() => {});
    await cp(join(work, "shots"), SHOTS_OUT, { recursive: true }).catch(() => {});
    if (process.env.SMOKE_KEEP === "1") {
      console.log(`临时目录已保留：${work}`);
    } else {
      await rm(work, { recursive: true, force: true });
    }
    console.log(`截图目录：${SHOTS_OUT}`);
  }
};

await main();
