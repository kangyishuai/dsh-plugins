#!/usr/bin/env node
// @ts-check
// 检查各 web 冒烟「生成的 browser.mjs」本身是合法 ESM。
//
// 为什么需要：`browserScript()` 返回的是**字符串模板**，模块自己的 `node --check` 只校验外层
// 模板语法，看不到生成脚本里的正则/转义。2026-11-28 的回归里 `smoke-projects` 就踩了：
// 模板里写 `/workspaces/<id>/u.test(...)`（少一层 `\/`），生成的脚本报
// `Invalid regular expression flags`，浏览器整段脚本起不来，冒烟表现为「没有返回结果」。
//
// 做法：临时副本里删掉末尾的 `await main();` 并导出 render 函数，用**假参数**渲染，
// 再交给 `node --check`（.mjs，允许 top-level await）。不启动宿主、不碰用户浏览器。

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ name: string, file: string, render: string, args: unknown[] }} Entry */

/** web 冒烟清单：脚本 / 导出的渲染函数名 / 渲染参数（假值即可，只关心生成脚本的语法）。 */
/** @type {Entry[]} */
export const ENTRIES = [
  {
    name: "advisor",
    file: "smoke-advisor.mjs",
    render: "browserScript",
    args: ["http://127.0.0.1:65535/?token=check", "/tmp/dsh-smoke-check/shots"],
  },
  {
    name: "artifacts",
    file: "smoke-artifacts.mjs",
    render: "makeBrowserScript",
    args: [
      {
        url: "http://127.0.0.1:65535/?token=check",
        space: "dsh artifacts smoke check",
        project: "project-1",
        projectArtifact: "artifact-1",
        markdownArtifact: "artifact-2",
        imageArtifact: "artifact-3",
      },
    ],
  },
  {
    name: "btw",
    file: "smoke-btw.mjs",
    render: "browserScript",
    args: ["http://127.0.0.1:65535/?token=check", false],
  },
  {
    name: "index",
    file: "smoke-index.mjs",
    render: "browserScript",
    args: [
      "http://127.0.0.1:65535/?token=check",
      "/tmp/dsh-smoke-check/shots",
      "http://127.0.0.1:65535/good/index.json",
      "http://127.0.0.1:65535/broken/index.json",
      { deleteTitle: "会话删除", rewindTitle: "会话回滚" },
    ],
  },
  {
    name: "next-step",
    file: "smoke-next-step.mjs",
    render: "browserScript",
    args: [
      "http://127.0.0.1:65535/?token=check",
      "/tmp/dsh-smoke-check/shots",
      "/tmp/dsh-smoke-check/home",
      false,
    ],
  },
  {
    name: "projects",
    file: "smoke-projects.mjs",
    render: "browserScript",
    args: [
      "http://127.0.0.1:65535/?token=check",
      "/tmp/dsh-smoke-check/shots",
      "/tmp/dsh-smoke-check/ws",
      "/tmp/dsh-smoke-check/ws2",
    ],
  },
  {
    name: "session-delete",
    file: "smoke-session-delete.mjs",
    render: "browserScript",
    args: [
      "http://127.0.0.1:65535/?token=check",
      "/tmp/dsh-smoke-check/shots",
      "/tmp/dsh-smoke-check/home",
      false,
    ],
  },
  {
    name: "session-rewind",
    file: "smoke-session-rewind.mjs",
    render: "browserScript",
    args: [
      "http://127.0.0.1:65535/?token=check",
      "/tmp/dsh-smoke-check/shots",
      "/tmp/dsh-smoke-check/home",
    ],
  },
];

const SCRIPTS_DIR = resolve(import.meta.dirname);

/**
 * 从源文件里抠出渲染函数：去掉文件末尾的入口调用并导出渲染函数。
 * 注意：只对「末尾是 `await main();`」的冒烟脚本成立（本文件的 ENTRIES 都是）。
 * @param {string} source
 * @param {string} render
 * @returns {string}
 */
export function toRenderModule(source, render) {
  const entry = /\nawait main\(\);\s*$/u.exec(source);
  if (entry === null) {
    throw new Error("脚本末尾没有 `await main();`：不认识的冒烟入口形态，无法抽出渲染函数");
  }
  return `${source.slice(0, entry.index)}\nexport { ${render} as __renderScript };\n`;
}

/**
 * 把生成脚本落盘并交给 `node --check`（.mjs，允许 top-level await）。
 * @param {string} generated
 * @param {string} generatedPath
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkGeneratedSource(generated, generatedPath) {
  const checked = spawnSync(process.execPath, ["--check", generatedPath], { encoding: "utf8" });
  if (checked.status === 0) {
    return { ok: true, detail: `${generated.length} 字符，node --check 通过` };
  }
  const stderr = String(checked.stderr ?? "").trim();
  const lineMatch = /browser-\w+\.mjs:(\d+)/u.exec(stderr);
  const line = lineMatch ? Number(lineMatch[1]) : 0;
  const context =
    line > 0
      ? generated
          .split("\n")
          .slice(Math.max(0, line - 2), line + 1)
          .map((text, index) => `${Math.max(1, line - 1) + index}: ${text}`)
          .join("\n")
      : "";
  return {
    ok: false,
    detail: `生成的 browser.mjs 语法错误（常见原因：模板里的正则分隔符少转义）\n${stderr}\n${context}`,
  };
}

/**
 * 校验一个条目：渲染 + `node --check`。
 * @param {Entry} entry
 * @param {string} work 临时工作目录（已创建）
 * @returns {Promise<{ name: string, ok: boolean, detail: string }>}
 */
export async function checkEntry(entry, work) {
  const target = join(SCRIPTS_DIR, entry.file);
  const source = await readFile(target, "utf8");
  // 临时副本必须放回 scripts/ 同级：脚本里的相对 import（./lib/…、../packages/…）与
  // import.meta.dirname 派生的路径都按原位置解析。
  const modulePath = join(SCRIPTS_DIR, `.check-browser-${entry.name}-${process.pid}.mjs`);
  const generatedPath = join(work, `browser-${entry.name}.mjs`);
  try {
    const moduleSource = toRenderModule(source, entry.render);
    await writeFile(modulePath, moduleSource, "utf8");
    const module = await import(pathToFileURL(modulePath).href);
    const render = /** @type {(...args: unknown[]) => string} */ (module.__renderScript);
    if (typeof render !== "function") {
      return { name: entry.name, ok: false, detail: `没有导出渲染函数 ${entry.render}` };
    }
    const generated = render(...entry.args);
    if (typeof generated !== "string" || generated.trim() === "") {
      return { name: entry.name, ok: false, detail: `${entry.render}() 没有返回脚本源码` };
    }
    await writeFile(generatedPath, generated, "utf8");
    return { name: entry.name, ...checkGeneratedSource(generated, generatedPath) };
  } finally {
    await rm(modulePath, { force: true }).catch(() => {});
  }
}

/**
 * 跑完整清单。CLI 与 node:test 共用。
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ failed: number, results: { name: string, ok: boolean, detail: string }[] }>}
 */
export async function checkBrowserScripts(log = (line) => console.log(line)) {
  const work = await mkdtemp(join(tmpdir(), "dsh-smoke-browser-check-"));
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const results = [];
  try {
    for (const entry of ENTRIES) {
      const result = await checkEntry(entry, work);
      results.push(result);
      log(`${result.ok ? "PASS" : "FAIL"} ${entry.file}${result.ok ? "" : ` :: ${result.detail}`}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  const failed = results.filter((item) => !item.ok).length;
  log(`${results.length - failed} PASS / 0 SKIP / ${failed} FAIL`);
  return { failed, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = (await checkBrowserScripts()).failed > 0 ? 1 : 0;
}
