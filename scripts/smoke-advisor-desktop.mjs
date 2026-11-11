#!/usr/bin/env node
// @ts-check
// 桌面版（Electron）只读回归：advisor。
//
//   # 1) 带调试端口重启 DSH
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:advisor-desktop --require
//
// 覆盖（全部**只读**：不选模型、不跑 `/advisor ask`、不改设置、不碰任何模型接口）：
//   1. 插件已加载：client 半注入的 `style[data-plugin]`（失败时打印已注入的插件样式清单与排查命令）
//   2. `/advisor` 回车 → 宿主 popupSelect 浮层出现且**至少一项** → 聚焦搜索框按 Esc，浮层消失
//   3. `/advisor status` → 命令平面卡片里出现「模式：」「顾问：」
//   4. `/advisor doctor` → 命令平面卡片里至少一条以 ✅/⚠️/❌ 开头的检查行
//   5. 收尾：没有遗留浮层，输入框草稿清空
//
// 安全前置：当前会话正在跑回合、输入框不可编辑、或输入框里已有**别人的草稿**时，
// 脚本会在敲任何键**之前**判失败并退出——绝不打断/覆盖用户正在进行的对话。
// `/advisor status` / `doctor` 会在当前会话的命令平面留下两条只读命令记录（不进模型历史、
// 不调用模型推理）；其余断言都只开关浮层。端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
//
// 选择器都来自宿主真实 DOM（不自己发明）：
//   - popupSelect 外壳（dsh-client-ui-commands）：搜索框 `<input type="text">` + `[role="listbox"]`
//     + `[role="option"]`，容器 aria-label 形如「/advisor 选项」；斜杠菜单是 `[data-trigger-menu]`，
//     里面没有输入框，所以不会和选择器混淆。
//   - 命令输出（dsh-client-ui-chat）：`[data-chat-flow-kind="command"]` 的卡片；输出文本（即使折叠）
//     也在 `textContent` 里。
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-advisor-desktop-shots");
const PLUGIN = "@kangyishuai/dsh-advisor";
const COMPOSER = "[data-composer-input]";
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

const main = async () => {
  const { values } = parseArgs({
    options: { port: { type: "string" }, require: { type: "boolean", default: false } },
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
  // 只有本脚本真的往输入框里写过东西时才允许收尾清理——否则可能擦掉用户自己的草稿。
  let touchedComposer = false;
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

    if (canInteract) {
      // ---------- C. `/advisor` → 宿主 popupSelect 浮层 ----------
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

      // ---------- D. `/advisor status` ----------
      const statusBaseline = toCount((await cdp.evaluate(COMMAND_STATE))?.count);
      const typedStatus = await typeIntoComposer(cdp, "/advisor status");
      const statusEntered = await waitForComposerText(cdp, "/advisor status", 5000);
      check(
        "把 /advisor status 写进输入框",
        statusEntered.ok,
        JSON.stringify({ typed: typedStatus, draft: statusEntered.value }),
      );
      await pressEnter(cdp);

      const status = await waitFor(
        cdp,
        COMMAND_STATE,
        (value) =>
          toCount(value?.count) > statusBaseline &&
          /模式[:：]|Mode:/u.test(String(value?.last ?? "")) &&
          /顾问[:：]|Advisor:/u.test(String(value?.last ?? "")),
        12_000,
      );
      const statusText = String(status.value?.last ?? "");
      check(
        "/advisor status 输出「模式：」「顾问：」",
        status.ok,
        `count=${toCount(status.value?.count)}（之前 ${statusBaseline}） text=${JSON.stringify(
          statusText.replace(/\s+/gu, " ").slice(0, 300),
        )} error=${status.error}`,
      );
      if (status.ok) {
        console.log(`      status: ${statusText.replace(/\s+/gu, " ").slice(0, 240)}`);
      }
      await cdp.screenshot(join(SHOTS, "04-status.png"));

      // ---------- E. `/advisor doctor` ----------
      await clearComposer(cdp);
      await sleep(300);
      const doctorBaseline = toCount((await cdp.evaluate(COMMAND_STATE))?.count);
      const typedDoctor = await typeIntoComposer(cdp, "/advisor doctor");
      const doctorEntered = await waitForComposerText(cdp, "/advisor doctor", 5000);
      check(
        "把 /advisor doctor 写进输入框",
        doctorEntered.ok,
        JSON.stringify({ typed: typedDoctor, draft: doctorEntered.value }),
      );
      await pressEnter(cdp);

      const doctor = await waitFor(
        cdp,
        COMMAND_STATE,
        (value) =>
          toCount(value?.count) > doctorBaseline &&
          /(?:✅|⚠️|❌)\s/u.test(String(value?.last ?? "")),
        12_000,
      );
      const doctorText = String(doctor.value?.last ?? "");
      check(
        "/advisor doctor 输出至少一条 ✅/⚠️/❌ 检查行",
        doctor.ok,
        `count=${toCount(doctor.value?.count)}（之前 ${doctorBaseline}） text=${JSON.stringify(
          doctorText.replace(/\s+/gu, " ").slice(0, 300),
        )} error=${doctor.error}`,
      );
      if (doctor.ok) {
        const lines = doctorText
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /✅|⚠️|❌/u.test(line));
        console.log(`      doctor: ${lines.slice(0, 6).join(" | ")}`);
      }
      await cdp.screenshot(join(SHOTS, "05-doctor.png"));

      // ---------- F. 收尾：不留浮层、不留草稿 ----------
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
      skip("收尾：没有遗留浮层、输入框草稿已清空", "前置未满足，没有输入过");
    }
  } catch (error) {
    check("桌面回归执行", false, error instanceof Error ? error.message : String(error));
  } finally {
    // 出错也要尽量还原界面：关掉浮层、清掉**我们自己**写进去的草稿。
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
