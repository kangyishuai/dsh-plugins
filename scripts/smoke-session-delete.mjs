#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:session-delete
//       SMOKE_DEMO=1 pnpm smoke:session-delete  —— 截图里的工作区名、会话标题、UUID 换成演示数据，可用于 README
// 端到端冒烟：临时 DSH_HOME 启动真实宿主 → 浏览器点一遍主链路 → 断言。
// 需要本机有 dsh 与 ego-browser；缺任意一个就跳过（退出码 0，打印 SKIP），方便在没有浏览器的 CI 上跑。
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const SHOTS_OUT = join(tmpdir(), "dsh-smoke-shots");
const PKG_DIR = join(REPO, "packages", "session-delete");

/** @param {string} message */
function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnOptions} [opts] */
async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts });
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
 * ego-browser 里跑的脚本：返回 { ok, checks }。
 * @param {string} url
 */
/**
 * ego-browser 里跑的脚本：返回 { ok, checks }，并把关键状态截图存到 SHOTS。
 * @param {string} url
 * @param {string} shots
 * @param {string} home
 * @param {boolean} [demo] 演示模式：截图前把工作区名、会话标题、UUID 换成演示数据（只改 DOM，用于公开截图）
 */
function browserScript(url, shots, home, demo = false) {
  return `
const task = await taskSpace("dsh smoke: session-delete");
const page = task.page("p1");
const SHOTS = ${JSON.stringify(shots)};
const HOME_DIR = ${JSON.stringify(home)};
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
const softCheck = (name, ok, detail) => checks.push({ name, ok: true, soft: !ok, detail: (ok ? "" : "WARN ") + (detail === undefined ? "" : String(detail)) });
const DEMO = ${JSON.stringify(demo)};
// 演示模式：第一次截图时记下真实的工作区名 / 会话标题，之后每次截图前把它们和 UUID 换成演示数据。
// 只改页面上的文字，不碰任何文件；React 重新渲染后会恢复，所以每张图前都要重新替换。
// 替换表存在脚本这边（demoMap），页面刷新后 window 上的状态会丢，不能只存在页面里。
let demoMap = null;
const anonymize = async () => { demoMap = await page.evaluate((saved) => {
  const DEMO_WORKSPACES = ["my-app", "blog", "sandbox", "notes", "infra"];
  const DEMO_SESSIONS = ["重构登录模块", "修复 CI 偶发失败", "撰写发布说明", "整理依赖升级", "排查内存泄漏", "设计数据表结构"];
  // 每次都重新扫描：折叠的工作区展开后会冒出新行，新标题追加进表，已分配的演示名保持不变
  const map = saved ? saved.slice() : [];
  const primaryText = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent || "").trim();
      if (t.length > 1 && !/^\\d+\\s*(秒|分钟|小时|天|周|个月|年)/.test(t)) return t;
    }
    return "";
  };
  const known = (t) => map.some(([real, fake]) => real === t || fake === t);
  const count = (kind) => map.filter((entry) => entry[2] === kind).length;
  for (const el of document.querySelectorAll("[data-row-key^='workspace:']")) {
    const t = primaryText(el);
    if (t && !known(t)) map.push([t, DEMO_WORKSPACES[count("w") % DEMO_WORKSPACES.length], "w"]);
  }
  for (const el of document.querySelectorAll("[data-row-key^='session:']")) {
    const t = primaryText(el);
    if (t && t !== "新会话" && t !== "未命名" && !known(t)) {
      map.push([t, DEMO_SESSIONS[count("s") % DEMO_SESSIONS.length], "s"]);
    }
  }
  map.sort((a, b) => b[0].length - a[0].length);
  const uuids = new Map();
  const fakeUuid = (u) => {
    if (!uuids.has(u)) {
      const i = uuids.size + 1;
      uuids.set(u, "0000000" + i + "-0000-4000-8000-00000000000" + i);
    }
    return uuids.get(u);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let t = n.textContent || "";
    const before = t;
    for (const [real, fake] of map) if (t.includes(real)) t = t.split(real).join(fake);
    t = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, fakeUuid);
    // 界面截断过的 ID 片段（如 session-8773d…）匹配不到完整 UUID，单独抹成 0
    t = t.replace(/(session-)([0-9a-f]{4,})(?![0-9a-f-])/gi, (_m, p, h) => p + "0".repeat(h.length));
    if (t !== before) n.textContent = t;
  }
  return map;
}, demoMap); };
const shot = async (name) => {
  if (DEMO) await anonymize().catch((error) => console.log("DEBUG anonymize", String(error).slice(0, 160)));
  await page.screenshot({ path: SHOTS + "/" + name + ".png" });
};
const dismiss = async () => {
  // 首启的「预览版说明 / 登录」弹层要点按钮关掉，Esc 不一定管用；
  // 它们的遮罩会把我们的浮层压暗，也会挡住真实指针事件。
  for (const label of ["继续", "开始使用", "跳过", "关闭"]) {
    await page.evaluate((text) => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text);
      if (btn) btn.click();
    }, label).catch(() => {});
    await page.waitForTimeout(250);
  }
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(200); }
};
// 侧栏第一行可能是「新会话」：它尚未落盘，data-row-key 也是 session:，
// 但删不掉、也不该参与行数断言。只统计有标题的真实会话行。
const rows = () => page.evaluate(() =>
  [...document.querySelectorAll("[data-row-key^='session:']")]
    .filter((el) => {
      const text = (el.innerText || "").trim();
      return text !== "" && text !== "新会话" && text !== "New chat" && text !== "未命名";
    })
    .map((el) => el.getAttribute("data-row-key")));
const openPanel = () => page.evaluate(async () => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  if (!btn) return "no-footer";
  btn.click();
  await new Promise((r) => setTimeout(r, 1300));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "missing";
});
const openConfirm = () => page.evaluate(async () => {
  const row = [...document.querySelectorAll("[data-row-key^='session:']")].find((el) => {
    const text = (el.innerText || "").trim();
    return text !== "" && text !== "新会话" && text !== "New chat" && text !== "未命名";
  });
  if (!row) return "no-session-row";
  // 行未激活时「…」菜单按钮不在 DOM 里（只在悬停/激活时渲染）。先点开这一行再悬停，
  // 否则下面按 aria-label 找到的会是别的行的按钮，菜单里没有删除项。
  row.click();
  await new Promise((r) => setTimeout(r, 900));
  row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const menuBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("会话“"));
  if (!menuBtn) return "no-menu-button";
  menuBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  const item = [...document.querySelectorAll("button, [role=menuitem]")].find((el) => (el.textContent || "").trim() === "删除会话…");
  if (!item) return "no-delete-item";
  item.click();
  await new Promise((r) => setTimeout(r, 2200));
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("移入回收站"));
  return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ") : "missing";
});
const clickDialogButton = (text) => page.evaluate(async (label) => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === label);
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}, text);
const dialogOpen = (needle) => page.evaluate((text) =>
  [...document.querySelectorAll('[role="dialog"]')].some((d) => (d.textContent || "").includes(text)), needle);

await page.goto(${JSON.stringify(url)});
await page.waitForTimeout(4500);
await dismiss();

// 1) slot 渲染
const slotErrors = await page.evaluate(() =>
  [...document.querySelectorAll("[data-slot-error]")].map((el) => el.getAttribute("data-slot-error")));
check("无 slot 渲染错误", slotErrors.length === 0, JSON.stringify(slotErrors));

// 2) 页脚入口 + hover 背景变化
const footerRect = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2,
    bg: getComputedStyle(btn).backgroundColor,
    label: btn.getAttribute("aria-label") };
});
check("侧栏页脚存在回收站入口", !!footerRect, footerRect && footerRect.label);
if (footerRect) {
  // 先确保窗口在前台（后台窗口不触发 :hover），再用真实鼠标移到按钮中心。
  await page.bringToFront?.().catch(() => {});
  await page.mouse.move(footerRect.x, footerRect.y).catch(() => {});
  await page.waitForTimeout(500);
  const hoverProbe = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
    if (!btn) return "no-button";
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return JSON.stringify({
      bg: getComputedStyle(btn).backgroundColor,
      inline: (btn.getAttribute("style") || "").includes("background"),
      topTag: top && top.tagName,
      topLabel: top && top.getAttribute && top.getAttribute("aria-label"),
      focused: document.hasFocus(),
    });
  });
  let hoverBg = "";
  try {
    hoverBg = JSON.parse(hoverProbe).bg;
  } catch (error) {
    hoverBg = "";
  }
if (footerRect) {
  // 真实 hover 需要窗口在前台；headless 下不保证，所以拿不到就退化为「样式表里存在
  // 该按钮的 :hover 规则」——确定性断言，仍然覆盖「hover 有视觉反馈」这件事。
  await page.bringToFront?.().catch(() => {});
  await page.mouse.move(footerRect.x, footerRect.y).catch(() => {});
  await page.waitForTimeout(500);
  const hoverProbe = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
    if (!btn) return { status: "no-button" };
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const cls = (btn.className || "").split(/s+/u).filter(Boolean)[0] || "";
    let cssHasHover = false;
    if (cls !== "") {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch (_error) {
          continue;
        }
        for (const rule of rules) {
          const text = rule.cssText || "";
          if (text.includes(":hover") && text.includes(cls)) {
            cssHasHover = true;
            break;
          }
        }
        if (cssHasHover) break;
      }
    }
    return {
      status: "ok",
      bg: getComputedStyle(btn).backgroundColor,
      topTag: top && top.tagName,
      cls: cls,
      cssHasHover: cssHasHover,
    };
  });
  const hoverOk =
    hoverProbe.status === "ok" &&
    (hoverProbe.bg !== footerRect.bg || hoverProbe.cssHasHover === true);
  check("页脚按钮 hover 有背景变化", hoverOk, JSON.stringify({ before: footerRect.bg, ...hoverProbe }));
}
  await shot("01-footer-hover");
}

// 3) 页脚 → 面板；Esc 关闭
const emptyPanel = await openPanel();
check("点击页脚可打开回收站面板", emptyPanel.includes("会话回收站"), emptyPanel.slice(0, 60));
check("空回收站显示空态", emptyPanel.includes("回收站是空的"), emptyPanel.slice(0, 60));
await shot("02-panel-empty");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("Esc 可关闭回收站面板", !(await dialogOpen("会话回收站")));

// 4) 菜单 → 确认框（含 plan）；Esc 关闭
const planText = await openConfirm();
check("会话菜单可打开确认框并渲染影响面", /约 [\\d.]+ ?(B|KB|MB|GB)/.test(planText), planText.slice(0, 140));
check(
  "确认框正文只留摘要，技术细节收进「详情」",
  planText.includes("详情") && !planText.includes("回收站："),
  planText.slice(0, 200),
);
// ② 默认选中：焦点必须在「移入回收站」上（宿主 Modal 认 [data-modal-autofocus]）。
const confirmFocus = await page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return null;
  return {
    tag: el.tagName,
    text: (el.textContent || "").trim(),
    auto: el.hasAttribute("data-modal-autofocus"),
  };
});
check(
  "确认框默认焦点在「移入回收站」上",
  !!confirmFocus && confirmFocus.tag === "BUTTON" && confirmFocus.text === "移入回收站",
  JSON.stringify(confirmFocus),
);
await shot("03-confirm-dialog");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("Esc 可关闭确认框", !(await dialogOpen("移入回收站")));

// 5) 执行删除 → 行消失 + toast
const beforeRows = await rows();
const deletedRowKey = beforeRows[0];
await openConfirm();
// ② 回车即生效：焦点已经在破坏性按钮上，敲 Enter 就应该直接执行，无需鼠标。
await page.keyboard.press("Enter");
await page.waitForTimeout(2600);
const confirmed = !(await dialogOpen("移入回收站"));
const afterRows = await rows();
// 按 ID 断言：侧栏只渲染固定条数，删掉一行后可能从折叠组补一行进来，
// 所以「总数减一」并不成立；真正要保证的是被删的那一行不在列表里。
check("确认后会话行消失", confirmed && deletedRowKey !== undefined && !afterRows.includes(deletedRowKey),
  "deleted=" + deletedRowKey + " before=" + beforeRows.length + " after=" + afterRows.length);
const toastVisible = await page.evaluate(() => document.body.innerText.includes("已移入回收站"));
check("删除后出现回执 toast", toastVisible);
await shot("04-after-delete");

// 6) 刷新不复活 + 角标
await page.reload();
await page.waitForTimeout(4500);
await dismiss();
const reloadRows = await rows();
const resurrected = beforeRows.filter((id) => !afterRows.includes(id)).filter((id) => reloadRows.includes(id));
check("刷新页面后已删会话不复活", resurrected.length === 0, JSON.stringify(resurrected));
const badge = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  return btn ? btn.getAttribute("aria-label") : "";
});
check("角标反映待恢复条目数", /\\(1\\)/.test(badge || ""), badge);

// 7) 面板条目 + 键盘导航
const withEntry = await openPanel();
check("回收站面板列出条目", withEntry.includes("恢复") && withEntry.includes("彻底删除"), withEntry.slice(0, 100));
check(
  "回收站支持全选与批量恢复/彻底删除",
  withEntry.includes("全选") && withEntry.includes("恢复（") && withEntry.includes("彻底删除（"),
  withEntry.slice(0, 160),
);
// ⑥ UI 减法：面板只有回收站一件事，审计/体检/回执已经搬到设置页。
check(
  "回收站面板不再有四个页签",
  !["审计", "体检", "回执"].some((label) => withEntry.includes(label)),
  withEntry.slice(0, 160),
);
await shot("05-panel-with-entry");
// ⑥ 行操作默认隐藏、悬停/聚焦才出现：用样式表断言，避免依赖窗口是否有焦点。
const rowActionsStyle = await page.evaluate(() => {
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_error) {
      continue;
    }
    for (const rule of rules) {
      const text = rule.cssText || "";
      if (text.includes(".dsh-sdel-row:hover") && text.includes(".dsh-sdel-row-actions")) return text;
    }
  }
  return "";
});
check("行操作按钮默认隐藏、悬停/聚焦才出现", rowActionsStyle !== "", rowActionsStyle.slice(0, 120));

// 8) 恢复
const restored = await clickDialogButton("恢复");
await page.waitForTimeout(2200);
const rowsAfterRestore = await rows();
const panelAfterRestore = await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "") : "";
});
check("恢复后会话回到列表", restored && deletedRowKey !== undefined && rowsAfterRestore.includes(deletedRowKey),
  "restored=" + deletedRowKey + " rows=" + rowsAfterRestore.length + "/" + beforeRows.length);
check("恢复后回收站清空", panelAfterRestore.includes("回收站是空的"));
await shot("06-after-restore");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 9) 再次删除 → 彻底删除
await openConfirm();
await clickDialogButton("移入回收站");
await page.waitForTimeout(2600);
await openPanel();
const purge = await clickDialogButton("彻底删除");
await page.waitForTimeout(400);
const purgeConfirm = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => (b.textContent || "").trim() === "不可恢复，确认",
  );
  if (!btn) return false;
  btn.click();
  await new Promise((r) => setTimeout(r, 1600));
  return true;
});
const afterPurge = await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent || "").includes("会话回收站"));
  return dlg ? (dlg.textContent || "") : "";
});
check("彻底删除后面板立即变空", purge && purgeConfirm && afterPurge.includes("回收站是空的"));
const badgeAfterPurge = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("回收站"));
  return btn ? btn.getAttribute("aria-label") : "";
});
check("彻底删除后角标归零", !/\\(\\d\\)/.test(badgeAfterPurge || ""), badgeAfterPurge);

// 10) 设置页「会话回收站」：偏好 / 概览 / 维护（原回收站面板的四个页签搬到这里）
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
// 设置面板的打开逻辑只写一次，挂到 window 上给后面几步复用：
// 面板在切换分节/重渲染后可能被 shell 关掉，测试要能幂等地重新打开。
await page.evaluate(() => {
  window.__openSdsSettings = async () => {
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const opener = '[data-shortcut-modal="settings"]';
    const isOpen = () => Boolean(document.querySelector(opener));
    const openOutline = async () => {
      for (const needle of ["设置", "账号菜单", "Settings"]) {
        if (isOpen()) return true;
        const btn = [...document.querySelectorAll("button")].find((b) =>
          (b.getAttribute("aria-label") || "").includes(needle));
        if (!btn) continue;
        btn.click();
        await sleepMs(900);
      }
      if (!isOpen()) {
        // Web 默认键位：primary+alt+Comma（macOS 上是 ⌘⌥,）
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: ",", code: "Comma", metaKey: true, altKey: true, ctrlKey: false, bubbles: true,
        }));
        await sleepMs(1000);
      }
      return isOpen();
    };
    if (!(await openOutline())) return "no-settings-panel";
    const shell = document.querySelector(opener);
    const nav = [...shell.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "会话回收站");
    if (!nav) return "no-section-nav";
    nav.click();
    await sleepMs(1600);
    return (document.querySelector(opener)?.textContent || "").replace(/\\s+/g, " ");
  };
});
const settingsText = await page.evaluate(async () => window.__openSdsSettings());
await shot("07-settings");

// ③ 记忆级联：把开关打开，主进程随后核对 preferences.json 是否真的落盘。
const cascadeToggled = await page.evaluate(async () => {
  if (!document.querySelector('[data-shortcut-modal="settings"]')) await window.__openSdsSettings();
  const panel = document.querySelector('[data-shortcut-modal="settings"]');
  if (!panel) return "no-panel";
  // 宿主 Switch 不一定是 input：可能是 role="switch" 的按钮，两种都认。
  const box = panel.querySelector('[role="switch"], input[type="checkbox"]');
  if (!box) return "no-switch";
  const isOn = () =>
    box.getAttribute("aria-checked") === "true" ||
    (box instanceof HTMLInputElement && box.checked === true);
  if (!isOn()) {
    box.click();
    await new Promise((r) => setTimeout(r, 1000));
  }
  return isOn() ? "on" : "off";
});
check("设置页开关可打开「记住级联选择」", cascadeToggled === "on", cascadeToggled);

// 维护区：展开审计日志（页面里只断言「能展开」，内容准确与否交给主进程读文件核对——
// 页面文本可能被宿主的脱敏层改写，用文本来断言审计内容不稳定）。
const auditExpanded = await page.evaluate(async () => {
  if (!document.querySelector('[data-shortcut-modal="settings"]')) await window.__openSdsSettings();
  const panel = document.querySelector('[data-shortcut-modal="settings"]');
  if (!panel) return "no-panel";
  // 折叠标题前面有 ▸ 字形，所以用 includes 而不是 startsWith。
  const toggle = [...panel.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes("审计日志"));
  if (!toggle) return "no-audit-toggle";
  toggle.click();
  await new Promise((r) => setTimeout(r, 900));
  return toggle.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed";
});
check("设置页的审计日志可展开", auditExpanded === "expanded", auditExpanded);
await shot("08-settings-audit");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// 12) 级联勾选框：遍历非选中会话行，找到带子会话的那一条（不改动任何东西）
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const ensureVictim = async () => {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) el.click();
  });
  await page.waitForTimeout(900);
  const hasNonSelected = await page.evaluate(() =>
    [...document.querySelectorAll("[data-row-key^='session:']")].some(
      (el) => el.getAttribute("aria-selected") !== "true" && !String(el.className).includes("_selected")));
  if (hasNonSelected) return;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "新建会话");
    if (btn) btn.click();
  });
  await page.waitForTimeout(1600);
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
};
await ensureVictim();
const sessionRows = await page.evaluate(() =>
  [...document.querySelectorAll("[data-row-key^='session:']")]
    .filter((el) => el.getAttribute("aria-selected") !== "true" && !String(el.className).includes("_selected"))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => el.getAttribute("data-row-key")));
let cascadeDetail = "no-parent-session";
for (const rowKey of sessionRows) {
  const rect = await page.evaluate((key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, rowKey);
  if (!rect) continue;
  await page.mouse.move(rect.x, rect.y);
  await page.waitForTimeout(600);
  await page.evaluate((key) => {
    const row = document.querySelector('[data-row-key="' + key + '"]');
    if (!row) return;
    row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    row.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  }, rowKey);
  await page.waitForTimeout(300);
  const probeResult = await page.evaluate(async (key) => {
    const rowEl = document.querySelector('[data-row-key="' + key + '"]');
    const rowButtons = rowEl ? [...rowEl.querySelectorAll("button")] : [];
    const menuBtn =
      rowButtons.find((b) => (b.getAttribute("aria-label") || "").includes("操作")) ||
      rowButtons[rowButtons.length - 1];
    if (!menuBtn) return "no-menu";
    menuBtn.click();
    await new Promise((r) => setTimeout(r, 450));
    const item = [...document.querySelectorAll("button, [role=menuitem]")].find(
      (el) => (el.textContent || "").trim() === "删除会话…");
    if (!item) return "no-item";
    item.click();
    await new Promise((r) => setTimeout(r, 1800));
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      (d.textContent || "").includes("移入回收站"));
    if (!dlg) return "no-dialog";
    const hasCheckbox =
      Boolean(dlg.querySelector('input[type="checkbox"]')) ||
      /同时删除|Also delete these/.test(dlg.textContent || "");
    return hasCheckbox ? "found:" + key : "none";
  }, rowKey);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  cascadeDetail = String(probeResult);
  if (cascadeDetail.startsWith("found:")) break;
}
check("有子会话的确认框出现级联勾选框", cascadeDetail.startsWith("found:"), cascadeDetail);
await shot("10-cascade-checkbox");

await task.finish({ keep: false }).catch(() => {});
console.log("SMOKE_RESULT " + JSON.stringify({ checks }));
`;
}

const main = async () => {
  if (!(await hasCommand("dsh"))) return console.log("SKIP 未找到 dsh");
  if (!(await hasCommand("ego-browser")))
    return console.log("SKIP 未找到 ego-browser（GUI 冒烟需要本机浏览器环境）");

  await rm(SHOTS_OUT, { recursive: true, force: true }).catch(() => {});
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  try {
    const profileSrc = join(process.env.HOME ?? "", ".dsh", "profiles", "desktop");
    const home = join(work, "home");
    const profile = join(home, "profiles", "sdel");
    await mkdir(join(home, "profiles"), { recursive: true });
    await cp(profileSrc, profile, { recursive: true });
    for (const dir of ["sessions", "storages"]) {
      await cp(join(process.env.HOME ?? "", ".dsh", dir), join(home, dir), {
        recursive: true,
      }).catch(() => {});
    }
    const profileJson = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
    profileJson.name = "dsh-profile-sdel-smoke";
    await writeFile(join(profile, "package.json"), JSON.stringify(profileJson, null, 2));

    // 没有会话就没什么可删的，直接跳过而不是误报失败
    const sessionRoots = await readdir(join(home, "sessions"), { withFileTypes: true }).catch(
      () => [],
    );
    let hasSession = false;
    for (const entry of sessionRoots) {
      if (!entry.isDirectory()) continue;
      const inner = await readdir(join(home, "sessions", entry.name), {
        withFileTypes: true,
      }).catch(() => []);
      if (inner.some((item) => item.isDirectory())) {
        hasSession = true;
        break;
      }
    }
    if (!hasSession) {
      console.log("SKIP 临时 profile 里没有会话，先随便开一个会话再跑");
      return;
    }

    // 打当前源码的包，装进临时 profile
    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");

    const env = { ...process.env, DSH_HOME: home };
    await run("dsh", ["plugin", "--profile", "sdel", "install"], { env }).catch(() => {});
    await run("dsh", ["plugin", "--profile", "sdel", "remove", "@kangyishuai/dsh-session-delete"], {
      env,
    }).catch(() => {});
    await run("dsh", ["plugin", "--profile", "sdel", "add", join(work, tgz)], { env });

    const logPath = join(work, "host.log");
    host = spawn("dsh", ["--profile", "sdel", "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {string[]} */
    const chunks = [];
    host.stdout?.on("data", (/** @type {any} */ c) => chunks.push(String(c)));
    host.stderr?.on("data", (/** @type {any} */ c) => chunks.push(String(c)));
    void writeFile(logPath, "");
    const flush = async () => writeFile(logPath, chunks.join(""));
    const poll = setInterval(flush, 300);

    /** @type {{ port: number, token: string, activationFailures: number, text: string }} */
    let boot;
    try {
      boot = await waitForBoot(logPath, 60_000);
    } finally {
      clearInterval(poll);
      await flush();
    }
    await run("dsh", ["--version"], { env }).catch(() => {});
    if (boot.activationFailures > 0) {
      fail(`宿主报告 ${boot.activationFailures} 个插件未激活`);
      console.error(boot.text.slice(-3000));
      return;
    }

    const url = `http://127.0.0.1:${boot.port}/?token=${boot.token}`;
    const shotsDir = join(work, "shots");
    await mkdir(shotsDir, { recursive: true });
    const browserFile = join(work, "browser.mjs");
    const browserSource = browserScript(url, shotsDir, home, process.env.SMOKE_DEMO === "1");
    await writeFile(browserFile, browserSource);
    await writeFile(join(shotsDir, "browser.mjs"), browserSource);

    const result = await new Promise((resolvePromise) => {
      const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
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

    if (process.env.SMOKE_DEBUG) console.log(String(result).slice(-5000));
    const match = String(result).match(/SMOKE_RESULT (\{.*\})/u);
    if (!match) {
      fail("浏览器脚本没有返回结果");
      console.error(String(result).slice(-4000));
      return;
    }
    /** @type {{ checks: { name: string, ok: boolean, detail: string }[] }} */
    /** @type {{ checks: { name: string, ok: boolean, detail: string }[] }} */
    const parsed = JSON.parse(match[1]);
    // ③ 记忆级联是「宿主侧持久化」，所以要绕过页面直接核对文件：
    // 页面里勾过开关，退出后文件必须还在（localStorage 会因为 Web 端口变化而丢）。
    const prefsFile = join(home, "session-trash", "preferences.json");
    let prefs = null;
    try {
      prefs = JSON.parse(await readFile(prefsFile, "utf8"));
    } catch {
      prefs = null;
    }
    parsed.checks.push({
      name: "级联记忆写入 preferences.json",
      ok: prefs !== null && prefs.cascadeChildren === true,
      detail: prefsFile,
    });
    // 审计日志：UI 已经搬到设置页，内容正确性在这里用文件核对（页面文本会被脱敏层改写）。
    const auditFile = join(home, "session-trash", "audit.log");
    const auditText = await readIfExists(auditFile);
    parsed.checks.push({
      name: "审计日志记录了 trash/restore/purge",
      ok:
        /"action":"trash"/u.test(auditText) &&
        /"action":"restore"/u.test(auditText) &&
        /"action":"purge"/u.test(auditText),
      detail: auditFile,
    });
    let failed = 0;
    for (const item of parsed.checks) {
      console.log(
        (item.ok ? "PASS " : "FAIL ") + item.name + (item.ok ? "" : ` :: ${item.detail}`),
      );
      if (!item.ok) failed += 1;
    }
    if (failed > 0) {
      fail(`${failed} 项断言失败`);
      return;
    }
    console.log(`PASS 全部 ${parsed.checks.length} 项冒烟断言通过`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    host?.kill("SIGTERM");
    await sleep(500);
    // 把截图留在固定路径，失败时也能看现场
    await cp(join(work, "shots"), SHOTS_OUT, { recursive: true }).catch(() => {});
    console.log(`截图目录：${SHOTS_OUT}`);
    await rm(work, { recursive: true, force: true });
  }
};

await main();
