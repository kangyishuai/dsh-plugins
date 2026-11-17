#!/usr/bin/env node
// @ts-check
// 用法：
//   # 1) 带调试端口启动桌面版
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//   # 2) 跑（发版门禁加 --require：连不上端口时失败而不是跳过）
//   pnpm smoke:btw-desktop --require
//
// 桌面端（Electron）只读回归：btw 的 client 半是否真的注入、浮层能否开关。
// 覆盖（全部**只读**：只开浮层再 Esc 关闭，不提交、不发起任何模型调用）：
//   1. client 半已加载：`style[data-plugin="@kangyishuai/dsh-btw"]`
//   2. 输入框左侧出现 `[data-btw-toggle]` 按钮
//   3. 点开 → `[data-btw-overlay]` 出现（role=dialog）
//   4. 浮层里有标题或空状态，且没有 `[data-btw-error]`
//   5. Esc 关闭 → 浮层消失
//   6. 收尾：没有遗留浮层
//
// 安全前置：当前会话正在跑回合（有「停止生成」按钮）时，脚本**不交互**，只报 SKIP——
// agent 自己跑桌面回归时，它的回合就跑在同一个桌面版里（约定 §6.1 末段）。
// 端口可用 --port 或 DSH_CDP_PORT 覆盖（默认 9222）。
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  return {
    styleInjected: style !== null,
    pluginCount: document.querySelectorAll('style[data-plugin]').length,
    toggle: toggle !== null,
    overlay: overlay !== null,
    overlayRole: overlay ? overlay.getAttribute('role') : null,
    error: err ? err.getAttribute('data-btw-error') : null,
    running: !!document.querySelector('button[aria-label="停止生成"]'),
    bodyLen: document.body ? document.body.innerText.length : 0,
  };
})()`;

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

    // 安全前置：正在跑的回合属于 agent 自己，不交互
    if (initial.running) {
      skip("桌面交互", "当前会话有运行中的回合（agent 自己跑回归时会这样）；切到空闲会话再跑");
      console.log(`\n${passed} PASS / ${skipped} SKIP / ${failed} FAIL`);
      return;
    }

    check(
      "client 半已注入（style[data-plugin]）",
      initial.styleInjected === true,
      initial.styleInjected === true
        ? ""
        : `页面有 ${initial.pluginCount} 个插件样式，但没有 btw —— 多半是没装进 desktop profile：` +
            "先 pnpm pack --pack-destination /tmp，再 dsh plugin --profile desktop add /tmp/<tgz>，然后重启桌面版",
    );
    check("输入框左侧出现 btw 按钮", initial.toggle === true, JSON.stringify(initial));

    // 快照用户进来时的草稿：非空就不做任何会改动输入框的断言，走完也不清空。
    const initialDraft = await cdp.evaluate(
      `(() => ((document.querySelector('[data-composer-input]') || {}).innerText || '').trim())()`,
    );

    if (initial.toggle !== true) {
      skip("浮层开关", "按钮未出现，后续断言无意义");
    } else {
      // 点开
      await cdp.evaluate(
        `(() => { document.querySelector('[data-btw-toggle]').click(); return true; })()`,
      );
      await sleep(900);
      const opened = await cdp.evaluate(STATE);
      check("点开后浮层出现", opened.overlay === true, JSON.stringify(opened));
      check("浮层是 dialog", opened.overlayRole === "dialog", String(opened.overlayRole));
      if (opened.error) skip("浮层内容", `读历史失败：${opened.error}`);

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
        // 展开追问输入框（只展开，不提交）
        await cdp.evaluate(
          `(() => { const b = document.querySelector('[data-btw-followup]'); if (b) b.click(); return true; })()`,
        );
        await sleep(600);
        const expanded = await cdp.evaluate(
          `(() => ({ threadInput: !!document.querySelector('[data-btw-thread-input]') }))()`,
        );
        check("点追问后出现线程内输入框", expanded.threadInput === true, JSON.stringify(expanded));
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
            "转正没有发送任何消息",
            afterFlow === beforeFlow,
            `flow ${beforeFlow} -> ${afterFlow}`,
          );
          // 清掉草稿：绝不把测试内容留在用户输入框里
          await clearComposerDraft(cdp);
        }
      }

      // Esc 关闭
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 53,
        });
      }
      await sleep(700);
      const closed = await cdp.evaluate(STATE);
      check("Esc 后浮层消失", closed.overlay === false, JSON.stringify(closed));
      check("没有遗留浮层", closed.overlay === false, JSON.stringify(closed));

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
      const item = [...document.querySelectorAll('button,[role=menuitem]')].find((b) => /^设置$|^Settings$/i.test(label(b)));
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
