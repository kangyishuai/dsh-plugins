// @ts-check
// 守护 web 冒烟「生成的 browser.mjs」的语法（含模板字符串里的正则转义）。
//
// 背景见 scripts/check-smoke-browser-scripts.mjs：browserScript 返回字符串，外层
// `node --check` 看不到里面的语法错误。2026-11-28 回归里 smoke-projects 的
// `/workspaces/<id>/u.test(...)` 少了一层 `\/`，生成脚本直接 "Invalid regular expression flags"。

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkBrowserScripts,
  checkGeneratedSource,
  ENTRIES,
  toRenderModule,
} from "../check-smoke-browser-scripts.mjs";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

test("所有 web 冒烟的生成脚本都能通过 node --check", async () => {
  const { failed, results } = await checkBrowserScripts(() => {});
  assert.equal(
    failed,
    0,
    results
      .filter((item) => !item.ok)
      .map((item) => item.detail)
      .join("\n"),
  );
  assert.equal(results.length, ENTRIES.length);
});

test("checkGeneratedSource 抓得住「模板里正则少转义」这类语法错误", async () => {
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-syntax-check-"));
  try {
    // 错误写法：模板里 `/workspaces/<id>/u` 会被解析成 `/workspaces/` + 非法 flags `<id>/u`
    //（与 2026-11-28 回归里 smoke-projects 那行同形）。
    const brokenPath = join(work, "browser-broken.mjs");
    const brokenSource =
      'const noDirHint = "x";\n' +
      "const ok = /workspaces/<id>/u.test(noDirHint) && /bound/u.test(noDirHint);\n";
    await writeFile(brokenPath, brokenSource, "utf8");
    const broken = checkGeneratedSource(brokenSource, brokenPath);
    assert.equal(broken.ok, false);
    assert.match(broken.detail, /Invalid regular expression flags/u);

    // 正确写法：正则里的 `/` 用 `\/` 转义（也就是 .mjs 源码模板里写 `\\/`）。
    const goodPath = join(work, "browser-good.mjs");
    const goodSource =
      'const hint = "workspaces/<id>";\nconst ok = /workspaces\\/<id>/u.test(hint);\n';
    await writeFile(goodPath, goodSource, "utf8");
    const good = checkGeneratedSource(goodSource, goodPath);
    assert.equal(good.ok, true, good.detail);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("ENTRIES 覆盖所有使用 ego taskSpace 的冒烟脚本", async () => {
  const files = (await readdir(SCRIPTS_DIR))
    .filter((name) => name.startsWith("smoke-") && name.endsWith(".mjs"))
    .filter((name) => !name.endsWith("-desktop.mjs") && name !== "smoke-agent-tool.mjs");
  const covered = new Set(ENTRIES.map((entry) => entry.file));
  /** @type {string[]} */
  const missing = [];
  for (const file of files) {
    const source = await readFile(join(SCRIPTS_DIR, file), "utf8");
    if (!source.includes("taskSpace(")) continue;
    // 截图工具（readme-shots）用内联模板生成脚本，不走 browserScript()，不在本检查范围。
    if (file === "readme-shots-session-rewind.mjs") continue;
    if (!covered.has(file)) missing.push(file);
  }
  assert.deepEqual(missing, [], `这些脚本用了 taskSpace 但没登记进检查清单：${missing.join("、")}`);
});

test("toRenderModule 认不出入口形态时直接失败（不静默跳过）", () => {
  assert.throws(() => toRenderModule("const x = 1;\n", "browserScript"), /await main/u);
});
