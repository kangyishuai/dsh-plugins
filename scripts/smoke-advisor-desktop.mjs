#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：advisor。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:advisor-desktop --require
//
// 覆盖（全部**只读**：不选模型、不跑 `/advisor ask`、不改任何设置值、不点保存、不碰任何模型接口）：
//   1. 插件已加载：client 半注入的 `style[data-plugin]`（失败时打印已注入的插件样式清单与排查命令）
//   2. 设置页卡片：账号菜单 →「设置」→「通用设置」→ 卡片加载出 provider/model 与预算 / 隐私 /
//      新增的「工作区」预算、「预览会发什么」、白名单、「确认跨 provider」；没有 `[data-advisor-error]`；
//      **不点保存、不改任何值**；关掉对话框并断言它消失（对照 `packages/advisor/locale/*.json` 断言文案）
//   3. 回合尾部顾问线：有 `.dsh-advisor-turn` 时断言 headline 是「顾问 · 严重度」；
//      没有就记 SKIP（本会话没有顾问记录）——**脚本不制造徵询**
//   4. `/advisor` 回车 → 宿主 popupSelect 浮层出现且**至少一项** → 聚焦搜索框按 Esc，浮层消失
//   5. `/advisor status` → 命令平面卡片里出现「模式：」「顾问：」
//   6. `/advisor doctor` → 命令平面卡片里至少一条以 ✅/⚠️/❌ 开头的检查行
//   7. 收尾：没有遗留浮层，输入框草稿清空
//
// `--advice`（opt-in；只读，但会展开**真实徵询**留下的记录）再加：
//   8. `/advisor report` 输出含「顾问报告」或「还没有顾问记录」
//   9. 有 `.dsh-advisor-turn` 时点开 headline，断言展开体含 `model · usage`，再点一次收起
//   10. 打印一行 COST 提醒——本段对应一次真实付费徵询，但脚本不负责发起（也绝不发起）
//
// 安全前置：当前会话正在跑回合、输入框不可编辑、或输入框里已有**别人的草稿**时，
// 脚本会在敲任何键**之前**判失败并退出——绝不打断/覆盖用户正在进行的对话。
// `/advisor status` / `doctor` 会在当前会话的命令平面留下两条只读命令记录（不进模型历史、
// 不调用模型推理）；其余断言只开关浮层 / 设置对话框（`--advice` 会点开再收起顾问线），
// 不写设置、不发消息、不徵询。端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
//
// 选择器都来自宿主真实 DOM（不自己发明）：
//   - popupSelect 外壳（dsh-client-ui-commands）：搜索框 `<input type="text">` + `[role="listbox"]`
//     + `[role="option"]`，容器 aria-label 形如「/advisor 选项」；斜杠菜单是 `[data-trigger-menu]`，
//     里面没有输入框，所以不会和选择器混淆。
//   - 命令输出（dsh-client-ui-chat）：`[data-chat-flow-kind="command"]` 的卡片；输出文本（即使折叠）
//     也在 `textContent` 里。
//   - 设置对话框（宿主）：`[role="dialog"]`，settings 那个还带 `data-shortcut-modal="settings"`；
//     入口是账号菜单 button（`aria-label` 含「账号」/「Account」，英文界面也能匹配）。
//   - 设置卡（advisor client 半）：`[data-advisor-settings]`、`[data-advisor-provider]`、
//     `[data-advisor-model]`、`[data-advisor-error]`；文案断言从仓库 locale 读，不在这里抄中文。
//   - 顾问线（advisor client 半）：`.dsh-advisor-turn` > `.dsh-advisor-turn-head` + `.dsh-advisor-turn-body`。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { zstdDecompressSync } from "node:zlib";

const SHOTS = join(tmpdir(), "dsh-advisor-desktop-shots");
const PLUGIN = "@kangyishuai/dsh-advisor";
const COMPOSER = "[data-composer-input]";
const LOCALE_DIR = new URL("../packages/advisor/locale/", import.meta.url);
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从仓库 locale 读一组文案（中文 + 英文）。文案断言用真实 locale 而不是在脚本里再抄一遍：
 * 改文案时断言跟着走；英文界面也能命中。
 * @param {string[]} keys
 * @returns {Promise<Map<string, string[]>>}
 */
async function readLocaleText(keys) {
  /** @type {Map<string, string[]>} */
  const out = new Map(keys.map((key) => [key, []]));
  for (const lang of ["zh", "en"]) {
    try {
      const dict = JSON.parse(await readFile(new URL(`${lang}.json`, LOCALE_DIR), "utf8"));
      const namespace = dict?.advisor ?? {};
      for (const key of keys) {
        const text = namespace[key];
        const bucket = out.get(key);
        if (bucket === undefined || typeof text !== "string" || text.trim() === "") continue;
        if (!bucket.includes(text.trim())) bucket.push(text.trim());
      }
    } catch {
      // 一份读不到就用另一份；两份都读不到时，调用方会把「缺文案」算成失败并打出来。
    }
  }
  return out;
}

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

/**
 * 派发一次真实按键（keyDown + keyUp）。macOS Electron 用 nativeVirtualKeyCode 更稳。
 * @param {any} cdp
 * @param {string} key
 * @param {string} code
 * @param {number} windowsVirtualKeyCode
 * @param {number} nativeVirtualKeyCode
 */
async function pressKey(cdp, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode,
    });
  }
}

/** @param {any} cdp */
const pressEnter = (cdp) => pressKey(cdp, "Enter", "Enter", 13, 36);

/** @param {any} cdp */
const pressEscape = (cdp) => pressKey(cdp, "Escape", "Escape", 27, 53);

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

// ---------------------------------------------------------------------------
// 页面 / 选择器 / 命令输出的探针（都在渲染进程里算完再回传，失败时能看到「看到了什么」）
// ---------------------------------------------------------------------------

const PAGE_STATE = `(() => {
  const composer = document.querySelector(${JSON.stringify(COMPOSER)});
  const visible = (el) => {
    if (el === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const pluginStyles = [...document.querySelectorAll("style[data-plugin]")]
    .map((node) => node.dataset.plugin || "")
    .filter(Boolean);
  return {
    title: document.title,
    pluginStyles: pluginStyles.filter((id) => id.includes("advisor")),
    allPluginStyles: pluginStyles.slice(-12),
    composer: composer === null ? null : {
      editable: composer.getAttribute("contenteditable") === "true",
      visible: visible(composer),
      text: composer.textContent || "",
    },
    turnRunning: [...document.querySelectorAll("button")].some((button) => {
      const label = button.getAttribute("aria-label") || "";
      const title = button.getAttribute("title") || "";
      return /停止|Stop/i.test(label + " " + title);
    }),
    commandCount: document.querySelectorAll('[data-chat-flow-kind="command"]').length,
  };
})()`;

/**
 * 找宿主 popupSelect 浮层。两条判定：
 *  1) 官方外壳的 aria-label（`/advisor 选项`，command 名不随 locale 变）；
 *  2) 结构兜底：可见的文本输入框（选择器搜索框）与 `[role="listbox"]` 在同一个容器里。
 *     斜杠菜单 `[data-trigger-menu]` 里没有输入框，不会被误判。
 */
const POPUP_STATE = `(() => {
  const visible = (el) => {
    if (el === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const read = (card, via) => {
    const listbox = card.querySelector('[role="listbox"]');
    const options = listbox === null ? [] : [...listbox.querySelectorAll('[role="option"]')];
    const input = card.querySelector("input");
    return {
      via,
      optionCount: options.length,
      labels: options
        .slice(0, 8)
        .map((option) => (option.textContent || "").replace(/\\s+/gu, " ").trim().slice(0, 80)),
      placeholder: input === null ? "" : input.getAttribute("placeholder") || "",
      text: (card.textContent || "").replace(/\\s+/gu, " ").trim().slice(0, 240),
    };
  };
  /** @type {any[]} */
  const cards = [];
  for (const el of document.querySelectorAll('[aria-label*="/advisor"]')) {
    if (!visible(el)) continue;
    if (el.querySelector("input") === null && el.querySelector('[role="listbox"]') === null) continue;
    cards.push(read(el, "aria-label"));
  }
  if (cards.length === 0) {
    for (const input of document.querySelectorAll('input[type="text"], input:not([type])')) {
      if (!visible(input)) continue;
      let node = input.parentElement;
      for (let depth = 0; depth < 3 && node !== null; depth += 1) {
        if (node.querySelector('[role="listbox"]') !== null) {
          cards.push(read(node, "dom"));
          break;
        }
        node = node.parentElement;
      }
    }
  }
  const chosen = cards.find((card) => card.optionCount > 0) ?? cards[0] ?? null;
  return { found: cards.length > 0, chosen };
})()`;

/** 把焦点放回选择器的搜索框（Esc 只有在浮层内部才会被宿主 popupSelect 处理）。 */
const FOCUS_POPUP = `(() => {
  const visible = (el) => {
    if (el === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (const el of document.querySelectorAll('[aria-label*="/advisor"]')) {
    if (!visible(el)) continue;
    const input = el.querySelector("input");
    if (input !== null) {
      input.focus();
      return true;
    }
  }
  for (const input of document.querySelectorAll('input[type="text"], input:not([type])')) {
    if (!visible(input)) continue;
    let node = input.parentElement;
    for (let depth = 0; depth < 3 && node !== null; depth += 1) {
      if (node.querySelector('[role="listbox"]') !== null) {
        input.focus();
        return true;
      }
      node = node.parentElement;
    }
  }
  return false;
})()`;

/** 命令平面：最后一张命令卡片（输出文本即使折叠也在 textContent 里）。 */
const COMMAND_STATE = `(() => {
  const nodes = [...document.querySelectorAll('[data-chat-flow-kind="command"]')];
  return {
    count: nodes.length,
    last: nodes.length === 0 ? "" : (nodes[nodes.length - 1].textContent || "").slice(0, 2000),
  };
})()`;

// ---------------------------------------------------------------------------
// 命令输出以**会话日志**为准：宿主的命令卡片在 DOM 里是折叠的，展开后 innerText 仍为空
// （真机确认过）。所以 /advisor status 与 /advisor doctor 的断言读 `command/done.data.text`。
// ---------------------------------------------------------------------------

/** 当前会话 id（宿主的会话根元素带 data-conversation-session）。 */
const SESSION_ID = `(() => {
  const el = document.querySelector('[data-conversation-session]');
  return el === null ? "" : String(el.getAttribute('data-conversation-session') || '');
})()`;

/** @param {string} sessionId */
async function commandTexts(sessionId) {
  if (sessionId === "") return [];
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
  const roots = join(home, "sessions");
  /** @type {string[]} */
  const files = [];
  const walk = async (/** @type {string} */ dir, /** @type {number} */ depth) => {
    if (depth > 3) return;
    /** @type {import("node:fs").Dirent[]} */
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === sessionId) {
          try {
            for (const inner of await readdir(join(dir, entry.name))) {
              if (inner.startsWith("session.v4.jsonl")) files.push(join(dir, entry.name, inner));
            }
          } catch {
            /* 跳过 */
          }
        } else {
          await walk(join(dir, entry.name), depth + 1);
        }
      }
    }
  };
  await walk(roots, 0);
  /** @type {string[]} */
  const texts = [];
  for (const file of files) {
    let text = "";
    try {
      const buffer = await readFile(file);
      if (file.endsWith(".zstd")) {
        const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
        let start = buffer.indexOf(magic);
        while (start >= 0) {
          const next = buffer.indexOf(magic, start + 4);
          const frame = buffer.subarray(start, next < 0 ? buffer.length : next);
          try {
            text += zstdDecompressSync(frame).toString("utf8");
          } catch {
            /* 跳过坏帧 */
          }
          if (next < 0) break;
          start = next;
        }
      } else {
        text = buffer.toString("utf8");
      }
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      /** @type {any} */
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== "command/done") continue;
      const value = event?.data?.text;
      if (typeof value === "string" && value !== "") texts.push(value);
    }
  }
  return texts;
}

/**
 * 等会话日志里出现满足 predicate 的新命令输出。
 * @param {string} sessionId @param {(text: string) => boolean} predicate @param {number} timeoutMs
 */
async function waitForCommandText(sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  /** @type {string} */
  let last = "";
  while (Date.now() < deadline) {
    const texts = await commandTexts(sessionId);
    for (const text of texts) {
      if (predicate(text)) return { ok: true, text };
    }
    last = texts.length === 0 ? "" : texts[texts.length - 1];
    await sleep(400);
  }
  return { ok: false, text: last };
}

// ---------------------------------------------------------------------------
// 设置对话框 / 设置卡 / 顾问线的探针
// ---------------------------------------------------------------------------

/**
 * 设置对话框：宿主的是 `[role="dialog"]`（settings 那个还带 `data-shortcut-modal="settings"`）。
 * 只认「有 settings 标记 / 有顾问卡 / 左栏有通用设置 tab」的那个，避免把别的弹窗当设置。
 * 英文界面同样命中（`General`）。
 */
const SETTINGS_SURFACE = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const tabs = (el) =>
    [...el.querySelectorAll('[role="tab"]')]
      .filter(visible)
      .map((tab) => (tab.textContent || "").trim());
  // 宿主的左栏实际渲染成 button（不是 role=tab），所以两条都认。
  const navLabels = (el) =>
    [...el.querySelectorAll('[role="tab"], button')]
      .filter(visible)
      .map((item) => (item.textContent || "").trim());
  const isSettings = (el) =>
    el.getAttribute("data-shortcut-modal") === "settings" ||
    el.querySelector("[data-advisor-settings]") !== null ||
    navLabels(el).some((label) => /^(通用设置|General)$/u.test(label));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const surface = dialogs.find(isSettings) ?? null;
  return {
    found: surface !== null,
    via:
      surface === null
        ? null
        : surface.getAttribute("data-shortcut-modal") === "settings"
          ? "data-shortcut-modal"
          : "role=dialog",
    dialogs: dialogs.length,
    tabs: surface === null ? [] : tabs(surface),
    hasAdvisorCard: surface !== null && surface.querySelector("[data-advisor-settings]") !== null,
    title: surface === null ? "" : (surface.getAttribute("aria-label") || "").slice(0, 80),
  };
})()`;

/**
 * 账号菜单入口：中英文 `aria-label` 优先；兜底左侧栏底部「只显示用户名」的按钮
 * （用户名因人而异，不能写死，所以只按形状找，找不到就判失败并打印看到的按钮）。
 */
const ACCOUNT_TRIGGER = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const point = (el, via) => {
    const rect = el.getBoundingClientRect();
    return {
      via,
      aria: el.getAttribute("aria-label") || "",
      text: (el.textContent || "").trim().slice(0, 40),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  };
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  const aria = buttons.find((el) =>
    /账号|帐号|账户|account|profile/iu.test(el.getAttribute("aria-label") || ""),
  );
  if (aria !== undefined) return point(aria, "aria-label");
  const footer = buttons.filter((el) => {
    const rect = el.getBoundingClientRect();
    const text = (el.textContent || "").trim();
    return (
      rect.x < 360 &&
      rect.y > window.innerHeight * 0.7 &&
      /^\\S{1,32}$/u.test(text) &&
      !/新建会话|插件|自动化任务|回收站|更多|设置|搜索|归档|置顶|展开|收起/u.test(text)
    );
  });
  return footer.length === 0 ? null : point(footer[footer.length - 1], "sidebar-footer");
})()`;

/** 账号菜单里的「设置」项（`role=menuitem`）；找不到时把可见项一起打出来。 */
const SETTINGS_MENU_ITEM = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const items = [
    ...document.querySelectorAll('[role="menuitem"], [role="menu"] button, button'),
  ].filter(visible);
  const labels = items
    .map((el) => (el.textContent || "").trim())
    .filter((label) => label !== "")
    .slice(0, 20);
  const hit = items.find((el) => /^(设置|Settings)/u.test((el.textContent || "").trim()));
  if (hit === undefined) return { found: false, labels };
  const rect = hit.getBoundingClientRect();
  return {
    found: true,
    labels,
    text: (hit.textContent || "").trim(),
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
})()`;

/** 设置对话框左栏的「通用设置」tab（`role=tab` 优先，按钮兜底；容忍英文 `General`）。 */
const GENERAL_TAB = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const surfaces = [
    ...document.querySelectorAll('[role="dialog"], [data-shortcut-modal]'),
  ].filter(visible);
  const targets = surfaces.flatMap((surface) =>
    [...surface.querySelectorAll('[role="tab"], button')].filter(visible),
  );
  const seen = targets
    .map((el) => (el.textContent || "").trim())
    .filter((label) => label !== "")
    .slice(0, 24);
  const hit = targets.find((el) => /^(通用设置|General)$/u.test((el.textContent || "").trim()));
  if (hit === undefined) return { found: false, seen };
  const rect = hit.getBoundingClientRect();
  return {
    found: true,
    seen,
    role: hit.getAttribute("role") || hit.tagName.toLowerCase(),
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
})()`;

/** 设置卡：provider/model 下拉、错误横幅，以及文案断言要用的整段文本。 */
const ADVISOR_CARD = `(() => {
  const root = document.querySelector("[data-advisor-settings]");
  if (root === null) return { found: false };
  const optionCount = (select) =>
    select === null ? null : [...select.options].filter((option) => (option.value || "") !== "").length;
  const provider = root.querySelector("[data-advisor-provider]");
  const model = root.querySelector("[data-advisor-model]");
  const error = root.querySelector("[data-advisor-error]") ?? document.querySelector("[data-advisor-error]");
  const confirm = root.querySelector("[data-advisor-confirm]");
  return {
    found: true,
    error: error === null ? null : (error.innerText || error.textContent || "").trim().slice(0, 240),
    text: (root.innerText || "").replace(/\\s+/gu, " ").trim().slice(0, 12000),
    providerOptions: optionCount(provider),
    providerValue: provider === null ? null : provider.value,
    providerLabels:
      provider === null
        ? []
        : [...provider.options]
            .filter((option) => (option.value || "") !== "")
            .slice(0, 6)
            .map((option) => (option.textContent || "").trim()),
    modelExists: model !== null,
    modelOptions: optionCount(model),
    groups: [...root.querySelectorAll("[data-advisor-group]")].map((el) =>
      el.getAttribute("data-advisor-group"),
    ),
    confirmVisible: confirm !== null,
    confirmText: confirm === null ? "" : (confirm.textContent || "").trim(),
    previewButton: root.querySelector("[data-advisor-preview-run]") !== null,
    poolLine: root.querySelector("[data-advisor-pool]") !== null,
  };
})()`;

/** off 紧凑态点「配置顾问」；已启用时无按钮，直接 no-op。 */
const CONFIGURE_CARD = `(() => {
  const root = document.querySelector("[data-advisor-settings]");
  if (root === null) return { found: false };
  const configure = root.querySelector("[data-advisor-configure]");
  if (configure !== null) configure.click();
  return { found: true, clicked: configure !== null };
})()`;

/** 展开高级与状态两个折叠区；只点 toggle，不改任何值。 */
const EXPAND_DISCLOSURES = `(() => {
  const root = document.querySelector("[data-advisor-settings]");
  if (root === null) return { found: false };
  const opened = [];
  for (const key of ["advanced", "status"]) {
    const toggle = root.querySelector('[data-advisor-disclosure-toggle="' + key + '"]');
    if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") {
      toggle.click();
      opened.push(key);
    }
  }
  return { found: true, opened };
})()`;

/**
 * 回合尾部顾问线：取最后一条 `.dsh-advisor-turn`。
 * headline 文本形如「顾问 · 轻微 <摘要>」（declined 时是「顾问认为无需建议」）。
 */
const ADVISOR_TURNS = `(() => {
  const compact = (value) => (value || "").replace(/\\s+/gu, " ").trim();
  const nodes = [...document.querySelectorAll(".dsh-advisor-turn")];
  const node = nodes.length === 0 ? null : nodes[nodes.length - 1];
  const head = node === null ? null : (node.querySelector(".dsh-advisor-turn-head") ?? node);
  const body = node === null ? null : node.querySelector(".dsh-advisor-turn-body");
  return {
    count: nodes.length,
    turn: node === null ? null : node.getAttribute("data-advisor-turn"),
    status: node === null ? null : node.getAttribute("data-advisor-status"),
    head: compact(head === null ? "" : head.innerText || head.textContent),
    headExpanded: head === null ? null : head.getAttribute("aria-expanded"),
    body: compact(body === null ? "" : body.innerText || body.textContent),
  };
})()`;

/** 设置对话框的「关闭」按钮（没有时调用方按 Esc）。 */
const CLOSE_BUTTON = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const buttons = dialogs.flatMap((dialog) => [...dialog.querySelectorAll("button")].filter(visible));
  const hit = buttons.find(
    (el) =>
      /^(关闭|Close)$/iu.test((el.textContent || "").trim()) ||
      /^(关闭|close)/iu.test(el.getAttribute("aria-label") || ""),
  );
  if (hit === undefined) return null;
  const rect = hit.getBoundingClientRect();
  return {
    text: (hit.textContent || "").trim(),
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
})()`;

/** 输入框当前文本（Lexical 空段落的 textContent 是空串）。 */

const COMPOSER_TEXT = `(() => {
  const el = document.querySelector(${JSON.stringify(COMPOSER)});
  return el === null ? null : (el.textContent || "");
})()`;

/** @param {any} value */
const asText = (value) => (typeof value === "string" ? value : "");

/**
 * 读输入框当前草稿文本（拿不到就是空串）。
 * @param {any} cdp
 */
const readComposer = async (cdp) => asText(await cdp.evaluate(COMPOSER_TEXT));

/**
 * 清空输入框草稿（只清脚本自己写进去的；调用前已确认原本为空）。
 *
 * 实现必须走**真实键盘事件**：Lexical 只认 beforeinput/键盘路径，
 * 直接改 DOM 选区 + execCommand("delete") 在它身上不可靠（实测会把上一条命令留在框里，
 * 于是下一条命令被拼成 `/advisor/advisor status`）。这里是本脚本唯一允许失败重试的交互。
 * @param {any} cdp
 * @returns {Promise<boolean>} 是否最终确认清空
 */
async function clearComposer(cdp) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cdp
      .evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(COMPOSER)}); if (el !== null) el.focus(); return true; })()`,
      )
      .catch(() => false);
    // macOS 用 Meta(4)，其它平台用 Ctrl(2)；两个都发一遍，没命中的那个是空操作。
    for (const modifiers of [4, 2]) {
      for (const type of ["keyDown", "keyUp"]) {
        await cdp
          .send("Input.dispatchKeyEvent", {
            type,
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 0,
            modifiers,
          })
          .catch(() => undefined);
      }
    }
    await pressKey(cdp, "Backspace", "Backspace", 8, 51);
    await sleep(250);
    const text = await readComposer(cdp);
    if (text.trim() === "") return true;
  }

  // 兜底：DOM 选区 + execCommand（最后再试一次，成败以读回为准）。
  await cdp
    .evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(COMPOSER)});
        if (el === null) return false;
        el.focus();
        const selection = document.getSelection();
        if (selection === null) return false;
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("delete", false);
        return true;
      })()`,
    )
    .catch(() => false);
  await sleep(200);
  return (await readComposer(cdp)).trim() === "";
}

/**
 * 往 composer 里写一行命令：先清空，再用 CDP 的 insertText 一次性插入（避免丢字/追加）。
 * @param {any} cdp
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function typeIntoComposer(cdp, text) {
  const cleared = await clearComposer(cdp);
  if (!cleared) console.log(`      警告：清空输入框失败，命令可能被追加到残留文本后面`);
  await cdp
    .evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(COMPOSER)}); if (el !== null) el.focus(); return true; })()`,
    )
    .catch(() => false);
  try {
    await cdp.send("Input.insertText", { text });
  } catch (_error) {
    await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(COMPOSER)});
      if (el === null) return false;
      el.focus();
      try {
        return document.execCommand("insertText", false, ${JSON.stringify(text)});
      } catch (_inner) {
        el.textContent = ${JSON.stringify(text)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    })()`);
  }
  await sleep(300);
  return true;
}

/**
 * 轮询一个探针表达式，直到 predicate 成立或超时；返回最后一次看到的值（失败时可打印）。
 * @param {any} cdp
 * @param {string} expression
 * @param {(value: any) => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(cdp, expression, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  /** @type {any} */
  let value = null;
  let error = "";
  while (Date.now() < deadline) {
    try {
      value = await cdp.evaluate(expression);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (predicate(value)) return { ok: true, value, error };
    await sleep(250);
  }
  return { ok: false, value, error };
}

/**
 * 等输入框里的文本变成期望值（execCommand 之后 Lexical 可能还差一拍才提交 state）。
 * @param {any} cdp
 * @param {string} expected
 * @param {number} timeoutMs
 */
async function waitForComposerText(cdp, expected, timeoutMs) {
  return waitFor(
    cdp,
    COMPOSER_TEXT,
    (value) => typeof value === "string" && value.trim() === expected,
    timeoutMs,
  );
}

/**
 * 关闭选择器：先聚焦搜索框，再按 Esc；返回是否真的关掉了（调用方负责重试一次）。
 * @param {any} cdp
 */
async function closePicker(cdp) {
  const focused = await cdp.evaluate(FOCUS_POPUP).catch(() => false);
  await pressEscape(cdp);
  const closed = await waitFor(cdp, POPUP_STATE, (value) => value?.found !== true, 5_000);
  return {
    ok: closed.ok,
    detail: JSON.stringify({ focused, found: closed.value?.found ?? null, error: closed.error }),
  };
}

/** @param {any} value */
const toCount = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * 用 CDP 原生鼠标事件点一个坐标（React 只认真实事件；不要盲点坐标，坐标先由探针从 rect 取）。
 * @param {any} cdp
 * @param {{x: number, y: number}} point
 */
async function clickPoint(cdp, point) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      // Radix/宿主菜单会在 pointerdown 里检查 buttons；缺了它菜单不会展开（实测账号菜单就是这样）。
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await sleep(80);
  }
}

/**
 * 打开 账号菜单 →「设置」→「通用设置」。只开对话框，不碰任何设置值。
 * @param {any} cdp
 * @returns {Promise<{ok: boolean, via: string, detail: string}>}
 */
async function openSettings(cdp) {
  // 账号菜单可能已经是打开的（用户点开的），那就直接点「设置」，不要把它 toggle 关掉。
  let item = await cdp.evaluate(SETTINGS_MENU_ITEM).catch(() => null);
  let trigger = null;
  if (item?.found !== true) {
    trigger = await cdp.evaluate(ACCOUNT_TRIGGER).catch(() => null);
    if (trigger === null) {
      return {
        ok: false,
        via: "none",
        detail: "找不到账号菜单入口（aria-label 不含账号/Account，左下角也没有用户名按钮）",
      };
    }
    await clickPoint(cdp, trigger);
    // 菜单有展开动画：轮询而不是死等一个固定毫秒数。
    const menu = await waitFor(cdp, SETTINGS_MENU_ITEM, (value) => value?.found === true, 3000);
    item = menu.value ?? null;
    if (item?.found !== true) {
      await pressEscape(cdp);
      return { ok: false, via: trigger.via, detail: JSON.stringify({ trigger, menu: item }) };
    }
  }
  await clickPoint(cdp, item);
  await sleep(1200);
  let surface = await waitFor(cdp, SETTINGS_SURFACE, (value) => value?.found === true, 5000);
  let tab = null;
  if (surface.ok && surface.value?.hasAdvisorCard !== true) {
    tab = await cdp.evaluate(GENERAL_TAB).catch(() => null);
    if (tab?.found === true) {
      await clickPoint(cdp, tab);
      await sleep(1200);
      surface = await waitFor(cdp, SETTINGS_SURFACE, (value) => value?.found === true, 4000);
    }
  }
  return {
    ok: surface.ok,
    via: trigger === null ? "already-open-menu" : trigger.via,
    detail: JSON.stringify({ trigger, item, tab, surface: surface.value ?? null }),
  };
}

/**
 * 关掉设置对话框：先点「关闭」，没有就 Esc；两次都关不掉就判失败（并打印当时看到的对话框）。
 * @param {any} cdp
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function closeSettings(cdp) {
  const surface = await cdp.evaluate(SETTINGS_SURFACE).catch(() => null);
  if (surface?.found !== true) {
    return {
      ok: true,
      detail: JSON.stringify({
        surface: surface ?? null,
        note: "设置对话框已经不在了，没有按任何键",
      }),
    };
  }
  const button = await cdp.evaluate(CLOSE_BUTTON).catch(() => null);
  if (button === null) await pressEscape(cdp);
  else await clickPoint(cdp, button);
  let gone = await waitFor(cdp, SETTINGS_SURFACE, (value) => value?.found !== true, 4000);
  if (!gone.ok) {
    await pressEscape(cdp);
    gone = await waitFor(cdp, SETTINGS_SURFACE, (value) => value?.found !== true, 4000);
  }
  return {
    ok: gone.ok,
    detail: JSON.stringify({
      closeButton: button === null ? null : button.text,
      surface: gone.value ?? null,
    }),
  };
}

/**
 * 展开/收起最后一条顾问线；已经处于目标状态时不再点（保证「点一次 = 展开」）。
 * @param {any} cdp
 * @param {boolean} expand
 * @returns {Promise<{ok: boolean, value: any, detail: string}>}
 */
async function toggleAdviceTurn(cdp, expand) {
  const want = expand ? "true" : "false";
  const before = await cdp.evaluate(ADVISOR_TURNS).catch(() => null);
  if (before === null || toCount(before.count) === 0) {
    return { ok: false, value: before, detail: "没有 .dsh-advisor-turn 节点" };
  }
  if (String(before.headExpanded) !== want) {
    await cdp.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(".dsh-advisor-turn")];
      const head = nodes.length === 0 ? null : nodes[nodes.length - 1].querySelector(".dsh-advisor-turn-head");
      if (head === null) return false;
      head.click();
      return true;
    })()`);
  }
  const waited = await waitFor(
    cdp,
    ADVISOR_TURNS,
    (value) =>
      value !== null &&
      String(value?.headExpanded) === want &&
      (want === "true" ? String(value?.body ?? "") !== "" : String(value?.body ?? "") === ""),
    4000,
  );
  return { ok: waited.ok, value: waited.value, detail: JSON.stringify(waited.value ?? null) };
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      require: { type: "boolean", default: false },
      // opt-in：多读一段真实徵询记录（report + 展开顾问线）。只读，但对应一次真花钱的调用。
      advice: { type: "boolean", default: false },
    },
    // 容忍 `pnpm smoke:advisor-desktop -- --require`：多余的 `--` 会被当成位置参数。
    allowPositionals: true,
  });
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  /** @type {{ name: string, ok: boolean, detail: string, skip?: boolean }[]} */
  const checks = [];
  /**
   * @param {string} name
   * @param {boolean} ok
   * @param {string} [detail]
   */
  const check = (name, ok, detail = "") => checks.push({ name, ok, detail });
  /**
   * @param {string} name
   * @param {string} reason
   */
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
        '提示：先带调试端口重启桌面版：open -a "DeepSeek Harness" --args --remote-debugging-port=9222',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`SKIP 无法连接 CDP（127.0.0.1:${port}）：${message}`);
    console.log("（发版门禁请加 --require：连不上端口将判为失败而不是跳过。）");
    return;
  }

  await mkdir(SHOTS, { recursive: true }).catch(() => {});
  // 紧接着别的 GUI 冒烟跑时，渲染线程可能还在忙；先等页面稳定再断言。
  await ensureReady(cdp);
  // 宿主的账号菜单是 Radix 菜单：窗口不在前台时点不开。点之前把它拉到前台。
  await cdp.send("Page.bringToFront").catch(() => undefined);
  // 只有本脚本真的往输入框里写过东西时才允许收尾清理——否则可能擦掉用户自己的草稿。
  let touchedComposer = false;
  // 只有本脚本自己打开过设置时，收尾才允许关它（用户开着的设置不动）。
  let settingsOpened = false;
  try {
    // ---------- A. 页面与插件加载 ----------
    const page = await cdp.evaluate(PAGE_STATE);
    check(
      "连接到 DSH 桌面 UI",
      typeof page?.title === "string" && page.title.length > 0,
      page?.title ?? "",
    );
    const pluginStyles = Array.isArray(page?.pluginStyles) ? page.pluginStyles : [];
    check("插件已加载（client 半样式注入）", pluginStyles.length > 0, JSON.stringify(pluginStyles));
    await cdp.screenshot(join(SHOTS, "01-overview.png"));

    let canInteract = pluginStyles.length > 0;
    if (!canInteract) {
      console.log(
        `      诊断：页面里没有 style[data-plugin] 含 "advisor"；最近注入的插件样式=${JSON.stringify(page?.allPluginStyles ?? [])}`,
      );
      console.log(
        `      诊断：大概率桌面 profile 没装 ${PLUGIN}，先 dsh plugin --profile desktop list 确认。`,
      );
      console.log("      插件没装就不往输入框里打字（避免在别人的会话里留下草稿/命令）。");
    }

    // ---------- B. 输入前的安全闸（只读原则，绝不打断正在进行对话） ----------
    if (canInteract) {
      const composer = page?.composer ?? null;
      const draft = composer === null ? null : String(composer.text ?? "");
      check(
        "当前会话空闲（没有正在跑的回合）",
        page?.turnRunning !== true,
        `turnRunning=${String(page?.turnRunning)}`,
      );
      check(
        "输入框可编辑且草稿为空（不覆盖用户草稿）",
        composer !== null &&
          composer.editable === true &&
          composer.visible === true &&
          (draft ?? "").trim() === "",
        JSON.stringify({ composer, draft }),
      );
      canInteract =
        page?.turnRunning !== true &&
        composer !== null &&
        composer.editable === true &&
        composer.visible === true &&
        (draft ?? "").trim() === "";
      if (!canInteract) {
        console.log("      不满足安全输入前置：按只读原则跳过所有会敲键盘的断言。");
      }
    }

    if (values.advice === true) {
      console.log(
        "COST: --advice 段对应一次真实徵询（本脚本不发起任何徵询，只读已有记录；真正的调用会花钱）。",
      );
    }

    // 设置段的断言名先集中定义，安全闸不满足时也要按同名记 SKIP（明细里不丢项）。
    const settingsNames = {
      open: "打开 设置 →「通用设置」",
      card: "设置卡加载（[data-advisor-settings] 存在且没有 [data-advisor-error]）",
      selects: "设置卡有 provider / model 下拉，且 provider 至少 1 个候选",
      fields: "设置卡出现新增字段（工作区预算 / 预览会发什么 / 模型白名单）",
      confirm: "设置卡出现「确认跨 provider 发送」按钮",
      close: "关闭设置对话框（对话框消失）",
    };

    // ---------- C. 设置页卡片（只读：打开 → 断言 → 关掉；不点保存、不改任何值） ----------
    let settingsAlreadyOpen = false;
    if (canInteract) {
      const preexisting = await cdp.evaluate(SETTINGS_SURFACE).catch(() => null);
      if (preexisting?.found === true) {
        // 用户已经开着设置（可能有未保存的改动）：绝不自动关闭，也不在里面点来点去。
        settingsAlreadyOpen = true;
        for (const name of Object.values(settingsNames)) {
          skip(name, "设置对话框本来就在打开状态（可能有未保存改动），按只读原则不自动关闭");
        }
      } else {
        const opened = await openSettings(cdp);
        check(settingsNames.open, opened.ok, opened.detail);
        settingsOpened = opened.ok;
        if (!opened.ok) {
          for (const name of [
            settingsNames.card,
            settingsNames.selects,
            settingsNames.fields,
            settingsNames.confirm,
          ]) {
            skip(name, "设置没有打开，无法断言；详见「打开 设置 →「通用设置」」的 detail");
          }
          skip(settingsNames.close, "设置没有打开，无需关闭");
        } else {
          const card = await waitFor(
            cdp,
            ADVISOR_CARD,
            (value) => value?.found === true && value?.error === null,
            12_000,
          );
          // 默认 off 只显示紧凑态；点「配置顾问」并展开高级/状态后再断言。
          // 只点展开按钮，不改任何值，保存按钮的语义不受影响。
          await cdp.evaluate(CONFIGURE_CARD).catch(() => false);
          await sleep(300);
          await cdp.evaluate(EXPAND_DISCLOSURES).catch(() => false);
          await sleep(300);
          const expandedCard = await cdp.evaluate(ADVISOR_CARD).catch(() => null);
          const value = expandedCard?.value ?? card.value ?? null;
          check(
            settingsNames.card,
            card.ok && value?.found === true && value?.error === null,
            JSON.stringify({
              error: value?.error ?? null,
              found: value?.found ?? false,
              text: typeof value?.text === "string" ? value.text.slice(0, 300) : "",
            }),
          );
          check(
            settingsNames.selects,
            value?.found === true &&
              toCount(value?.providerOptions) >= 1 &&
              value?.modelExists === true,
            JSON.stringify({
              providerOptions: value?.providerOptions ?? null,
              providerValue: value?.providerValue ?? null,
              providerLabels: value?.providerLabels ?? [],
              modelExists: value?.modelExists ?? null,
              modelOptions: value?.modelOptions ?? null,
              groups: value?.groups ?? [],
            }),
          );

          // 新增字段的文案从仓库 locale 读（中文 + 英文都认），避免脚本与文案漂移。
          const fieldLabels = await readLocaleText([
            "settings.budget.workspaceMaxCallsPerDay",
            "settings.budget.workspaceMaxCostPerDayUsd",
            "settings.preview.run",
            "settings.advanced.allowedModels",
          ]);
          const cardText = typeof value?.text === "string" ? value.text : "";
          /** @type {{key: string, candidates: string[]}[]} */
          const missingFields = [];
          /** @type {string[]} */
          const seenFields = [];
          for (const key of fieldLabels.keys()) {
            const candidates = fieldLabels.get(key) ?? [];
            const hit = candidates.find((label) => cardText.includes(label)) ?? null;
            if (hit === null) missingFields.push({ key, candidates });
            else seenFields.push(hit);
          }
          check(
            settingsNames.fields,
            value?.found === true && missingFields.length === 0,
            JSON.stringify({
              seen: seenFields,
              missing: missingFields,
              hint:
                missingFields.length === 0
                  ? undefined
                  : "卡片里没有这些字段：若桌面装的是旧构建，先 pnpm pack + dsh plugin add 再重跑",
            }),
          );

          const providerValue = typeof value?.providerValue === "string" ? value.providerValue : "";
          const confirmLabels = (await readLocaleText(["settings.confirm.run"])).get(
            "settings.confirm.run",
          );
          if (value?.found !== true) {
            skip(settingsNames.confirm, "设置卡没有加载，无法断言确认按钮");
          } else if (providerValue === "") {
            skip(settingsNames.confirm, "没有选中 provider（卡片按设计不渲染确认按钮）");
          } else {
            const confirmText = String(value?.confirmText ?? "");
            check(
              settingsNames.confirm,
              value?.confirmVisible === true &&
                (confirmLabels ?? []).some((label) => confirmText.includes(label)),
              JSON.stringify({
                providerValue,
                confirmVisible: value?.confirmVisible ?? null,
                confirmText,
                expected: confirmLabels ?? [],
              }),
            );
          }
          // 卡片在设置页里通常要往下滚才看得见；截图前滚到它，留一份能看懂的证据（不改值）。
          await cdp
            .evaluate(
              `(() => { const root = document.querySelector("[data-advisor-settings]"); if (root !== null) root.scrollIntoView({ block: "center" }); return true; })()`,
            )
            .catch(() => false);
          await sleep(400);
          await cdp.screenshot(join(SHOTS, "settings-card.png"));

          const closed = await closeSettings(cdp);
          check(settingsNames.close, closed.ok, closed.detail);
          if (closed.ok) settingsOpened = false;
          else {
            // 关不掉的模态框会吞掉后面的输入：不要再往输入框打字。
            canInteract = false;
            console.log("      设置对话框关不掉：后续输入类断言改为 SKIP（模态框会吞掉输入）。");
          }
          await cdp.screenshot(join(SHOTS, "settings-closed.png"));
        }
      }
    } else {
      for (const name of Object.values(settingsNames)) {
        skip(name, "前置未满足（或插件未装），没有打开设置");
      }
    }

    if (settingsAlreadyOpen) {
      // 模态框会吞掉输入：不硬敲键盘，后面的输入类断言按安全闸不满足处理。
      canInteract = false;
      console.log(
        "      设置对话框本来就在打开状态：既不自动关闭，也不往输入框打字（模态框会吞掉输入）。",
      );
    }

    // ---------- D. 回合尾部顾问线（只读；没有记录就 SKIP，脚本不制造徵询） ----------
    const turnLineName = "回合尾部顾问线 headline 为「顾问 · 严重度」（declined 除外）";
    const turns =
      pluginStyles.length === 0 ? null : await cdp.evaluate(ADVISOR_TURNS).catch(() => null);
    if (pluginStyles.length === 0) {
      skip(turnLineName, "插件未加载，页面上不会有顾问线");
    } else if (turns === null || toCount(turns.count) === 0) {
      skip(turnLineName, "本会话没有顾问记录（页面没有 .dsh-advisor-turn 节点；脚本不制造徵询）");
    } else {
      const head = String(turns.head ?? "");
      const declined = /顾问认为无需建议|found nothing worth flagging/iu.test(head);
      const titled = /^(顾问|Advisor)\s*·/u.test(head);
      const severity = /轻微|关注|阻塞|\bnit\b|\bconcern\b|\bblocker\b/iu.test(head);
      check(
        turnLineName,
        declined || (titled && severity),
        JSON.stringify({
          count: turns.count,
          turn: turns.turn,
          status: turns.status,
          head,
          declined,
          titled,
          severity,
        }),
      );
      await cdp.screenshot(join(SHOTS, "turn-line.png"));
    }

    if (canInteract) {
      // ---------- E. `/advisor` → 宿主 popupSelect 浮层 ----------
      touchedComposer = true;
      const typedAdvisor = await typeIntoComposer(cdp, "/advisor");
      const advEntered = await waitForComposerText(cdp, "/advisor", 3000);
      check(
        "把 /advisor 写进输入框",
        advEntered.ok,
        JSON.stringify({ typed: typedAdvisor, draft: advEntered.value }),
      );
      await pressEnter(cdp);

      const opened = await waitFor(
        cdp,
        POPUP_STATE,
        (value) => value?.found === true && toCount(value?.chosen?.optionCount) > 0,
        12_000,
      );
      const chosen = opened.value?.chosen ?? null;
      check(
        "/advisor 弹出宿主选择器（浮层出现且至少一项）",
        opened.ok,
        JSON.stringify({
          found: opened.value?.found ?? false,
          optionCount: toCount(chosen?.optionCount),
          via: chosen?.via ?? null,
          placeholder: chosen?.placeholder ?? "",
          labels: chosen?.labels ?? [],
          error: opened.error,
        }),
      );

      if (opened.ok) {
        console.log(
          `      选择器 ${toCount(chosen?.optionCount)} 项（${chosen?.via ?? "?"}，搜索框占位=${JSON.stringify(chosen?.placeholder ?? "")}）：${JSON.stringify(chosen?.labels ?? [])}`,
        );
        await cdp.screenshot(join(SHOTS, "02-picker.png"));

        // Esc 关闭：焦点必须先在选择器里；第一次按不出就重试一次，但断言不降级。
        let closed = await closePicker(cdp);
        if (!closed.ok) closed = await closePicker(cdp);
        check("Esc 关闭选择器（浮层消失）", closed.ok, closed.detail);
        await cdp.screenshot(join(SHOTS, "03-picker-closed.png"));
      } else {
        const fallback = await cdp.evaluate(COMMAND_STATE).catch(() => null);
        console.log(
          `      诊断：没看到选择器；命令平面最后一条=${JSON.stringify(
            String(fallback?.last ?? "")
              .replace(/\s+/gu, " ")
              .slice(0, 240),
          )}`,
        );
        skip("Esc 关闭选择器（浮层消失）", "选择器没有打开，无法验证 Esc；详见上一条的诊断");
        await cdp.screenshot(join(SHOTS, "02-picker-missing.png"));
      }

      // Escape 不消费 token：清掉可能残留的 `/advisor` 草稿再跑命令。
      await clearComposer(cdp);
      await sleep(300);

      // ---------- F. `/advisor status` ----------
      const desktopSessionId = String((await cdp.evaluate(SESSION_ID).catch(() => "")) ?? "");
      const typedStatus = await typeIntoComposer(cdp, "/advisor status");
      const statusEntered = await waitForComposerText(cdp, "/advisor status", 5000);
      check(
        "把 /advisor status 写进输入框",
        statusEntered.ok,
        JSON.stringify({ typed: typedStatus, draft: statusEntered.value }),
      );
      await pressEnter(cdp);

      const status = await waitForCommandText(
        desktopSessionId,
        (text) => /模式[:：]|Mode:/u.test(text) && /顾问[:：]|Advisor:/u.test(text),
        12_000,
      );
      check(
        "/advisor status 输出「模式：」「顾问：」（会话日志）",
        status.ok,
        `session=${desktopSessionId} text=${JSON.stringify(String(status.text).replace(/\s+/gu, " ").slice(0, 300))}`,
      );
      if (status.ok) {
        console.log(`      status: ${String(status.text).replace(/\s+/gu, " ").slice(0, 240)}`);
      }
      await cdp.screenshot(join(SHOTS, "04-status.png"));

      // ---------- G. `/advisor doctor` ----------
      await clearComposer(cdp);
      await sleep(300);
      const typedDoctor = await typeIntoComposer(cdp, "/advisor doctor");
      const doctorEntered = await waitForComposerText(cdp, "/advisor doctor", 5000);
      check(
        "把 /advisor doctor 写进输入框",
        doctorEntered.ok,
        JSON.stringify({ typed: typedDoctor, draft: doctorEntered.value }),
      );
      await pressEnter(cdp);

      const doctor = await waitForCommandText(
        desktopSessionId,
        (text) => /(?:✅|⚠️|❌)\s/u.test(text),
        12_000,
      );
      const doctorText = String(doctor.text ?? "");
      check(
        "/advisor doctor 输出至少一条 ✅/⚠️/❌ 检查行（会话日志）",
        doctor.ok,
        `session=${desktopSessionId} text=${JSON.stringify(
          doctorText.replace(/\s+/gu, " ").slice(0, 300),
        )}`,
      );
      if (doctor.ok) {
        const lines = doctorText
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /✅|⚠️|❌/u.test(line));
        console.log(`      doctor: ${lines.slice(0, 6).join(" | ")}`);
      }
      await cdp.screenshot(join(SHOTS, "05-doctor.png"));

      // ---------- H. --advice：/advisor report + 展开顾问线（只读，不发起徵询） ----------
      if (values.advice === true) {
        await clearComposer(cdp);
        await sleep(300);
        const reportBaseline = toCount((await cdp.evaluate(COMMAND_STATE))?.count);
        const typedReport = await typeIntoComposer(cdp, "/advisor report");
        const reportEntered = await waitForComposerText(cdp, "/advisor report", 5000);
        check(
          "把 /advisor report 写进输入框",
          reportEntered.ok,
          JSON.stringify({ typed: typedReport, draft: reportEntered.value }),
        );
        await pressEnter(cdp);

        const report = await waitFor(
          cdp,
          COMMAND_STATE,
          (value) =>
            toCount(value?.count) > reportBaseline &&
            /顾问报告|还没有顾问记录/u.test(String(value?.last ?? "")),
          12_000,
        );
        const reportText = String(report.value?.last ?? "");
        check(
          "--advice：/advisor report 输出含「顾问报告」或「还没有顾问记录」",
          report.ok,
          `count=${toCount(report.value?.count)}（之前 ${reportBaseline}） text=${JSON.stringify(
            reportText.replace(/\s+/gu, " ").slice(0, 300),
          )} error=${report.error}`,
        );
        if (report.ok) {
          console.log(`      report: ${reportText.replace(/\s+/gu, " ").slice(0, 240)}`);
        }
        await cdp.screenshot(join(SHOTS, "advice-report.png"));

        const adviceTurns = await cdp.evaluate(ADVISOR_TURNS).catch(() => null);
        if (adviceTurns === null || toCount(adviceTurns.count) === 0) {
          skip("--advice：点开顾问线看到 model · usage", "本会话没有顾问记录（脚本不制造徵询）");
          skip("--advice：再点一次收起顾问线", "本会话没有顾问记录（脚本不制造徵询）");
        } else {
          const expanded = await toggleAdviceTurn(cdp, true);
          const body = String(expanded.value?.body ?? "");
          // 用量形如「910 in / 354 out / 4.2s」；formatTokens 会把上万缩成 9.1k，所以允许 k 后缀。
          const usage = /\d+(?:\.\d+)?k?\s*in\s*\/\s*\d+(?:\.\d+)?k?\s*out/u.test(body);
          check(
            "--advice：点开顾问线看到 model · usage",
            expanded.ok && usage,
            JSON.stringify({ ok: expanded.ok, usage, body: body.slice(0, 260) }),
          );
          await cdp.screenshot(join(SHOTS, "advice-turn.png"));
          const collapsed = await toggleAdviceTurn(cdp, false);
          check(
            "--advice：再点一次收起顾问线",
            collapsed.ok,
            JSON.stringify({
              ok: collapsed.ok,
              headExpanded: collapsed.value?.headExpanded ?? null,
            }),
          );
        }
      }

      // ---------- I. 收尾：不留浮层、不留草稿 ----------
      const leftover = await cdp.evaluate(POPUP_STATE);
      if (leftover?.found === true) await closePicker(cdp);
      await clearComposer(cdp);
      await sleep(400);
      const finalPopup = await cdp.evaluate(POPUP_STATE);
      const finalDraft = await readComposer(cdp);
      check(
        "收尾：没有遗留浮层、输入框草稿已清空",
        finalPopup?.found !== true && finalDraft.trim() === "",
        JSON.stringify({ popup: finalPopup?.found ?? false, draft: finalDraft }),
      );
      await cdp.screenshot(join(SHOTS, "06-final.png"));
    } else {
      skip("/advisor 弹出宿主选择器（浮层出现且至少一项）", "前置未满足，未敲键盘");
      skip("Esc 关闭选择器（浮层消失）", "前置未满足，未敲键盘");
      skip("/advisor status 输出「模式：」「顾问：」", "前置未满足，未敲键盘");
      skip("/advisor doctor 输出至少一条 ✅/⚠️/❌ 检查行", "前置未满足，未敲键盘");
      if (values.advice === true) {
        skip("把 /advisor report 写进输入框", "前置未满足，未敲键盘");
        skip(
          "--advice：/advisor report 输出含「顾问报告」或「还没有顾问记录」",
          "前置未满足，未敲键盘",
        );
        skip("--advice：点开顾问线看到 model · usage", "前置未满足，未敲键盘");
        skip("--advice：再点一次收起顾问线", "前置未满足，未敲键盘");
      }
      skip("收尾：没有遗留浮层、输入框草稿已清空", "前置未满足，没有输入过");
    }
  } catch (error) {
    check("桌面回归执行", false, error instanceof Error ? error.message : String(error));
  } finally {
    // 出错也要尽量还原界面：关掉浮层/设置、清掉**我们自己**写进去的草稿。
    if (cdp !== undefined && settingsOpened) {
      try {
        await closeSettings(cdp);
      } catch {
        /* 页面已不可达就不强求 */
      }
    }
    if (cdp !== undefined && touchedComposer) {
      try {
        const leftover = await cdp.evaluate(POPUP_STATE);
        if (leftover?.found === true) await closePicker(cdp);
        await clearComposer(cdp);
      } catch {
        /* 页面已不可达就不强求 */
      }
    }
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
    console.log(`PASS 全部 ${checks.length - skipped} 项桌面回归断言通过（SKIP ${skipped} 项）`);
  } else {
    console.log(`PASS 全部 ${checks.length} 项桌面回归断言通过`);
  }
};

await main();
