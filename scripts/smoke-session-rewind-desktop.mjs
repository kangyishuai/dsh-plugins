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
// `--deep --workspace <专用测试目录>`：额外跑**文件模式端到端**（在该目录的会话里发一次模型请求，
// 让它写一个文件、然后回溯并还原）。两道硬前置：
//   1. 必须显式给 `--workspace`，且它必须存在、不在本仓库内；
//   2. 当前必须已打开一个**绑定到该工作区**的会话——即输入框可编辑。
//      「点 + 新建会话」在未绑定工作区时会停在「选择一个工作区开始」，而那个工作区选择器是
//      无头环境里点不动的弹层（合成 click、CDP 真鼠标事件、键盘导航都试过），所以无法可靠自动化；
//      请先手工在 DSH 里打开该工作区、新建一个会话，
//      然后再跑。脚本绝不会退而求其次去用工作区里别的会话（可能是有价值的真实内容）。
//   pnpm smoke:session-rewind-desktop --require --deep --workspace ~/Workspace/dsh-rewind-ui-smoke
//
// 两条踩过的坑：
//   1. `Esc` `Esc` 在「正在运行本 agent 的会话」里会触发内置停止，取消正在跑的这一轮
//      （脚本自己的工具调用会被 abort）。所以先切到一个**有消息的空闲会话**再按 Esc。
//   2. 侧栏里可能有没有消息的会话，切过去候选列表是空的；必须挑选有用户消息的会话。
//
// `--sidebar-workspace <标题>`：只在该工作区的分组里找会话，**不碰别的工作区的会话**。
// 找不到合格会话就判失败（而不是随手点开别人的会话）。
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

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

const DIALOG = `[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((d) => (d.className || "").includes("dsh-srw"))`;

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

/**
 * 等输入框**可编辑**。新建会话后宿主可能先要求「选择一个工作区开始」，
 * 此时输入框存在但 contenteditable=false，光看存在性会误判为就绪。
 */
async function waitForComposer(/** @type {any} */ cdp, /** @type {number} */ timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const el = document.querySelector("[data-composer-input]");
      if (!el) return { ready: false, needsWorkspace: false };
      const rect = el.getBoundingClientRect();
      const editable = el.getAttribute("contenteditable") === "true";
      const placeholder = el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "";
      return {
        ready: editable && rect.width > 0 && rect.height > 0,
        needsWorkspace: !editable && String(placeholder).includes("选择一个工作区"),
      };
    })()`);
    if (state?.ready === true) return true;
    if (state?.needsWorkspace === true) return false;
    await sleep(400);
  }
  return false;
}

/** 往 composer 里打字（Lexical 需要 execCommand 才进得去）。 */
const typeIntoComposer = (/** @type {any} */ cdp, /** @type {string} */ text) =>
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

const clickSend = (/** @type {any} */ cdp) =>
  cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /发送消息|Send/.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);

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
    },
    allowPositionals: true,
  });
  // 容忍 `pnpm <script> -- --require`：多余的 `--` 会被当成位置参数，这里忽略它。
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const check = (
    /** @type {string} */ name,
    /** @type {boolean} */ ok,
    /** @type {string} */ detail = "",
  ) => checks.push({ name, ok, detail });

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

    // ---------- C. Esc Esc → 候选列表 → 搜索 ----------
    /** @type {any} */
    let candidates = null;
    if (idleSession !== null) {
      await cdp.evaluate(
        `(() => { const el = document.querySelector("[data-composer-input]"); if (el && el.focus) el.focus(); })()`,
      );
      await sleep(200);
      await pressEscape(cdp, "Escape", 53);
      await sleep(120);
      await pressEscape(cdp, "Escape", 53);
      await sleep(900);
      candidates = await dialogInfo(cdp);
    }
    check(
      "Esc Esc 打开候选列表",
      candidates !== null,
      candidates ? candidates.title : "没有对话框",
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
    check(
      "确认框写明影响面与预览",
      typeof confirm?.text === "string" && /将撤回|This withdraws/u.test(confirm.text),
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

    // ---------- E. 回溯面板四页签 ----------
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
      if (btn) btn.click();
    })()`);
    await sleep(1000);
    const drawer = await drawerInfo(cdp);
    check(
      "回溯面板打开且四页签齐全",
      drawer !== null &&
        ["已撤回", "回溯记录", "救援点", "设置"].every((tab) => drawer.tabs.includes(tab)),
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

    // ---------- F. 设置 → 诊断（含只读工具与孤儿数据） ----------
    await openDrawerTab(cdp, "设置");
    await sleep(1400);
    const health = await cdp.evaluate(`(async () => {
      const root = document.querySelector(".dsh-srw-drawer");
      if (!root) return "";
      const refresh = [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "刷新");
      if (refresh) refresh.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return (root.textContent || "").replace(/\\s+/g, " ");
    })()`);
    check(
      "设置页诊断可加载",
      /诊断/u.test(health) && /正常|异常|OK|Problem/u.test(health),
      health.slice(0, 200),
    );
    check(
      "诊断报告只读工具已注册",
      /只读工具/u.test(health) && /enabled|disabled by config/u.test(health),
      health.slice(0, 400),
    );
    check("诊断报告孤儿数据检查", /孤儿数据/u.test(health), health.slice(0, 400));
    await cdp.screenshot(join(SHOTS, "04-settings.png"));

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
    if (values.deep === true) {
      const workspacePath = values.workspace;
      const fileName = "rewind-desktop-smoke.txt";
      const filePath = workspacePath === undefined ? "" : join(workspacePath, fileName);
      // 每次跑用唯一内容：否则重复运行时 write 是幂等的（beforeHash === afterHash），
      // 文件引擎正确地认为「没有变化」，文件模式也就理所当然地不可用。
      const content = `hello-rewind-desktop-${Date.now()}`;
      const prompt =
        `只做一件事：用 write 工具在当前工作区创建 ${fileName}，内容为 ${content}。` +
        "不要做其他任何操作，完成后回复一句简短确认。";

      // 安全闸：必须显式给出一个已存在的专用目录，且不能是仓库所在目录。
      let workspaceOk = false;
      let workspaceDetail = "缺少 --workspace";
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

      const workspaceTitle = typeof workspacePath === "string" ? basename(workspacePath) : "";

      if (workspaceOk && typeof workspacePath === "string") {
        // 干净起点：上一次跑留下的同名文件会变成「已存在」而不是「新建」，语义不同。
        await rm(filePath, { force: true }).catch(() => {});
        check("测试文件在开始前不存在（保证是新建语义）", !(await exists(filePath)), filePath);
        // 要求当前会话已绑定工作区且输入框可编辑：见文件头说明（新建会话的绑定无法可靠自动化）。
        const ready = await waitForComposer(cdp, 4000);
        check(
          "当前会话输入框可编辑（已绑定测试工作区）",
          ready,
          ready
            ? ""
            : `请先在 DSH 里打开「${workspaceTitle}」工作区并新建/打开一个会话，使输入框可编辑，再重跑 --deep`,
        );

        const typed = await typeIntoComposer(cdp, prompt);
        await sleep(300);
        const sent = await clickSend(cdp);
        check(
          "发送「创建测试文件」的请求",
          typed !== false && sent === true,
          JSON.stringify({ typed, sent }),
        );

        const finished = await waitForTurnEnd(cdp, 180000);
        let fileBody = "";
        try {
          fileBody = (await readFile(filePath, "utf8")).trim();
        } catch {
          fileBody = "";
        }
        check(
          "agent 确实用 write 创建了测试文件",
          finished && fileBody === content,
          JSON.stringify({ finished, fileBody: fileBody.slice(0, 40) }),
        );

        // 点这条用户消息的 ↶ → 确认框（文件模式应该可用）
        const opened = await cdp.evaluate(`(() => {
          const row = document.querySelector('[data-chat-flow-kind="user"]');
          if (!row) return "no-user-row";
          const btn = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回退到此处"));
          if (!btn) return "no-rewind-button";
          btn.click();
          return "clicked";
        })()`);
        await sleep(2200);
        const deepConfirm = await dialogInfo(cdp);
        const bothReady = await cdp.evaluate(`(() => {
          const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
          return radio ? !radio.disabled : false;
        })()`);
        check(
          "文件模式在确认框里可用（有文件变更）",
          opened === "clicked" && bothReady === true,
          JSON.stringify({ opened, bothReady }),
        );
        check(
          "确认框预览写明文件动作",
          typeof deepConfirm?.text === "string" &&
            /将还原|还原 \d|移入回收站|Restore/u.test(deepConfirm.text),
          (deepConfirm?.text ?? "").slice(0, 200),
        );

        // 选「对话+文件」并执行
        await cdp.evaluate(`(() => {
          const radio = document.querySelector('.dsh-srw-dialog input[type="radio"][value="both"]');
          if (radio && !radio.disabled) radio.click();
        })()`);
        await sleep(400);
        const confirmed = await clickDialogButton(cdp, ["开始回退", "Rewind"]);
        let dialogGone = false;
        for (let i = 0; i < 40; i += 1) {
          await sleep(500);
          if ((await dialogInfo(cdp)) === null) {
            dialogGone = true;
            break;
          }
        }
        let afterBody = "exists";
        try {
          await stat(filePath);
        } catch {
          afterBody = "";
        }
        check(
          "确认后对话框关闭",
          confirmed && dialogGone,
          JSON.stringify({ confirmed, dialogGone }),
        );
        check(
          "文件被移入插件回收站（工作区里已不存在）",
          afterBody === "",
          afterBody === "" ? "" : "文件仍在",
        );

        const toast = await cdp.evaluate(
          `(() => { const el = document.querySelector(".dsh-srw-toast"); return el ? (el.textContent || "").trim() : ""; })()`,
        );
        check(
          "toast 报告撤回与文件结果",
          /回退|Rewound/u.test(toast) && /回收站|trash/u.test(toast),
          toast.slice(0, 160),
        );
        const refilled = await composerText(cdp);
        check(
          "输入框回填被撤回的消息文本",
          refilled.trim().length > 0 && refilled.includes("rewind-desktop-smoke"),
          refilled.slice(0, 80),
        );

        // 清掉回填的草稿，避免影响后续面板操作
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

        // 救援点恢复：面板 → 救援点 → 恢复 → 确认
        await cdp.evaluate(`(() => {
          const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回溯面板"));
          if (btn) btn.click();
        })()`);
        await sleep(900);
        await openDrawerTab(cdp, "救援点");
        await sleep(1200);
        const restoreClicked = await cdp.evaluate(`(() => {
          const root = document.querySelector(".dsh-srw-drawer");
          if (!root) return "no-drawer";
          const btn = [...root.querySelectorAll("button")].find((b) => /恢复这些文件|Restore/u.test((b.textContent || "").trim()));
          if (!btn) return "no-restore-button";
          btn.click();
          return "clicked";
        })()`);
        await sleep(900);
        const restoreConfirmed = await cdp.evaluate(`(() => {
          const root = document.querySelector(".dsh-srw-drawer");
          if (!root) return "no-drawer";
          const btn = [...root.querySelectorAll("button")].find((b) => /恢复这些文件|Restore/u.test((b.textContent || "").trim()));
          if (!btn) return "no-confirm-button";
          btn.click();
          return "clicked";
        })()`);
        await sleep(2200);
        let restored = "";
        try {
          restored = (await readFile(filePath, "utf8")).trim();
        } catch {
          restored = "";
        }
        check(
          "从救援点恢复后文件内容回到工作区",
          (restoreClicked === "clicked" || restoreConfirmed === "clicked") && restored === content,
          JSON.stringify({ restoreClicked, restoreConfirmed, restored: restored.slice(0, 40) }),
        );
        await cdp.screenshot(join(SHOTS, "05-deep-restored.png"));

        // 时间线里应出现一条「文件恢复」节点
        await openDrawerTab(cdp, "回溯记录");
        await sleep(1200);
        const timelineKinds = await cdp.evaluate(`(() => {
          const root = document.querySelector(".dsh-srw-timeline");
          return root ? [...root.querySelectorAll(".dsh-srw-tl-node")].map((n) => n.getAttribute("data-kind")) : null;
        })()`);
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
        // 收尾：删掉测试文件，别把垃圾留在工作区。
        await rm(filePath, { force: true }).catch(() => {});
        check("测试文件已清理", !(await exists(filePath)), filePath);
      }
    }
  } catch (error) {
    check("桌面回归执行", false, error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.ws.close();
  }

  let failed = 0;
  for (const item of checks) {
    console.log((item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`));
    if (!item.ok) failed += 1;
  }
  console.log(`截图目录：${SHOTS}`);
  if (failed > 0) {
    console.error(`FAIL ${failed} 项桌面回归断言失败`);
    process.exitCode = 1;
  } else {
    console.log(`PASS 全部 ${checks.length} 项桌面回归断言通过`);
  }
};

await main();
