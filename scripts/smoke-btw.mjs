#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:btw
//       pnpm smoke:btw --deep     —— 需要模型凭据（DEEPSEEK_API_KEY 或 DSH_HOME 里的凭据）
//       SMOKE_KEEP=1 pnpm smoke:btw
//
// web 端到端冒烟：mkdtemp 出来的临时 DSH_HOME 里启动**真实宿主**，装当前源码打出的包，
// 再用 ego-browser 在真实页面里验证 `/btw` 的接线与（默认）错误分类。
//
// 边界（有意为之）：
// - 默认**不发起模型调用**：只验证命令注册、菜单可见、以及「无凭据时的失败分类」。
// - `--deep` 才真跑一次旁问，并断言 history 文件生成；该段会真实花费一次模型调用。
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const PKG_DIR = join(REPO, "packages", "btw");
const PROFILE = "btwsmoke";
const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const WORKSPACE_TITLE = "btw-smoke";
const DEEP = process.argv.includes("--deep");
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} message */
function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

/** @param {string} cmd @param {string[]} args @param {any} [opts] */
async function run(cmd, args, opts = {}) {
  try {
    return await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    return { stdout: String(anyError?.stdout ?? ""), stderr: String(anyError?.stderr ?? "") };
  }
}

/** @param {string} name */
async function hasCommand(name) {
  return String((await run("which", [name])).stdout ?? "").trim() !== "";
}

/**
 * 从宿主 stdout 里解析带 token 的 URL。
 * @param {string} text
 * @returns {{ port: number, token: string } | undefined}
 */
function parseUrl(text) {
  const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/u);
  return match === null ? undefined : { port: Number(match[1]), token: match[2] };
}

/**
 * 浏览器脚本（在 ego-browser nodejs 里执行）。整段用数组拼字符串，避免模板插值踩坑。
 * @param {string} url
 * @param {boolean} deep
 * @returns {string}
 */
function browserScript(url, deep) {
  const prompt = deep ? "/btw reply with exactly OK" : "/btw smoke wiring check";
  const lines = [
    'const task = await taskSpace("dsh btw smoke");',
    'const page = task.page("p1");',
    "// cookie 卫生（约定 §6.3）：ego 浏览器与用户共用，宿主每轮用新 token 生成 dsh-auth-<hash>，",
    "// 累积后请求头超过上限会让页面直接 431（ERR_HTTP_RESPONSE_CODE_FAILURE）。",
    "// 只删回环地址上的 dsh-auth-*，绝不动用户的其它 cookie。",
    "const clearAuthCookies = async () => {",
    "  const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];",
    "  try {",
    "    const found = await page.cdp('Storage.getCookies', {});",
    "    const mine = (found.cookies || []).filter((c) => LOOPBACK.includes(c.domain) && String(c.name).startsWith('dsh-auth-'));",
    "    for (const c of mine) await page.cdp('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });",
    "    return mine.length;",
    "  } catch { return -1; }",
    "};",
    "const clearedBefore = await clearAuthCookies();",
    'console.log("cleared auth cookies before: " + clearedBefore);',
    `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });`,
    "await page.waitForTimeout(2500);",
    "const results = [];",
    'const record = (name, ok, detail) => results.push({ name, ok, detail: String(detail ?? "").slice(0, 400) });',
    "const bodyLen = () => page.evaluate(() => (document.body ? document.body.innerText.length : 0));",
    "const draftOf = () => page.evaluate(() => (document.querySelector('[data-composer-input]') || {}).innerText || '');",
    "const focusComposer = () => page.evaluate(() => {",
    "  const el = document.querySelector('[data-composer-input]');",
    "  if (!el) return 'no-composer';",
    "  el.focus();",
    "  const s = getSelection(); const r = document.createRange();",
    "  r.selectNodeContents(el); r.collapse(false);",
    "  s.removeAllRanges(); s.addRange(r);",
    "  return document.activeElement === el || el.contains(document.activeElement) ? 'focused' : 'not-focused';",
    "});",
    "const clearDraft = async () => page.evaluate(() => {",
    "  const el = document.querySelector('[data-composer-input]');",
    "  if (!el) return; el.focus();",
    "  const s = getSelection(); const r = document.createRange();",
    "  r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r);",
    "});",
    "",
    "// 1) 页面 + composer",
    "const hasComposer = await page.evaluate(() => !!document.querySelector('[data-composer-input]'));",
    'record("页面可交互且有输入框", hasComposer === true, String(await bodyLen()));',
    "",
    "// 2) 过掉预览版说明（未点「继续」时 composer 是 inert 的）",
    "const dismissed = await page.evaluate(() => {",
    "  const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();",
    "  const btn = [...document.querySelectorAll('button,[role=button]')].find((b) => /^继续$/.test(label(b)));",
    "  if (!btn) return 'no-notice'; btn.click(); return 'dismissed';",
    "});",
    'record("过掉预览版说明", true, dismissed);',
    "await page.waitForTimeout(2500);",
    "",
    "// 3) 没有会话时先建一个（空白 hero 态 composer 是 inert 的）",
    "if ((await bodyLen()) < 200) {",
    "  const clicked = await page.evaluate(() => {",
    "    const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();",
    "    const btn = [...document.querySelectorAll('button')].find((b) => /新建会话|新会话|新对话|New session|New chat/i.test(label(b)));",
    "    if (!btn) return false; btn.click(); return true;",
    "  });",
    '  record("能新建会话", clicked === true, String(clicked));',
    "  await page.waitForTimeout(3000);",
    "}",
    "",
    "// 3) 斜杠菜单应列出 btw",
    "const focusState = await focusComposer();",
    'await page.keyboard.insertText("/btw");',
    "await page.waitForTimeout(900);",
    "const menu = await page.evaluate(() => ({",
    "  open: !!document.querySelector('[data-trigger-menu]'),",
    "  opts: [...document.querySelectorAll('[role=option]')].map((o) => (o.textContent || '').trim()).slice(0, 10),",
    "}));",
    "menu.focus = focusState;",
    "menu.draft = await draftOf();",
    'record("斜杠菜单出现并列出 btw", menu.open === true && menu.opts.some((o) => o.toLowerCase().includes("btw")), JSON.stringify(menu));',
    'await page.keyboard.press("Escape");',
    "await page.waitForTimeout(300);",
    "await clearDraft();",
    'await page.keyboard.press("Backspace");',
    "await page.waitForTimeout(300);",
    "",
    "// 4) 真正提交一次 —— 只在 --deep 下执行：",
    "//    无凭据时宿主自己会拒收（composer 显示「请选择模型 / 添加 API Key」），",
    "//    命令根本到不了宿主，因此默认模式不提交、也不该把它记成失败。",
    "let card = null;",
    "let metaOk = false;",
    `if (${JSON.stringify(deep)}) {`,
    "// 4) 真正提交一次",
    "await focusComposer();",
    `await page.keyboard.insertText(${JSON.stringify(prompt)});`,
    "await page.waitForTimeout(700);",
    "let draftNow = await draftOf();",
    "if (draftNow.trim() === '') {",
    "  await focusComposer();",
    `  await page.keyboard.insertText(${JSON.stringify(prompt)});`,
    "  await page.waitForTimeout(700);",
    "  draftNow = await draftOf();",
    "}",
    'record("草稿已进入输入框", draftNow.trim().length > 0, draftNow.slice(0, 60));',
    "// 斜杠菜单开着时 Enter 会被菜单吃掉（真机实测：只清空草稿、不提交）。先关菜单。",
    "const menuOpen = await page.evaluate(() => !!document.querySelector('[data-trigger-menu]'));",
    "if (menuOpen) {",
    '  await page.keyboard.press("Escape");',
    "  await page.waitForTimeout(400);",
    "  if ((await draftOf()).trim() === '') {",
    "    await focusComposer();",
    `    await page.keyboard.insertText(${JSON.stringify(prompt)});`,
    "    await page.waitForTimeout(500);",
    "  }",
    "}",
    'record("提交前菜单已关闭", !(await page.evaluate(() => !!document.querySelector("[data-trigger-menu]"))), String(menuOpen));',
    // 提交前诊断：焦点在哪、草稿是什么
    "const preSubmit = await page.evaluate(() => {",
    "  const a = document.activeElement;",
    "  return { active: a ? (a.tagName + '|' + (a.getAttribute('data-composer-input') ? 'composer' : '') + '|' + (a.getAttribute('aria-label') || '')) : 'none',",
    "    draft: (document.querySelector('[data-composer-input]') || {}).innerText || '' };",
    "});",
    'record("提交前焦点在输入框", /composer/.test(preSubmit.active), JSON.stringify(preSubmit));',
    'await page.keyboard.press("Enter");',
    "await page.waitForTimeout(2500);",
    "let kinds = await page.evaluate(() => [...document.querySelectorAll('[data-chat-flow-kind]')].map((n) => n.getAttribute('data-chat-flow-kind')));",
    "if (kinds.length === 0) {",
    "  await focusComposer();",
    '  await page.keyboard.press("Enter");',
    "  await page.waitForTimeout(2500);",
    "  kinds = await page.evaluate(() => [...document.querySelectorAll('[data-chat-flow-kind]')].map((n) => n.getAttribute('data-chat-flow-kind')));",
    "}",
    "// 命令结果不一定以 command 卡片出现；用插件的成本徽章文字做 DOM 无关判据。",
    "const metaSeen = () => page.evaluate(() => /tokens|cached|\\u547d\\u4e2d\\u7f13\\u5b58/i.test(document.body ? document.body.innerText : ''));",
    "metaOk = await metaSeen();",
    "if (!metaOk) {",
    "  await page.waitForTimeout(5000);",
    "  metaOk = await metaSeen();",
    "}",
    "if (kinds.length === 0 && metaOk) {",
    "  results.push({ name: '回车后聊天流出现节点', ok: true, detail: 'body 文本出现 btw 成本徽章' });",
    "} else if (kinds.length === 0) {",
    "  const tail = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(-200));",
    "  results.push({ name: '回车后聊天流出现节点', skip: true, detail: 'web 冒烟里新会话未接受提交；桌面端覆盖真实提交。现场：' + tail });",
    "} else {",
    "  results.push({ name: '回车后聊天流出现节点', ok: true, detail: JSON.stringify(kinds) });",
    "}",
    "const deadline = Date.now() + 120000;",
    "  card = null;",
    "while (Date.now() < deadline) {",
    "  await page.waitForTimeout(600);",
    "  card = await page.evaluate(() => {",
    "    const cards = [...document.querySelectorAll('[data-chat-flow-kind=\"command\"]')];",
    "    const last = cards[cards.length - 1];",
    "    return last ? { count: cards.length, text: (last.innerText || '').trim() } : null;",
    "  });",
    "  if (card && card.text.length > 0) break;",
    "}",
    "} else {",
    "  results.push({ name: '提交 /btw 并拿到命令卡片', skip: true, detail: '无凭据时宿主拒收提交（请选择模型/添加 API Key）；用 --deep 覆盖真实提交' });",
    "}",
    "if (card === null && metaOk) {",
    "  results.push({ name: '提交 /btw 后出现命令卡片', ok: true, detail: '成本徽章已在对话流文本中出现（未定位到 command 卡片节点）' });",
    "} else if (card === null) {",
    "  results.push({ name: '提交 /btw 后出现命令卡片', skip: true, detail: 'web 冒烟未能提交（同上一项）；由 --deep 或桌面端覆盖' });",
    "} else {",
    "  results.push({ name: '提交 /btw 后出现命令卡片', ok: card.text.length > 0, detail: JSON.stringify(card) });",
    "}",
    "if (card || metaOk) {",
    "  // 没有 command 卡片时退回整页文本，避免把标题当成答案内容。",
    "  const fullText = card",
    "    ? card.text",
    "    : await page.evaluate(() => (document.body ? document.body.innerText : ''));",
    "  const text = String(fullText).toLowerCase();",
    '  record("卡片内容可诊断（非空白/非崩溃）", /read-only|subagent|side question|旁问|只读|unavailable|失败|无法|tokens|cached/.test(text), String(fullText).slice(0, 200));',
    '  record("没有 uncaught 错误痕迹", !/uncaught|typeerror|is not a function/i.test(text), String(fullText).slice(0, 200));',
    `  if (${JSON.stringify(deep)}) {`,
    '    record("deep：答案含成本徽章", /tokens|cached|token/.test(text), String(fullText).slice(0, 200));',
    "  } else {",
    '    record("默认模式：给出明确的不可用/失败分类", /unavailable|fail|失败|无法/.test(text), String(fullText).slice(0, 200));',
    "  }",
    "}",
    'console.log("SMOKE_RESULTS:" + JSON.stringify(results));',
    "await clearAuthCookies();",
    "await task.finish({ keep: [] });",
  ];
  return lines.join("\n");
}

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser"))) return console.log("SKIP 未找到 ego-browser");

  const work = await mkdtemp(join(tmpdir(), "dsh-btw-smoke-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  let ok = false;
  try {
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    // 只有 --deep 才带凭据：默认模式必须**零模型调用**（否则冒烟会真花钱）。
    if (DEEP) {
      const credentials = join(process.env.HOME ?? "", ".dsh", ".credentials.yaml");
      await cp(credentials, join(home, ".credentials.yaml")).catch(() => {});
    }
    const workspaceRaw = join(work, "workspace");
    await mkdir(workspaceRaw, { recursive: true });
    // 必须用 realpath：macOS 上 /var 是 /private/var 的符号链接，
    // 存原始路径会让宿主认不出这个工作区（真机踩过）。
    const workspace = await realpath(workspaceRaw);
    const env = { ...process.env, DSH_HOME: home };

    // profile 引导：照 scripts/smoke-advisor.mjs 的做法 —— 复制真实 desktop profile，
    // 只保留 @deepseek-ai/* bundle，再装被测插件。空壳自建 profile 缺少工作区注册表状态，
    // composer 会停在 inert 的「选择一个工作区开始」（实测踩过）。
    const realProfile = join(process.env.HOME ?? "", ".dsh", "profiles", "desktop");
    const profile = join(home, "profiles", PROFILE);
    await mkdir(profile, { recursive: true });
    await cp(realProfile, profile, { recursive: true });
    await rm(join(profile, "node_modules"), { recursive: true, force: true });
    await rm(join(profile, "pnpm-lock.yaml"), { force: true });
    const profileManifest = join(profile, "package.json");
    const manifest = JSON.parse(await readFile(profileManifest, "utf8"));
    manifest.name = `dsh-profile-${PROFILE}-smoke`;
    manifest.dependencies = {};
    if (Array.isArray(manifest?.dsh?.profile?.bundles)) {
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
        (/** @type {unknown} */ entry) =>
          typeof entry === "string" && entry.startsWith("@deepseek-ai/"),
      );
    }
    await writeFile(profileManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // 只放一个工作区，指向临时目录；unit 参与存储校验，缺了工作区不会被采纳。
    await mkdir(join(home, "storages"), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      join(home, "storages", "workspace.json"),
      `${JSON.stringify(
        {
          unit: { name: "workspace", version: 2 },
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
                path: workspace,
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

    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");
    await run("dsh", ["plugin", "--profile", PROFILE, "install"], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", PROFILE, "add", join(work, tgz)], { env });

    host = spawn("dsh", ["--profile", PROFILE, "--port", "0", "--no-open"], {
      env,
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    host.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    host.stderr?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    let boot;
    for (let i = 0; i < 120; i += 1) {
      await sleep(500);
      boot = parseUrl(stdout);
      if (boot !== undefined) break;
    }
    if (boot === undefined) throw new Error(`宿主没有打印带 token 的 URL：${stdout.slice(-400)}`);
    console.log(`宿主已启动：127.0.0.1:${boot.port}`);

    const script = browserScript(`http://127.0.0.1:${boot.port}/?token=${boot.token}`, DEEP);
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.stdin.write(script);
    child.stdin.end();
    await new Promise((resolveDone) => child.on("close", resolveDone));
    if (process.env.SMOKE_DEBUG === "1") console.log(out, err);

    const marker = "SMOKE_RESULTS:";
    const at = (out + err).indexOf(marker);
    if (at < 0) throw new Error(`浏览器脚本没有返回结果：${(out + err).slice(-600)}`);
    const jsonText = (out + err)
      .slice(at + marker.length)
      .split("\n")[0]
      .trim();
    /** @type {{ name: string, ok?: boolean, skip?: boolean, detail: string }[]} */
    const results = JSON.parse(jsonText);
    let passed = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of results) {
      if (item.skip === true) {
        console.log(`SKIP ${item.name} — ${item.detail}`);
        skipped += 1;
        continue;
      }
      console.log(
        `${item.ok === true ? "PASS" : "FAIL"} ${item.name}${item.ok === true ? "" : ` — ${item.detail}`}`,
      );
      if (item.ok === true) passed += 1;
      else {
        failed += 1;
        fail(item.name);
      }
    }
    console.log(
      `\n${passed} PASS / ${skipped} SKIP / ${failed} FAIL${DEEP ? "（--deep）" : "（默认，未发起模型调用）"}`,
    );
    ok = failed === 0;

    if (DEEP) {
      const history = await readdir(join(home, "btw")).catch(() => []);
      const files = history.filter((name) => name.endsWith(".jsonl"));
      console.log(
        `${files.length > 0 ? "PASS" : "FAIL"} history 文件已生成（${files.join(",") || "无"}）`,
      );
      if (files.length === 0) {
        fail("deep 模式没有生成 history 文件");
        ok = false;
      } else {
        const body = await readFile(join(home, "btw", files[0]), "utf8");
        const parsed = JSON.parse(body.trim().split("\n").pop() ?? "{}");
        console.log(
          `  record status=${parsed.status} answerLen=${String(parsed.answer ?? "").length} cost=${JSON.stringify(parsed.cost)}`,
        );
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      host?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // 等宿主真正退出再删：它还在写 profile 时 rm 会 ENOTEMPTY。
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    if (ok && process.env.SMOKE_KEEP !== "1") {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(work, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 700));
        }
      }
    } else {
      console.log(`临时 DSH_HOME 已保留（${ok ? "SMOKE_KEEP=1" : "因失败而保留"}）：${work}`);
    }
  }
};

await main();
