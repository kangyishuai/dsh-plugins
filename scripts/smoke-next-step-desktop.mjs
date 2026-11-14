#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）回归：next-step。
// 硬性要求见 docs/plugin-conventions.md §6.1 —— 走真实 CDP 驱动**用户的桌面版**。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（默认只读）
//   pnpm smoke:next-step-desktop
//   # 发版门禁加 --require：连不上端口时**失败**而不是跳过（避免「没测也绿」）
//   pnpm smoke:next-step-desktop --require
//   # 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）
//   DSH_CDP_PORT=9333 pnpm smoke:next-step-desktop
//
// 默认**只读**：只切会话、展开/收起卡片的摘要、点卡片上的 ✕、按一次 Esc，
// **不发消息、不写文件、不装插件**，可以直接跑在真实 profile 上。
// 唯一会写会话数据的是「点 ✕」——它会往会话日志追加一条 `plugin:next-step/decision`
// （phase=dismissed），把那张卡变成只读态；这是只读回归允许的边界（与 session-rewind
// 的「只开对话框再 Esc」同级），不会删除任何内容。
//
// `--deep --workspace <专用测试目录>`：真正的破坏性端到端——在**该目录**里自己新建会话、
// 发一条真实模型请求、等回答结束、等决策卡出现，然后点胶囊验证「点击 = 发出一条用户消息」。
// 前置状态由脚本自己建立（新建会话 + 断言会话为空），不依赖前面段落「切回某个会话」：
// 侧栏行在折叠分组里时点击不生效，会静默跑在上一个会话上，而那个会话没有该工作区的权限。
//   必须显式给 `--workspace`，且它必须是已存在、且**不在本仓库内**的目录。
//
// ---------------------------------------------------------------------------
// 当前能力边界（**跑过 ≠ 全绿**，下一个人务必先读这段）
// ---------------------------------------------------------------------------
// 1. 无条件可断言（不要求插件已装、不要求有卡片）：
//    - 能连上 CDP、页面可交互；
//    - **投影健康**：页面上没有「历史加载失败 / failed to project / Cannot read properties」
//      ——投影一旦坏掉是「静默全灭」（消息能发、会话日志正常，只是历史加载失败、卡片永不渲染），
//      这条是唯一能把那种状态和「本来就没有卡」区分开的断言；
//    - 卡片结构不变量（当前会话里已有的卡）：胶囊数 0 或 2、只读态无胶囊、摘要/提问非空、
//      任何时刻最多一张可交互卡；没有卡时这些断言**空跑通过**（不是验证过卡片）；
//    - 幽灵提示默认不出现（ghost 默认关）。
// 2. **插件未安装时必然 FAIL（这是对的，不是脚本坏了）**：
//    - `插件 client 半已加载（style[data-plugin="@kangyishuai/dsh-next-step"]）`。
//      失败信息会列出页面上实际有哪些 data-plugin。修复方式：
//      `cd packages/next-step && pnpm pack --pack-destination /tmp` →
//      `dsh plugin --profile <正在运行的那个 profile> add /tmp/<tgz>` → **重启桌面版**（host 半要重启）。
//      注意：桌面版用的 profile 不一定是 `desktop`（本机实测是 `ai-radar`），装错 profile 等于没装。
// 3. **需要已有卡片才能真跑的交互断言**（默认只读**不会**生成卡片）：
//    - 找到带可交互卡的会话 → 点「展开」（摘要变高，带一次重试）→ 按一次 Esc（不误关卡片）
//      → 点 ✕（进入 dismissed、胶囊消失，带一次重试）→ 刷新后 dismissed 仍在。
//    - 只读模式不发消息，「找到带可交互卡的会话」通常是 SKIP（只有最后一轮可交互）；
//      要验交互必须用 --deep。
//      播种办法：先跑一次 `--deep --workspace /tmp/next-step-deep`（会真发一轮模型请求并留下真卡），
//      之后再跑只读回归；或者平时手动用过插件、profile 里已经有卡。
// 4. `--require` 只影响**连接**语义：连不上 CDP 时 FAIL（退出码 1）而不是 SKIP；
//    连上了但插件没装、没有卡，仍然是 FAIL（由上面第 2、3 条决定，不受 `--require` 影响）。
// 5. 以下内容**本脚本不覆盖**：幽灵提示接受（Tab/→）、设置面板改开关、`nextStep/*` RPC 的
//    错误分支（stale/missing/disabled）、流式中不渲染。这些在 web 冒烟与单测里覆盖。
//
// 三条踩过的坑（照 session-rewind 的经验）：
//   1. 手势断言（点 ✕ / 点「展开」）留**一次重试**：刚切完会话时焦点与回合状态可能差一拍，
//      第一次点不动、第二次就成；重试不降低断言（最终仍要求状态真的变了）。
//   2. 任何会写文件的段落都断言「没写进仓库 cwd」：会话没绑对工作区时模型的写入会落到
//      脚本自身 cwd（本仓库），断言只表现为「文件不存在」，污染完全静默。
//   3. 不按 `Esc Esc`（在运行本 agent 的会话里等于内置「停止」），最多按**一次** Esc，
//      且只断言「没有误关卡片」。
// 4. 宿主的 flow kind **没有** `"assistant"`：回答正文是 `assistant-step`
//    （值域 user / turn-process / assistant-step / tool-call / turn-tail / model-retry / turn-trigger）。
import { readdirSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-next-step-desktop-shots");
const PLUGIN = "@kangyishuai/dsh-next-step";
const PLUGIN_STYLE = `style[data-plugin="${PLUGIN}"]`;
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

/** 等页面可交互：readyState complete 且根节点有内容。 @param {any} cdp */
async function ensureReady(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await cdp
      .evaluate(
        `(() => document.readyState === "complete" && document.body && document.body.innerText.trim().length > 20)()`,
      )
      .catch(() => false);
    if (ready === true) {
      await sleep(800);
      return;
    }
    await sleep(400);
  }
}

/** 输入框里是否还有「停止」按钮（回合仍在跑）。 @param {any} cdp */
const isRunning = (cdp) =>
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
      await sleep(1200);
      if (!(await isRunning(cdp))) return true;
    }
    await sleep(1000);
  }
  return false;
}

/** 当前打开会话的 id。 @param {any} cdp */
const sessionIdOf = (cdp) =>
  cdp.evaluate(`(() => {
    const root = document.querySelector("[data-conversation-session]");
    return root ? root.getAttribute("data-conversation-session") : null;
  })()`);

/** 当前会话里的所有决策卡（data-* 契约与 client.js 文件头一致）。 @param {any} cdp */
const cardsNow = (cdp) =>
  cdp.evaluate(`(() => [...document.querySelectorAll("[data-next-step-card]")].map((el) => {
    const text = (selector) => { const node = el.querySelector(selector); return node ? (node.textContent || "").trim() : ""; };
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
      })),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
    };
  }))()`);

/** 往 composer 里打字（Lexical 需要 execCommand 才进得去）。 @param {any} cdp @param {string} text */
const typeIntoComposer = (cdp, text) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector("[data-composer-input]");
    if (!el) return false;
    el.focus();
    try { return document.execCommand("insertText", false, ${JSON.stringify(text)}); } catch (_error) {
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
  })()`);

/** @param {any} cdp */
const clickSend = (cdp) =>
  cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /发送消息|Send/.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);

/** 等输入框可编辑（新会话可能先要求选工作区）。 @param {any} cdp @param {number} timeoutMs */
async function waitForComposer(cdp, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const el = document.querySelector("[data-composer-input]");
      if (!el) return { ready: false, needsWorkspace: false };
      const rect = el.getBoundingClientRect();
      const editable = el.getAttribute("contenteditable") === "true";
      const placeholder = el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "";
      return { ready: editable && rect.width > 0 && rect.height > 0, needsWorkspace: !editable && String(placeholder).includes("选择一个工作区") };
    })()`);
    if (state?.ready === true) return true;
    if (state?.needsWorkspace === true) return false;
    await sleep(400);
  }
  return false;
}

/** 点卡片上的某个按钮；返回是否点到了。 @param {any} cdp @param {number} turn @param {string} selector */
const clickCardButton = (cdp, turn, selector) =>
  cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll("[data-next-step-card]")].find((el) => Number(el.getAttribute("data-next-step-turn")) === ${JSON.stringify(turn)});
    if (!card) return "no-card";
    const btn = card.querySelector(${JSON.stringify(selector)});
    if (!btn) return "no-button";
    if (btn.disabled) return "disabled";
    btn.click();
    return "clicked";
  })()`);

/** 等某轮卡片进入某个状态（或任意非指定状态）。 @param {any} cdp @param {number} turn @param {string} expectedState */
async function waitCardState(cdp, turn, expectedState, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let card = null;
  while (Date.now() < deadline) {
    const cards = await cardsNow(cdp);
    card = cards.find((/** @type {any} */ entry) => entry.turn === turn) ?? null;
    if (card?.state === expectedState) return card;
    await sleep(250);
  }
  return card;
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
      deep: { type: "boolean", default: false },
      workspace: { type: "string" },
    },
    allowPositionals: true,
  });
  // 容忍 `pnpm <script> -- --require`：多余的 `--` 会被当成位置参数，这里忽略它。
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  /** @type {{name: string, ok: boolean, detail: string, skip?: boolean}[]} */
  const checks = [];
  const check = (
    /** @type {string} */ name,
    /** @type {boolean} */ ok,
    /** @type {string} */ detail = "",
  ) => checks.push({ name, ok, detail });
  /** @param {string} name @param {string} reason */
  const skip = (name, reason) => checks.push({ name, ok: true, detail: reason, skip: true });

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
    // ---------- A. 插件加载与卡片结构（只读） ----------
    const info = await cdp.evaluate(`(() => ({
      title: document.title,
      pluginStyle: document.querySelector(${JSON.stringify(PLUGIN_STYLE)}) !== null,
      pluginStyles: [...document.querySelectorAll("style[data-plugin]")].map((s) => s.dataset.plugin).filter(Boolean),
      cardCount: document.querySelectorAll("[data-next-step-card]").length,
      chatRows: document.querySelectorAll("[data-chat-flow-kind]").length,
      projectionError: (() => {
        for (const el of document.querySelectorAll('[role="alert"], [class*="error"], [class*="Error"]')) {
          const text = (el.textContent || "").trim();
          if (/历史加载失败|failed to project|Cannot read properties/i.test(text)) return text.slice(0, 240);
        }
        return "";
      })(),
      ghostCount: document.querySelectorAll("[data-next-step-ghost]").length,
      composerEditable: (() => {
        const el = document.querySelector("[data-composer-input]");
        return !!el && el.getAttribute("contenteditable") === "true";
      })(),
      // 没打开会话 / 还没选工作区时输入框本来就不可编辑，这不是失败。
      composerNeedsWorkspace: (() => {
        const el = document.querySelector("[data-composer-input]");
        const placeholder = el ? el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "" : "";
        return String(placeholder).includes("选择一个工作区");
      })(),
      hasConversation: document.querySelector("[data-conversation-session]") !== null,
      composerEmpty: (() => {
        const el = document.querySelector("[data-composer-input]");
        return !el || (el.textContent || "").trim() === "";
      })(),
    }))()`);
    check(
      "连接到 DSH 桌面 UI",
      typeof info?.title === "string" && info.title.length > 0,
      JSON.stringify(info?.title ?? null),
    );
    // 约定（docs/plugin-conventions.md §6.1 参考实现）：client 半的 <style> 带 data-plugin。
    check(
      `插件 client 半已加载（${PLUGIN_STYLE}）`,
      info?.pluginStyle === true,
      info?.pluginStyle === true
        ? ""
        : `期望存在 ${PLUGIN_STYLE}，实际页面上的 data-plugin 有=${JSON.stringify(info?.pluginStyles ?? [])}；若 client 半未注入 style，请报给 Lead`,
    );
    // 只读回归不该要求「恰好有一个可编辑会话」：没打开会话、或停在「选择一个工作区」都是正常状态。
    // 有会话时要求输入框可编辑；没有会话时这条按 SKIP 记，避免在干净环境上假红。
    if (info?.composerEditable === true) {
      check("输入框可编辑（Esc/点击不会把界面搞坏的前提）", true, "");
    } else if (info?.hasConversation === false || info?.composerNeedsWorkspace === true) {
      skip(
        "输入框可编辑",
        `当前没有可编辑的会话（hasConversation=${String(info?.hasConversation)}, needsWorkspace=${String(info?.composerNeedsWorkspace)}）—— 先打开一个会话再跑可覆盖该条`,
      );
    } else {
      check(
        "输入框可编辑（Esc/点击不会把界面搞坏的前提）",
        false,
        `期望 [data-composer-input] 的 contenteditable="true"，实际=${JSON.stringify({
          composerEditable: info?.composerEditable,
          hasConversation: info?.hasConversation,
        })}`,
      );
    }
    check(
      "幽灵提示默认不出现（ghost 默认关 + 草稿为空）",
      info?.ghostCount === 0,
      `期望 0 个 [data-next-step-ghost]，实际=${info?.ghostCount}（若草稿非空请先清空输入框）`,
    );
    check(
      "当前会话卡片总数可读",
      typeof info?.cardCount === "number",
      JSON.stringify(info?.cardCount),
    );
    // 投影坏了是「静默全灭」：页面还能用、日志正常，只是整条历史加载失败、卡片永不渲染。
    // 这条同时兜住「没有任何卡片」是「本来就没有」还是「投影炸了」。
    check(
      "投影健康：没有会话历史加载失败的报错",
      typeof info?.projectionError === "string" && info.projectionError === "",
      JSON.stringify({ projectionError: info?.projectionError, chatRows: info?.chatRows }),
    );

    // 结构不变量：任何卡片都满足「2 粒胶囊 / 有 ✕ / 摘要提问非空」的契约。
    /** @param {any[]} cards */
    /**
     * @param {any[]} cards
     * @param {string} label
     */
    const structureCheck = (cards, label) => {
      const badPills = cards.filter((c) => c.pills.length !== 0 && c.pills.length !== 2);
      const interactiveWithWrongPills = cards.filter(
        (c) => c.state === "interactive" && (c.pills.length !== 2 || !c.hasDismiss),
      );
      const readonlyWithPills = cards.filter(
        (c) => c.state !== "interactive" && c.state !== "sending" && c.pills.length !== 0,
      );
      const emptyText = cards.filter((c) => c.summary === "" || c.question === "");
      check(
        `${label}：每张卡最多 2 粒胶囊、只读态无胶囊、摘要提问非空`,
        badPills.length === 0 &&
          interactiveWithWrongPills.length === 0 &&
          readonlyWithPills.length === 0 &&
          emptyText.length === 0,
        JSON.stringify({
          cards: cards.map((c) => ({ turn: c.turn, state: c.state, pills: c.pills.length })),
          badPills: badPills.map((c) => c.turn),
          interactiveWithWrongPills: interactiveWithWrongPills.map((c) => c.turn),
          readonlyWithPills: readonlyWithPills.map((c) => c.turn),
          emptyText: emptyText.map((c) => c.turn),
        }),
      );
      const interactive = cards.filter((/** @type {any} */ c) => c.state === "interactive");
      check(
        `${label}：最多一张可交互卡`,
        interactive.length <= 1,
        JSON.stringify(interactive.map((c) => c.turn)),
      );
    };
    const initialCards = await cardsNow(cdp);
    structureCheck(initialCards, "初始会话");
    if (initialCards.length > 0) {
      const newest = initialCards[initialCards.length - 1];
      check(
        "当前会话的卡片有摘要 / 提问（可交互态另需 ✕）",
        newest.summary !== "" &&
          newest.question !== "" &&
          (newest.state !== "interactive" || newest.hasDismiss === true),
        JSON.stringify({
          turn: newest.turn,
          state: newest.state,
          summary: newest.summary.slice(0, 40),
          question: newest.question.slice(0, 40),
          hasDismiss: newest.hasDismiss,
        }),
      );
    } else {
      skip(
        "当前会话的卡片结构",
        "当前会话没有决策卡（默认只读不生成新卡）；用 --deep 发一轮消息可验证",
      );
    }
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    // ---------- B. 找一张可交互的卡（只切会话，不发消息） ----------
    const originalSession = await sessionIdOf(cdp);
    const sessionIds = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
      return rows
        .filter((row) => !(row.textContent || "").includes("进行中"))
        .map((row) => (row.getAttribute("data-row-key") || "").replace("session:", ""));
    })()`);
    /** @param {string} id */
    const switchTo = async (id) => {
      await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(id)} + '"]');
        if (row) { row.scrollIntoView({ block: "center" }); row.click(); }
      })()`);
      await sleep(1100);
    };
    /** @type {{sessionId: string, turn: number} | null} */
    let target = null;
    /** @type {string[]} */
    const probeLog = [];
    const candidates = [originalSession, ...(Array.isArray(sessionIds) ? sessionIds : [])].filter(
      (id, index, list) => typeof id === "string" && id !== "" && list.indexOf(id) === index,
    );
    for (const id of candidates) {
      if (id !== originalSession) await switchTo(id);
      const cards = await cardsNow(cdp);
      const interactive = cards.filter((/** @type {any} */ c) => c.state === "interactive");
      probeLog.push(`${id.slice(0, 14)}:cards=${cards.length}:interactive=${interactive.length}`);
      if (interactive.length > 0) {
        target = { sessionId: id, turn: interactive[interactive.length - 1].turn };
        break;
      }
    }
    if (target === null) {
      // 只有「最后一轮」的卡可交互；只读回归不发消息，因此找不到是**正常状态**，不该判红。
      skip(
        "找到带可交互卡的会话（只读模式不需要）",
        `探测=${probeLog.join(" ") || "侧栏里没有会话"} —— 只读回归不发消息造卡；要验交互用 --deep`,
      );
    } else {
      check(
        "找到一个带可交互卡的会话（默认只读：只切会话，不发消息）",
        true,
        `session=${target.sessionId} turn=${target.turn}（探测：${probeLog.join(" ")}）`,
      );
    }
    let deepSession = null;
    if (target !== null) {
      const cards = await cardsNow(cdp);
      structureCheck(cards, "目标会话");
      const card = cards.find((/** @type {any} */ c) => c.turn === target.turn) ?? null;
      check(
        "可交互卡带摘要、提问、两粒胶囊与 ✕",
        card !== null &&
          card.summary !== "" &&
          card.question !== "" &&
          card.pills.length === 2 &&
          card.hasDismiss === true,
        JSON.stringify(
          card === null
            ? null
            : {
                turn: card.turn,
                state: card.state,
                pills: card.pills.map((/** @type {any} */ p) => p.label),
                summary: card.summary.slice(0, 40),
                question: card.question.slice(0, 40),
              },
        ),
      );
      check(
        "两粒胶囊的 stance 互斥",
        card !== null &&
          card.pills.length === 2 &&
          card.pills[0].stance !== "" &&
          card.pills[1].stance !== "" &&
          card.pills[0].stance !== card.pills[1].stance,
        JSON.stringify(
          card === null
            ? null
            : card.pills.map((/** @type {any} */ p) => ({ stance: p.stance, label: p.label })),
        ),
      );
      await cdp.screenshot(join(SHOTS, "02-card.png"));

      // ---------- C. 展开 / 收起摘要（手势断言，留一次重试） ----------
      if (card?.hasMore) {
        const before = await cdp.evaluate(`(() => {
          const el = [...document.querySelectorAll("[data-next-step-card]")].find((n) => Number(n.getAttribute("data-next-step-turn")) === ${JSON.stringify(target.turn)});
          const summary = el ? el.querySelector("[data-next-step-summary]") : null;
          return summary ? { height: summary.getBoundingClientRect().height, text: (summary.textContent || "").length } : null;
        })()`);
        let expanded = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          await clickCardButton(cdp, target.turn, "button[data-next-step-more]");
          await sleep(500);
          expanded = await cdp.evaluate(`(() => {
            const el = [...document.querySelectorAll("[data-next-step-card]")].find((n) => Number(n.getAttribute("data-next-step-turn")) === ${JSON.stringify(target.turn)});
            const summary = el ? el.querySelector("[data-next-step-summary]") : null;
            return summary ? { height: summary.getBoundingClientRect().height, text: (summary.textContent || "").length, moreLabel: (el.querySelector("button[data-next-step-more]")?.textContent || "").trim() } : null;
          })()`);
          if (expanded !== null && before !== null && expanded.height > before.height + 1) break;
          await sleep(400);
        }
        check(
          "点「展开」后摘要变高（手势断言，失败时重试一次）",
          before !== null && expanded !== null && expanded.height > before.height + 1,
          JSON.stringify({ before, expanded }),
        );
        // 收起，别把界面留在展开态
        await clickCardButton(cdp, target.turn, "button[data-next-step-more]");
        await sleep(400);
      } else {
        skip("点「展开」后摘要变高", "该卡没有 button[data-next-step-more]（摘要没折叠）");
      }
      await cdp.screenshot(join(SHOTS, "03-expanded.png"));

      // ---------- D. Esc 不会误关卡片（只按一次，避免内置「停止」） ----------
      const beforeEsc = await waitCardState(cdp, target.turn, "interactive", 4000);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 53,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 53,
      });
      await sleep(700);
      const afterEsc = await cardsNow(cdp);
      const escCard = afterEsc.find((/** @type {any} */ c) => c.turn === target.turn) ?? null;
      check(
        "按一次 Esc 不会误关卡片（卡片与胶囊都还在）",
        beforeEsc !== null &&
          escCard !== null &&
          escCard.state === "interactive" &&
          escCard.pills.length === 2,
        JSON.stringify({
          before: beforeEsc?.state ?? null,
          after: escCard === null ? null : { state: escCard.state, pills: escCard.pills.length },
        }),
      );
      await cdp.screenshot(join(SHOTS, "04-after-esc.png"));

      // ---------- E. 点 ✕ → 只读态 + 胶囊消失；刷新后仍是只读（投影持久化） ----------
      let dismissed = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const clicked = await clickCardButton(cdp, target.turn, "button[data-next-step-dismiss]");
        if (clicked !== "clicked") {
          check(
            "点 ✕ 命中卡片上的关闭按钮",
            false,
            `clickCardButton 返回=${JSON.stringify(clicked)}`,
          );
          break;
        }
        dismissed = await waitCardState(cdp, target.turn, "dismissed", 5000);
        if (dismissed?.state === "dismissed" && dismissed.pills.length === 0) break;
        await sleep(400);
      }
      check(
        "点 ✕ 后卡片进入 dismissed（且胶囊消失，失败时重试一次）",
        dismissed !== null && dismissed.state === "dismissed" && dismissed.pills.length === 0,
        JSON.stringify(
          dismissed === null
            ? null
            : { turn: dismissed.turn, state: dismissed.state, pills: dismissed.pills.length },
        ),
      );
      await cdp.screenshot(join(SHOTS, "05-dismissed.png"));

      await cdp.send("Page.reload");
      await ensureReady(cdp);
      await sleep(2500);
      const reopened = await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(target.sessionId)} + '"]');
        if (!row) return false;
        row.scrollIntoView({ block: "center" });
        row.click();
        return true;
      })()`);
      await sleep(2500);
      const afterReload = await cardsNow(cdp);
      const reloadedCard =
        afterReload.find((/** @type {any} */ c) => c.turn === target.turn) ?? null;
      check(
        "刷新后重新打开会话，已 dismiss 的卡片仍在且仍是只读态",
        reopened === true &&
          reloadedCard !== null &&
          reloadedCard.pills.length === 0 &&
          reloadedCard.state === "dismissed",
        JSON.stringify({
          reopened,
          cards: afterReload.map((/** @type {any} */ c) => ({
            turn: c.turn,
            state: c.state,
            pills: c.pills.length,
          })),
        }),
      );
      structureCheck(afterReload, "刷新后");
      await cdp.screenshot(join(SHOTS, "06-after-reload.png"));

      // 收尾：切回调用者的会话，别把界面留在别人的会话里。
      if (typeof originalSession === "string" && originalSession !== "")
        await switchTo(originalSession);
    }

    // ---------- E2. 设置页：一行开关 + 诊断（含运行时版本 / 构建哈希） ----------
    // 入口是账号菜单 →「设置」→ 左栏「下一步建议」（独立分节；不要盲点坐标：先取元素 rect 再派发原生事件）。
    {
      const clickRect = async (/** @type {{x:number,y:number}} */ rect) => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: rect.x,
            y: rect.y,
            button: "left",
            clickCount: 1,
          });
          await sleep(80);
        }
      };
      /** @param {string} selector @param {string} [label] */
      const rectOf = (selector, label) =>
        cdp.evaluate(`(() => {
          const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
          const hit = nodes.find((el) => ${label === undefined ? "true" : `(el.textContent || "").includes(${JSON.stringify(label)})`});
          if (!hit) return null;
          const r = hit.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);

      const openSettings = async () => {
        if (await cdp.evaluate(`!!document.querySelector('[data-shortcut-modal="settings"]')`))
          return true;
        const trigger = await rectOf('button[aria-label="账号菜单"]');
        if (trigger === null) return false;
        await clickRect(trigger);
        await sleep(1200);
        const item = await rectOf('button[role="menuitem"]', "设置");
        if (item === null) return false;
        await clickRect(item);
        await sleep(1500);
        return Boolean(
          await cdp.evaluate(`!!document.querySelector('[data-shortcut-modal="settings"]')`),
        );
      };

      const opened = await openSettings();
      const general = opened
        ? await rectOf('[data-shortcut-modal="settings"] button', "下一步建议")
        : null;
      if (general !== null) {
        await clickRect(general);
        await sleep(1000);
      }
      const readRow = async () =>
        cdp.evaluate(`(() => {
          const host = document.querySelector("[data-next-step-settings]");
          if (!host) return null;
          const diag = document.querySelector("[data-next-step-diag]");
          const advanced = host.querySelector("[data-next-step-advanced]");
          return {
            switches: [...host.querySelectorAll("[data-next-step-switch]")].map((el) => el.getAttribute("data-next-step-switch")),
            tiers: [...host.querySelectorAll("[data-next-step-tier]")].map((el) => el.getAttribute("data-next-step-tier")),
            advanced: !!advanced,
            advancedOpen: advanced !== null && advanced.getAttribute("aria-expanded") === "true",
            budget: !!host.querySelector("[data-next-step-budget]"),
            pause: !!host.querySelector("[data-next-step-pause]"),
            review: !!host.querySelector("[data-next-step-review]"),
            diag: diag ? (diag.textContent || "").trim() : "",
          };
        })()`);
      let row = null;
      const rowDeadline = Date.now() + 10000;
      while (Date.now() < rowDeadline) {
        row = await readRow();
        if (row !== null) break;
        await sleep(400);
      }
      check(
        "设置页出现「下一步建议」分节：首屏 3 行（启用 / 出卡频率三选一 / 决策卡），其余折叠",
        row !== null &&
          Array.isArray(row.switches) &&
          row.switches.length === 2 &&
          Array.isArray(row.tiers) &&
          row.tiers.join(",") === "must,could,any" &&
          row.advanced === true &&
          row.advancedOpen === false &&
          row.budget === false &&
          row.pause === false,
        JSON.stringify({
          opened,
          generalFound: general !== null,
          row:
            row === null
              ? null
              : {
                  switches: row.switches,
                  tiers: row.tiers,
                  advancedOpen: row.advancedOpen,
                  budget: row.budget,
                },
        }),
      );

      // 展开「更多设置」（纯 UI 展开，只读）→ 依赖项与回顾块出现
      const advancedRect = await cdp.evaluate(`(() => {
        const el = document.querySelector("[data-next-step-advanced]");
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      if (advancedRect !== null) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: Math.round(advancedRect.x),
            y: Math.round(advancedRect.y),
            button: "left",
            clickCount: 1,
          });
        }
        await sleep(600);
      }
      let rowOpen = null;
      const openDeadline = Date.now() + 8000;
      while (Date.now() < openDeadline) {
        rowOpen = await readRow();
        if (rowOpen !== null && rowOpen.advancedOpen === true) break;
        await sleep(300);
      }
      check(
        "「更多设置」展开后出现 4 个开关 + 预算 + 暂停 + 诊断 + 回顾块",
        rowOpen !== null &&
          rowOpen.switches.length === 4 &&
          rowOpen.budget === true &&
          rowOpen.pause === true &&
          rowOpen.review === true,
        JSON.stringify(
          rowOpen === null
            ? null
            : {
                switches: rowOpen.switches,
                budget: rowOpen.budget,
                pause: rowOpen.pause,
                review: rowOpen.review,
              },
        ),
      );
      check(
        "诊断行显示运行时版本、构建哈希与提示词版本",
        rowOpen !== null &&
          /版本\s+\d+\.\d+\.\d+\s+·\s+构建\s+[0-9a-f]{8}/u.test(rowOpen.diag) &&
          /提示词 v\d+/u.test(rowOpen.diag),
        JSON.stringify({ diag: rowOpen === null ? null : rowOpen.diag }),
      );
      if (rowOpen !== null)
        console.log(`      diagnostics: ${rowOpen.diag.replace(/\n/gu, " | ")}`);
      row = rowOpen;
      if (row !== null) console.log(`      diagnostics: ${row.diag.replace(/\n/gu, " | ")}`);
      await cdp.screenshot(join(SHOTS, "05-settings.png"));
      // 关掉设置面板，别把界面留在设置里。
      for (let i = 0; i < 2; i += 1) {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await sleep(300);
      }
    }

    // ---------- F. --deep：真发消息（破坏性，自己建立前置状态） ----------
    if (values.deep === true) {
      const workspacePath = values.workspace;
      /** @type {string} */
      let workspaceDetail = "缺少 --workspace";
      let workspaceOk = false;
      if (typeof workspacePath === "string" && workspacePath !== "") {
        try {
          const info = await stat(workspacePath);
          const repo = process.cwd();
          workspaceOk = info.isDirectory() && !workspacePath.startsWith(repo);
          workspaceDetail = workspaceOk ? "" : `不是目录，或位于仓库内（${repo}）`;
        } catch {
          workspaceDetail = `目录不存在：${workspacePath}`;
        }
      }
      check("--deep 提供了可用的专用测试工作区", workspaceOk, workspaceDetail);

      if (workspaceOk && typeof workspacePath === "string") {
        const workspaceTitle = basename(workspacePath);
        const repoRootBefore = readdirSync(process.cwd()).sort();
        const prompt = "用一句话解释什么是二分查找。不要使用任何工具，直接回答。";

        const opened = await cdp.evaluate(`(() => {
          const title = ${JSON.stringify(workspaceTitle)};
          const buttons = [...document.querySelectorAll("button")];
          const scoped = buttons.find((b) => {
            const aria = (b.getAttribute("aria-label") || "").trim();
            return aria.includes("中新建会话") && aria.includes(title);
          });
          const fallback = buttons.find((b) => (b.getAttribute("aria-label") || "").trim() === "新建会话");
          const button = scoped || fallback;
          if (!button) return "no-button";
          button.click();
          return scoped ? "clicked-scoped" : "clicked-fallback";
        })()`);
        await sleep(2600);
        const fresh = await cdp.evaluate(`(() => ({
          session: (() => { const root = document.querySelector("[data-conversation-session]"); return root ? root.getAttribute("data-conversation-session") : null; })(),
          userRows: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
          cards: document.querySelectorAll("[data-next-step-card]").length,
        }))()`);
        check(
          "在测试工作区里新建了一个空会话（--deep 前置）",
          opened !== "no-button" && fresh.userRows === 0,
          JSON.stringify({ opened, ...fresh }),
        );
        deepSession = fresh.session ?? null;
        const composerReady = await waitForComposer(cdp, 8000);
        check(
          "新会话输入框可编辑（已绑定测试工作区）",
          composerReady === true,
          composerReady
            ? ""
            : `「${workspaceTitle}」的新会话输入框不可编辑；检查工作区是否可写，或手动开一个会话再重跑 --deep`,
        );
        const typed = await typeIntoComposer(cdp, prompt);
        await sleep(400);
        const sent = await clickSend(cdp);
        check("发送测试提示词", typed !== false && sent === true, JSON.stringify({ typed, sent }));
        const finished = await waitForTurnEnd(cdp, 240000);
        check("回合结束（模型答完）", finished === true, finished ? "" : "240s 内没等到回合结束");
        // 卡片在 turn/end 之后由一次额外模型调用生成（超时 20s），这里给足余量。
        // v0.2：模型可能判断这一轮不需要继续 —— 此时不出卡，改由「生成下一步建议」按钮强制出卡。
        /** @type {any[]} */
        let deepCards = [];
        let deepGenerated = false;
        const cardDeadline = Date.now() + 30000;
        while (Date.now() < cardDeadline) {
          deepCards = await cardsNow(cdp);
          if (deepCards.some((c) => c.state === "interactive")) break;
          await sleep(1000);
        }
        if (!deepCards.some((c) => c.state === "interactive")) {
          const retry = await cdp.evaluate(`(() => {
            const button = document.querySelector("[data-next-step-generate]");
            if (!button) return "no-button";
            if (button.disabled) return "disabled";
            button.click();
            return "clicked";
          })()`);
          check(
            "模型判断无需继续时出现「生成下一步建议」按钮（--deep）",
            retry !== "no-button",
            JSON.stringify({ retry }),
          );
          if (retry === "clicked") {
            const retryDeadline = Date.now() + 90000;
            while (Date.now() < retryDeadline) {
              deepCards = await cardsNow(cdp);
              if (deepCards.some((c) => c.state === "interactive")) {
                deepGenerated = true;
                break;
              }
              await sleep(1000);
            }
          }
        }
        const deepCard = deepCards.filter((c) => c.state === "interactive").pop() ?? null;
        check(
          "答后出现可交互决策卡（--deep，自动或补生成）",
          deepCard !== null,
          JSON.stringify({
            generatedByRetry: deepGenerated,
            cards: deepCards.map((c) => ({ turn: c.turn, state: c.state, pills: c.pills.length })),
          }),
        );
        if (deepCard !== null) {
          check(
            "--deep 卡片有两粒 stance 互斥的胶囊",
            deepCard.pills.length === 2 &&
              deepCard.pills[0].stance !== deepCard.pills[1].stance &&
              deepCard.pills.every((/** @type {any} */ p) => p.label !== ""),
            JSON.stringify(
              deepCard.pills.map((/** @type {any} */ p) => ({ stance: p.stance, label: p.label })),
            ),
          );
          await cdp.screenshot(join(SHOTS, "07-deep-card.png"));
          // 点第一粒胶囊：会真的发出一条用户消息（破坏性，只在 --deep 下做）。
          const userRowsBefore = await cdp.evaluate(
            `document.querySelectorAll('[data-chat-flow-kind="user"]').length`,
          );
          const pillClick = await cdp.evaluate(`(() => {
            const card = [...document.querySelectorAll("[data-next-step-card]")].find((el) => Number(el.getAttribute("data-next-step-turn")) === ${JSON.stringify(deepCard.turn)});
            if (!card) return "no-card";
            const pill = card.querySelector("button[data-next-step-pill]");
            if (!pill) return "no-pill";
            if (pill.disabled) return "disabled";
            const label = (pill.getAttribute("data-text") || "").trim();
            pill.click();
            return "clicked:" + label;
          })()`);
          // 点击后是「先写 decision 再发送」：轮询等 sent，不要期望瞬间切换。
          const afterPill = await waitCardState(cdp, deepCard.turn, "sent", 15000);
          let userRowsAfter = userRowsBefore;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            userRowsAfter = await cdp.evaluate(
              `document.querySelectorAll('[data-chat-flow-kind="user"]').length`,
            );
            if (userRowsAfter > userRowsBefore) break;
            await sleep(250);
          }
          check(
            "点胶囊后卡片进入 sent 且胶囊消失",
            afterPill !== null && afterPill.state === "sent" && afterPill.pills.length === 0,
            JSON.stringify({
              pillClick,
              state: afterPill?.state ?? null,
              pills: afterPill?.pills.length ?? null,
            }),
          );
          check(
            "点胶囊发送出一条新的用户消息",
            userRowsAfter >= userRowsBefore + 1,
            JSON.stringify({ before: userRowsBefore, after: userRowsAfter, pillClick }),
          );
          const sentEcho = await cdp.evaluate(`(() => {
            const card = [...document.querySelectorAll("[data-next-step-card]")].find((el) => Number(el.getAttribute("data-next-step-turn")) === ${JSON.stringify(deepCard.turn)});
            const node = card ? card.querySelector("[data-next-step-sent]") : null;
            return {
              label: node ? node.getAttribute("data-next-step-sent-label") || "" : "",
              text: node ? (node.textContent || "").replace(/\\s+/g, " ").trim() : "",
            };
          })()`);
          const clickedLabel =
            typeof pillClick === "string" && pillClick.startsWith("clicked:")
              ? pillClick.slice("clicked:".length)
              : "";
          check(
            "点后回显被点的按钮文本（选中态 + 已发出）",
            clickedLabel !== "" &&
              sentEcho.label === clickedLabel &&
              sentEcho.text.includes(clickedLabel),
            JSON.stringify({ clickedLabel, sentEcho }),
          );
          await cdp.screenshot(join(SHOTS, "08-deep-sent.png"));
          await waitForTurnEnd(cdp, 240000);
        }
        // 防回归：会话没绑对工作区时模型写入会落到**脚本自身 cwd**（本仓库）。
        const repoRootAfter = readdirSync(process.cwd()).sort();
        const leaked = repoRootAfter.filter(
          (/** @type {string} */ name) => repoRootBefore.indexOf(name) < 0,
        );
        check(
          "仓库根目录没有多出文件（模型写入没漏到 cwd）",
          leaked.length === 0,
          leaked.length === 0 ? "" : `仓库 cwd=${process.cwd()} 多出=${JSON.stringify(leaked)}`,
        );
        // 清掉可能残留的草稿，避免影响后续手动验证。
        await cdp.evaluate(`(() => {
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
        })()`);
        if (deepSession !== null) {
          check(
            "--deep 跑在自己的会话里（拿到会话 id）",
            typeof deepSession === "string" && deepSession.length > 0,
            JSON.stringify(deepSession),
          );
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
    const tag = item.skip === true ? "SKIP " : item.ok ? "PASS " : "FAIL ";
    console.log(tag + item.name + (item.skip === true || !item.ok ? ` :: ${item.detail}` : ""));
    if (item.skip === true) skipped += 1;
    else if (!item.ok) failed += 1;
  }
  console.log(`截图目录：${SHOTS}`);
  if (failed > 0) {
    console.error(
      `FAIL ${failed} 项桌面回归断言失败（共 ${checks.length} 项，SKIP ${skipped} 项）`,
    );
    process.exitCode = 1;
  } else if (skipped > 0) {
    console.log(
      `PASS 其余 ${checks.length - skipped} 项桌面回归断言通过；SKIP ${skipped} 项（原因见上）`,
    );
  } else {
    console.log(`PASS 全部 ${checks.length} 项桌面回归断言通过`);
  }
};

await main();
