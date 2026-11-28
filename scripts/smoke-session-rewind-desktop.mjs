#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑
//   pnpm smoke:session-rewind-desktop
//   # 发版门禁用 --require：连不上端口时不是 SKIP，而是失败（避免「没测也绿」）
//   pnpm smoke:session-rewind-desktop --require
//
// 默认只读：只切会话、开/关对话框与面板、点取消；**不回溯、不写文件、不发模型请求**，因此可以
// 直接跑在真实 profile 上。端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
//
// `--deep --workspace <专用测试目录>`：额外跑**文件模式端到端**（在该目录的会话里发模型请求，
// 让它用 write 写文件、然后回溯、救援点恢复、修改还原、冲突拒绝）。前置有两条：
//   1) `--workspace` 指向一个**已注册成桌面工作区**的目录（桌面「工作区 → 添加工作区」选一次；
//      这是唯一的人工步骤，脚本只读侧栏、不写宿主注册表）。标题默认取目录名，改过名用
//      `--sidebar-workspace` 指定。**macOS 的 /tmp 是 /private/tmp 的软链**：要按真实路径注册，
//      否则会话建得出来却「附不到工作区」，界面静默停在旧会话上；
//   2) 模型凭据可用（要发真请求、花额度）。
// 脚本会**自己**在该工作区点「新建会话」并断言四个终态：会话 id 变了、会话为空、输入框可编辑、
// 工作区选择器显示该工作区。不依赖调用者先手工开好会话，也不依赖前面段落「切回某个会话」——
// 侧栏行在折叠分组里时点击不生效，那会让模型在没有该工作区权限的会话里跑，写出的文件落到
// **脚本 cwd（本仓库）**，而断言只表现为「文件不存在」。脚本绝不会退而求其次用工作区里别的会话。
// 校准要点（2026-11-28）：文件断言**轮询文件系统**、不依赖模型回复文案；每轮 prompt 用真实
// ⌘A/⌫ 清空输入框（回溯会把撤回的消息回填进来，`execCommand("delete")` 改得动 DOM、清不掉
// Lexical 的编辑器状态）；断言「确实用了 write」看的是工具卡的 `data-tool`。
// 宿主 0.2.2-rc.5 的四个 agent 预设都把 `tool-fs.applyPatch` 设为 false，桌面默认没有
// apply_patch，所以「删除文件」三条断言在默认组合里按环境分支 SKIP（宿主流行值，不是插件缺陷）。
//   pnpm smoke:session-rewind-desktop --require --deep --workspace ~/Workspace/dsh-rewind-ui-smoke
//
// 三条踩过的坑：
//   1. `Esc` `Esc` 在「正在运行本 agent 的会话」里会触发内置停止，取消正在跑的这一轮
//      （脚本自己的工具调用会被 abort）。所以先切到一个**有消息的空闲会话**再按 Esc。
//   2. 侧栏里可能有没有消息的会话，切过去候选列表是空的；必须挑选有用户消息的会话。
//   3. 手势断言（`Esc` `Esc`、`↑` `↓`）要留**一次重试**：刚切完会话/刚关掉对话框时焦点还差一拍，
//      第一次按不出、第二次就出来；重试不能降低断言（仍然要求最终拿到对话框）。
//
// `--sidebar-workspace <标题>`：只在该工作区的分组里找会话，**不碰别的工作区的会话**。
//
// `--recall`：额外验证「输入框 ↑/↓ 历史召回」（在真实 Electron 渲染进程里派发真实按键）。
// 它会往输入框里写草稿、并在结束时清空；**不发送、不回溯、不写会话日志**。
//   pnpm smoke:session-rewind-desktop --require --recall
// 找不到合格会话就判失败（而不是随手点开别人的会话）。
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { deepDeleteVerdict } from "./lib/deep-delete-gate.mjs";

const SHOTS = join(tmpdir(), "dsh-session-rewind-desktop-shots");
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {number} port
 */
async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((/** @type {any} */ item) => item.type === "page");
  if (!page) throw new Error(`no page target on 127.0.0.1:${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  ws.onmessage = (/** @type {any} */ event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const record = pending.get(msg.id);
      if (record === undefined) return;
      pending.delete(msg.id);
      if (msg.error) record.reject(new Error(JSON.stringify(msg.error)));
      else record.resolve(msg.result);
    }
  };
  /** @param {string} method @param {any} [params] */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** @param {string} expression */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "evaluate failed",
      );
    }
    return result.result?.value;
  };
  /** @param {string} file */
  const screenshot = async (file) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
  };
  return { ws, send, evaluate, screenshot };
}

/** @param {any} cdp @param {string} key @param {number} vk */
async function pressEscape(cdp, key, vk) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: vk,
    });
  }
}

// 注意：回溯抽屉（.dsh-srw-drawer）也是 role="dialog"[aria-modal="true"]，但它铺满窗口、
// 会吃掉输入框的点击，所以确认框必须按 .dsh-srw-dialog 精确匹配，否则「打开确认框」会拿到抽屉。
const DIALOG = `[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw-dialog"))`;

/** @param {any} cdp */
const dialogInfo = (cdp) =>
  cdp.evaluate(`(() => {
    const dlg = ${DIALOG};
    if (!dlg) return null;
    return {
      title: dlg.getAttribute("aria-label") || "",
      text: (dlg.textContent || "").replace(/\\s+/g, " "),
      rows: [...dlg.querySelectorAll(".dsh-srw-row")].map((row) => (row.textContent || "").trim()),
      hasSearch: !!dlg.querySelector('input[type="search"]'),
      radios: [...dlg.querySelectorAll('input[type="radio"]')].map((r) => r.value),
      resend: (() => {
        const box = dlg.querySelector('input[data-rewind-resend="true"]');
        return box ? { present: true, checked: box.checked } : { present: false, checked: false };
      })(),
      buttons: [...dlg.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean),
      recoverable: (() => {
        const el = dlg.querySelector("[data-rewind-recoverable]");
        return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "";
      })(),
      autofocus: (() => {
        const el = dlg.querySelector("[data-modal-autofocus]");
        if (!el) return null;
        return {
          label: (el.textContent || "").trim(),
          primary: (el.className || "").includes("dsh-srw-btn-primary"),
          focused: document.activeElement === el,
        };
      })(),
      focusInDialog: dlg.contains(document.activeElement),
      trackingScope: (() => {
        const el = dlg.querySelector("[data-srw-tracking-scope]");
        return el ? (el.textContent || "").trim() : "";
      })(),
    };
  })()`);

/** @param {any} cdp @param {string[]} labels */
const clickDialogButton = (cdp, labels) =>
  cdp.evaluate(`(() => {
    const dlg = ${DIALOG};
    if (!dlg) return false;
    const btn = [...dlg.querySelectorAll("button")].find((b) => ${JSON.stringify(labels)}.includes((b.textContent || "").trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

/** @param {any} cdp */
const drawerInfo = (cdp) =>
  cdp.evaluate(`(() => {
    const root = document.querySelector(".dsh-srw-drawer");
    if (!root) return null;
    return {
      tabs: [...root.querySelectorAll(".dsh-srw-tab")].map((t) => (t.textContent || "").trim()),
      text: (root.textContent || "").replace(/\\s+/g, " "),
      hintPresent: !!root.querySelector(".dsh-srw-drawer-hint"),
      hasPickMessage: [...root.querySelectorAll("button")].some((b) =>
        /选择消息回退|Pick a message/iu.test((b.textContent || "").trim()),
      ),
    };
  })()`);

/** @param {any} cdp @param {string} tab */
const openDrawerTab = (cdp, tab) =>
  cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll(".dsh-srw-tab")].find((t) => (t.textContent || "").trim() === ${JSON.stringify(tab)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** @param {string} path */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 输入框在屏幕上的中心点（真实鼠标点击用）。 */
const composerCentre = (/** @type {any} */ cdp) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector("[data-composer-input]");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 24) };
  })()`);

/** 真实鼠标点击一个坐标（渲染进程里派发，和用户点一样）。 */
async function clickPoint(/** @type {any} */ cdp, /** @type {{x: number, y: number}} */ point) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: 1,
    });
  }
}

/** 聚焦输入框：先真点一下；被面板遮住时退回程序化 focus，最后都要求 activeElement 是输入框。 */
async function focusComposer(/** @type {any} */ cdp) {
  const point = await composerCentre(cdp);
  if (point === null) return false;
  await clickPoint(cdp, point);
  await sleep(120);
  const state = await cdp.evaluate(`(() => {
    const el = document.querySelector("[data-composer-input]");
    if (!el) return { ready: false };
    if (document.activeElement !== el) el.focus();
    return {
      ready: document.activeElement === el && el.getAttribute("contenteditable") === "true",
      active: document.activeElement ? String(document.activeElement.tagName) : null,
    };
  })()`);
  return state?.ready === true;
}

/** 发一次真实按键（`modifiers` 4 = Meta/⌘）。 */
async function pressCombo(
  /** @type {any} */ cdp,
  /** @type {string} */ key,
  /** @type {string} */ code,
  /** @type {number} */ vk,
  /** @type {number} */ modifiers = 0,
) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: 0,
      modifiers,
    });
  }
}

/**
 * 清空 composer。
 *
 * **不能用 `document.execCommand("delete")`**：它改得动 DOM，却改不动 Lexical 的编辑器状态，
 * 于是下一轮 insertText 会追加在旧草稿后面。2026-11-28 实测：回溯把撤回的消息回填进输入框后，
 * 旧写法清不掉，之后每一轮 prompt 都叠成「旧任务 + 新任务」发给模型——模型于是反复执行旧任务，
 * 表现为「覆盖没发生 / 删除没发生」。真实 ⌘A → ⌫ 才清得干净。
 */
async function clearComposer(/** @type {any} */ cdp) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await focusComposer(cdp))) return false;
    await pressCombo(cdp, "a", "KeyA", 65, 4);
    await sleep(110);
    await pressCombo(cdp, "Backspace", "Backspace", 8);
    await sleep(220);
    const text = await composerText(cdp);
    if (typeof text === "string" && text.trim() === "") return true;
  }
  return false;
}

/** 打字并确认真的进了输入框（CDP 的原生 insertText 才走 Lexical 的输入管线）。 */
async function typeIntoComposerStrict(/** @type {any} */ cdp, /** @type {string} */ text) {
  const probe = text.slice(0, Math.min(16, text.length));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await focusComposer(cdp))) return false;
    await cdp.send("Input.insertText", { text });
    await sleep(260);
    const current = await composerText(cdp);
    if (typeof current === "string" && current.includes(probe)) return true;
    await clearComposer(cdp);
  }
  return false;
}

/** 点发送，并确认用户行真的多了一条（断言界面状态，不信按钮回调）。 */
async function sendComposer(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 20000) {
  const count = () =>
    cdp.evaluate(`document.querySelectorAll('[data-chat-flow-kind="user"]').length`);
  const before = await count();
  const clicked = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /发送消息|Send/.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const now = await count();
    if (typeof now === "number" && now > before) return { clicked, delivered: true };
  }
  return { clicked, delivered: false };
}

/**
 * 当前会话界面里的工具卡（宿主用 `data-tool` 标出工具名）。
 * @param {any} cdp
 * @returns {Promise<{tool: string, state: string}[]>}
 */
const toolCards = (cdp) =>
  cdp.evaluate(`(() => [...document.querySelectorAll("[data-tool]")].map((el) => ({
    tool: el.getAttribute("data-tool") || "",
    state: el.getAttribute("data-state") || "",
  })))()`);

/** 轮询文件状态：`expected` 是内容；传 `null` 表示「应当不存在」。 */
async function waitForFileState(
  /** @type {string} */ filePath,
  /** @type {string | null} */ expected,
  /** @type {number} */ timeoutMs = 60000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (expected === null) {
      if (!(await exists(filePath))) return true;
    } else {
      try {
        if ((await readFile(filePath, "utf8")).trim() === expected) return true;
      } catch {
        /* 文件还没出现，继续等 */
      }
    }
    await sleep(400);
  }
  return false;
}

/** 发一轮 prompt：清空 → 打字 → 发送 → 等回合结束，并带回本轮工具卡。 */
const runPrompt = async (
  /** @type {any} */ cdp,
  /** @type {string} */ text,
  /** @type {number} */ timeoutMs = 300000,
) => {
  const cleared = await clearComposer(cdp);
  const typed = cleared && (await typeIntoComposerStrict(cdp, text));
  const send = await sendComposer(cdp);
  const finished = send.delivered ? await waitForTurnEnd(cdp, timeoutMs) : false;
  return { cleared, typed, sent: send.delivered, finished, tools: await toolCards(cdp) };
};

/** 点最后一条用户消息的 ↶（--deep 的修改/删除/冲突场景都围绕最新一轮）。 */
const openRewindOnLastUser = (/** @type {any} */ cdp) =>
  cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')];
    const row = rows[rows.length - 1];
    if (!row) return "no-user-row";
    const btn = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回退到此处"));
    if (!btn) return "no-rewind-button";
    btn.click();
    return "clicked";
  })()`);

/** 点 ↶ 并轮询确认框出现；刚发完一轮时焦点还差一拍，允许重试一次。 */
async function openRewindDialog(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 12000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clicked = await openRewindOnLastUser(cdp);
    if (clicked !== "clicked") return clicked;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await dialogInfo(cdp)) !== null) return "clicked";
      await sleep(300);
    }
  }
  return "no-dialog";
}

/** 等「对话+文件」单选可用：文件变更记录异步落库，可能晚一两拍。 */
async function waitForBothRadio(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate(`(() => {
      const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
      return radio ? !radio.disabled : null;
    })()`);
    if (ready === true) return true;
    await sleep(300);
  }
  return false;
}

/**
 * 等确认框正文出现指定文案：影响面是**异步**算的，刚点开时正文可能还是
 * 「正在计算影响面…」，这时断言预览文案会假红。
 */
async function waitForDialogText(
  /** @type {any} */ cdp,
  /** @type {string} */ pattern,
  /** @type {number} */ timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  const re = new RegExp(pattern, "u");
  let text = "";
  while (Date.now() < deadline) {
    const info = await dialogInfo(cdp);
    text = typeof info?.text === "string" ? info.text : "";
    if (re.test(text)) return { matched: true, info, text };
    await sleep(300);
  }
  return { matched: false, info: null, text };
}

/** 确认框里选「对话+文件」并执行；返回是否在超时内关闭。 */
const chooseBothAndConfirm = async (/** @type {any} */ cdp) => {
  await cdp.evaluate(`(() => {
    const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
    if (radio && !radio.disabled) radio.click();
  })()`);
  await sleep(400);
  const confirmed = await clickDialogButton(cdp, ["开始回退", "Rewind"]);
  let gone = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    if ((await dialogInfo(cdp)) === null) {
      gone = true;
      break;
    }
  }
  return confirmed && gone;
};

/** 等 toast 出现并返回文本（toast 与回退结果同时落，慢机器会晚一拍）。 */
async function waitForToast(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await cdp.evaluate(
      `(() => { const el = document.querySelector(".dsh-srw-toast"); return el ? (el.textContent || "").trim() : ""; })()`,
    );
    if (typeof text === "string" && text !== "") return text;
    await sleep(300);
  }
  return typeof text === "string" ? text : "";
}

/** 打开回溯抽屉（幂等）。 */
async function openDrawer(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      if (document.querySelector(".dsh-srw-drawer")) return "open";
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
      if (!btn) return "no-button";
      btn.click();
      return "clicked";
    })()`);
    if (state === "open") return true;
    await sleep(500);
  }
  return false;
}

/**
 * 关闭回溯抽屉。抽屉是铺满窗口的 \`role="dialog"\` aside：开着的时候它会挡住输入框的点击，
 * 后续还要在会话里发 prompt，必须先关（2026-11-28 实测：不关的话输入框点不进去，
 * 打字落空、发送按钮一直是 disabled）。
 */
async function closeDrawer(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      if (!root) return "closed";
      const btn = [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭");
      if (!btn) return "no-button";
      btn.click();
      return "clicked";
    })()`);
    if (state === "closed") return true;
    await sleep(400);
  }
  return false;
}

/** 在抽屉里按文本正则找按钮并点击（抽屉内容异步渲染，先轮询出现）。 */
async function clickDrawerButton(
  /** @type {any} */ cdp,
  /** @type {string} */ pattern,
  /** @type {number} */ timeoutMs = 10000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      if (!root) return "no-drawer";
      const re = new RegExp(${JSON.stringify(pattern)}, "iu");
      const btn = [...root.querySelectorAll("button")].find((b) => re.test((b.textContent || "").trim()));
      if (!btn) return "no-button";
      btn.click();
      return "clicked";
    })()`);
    if (result === "clicked") return "clicked";
    await sleep(400);
  }
  return "no-button";
}

/**
 * 找侧栏里的工作区行：展开所有折叠分组后按标题精确匹配。
 * 标题默认是目录名（宿主按目录名自动起名）；用户改过名时用 `--sidebar-workspace` 指定。
 */
async function waitForWorkspaceRow(
  /** @type {any} */ cdp,
  /** @type {string} */ title,
  /** @type {number} */ timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  /** @type {string[]} */
  let labels = [];
  while (Date.now() < deadline) {
    const state = await cdp
      .evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-row-key^="workspace:"]')];
        for (const row of rows) {
          if (row.getAttribute("aria-expanded") === "false") row.click();
        }
        return { labels: rows.map((row) => (row.textContent || "").trim()) };
      })()`)
      .catch(() => null);
    if (state !== null && Array.isArray(state.labels)) {
      labels = state.labels;
      if (labels.includes(title)) return { found: true, detail: "" };
    }
    await sleep(500);
  }
  return {
    found: false,
    detail: labels.length === 0 ? "侧栏里没有任何工作区" : `侧栏工作区：${labels.join(" / ")}`,
  };
}

/**
 * 等「绑定该工作区的空白会话」就绪：会话 id 变了、0 条用户消息、输入框可编辑。
 * 只点按钮不算数——宿主可能建了会话却附不上工作区（cwd 真实路径不一致时会这样），
 * 那时界面仍停在旧会话上，必须按终态重试而不是静默继续。
 */
async function waitForFreshSession(
  /** @type {any} */ cdp,
  /** @type {string | null} */ previousSessionId,
  /** @type {number} */ timeoutMs = 25000,
) {
  const deadline = Date.now() + timeoutMs;
  /** @type {any} */
  let detail = {};
  while (Date.now() < deadline) {
    detail = await cdp
      .evaluate(`(() => {
        const root = document.querySelector("[data-conversation-session]");
        const composer = document.querySelector("[data-composer-input]");
        const ws = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "选择工作区");
        return {
          session: root ? root.getAttribute("data-conversation-session") : null,
          phase: root ? root.getAttribute("data-content-phase") : null,
          userRows: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
          editable: composer ? composer.getAttribute("contenteditable") === "true" : false,
          workspace: ws ? (ws.textContent || "").trim() : "",
        };
      })()`)
      .catch(() => ({}));
    const changed =
      typeof detail.session === "string" &&
      detail.session !== null &&
      detail.session !== previousSessionId;
    if (changed && detail.userRows === 0 && detail.editable === true) return { ok: true, detail };
    await sleep(400);
  }
  return { ok: false, detail };
}

/** 输入框里是否还有「停止」按钮（回合仍在跑）。 */
const isRunning = (/** @type {any} */ cdp) =>
  cdp.evaluate(`(() => [...document.querySelectorAll("button")].some((b) => {
    const aria = (b.getAttribute("aria-label") || "").trim();
    const ttl = (b.getAttribute("title") || "").trim();
    return /停止|Stop/i.test(aria + " " + ttl);
  }))()`);

/** @param {any} cdp @param {number} timeoutMs */
async function waitForTurnEnd(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(cdp))) {
      // 再等一拍，避免「还没开始渲染」被当成结束
      await sleep(1200);
      if (!(await isRunning(cdp))) return true;
    }
    await sleep(1000);
  }
  return false;
}

const composerText = (/** @type {any} */ cdp) =>
  cdp.evaluate(
    `(() => { const el = document.querySelector("[data-composer-input]"); return el ? (el.textContent || "") : ""; })()`,
  );

/**
 * 等页面可交互：document.readyState complete 且根节点有内容，最多等 ~15s。
 * @param {any} cdp
 */
async function ensureReady(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await cdp
      .evaluate(
        `(() => document.readyState === "complete" && document.body && document.body.innerText.trim().length > 20)()`,
      )
      .catch(() => false);
    if (ready === true) {
      await sleep(600);
      return;
    }
    await sleep(400);
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
      deep: { type: "boolean", default: false },
      workspace: { type: "string" },
      // 侧栏工作区标题：把会话交互严格限制在该工作区分组内。
      "sidebar-workspace": { type: "string" },
      // 输入框 ↑/↓ 历史召回：会往输入框里按方向键并写草稿，跑完清空。
      recall: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  // 容忍 `pnpm <script> -- --require`：多余的 `--` 会被当成位置参数，这里忽略它。
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  /** @type {{name: string, ok: boolean, skipped: boolean, detail: string}[]} */
  const checks = [];
  const check = (
    /** @type {string} */ name,
    /** @type {boolean} */ ok,
    /** @type {string} */ detail = "",
  ) => checks.push({ name, ok, detail, skipped: false });
  /**
   * 环境分支：确实无法验证时不伪装成 PASS，也不把「宿主没这个工具」报成插件红。
   * 门禁认可 SKIP（只要有 PASS），理由写进 detail 供复核。
   * @param {string} name
   * @param {string} detail
   */
  const skip = (name, detail) => checks.push({ name, ok: true, detail, skipped: true });

  /** @type {Awaited<ReturnType<typeof connect>> | undefined} */
  let cdp;
  try {
    cdp = await connect(port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (values.require === true) {
      console.error(`FAIL 无法连接 CDP（127.0.0.1:${port}）：${message}`);
      console.error(
        "提示：先带调试端口重启桌面版，或用 --args --remote-debugging-port=9222 启动。",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`SKIP 无法连接 CDP（127.0.0.1:${port}）：${message}`);
    console.log("提示：先按文件头的命令带 --remote-debugging-port=9222 重启 DSH 桌面版。");
    console.log("（发版门禁请加 --require：连不上端口将判为失败而不是跳过。）");
    return;
  }

  await mkdir(SHOTS, { recursive: true }).catch(() => {});
  // 紧接着别的 GUI 冒烟跑时，渲染线程可能还在忙；先等页面稳定再断言。
  await ensureReady(cdp);
  try {
    // ---------- A. 插件加载与入口 ----------
    const info = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || "");
      return {
        title: document.title,
        pluginStyles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter((p) => p && p.includes("session-rewind")),
        headerButton: buttons.some((aria) => aria.includes("回溯面板")),
        userRows: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
        rewindButtons: [...document.querySelectorAll('[data-chat-flow-kind="user"] button')].filter((b) => (b.getAttribute("aria-label") || "").includes("回退到此处")).length,
      };
    })()`);
    check(
      "连接到 DSH 桌面 UI",
      typeof info?.title === "string" && info.title.length > 0,
      info?.title ?? "",
    );
    check(
      "插件 client 半已加载（样式注入）",
      info?.pluginStyles?.length > 0,
      JSON.stringify(info?.pluginStyles ?? []),
    );
    // 没打开任何会话时头部本来就没有动作区，这时不该判失败。
    check(
      "会话头部有回溯面板入口",
      info?.headerButton === true || (info?.userRows ?? 0) === 0,
      info?.headerButton === true ? "" : "当前没有打开会话，跳过该断言",
    );
    // 注意：当前会话可能本来就没有用户消息（例如刚被回溯过），不能在这断言 ↶ 存在；
    // 挑到候选可达的会话之后再断言（见下）。
    check(
      "当前会话渲染正常（用户行与 ↶ 按钮数量自洽）",
      info?.rewindButtons === 0 || info.rewindButtons === info.userRows,
      `${info?.userRows ?? 0} user rows / ${info?.rewindButtons ?? 0} buttons`,
    );
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // ---------- B. 挑一个「候选可达」的空闲会话（Esc 不能在本 agent 会话里按） ----------
    // 只看「有没有渲染出来的用户消息」不够：会话可能因为压缩遮蔽、或之前已回溯过，
    // 候选列表是空的。所以逐个会话按一次 Esc 数候选，取候选 ≥2 的那个。
    const originalSession = await cdp.evaluate(`(() => {
      const root = document.querySelector("[data-conversation-session]");
      return root ? root.getAttribute("data-conversation-session") : null;
    })()`);
    // 只挑**空闲**会话：Esc Esc 在内置语义里是「停止当前回合」，如果挑到正在跑的会话
    // （包括正在调用本脚本的 agent 会话），会把那一轮取消掉。
    const sidebarWorkspace =
      typeof values["sidebar-workspace"] === "string" ? values["sidebar-workspace"] : null;
    const sessionIds = await cdp.evaluate(`(() => {
      const title = ${JSON.stringify(sidebarWorkspace)};
      let scope = null;
      if (title) {
        const wsRow = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find((r) => (r.textContent || "").includes(title));
        if (!wsRow) return { status: "no-workspace" };
        scope = wsRow.parentElement && wsRow.parentElement.parentElement;
        if (!scope) return { status: "no-section" };
      }
      const rows = [...(scope || document).querySelectorAll('[data-row-key^="session:"]')];
      const ids = rows
        .filter((row) => !(row.textContent || "").includes("进行中"))
        .map((row) => (row.getAttribute("data-row-key") || "").replace("session:", ""));
      return { status: "ok", ids };
    })()`);
    /** @param {string} id */
    const switchTo = async (id) => {
      await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(id)} + '"]');
        if (row) row.click();
      })()`);
      await sleep(900);
    };
    /** 打开候选框并返回候选行，然后取消。 */
    const probeCandidates = async () => {
      await cdp.evaluate(
        `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); })()`,
      );
      await sleep(150);
      await pressEscape(cdp, "Escape", 53);
      await sleep(120);
      await pressEscape(cdp, "Escape", 53);
      await sleep(800);
      const dialog = await dialogInfo(cdp);
      const rows = dialog && Array.isArray(dialog.rows) ? dialog.rows.length : 0;
      if (dialog) {
        await clickDialogButton(cdp, ["取消", "Cancel"]);
        await sleep(350);
      }
      return rows;
    };
    /** @type {string | null} */
    let idleSession = null;
    /** @type {string[]} */
    const probeLog = [];
    check(
      sidebarWorkspace === null
        ? "未限定侧栏工作区（会遍历全部会话）"
        : `会话遍历限定在工作区「${sidebarWorkspace}」`,
      sidebarWorkspace === null || sessionIds?.status === "ok",
      sidebarWorkspace === null
        ? "提示：建议加 --sidebar-workspace 避免碰到其它工作区的会话"
        : JSON.stringify(sessionIds?.status),
    );
    for (const id of Array.isArray(sessionIds?.ids) ? sessionIds.ids : []) {
      if (id === originalSession) continue;
      await switchTo(id);
      const users = await cdp.evaluate(
        `document.querySelectorAll('[data-chat-flow-kind="user"]').length`,
      );
      if (users === 0) {
        probeLog.push(`${id.slice(8, 16)}:0users`);
        continue;
      }
      const candidates = await probeCandidates();
      probeLog.push(`${id.slice(8, 16)}:${candidates}`);
      // 只需要 ≥1 条候选：Esc 流程本身只要求能列出并选中一条。
      if (candidates >= 1) {
        idleSession = id;
        break;
      }
    }
    check(
      "找到一个候选可达（≥1 条）的空闲会话用于 Esc 流程",
      idleSession !== null,
      probeLog.join(" ") || "侧栏里没有第二个会话",
    );
    if (idleSession !== null) {
      await switchTo(idleSession);
      const rowButtons = await cdp.evaluate(`(() => {
        const users = [...document.querySelectorAll('[data-chat-flow-kind="user"]')];
        const withButton = users.filter((row) => [...row.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") || "").includes("回退到此处")));
        return { users: users.length, withButton: withButton.length };
      })()`);
      check(
        "每条用户消息旁都有 ↶ 按钮",
        rowButtons.users > 0 && rowButtons.withButton === rowButtons.users,
        JSON.stringify(rowButtons),
      );
    }

    // ---------- B2. --recall：输入框 ↑/↓ 历史召回（真实 Electron 渲染进程按键） ----------
    // 需要一个「至少有 2 条可召回消息」的会话：section B 只要求 ≥1 条候选，
    // 而召回要验证「再按 ↑ 往前翻一条」，1 条历史翻不出差异。
    /** @type {string | null} */
    let recallSession = null;
    if (values.recall === true) {
      /** 草稿文本（Lexical 空段落 textContent 是空串，innerText 是 "\n"）。 */
      const recallDraft = () =>
        cdp.evaluate(`(() => {
          const el = document.querySelector("[data-composer-input]");
          return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : null;
        })()`);
      /** 当前会话里每条用户消息的文本（用于核对召回的是真消息）。 */
      const recallRows = () =>
        cdp.evaluate(
          `(() => [...document.querySelectorAll('[data-chat-flow-kind="user"]')].map((row) => (row.textContent || "").replace(/\\s+/g, " ").trim()))()`,
        );
      const recallFocus = () =>
        cdp.evaluate(
          `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); return !!el; })()`,
        );
      /** @param {string} key @param {string} code @param {number} keyCode @param {number} nativeCode */
      const recallPress = async (key, code, keyCode, nativeCode) => {
        for (const type of ["keyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", {
            type,
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: nativeCode,
          });
        }
      };
      const recallUp = () => recallPress("ArrowUp", "ArrowUp", 38, 126);
      const recallDown = () => recallPress("ArrowDown", "ArrowDown", 40, 125);

      // 优先挑 ≥2 条的会话（能验证「继续往前翻」）；只有 1 条也照测，但那条断言退化为
      // 「停在最旧一条、内容不变」——新装 profile 里常常只有一条历史。
      /** @type {string | null} */
      let recallFallback = null;
      let recallHasOlder = false;
      for (const id of Array.isArray(sessionIds?.ids) ? sessionIds.ids : []) {
        if (id === originalSession) continue;
        await switchTo(id);
        /** @type {string[]} */
        const probeRows = await recallRows();
        const usable = probeRows.filter((/** @type {string} */ text) => text !== "").length;
        if (usable >= 2) {
          recallSession = id;
          recallHasOlder = true;
          break;
        }
        if (usable === 1 && recallFallback === null) recallFallback = id;
      }
      if (recallSession === null && recallFallback !== null) {
        recallSession = recallFallback;
        await switchTo(recallFallback);
      }
      check(
        "召回：找到一个可召回的会话（空闲、有用户消息）",
        recallSession !== null,
        recallSession
          ? `${recallSession.slice(0, 16)}${recallHasOlder ? "（≥2 条，可验证往前翻）" : "（仅 1 条，部分断言退化）"}`
          : "侧栏里没有第二个带用户消息的空闲会话",
      );

      const focused = await recallFocus();
      await sleep(250);
      const startingDraft = await recallDraft();
      /** @type {string[]} */
      const startingRows = await recallRows();
      check(
        "召回：输入框已聚焦且草稿为空",
        focused === true && startingDraft === "",
        JSON.stringify({ focused, draft: startingDraft }),
      );

      await recallUp();
      await sleep(500);
      /** @type {string | null} */
      const newest = await recallDraft();
      check(
        "空草稿按 ↑ 召回最新一条用户输入（桌面版按键路径）",
        typeof newest === "string" && newest !== "" && newest !== startingDraft,
        JSON.stringify({ draft: (newest || "").slice(0, 60) }),
      );
      check(
        "召回的文本确实来自会话里的某条用户消息",
        typeof newest === "string" && newest !== ""
          ? startingRows.some((/** @type {string} */ row) =>
              row.includes(newest.slice(0, Math.min(24, newest.length))),
            )
          : false,
        JSON.stringify({ rows: startingRows.length }),
      );

      await recallUp();
      await sleep(400);
      /** @type {string | null} */
      const older = await recallDraft();
      if (recallHasOlder) {
        check(
          "再按 ↑ 继续往前翻一条（内容变化）",
          typeof older === "string" && older !== "" && older !== newest,
          JSON.stringify({ from: (newest || "").slice(0, 30), to: (older || "").slice(0, 30) }),
        );
      } else {
        check(
          "只有一条历史时，再按 ↑ 停在最旧一条（不环绕、不清空）",
          typeof older === "string" && older !== "" && older === newest,
          JSON.stringify({ draft: (older || "").slice(0, 30) }),
        );
      }

      await recallDown();
      await sleep(300);
      await recallDown();
      await sleep(400);
      const restored = await recallDraft();
      check("↓↓ 走回正在编辑的那一行，草稿恢复为空", restored === "", JSON.stringify(restored));

      /** @type {string[]} */
      const afterRows = await recallRows();
      const afterDialog = await dialogInfo(cdp);
      check(
        "召回全程非破坏：对话行数不变、没有弹出回溯框",
        afterRows.length === startingRows.length && afterDialog === null,
        JSON.stringify({ before: startingRows.length, after: afterRows.length }),
      );
      await cdp.evaluate(
        `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); })()`,
      );
      await sleep(120);
    }

    // ---------- C. Esc Esc → 候选列表 → 搜索 ----------
    /** @type {any} */
    let candidates = null;
    /** 把焦点放回输入框。 */
    const focusComposer = () =>
      cdp.evaluate(
        `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); return !!el; })()`,
      );
    /** 按一次 Esc Esc 并返回对话框信息（没有对话框时 null）。 */
    const fireDoubleEscape = async () => {
      await focusComposer();
      await sleep(200);
      await pressEscape(cdp, "Escape", 53);
      await sleep(120);
      await pressEscape(cdp, "Escape", 53);
      await sleep(900);
      return dialogInfo(cdp);
    };
    if (idleSession !== null) {
      candidates = await fireDoubleEscape();
      // 重试一次：切换会话、取消上一个对话框之后，焦点/回合状态可能还没就绪
      // （实测偶发「第一次按不出、第二次就出来」）。只重试，不降低断言。
      if (candidates === null) {
        await switchTo(idleSession);
        await sleep(300);
        candidates = await fireDoubleEscape();
      }
    }
    check(
      "Esc Esc 打开候选列表",
      candidates !== null,
      candidates
        ? candidates.title
        : `没有对话框（session=${String(idleSession).slice(0, 20)}，userRows=${await cdp.evaluate(`document.querySelectorAll('[data-chat-flow-kind="user"]').length`)}）`,
    );
    check("候选列表可搜索", candidates?.hasSearch === true, "");
    const needle = candidates && candidates.rows.length > 0 ? candidates.rows[0].slice(0, 2) : "";
    if (needle !== "") {
      await cdp.evaluate(`(() => {
        const input = document.querySelector('.dsh-srw-dialog input[type="search"], [class*="dsh-srw"] input[type="search"]');
        if (!input) return;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setValue.call(input, ${JSON.stringify(needle)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await sleep(900);
      const filteredRows = await cdp.evaluate(`document.querySelectorAll(".dsh-srw-row").length`);
      check("候选搜索过滤生效", filteredRows > 0, `needle=${needle}, rows=${filteredRows}`);
      await cdp.screenshot(join(SHOTS, "02-candidates.png"));
    } else {
      check("候选搜索过滤生效", false, "候选列表为空");
    }

    // ---------- D. 选候选 → 确认框（只看不执行）→ 取消 ----------
    const picked = await cdp.evaluate(`(() => {
      const dlg = ${DIALOG};
      if (!dlg) return false;
      const row = dlg.querySelector(".dsh-srw-row");
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await sleep(1600);
    const confirm = await dialogInfo(cdp);
    check(
      "选择候选后进入确认框",
      picked && confirm !== null,
      confirm ? confirm.title : "没有确认框",
    );
    // B1：新文案是「将截断 N 条上下文记录（撤回 M 条用户/助手消息）」；同时接受旧口径。
    check(
      "确认框写明影响面与预览（截断记录 / 撤回消息）",
      typeof confirm?.text === "string" && /将截断|将撤回|truncates|withdraws/iu.test(confirm.text),
      (confirm?.text ?? "").slice(0, 160),
    );
    check(
      "确认框有「仅对话 / 对话+文件」两个范围",
      Array.isArray(confirm?.radios) &&
        confirm.radios.includes("chat") &&
        confirm.radios.includes("both"),
      JSON.stringify(confirm?.radios ?? null),
    );
    check(
      "确认框有「回退后立即重发」且默认不勾选",
      confirm?.resend?.present === true && confirm.resend.checked === false,
      JSON.stringify(confirm?.resend ?? null),
    );
    // AUD-REW-06 / ADR 0002：破坏性确认框必须写清「能否恢复」。
    // B1：默认 chat 模式只有基础行；both（且有 tracked 文件）才追加救援点/回收站。
    const dialogBothSelected = await cdp.evaluate(`(() => {
      const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
      return radio ? radio.checked : false;
    })()`);
    const recoverableHasFileLine =
      typeof confirm?.recoverable === "string" &&
      /救援点|rescue|回收站|trash/iu.test(confirm.recoverable);
    check(
      "确认框写明「撤回不可撤销、内容留在已撤回页签」（可恢复性基础行）",
      typeof confirm?.recoverable === "string" && /撤回|withdrawn/iu.test(confirm.recoverable),
      (confirm?.recoverable ?? "").slice(0, 240),
    );
    check(
      "可恢复性文案按模式分档（chat 不出现文件救援点 / both 必含）",
      dialogBothSelected === true ? recoverableHasFileLine : !recoverableHasFileLine,
      JSON.stringify({ dialogBothSelected, recoverable: confirm?.recoverable }),
    );
    // AUD-REW-07：主按钮默认聚焦，且焦点陷阱生效。
    check(
      "确认框默认聚焦主按钮（data-modal-autofocus）",
      confirm?.autofocus?.primary === true &&
        confirm.autofocus.focused === true &&
        confirm.focusInDialog === true,
      JSON.stringify(confirm?.autofocus ?? null),
    );
    await cdp.evaluate(`(() => {
      const dlg = ${DIALOG};
      if (!dlg) return;
      const nodes = [...dlg.querySelectorAll('button:not([disabled]), input:not([disabled])')];
      const last = nodes[nodes.length - 1];
      if (last && typeof last.focus === "function") last.focus();
    })()`);
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
    }
    await sleep(200);
    const tabTrap = await cdp.evaluate(`(() => {
      const dlg = ${DIALOG};
      if (!dlg) return null;
      return {
        inside: dlg.contains(document.activeElement),
        active: (document.activeElement && document.activeElement.textContent || "").trim(),
      };
    })()`);
    check("确认框 Tab 不穿透（焦点在框内环绕）", tabTrap?.inside === true, JSON.stringify(tabTrap));
    check(
      "确认框写明文件追踪范围（write/edit/apply_patch；bash/子代理不追踪）",
      typeof confirm?.trackingScope === "string" &&
        /write/iu.test(confirm.trackingScope) &&
        /apply_patch|edit|编辑/iu.test(confirm.trackingScope),
      (confirm?.trackingScope ?? "").slice(0, 240),
    );
    // 主按钮的底色与文字必须成对翻转：--dsw-alias-brand-primary 是「反色表面色」
    // （浅色 #0f1115、深色 #f9fafb），0.6.1 把它和死白 #fff 配在一起，深色主题下确认按钮
    // 变成白底白字（1.05:1），肉眼看不到文字。这里在**真实渲染进程**里按 WCAG 算一次对比度。
    const primaryContrast = await cdp.evaluate(`(() => {
      const dlg = ${DIALOG};
      const btn = dlg && dlg.querySelector(".dsh-srw-btn-primary");
      if (!btn) return null;
      const parse = (value) => {
        const nums = String(value || "").match(/[\\d.]+/g);
        return nums ? nums.slice(0, 4).map(Number) : null;
      };
      const style = getComputedStyle(btn);
      const background = parse(style.backgroundColor);
      const foreground = parse(style.color);
      if (!background || !foreground || background.length < 3 || foreground.length < 3) return null;
      const panel = parse(getComputedStyle(dlg).backgroundColor);
      const opaque = (rgb) => {
        const alpha = rgb.length === 4 ? rgb[3] : 1;
        if (alpha >= 1 || !panel) return rgb.slice(0, 3);
        return [0, 1, 2].map((i) => Math.round(rgb[i] * alpha + panel[i] * (1 - alpha)));
      };
      const luminance = (rgb) => {
        const [r, g, b] = rgb.map((raw) => {
          const c = raw / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fill = luminance(opaque(background));
      const text = luminance(foreground.slice(0, 3));
      const ratio = (Math.max(fill, text) + 0.05) / (Math.min(fill, text) + 0.05);
      return {
        ratio: Math.round(ratio * 100) / 100,
        color: style.color,
        background: style.backgroundColor,
        label: (btn.textContent || "").trim(),
      };
    })()`);
    check(
      "确认按钮文字与底色对比度 ≥ 4.5:1（深色主题曾为 1.05:1）",
      typeof primaryContrast?.ratio === "number" && primaryContrast.ratio >= 4.5,
      primaryContrast
        ? `${primaryContrast.ratio}:1 — "${primaryContrast.label}" ${primaryContrast.color} on ${primaryContrast.background}`
        : "确认框里没有 .dsh-srw-btn-primary",
    );
    await cdp.screenshot(join(SHOTS, "02b-confirm.png"));
    // 从候选列表进的确认框，取消会**退回候选列表**（方便换一条），不是直接关闭——
    // 这是设计而非 bug，所以先断言这一步，再关掉列表。
    const cancelled = await clickDialogButton(cdp, ["取消", "Cancel"]);
    await sleep(700);
    const afterCancel = await dialogInfo(cdp);
    check(
      "确认框取消后退回候选列表（不执行回退）",
      cancelled &&
        afterCancel !== null &&
        Array.isArray(afterCancel.rows) &&
        afterCancel.rows.length > 0 &&
        Array.isArray(afterCancel.radios) &&
        afterCancel.radios.length === 0,
      afterCancel
        ? JSON.stringify({ rows: afterCancel.rows.length, radios: afterCancel.radios.length })
        : "对话框直接关闭了",
    );
    await clickDialogButton(cdp, ["取消", "Cancel"]);
    await sleep(600);
    const closed = await dialogInfo(cdp);
    check("再取消后对话框关闭且未回溯", closed === null, closed ? "对话框仍在" : "");

    // ---------- E. 回溯面板三页签（设置已迁到独立设置分节） ----------
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
      if (btn) btn.click();
    })()`);
    await sleep(1000);
    const drawer = await drawerInfo(cdp);
    check(
      "回溯面板打开且三页签齐全",
      drawer !== null &&
        ["已撤回", "回溯记录", "救援点"].every((tab) => drawer.tabs.includes(tab)) &&
        !drawer.tabs.includes("设置"),
      JSON.stringify(drawer?.tabs ?? null),
    );
    await cdp.screenshot(join(SHOTS, "03-panel.png"));

    await openDrawerTab(cdp, "回溯记录");
    await sleep(1000);
    const timeline = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-timeline");
      if (!root) return null;
      return {
        nodes: root.querySelectorAll(".dsh-srw-tl-node").length,
        dots: root.querySelectorAll(".dsh-srw-tl-dot").length,
      };
    })()`);
    check(
      "回溯记录渲染为时间线（节点数 === 圆点数）",
      timeline === null || (timeline.nodes >= 1 && timeline.dots === timeline.nodes),
      JSON.stringify(timeline),
    );

    await openDrawerTab(cdp, "救援点");
    await sleep(900);
    const rescuesText = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      return root ? (root.textContent || "").replace(/\\s+/g, " ") : "";
    })()`);
    check("救援点页签可渲染", /救援点|rescue/iu.test(rescuesText), rescuesText.slice(0, 120));
    const trashSection = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      const section = root ? root.querySelector("[data-srw-trash]") : null;
      return { present: !!section, text: section ? (section.textContent || "").replace(/\\s+/g, " ") : "" };
    })()`);
    check(
      "救援点页签里有回收站入口（可恢复/可清空，AUD-REW-08）",
      trashSection?.present === true && /回收站|Trash/iu.test(trashSection.text ?? ""),
      JSON.stringify(trashSection).slice(0, 200),
    );
    check(
      "回溯面板提供「选择消息回退」入口（USIM-U2-10）",
      drawer?.hintPresent === true && drawer.hasPickMessage === true,
      JSON.stringify({ hint: drawer?.hintPresent, pick: drawer?.hasPickMessage }),
    );
    const pickClicked = await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      const btn = root ? [...root.querySelectorAll("button")].find((b) => /选择消息回退|Pick a message/iu.test((b.textContent || "").trim())) : null;
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(1200);
    const pickDialog = await dialogInfo(cdp);
    check(
      "「选择消息回退」关闭面板并打开候选对话框",
      pickClicked === true &&
        pickDialog !== null &&
        /回溯|Rewind/iu.test(pickDialog.title ?? "") &&
        Array.isArray(pickDialog.rows),
      pickDialog?.title ?? "no dialog",
    );
    if (pickDialog !== null) {
      await clickDialogButton(cdp, ["取消", "Cancel"]);
      await sleep(500);
    }

    // ---------- F. 设置 → 会话回溯 分节（偏好 + 诊断） ----------
    // 设置原来在抽屉里，现在独立成设置分节；这里只读地打开它并读诊断文本。
    const settings = await cdp.evaluate(`(async () => {
      const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const opener = '[data-shortcut-modal="settings"]';
      const isOpen = () => Boolean(document.querySelector(opener));
      // 装了账号插件时，侧栏底部的设置入口会换成「账号菜单」按钮，菜单里才有「设置」。
      for (const needle of ["设置", "Settings"]) {
        if (isOpen()) break;
        const btn = [...document.querySelectorAll("button")].find(
          (b) => (b.getAttribute("aria-label") || "") === needle,
        );
        if (!btn) continue;
        btn.click();
        await sleepMs(800);
      }
      if (!isOpen()) {
        const account = [...document.querySelectorAll("button")].find(
          (b) => (b.getAttribute("aria-label") || "") === "账号菜单",
        );
        if (account) {
          account.click();
          await sleepMs(600);
          const item = [...document.querySelectorAll('[role="menu"] button, [role="menuitem"]')].find(
            (el) => (el.textContent || "").trim().startsWith("设置"),
          );
          if (item) {
            item.click();
            await sleepMs(900);
          }
        }
      }
      if (!isOpen()) return { status: "no-settings-panel" };
      const shell = document.querySelector(opener);
      const nav = [...shell.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim() === "会话回溯",
      );
      if (!nav) return { status: "no-section-nav" };
      nav.click();
      await sleepMs(1600);
      const section = document.querySelector("[data-srw-settings]");
      if (!section) return { status: "no-section-body" };
      const refresh = [...section.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim() === "刷新",
      );
      if (refresh) refresh.click();
      await sleepMs(1500);
      return { status: "ok", text: (section.textContent || "").replace(/\\s+/g, " ") };
    })()`);
    check(
      "设置页出现「会话回溯」分节",
      settings?.status === "ok",
      JSON.stringify(settings ?? null).slice(0, 300),
    );
    check(
      "设置分节包含偏好与诊断",
      settings?.status === "ok" &&
        settings.text.includes("默认回退范围") &&
        settings.text.includes("诊断"),
      (settings?.text ?? "").slice(0, 220),
    );
    const moreSettings = await cdp.evaluate(`(() => {
      const details = document.querySelector("[data-srw-settings] details[data-srw-more-settings]");
      if (!details) return null;
      const summary = details.querySelector("summary");
      const before = { open: details.open === true, summary: (summary?.textContent || "").trim() };
      if (summary) summary.click();
      return { ...before, expanded: details.open === true };
    })()`);
    check(
      "低频设置与诊断收进「更多设置」且默认收起（AUD-REW-17）",
      moreSettings?.open === false && /更多设置|More settings/iu.test(moreSettings.summary ?? ""),
      JSON.stringify(moreSettings),
    );
    await sleep(300);
    check(
      "「更多设置」可以展开（里面是每页数量/列表确认/诊断）",
      moreSettings?.expanded === true,
      JSON.stringify(moreSettings),
    );
    check(
      "诊断报告只读工具已注册（诊断文案已本地化）",
      settings?.status === "ok" &&
        /只读工具/u.test(settings.text) &&
        /已启用|已关闭|enabled|disabled/u.test(settings.text),
      (settings?.text ?? "").slice(0, 400),
    );
    check(
      "诊断报告孤儿数据检查",
      /孤儿数据/u.test(settings?.text ?? ""),
      (settings?.text ?? "").slice(0, 400),
    );
    await cdp.screenshot(join(SHOTS, "04-settings.png"));
    // 关掉设置面板，后面的收尾断言依赖抽屉/会话视图。
    await cdp.evaluate(`(() => {
      const panel = document.querySelector('[data-shortcut-modal="settings"]');
      const close = panel ? [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
      if (close) close.click();
    })()`);
    await sleep(600);

    // ---------- G. 收尾：关闭面板，切回原会话 ----------
    await cdp.evaluate(`(() => {
      const root = document.querySelector(".dsh-srw-drawer");
      const btn = root ? [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
      if (btn) btn.click();
    })()`);
    await sleep(500);
    check("面板可关闭", (await drawerInfo(cdp)) === null, "");
    if (originalSession !== null) {
      await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(originalSession)} + '"]');
        if (row) row.click();
      })()`);
      await sleep(800);
    }

    // ---------- H. --deep：文件模式端到端（新建会话 → 写文件 → 回溯 → 还原） ----------
    // 前置由脚本自己建立，不依赖调用者先手工开好会话、也不依赖上一段「切回原会话」：
    //   1) `--workspace` 必须是**已注册成桌面工作区**的专用目录。这是唯一的人工前置
    //      （桌面「工作区 → 添加工作区」选一次），脚本只读侧栏、不写宿主注册表；
    //   2) 在那个工作区的分组里点「新建会话」（幂等：桌面上已有多少会话、停在哪个会话都不影响，
    //      每次都得到一个绑定该工作区的空白会话）；
    //   3) 模型只被告知**绝对路径**，文件断言轮询文件系统，不依赖模型回复文案。
    // macOS 的 /tmp 是 /private/tmp 的软链：宿主按**真实路径**绑定会话 cwd，用软链路径注册
    // 工作区会让「新建会话」建成功、附不上去（界面报「无法附到工作区」），所以路径一律先 realpath。
    if (values.deep === true) {
      const fileName = "rewind-desktop-smoke.txt";
      const workspaceArg = typeof values.workspace === "string" ? values.workspace : "";
      let repoReal = process.cwd();
      try {
        repoReal = await realpath(process.cwd());
      } catch {
        /* 保留原样 */
      }
      let workspaceReal = "";
      let workspaceOk = false;
      let workspaceDetail = "缺少 --workspace（需要已注册成桌面工作区的专用目录）";
      if (workspaceArg !== "") {
        try {
          const info = await stat(workspaceArg);
          workspaceReal = await realpath(workspaceArg);
          const insideRepo = workspaceReal === repoReal || workspaceReal.startsWith(`${repoReal}/`);
          workspaceOk = info.isDirectory() && !insideRepo;
          workspaceDetail = workspaceOk ? workspaceReal : `不是目录，或位于仓库内（${repoReal}）`;
        } catch {
          workspaceReal = "";
          workspaceDetail = `目录不存在：${workspaceArg}`;
        }
      }
      check("--deep 提供了可用的专用测试工作区（按真实路径）", workspaceOk, workspaceDetail);

      if (workspaceOk) {
        const customTitle =
          typeof values["sidebar-workspace"] === "string" ? values["sidebar-workspace"].trim() : "";
        const workspaceTitle = customTitle === "" ? basename(workspaceReal) : customTitle;
        const filePath = join(workspaceReal, fileName);
        // 幂等起点：上次崩溃留下的同名文件会让「新建」变成「覆盖」，语义不同。
        await rm(filePath, { force: true }).catch(() => {});
        check("测试文件在开始前不存在（保证是新建语义）", !(await exists(filePath)), filePath);

        // 工作区必须是宿主**注册过**的：会话 cwd 来自工作区而 screen 上的工作区选择器，
        // 不是来自 prompt。缺了它「在 X 中新建会话」按钮根本不存在（旧版脚本会以 no-button
        // 静默失败，然后模型在别的会话里跑，文件永远不出现）。
        const workspaceRow = await waitForWorkspaceRow(cdp, workspaceTitle, 15000);
        check(
          `专用工作区「${workspaceTitle}」已注册为桌面工作区（侧栏可见）`,
          workspaceRow.found,
          workspaceRow.found
            ? ""
            : `${workspaceRow.detail}；先在桌面「工作区 → 添加工作区」选择 ${workspaceReal}（一次性），` +
                "或用 --sidebar-workspace 指定工作区标题",
        );

        if (workspaceRow.found) {
          const previousSession = await cdp.evaluate(`(() => {
            const root = document.querySelector("[data-conversation-session]");
            return root ? root.getAttribute("data-conversation-session") : null;
          })()`);
          /** 点侧栏工作区行上的「新建会话」（aria-label 里带工作区标题）。 */
          const openNewSession = () =>
            cdp.evaluate(`(() => {
              const title = ${JSON.stringify(workspaceTitle)};
              const btn = [...document.querySelectorAll("button")].find((b) => {
                const label = b.getAttribute("aria-label") || "";
                return label.includes(title) && /新建会话|New session/u.test(label);
              });
              if (!btn) return "no-button";
              btn.click();
              return "clicked";
            })()`);
          let opened = await openNewSession();
          let fresh = await waitForFreshSession(cdp, previousSession, 25000);
          if (!fresh.ok && opened === "clicked") {
            // 慢机器上第一次点击可能落在分组展开动画里；重试一次仍要求同样的终态。
            await sleep(1200);
            opened = await openNewSession();
            fresh = await waitForFreshSession(cdp, previousSession, 25000);
          }
          check(
            "在测试工作区里打开一个新会话（H 段的前置）",
            fresh.ok,
            JSON.stringify({ opened, ...fresh.detail }).slice(0, 420),
          );
          await cdp.screenshot(join(SHOTS, "03-deep-fresh-session.png"));
          check(
            "新会话的输入框可编辑（空白会话）",
            fresh.detail?.editable === true && fresh.detail?.userRows === 0,
            JSON.stringify({ editable: fresh.detail?.editable, userRows: fresh.detail?.userRows }),
          );
          // cwd 绑定证明：输入框下方的工作区选择器显示的就是这个工作区。
          check(
            "新会话绑定到专用工作区（工作区选择器显示该工作区）",
            typeof fresh.detail?.workspace === "string" &&
              fresh.detail.workspace.includes(workspaceTitle),
            JSON.stringify(fresh.detail?.workspace ?? ""),
          );

          if (fresh.ok) {
            // ---- 1) 新建文件（write create） ----
            const content = `hello-rewind-desktop-${Date.now()}`;
            const createPrompt =
              `只做一件事：用 write 工具在目录 ${workspaceReal} 下创建文件 ${fileName}，内容为 ${content}。` +
              "不要用 bash，不要做其他操作；这是本轮唯一任务。完成后只回复一句简短确认。";
            const createRun = await runPrompt(cdp, createPrompt, 300000);
            check(
              "发送「创建测试文件」的请求",
              createRun.typed && createRun.sent,
              JSON.stringify({
                cleared: createRun.cleared,
                typed: createRun.typed,
                sent: createRun.sent,
              }),
            );
            const created = await waitForFileState(filePath, content, 120000);
            const createTools = createRun.tools.map((card) => `${card.tool}:${card.state}`);
            check(
              "agent 确实用 write 创建了测试文件",
              createRun.finished &&
                created &&
                createRun.tools.some((card) => card.tool === "write"),
              JSON.stringify({ finished: createRun.finished, created, tools: createTools }).slice(
                0,
                420,
              ),
            );
            await cdp.screenshot(join(SHOTS, "04-deep-file-created.png"));

            // ---- 2) 回溯（对话+文件）：文件进回收站、输入框回填 ----
            const rewound = await openRewindDialog(cdp);
            // 影响面是异步算的：点开时正文可能还是「正在计算影响面…」，要等文件动作出现。
            const deepPreview = await waitForDialogText(
              cdp,
              "将还原|还原 \\d|移入回收站|Restore",
              15000,
            );
            const bothReady = await waitForBothRadio(cdp, 10000);
            check(
              "文件模式在确认框里可用（有文件变更）",
              rewound === "clicked" && bothReady,
              JSON.stringify({ rewound, bothReady }),
            );
            check(
              "确认框预览写明文件动作",
              rewound === "clicked" && deepPreview.matched,
              (deepPreview.text ?? "").slice(0, 240),
            );

            // 选「对话+文件」并执行
            await cdp.evaluate(`(() => {
              const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
              if (radio && !radio.disabled) radio.click();
            })()`);
            await sleep(500);
            // B1 的另一半：切到 both 后，可恢复性文案才追加「救援点/回收站」。
            const bothModeRecoverable = await cdp.evaluate(`(() => {
              const el = document.querySelector('.dsh-srw-dialog [data-rewind-recoverable]');
              return el ? (el.textContent || '').trim() : '';
            })()`);
            check(
              "both 模式的可恢复性文案包含救援点/回收站",
              /救援点|rescue|回收站|trash/iu.test(bothModeRecoverable),
              bothModeRecoverable.slice(0, 240),
            );
            const confirmed = await clickDialogButton(cdp, ["开始回退", "Rewind"]);
            let dialogGone = false;
            for (let i = 0; i < 60; i += 1) {
              await sleep(300);
              if ((await dialogInfo(cdp)) === null) {
                dialogGone = true;
                break;
              }
            }
            check(
              "确认后对话框关闭",
              confirmed && dialogGone,
              JSON.stringify({ confirmed, dialogGone }),
            );
            const movedToTrash = await waitForFileState(filePath, null, 20000);
            check(
              "文件被移入插件回收站（工作区里已不存在）",
              movedToTrash,
              movedToTrash ? "" : "文件仍在工作区",
            );
            const toast = await waitForToast(cdp, 8000);
            check(
              "toast 报告撤回与文件结果",
              /回退|Rewound/u.test(toast) && /回收站|trash/u.test(toast),
              toast.slice(0, 200),
            );
            let refilled = "";
            for (let i = 0; i < 30; i += 1) {
              refilled = (await composerText(cdp)) ?? "";
              if (refilled.trim() !== "" && refilled.includes(fileName)) break;
              await sleep(300);
            }
            check(
              "输入框回填被撤回的消息文本",
              refilled.trim() !== "" && refilled.includes(fileName),
              refilled.slice(0, 120),
            );
            // 清掉回填的草稿（下一轮 prompt 自己也会清，这里清是为了面板操作时输入框是空的）。
            await clearComposer(cdp);

            // ---- 3) 救援点恢复：面板 → 救援点 → 恢复 ----
            await openDrawer(cdp);
            await sleep(600);
            await openDrawerTab(cdp, "救援点");
            await sleep(600);
            const restoreClicked = await clickDrawerButton(cdp, "恢复这些文件|Restore", 12000);
            let restoredOk = await waitForFileState(filePath, content, 25000);
            let restoreConfirmed = "";
            if (!restoredOk) {
              restoreConfirmed = await clickDrawerButton(cdp, "恢复这些文件|Restore", 8000);
              restoredOk = await waitForFileState(filePath, content, 40000);
            }
            // 抽屉铺满窗口、会吃掉输入框的点击：后面还要发 prompt，先关掉。
            const drawerClosed = await closeDrawer(cdp);
            check(
              "从救援点恢复后文件内容回到工作区",
              (restoreClicked === "clicked" || restoreConfirmed === "clicked") &&
                restoredOk &&
                drawerClosed,
              JSON.stringify({
                restoreClicked,
                restoreConfirmed,
                restored: restoredOk,
                drawerClosed,
              }),
            );
            await cdp.screenshot(join(SHOTS, "05-deep-restored.png"));

            // ---- 4) 修改还原：覆盖已有文件 → 回退 → 内容回到覆盖前 ----
            const rewriteContent = `rewritten-${Date.now()}`;
            const rewriteRun = await runPrompt(
              cdp,
              `只做一件事：用 write 工具把文件 ${filePath} 的内容覆盖为 ${rewriteContent}。` +
                "不要用 bash，不要做其他操作；这是本轮唯一任务。",
              300000,
            );
            const rewrittenOk = await waitForFileState(filePath, rewriteContent, 120000);
            const rewriteTools = rewriteRun.tools.map((card) => card.tool);
            check(
              "修改还原：agent 覆盖了已存在的文件",
              rewriteRun.finished && rewrittenOk && rewriteTools.includes("write"),
              JSON.stringify({
                cleared: rewriteRun.cleared,
                typed: rewriteRun.typed,
                sent: rewriteRun.sent,
                finished: rewriteRun.finished,
                overwritten: rewrittenOk,
                tools: rewriteTools,
              }).slice(0, 360),
            );
            const modifyOpened = await openRewindDialog(cdp);
            const modifyBothReady = await waitForBothRadio(cdp, 10000);
            const modifyPreview = await waitForDialogText(cdp, "将还原|还原 \\d|Restore", 15000);
            check(
              "修改还原：确认框预览可用且写明还原文件",
              modifyOpened === "clicked" && modifyBothReady && modifyPreview.matched,
              JSON.stringify({
                modifyOpened,
                modifyBothReady,
                text: (modifyPreview.text ?? "").slice(0, 160),
              }).slice(0, 320),
            );
            const modifyExecuted = await chooseBothAndConfirm(cdp);
            const modifyRestored = await waitForFileState(filePath, content, 60000);
            check(
              "修改还原：回退后内容回到覆盖前",
              modifyExecuted && modifyRestored,
              JSON.stringify({ modifyExecuted, restored: modifyRestored }),
            );

            // ---- 5) 删除文件 → 回退重建 ----
            // DSH 0.2.2-rc.5 的**所有** agent 预设在 preset 里把 tool-fs 的 `applyPatch` 设为
            // false（宿主源码 + `--dump-config` 双证据），桌面默认没有 apply_patch 工具；而插件
            // 只追踪 write/edit/apply_patch，所以「删除」在这个组合里无法由受追踪工具驱动。
            // 这里仍然发删除指令：宿主以后打开 applyPatch 时这段会真的跑；跑不起来就按**环境分支**
            // 记 SKIP（不改成假绿，也不把「宿主没这个工具」报成插件红）。
            const deletePrompt =
              `只做一件事：用 apply_patch 工具删除文件 ${filePath}。补丁形状如下（这是本轮唯一任务，不要用 bash）：\n` +
              `*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n完成后只回复一句简短确认。`;
            const deleteRun = await runPrompt(cdp, deletePrompt, 300000);
            const deleted = await waitForFileState(filePath, null, 60000);
            const deleteTools = deleteRun.tools.map((card) => `${card.tool}:${card.state}`);
            const usedApplyPatch = deleteRun.tools.some((card) => card.tool === "apply_patch");
            // N1：三种情形分开判（纯函数 + 单测锁住）——
            //   run ：调了 apply_patch 且文件消失 → 继续断言重建；
            //   fail：调了 apply_patch 但文件还在 → 真失败（不能记成宿主没这个工具）；
            //   skip：压根没调 apply_patch → 环境分支，理由从当轮工具卡推导。
            const deleteVerdict = deepDeleteVerdict({ usedApplyPatch, deleted });
            const deleteFacts = JSON.stringify({ deleted, tools: deleteTools }).slice(0, 360);
            if (deleteVerdict === "run") {
              await cdp.screenshot(join(SHOTS, "06-deep-deleted.png"));
              check("删除文件：agent 用 apply_patch 删除了测试文件", deleted, deleteFacts);
              const deleteOpened = await openRewindDialog(cdp);
              const deletePreview = await waitForDialogText(
                cdp,
                "重建|还原被删除|recreat|Restore",
                15000,
              );
              check(
                "删除文件：确认框预览写明会重建被删除的文件",
                deleteOpened === "clicked" && deletePreview.matched,
                (deletePreview.text ?? "").slice(0, 240),
              );
              const deleteExecuted = await chooseBothAndConfirm(cdp);
              const recreated = await waitForFileState(filePath, content, 60000);
              check(
                "删除文件：回退后文件被重建",
                deleteExecuted && recreated,
                JSON.stringify({ deleteExecuted, recreated }),
              );
            } else if (deleteVerdict === "fail") {
              // 工具调了却没删掉：这是真失败，不是宿主能力分支；后两条重建断言按前置失败记 FAIL。
              check("删除文件：agent 用 apply_patch 删除了测试文件", false, deleteFacts);
              const reason =
                `apply_patch 已调用但文件仍在（当轮工具卡：${deleteTools.join(",") || "无"}）；` +
                "后两条重建断言未执行（前置失败：删除没发生）";
              check("删除文件：确认框预览写明会重建被删除的文件", false, reason);
              check("删除文件：回退后文件被重建", false, reason);
            } else {
              // 环境分支：当轮根本没调 apply_patch（宿主预设没注册该工具，或模型改用 bash）。
              // 理由从工具卡推导，不写死具体版本/预设。
              const reason =
                `本轮未调用 apply_patch（当轮工具卡：${deleteTools.join(",") || "无"}；` +
                `文件${deleted ? "已被非受追踪工具删除" : "仍在"}）。` +
                "插件只追踪 write/edit/apply_patch，bash/脚本/子代理的删除不追踪；" +
                "apply_patch 是否注册由桌面 profile 的 agent 预设配置决定。";
              skip("删除文件：agent 用 apply_patch 删除了测试文件", reason);
              skip("删除文件：确认框预览写明会重建被删除的文件", reason);
              skip("删除文件：回退后文件被重建", reason);
              // 非受追踪删除（例如模型改用 bash）会把文件弄丢，补回来给后面的冲突场景当基线。
              if (deleted) await writeFile(filePath, content, "utf8").catch(() => {});
            }

            // ---- 6) 冲突拒绝：外部改动后文件模式整体禁用、一个字节都不写 ----
            const conflictBase = `conflict-base-${Date.now()}`;
            const conflictRun = await runPrompt(
              cdp,
              `只做一件事：用 write 工具把文件 ${filePath} 的内容覆盖为 ${conflictBase}。` +
                "不要用 bash，不要做其他操作；这是本轮唯一任务。",
              300000,
            );
            const conflictApplied = await waitForFileState(filePath, conflictBase, 120000);
            const externalContent = `external-change-${Date.now()}`;
            await writeFile(filePath, externalContent, "utf8");
            const conflictOpened = await openRewindDialog(cdp);
            const conflictPreview = await waitForDialogText(
              cdp,
              "冲突|conflict|不一致|differs",
              15000,
            );
            /** @type {boolean | null} */
            let conflictBothDisabled = null;
            for (let i = 0; i < 30; i += 1) {
              conflictBothDisabled = await cdp.evaluate(`(() => {
                const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
                return radio ? radio.disabled : null;
              })()`);
              if (conflictBothDisabled === true) break;
              await sleep(300);
            }
            check(
              "冲突拒绝：外部改动后文件模式被禁用并列出冲突",
              conflictOpened === "clicked" &&
                conflictRun.finished &&
                conflictApplied &&
                conflictPreview.matched &&
                conflictBothDisabled === true,
              JSON.stringify({
                finished: conflictRun.finished,
                applied: conflictApplied,
                conflictBothDisabled,
                text: (conflictPreview.text ?? "").slice(0, 200),
              }).slice(0, 460),
            );
            await clickDialogButton(cdp, ["取消", "Cancel"]);
            await sleep(700);
            let conflictFileBody = "";
            try {
              conflictFileBody = (await readFile(filePath, "utf8")).trim();
            } catch {
              conflictFileBody = "";
            }
            check(
              "冲突拒绝：拒绝后没有写文件（外部内容保持原样）",
              conflictFileBody === externalContent,
              JSON.stringify({ body: conflictFileBody.slice(0, 48) }),
            );
            await rm(filePath, { force: true }).catch(() => {});

            // ---- 7) 时间线里应出现「文件恢复」节点（救援点恢复留下的） ----
            await openDrawer(cdp);
            await sleep(400);
            await openDrawerTab(cdp, "回溯记录");
            let timelineKinds = null;
            for (let i = 0; i < 30; i += 1) {
              await sleep(400);
              timelineKinds = await cdp.evaluate(`(() => {
                const root = document.querySelector(".dsh-srw-timeline");
                return root ? [...root.querySelectorAll(".dsh-srw-tl-node")].map((n) => n.getAttribute("data-kind")) : null;
              })()`);
              if (Array.isArray(timelineKinds) && timelineKinds.includes("rescue-restore")) break;
            }
            check(
              "时间线里出现文件恢复节点",
              Array.isArray(timelineKinds) && timelineKinds.includes("rescue-restore"),
              JSON.stringify(timelineKinds),
            );
            await cdp.evaluate(`(() => {
              const root = document.querySelector(".dsh-srw-drawer");
              const btn = root ? [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭") : null;
              if (btn) btn.click();
            })()`);
            await sleep(400);
            await cdp.screenshot(join(SHOTS, "07-deep-final.png"));
            // 收尾：删掉测试文件，别把垃圾留在工作区。
            await rm(filePath, { force: true }).catch(() => {});
            check("测试文件已清理", !(await exists(filePath)), filePath);
            // 防回归：会话没绑定测试工作区时，模型的 write 会落到**脚本自身 cwd**（本仓库）里。
            // 那会在仓库根留下一个未跟踪的测试文件，并在断言里表现为「文件不存在」。
            check(
              "测试文件没有漏到仓库目录",
              !(await exists(join(process.cwd(), fileName))),
              join(process.cwd(), fileName),
            );
          }
        }
      }
    }
  } catch (error) {
    check("桌面回归执行", false, error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.ws.close();
  }

  let failed = 0;
  let skipped = 0;
  for (const item of checks) {
    const label = item.skipped === true ? "SKIP " : item.ok ? "PASS " : "FAIL ";
    const detail = item.detail === "" ? "" : ` :: ${item.detail}`;
    console.log(label + item.name + detail);
    if (item.skipped === true) skipped += 1;
    else if (!item.ok) failed += 1;
  }
  console.log(`截图目录：${SHOTS}`);
  if (failed > 0) {
    console.error(`FAIL ${failed} 项桌面回归断言失败`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS 全部 ${checks.length - skipped} 项桌面回归断言通过` +
        (skipped > 0 ? `（另有 ${skipped} 项按环境分支 SKIP，理由见上）` : ""),
    );
  }
  // 门禁靠这一行判定「跑过但一条断言都没执行」（见 docs/plugin-conventions.md §6.1）。
  console.log(`${checks.length - skipped - failed} PASS / ${skipped} SKIP / ${failed} FAIL`);
};

await main();
