#!/usr/bin/env node
// @ts-check
// 用法：
//   # 1) 带调试端口启动桌面版
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:btw-desktop --require
//   pnpm smoke:btw-desktop --require --deep   —— 另跑一次真实 /btw，验证真实数据根的 history 落盘
//
// 桌面端（Electron）只读回归：btw 的 client 半是否真的注入、原生右侧栏 tab 能否开关/收起。
// 覆盖（全部**只读**：只开浮层再 Esc 关闭，不提交、不发起任何模型调用）：
//   1. client 半已加载：`style[data-plugin="@kangyishuai/dsh-btw"]`
//   2. 输入框左侧出现 `[data-btw-toggle]` 按钮
//   3. 点开 → 右侧 `[data-btw-panel]` 出现（role=dialog，靠右、不遮挡输入框）
//   4. 抽屉里有标题或空状态，且没有 `[data-btw-error]`；有记录时答案按 Markdown 渲染
//   5. 宿主「收起」→ 右侧栏折叠（tab 保留）；再点「旁问」展开；「关闭」关闭 tab
//   6. 收尾：没有遗留抽屉
//
// 安全前置：当前会话正在跑回合（有「停止生成」按钮）时，脚本**不交互**，只报 SKIP——
// agent 自己跑桌面回归时，它的回合就跑在同一个桌面版里（约定 §6.1 末段）。
// 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHOTS = join(tmpdir(), "dsh-btw-desktop-shots");
const PLUGIN = "@kangyishuai/dsh-btw";
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} message */
function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

/**
 * @param {number} port
 * @returns {Promise<{ send: (method: string, params?: any) => Promise<any>, evaluate: (expression: string) => Promise<any>, screenshot: (file: string) => Promise<void>, close: () => void }>}
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
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
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
  return { send, evaluate, screenshot, close: () => ws.close() };
}

const STATE = `(() => {
  const style = document.querySelector('style[data-plugin="${PLUGIN}"]');
  const toggle = document.querySelector('[data-btw-toggle]');
  const overlay = document.querySelector('[data-btw-overlay]');
  const err = document.querySelector('[data-btw-error]');
  const panel = document.querySelector('[data-btw-panel]');
  const rect = panel ? panel.getBoundingClientRect() : null;
  const conversation = document.querySelector('[data-conversation-session]');
  const crect = conversation ? conversation.getBoundingClientRect() : null;
  const rightbar = document.querySelector('[data-sidebar-right-panel]');
  return {
    styleInjected: style !== null,
    pluginCount: document.querySelectorAll('style[data-plugin]').length,
    toggle: toggle !== null,
    overlay: overlay !== null,
    overlayRole: overlay ? overlay.getAttribute('role') : null,
    isTab: panel !== null && panel.hasAttribute('data-btw-tab'),
    noOverlap: rect !== null && crect !== null && crect.right <= rect.left + 1,
    rightbar: rightbar !== null,
    rightbarCollapsed: !!document.querySelector('[data-rightbar-collapsed="true"]'),
    rail: !!document.querySelector('[data-btw-rail]'),
    markdown: document.querySelectorAll('[data-btw-md]').length,
    turns: document.querySelectorAll('[data-btw-turn]').length,
    error: err ? err.getAttribute('data-btw-error') : null,
    running: !!document.querySelector('button[aria-label="停止生成"]'),
    bodyLen: document.body ? document.body.innerText.length : 0,
  };
})()`;

/**
 * 用 CDP 往当前焦点插入文本（比逐字符按键快且不丢）。
 * @param {Awaited<ReturnType<typeof connect>>} cdp
 * @param {string} text
 * @returns {Promise<void>}
 */
async function send_text(cdp, text) {
  await cdp.send("Input.insertText", { text });
}

/**
 * 清空 composer 草稿。桌面回归会往输入框插转正草稿，失败路径也必须清理干净——
 * 只动 DSH 的输入框，不碰页面任何其它状态。
 * @param {Awaited<ReturnType<typeof connect>>} cdp
 * @returns {Promise<void>}
 */
async function clearComposerDraft(cdp) {
  try {
    const ok = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-composer-input]');
      if (!el) return false;
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()`);
    if (ok !== true) return;
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 51,
      });
    }
    await sleep(300);
  } catch {
    /* 清理失败不改变结论，只影响现场整洁 */
  }
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      deep: { type: "boolean", default: false },
      require: { type: "boolean", default: false },
      shots: { type: "string" },
    },
    allowPositionals: true,
  });
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  const shots = values.shots ?? SHOTS;

  /** @type {Awaited<ReturnType<typeof connect>> | undefined} */
  let cdp;
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  /** @param {string} name @param {boolean} ok @param {string} [detail] */
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
    if (ok) passed += 1;
    else {
      failed += 1;
      fail(name);
    }
  };
  /** @param {string} name @param {string} detail */
  const skip = (name, detail) => {
    console.log(`SKIP ${name} — ${detail}`);
    skipped += 1;
  };

  try {
    try {
      cdp = await connect(port);
    } catch (error) {
      const message = `连不上 127.0.0.1:${port}（${error instanceof Error ? error.message : String(error)}）`;
      if (values.require) {
        fail(message);
        return;
      }
      console.log(`SKIP ${message}；先带 --remote-debugging-port=${port} 重启桌面版`);
      return;
    }

    await sleep(1200);
    const initial = await cdp.evaluate(STATE);

    // 先判断插件是否装上：这是纯只读检测，与回合状态无关。
    // 顺序很重要——如果先做「忙就 SKIP」，会把「没装」误报成「忙」，
    // 让真问题（没装进当前 profile）永远藏着（2026-11-17 实测踩中）。
    check(
      "client 半已注入（style[data-plugin]）",
      initial.styleInjected === true,
      initial.styleInjected === true
        ? ""
        : `页面有 ${initial.pluginCount} 个插件样式，但没有 btw —— 没装进**当前运行的 profile**。` +
            "先确认实例用的是哪个 profile（进程参数里的 --profile），再 dsh plugin --profile <name> add @kangyishuai/dsh-btw，然后重启桌面版",
    );
    if (initial.styleInjected !== true) {
      console.log(`\n${passed} PASS / ${skipped} SKIP / ${failed} FAIL`);
      return;
    }

    // 只读断言无条件执行：它们不改动任何状态，与回合是否在跑无关。
    // 只有**会碰 composer 草稿**的断言（转正）需要空闲会话——见文件末尾的 running 判断。
    // 早期版本「忙就全 SKIP」，导致 agent 自己跑时 0 断言执行，正好是门禁要防的假绿。
    check("输入框左侧出现 btw 按钮", initial.toggle === true, JSON.stringify(initial));

    // 快照用户进来时的草稿：非空就不做任何会改动输入框的断言，走完也不清空。
    const initialDraft = await cdp.evaluate(
      `(() => ((document.querySelector('[data-composer-input]') || {}).innerText || '').trim())()`,
    );

    if (initial.toggle !== true) {
      skip("抽屉开关", "按钮未出现，后续断言无意义");
    } else {
      // 点开
      await cdp.evaluate(
        `(() => { document.querySelector('[data-btw-toggle]').click(); return true; })()`,
      );
      await sleep(900);
      const opened = await cdp.evaluate(STATE);
      check(
        "点「旁问」在原生右侧栏打开 tab",
        opened.isTab === true && opened.overlay === false && opened.rightbar === true,
        JSON.stringify(opened),
      );
      check("右侧栏 tab 不遮挡主对话", opened.noOverlap === true, JSON.stringify(opened));
      if (opened.error) skip("tab 内容", `读历史失败：${opened.error}`);

      // ---- v0.3：档位选择器 / 徽章 / 追问 / 转正（全部只读）--------------
      const v03 = await cdp.evaluate(`(() => {
        const threads = document.querySelectorAll('[data-btw-thread]');
        const scope = document.querySelector('[data-btw-scope]');
        return {
          threads: threads.length,
          scope: scope !== null,
          scopeOptions: scope ? scope.options.length : 0,
          badge: (document.querySelector('[data-btw-badge]') || { innerText: '' }).innerText || '',
          followup: document.querySelectorAll('[data-btw-followup]').length,
          promote: document.querySelectorAll('[data-btw-promote]').length,
        };
      })()`);
      check(
        "档位选择器存在且有 4 个档位",
        v03.scope === true && v03.scopeOptions === 4,
        JSON.stringify(v03),
      );
      check(
        "徽章如实写明模型可见完整会话",
        typeof v03.badge === "string" && /完整会话|whole conversation/.test(v03.badge),
        String(v03.badge),
      );

      if (v03.threads === 0) {
        skip("追问/转正按钮", "当前会话还没有旁问记录（先提一个 /btw 再跑）");
      } else {
        check("每条线程都有追问按钮", v03.followup === v03.threads, JSON.stringify(v03));
        check("每条线程都有转正按钮", v03.promote === v03.threads, JSON.stringify(v03));
        // 展开追问输入框（只展开，不提交）。
        // 点一次不生效就再点一次——这是约定 §6.1 说的「手势断言加一次不降低断言的重试」：
        // 面板刚渲染完时 React 可能还在处理上一帧，第一次点击会被吞（实测 2 次里偶发 1 次）。
        let expanded = { threadInput: false };
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          await cdp.evaluate(
            `(() => { const b = document.querySelector('[data-btw-followup]'); if (b) b.click(); return true; })()`,
          );
          await sleep(600);
          expanded = await cdp.evaluate(
            `(() => ({ threadInput: !!document.querySelector('[data-btw-thread-input]') }))()`,
          );
          if (expanded.threadInput === true) break;
        }
        check("点追问后出现线程内输入框", expanded.threadInput === true, JSON.stringify(expanded));
        const followUi = await cdp.evaluate(`(() => ({
          visibleTextareas: [...document.querySelectorAll('[data-btw-panel] textarea')].filter((el) => el.offsetParent !== null).length,
          sendText: ((document.querySelector('[data-btw-thread-input] [data-btw-send]') || {}).innerText || '').trim(),
          scope: !!document.querySelector('[data-btw-thread-input] [data-btw-scope]'),
        }))()`);
        check(
          "追问时只保留一个输入框且按钮叫「追问」",
          followUi.visibleTextareas === 1 &&
            followUi.scope === true &&
            !/提问$/.test(followUi.sendText),
          JSON.stringify(followUi),
        );
        // 转正：只插草稿，**不发送** —— 断言 composer 有内容但对话流没有新节点
        const beforeFlow = await cdp.evaluate(
          `(() => document.querySelectorAll('[data-chat-flow-kind]').length)()`,
        );
        const draftBefore = await cdp.evaluate(
          `(() => ((document.querySelector('[data-composer-input]') || {}).innerText || '').trim())()`,
        );
        if (draftBefore !== "") {
          skip("转正只插草稿", "输入框已有内容（插件会拒绝转正，属预期保护）");
        } else {
          await cdp.evaluate(
            `(() => { const b = document.querySelector('[data-btw-promote]'); if (b) b.click(); return true; })()`,
          );
          await sleep(2000);
          const afterFlow = await cdp.evaluate(
            `(() => document.querySelectorAll('[data-chat-flow-kind]').length)()`,
          );
          const draftAfter = await cdp.evaluate(
            `(() => ((document.querySelector('[data-composer-input]') || {}).innerText || '').trim())()`,
          );
          check("转正把草稿插进输入框", draftAfter.length > 0, `draft=${draftAfter.slice(0, 40)}`);
          check(
            "转正草稿保留 Markdown 源码",
            /^##\s/m.test(draftAfter),
            `draft=${draftAfter.slice(0, 60)}`,
          );
          check(
            "转正没有发送任何消息",
            afterFlow === beforeFlow,
            `flow ${beforeFlow} -> ${afterFlow}`,
          );
          // 清掉草稿：绝不把测试内容留在用户输入框里
          await clearComposerDraft(cdp);
        }
      }

      // 收起右侧栏 → 再点「旁问」展开（「可以点击展开或者收起来」）
      await cdp.evaluate(
        `(() => { const b = document.querySelector('[data-sidebar-right-toggle]'); if (b) b.click(); return true; })()`,
      );
      await sleep(700);
      const collapsed = await cdp.evaluate(STATE);
      check(
        "点宿主「收起」收起右侧栏（tab 保留）",
        collapsed.rightbarCollapsed === true && collapsed.isTab === true,
        JSON.stringify(collapsed),
      );
      await cdp.evaluate(
        `(() => { document.querySelector('[data-btw-toggle]').click(); return true; })()`,
      );
      await sleep(800);
      const expanded = await cdp.evaluate(STATE);
      check(
        "再点「旁问」重新展开右侧栏与 tab",
        expanded.rightbarCollapsed === false && expanded.isTab === true,
        JSON.stringify(expanded),
      );

      // Esc 关闭 tab（先聚焦面板输入框，焦点不在面板时 Esc 留给宿主/设置）。
      await cdp.evaluate(
        `(() => { const el = document.querySelector('[data-btw-panel] textarea[data-btw-input]'); if (el) el.focus(); return true; })()`,
      );
      await sleep(300);
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27,
        });
      }
      await sleep(700);
      const escClosed = await cdp.evaluate(STATE);
      check("按 Esc 关闭 tab", escClosed.isTab === false, JSON.stringify(escClosed));
      await cdp.evaluate(
        `(() => { document.querySelector('[data-btw-toggle]')?.click(); return true; })()`,
      );
      await sleep(800);
      const reopened = await cdp.evaluate(STATE);
      check(
        "Esc 后可再次打开 tab",
        reopened.isTab === true && reopened.rightbarCollapsed === false,
        JSON.stringify(reopened),
      );

      // 关闭 tab（只读收尾：不在用户会话里留下打开的面板）
      await cdp.evaluate(
        `(() => { const b = document.querySelector('[data-btw-close]'); if (b) b.click(); return true; })()`,
      );
      await sleep(700);
      const closed = await cdp.evaluate(STATE);
      check("点「关闭」关闭 tab", closed.isTab === false, JSON.stringify(closed));

      // 兜底：进来时输入框是空的，结束时也必须是空的（可能是被测脚本插入的草稿）。
      if (initialDraft === "") {
        await clearComposerDraft(cdp);
        const draftNow = await cdp.evaluate(
          `(() => ((document.querySelector('[data-composer-input]') || {}).innerText || '').trim())()`,
        );
        check("结束时输入框已还原为空", draftNow === "", `draft=${String(draftNow).slice(0, 40)}`);
      } else {
        skip("结束时输入框已还原为空", "进来时已有草稿，保持原样不做清理");
      }
    }

    // ---- 设置分节（只读）--------------------------------------------
    // 打开账号菜单 → 设置 → 点「旁问」nav → 断言分节渲染 → Esc 关闭。
    // 打不开设置对话框（未登录 / 门禁）时只报 SKIP，不制造失败。
    const openedSettings = await cdp.evaluate(`(() => {
      const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
      const acct = [...document.querySelectorAll('button')].find((b) => /账号|Account/i.test(label(b)));
      if (!acct) return 'no-account-button';
      acct.click();
      return 'clicked';
    })()`);
    await sleep(900);
    const clickedSettings = await cdp.evaluate(`(() => {
      const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
      // 账号菜单里的菜单项 textContent 会带快捷键标记（"设置⌘,"），不能用 ^...$ 精确匹配。
      // 用「以设置开头」并排除明显不是设置的长文案。
      const item = [...document.querySelectorAll('[role="menuitem"],button')].find((b) => {
        const text = label(b);
        if (/意见反馈|退出登录|feedback|sign out/i.test(text)) return false;
        return /^设置|^Settings\b/i.test(text);
      });
      if (!item) return false;
      item.click();
      return true;
    })()`);
    await sleep(1500);
    const settingsState = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const title = dialog ? dialog.getAttribute('aria-label') || '' : '';
      return {
        dialog: dialog !== null,
        title,
        gated: /开始使用|Get started|添加 API Key|Add API key/i.test(dialog ? dialog.innerText || '' : ''),
        nav: [...document.querySelectorAll('[role=tab],nav button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 16),
      };
    })()`);
    if (openedSettings !== "clicked" || clickedSettings !== true) {
      skip("设置分节", `打不开设置入口（account=${openedSettings}, settings=${clickedSettings}）`);
    } else if (settingsState.gated) {
      skip("设置分节", "设置对话框被「开始使用 / 添加 API Key」门禁挡住（需要已登录的桌面版）");
    } else {
      const clickedNav = await cdp.evaluate(`(() => {
        const nodes = [...document.querySelectorAll('[role=tab],nav button,button')]
          .filter((b) => (b.textContent || '').trim() === '旁问' && !b.hasAttribute('data-btw-toggle'));
        if (nodes.length === 0) return false;
        nodes[0].click();
        return true;
      })()`);
      await sleep(1200);
      const section = await cdp.evaluate(`(() => ({
        hasSection: !!document.querySelector('[data-btw-settings]'),
        hasTools: !!document.querySelector('[data-btw-setting-tools]'),
        hasEcho: !!document.querySelector('[data-btw-setting-echo]'),
        hasSave: !!document.querySelector('[data-btw-settings-save]'),
        saveDisabled: (document.querySelector('[data-btw-settings-save]') || {}).disabled ?? null,
        hasMore: !!document.querySelector('[data-btw-settings-more]'),
        extraVisible: !!document.querySelector('[data-btw-settings-extra]'),
      }))()`);
      if (clickedNav !== true) {
        skip("设置分节", `设置对话框里没有「旁问」nav（可见：${settingsState.nav.join(" / ")}）`);
      } else {
        check("设置分节渲染", section.hasSection === true, JSON.stringify(section));
        check("首屏有工具白名单输入", section.hasTools === true, JSON.stringify(section));
        check(
          "首屏有「主对话显示完整答案」开关",
          section.hasEcho === true,
          JSON.stringify(section),
        );
        check("无改动时保存按钮禁用", section.saveDisabled === true, JSON.stringify(section));
        check("「更多设置」默认折叠", section.extraVisible === false, JSON.stringify(section));
      }
      // Esc 关掉设置对话框
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 53,
        });
      }
      await sleep(600);
    }

    // ---- --deep：真实 /btw 往返 + 真实数据根的 history 落盘 -----------------
    // 这是 web 冒烟（临时 DSH_HOME）覆盖不到的一层：真实桌面版是否把 history 写到
    // 用户的 ~/.dsh/btw/，record 字段是否齐全。
    if (values.deep === true) {
      const historyDir = join(homedir(), ".dsh", "btw");
      /** @returns {Promise<number>} 当前 history 记录总数 */
      const countRecords = async () => {
        try {
          const files = (await readdir(historyDir)).filter((f) => f.endsWith(".jsonl"));
          let total = 0;
          for (const file of files) {
            const text = await readFile(join(historyDir, file), "utf8");
            total += text.split("\n").filter((line) => line.trim() !== "").length;
          }
          return total;
        } catch {
          return 0;
        }
      };

      const before = await countRecords();
      // 打开浮层并填 composer（浮层里的输入框会写 /btw 前缀，这里直接走 composer 更贴近真实用法）
      await cdp.evaluate(
        `(() => { const t = document.querySelector('[data-btw-toggle]'); if (t) t.click(); return true; })()`,
      );
      await sleep(600);
      await cdp.evaluate(
        `(() => {
          const el = document.querySelector('[data-composer-input]');
          if (!el) return false;
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        })()`,
      );
      await send_text(cdp, "/btw reply with exactly OK");
      await sleep(800);
      // 关掉斜杠菜单（开着时 Enter 会被吃掉）
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 53,
        });
      }
      await sleep(400);
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 36,
        });
      }
      // 轮询 history 直到出现新记录（一次真实模型调用，给足时间）
      let records = before;
      for (let i = 0; i < 40; i += 1) {
        await sleep(2000);
        records = await countRecords();
        if (records > before) break;
      }
      check(
        "--deep：真实 /btw 在真实数据根落盘",
        records > before,
        `记录数 ${before} -> ${records}（目录 ${historyDir}）`,
      );

      if (records > before) {
        // 读回最后一条，断言字段齐全
        const files = (await readdir(historyDir)).filter((f) => f.endsWith(".jsonl"));
        let lastRecord = /** @type {any} */ (undefined);
        for (const file of files) {
          const text = await readFile(join(historyDir, file), "utf8");
          for (const line of text.split("\n")) {
            if (line.trim() === "") continue;
            try {
              lastRecord = JSON.parse(line);
            } catch {
              /* 坏行跳过，与插件行为一致 */
            }
          }
        }
        check(
          "--deep：record 状态为 done 且有答案",
          lastRecord?.status === "done" && String(lastRecord?.answer ?? "").trim() !== "",
          JSON.stringify({
            status: lastRecord?.status,
            answer: String(lastRecord?.answer ?? "").slice(0, 40),
          }),
        );
        check(
          "--deep：record 带成本与耗时",
          Number(lastRecord?.ms) > 0 && lastRecord?.cost !== null && lastRecord?.cost !== undefined,
          JSON.stringify({ ms: lastRecord?.ms, cost: lastRecord?.cost }),
        );
        check(
          "--deep：写了 threadId（v0.3 线程字段）",
          typeof lastRecord?.threadId === "string" && lastRecord.threadId !== "",
          String(lastRecord?.threadId ?? ""),
        );
      }
      // 关掉浮层，避免留下打开的面板
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 53,
        });
      }
      await sleep(400);
    }

    try {
      await cdp.screenshot(join(shots, "after.png"));
      console.log(`截图：${join(shots, "after.png")}`);
    } catch {
      /* 截图失败不影响结论 */
    }
    console.log(`\n${passed} PASS / ${skipped} SKIP / ${failed} FAIL`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.close();
  }
};

await main();
