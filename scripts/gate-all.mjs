#!/usr/bin/env node
// @ts-check
// 用法：pnpm gate:all [选项]
//
// 一条命令跑完八个发布插件的门禁（`pnpm gate <plugin>` 的批量版）：
//
//   1. pnpm verify            只跑一次（不再每个插件各跑一遍）
//   2. pnpm probe:runtime     只跑一次
//   3. 逐插件 web 冒烟         pnpm smoke:<plugin>（临时 DSH_HOME）
//   4. 逐插件桌面只读回归      pnpm smoke:<plugin>-desktop --require
//
// 为什么需要它：手工连跑八条 `pnpm gate` 时，每一步桌面回归前都要先把可见会话切到
// **空闲会话**（advisor / next-step 的脚本在可见会话正跑回合时按设计拒绝交互，直接判红），
// 跑完还要切回——六次手工切换最容易漏一次。本脚本把这件事自动化：
//
//   --idle-session <标题>   每个桌面步骤前把可见会话切到侧栏里标题含该字符串的空闲会话，
//                           全部结束后切回开始时的会话。**强烈建议在 agent 会话里跑时带上**。
//
// 其他选项：
//   --plugins a,b           只跑指定插件（默认八个发布插件）
//   --skip-verify           跳过 verify（刚跑过时用；结束时大声提示门禁不完整）
//   --skip-desktop          跳过桌面端（只跑 verify/probe/web；同样提示不完整）
//   --port 9222             桌面版 CDP 端口（默认 9222 / DSH_CDP_PORT）
//   --dry-run               只打印计划，不执行
//
// 设计要点：
//   - 桌面阶段永远带 `--require`；并用 gate.mjs 的 desktopGateVerdict() 判「缺计数行 / 全 SKIP」
//     的假绿，与单插件门禁同一套标准。
//   - web 冒烟逐条串行（它们都要打真实模型/起临时宿主），失败也继续跑完其余插件，
//     最后给总表——一次操作看到全部结论，而不是「第一条就停，剩下的不知道」。
//   - 退出码：任一插件失败即 1。
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { desktopGateVerdict, gateVerdict, parseCounts } from "./gate.mjs";
import { isMain } from "./lib/repo.mjs";

const REPO = resolve(import.meta.dirname, "..");
/**
 * 默认跑全部八个已发布插件（AUD-XCT-04：旧清单漏了 artifacts / projects，
 * 与 AGENTS.md「八个发布插件」不符；两插件的 web/桌面脚本早已存在，`pnpm check` 也在拦）。
 * 顺序按目录名字母序，便于和 `packages/` 对照。
 */
export const RELEASE_PLUGINS = [
  "advisor",
  "artifacts",
  "btw",
  "casefile",
  "next-step",
  "projects",
  "session-delete",
  "session-rewind",
];
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 解析 `--plugins a,b`：逗号分隔、去空白、去空项与重复；缺省返回六个发布插件。
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function normalizePlugins(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [...RELEASE_PLUGINS];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const plugins = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    plugins.push(name);
  }
  return plugins;
}

/**
 * 所选插件缺哪些冒烟脚本（`--skip-desktop` 时不检查桌面脚本）。
 * @param {string[]} plugins
 * @param {Record<string, string>} scripts
 * @param {boolean} skipDesktop
 * @returns {string[]}
 */
export function missingScripts(plugins, scripts, skipDesktop) {
  /** @type {string[]} */
  const missing = [];
  for (const plugin of plugins) {
    if (typeof scripts[`smoke:${plugin}`] !== "string") missing.push(`smoke:${plugin}`);
    if (!skipDesktop && typeof scripts[`smoke:${plugin}-desktop`] !== "string") {
      missing.push(`smoke:${plugin}-desktop`);
    }
  }
  return missing;
}

/**
 * 比较两次计数的 PASS/SKIP/FAIL。数据相关 SKIP 漂移允许（只提示），但 FAIL 变化要看得见。
 * @param {{ pass: number, skip: number, fail: number }} first
 * @param {{ pass: number, skip: number, fail: number }} next
 * @returns {string | null} 有漂移时返回 `first → next` 描述，完全一致返回 null
 */
export function compareCounts(first, next) {
  if (first.pass === next.pass && first.skip === next.skip && first.fail === next.fail) return null;
  return `${first.pass}/${first.skip}/${first.fail} → ${next.pass}/${next.skip}/${next.fail}`;
}

/**
 * 生成 dry-run / 日志用的执行计划（纯文本行；不执行任何命令）。
 * @param {{ plugins: string[], skipVerify: boolean, skipDesktop: boolean, idleTitle: string | null, repeat: number }} options
 * @returns {string[]}
 */
export function buildPlan(options) {
  const { plugins, skipVerify, skipDesktop, idleTitle, repeat } = options;
  /** @type {string[]} */
  const plan = [
    skipVerify ? "- verify（已按 --skip-verify 跳过）" : "1. pnpm verify",
    "2. pnpm probe:runtime",
    ...plugins.map((plugin, index) => `3.${index + 1} pnpm smoke:${plugin}`),
  ];
  if (skipDesktop) {
    plan.push("- 桌面端（已按 --skip-desktop 跳过）");
  } else {
    for (const [index, plugin] of plugins.entries()) {
      plan.push(
        `4.${index + 1} pnpm smoke:${plugin}-desktop --require${repeat > 1 ? `（连跑 ${repeat} 次）` : ""}`,
      );
    }
    if (idleTitle !== null) {
      plan.push(`   桌面步骤前切到空闲会话「${idleTitle}」，结束后切回`);
    }
  }
  return plan;
}

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
function run(args) {
  return new Promise((done) => {
    const child = spawn("pnpm", args, {
      cwd: REPO,
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    /** @type {string[]} */
    const chunks = [];
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      chunks.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      chunks.push(String(chunk));
    });
    child.on("close", (code) => done({ code: code ?? 1, output: chunks.join("") }));
    child.on("error", () => done({ code: 1, output: chunks.join("") }));
  });
}

/** @param {number} port */
async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((/** @type {any} */ item) => item.type === "page");
  if (!page) throw new Error(`no page target on 127.0.0.1:${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    ws.onopen = resolveOpen;
    ws.onerror = reject;
  });
  let seq = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  ws.onmessage = (/** @type {any} */ event) => {
    const msg = JSON.parse(String(event.data));
    const record = msg.id === undefined ? undefined : pending.get(msg.id);
    if (record === undefined) return;
    pending.delete(msg.id);
    if (msg.error) {
      record.reject(new Error(JSON.stringify(msg.error)));
      return;
    }
    // Runtime.evaluate 的协议返回是 { result: { type, value } }；返回整个信封会让
    // `typeof id === "string"` 之类的判断永远失败（2026-11-20 实测：切换/恢复全部静默失效）。
    const evaluated = msg.result;
    if (evaluated?.exceptionDetails !== undefined) {
      record.resolve(undefined);
      return;
    }
    record.resolve(evaluated?.result?.value);
  };
  /**
   * @param {string} expression
   * @returns {Promise<any>}
   */
  const evaluate = (expression) =>
    new Promise((resolveCall) => {
      const id = ++seq;
      pending.set(id, { resolve: resolveCall, reject: () => resolveCall(undefined) });
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  return { ws, evaluate };
}

/** @typedef {Awaited<ReturnType<typeof connect>>} Cdp */

/**
 * 侧栏里的会话行可能被收起的「工作区」分组或「展开其余 N 个会话」遮住：先展开再找。
 * @param {Cdp} cdp
 */
const revealSidebarGroups = (cdp) =>
  cdp.evaluate(`(() => {
    let clicked = 0;
    for (const row of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) {
      row.click(); clicked += 1;
    }
    for (const btn of document.querySelectorAll('[data-row-key^="overflow:"][aria-expanded="false"]')) {
      btn.click(); clicked += 1;
    }
    return clicked;
  })()`);

/**
 * @param {Cdp} cdp
 * @returns {Promise<string | null>}
 */
const currentSession = async (cdp) => {
  const id = await cdp.evaluate(
    `(() => { const root = document.querySelector('[data-conversation-session]'); return root ? root.getAttribute('data-conversation-session') : null; })()`,
  );
  return typeof id === "string" && id !== "" ? id : null;
};

/**
 * 等到「会话视图」就绪：读到 `data-conversation-session` 才算，最多 20s。
 *
 * **不要在这里替用户点侧栏行**（2026-11-20 实测踩坑）：应用切换会话时会短暂没有这个属性，
 * 若此时去点「第一行会话」，会和用户/上一步的切换抢导航，最后停在一个**随机会话**上，
 * 既记错原会话、又会让后面的空闲会话查找扑空。这里只等待；真的停在插件页/设置页时由调用者
 * 得到 null 并报一条可操作的错误（`--skip-desktop` 可只跑 web 部分）。
 * @param {Cdp} cdp
 * @returns {Promise<string | null>}
 */
const ensureConversation = async (cdp) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const id = await currentSession(cdp).catch(() => null);
    if (id !== null) return id;
    await sleep(500);
  }
  return null;
};

/**
 * 切到标题含 `title` 的会话；点完要**回读 `data-conversation-session` 确认真的切过去了**
 * （行可能被遮挡、点击不生效；2026-11-20 实测「恢复原会话」就栽在只看 click 返回值）。
 * 找不到 / 没切过去就展开分组重试，最多 12s。
 * @param {Cdp} cdp @param {string} title
 */
const switchToTitle = async (cdp, title) => {
  if ((await ensureConversation(cdp)) === null) return false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const targetId = await cdp.evaluate(
      `(() => {
        const row = [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => (r.innerText || '').includes(${JSON.stringify(title)}));
        if (!row) return null;
        row.scrollIntoView({ block: 'center' });
        row.click();
        return (row.getAttribute('data-row-key') || '').replace('session:', '');
      })()`,
    );
    if (typeof targetId === "string" && targetId !== "") {
      await sleep(1200);
      if ((await currentSession(cdp)) === targetId) return true;
    }
    await revealSidebarGroups(cdp).catch(() => 0);
    await sleep(600);
  }
  return false;
};

/**
 * 切回指定会话 id。
 * @param {Cdp} cdp @param {string} id
 */
const switchToId = async (cdp, id) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(
      `(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(id)} + '"]');
        if (!row) return false;
        row.scrollIntoView({ block: 'center' });
        row.click();
        return true;
      })()`,
    );
    if (found === true) {
      await sleep(1200);
      if ((await currentSession(cdp)) === id) return true;
    }
    await revealSidebarGroups(cdp).catch(() => 0);
    await sleep(600);
  }
  return false;
};

/**
 * @typedef {object} PluginResult
 * @property {string} plugin
 * @property {boolean} webOk
 * @property {boolean} desktopOk
 * @property {string} [detail]
 */

const main = async () => {
  const { values } = parseArgs({
    options: {
      plugins: { type: "string" },
      "skip-verify": { type: "boolean", default: false },
      "skip-desktop": { type: "boolean", default: false },
      "idle-session": { type: "string" },
      repeat: { type: "string" },
      port: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const scripts = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")).scripts ?? {};
  const plugins = normalizePlugins(values.plugins);
  const port = Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222);
  const idleTitle = typeof values["idle-session"] === "string" ? values["idle-session"] : null;
  const repeat = Number(values.repeat ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
    console.error("FAIL --repeat 只接受 1–3 的整数（默认 1；幂等自检用 2）");
    process.exitCode = 2;
    return;
  }
  const missing = missingScripts(plugins, scripts, values["skip-desktop"] === true);
  if (missing.length > 0) {
    console.error(`FAIL 这些脚本缺失：${missing.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const plan = buildPlan({
    plugins,
    skipVerify: values["skip-verify"] === true,
    skipDesktop: values["skip-desktop"] === true,
    idleTitle,
    repeat,
  });
  console.log(`gate:all 计划：${plugins.length} 个插件（${plugins.join(", ")}）`);
  for (const line of plan) console.log(`  ${line}`);
  if (values["dry-run"] === true) return;
  if (values["skip-verify"] === true || values["skip-desktop"] === true) {
    console.log("注意：带了 --skip-verify / --skip-desktop，门禁不完整。");
  }

  const started = Date.now();
  if (values["skip-verify"] !== true) {
    console.log("\n▶ [1] pnpm verify");
    const verify = await run(["verify"]);
    if (verify.code !== 0) {
      console.error("\nFAIL 门禁中止：pnpm verify 失败");
      process.exitCode = 1;
      return;
    }
    console.log("✓ pnpm verify");
  }
  console.log("\n▶ [2] pnpm probe:runtime");
  const probe = await run(["probe:runtime"]);
  if (probe.code !== 0) {
    console.error("\nFAIL 门禁中止：pnpm probe:runtime 失败");
    process.exitCode = 1;
    return;
  }
  console.log("✓ pnpm probe:runtime");

  /** @type {PluginResult[]} */
  const results = [];
  let cdp;
  /** @type {string | null} */
  let originalSession = null;
  const desktopEnabled = values["skip-desktop"] !== true;
  if (desktopEnabled && idleTitle !== null) {
    try {
      cdp = await connect(port);
      originalSession = await ensureConversation(cdp);
      if (originalSession === null) {
        console.error("FAIL 桌面版不在会话视图（可能停在插件页 / 设置页，或还在渲染）");
        console.error("      先点回任一会话再跑；只想跑 web 部分可加 --skip-desktop。");
        cdp.ws.close();
        process.exitCode = 1;
        return;
      }
      console.log(`可见会话：session:${originalSession}`);
      const switched = await switchToTitle(cdp, idleTitle);
      if (!switched) {
        console.warn(`WARN 侧栏里没找到标题含「${idleTitle}」的会话；桌面步骤将按当前会话跑`);
      }
    } catch (error) {
      console.error(
        `FAIL 连不上桌面版 CDP（127.0.0.1:${port}）：${error instanceof Error ? error.message : String(error)}`,
      );
      console.error('提示：open -a "DeepSeek Harness" --args --remote-debugging-port=9222');
      process.exitCode = 1;
      return;
    }
  }

  let index = 0;
  for (const plugin of plugins) {
    index += 1;
    console.log(`\n▶ [3.${index}] pnpm smoke:${plugin}`);
    const web = await run([`smoke:${plugin}`]);
    const webOk = web.code === 0;
    const webCounts = parseCounts(web.output);
    const webVerdict = gateVerdict(webCounts);
    const webCountsText =
      webCounts === undefined
        ? "无计数行"
        : `${webCounts.pass} PASS / ${webCounts.skip} SKIP / ${webCounts.fail} FAIL`;
    /** @type {PluginResult} */
    const result = { plugin, webOk, desktopOk: true };
    if (!webOk) {
      console.error(`FAIL web 冒烟失败：${plugin}（继续跑其余插件）`);
      result.detail = "web 冒烟失败";
    } else if (webVerdict !== "ok") {
      // 与桌面同一套标准：web 冒烟不打印计数行、或一条断言都没跑（全 SKIP）都算假绿。
      console.error(
        `FAIL web 冒烟判定：${plugin} → ${webVerdict === "missing-counts" ? "脚本没打印计数行" : "全 SKIP/零断言"}（${webCountsText}）`,
      );
      result.webOk = false;
      result.detail = `web 冒烟判定失败（${webVerdict}，${webCountsText}）`;
    } else {
      console.log(`✓ web 冒烟：${plugin}（${webCountsText}）`);
    }

    if (desktopEnabled) {
      if (cdp !== undefined && idleTitle !== null) {
        await switchToTitle(cdp, idleTitle).catch(() => false);
      }
      /** @type {{ pass: number, skip: number, fail: number } | undefined} */
      let firstCounts;
      for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
        const suffix = repeat > 1 ? `（第 ${runIndex}/${repeat} 次）` : "";
        console.log(`\n▶ [4.${index}] pnpm smoke:${plugin}-desktop --require${suffix}`);
        const desktop = await run([`smoke:${plugin}-desktop`, "--require"]);
        const counts = parseCounts(desktop.output);
        const verdict = desktopGateVerdict(counts);
        const countsText =
          counts === undefined
            ? "无计数行"
            : `${counts.pass} PASS / ${counts.skip} SKIP / ${counts.fail} FAIL`;
        if (desktop.code !== 0) {
          console.error(`FAIL 桌面回归失败：${plugin}${suffix}（${countsText}）`);
          result.desktopOk = false;
          result.detail = `桌面回归失败（${countsText}）`;
          break;
        }
        if (verdict !== "ok") {
          console.error(
            `FAIL 桌面回归判定：${plugin}${suffix} → ${verdict === "missing-counts" ? "脚本没打印计数行" : "全 SKIP/零断言"}（${countsText}）`,
          );
          result.desktopOk = false;
          result.detail = `桌面回归判定失败（${verdict}，${countsText}）`;
          break;
        }
        if (firstCounts === undefined) {
          firstCounts = counts;
        } else if (counts !== undefined) {
          // 数据相关分支（SKIP）几次之间可以不同；但任何一次 FAIL 都已经在上面中断。
          const drift = compareCounts(firstCounts, counts);
          if (drift !== null) {
            console.log(
              `  注意：第 ${runIndex} 次计数与第 1 次不同（${drift}）——数据相关分支允许不同，不允许失败`,
            );
          }
        }
        console.log(`✓ 桌面回归：${plugin}${suffix}（${countsText}）`);
      }
    }
    results.push(result);
  }

  if (cdp !== undefined) {
    if (originalSession !== null) {
      let restored = await switchToId(cdp, originalSession).catch(() => false);
      for (let attempt = 0; attempt < 2 && !restored; attempt += 1) {
        await sleep(800);
        restored = await switchToId(cdp, originalSession).catch(() => false);
      }
      const now = await currentSession(cdp).catch(() => null);
      if (!restored || now !== originalSession) {
        console.warn(
          `WARN 没能切回原会话 session:${originalSession}（当前 ${now ?? "未知"}）；请手动点一下侧栏`,
        );
      } else {
        console.log(`✓ 已切回原会话（session:${originalSession}）`);
      }
    }
    cdp.ws.close();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log("\n===== gate:all 汇总 =====");
  for (const result of results) {
    const web = result.webOk ? "web ✓" : "web ✗";
    const desktop = desktopEnabled ? (result.desktopOk ? "desktop ✓" : "desktop ✗") : "desktop -";
    console.log(
      `  ${result.plugin.padEnd(16)} ${web}  ${desktop}${result.detail === undefined ? "" : `  ${result.detail}`}`,
    );
  }
  const failed = results.filter((result) => !result.webOk || !result.desktopOk);
  if (failed.length > 0) {
    console.error(`\nFAIL ${failed.length}/${results.length} 个插件门禁失败（${seconds}s）`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS 全部插件门禁全绿（${results.length}/${RELEASE_PLUGINS.length} 个发布插件，${seconds}s${repeat > 1 ? `，桌面每步跑 ${repeat} 次` : ""}）`,
  );
};

if (isMain(import.meta.url)) await main();
